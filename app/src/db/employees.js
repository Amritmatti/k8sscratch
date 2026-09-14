/**
 * Employee data access.
 *
 * Every value reaches Postgres as a bound parameter — no string interpolation
 * anywhere, including the sort column, which is resolved through an allow-list
 * because identifiers cannot be parameterised.
 */

import { query } from './pool.js';

const COLUMNS = 'id, name, dob, designation, doj, created_at, updated_at';

// An allow-list, not the caller's string: `ORDER BY ${input}` would be an
// injection point that bound parameters cannot protect.
const SORTABLE = {
  id: 'id',
  name: 'lower(name)',
  dob: 'dob',
  doj: 'doj',
};

const ORDER = { asc: 'ASC', desc: 'DESC' };

export async function listEmployees({ limit, offset, search, sort, order }) {
  const column = SORTABLE[sort] ?? SORTABLE.id;
  const direction = ORDER[order] ?? ORDER.asc;

  const params = [];
  let where = '';

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where = `WHERE lower(name) LIKE $${params.length} OR lower(designation) LIKE $${params.length}`;
  }

  params.push(limit, offset);

  const rows = await query(
    `SELECT ${COLUMNS} FROM employees
     ${where}
     ORDER BY ${column} ${direction}, id ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = await query(
    `SELECT count(*)::int AS count FROM employees ${where}`,
    search ? [params[0]] : [],
  );

  return { data: rows.rows, total: total.rows[0].count, limit, offset };
}

export async function getEmployee(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM employees WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createEmployee({ name, dob, designation, doj }) {
  const { rows } = await query(
    `INSERT INTO employees (name, dob, designation, doj)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [name, dob, designation, doj],
  );
  return rows[0];
}

export async function replaceEmployee(id, { name, dob, designation, doj }) {
  const { rows } = await query(
    `UPDATE employees
        SET name = $2, dob = $3, designation = $4, doj = $5
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, name, dob, designation, doj],
  );
  return rows[0] ?? null;
}

export async function deleteEmployee(id) {
  const { rowCount } = await query('DELETE FROM employees WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function countEmployees() {
  const { rows } = await query('SELECT count(*)::int AS count FROM employees');
  return rows[0].count;
}
