/**
 * Employee CRUD routes: /api/v1/employees
 *
 * Fields stored per the brief: ID, Name, DOB, Designation, DOJ.
 */

import { Router } from 'express';

import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  listEmployees,
  replaceEmployee,
} from '../db/employees.js';
import { ApiError, asyncHandler } from '../middleware/errors.js';
import {
  createEmployeeSchema,
  idParamSchema,
  listQuerySchema,
  replaceEmployeeSchema,
} from '../validation.js';

export const employeesRouter = Router();

/** GET /api/v1/employees — paginated list with optional search and sort. */
employeesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = listQuerySchema.parse(req.query);
    const result = await listEmployees(params);
    res.json({
      data: result.data,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.data.length < result.total,
      },
    });
  }),
);

/** GET /api/v1/employees/:id */
employeesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const employee = await getEmployee(id);
    if (!employee) throw ApiError.notFound(`No employee with id ${id}`);
    res.json({ data: employee });
  }),
);

/** POST /api/v1/employees */
employeesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = createEmployeeSchema.parse(req.body);
    const employee = await createEmployee(payload);
    res
      .status(201)
      .location(`${req.baseUrl}/${employee.id}`)
      .json({ data: employee });
  }),
);

/** PUT /api/v1/employees/:id — full replacement. */
employeesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const payload = replaceEmployeeSchema.parse(req.body);
    const employee = await replaceEmployee(id, payload);
    if (!employee) throw ApiError.notFound(`No employee with id ${id}`);
    res.json({ data: employee });
  }),
);

/** DELETE /api/v1/employees/:id */
employeesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const removed = await deleteEmployee(id);
    if (!removed) throw ApiError.notFound(`No employee with id ${id}`);
    res.status(204).end();
  }),
);
