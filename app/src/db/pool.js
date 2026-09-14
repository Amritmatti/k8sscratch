/**
 * PostgreSQL connection pool.
 *
 * A pool rather than a single connection because the app runs several replicas
 * and each needs to survive Postgres restarts, failovers and network blips
 * without taking the pod down with it.
 */

import pg from 'pg';

import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

// Postgres DATE columns come back as JS Date objects in the server's timezone,
// which shifts a date of birth by a day either side of UTC. Employee records
// only ever need the calendar date, so keep them as the literal 'YYYY-MM-DD'.
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  // A runaway query must not hold a pool slot forever.
  statement_timeout: config.db.statementTimeoutMs,
  application_name: 'employee-api',
});

// An idle client erroring (Postgres restarted, network dropped) emits on the
// pool. Without a handler this is an unhandled 'error' event and kills the
// process, which turns a recoverable blip into a CrashLoopBackOff.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle PostgreSQL client errored; the pool will reconnect');
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL connection established');
});

/** Run a query, logging slow ones so they can be found later. */
export async function query(text, params) {
  const started = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 500) {
      logger.warn({ ms: Math.round(ms), sql: text.slice(0, 120) }, 'Slow query');
    }
    return result;
  } catch (err) {
    logger.error({ err, sql: text.slice(0, 120) }, 'Query failed');
    throw err;
  }
}

/** Run several statements in one transaction, rolling back on any failure. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Cheap liveness check for the readiness probe. */
export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function closePool() {
  await pool.end();
  logger.info('PostgreSQL pool closed');
}
