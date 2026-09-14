/**
 * Process entry point: bind the API, expose metrics separately, shut down
 * cleanly.
 *
 * Metrics listen on their own port so the Service can expose 3000 through the
 * Istio Gateway while 9090 stays reachable only from inside the cluster.
 */

import http from 'node:http';

import { createApp } from './app.js';
import { config, validateConfig } from './config.js';
import { closePool, ping } from './db/pool.js';
import { logger } from './logger.js';
import { employeeCount, dbUp, registry } from './metrics.js';
import { countEmployees } from './db/employees.js';
import { beginShutdown, markStarted } from './routes/health.js';

const METRICS_PORT = Number.parseInt(process.env.METRICS_PORT ?? '9090', 10);

function startMetricsServer() {
  if (!config.metrics.enabled) return null;

  const server = http.createServer(async (req, res) => {
    if (req.url !== config.metrics.path) {
      res.writeHead(404).end();
      return;
    }
    try {
      // Refresh the gauge lazily, on scrape, rather than polling the database
      // on a timer nobody is reading.
      countEmployees()
        .then((count) => employeeCount.set(count))
        .catch(() => {});
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
    } catch (err) {
      logger.error({ err }, 'Failed to render metrics');
      res.writeHead(500).end();
    }
  });

  server.listen(METRICS_PORT, config.server.host, () => {
    logger.info({ port: METRICS_PORT, path: config.metrics.path }, 'Metrics server listening');
  });
  return server;
}

async function main() {
  const problems = validateConfig();
  if (problems.length > 0) {
    for (const problem of problems) logger.fatal(problem);
    logger.fatal('Refusing to start with an invalid configuration');
    process.exit(1);
  }

  const app = createApp();
  const server = http.createServer(app);
  const metricsServer = startMetricsServer();

  // Slow-loris protection: a client must send headers promptly.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  server.listen(config.server.port, config.server.host, async () => {
    logger.info(
      {
        port: config.server.port,
        env: config.env,
        db: `${config.db.host}:${config.db.port}/${config.db.database}`,
        version: process.env.APP_VERSION ?? 'dev',
        commit: process.env.GIT_COMMIT ?? 'unknown',
      },
      'Employee API listening',
    );

    // Connectivity is reported, not required: readiness will keep the pod out
    // of rotation until the database answers, and the pod recovers by itself.
    try {
      await ping();
      dbUp.set(1);
      logger.info('Connected to PostgreSQL');
    } catch (err) {
      dbUp.set(0);
      logger.error({ err: err.message }, 'PostgreSQL not reachable yet; will keep retrying');
    }
    markStarted();
  });

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown requested');

    // 1. Fail readiness first. Endpoints are removed asynchronously, so for a
    //    few seconds traffic still arrives here; keep serving it.
    beginShutdown();
    await new Promise((resolve) => setTimeout(resolve, config.server.preStopDelayMs));

    // 2. Stop accepting new connections, let in-flight requests finish.
    const closed = new Promise((resolve) => server.close(resolve));
    const timedOut = new Promise((resolve) =>
      setTimeout(() => resolve('timeout'), config.server.shutdownTimeoutMs),
    );
    const outcome = await Promise.race([closed, timedOut]);
    if (outcome === 'timeout') {
      logger.warn('Timed out waiting for in-flight requests; closing anyway');
    }

    metricsServer?.close();
    await closePool().catch((err) => logger.error({ err }, 'Error closing the pool'));

    logger.info('Shutdown complete');
    process.exit(0);
  }

  // SIGTERM is what Kubernetes sends; SIGINT is Ctrl+C locally.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    // The process state is unknown after this; exit and let Kubernetes
    // replace the pod rather than serve from a corrupted runtime.
    logger.fatal({ err }, 'Uncaught exception; exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
