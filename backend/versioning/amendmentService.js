'use strict';

/**
 * Module 3 — authorized amendments, revocation, version diffs and provenance (medicine-scoped since Module 14).
 *
 * amendPrescriptionAuthorized and revokePrescription are the ONLY application paths that reach
 * the repository's write functions (and therefore Module 2's hashing). Every attempt is logged,
 * allowed or not.
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAuthorization } = require('./authorization');

// Module 14: an amendment changes ONE medicine of the current version, identified by its medicineId, and only these
// fields of it. Every other medicine is copied forward unchanged by the repository.
const AMENDABLE_FIELDS = Object.freeze(['dosageValue', 'dosageUnit', 'frequency', 'durationDays', 'quantityPrescribed']);

// The same fields as stored columns (used for display diffs).
const AMENDABLE_MEDICINE_COLUMNS = Object.freeze(['dosage_value', 'dosage_unit', 'frequency', 'duration_days', 'quantity_prescribed']);

// Fields that define WHAT is prescribed, FOR/BY WHOM, and the vitals recorded with it — changing them is a new prescription.
const IDENTITY_FIELDS = Object.freeze(['patientId', 'providerId', 'drugName', 'drugClass', 'heightCm', 'weightKg']);

// Keys that try to change WHICH medicines the prescription contains.
const MEDICINE_SET_CHANGE_KEY = /^(medicines|(add|remove|delete|insert|new)Medicines?(Ids?)?)$/i;

const AMENDMENT_REJECTIONS = Object.freeze({
  INVALID_AMENDMENT_FIELD: 'INVALID_AMENDMENT_FIELD',
  NO_CHANGES: 'NO_CHANGES',
  REASON_REQUIRED: 'REASON_REQUIRED',
  MEDICINE_ID_REQUIRED: 'MEDICINE_ID_REQUIRED',
  MEDICINE_SET_CHANGE_NOT_ALLOWED: 'MEDICINE_SET_CHANGE_NOT_ALLOWED',
});

// amendment_attempts has no action column; revocation log reasons carry this prefix.
const REVOCATION_LOG_PREFIX = 'REVOCATION:';

class AmendmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AmendmentError';
    this.code = code;
  }
}

const AUTHORIZATION_MESSAGES = Object.freeze({
  PRESCRIPTION_NOT_FOUND: 'Prescription not found',
  NOT_AMENDABLE_STATUS: 'Prescription is dispensed or revoked and can no longer be amended or revoked',
  NOT_AUTHORIZED_PROVIDER: 'Only the original prescriber or a provider they delegated can change this prescription',
});

function invalidFieldMessage(disallowed) {
  const identity = disallowed.filter((f) => IDENTITY_FIELDS.includes(f));
  const unknown = disallowed.filter((f) => !IDENTITY_FIELDS.includes(f));
  const parts = [];
  if (identity.length > 0) {
    parts.push(`${identity.join('/')} changes require a new prescription, not an amendment`);
  }
  if (unknown.length > 0) {
    parts.push(`unknown amendment field(s): ${unknown.join(', ')}`);
  }
  return `${parts.join('; ')} (amendable, on one medicine: ${AMENDABLE_FIELDS.join(', ')})`;
}

/**
 * DISPLAY logic for pharmacists/auditors: what changed between two version rows, in readable form.
 * This is NOT a security check. It compares whatever is currently in the rows, so it would happily
 * show a tampered value as if it were legitimate. Integrity must always be established with
 * hashEngine.verifyIntegrity (and the ledger anchor), never with this diff.
 */
