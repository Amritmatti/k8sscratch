/**
 * Migration runner.
 *
 * Runs as a Helm pre-install/pre-upgrade hook Job, so the schema is in place
 * before any new pod serves traffic. Three properties matter in a cluster:
 *
 *  - idempotent: the Job may be retried, and every replica of a rollback may
 *    run it again;
 *  - serialised: several pods starting at once must not race, so an advisory
 *    lock lets exactly one runner proceed while the others wait;
 *  - recorded: applied migrations are tracked in a table so re-running is a
 *    no-op rather than an error.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { closePool, pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(here, '..', '..', 'migrations');

// Any constant works; it just has to be the same in every replica.
const ADVISORY_LOCK_KEY = 4_815_162_342;

const TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

// On a fresh cluster install the database is created alongside this runner, so
// it may take a while to accept connections. DB_WAIT_SECONDS is set by the
// Helm chart (migrations.waitForDatabaseSeconds).
const WAIT_SECONDS = Number.parseInt(process.env.DB_WAIT_SECONDS ?? '60', 10);

async function waitForDatabase(delayMs = 2000) {
  const attempts = Math.max(1, Math.ceil((WAIT_SECONDS * 1000) / delayMs));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database is reachable');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      logger.warn(
        { attempt, attempts, err: err.message },
        'Database not ready yet, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function migrate() {
  logger.info(
    { host: config.db.host, database: config.db.database, dir: MIGRATIONS_DIR },
    'Starting migrations',
  );

  // Postgres inside a fresh StatefulSet may still be initialising.
  await waitForDatabase();

  const client = await pool.connect();
  let applied = 0;

  try {
    await client.query(TRACKING_TABLE);

    // Session-level lock: held until released or the connection drops, so a
    // crashed runner cannot deadlock the next one.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    logger.debug('Acquired migration advisory lock');

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      logger.warn('No migration files found');
    }

    const { rows } = await client.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const filename of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const hash = checksum(sql);
      const previous = alreadyApplied.get(filename);

      if (previous) {
        if (previous !== hash) {
          // Editing an applied migration means environments have silently
          // diverged. Refuse rather than guess which version is live.
          throw new Error(
            `Migration ${filename} has changed since it was applied ` +
              `(recorded ${previous.slice(0, 12)}, now ${hash.slice(0, 12)}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        logger.debug({ filename }, 'Already applied, skipping');
        continue;
      }

      logger.info({ filename }, 'Applying migration');
      // Each migration is one transaction: it lands completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, hash],
        );
        await client.query('COMMIT');
        applied += 1;
        logger.info({ filename }, 'Migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
      }
    }

    logger.info({ applied, total: files.length }, 'Migrations complete');
    return applied;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}

// Executed directly (the Helm hook Job runs `npm run migrate`).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly || process.env.RUN_MIGRATIONS === 'true') {
  migrate()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Migration run failed');
      await closePool().catch(() => {});
      process.exit(1);
    });
}
