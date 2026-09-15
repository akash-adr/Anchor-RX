'use strict';

const express = require('express');
const { ApiError, handleAuditError } = require('../errors');

/**
 * Audit Timeline / Provenance Dashboard endpoints (Module 10). Thin, read-only wrappers:
 *
 *   GET /api/audit/prescriptions/:prescriptionId/timeline  → getMergedTimeline        HISTORICAL (Modules 3/4/6/9 records)
 *   GET /api/audit/prescriptions/:prescriptionId/recheck   → recheckCurrentIntegrity  LIVE (computed now; writes nothing)
 *   GET /api/audit/summary?currentStatus=&onlyConcerning=  → getAuditSummaryList
 *
 * Responses are the functions' output unchanged: camelCase, every timestamp in epoch milliseconds (UTC).
 *
 * ⚠ PROTOTYPE SIMPLIFICATION — ZERO REAL ACCESS CONTROL.
 * There is no auditor table, no login, no session and no auth middleware on these routes: anyone who can reach this
 * API can read every prescription's audit trail. The frontend "Enter Audit Dashboard" action (Step 5) is a UI
 * affordance only, not a gate. This is deliberately even more minimal than the Doctor/Pharmacy mock logins, which at
 * least select a seeded identity. Real auditor authentication and authorization are out of scope for this prototype.
 */

/** Query string → getAuditSummaryList filters. currentStatus and unknown keys are validated by the summary itself. */
function toSummaryFilters(query) {
  const filters = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      throw new ApiError(400, 'INVALID_FILTERS', `Query parameter "${key}" must be given exactly once`);
    }
    if (key === 'onlyConcerning') {
      if (value !== 'true' && value !== 'false') {
        throw new ApiError(400, 'INVALID_FILTERS', 'onlyConcerning must be "true" or "false"');
      }
      filters.onlyConcerning = value === 'true';
    } else {
      filters[key] = value;
    }
  }
  return filters;
}

function createAuditRouter({ auditTimeline, integrityRecheck, auditSummary }) {
  const router = express.Router();

  router.get('/prescriptions/:prescriptionId/timeline', async (req, res, next) => {
    try {
      res.json(await auditTimeline.getMergedTimeline(req.params.prescriptionId));
    } catch (err) {
      handleAuditError(err, res, next);
    }
  });

  router.get('/prescriptions/:prescriptionId/recheck', async (req, res, next) => {
    try {
      res.json(await integrityRecheck.recheckCurrentIntegrity(req.params.prescriptionId));
    } catch (err) {
      handleAuditError(err, res, next);
    }
  });

  router.get('/summary', async (req, res, next) => {
    try {
      res.json(await auditSummary.getAuditSummaryList(toSummaryFilters(req.query)));
    } catch (err) {
      handleAuditError(err, res, next);
    }
  });

  return router;
}

module.exports = { createAuditRouter, toSummaryFilters };
