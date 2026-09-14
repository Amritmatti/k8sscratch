/**
 * Configuration, resolved once at startup from the environment.
 *
 * Every value comes from an environment variable because that is what a
 * container can be configured with. In Kubernetes these are injected from the
 * Helm chart: plain values from a ConfigMap, credentials from a Secret.
 *
 * The process refuses to start if a required secret is missing rather than
 * falling back to a default — a service that silently starts with the wrong
 * database credentials is worse than one that fails loudly.
 */

const REQUIRED_IN_PRODUCTION = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',

  server: {
    port: readInt('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    // How long to keep serving after SIGTERM, so in-flight requests finish and
    // the Istio sidecar and kube-proxy have time to drop this pod from
    // rotation. Must be shorter than terminationGracePeriodSeconds.
    shutdownTimeoutMs: readInt('SHUTDOWN_TIMEOUT_MS', 10_000),
    // Kubernetes sends traffic for a few seconds after the pod is marked
    // Terminating. Failing readiness first avoids dropped requests.
    preStopDelayMs: readInt('PRE_STOP_DELAY_MS', 5_000),
  },

  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: readInt('DB_PORT', 5432),
    database: process.env.DB_NAME ?? 'employees',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    ssl: readBool('DB_SSL', false) ? { rejectUnauthorized: false } : false,
    poolMax: readInt('DB_POOL_MAX', 10),
    idleTimeoutMs: readInt('DB_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMs: readInt('DB_CONNECTION_TIMEOUT_MS', 5_000),
    statementTimeoutMs: readInt('DB_STATEMENT_TIMEOUT_MS', 10_000),
  },

  log: {
    level: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    // Pretty logs are for humans; in a cluster the collector wants JSON.
    pretty: readBool('LOG_PRETTY', nodeEnv !== 'production'),
  },

  rateLimit: {
    enabled: readBool('RATE_LIMIT_ENABLED', true),
    windowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
    max: readInt('RATE_LIMIT_MAX', 120),
  },

  metrics: {
    enabled: readBool('METRICS_ENABLED', true),
    path: process.env.METRICS_PATH ?? '/metrics',
  },
};

/**
 * Fail fast on a misconfigured production deployment.
 * Returns the list of problems so the caller can log them before exiting.
 */
export function validateConfig() {
  const problems = [];

  if (config.isProduction) {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!process.env[name]) {
        problems.push(`${name} is not set (required when NODE_ENV=production)`);
      }
    }
    if (config.db.password && config.db.password.length < 8) {
      problems.push('DB_PASSWORD is shorter than 8 characters');
    }
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    problems.push(`PORT ${config.server.port} is out of range`);
  }

  return problems;
}
