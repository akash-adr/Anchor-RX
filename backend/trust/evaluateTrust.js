'use strict';

/**
 * Anchor Rx — Module 9: trust evaluation orchestration ("Pharmacy Trust Mode").
 *
 *   evaluateTrust(qrPayloadRaw, pharmacyId)
 *     1. verifyScan (Module 6)             integrity verdict; logs a verification_event (eventId)
 *     2. RISK ENGINE GATE                   consultsRiskEngine() — the AI service is called ONLY for authentic scans:
 *          verified       → risk of the scanned version
 *          stale_version  → risk of the CURRENT ACTIVE version (what would actually be dispensed), not the QR's version
 *          anything else  → the scorer is never invoked; decideTrust(scan, null) → Block
 *     3. decideTrust                        the single decision policy: Dispense | Review | Block
 *          AI outage → decideTrust(scan, null) → Review "riskEngineUnavailable" (decideTrust owns that fallback)
 *     4. trust_decision_log                 one row linked to the verification_event, then the decision is returned
 *
 * Only AI-service failures (AIServiceError) degrade to Review. Database errors, payload errors and a failed decision
 * log write still throw: an unaudited decision is never handed back (same rule as Module 6's verification_event).
 */

const { createPharmacyVerification } = require('../qr/pharmacyVerification');
const { createScoreClient, AIServiceError } = require('../ml/scoreClient');
const { decideTrust, TrustDecisionError, RISK_ASSESSED_SCAN_RESULTS } = require('./decideTrust');

const INSERT_DECISION_SQL = `
  INSERT INTO trust_decision_log
    (prescription_id, version_number, pharmacy_id, verification_event_id,
     trust_decision, primary_reason, risk_score, risk_band, decided_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE GUARANTEE: the AI risk model is never invoked once integrity has failed.
// This allowlist is the ONLY gate in front of the scorer, and assessRisk() — the ONLY place scorePrescriptionViaAI is
// called — runs only inside `if (consultsRiskEngine(scan))`. It is deliberately an allowlist of authentic outcomes
// (verified, stale_version), not a blocklist of failures: tampered, forged, provider_identity_issue,
// unknown_prescription, malformed_qr, revoked — and any scan result added in future — can never reach the scorer.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function consultsRiskEngine(scan) {
  return RISK_ASSESSED_SCAN_RESULTS.includes(scan.scanResult);
}

/** The version whose risk matters: for a stale scan, the current active version that would actually be dispensed. */
function evaluatedVersionNumber(scan) {
  return scan.scanResult === 'stale_version' ? scan.currentActiveVersion : scan.versionNumber;
}

function withRiskEngineNote(decision, riskEngine) {
  return { ...decision, supportingDetail: { ...decision.supportingDetail, riskEngine } };
}

function createTrustEvaluator(
  pool,
  { pharmacyVerification = createPharmacyVerification(pool), scoreClient = createScoreClient(pool) } = {},
) {
  /** Only ever reached from the gated branch in evaluateTrust. */
  async function assessRisk(prescriptionId, versionNumber) {
    try {
      const risk = await scoreClient.scorePrescriptionViaAI(prescriptionId, versionNumber); // ← the ONLY scorer call site
      return {
        risk,
        riskEngine: { status: 'consulted', evaluatedVersionNumber: versionNumber, modelVersion: risk?.details?.modelVersion ?? null },
      };
    } catch (err) {
      if (!(err instanceof AIServiceError)) throw err;
      // Safe default: no risk result → decideTrust returns Review "riskEngineUnavailable" (never Dispense, never a crash).
      return {
        risk: null,
        riskEngine: { status: 'unavailable', evaluatedVersionNumber: versionNumber, errorCode: err.code, reason: err.reason },
      };
    }
  }

  async function logDecision(decision, { prescriptionId, versionNumber, pharmacyId, verificationEventId }) {
    await pool.execute(INSERT_DECISION_SQL, [
      prescriptionId,
      versionNumber,
      pharmacyId,
      verificationEventId,
      decision.trustDecision,
      decision.primaryReason,
      decision.riskScore,
      decision.riskBand,
      new Date(decision.decidedAt),
    ]);
  }

  /**
   * @returns {Promise<object>} decideTrust output, plus supportingDetail.riskEngine:
   *   { status: "not_consulted" } | { status: "consulted", evaluatedVersionNumber, modelVersion }
   *   | { status: "unavailable", evaluatedVersionNumber, errorCode, reason }
   * @throws PharmacyVerificationError (unknown pharmacy), TrustDecisionError, database errors
   */
  async function evaluateTrust(qrPayloadRaw, pharmacyId) {
    const scan = await pharmacyVerification.verifyScan(qrPayloadRaw, pharmacyId);

    let decision;
    let versionNumber;

    if (consultsRiskEngine(scan)) {
      versionNumber = evaluatedVersionNumber(scan);
      if (!Number.isInteger(versionNumber)) {
        throw new TrustDecisionError('INVALID_SCAN_RESULT', `${scan.scanResult} scan has no usable version number to evaluate`);
      }
      const { risk, riskEngine } = await assessRisk(scan.prescriptionId, versionNumber);
      decision = withRiskEngineNote(decideTrust(scan, risk), riskEngine); // ORIGINAL scan (still stale_version if stale)
    } else {
      // Integrity/identity failure (or an unrecognised result, which decideTrust rejects): the scorer is NOT invoked.
      versionNumber = scan.versionNumber;
      decision = withRiskEngineNote(decideTrust(scan, null), { status: 'not_consulted' });
    }

    await logDecision(decision, {
      prescriptionId: scan.prescriptionId,
      versionNumber,
      pharmacyId,
      verificationEventId: scan.eventId,
    });
    return decision;
  }

  return Object.freeze({ evaluateTrust });
}

module.exports = { createTrustEvaluator, consultsRiskEngine };
