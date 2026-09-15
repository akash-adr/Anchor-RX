'use strict';

/**
 * Anchor Rx — Module 9: HTTP client for the Module 8 AI risk service (ai-service/main.py, POST /score).
 *
 * This is the ONLY place in the Node codebase that knows the Python service speaks snake_case. Callers get camelCase
 * keys (identifier VALUES such as source "rule_engine" or feature "dose_value" are data and pass through unchanged):
 *
 *   { riskScore, riskBand, reasons: [{ source, feature, explanation }],
 *     details: { mlSubscore, ruleSubscore, rulesNotEvaluated: [{ rule, reason }], patientWeightIsDefault, modelVersion } }
 *
 * Failure contract — an AI-service problem never escapes as an arbitrary exception:
 *   network error, timeout, non-2xx status, or a response that is not the documented shape
 *     → throws AIServiceError { name: "AIServiceError", code: "AI_SERVICE_UNAVAILABLE",
 *                               reason: "network" | "timeout" | "http_status" | "invalid_response", status }
 *   Callers (Step 3) catch AIServiceError and hand decideTrust a null risk result → Review "riskEngineUnavailable".
 *   NOT converted: ScoringPayloadError (e.g. VERSION_NOT_FOUND) and database errors — those are not AI outages.
 *
 * Config: AI_SERVICE_URL (default http://127.0.0.1:8000 — uvicorn listens on IPv4 localhost),
 *         AI_SERVICE_TIMEOUT_MS (default 2000).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { createScoringPayloadBuilder } = require('./buildScoringPayload');

const DEFAULT_AI_SERVICE_URL = 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT_MS = 2000;
const AI_SERVICE_UNAVAILABLE = 'AI_SERVICE_UNAVAILABLE';
const RISK_BANDS = new Set(['low', 'review', 'high']);
const REASON_SOURCES = new Set(['rule_engine', 'ml_model']);
const MAX_REASONS = 3;

class AIServiceError extends Error {
  constructor(reason, message, { status = null, cause, responseBody } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AIServiceError';
    this.code = AI_SERVICE_UNAVAILABLE;
    this.reason = reason;
    this.status = status;
    if (responseBody !== undefined) this.responseBody = responseBody;
  }
}

function isTimeout(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Python response (snake_case) → Node contract (camelCase). Throws AIServiceError("invalid_response") on any drift. */
function translateAIResponse(body) {
  const invalid = (detail) => new AIServiceError('invalid_response', `AI service returned an unexpected response: ${detail}`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body is not a JSON object');

  const { risk_score: riskScore, risk_band: riskBand, reasons, details } = body;
  if (!Number.isInteger(riskScore) || riskScore < 0 || riskScore > 100) throw invalid('risk_score must be an integer 0–100');
  if (!RISK_BANDS.has(riskBand)) throw invalid('risk_band must be low, review or high');
  const reasonsValid =
    Array.isArray(reasons) &&
    reasons.length <= MAX_REASONS &&
    reasons.every(
      (reason) =>
        reason !== null && typeof reason === 'object' && REASON_SOURCES.has(reason.source) && typeof reason.feature === 'string' && typeof reason.explanation === 'string',
    );
  if (!reasonsValid) throw invalid('reasons must be up to 3 { source, feature, explanation } objects');

  const hasDetails = details !== null && typeof details === 'object' && !Array.isArray(details);
  return {
    riskScore,
    riskBand,
    reasons: reasons.map(({ source, feature, explanation }) => ({ source, feature, explanation })),
    details: hasDetails
      ? {
          mlSubscore: details.ml_subscore ?? null,
          ruleSubscore: details.rule_subscore ?? null,
          rulesNotEvaluated: Array.isArray(details.rules_not_evaluated)
            ? details.rules_not_evaluated.map(({ rule, reason }) => ({ rule, reason }))
            : [],
          patientWeightIsDefault: details.patient_weight_is_default ?? null,
          modelVersion: details.model_version ?? null,
        }
      : null,
  };
}

function createScoreClient(
  pool,
  {
    payloadBuilder = createScoringPayloadBuilder(pool),
    baseUrl = process.env.AI_SERVICE_URL || DEFAULT_AI_SERVICE_URL,
    timeoutMs = Number(process.env.AI_SERVICE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const scoreUrl = `${new URL(baseUrl).href.replace(/\/+$/, '')}/score`; // invalid URL → throws at startup, not per scan

  /**
   * Scores a stored prescription version (its first medicine, with the others as sibling context) — Module 9's path.
   * @returns {Promise<{riskScore: number, riskBand: 'low'|'review'|'high', reasons: Array, details: object|null}>}
   * @throws {AIServiceError} code AI_SERVICE_UNAVAILABLE — any AI-service failure
   * @throws {ScoringPayloadError} the prescription version cannot be turned into a payload (not an AI outage)
   */
  async function scorePrescriptionViaAI(prescriptionId, versionNumber) {
    const payload = await payloadBuilder.buildScoringPayload(prescriptionId, versionNumber);
    return scorePayloadViaAI(payload);
  }

  /**
   * ONE POST /score for an already-built ScoringPayload (Module 15's per-medicine path). Same failure contract.
   * @throws {AIServiceError} code AI_SERVICE_UNAVAILABLE — any AI-service failure
   */
  async function scorePayloadViaAI(payload) {
    let response;
    try {
      response = await fetchImpl(scoreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        throw new AIServiceError('timeout', `AI service did not respond within ${timeoutMs} ms (${scoreUrl})`, { cause: err });
      }
      const detail = err?.cause?.code ?? err?.message ?? String(err);
      throw new AIServiceError('network', `AI service unreachable at ${scoreUrl} (${detail})`, { cause: err });
    }

    if (!response.ok) {
      let responseBody = '';
      try {
        responseBody = (await response.text()).slice(0, 500);
      } catch {
        // body unavailable — the status alone is enough to fail
      }
      throw new AIServiceError('http_status', `AI service responded ${response.status} (${scoreUrl})`, { status: response.status, responseBody });
    }

    let body;
    try {
      body = await response.json();
    } catch (err) {
      if (isTimeout(err)) {
        throw new AIServiceError('timeout', `AI service response did not complete within ${timeoutMs} ms`, { cause: err, status: response.status });
      }
      throw new AIServiceError('invalid_response', 'AI service response was not valid JSON', { cause: err, status: response.status });
    }
    return translateAIResponse(body);
  }

  return Object.freeze({ scorePrescriptionViaAI, scorePayloadViaAI });
}

module.exports = {
  createScoreClient,
  translateAIResponse,
  AIServiceError,
  AI_SERVICE_UNAVAILABLE,
  DEFAULT_AI_SERVICE_URL,
  DEFAULT_TIMEOUT_MS,
};
