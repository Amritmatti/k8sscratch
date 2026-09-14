/**
 * Structured logging.
 *
 * JSON in production so a log collector can parse it; pretty-printed locally.
 * Credentials and personal data are redacted at the logger level rather than
 * relying on every call site to remember — employee records contain dates of
 * birth, which should not end up in a log aggregator.
 */

import pino from 'pino';

import { config } from './config.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'DB_PASSWORD',
  'body.dob',
  '*.dob',
];

export const logger = pino({
  level: config.log.level,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'employee-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Kubernetes log tooling expects a plain `level` string, not pino's number.
    level: (label) => ({ level: label }),
  },
  ...(config.log.pretty
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

export default logger;
