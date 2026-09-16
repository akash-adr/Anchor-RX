'use strict';

const express = require('express');

/**
 * GET /api/drug-reference — thin passthrough to the AI service's GET /drug-reference (Python's DRUG_REFERENCE, the ONE
 * source of truth for the Doctor Portal's medicine autofill). Node keeps no copy of the table: the body is relayed
 * as-is and held in memory for a few minutes, because the table only changes when the AI service is retrained and
 * restarted. Failures are never cached — the next request tries again — and answer 503 DRUG_REFERENCE_UNAVAILABLE, on
 * which the portal falls back to fully manual entry.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3000;

function createDrugReferenceSource({
  baseUrl = process.env.RISK_ENGINE_URL || process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000',
  fetchImpl = globalThis.fetch,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/drug-reference`;
  let cached = null; // { body, expiresAt }
  let inFlight = null; // concurrent misses share one upstream call

  async function fetchFresh() {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`AI service ${url} answered HTTP ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`AI service ${url} returned a non-object body`);
    return body;
  }

  async function get() {
    if (cached && now() < cached.expiresAt) return cached.body;
    if (!inFlight) {
      inFlight = fetchFresh()
        .then((body) => {
          cached = { body, expiresAt: now() + ttlMs };
          return body;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return Object.freeze({ get });
}

function createDrugReferenceRouter({ drugReferenceSource }) {
  const router = express.Router();

  router.get('/drug-reference', async (req, res) => {
    try {
      res.json(await drugReferenceSource.get());
    } catch (err) {
      console.error('[api] drug reference unavailable:', err.message);
      res.status(503).json({ error: true, reason: 'DRUG_REFERENCE_UNAVAILABLE', message: 'Drug reference data is unavailable right now; enter medicine details manually.' });
    }
  });

  return router;
}

module.exports = { createDrugReferenceSource, createDrugReferenceRouter, DEFAULT_TTL_MS };
