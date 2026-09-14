/**
 * Unit tests — no database required.
 *
 * Run: npm run test:unit
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEmployeeSchema,
  idParamSchema,
  listQuerySchema,
} from '../src/validation.js';

const valid = {
  name: 'Ada Lovelace',
  dob: '1990-12-10',
  designation: 'Principal Engineer',
  doj: '2015-06-01',
};

function expectFailure(payload, field) {
  const result = createEmployeeSchema.safeParse(payload);
  assert.equal(result.success, false, `expected ${JSON.stringify(payload)} to be rejected`);
  const fields = result.error.issues.map((issue) => issue.path.join('.'));
  assert.ok(
    fields.includes(field),
    `expected an issue on "${field}", got ${JSON.stringify(fields)}`,
  );
}

describe('createEmployeeSchema', () => {
  it('accepts a well-formed employee', () => {
    const result = createEmployeeSchema.safeParse(valid);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(result.data.name, 'Ada Lovelace');
  });

  it('trims surrounding whitespace from text fields', () => {
    const result = createEmployeeSchema.parse({ ...valid, name: '  Ada Lovelace  ' });
    assert.equal(result.name, 'Ada Lovelace');
  });

  it('rejects a missing name', () => expectFailure({ ...valid, name: '' }, 'name'));

  it('rejects a name of only whitespace', () =>
    expectFailure({ ...valid, name: '   ' }, 'name'));

  it('rejects a name over 120 characters', () =>
    expectFailure({ ...valid, name: 'a'.repeat(121) }, 'name'));

  it('rejects a missing designation', () =>
    expectFailure({ ...valid, designation: '' }, 'designation'));

  it('rejects a non-ISO date', () => expectFailure({ ...valid, dob: '10/12/1990' }, 'dob'));

  it('rejects a date that does not exist', () =>
    expectFailure({ ...valid, dob: '2023-02-30' }, 'dob'));

  it('rejects a date of birth in the future', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    expectFailure({ ...valid, dob: future.toISOString().slice(0, 10) }, 'dob');
  });

  it('rejects an implausible age', () =>
    expectFailure({ ...valid, dob: '1850-01-01' }, 'dob'));

  it('rejects a joining date before the date of birth', () =>
    expectFailure({ ...valid, dob: '1990-12-10', doj: '1985-01-01' }, 'doj'));

  it('rejects a joining date far in the future', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 3);
    expectFailure({ ...valid, doj: future.toISOString().slice(0, 10) }, 'doj');
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    // .strict() matters: a typo like "desgination" should be an error, not a
    // record saved with a missing designation.
    const result = createEmployeeSchema.safeParse({ ...valid, salary: 100000 });
    assert.equal(result.success, false);
  });
});

describe('listQuerySchema', () => {
  it('applies defaults when nothing is supplied', () => {
    const result = listQuerySchema.parse({});
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
    assert.equal(result.sort, 'id');
    assert.equal(result.order, 'asc');
  });

  it('coerces numeric strings from the query string', () => {
    const result = listQuerySchema.parse({ limit: '25', offset: '100' });
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 100);
  });

  it('caps the page size', () => {
    assert.equal(listQuerySchema.safeParse({ limit: '5000' }).success, false);
  });

  it('rejects a sort column outside the allow-list', () => {
    // Guards the ORDER BY interpolation in the repository.
    assert.equal(listQuerySchema.safeParse({ sort: 'id; DROP TABLE employees' }).success, false);
  });
});

describe('idParamSchema', () => {
  it('accepts a positive integer', () => {
    assert.equal(idParamSchema.parse({ id: '42' }).id, 42);
  });

  for (const bad of ['0', '-1', 'abc', '1.5']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(idParamSchema.safeParse({ id: bad }).success, false);
    });
  }
});
