'use strict';

/**
 * Anchor Rx — Module 9: trust decision ("Pharmacy Trust Mode") — a PURE function.
 *
 * decideTrust(scanResult, riskResult) combines Module 6's integrity verdict with Module 8's risk assessment into
 * one pharmacy-facing decision: Dispense | Review | Block. No I/O, no logging, no HTTP, no database.
 *
 * Precedence (integrity always first):
 *   1. Integrity failure — tampered, forged, provider_identity_issue, unknown_prescription, malformed_qr, revoked
 *        → Block, primaryReason = the scan result. riskResult is NEVER read in this branch: the risk engine's opinion
 *          of a prescription we can't trust is meaningless, and every risk field in the output is null.
 *        (revoked is not in the original Module 9 spec list; a doctor-withdrawn prescription must never be dispensed,
 *          so it blocks exactly like the other integrity failures.)
 *   2. Authentic — verified, stale_version → decided by riskResult.riskBand:
 *        low → Dispense "clean" · review → Review "reviewRiskScore" · high → Review "highRiskScore"
 *        missing / malformed riskResult → Review "riskEngineUnavailable" (never Dispense without a risk assessment)
 *   Any other scanResult value throws TrustDecisionError — an unknown integrity state is a bug, not a decision.
 *
 * riskResult is the camelCase shape produced by the Node HTTP client (Step 2): { riskScore, riskBand, reasons }.
 */

const TRUST_DECISIONS = Object.freeze({ DISPENSE: 'Dispense', REVIEW: 'Review', BLOCK: 'Block' });

const BLOCKING_SCAN_RESULTS = Object.freeze([
  'tampered',
  'forged',
  'provider_identity_issue',
  'unknown_prescription',
  'malformed_qr',
  'revoked',
]);

const RISK_ASSESSED_SCAN_RESULTS = Object.freeze(['verified', 'stale_version']);

const RISK_BAND_DECISIONS = Object.freeze({
  low: Object.freeze({ trustDecision: TRUST_DECISIONS.DISPENSE, primaryReason: 'clean' }),
  review: Object.freeze({ trustDecision: TRUST_DECISIONS.REVIEW, primaryReason: 'reviewRiskScore' }),
  // DELIBERATE DESIGN CHOICE — "high" maps to Review, NOT Block. Do not change "high" → "Review" to "Block" without
  // deliberately revisiting this reasoning; it is not an arbitrary threshold. A prescription that reaches this branch
  // passed every integrity check: it really was written by a verified, active doctor and has not been altered. The
  // risk engine only says it is unusual (synthetic reference ranges + an unsupervised anomaly model); it cannot know
  // the clinical context. It flags the prescription for human judgment — it must not override an authentic doctor's
  // clinical decision by forcing an automatic block.
  high: Object.freeze({ trustDecision: TRUST_DECISIONS.REVIEW, primaryReason: 'highRiskScore' }),
});

const RISK_UNAVAILABLE_REASON = 'riskEngineUnavailable';

class TrustDecisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrustDecisionError';
    this.code = code;
  }
}

function isUsableRiskResult(riskResult) {
  return (
    riskResult !== null &&
    typeof riskResult === 'object' &&
    typeof riskResult.riskBand === 'string' &&
    Object.hasOwn(RISK_BAND_DECISIONS, riskResult.riskBand) &&
    Number.isFinite(riskResult.riskScore) &&
    riskResult.riskScore >= 0 &&
    riskResult.riskScore <= 100 &&
    Array.isArray(riskResult.reasons)
  );
}

function buildDecision(scan, { trustDecision, primaryReason, riskScore, riskBand, riskReasons }) {
  return {
    trustDecision,
    primaryReason,
    scanResult: scan.scanResult,
    riskScore,
    riskBand,
    supportingDetail: {
      fieldVerification: scan.fieldVerification ?? null,
      ledgerVerification: scan.ledgerVerification ?? null,
      riskReasons,
    },
    decidedAt: new Date().toISOString(),
  };
}

/**
 * @param {object} scanResult  verifyScan() output (Module 6)
 * @param {object|null|undefined} riskResult  { riskScore, riskBand, reasons } — ignored entirely for integrity failures
 * @returns {{trustDecision: 'Dispense'|'Review'|'Block', primaryReason: string, scanResult: string,
 *            riskScore: number|null, riskBand: string|null,
 *            supportingDetail: {fieldVerification: object|null, ledgerVerification: object|null, riskReasons: Array|null},
 *            decidedAt: string}}
 * @throws {TrustDecisionError} INVALID_SCAN_RESULT | UNKNOWN_SCAN_RESULT
 */
function decideTrust(scanResult, riskResult) {
  if (scanResult === null || typeof scanResult !== 'object' || typeof scanResult.scanResult !== 'string') {
    throw new TrustDecisionError('INVALID_SCAN_RESULT', 'decideTrust requires a verifyScan() result with a scanResult string');
  }
  const outcome = scanResult.scanResult;

  if (BLOCKING_SCAN_RESULTS.includes(outcome)) {
    // Integrity failed: riskResult is intentionally never touched here (not even to check whether it exists).
    return buildDecision(scanResult, {
      trustDecision: TRUST_DECISIONS.BLOCK,
      primaryReason: outcome,
      riskScore: null,
      riskBand: null,
      riskReasons: null,
    });
  }

  if (!RISK_ASSESSED_SCAN_RESULTS.includes(outcome)) {
    throw new TrustDecisionError('UNKNOWN_SCAN_RESULT', `Unrecognised scanResult "${outcome}"`);
  }

  if (!isUsableRiskResult(riskResult)) {
    return buildDecision(scanResult, {
      trustDecision: TRUST_DECISIONS.REVIEW,
      primaryReason: RISK_UNAVAILABLE_REASON,
      riskScore: null,
      riskBand: null,
      riskReasons: null,
    });
  }

  const { trustDecision, primaryReason } = RISK_BAND_DECISIONS[riskResult.riskBand];
  return buildDecision(scanResult, {
    trustDecision,
    primaryReason,
    riskScore: riskResult.riskScore,
    riskBand: riskResult.riskBand,
    riskReasons: riskResult.reasons,
  });
}

module.exports = {
  decideTrust,
  TrustDecisionError,
  TRUST_DECISIONS,
  BLOCKING_SCAN_RESULTS,
  RISK_ASSESSED_SCAN_RESULTS,
  RISK_UNAVAILABLE_REASON,
};
