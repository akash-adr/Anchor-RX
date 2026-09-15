'use strict';

/**
 * Anchor Rx — Module 10: LIVE integrity recheck — on demand, right now.
 *
 *   recheckCurrentIntegrity(prescriptionId) → { fieldVerification, ledgerVerification, checkedAt, version }
 *     fieldVerification   Module 2 verifyIntegrity(row, row.field_hashes, row.salt) on the row's CURRENT stored data
 *     ledgerVerification  Module 4 verifyAnchor(prescriptionId, versionNumber), recomputed now (anchoredAt → epoch ms)
 *     checkedAt           epoch ms when this check completed
 *     version             { prescriptionId, versionNumber, status, basis } — exactly which version was checked
 *
 * STRUCTURALLY SEPARATE FROM THE HISTORICAL TIMELINE (Step 2): this never reads verification_event or
 * trust_decision_log, never calls getMergedTimeline, and writes nothing (unlike a pharmacy scan, it logs no event).
 * A past "verified" scan records what was true THEN; this reports what is true NOW, and the two can disagree — that
 * disagreement is exactly what an auditor is looking for.
 * UI DESIGN CONSTRAINT (carried forward to Step 5): the live recheck must be displayed visually distinct from the
 * historical timeline — never merged into it as if it were another past event.
 *
 * Which version is checked:
 *   - Module 3 getActiveVersion → the latest version, including a dispensed one            basis "active_version"
 *   - revoked (getActiveVersion → null) → the LATEST version in the chain, i.e. the terminal
 *     revoked row: an auditor investigating a revoked prescription still needs to know
 *     whether its last recorded state has been altered since                                basis "latest_version_revoked"
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createLedgerService } = require('../ledger/ledgerService');
const hashEngine = require('../integrity/hashEngine');
const { normalizeTimestamp } = require('./normalizeTimestamp');

class AuditRecheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditRecheckError';
    this.code = code;
  }
}

/** Module 2 call. Stored hashes/salt so corrupted they cannot be recomputed report as failed integrity (as in Module 6). */
function verifyFields(row) {
  try {
    return hashEngine.verifyIntegrity(row, row.field_hashes, row.salt);
  } catch (err) {
    return { valid: false, tamperedFields: [], integrityRootMatch: false, unverifiable: true, error: err.message };
  }
}

/**
 * True only when the live data matches its own field hashes AND the version is anchored with a matching root AND the
 * ledger chain is intact — the same conditions Module 6 reports as tampered / forged. Not a new rule.
 */
function isIntegrityIntact({ fieldVerification, ledgerVerification }) {
  return (
    fieldVerification.valid === true &&
    ledgerVerification.anchored === true &&
    ledgerVerification.integrityRootMatch === true &&
    ledgerVerification.chainIntact === true
  );
}

function createIntegrityRecheck(
  pool,
  {
    repository = createPrescriptionVersionRepository(pool),
    amendmentService = createAmendmentService(pool, { repository }),
    ledger = createLedgerService(pool, { repository }),
    now = () => Date.now(),
  } = {},
) {
  async function resolveVersionToCheck(prescriptionId) {
    const active = await amendmentService.getActiveVersion(prescriptionId);
    if (active) return { row: active, basis: 'active_version' };
    const latest = await repository.getLatestVersion(prescriptionId); // revoked: still check its last recorded state
    if (latest) return { row: latest, basis: 'latest_version_revoked' };
    throw new AuditRecheckError('PRESCRIPTION_NOT_FOUND', `No prescription with id ${prescriptionId}`);
  }

  /**
   * @throws {AuditRecheckError} INVALID_PRESCRIPTION_ID | PRESCRIPTION_NOT_FOUND
   */
  async function recheckCurrentIntegrity(prescriptionId) {
    if (typeof prescriptionId !== 'string' || prescriptionId.trim() === '') {
      throw new AuditRecheckError('INVALID_PRESCRIPTION_ID', 'prescriptionId must be a non-empty string');
    }
    const { row, basis } = await resolveVersionToCheck(prescriptionId);

    const fieldVerification = verifyFields(row);
    const anchor = await ledger.verifyAnchor(row.prescription_id, row.version_number);
    const ledgerVerification = { ...anchor, anchoredAt: anchor.anchoredAt == null ? null : normalizeTimestamp(anchor.anchoredAt) };

    return {
      fieldVerification,
      ledgerVerification,
      checkedAt: now(),
      version: { prescriptionId: row.prescription_id, versionNumber: row.version_number, status: row.status, basis },
    };
  }

  return Object.freeze({ recheckCurrentIntegrity });
}

module.exports = { createIntegrityRecheck, isIntegrityIntact, AuditRecheckError };
