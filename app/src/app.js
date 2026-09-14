/**
 * Express application factory.
 *
 * Kept separate from server.js so tests can mount the app without binding a
 * port or installing signal handlers.
 */

import { randomUUID } from 'node:crypto';

import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { metricsMiddleware } from './metrics.js';
import { employeesRouter } from './routes/employees.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  // Istio's sidecar and gateway terminate the client connection, so the
  // client IP arrives in X-Forwarded-For. Trusting exactly one hop lets rate
  // limiting see real clients without letting a client spoof the header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Correlation id: reuse the one Istio generates so a request can be traced
  // across the mesh, otherwise mint one.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] ?? randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Health probes fire every few seconds; logging them buries real traffic.
      autoLogging: {
        ignore: (req) => ['/healthz', '/readyz', '/startupz'].includes(req.url),
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(
    helmet({
      // This is a JSON API with no browser UI, so a restrictive CSP costs
      // nothing and removes a class of response-injection risk.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // A 100 kB cap is far above any legitimate employee record and stops a
  // trivial memory-exhaustion attempt.
  app.use(express.json({ limit: '100kb' }));

  app.use(metricsMiddleware);

  // Probes must never be rate limited or they will fail under load and the
  // pod will be restarted exactly when it is busiest.
  app.use('/', healthRouter);

  if (config.rateLimit.enabled) {
    app.use(
      '/api',
      rateLimit({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' },
        },
      }),
    );
  }

  app.use('/api/v1/employees', employeesRouter);

  app.get('/api/v1', (req, res) => {
    res.json({
      service: 'employee-api',
      version: process.env.APP_VERSION ?? 'dev',
      commit: process.env.GIT_COMMIT ?? 'unknown',
      endpoints: [
        'GET    /api/v1/employees',
        'POST   /api/v1/employees',
        'GET    /api/v1/employees/:id',
        'PUT    /api/v1/employees/:id',
        'DELETE /api/v1/employees/:id',
      ],
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
