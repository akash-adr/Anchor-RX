'use strict';

/**
 * Anchor Rx — Module 6: pharmacy scan verification.
 *
 * ORCHESTRATION ONLY. This module decides nothing about hashes or the ledger itself:
 *   - QR parsing            → qrEngine.parseQrPayload
 *   - field integrity       → hashEngine.verifyIntegrity        (Module 2)
 *   - ledger anchor + chain → ledgerService.verifyAnchor        (Module 4)
 *   - active / revoked      → amendmentService.getActiveVersion (Module 3)
 * It also makes NO Dispense / Review / Block decision — that is Module 9's job (with Module 8's risk score).
 *
 * Precedence is fixed and sequential (first failing check wins):
 *   a malformed_qr → b unknown_prescription → c provider_identity_issue → d tampered → e forged
 *   → f revoked → g stale_version → h verified
 * Every branch logs exactly one verification_event before returning.
 */

const hashEngine = require('../integrity/hashEngine');
const { parseQrPayload } = require('./qrEngine');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createLedgerService } = require('../ledger/ledgerService');
const { createAmendmentService } = require('../versioning/amendmentService');

const SCAN_RESULTS = Object.freeze({
  MALFORMED_QR: 'malformed_qr',
  UNKNOWN_PRESCRIPTION: 'unknown_prescription',
  PROVIDER_IDENTITY_ISSUE: 'provider_identity_issue',
  TAMPERED: 'tampered',
  FORGED: 'forged',
  REVOKED: 'revoked',
  STALE_VERSION: 'stale_version',
  VERIFIED: 'verified',
});

const BLOCKING_PROVIDER_STATUSES = new Set(['flagged', 'inactive']);

const INSERT_EVENT_SQL =
  'INSERT INTO verification_event (prescription_version_id, pharmacy_id, result, `timestamp`) VALUES (?, ?, ?, ?)';

class PharmacyVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PharmacyVerificationError';
    this.code = code;
  }
}

/**
 * Module 2 call. A row whose stored hashes or salt are so corrupted that they cannot even be recomputed
 * (verifyIntegrity throws) is reported as failed integrity — it must surface as "tampered", never crash.
 */
function runFieldVerification(version) {
  try {
    return hashEngine.verifyIntegrity(version, version.field_hashes, version.salt);
  } catch (err) {
    return { valid: false, tamperedFields: [], integrityRootMatch: false, unverifiable: true, error: err.message };
  }
}

/**
 * @param pool mysql2 promise pool
 * @param {object} [options] injectable collaborators (tests pass the test-database instances)
 */
function createPharmacyVerification(
  pool,
  {
    repository = createPrescriptionVersionRepository(pool),
    ledger = createLedgerService(pool, { repository }),
    amendmentService = createAmendmentService(pool, { repository }),
  } = {},
) {
  // A scan must be attributable. An unknown pharmacy is a setup error, not a scan outcome, and cannot be
  // logged (FK), so it throws before anything else. Compared exactly: the column collation is case-insensitive.
  async function assertKnownPharmacy(pharmacyId) {
    if (typeof pharmacyId === 'string' && pharmacyId !== '') {
      const [rows] = await pool.execute('SELECT pharmacy_id FROM pharmacy WHERE pharmacy_id = ?', [pharmacyId]);
      if (rows.some((row) => row.pharmacy_id === pharmacyId)) return;
    }
    throw new PharmacyVerificationError('UNKNOWN_PHARMACY', `Unknown pharmacyId: ${JSON.stringify(pharmacyId)}`);
  }

  /**
   * @param {string} rawScanData exactly what the scanner produced
   * @param {string} pharmacyId e.g. "PHM-001"
   * @returns {Promise<{
   *   scanResult: string, prescriptionId: string|null, versionNumber: number|null,
   *   fieldVerification: object|null, ledgerVerification: object|null, providerStatus: string|null,
   *   currentActiveVersion: number|null, scannedAt: Date
   * }>} a field is null only when its check did not run
   */
  async function verifyScan(rawScanData, pharmacyId) {
    const scannedAt = new Date();
    await assertKnownPharmacy(pharmacyId);

    const result = {
      scanResult: null,
      prescriptionId: null,
      versionNumber: null,
      fieldVerification: null,
      ledgerVerification: null,
      providerStatus: null,
      currentActiveVersion: null,
      scannedAt,
    };

    // The single exit: log exactly one verification_event, then return. If logging fails, this throws —
    // an unaudited verification result is never handed back.
    const finish = async (scanResult, prescriptionVersionId) => {
      result.scanResult = scanResult;
      await pool.execute(INSERT_EVENT_SQL, [prescriptionVersionId, pharmacyId, scanResult, scannedAt]);
      return result;
    };

    // (a) Malformed QR — nothing to reference.
    const parsed = parseQrPayload(rawScanData);
    if (!parsed.valid) {
      return finish(SCAN_RESULTS.MALFORMED_QR, null);
    }
    const { prescriptionId, versionNumber } = parsed.payload;
    result.prescriptionId = prescriptionId;
    result.versionNumber = versionNumber;

    // (b) Unknown prescription version — nothing to reference.
    const version = await repository.getVersion(prescriptionId, versionNumber);
    if (!version) {
      return finish(SCAN_RESULTS.UNKNOWN_PRESCRIPTION, null);
    }

    // (c) Provider identity — overrides every check below.
    const [providers] = await pool.execute('SELECT status FROM provider WHERE provider_id = ?', [version.provider_id]);
    const provider = providers[0] ?? null;
    result.providerStatus = provider ? provider.status : null;
    if (!provider || BLOCKING_PROVIDER_STATUSES.has(provider.status)) {
      return finish(SCAN_RESULTS.PROVIDER_IDENTITY_ISSUE, version.id);
    }

    // (d) Live data vs the row's own stored field hashes (Module 2).
    result.fieldVerification = runFieldVerification(version);
    if (!result.fieldVerification.valid) {
      return finish(SCAN_RESULTS.TAMPERED, version.id);
    }

    // (e) Live data vs the externally anchored root, and the ledger chain itself (Module 4).
    result.ledgerVerification = await ledger.verifyAnchor(prescriptionId, versionNumber);
    if (!result.ledgerVerification.chainIntact || !result.ledgerVerification.integrityRootMatch) {
      return finish(SCAN_RESULTS.FORGED, version.id);
    }

    // (f) Revoked chain (Module 3: getActiveVersion → null once the latest version is revoked).
    const activeVersion = await amendmentService.getActiveVersion(prescriptionId);
    if (!activeVersion) {
      return finish(SCAN_RESULTS.REVOKED, version.id);
    }

    // (g) Superseded by a legitimate newer version — calm, not an attack.
    result.currentActiveVersion = activeVersion.version_number;
    if (activeVersion.version_number !== versionNumber) {
      return finish(SCAN_RESULTS.STALE_VERSION, version.id);
    }

    // (h) Every check passed.
    return finish(SCAN_RESULTS.VERIFIED, version.id);
  }

  return Object.freeze({ verifyScan });
}

module.exports = { createPharmacyVerification, SCAN_RESULTS, PharmacyVerificationError };