function diffRows(prescriptionId, fromRow, toRow) {
  const base = { prescriptionId, fromVersion: fromRow.version_number, toVersion: toRow.version_number };

  if (toRow.status === 'revoked') {
    return {
      ...base,
      changedFields: [],
      revoked: true,
      revokedBy: toRow.amended_by_provider_id,
      revokedReason: toRow.reason,
      revokedAt: toRow.created_at,
    };
  }

  // Medicines are matched by sequence_number (their identity across versions; medicine_id differs per version).
  const changedFields = [];
  const fromBySequence = new Map((fromRow.medicines || []).map((medicine) => [medicine.sequence_number, medicine]));
  for (const toMedicine of toRow.medicines || []) {
    const fromMedicine = fromBySequence.get(toMedicine.sequence_number);
    if (!fromMedicine) continue; // the medicine set is fixed across amendments; nothing to compare
    for (const field of AMENDABLE_MEDICINE_COLUMNS) {
      // Exact comparison of stored values (dosage_value stays a DECIMAL string — never parsed).
      if (fromMedicine[field] === toMedicine[field]) continue;
      const entry = { medicine: toMedicine.sequence_number, drugName: toMedicine.drug_name, field, old: fromMedicine[field], new: toMedicine[field] };
      if (field === 'dosage_value') {
        entry.unit = toMedicine.dosage_unit;
        if (fromMedicine.dosage_unit !== toMedicine.dosage_unit) entry.oldUnit = fromMedicine.dosage_unit;
      }
      changedFields.push(entry);
    }
  }

  return {
    ...base,
    changedFields,
    amendedBy: toRow.amended_by_provider_id,
    // created_at of the "to" version = when this amendment happened.
    // (amended_at on a row means when it was later superseded, so it is NULL on the latest version.)
    amendedAt: toRow.created_at,
  };
}

