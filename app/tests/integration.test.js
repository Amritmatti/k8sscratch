/**
 * Integration tests — require a reachable PostgreSQL.
 *
 * Start one with `docker compose up -d postgres`, then:
 *   DB_HOST=localhost DB_PASSWORD=local-dev-password npm run test:integration
 *
 * The whole suite skips (rather than fails) when no database is configured, so
 * `npm test` stays useful on a machine without Docker.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, ping, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

// Resolved with top-level await, before any describe() runs.
//
// `skip` must be a boolean or a string: node:test treats a *function* as
// truthy and skips unconditionally, which silently turned this whole suite
// into a no-op that still reported success.
const databaseAvailable = await ping().then(
  () => true,
  () => false,
);

if (!databaseAvailable) {
  // eslint-disable-next-line no-console
  console.log(
    '\n  Integration tests skipped: no database reachable.\n' +
      '  Start one with `docker compose up -d postgres`, then re-run with\n' +
      '  DB_HOST=127.0.0.1 DB_PORT=55432 DB_PASSWORD=local-dev-password\n',
  );
}

let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

before(async () => {
  if (!databaseAvailable) return;

  await migrate();
  await query('TRUNCATE employees RESTART IDENTITY');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (databaseAvailable) {
    await query('TRUNCATE employees RESTART IDENTITY').catch(() => {});
    await closePool().catch(() => {});
  }
});

const sample = {
  name: 'Grace Hopper',
  dob: '1980-12-09',
  designation: 'Rear Admiral',
  doj: '2010-01-04',
};

describe('health endpoints', { skip: !databaseAvailable }, () => {
  it('liveness reports ok', async () => {
    const res = await request('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('readiness reports the database is reachable', async () => {
    const res = await request('/readyz');
    assert.equal(res.status, 200);
    assert.equal(res.body.checks.database, 'ok');
  });
});

describe('employee CRUD', { skip: !databaseAvailable }, () => {
  let createdId;

  it('creates an employee and returns 201 with a Location header', async () => {
    const res = await request('/api/v1/employees', { method: 'POST', body: sample });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, sample.name);
    // Dates must survive the round trip as calendar dates, not shift a day.
    assert.equal(res.body.data.dob, sample.dob);
    assert.equal(res.body.data.doj, sample.doj);
    assert.ok(res.headers.get('location')?.endsWith(`/${res.body.data.id}`));
    createdId = res.body.data.id;
  });

  it('reads the employee back', async () => {
    const res = await request(`/api/v1/employees/${createdId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.designation, sample.designation);
  });

  it('lists employees with pagination metadata', async () => {
    const res = await request('/api/v1/employees?limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.pagination.total, 'number');
  });

  it('finds the employee by search', async () => {
    const res = await request('/api/v1/employees?search=hopper');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
  });

  it('replaces the employee', async () => {
    const res = await request(`/api/v1/employees/${createdId}`, {
      method: 'PUT',
      body: { ...sample, designation: 'Fleet Admiral' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.designation, 'Fleet Admiral');
  });

  it('rejects an invalid payload with field-level detail', async () => {
    const res = await request('/api/v1/employees', {
      method: 'POST',
      body: { ...sample, dob: 'not-a-date' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
    assert.ok(res.body.error.details.some((d) => d.field === 'dob'));
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request('/api/v1/employees/999999');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await request('/api/v1/employees/not-a-number');
    assert.equal(res.status, 400);
  });

  it('deletes the employee and then 404s', async () => {
    const del = await request(`/api/v1/employees/${createdId}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const after = await request(`/api/v1/employees/${createdId}`);
    assert.equal(after.status, 404);
  });
});

describe('database constraints', { skip: !databaseAvailable }, () => {
  it('the database rejects a joining date before birth even if validation is bypassed', async () => {
    // Proves the CHECK constraints are real and not just API-side validation.
    await assert.rejects(
      () =>
        query(
          'INSERT INTO employees (name, dob, designation, doj) VALUES ($1,$2,$3,$4)',
          ['Bad Record', '1990-01-01', 'Engineer', '1985-01-01'],
        ),
      /employees_doj_after_dob/,
    );
  });

  it('the database rejects a blank name', async () => {
    await assert.rejects(
      () =>
        query(
          'INSERT INTO employees (name, dob, designation, doj) VALUES ($1,$2,$3,$4)',
          ['   ', '1990-01-01', 'Engineer', '2015-01-01'],
        ),
      /employees_name_not_blank/,
    );
  });
});
