'use strict';

/**
 * Anchor Rx — Module 10: audit summary across prescriptions.
 *
 *   getAuditSummaryList(filters = {}) → rows sorted by prescriptionId:
 *     { prescriptionId, currentStatus, lastScan, lastTrustDecision, latestIntegrityIntact, integrityCheckedAt }
 *
 *   currentStatus          status of the latest version in the chain (Module 3 semantics)
 *   lastScan               HISTORICAL — most recent verification_event, joined through prescription_version_id
 *                          { eventId, result, versionNumber, timestamp } | null
 *   lastTrustDecision      HISTORICAL — most recent trust_decision_log row for the prescription
 *                          { decisionId, trustDecision, primaryReason, riskScore, riskBand, versionNumber,
 *                            verificationEventId, decidedAt } | null
 *   latestIntegrityIntact  LIVE — isIntegrityIntact(recheckCurrentIntegrity(prescriptionId)), computed now
 *   integrityCheckedAt     epoch ms of that live check
 *
 * "Most recent" is ordered inside one source column (timestamp DESC, id DESC); every returned timestamp is normalized.
 *
 * PERFORMANCE — deliberate choice: every listed prescription gets the FULL live recheck (no lighter shortcut), so this
 * list can never disagree with the per-prescription detail view. verifyAnchor walks the global ledger chain up to the
 * entry, so cost is O(prescriptions × ledger entries): fine at demo scale; the first optimisation if it grows would be
 * verifying the chain once per request. The currentStatus filter runs in SQL before any recheck.
 *
 * Filters: { currentStatus?: "active" | "dispensed" | "revoked", onlyConcerning?: boolean } — onlyConcerning keeps
 * rows with latestIntegrityIntact === false. Unknown keys or invalid values throw (a typo must not silently list all).
 */

const { createIntegrityRecheck, isIntegrityIntact } = require('./recheck');
const { normalizeTimestamp } = require('./normalizeTimestamp');

const STATUS_FILTERS = Object.freeze(['active', 'dispensed', 'revoked']);
const FILTER_KEYS = Object.freeze(['currentStatus', 'onlyConcerning']);

const LATEST_VERSIONS_SQL = `
  SELECT pv.prescription_id, pv.status
    FROM prescription_version pv
    JOIN (SELECT prescription_id, MAX(version_number) AS latest FROM prescription_version GROUP BY prescription_id) l
      ON l.prescription_id = pv.prescription_id AND l.latest = pv.version_number`;

const LAST_SCANS_SQL = `
  SELECT event_id, result, \`timestamp\`, prescription_id, version_number
    FROM (SELECT ve.event_id, ve.result, ve.\`timestamp\`, pv.prescription_id, pv.version_number,
                 ROW_NUMBER() OVER (PARTITION BY pv.prescription_id ORDER BY ve.\`timestamp\` DESC, ve.event_id DESC) AS rn
            FROM verification_event ve
            JOIN prescription_version pv ON pv.id = ve.prescription_version_id) ranked
   WHERE rn = 1`;

const LAST_DECISIONS_SQL = `
  SELECT decision_id, prescription_id, version_number, verification_event_id, trust_decision, primary_reason,
         risk_score, risk_band, decided_at
    FROM (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.prescription_id ORDER BY d.decided_at DESC, d.decision_id DESC) AS rn
            FROM trust_decision_log d
           WHERE d.prescription_id IS NOT NULL) ranked
   WHERE rn = 1`;

class AuditSummaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditSummaryError';
    this.code = code;
  }
}

function validateFilters(filters) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new AuditSummaryError('INVALID_FILTERS', 'filters must be an object');
  }
  const unknown = Object.keys(filters).filter((key) => !FILTER_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new AuditSummaryError('INVALID_FILTERS', `Unknown filter(s): ${unknown.join(', ')}`);
  }
  if (filters.currentStatus !== undefined && !STATUS_FILTERS.includes(filters.currentStatus)) {
    throw new AuditSummaryError('INVALID_FILTERS', `currentStatus must be one of ${STATUS_FILTERS.join(', ')}`);
  }
  if (filters.onlyConcerning !== undefined && typeof filters.onlyConcerning !== 'boolean') {
    throw new AuditSummaryError('INVALID_FILTERS', 'onlyConcerning must be a boolean');
  }
  return filters;
}

function createAuditSummary(pool, { integrityRecheck = createIntegrityRecheck(pool) } = {}) {
  async function getAuditSummaryList(filters = {}) {
    const { currentStatus, onlyConcerning = false } = validateFilters(filters);

    const statusClause = currentStatus ? ' WHERE pv.status = ?' : '';
    const [[prescriptions], [scans], [decisions]] = await Promise.all([
      pool.query(`${LATEST_VERSIONS_SQL}${statusClause} ORDER BY pv.prescription_id`, currentStatus ? [currentStatus] : []),
      pool.query(LAST_SCANS_SQL),
      pool.query(LAST_DECISIONS_SQL),
    ]);
    const scanByRx = new Map(scans.map((row) => [row.prescription_id, row]));
    const decisionByRx = new Map(decisions.map((row) => [row.prescription_id, row]));

    const rows = [];
    for (const { prescription_id: prescriptionId, status } of prescriptions) {
      const scan = scanByRx.get(prescriptionId);
      const decision = decisionByRx.get(prescriptionId);
      const recheck = await integrityRecheck.recheckCurrentIntegrity(prescriptionId); // full live recheck, sequential
      const row = {
        prescriptionId,
        currentStatus: status,
        lastScan: scan
          ? { eventId: Number(scan.event_id), result: scan.result, versionNumber: scan.version_number, timestamp: normalizeTimestamp(scan.timestamp) }
          : null,
        lastTrustDecision: decision
          ? {
              decisionId: Number(decision.decision_id),
              trustDecision: decision.trust_decision,
              primaryReason: decision.primary_reason,
              riskScore: decision.risk_score,
              riskBand: decision.risk_band,
              versionNumber: decision.version_number,
              verificationEventId: decision.verification_event_id === null ? null : Number(decision.verification_event_id),
              decidedAt: normalizeTimestamp(decision.decided_at),
            }
          : null,
        latestIntegrityIntact: isIntegrityIntact(recheck),
        integrityCheckedAt: recheck.checkedAt,
      };
      if (!onlyConcerning || row.latestIntegrityIntact === false) rows.push(row);
    }
    return rows;
  }

  return Object.freeze({ getAuditSummaryList });
}

module.exports = { createAuditSummary, AuditSummaryError, STATUS_FILTERS };
