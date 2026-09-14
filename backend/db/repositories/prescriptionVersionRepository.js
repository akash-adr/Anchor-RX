'use strict';

/**
 * prescription_version repository.
 *
 * Immutability guarantee (load-bearing for Modules 2–13):
 *   - There is NO generic update function in this module.
 *   - Every write to clinical columns goes through INSERT_VERSION_SQL.
 *   - The ONLY UPDATE statement is SUPERSEDE_SQL, a constant string whose
 *     SET clause is hard-coded to `status` and `amended_at`. No column name
 *     is ever interpolated from caller input.
 *
 * Integrity (Module 2): every INSERT carries its own freshly generated salt,
 * field_hashes and integrity_root, computed from the exact values being written.
 *
 * Versioning governance (Module 3):
 *   - provider_id is the ORIGINAL prescriber: copied forward unchanged on every version.
 *   - Only dosage_value, dosage_unit, frequency and duration_days are amendable.
 *   - amended_by_provider_id and reason are metadata: stored on the row, never hashed.
 *
 * Ledger anchoring (Module 4): every new version (create, amend, revoke) is anchored to the ledger
 * inside the SAME transaction that inserts it, and its ledger_entry_id is written by the same INSERT.
 * Either both the ledger entry and the version row commit, or neither does.
 * Lock order in every write transaction: ledger mutex → prescription rows.
 */

const crypto = require('crypto');
const hashEngine = require('../../integrity/hashEngine');
const { createLedgerService } = require('../../ledger/ledgerService');

const SELECT_COLUMNS = `
  id, prescription_id, version_number, parent_version_id,
  patient_id, provider_id,
  drug_name, dosage_value, dosage_unit, frequency, duration_days, drug_class,
  status, created_at, amended_at, amended_by_provider_id, reason,
  salt, field_hashes, integrity_root, ledger_anchor_ref`;

// The single write path for clinical data. salt/field_hashes/integrity_root are computed per version
// and ledger_anchor_ref is that version's own ledger entry — none of them is ever copied forward.
// status is supplied only by this module (NEW_VERSION_STATUSES), never by a caller.
const INSERT_VERSION_SQL = `
  INSERT INTO prescription_version
    (prescription_id, version_number, parent_version_id,
     patient_id, provider_id,
     drug_name, dosage_value, dosage_unit, frequency, duration_days, drug_class,
     salt, field_hashes, integrity_root, ledger_anchor_ref,
     status, amended_by_provider_id, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// The only UPDATE in this layer. Lifecycle metadata on the superseded row — nothing else.
const SUPERSEDE_SQL = `
  UPDATE prescription_version
     SET status = 'amended', amended_at = CURRENT_TIMESTAMP(3)
   WHERE id = ? AND status = 'active'`;

const SELECT_LATEST_FOR_UPDATE_SQL = `
  SELECT ${SELECT_COLUMNS} FROM prescription_version
   WHERE prescription_id = ?
   ORDER BY version_number DESC
   LIMIT 1
   FOR UPDATE`;

const NEW_VERSION_STATUSES = Object.freeze(['active', 'revoked']);

// Order matters: it is the INSERT parameter order after the version columns.
// This is also exactly the hashed field set.
const CLINICAL_FIELDS = Object.freeze([
  'patient_id',
  'provider_id',
  'drug_name',
  'dosage_value',
  'dosage_unit',
  'frequency',
  'duration_days',
  'drug_class',
]);

// patient_id / provider_id: identity of the prescription (who for, who prescribed).
// drug_name / drug_class: a different drug is a new prescription, not an amendment.
const AMENDABLE_FIELDS = Object.freeze(['dosage_value', 'dosage_unit', 'frequency', 'duration_days']);

const STRING_MAX_LENGTH = Object.freeze({
  patient_id: 32,
  provider_id: 32,
  drug_name: 120,
  dosage_unit: 16,
  frequency: 64,
  drug_class: 80,
});

const PROVIDER_ID_MAX_LENGTH = 32;
const REASON_MAX_LENGTH = 255;
const PRESCRIPTION_ID_PATTERN = /^RX-[A-Z0-9-]{4,29}$/; // fits VARCHAR(32)
const DOSAGE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/; // fits DECIMAL(12,3)

class RepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

function generatePrescriptionId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `RX-${date}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function assertPrescriptionId(prescriptionId) {
  if (typeof prescriptionId !== 'string' || !PRESCRIPTION_ID_PATTERN.test(prescriptionId)) {
    throw new RepositoryError('INVALID_PRESCRIPTION_ID', `Invalid prescription_id: ${prescriptionId}`);
  }
}