function createAmendmentService(
  pool,
  {
    repository = createPrescriptionVersionRepository(pool),
    authorization = createAuthorization(pool, { repository }),
  } = {},
) {
  const { canAmend, logAmendmentAttempt } = authorization;

  async function reject(prescriptionId, providerId, code, message, logPrefix = '') {
    await logAmendmentAttempt(prescriptionId, providerId, false, `${logPrefix}${code}`);
    throw new AmendmentError(code, message);
  }

  /**
   * Shared tail for amend/revoke: authorize, log the decision BEFORE writing (so no unlogged write
   * can happen), run `write`, and log a failure if the repository refuses after authorization.
   */
  async function authorizeAndWrite(prescriptionId, providerId, logPrefix, write) {
    const decision = await canAmend(prescriptionId, providerId);
    if (!decision.allowed) {
      return reject(prescriptionId, providerId, decision.reason, AUTHORIZATION_MESSAGES[decision.reason] || decision.reason, logPrefix);
    }

    await logAmendmentAttempt(prescriptionId, providerId, true, `${logPrefix}${decision.reason}`);

    try {
      return await write();
    } catch (err) {
      // Authorized but not applied (invalid value, identical values, status changed meanwhile):
      // record the outcome so the log never shows only "allowed" for a change that didn't happen.
      const code = (err && err.code) || 'UNKNOWN';
      await logAmendmentAttempt(prescriptionId, providerId, false, `${logPrefix}AMENDMENT_FAILED:${code}`);
      throw err;
    }
  }

  /**
   * @param {object} changes { medicineId, dosageValue?, dosageUnit?, frequency?, durationDays?, quantityPrescribed? }
   *        — exactly ONE medicine per call, identified by its medicine_id in the CURRENT version.
   * @returns {Promise<object>} the newly created prescription_version row (with its medicines)
   * @throws {AmendmentError} code = MEDICINE_SET_CHANGE_NOT_ALLOWED | INVALID_AMENDMENT_FIELD | MEDICINE_ID_REQUIRED |
   *         NO_CHANGES | PRESCRIPTION_NOT_FOUND | NOT_AMENDABLE_STATUS | NOT_AUTHORIZED_PROVIDER
   *         (repository errors, e.g. MEDICINE_NOT_IN_CURRENT_VERSION, pass through after logging)
   */
  async function amendPrescriptionAuthorized(prescriptionId, changes, requestingProviderId, reason) {
    // Shape of the request — rejected before authorization is even consulted.
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
      return reject(prescriptionId, requestingProviderId, AMENDMENT_REJECTIONS.NO_CHANGES, 'changes must be an object: { medicineId, ...amendable fields }');
    }
    const setChanges = Object.keys(changes).filter((key) => MEDICINE_SET_CHANGE_KEY.test(key));
    if (setChanges.length > 0) {
      return reject(
        prescriptionId,
        requestingProviderId,
        AMENDMENT_REJECTIONS.MEDICINE_SET_CHANGE_NOT_ALLOWED,
        `Adding or removing a medicine requires a new prescription, not an amendment (got: ${setChanges.join(', ')})`,
      );
    }
    const disallowed = Object.keys(changes).filter((key) => key !== 'medicineId' && !AMENDABLE_FIELDS.includes(key));
    if (disallowed.length > 0) {
      return reject(prescriptionId, requestingProviderId, AMENDMENT_REJECTIONS.INVALID_AMENDMENT_FIELD, invalidFieldMessage(disallowed));
    }
    if (!Number.isSafeInteger(changes.medicineId) || changes.medicineId < 1) {
      return reject(
        prescriptionId,
        requestingProviderId,
        AMENDMENT_REJECTIONS.MEDICINE_ID_REQUIRED,
        'medicineId is required: an amendment changes exactly one medicine of the current version',
      );
    }
    if (AMENDABLE_FIELDS.every((field) => changes[field] === undefined)) {
      return reject(prescriptionId, requestingProviderId, AMENDMENT_REJECTIONS.NO_CHANGES, 'Amendment must change at least one field of the medicine');
    }

    // A rejected attempt never reaches the repository or the hash engine.
    return authorizeAndWrite(prescriptionId, requestingProviderId, '', () =>
      repository.amendPrescription(prescriptionId, changes, requestingProviderId, reason),
    );
  }

  /**
   * Appends a terminal 'revoked' version. Same authorization rule as amendments; afterwards
   * canAmend returns NOT_AMENDABLE_STATUS for this prescription because the latest status is 'revoked'.
   * @returns {Promise<object>} the new revoked prescription_version row
   */
  async function revokePrescription(prescriptionId, providerId, reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      return reject(prescriptionId, providerId, AMENDMENT_REJECTIONS.REASON_REQUIRED, 'A reason is required to revoke a prescription', REVOCATION_LOG_PREFIX);
    }

    return authorizeAndWrite(prescriptionId, providerId, REVOCATION_LOG_PREFIX, () =>
      repository.insertRevocationVersion(prescriptionId, providerId, reason),
    );
  }

  async function diffVersions(prescriptionId, fromVersionNumber, toVersionNumber) {
    for (const [name, n] of [['fromVersionNumber', fromVersionNumber], ['toVersionNumber', toVersionNumber]]) {
      if (!Number.isInteger(n) || n < 1) {
        throw new AmendmentError('INVALID_VERSION', `${name} must be a positive integer, got ${n}`);
      }
    }

    const chain = await repository.getPrescriptionChain(prescriptionId);
    const fromRow = chain.find((v) => v.version_number === fromVersionNumber);
    const toRow = chain.find((v) => v.version_number === toVersionNumber);
    if (!fromRow || !toRow) {
      const missing = [!fromRow && fromVersionNumber, !toRow && toVersionNumber].filter(Boolean);
      throw new AmendmentError('VERSION_NOT_FOUND', `${prescriptionId} has no version(s): ${missing.join(', ')}`);
    }

    return diffRows(prescriptionId, fromRow, toRow);
  }

  /**
   * Whole chain plus one diff per consecutive pair (N versions → N-1 diffs), computed from a single
   * chain read so chain and diffs always describe the same snapshot. Display data, not verification.
   */
  async function getFullProvenance(prescriptionId) {
    const chain = await repository.getPrescriptionChain(prescriptionId);
    if (chain.length === 0) {
      throw new AmendmentError('PRESCRIPTION_NOT_FOUND', `No prescription with id ${prescriptionId}`);
    }

    const diffs = [];
    for (let i = 1; i < chain.length; i += 1) {
      diffs.push(diffRows(prescriptionId, chain[i - 1], chain[i]));
    }
    return { prescriptionId, chain, diffs };
  }

  /**
   * @returns {Promise<object|null>} the latest version row, or null if the prescription is revoked
   *          or does not exist. A 'dispensed' latest version is still returned.
   */
  async function getActiveVersion(prescriptionId) {
    const latest = await repository.getLatestVersion(prescriptionId);
    if (!latest || latest.status === 'revoked') return null;
    return latest;
  }

  return Object.freeze({
    amendPrescriptionAuthorized,
    revokePrescription,
    diffVersions,
    getFullProvenance,
    getActiveVersion,
  });
}

module.exports = {
  createAmendmentService,
  AmendmentError,
  AMENDMENT_REJECTIONS,
  AMENDABLE_FIELDS,
  IDENTITY_FIELDS,
  REVOCATION_LOG_PREFIX,
};
