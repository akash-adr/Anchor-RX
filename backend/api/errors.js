'use strict';

/**
 * Maps domain errors to HTTP responses. Known, client-caused errors keep their specific code as
 * `reason` (never collapsed to a generic message). Anything unexpected goes to errorMiddleware → 500.
 */

const { RepositoryError } = require('../db/repositories/prescriptionVersionRepository');
const { AmendmentError } = require('../versioning/amendmentService');
const { LedgerError } = require('../ledger/ledgerService');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const NOT_FOUND_CODES = new Set(['PRESCRIPTION_NOT_FOUND', 'NOT_FOUND', 'VERSION_NOT_FOUND']);
// Ledger codes that describe a conflict with current state rather than a broken server.
const LEDGER_CONFLICT_CODES = new Set(['ALREADY_ANCHORED']);

function sendError(res, status, code, message) {
  const body = { error: true, reason: code };
  if (message) body.message = message;
  res.status(status).json(body);
}

function isDomainError(err) {
  return err instanceof RepositoryError || err instanceof AmendmentError;
}

/** POST /prescriptions — validation/reference problems are 400. */
function handleCreateError(err, res, next) {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
  if (err instanceof RepositoryError) return sendError(res, 400, err.code, err.message);
  return next(err);
}

/** amend / revoke — every rejection is 409 with its specific reason; unknown prescription is 404. */
function handleChangeError(err, res, next) {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
  if (isDomainError(err)) {
    if (NOT_FOUND_CODES.has(err.code)) return sendError(res, 404, 'PRESCRIPTION_NOT_FOUND', err.message);
    return sendError(res, 409, err.code, err.message);
  }
  if (err instanceof LedgerError && LEDGER_CONFLICT_CODES.has(err.code)) return sendError(res, 409, err.code, err.message);
  return next(err);
}

/** reads — unknown prescription is 404, malformed identifiers are 400. */
function handleReadError(err, res, next) {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
  if (isDomainError(err)) {
    if (NOT_FOUND_CODES.has(err.code)) return sendError(res, 404, 'PRESCRIPTION_NOT_FOUND', err.message);
    return sendError(res, 400, err.code, err.message);
  }
  return next(err);
}

function notFoundHandler(req, res) {
  sendError(res, 404, 'ROUTE_NOT_FOUND', `${req.method} ${req.path} does not exist`);
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its 4 parameters
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (err && err.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE');
  // Real error stays server-side; the client never sees a stack trace or internal message.
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  return sendError(res, 500, 'INTERNAL_ERROR');
}

module.exports = { ApiError, handleCreateError, handleChangeError, handleReadError, notFoundHandler, errorMiddleware };