function normalizeField(key, value) {
  if (key === 'dosage_value') {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !DOSAGE_PATTERN.test(text) || Number(text) <= 0) {
      throw new RepositoryError('INVALID_FIELD', `dosage_value must be a positive number with ≤3 decimals, got: ${value}`);
    }
    return text;
  }
  if (key === 'duration_days') {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n <= 0) {
      throw new RepositoryError('INVALID_FIELD', `duration_days must be a positive integer, got: ${value}`);
    }
    return n;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryError('INVALID_FIELD', `${key} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > STRING_MAX_LENGTH[key]) {
    throw new RepositoryError('INVALID_FIELD', `${key} exceeds ${STRING_MAX_LENGTH[key]} characters`);
  }
  return trimmed;
}

function pickFields(input, allowed, { requireAll }) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError('INVALID_INPUT', 'Expected an object of prescription fields');
  }
  const disallowed = Object.keys(input).filter((key) => !allowed.includes(key));
  if (disallowed.length > 0) {
    throw new RepositoryError('FIELD_NOT_ALLOWED', `Field(s) not allowed: ${disallowed.join(', ')}`);
  }
  const fields = {};
  for (const key of allowed) {
    if (input[key] === undefined) {
      if (requireAll) throw new RepositoryError('MISSING_FIELD', `Missing required field: ${key}`);
      continue;
    }
    fields[key] = normalizeField(key, input[key]);
  }
  return fields;
}

function normalizeProviderRef(name, value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > PROVIDER_ID_MAX_LENGTH) {
    throw new RepositoryError('INVALID_FIELD', `${name} must be a non-empty string of at most ${PROVIDER_ID_MAX_LENGTH} characters`);
  }
  return value.trim();
}

function normalizeReason(value, { required }) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === undefined || text === null || text === '') {
    if (required) throw new RepositoryError('MISSING_FIELD', 'reason is required');
    return null;
  }
  if (typeof text !== 'string') {
    throw new RepositoryError('INVALID_FIELD', 'reason must be a string');
  }
  if (text.length > REASON_MAX_LENGTH) {
    throw new RepositoryError('INVALID_FIELD', `reason exceeds ${REASON_MAX_LENGTH} characters`);
  }
  return text;
}

function copyClinicalFields(row) {
  const fields = {};
  for (const key of CLINICAL_FIELDS) fields[key] = row[key];
  return fields;
}

function isSameValue(key, a, b) {
  return key === 'dosage_value' ? Number(a) === Number(b) : a === b;
}

function mapDbError(err) {
  if (err instanceof RepositoryError) return err;
  if (err && err.code === 'ER_DUP_ENTRY') {
    return new RepositoryError('DUPLICATE_VERSION', 'prescription_id/version_number already exists');
  }
  if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
    return new RepositoryError('UNKNOWN_REFERENCE', 'patient_id, provider_id or amended_by_provider_id does not exist');
  }
  return err; // includes LedgerError (e.g. ALREADY_ANCHORED), passed through unchanged
}

/**
 * @param pool mysql2 promise pool
 * @param {object} [options]
 * @param {(ctx: {prescription_id: string, version_number: number}) => string} [options.generateSalt]
 *        Salt source, called once per new version. Defaults to a random salt; only the demo seed
 *        overrides it (deterministic salts for stable demo roots).
 * @param [options.ledger] ledger service used for anchoring (defaults to the mock ledger on the same pool)
 */
function createPrescriptionVersionRepository(
  pool,
  { generateSalt = hashEngine.generateSalt, ledger = createLedgerService(pool) } = {},
) {
  async function getVersionById(id) {
    const [rows] = await pool.execute(`SELECT ${SELECT_COLUMNS} FROM prescription_version WHERE id = ?`, [id]);
    return rows[0] || null;
  }

  async function getPrescriptionChain(prescriptionId) {
    assertPrescriptionId(prescriptionId);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLUMNS} FROM prescription_version
        WHERE prescription_id = ?
        ORDER BY version_number ASC`,
      [prescriptionId],
    );
    return rows;
  }

  async function getVersion(prescriptionId, versionNumber) {
    assertPrescriptionId(prescriptionId);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLUMNS} FROM prescription_version
        WHERE prescription_id = ? AND version_number = ?`,
      [prescriptionId, versionNumber],
    );
    return rows[0] || null;
  }

  async function getLatestVersion(prescriptionId) {
    assertPrescriptionId(prescriptionId);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLUMNS} FROM prescription_version
        WHERE prescription_id = ?
        ORDER BY version_number DESC
        LIMIT 1`,
      [prescriptionId],
    );
    return rows[0] || null;
  }

  /**
   * Runs `work(conn)` in one transaction and returns its result. Any throw — from the ledger,
   * hashing, or any SQL statement — rolls back EVERYTHING the transaction did: the supersede UPDATE,
   * the ledger entry, and the version row. The ledger mutex is taken first (see lock order above).
   */
  async function inWriteTransaction(work) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await ledger.acquireWriteLock(conn);
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw mapDbError(err);
    } finally {
      conn.release();
    }
  }

  /**
   * Hash → anchor → insert, all on the caller's transaction connection. Never commits.
   * @returns {Promise<number>} the new row id
   */
  async function hashAnchorAndInsert(conn, { prescriptionId, versionNumber, parentVersionId, fields, status, amendedByProviderId, reason }) {
    if (!NEW_VERSION_STATUSES.includes(status)) {
      throw new Error(`Internal error: invalid status for new version: ${status}`);
    }

    // 1. Integrity data for exactly the clinical values being written (metadata never hashed).
    const salt = generateSalt({ prescription_id: prescriptionId, version_number: versionNumber });
    const fieldHashes = hashEngine.computeFieldHashes(fields, salt);
    const integrityRoot = hashEngine.computeIntegrityRoot(fieldHashes);

    // 2. Anchor BEFORE inserting, on the SAME connection: joins this transaction, never opens a nested one.
    const ledgerEntryId = await ledger.anchorEntry(prescriptionId, versionNumber, integrityRoot, conn);

    // 3. One INSERT writes the version together with its ledger reference — no follow-up UPDATE.
    const [inserted] = await conn.execute(INSERT_VERSION_SQL, [
      prescriptionId,
      versionNumber,
      parentVersionId,
      ...CLINICAL_FIELDS.map((key) => fields[key]),
      salt,
      JSON.stringify(fieldHashes),
      integrityRoot,
      ledgerEntryId,
      status,
      amendedByProviderId,
      reason,
    ]);
    return inserted.insertId;
  }

  /**
   * @param {object} data clinical fields; optional `prescription_id` (e.g. 'RX-DEMO-0001'),
   *                      otherwise one is generated.
   */
  async function createPrescription(data) {
    if (data === null || typeof data !== 'object') {
      throw new RepositoryError('INVALID_INPUT', 'Expected an object of prescription fields');
    }
    const { prescription_id: requestedId, ...rest } = data;
    const fields = pickFields(rest, CLINICAL_FIELDS, { requireAll: true });

    let prescriptionId = generatePrescriptionId();
    if (requestedId !== undefined) {
      assertPrescriptionId(requestedId);
      prescriptionId = requestedId;
    }

    const id = await inWriteTransaction((conn) =>
      hashAnchorAndInsert(conn, {
        prescriptionId,
        versionNumber: 1,
        parentVersionId: null,
        fields,
        status: 'active',
        amendedByProviderId: null, // version 1 is never "amended by" anyone
        reason: null,
      }),
    );
    return getVersionById(id);
  }

  /**
   * Shared path for version N+1: lock the latest row, require it to be active, derive the new row via
   * `build(latest)`, supersede the latest (status/amended_at only), then hash → anchor → insert.
   * Never modifies clinical columns of any existing row.
   */
  async function insertNextVersion(prescriptionId, build) {
    const id = await inWriteTransaction(async (conn) => {
      const [rows] = await conn.execute(SELECT_LATEST_FOR_UPDATE_SQL, [prescriptionId]);
      const latest = rows[0];
      if (!latest) {
        throw new RepositoryError('NOT_FOUND', `No prescription with id ${prescriptionId}`);
      }
      if (latest.status !== 'active') {
        throw new RepositoryError(
          'NOT_AMENDABLE',
          `Latest version is '${latest.status}', only 'active' can be amended or revoked`,
        );
      }

      const { fields, status, amendedByProviderId, reason } = build(latest);

      const [superseded] = await conn.execute(SUPERSEDE_SQL, [latest.id]);
      if (superseded.affectedRows !== 1) {
        throw new RepositoryError('CONCURRENT_MODIFICATION', 'Latest version changed during amendment');
      }

      return hashAnchorAndInsert(conn, {
        prescriptionId,
        versionNumber: latest.version_number + 1,
        parentVersionId: latest.id,
        fields,
        status,
        amendedByProviderId,
        reason,
      });
    });
    return getVersionById(id);
  }

  /**
   * Creates version N+1 with `changes` applied (dosage_value, dosage_unit, frequency, duration_days only).
   * provider_id, patient_id, drug_name and drug_class are always copied forward.
   *
   * @param {string} [amendedByProviderId] who performed the amendment; defaults to the original provider_id
   * @param {string} [reason] optional human-readable reason
   */
  async function amendPrescription(prescriptionId, changes, amendedByProviderId, reason) {
    assertPrescriptionId(prescriptionId);
    const updates = pickFields(changes, AMENDABLE_FIELDS, { requireAll: false });
    if (Object.keys(updates).length === 0) {
      throw new RepositoryError('NO_CHANGES', 'Amendment must change at least one field');
    }
    const amendedBy =
      amendedByProviderId === undefined || amendedByProviderId === null
        ? null
        : normalizeProviderRef('amendedByProviderId', amendedByProviderId);
    const amendmentReason = normalizeReason(reason, { required: false });

    return insertNextVersion(prescriptionId, (latest) => {
      if (Object.keys(updates).every((key) => isSameValue(key, updates[key], latest[key]))) {
        throw new RepositoryError('NO_CHANGES', 'Amendment values are identical to the current version');
      }
      return {
        fields: { ...copyClinicalFields(latest), ...updates },
        status: 'active',
        amendedByProviderId: amendedBy ?? latest.provider_id,
        reason: amendmentReason,
      };
    });
  }

  /**
   * Appends a terminal 'revoked' version: all clinical fields copied forward unchanged,
   * hashed with a fresh salt and anchored like any other version. No further versions can follow it.
   */
  async function insertRevocationVersion(prescriptionId, providerId, reason) {
    assertPrescriptionId(prescriptionId);
    const revokedBy = normalizeProviderRef('providerId', providerId);
    const revocationReason = normalizeReason(reason, { required: true });

    return insertNextVersion(prescriptionId, (latest) => ({
      fields: copyClinicalFields(latest),
      status: 'revoked',
      amendedByProviderId: revokedBy,
      reason: revocationReason,
    }));
  }

  return Object.freeze({
    createPrescription,
    amendPrescription,
    insertRevocationVersion,
    getPrescriptionChain,
    getLatestVersion,
    getVersion, // read-only; lookup by prescription_id + version_number (ledger verification)
    getVersionById, // read-only; used by tests to re-fetch a superseded row
  });
}

module.exports = {
  createPrescriptionVersionRepository,
  RepositoryError,
  CLINICAL_FIELDS,
  AMENDABLE_FIELDS,
};
