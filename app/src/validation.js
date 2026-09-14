/**
 * Request validation.
 *
 * Mirrors the CHECK constraints in the database so a bad request gets a clear
 * 400 with a field-level message instead of a 500 from a constraint violation.
 */

import { z } from 'zod';

const MAX_AGE_YEARS = 120;

/** 'YYYY-MM-DD' only. Accepting free-form dates invites 03/04/2020 ambiguity. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    // Rejects 2023-02-30, which Date would roll forward to 2023-03-02.
    return parsed.toISOString().slice(0, 10) === value;
  }, 'is not a real calendar date');

const name = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(120, 'must be 120 characters or fewer');

const designation = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(120, 'must be 120 characters or fewer');

const employeeShape = {
  name,
  dob: isoDate,
  designation,
  doj: isoDate,
};

/** Cross-field rules that cannot be expressed on a single property. */
function applyDateRules(data, ctx) {
  const today = new Date().toISOString().slice(0, 10);

  if (data.dob >= today) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dob'], message: 'must be in the past' });
  }

  const oldest = new Date();
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);
  if (data.dob < oldest.toISOString().slice(0, 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dob'],
      message: `implies an age over ${MAX_AGE_YEARS} years`,
    });
  }

  if (data.doj <= data.dob) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['doj'],
      message: 'must be after the date of birth',
    });
  }

  const nextYear = new Date();
  nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
  if (data.doj > nextYear.toISOString().slice(0, 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['doj'],
      message: 'is more than a year in the future',
    });
  }
}

export const createEmployeeSchema = z
  .object(employeeShape)
  .strict()
  .superRefine(applyDateRules);

/** PUT replaces the whole record, so it takes the same shape as create. */
export const replaceEmployeeSchema = createEmployeeSchema;

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Substring match on name or designation.
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['id', 'name', 'doj', 'dob']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive('must be a positive integer'),
});

/** Turn a ZodError into a flat, readable list for the API response. */
export function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}
