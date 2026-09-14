/**
 * Error handling.
 *
 * Clients get a stable shape and a message they can act on. Stack traces and
 * raw Postgres errors stay in the logs — a driver error can leak table names,
 * column names and constraint definitions.
 */

import { ZodError } from 'zod';

import { logger } from '../logger.js';
import { formatIssues } from '../validation.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'not_found', message);
  }

  static badRequest(message, details) {
    return new ApiError(400, 'bad_request', message, details);
  }

  static conflict(message) {
    return new ApiError(409, 'conflict', message);
  }
}

/** Map the Postgres errors this app can actually provoke onto HTTP status. */
function fromPostgres(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return new ApiError(409, 'conflict', 'That record already exists.');
    case '23514': // check_violation
      return new ApiError(
        400,
        'bad_request',
        'The record failed a database validation rule.',
        [{ field: '(record)', message: err.constraint ?? 'check constraint violated' }],
      );
    case '23503': // foreign_key_violation
      return new ApiError(409, 'conflict', 'That record is referenced by something else.');
    case '22001': // string_data_right_truncation
      return new ApiError(400, 'bad_request', 'A field is longer than allowed.');
    case '57014': // query_canceled (statement_timeout)
      return new ApiError(503, 'timeout', 'The database took too long to respond.');
    case 'ECONNREFUSED':
    case '08006': // connection_failure
    case '08001':
      return new ApiError(503, 'database_unavailable', 'The database is unavailable.');
    default:
      return null;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: `No route for ${req.method} ${req.path}`,
    },
  });
}

// Express identifies an error handler by its four-parameter signature, so
// `next` must stay even though it is unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let apiError;

  if (err instanceof ApiError) {
    apiError = err;
  } else if (err instanceof ZodError) {
    apiError = ApiError.badRequest('The request body is not valid.', formatIssues(err));
  } else if (err?.type === 'entity.parse.failed') {
    apiError = ApiError.badRequest('The request body is not valid JSON.');
  } else if (err?.type === 'entity.too.large') {
    apiError = new ApiError(413, 'payload_too_large', 'The request body is too large.');
  } else {
    apiError = fromPostgres(err) ?? null;
  }

  if (!apiError) {
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
    return res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Something went wrong handling this request.',
        requestId: req.id,
      },
    });
  }

  const level = apiError.status >= 500 ? 'error' : 'warn';
  logger[level](
    { err, status: apiError.status, path: req.path, method: req.method },
    apiError.message,
  );

  return res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
      requestId: req.id,
    },
  });
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
