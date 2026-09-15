'use strict';

/**
 * prescription_version repository (multi-medicine since Module 14).
 *
 * A prescription VERSION is one prescription_version row (patient, prescriber, recorded vitals, lifecycle, integrity
 * data, ledger anchor) plus its prescription_medicine rows — one per medicine, with sequence_number = the medicine's
 * 1-based position in the order it was SUBMITTED. sequence_number is the stable identity ("medicine_N") used by the
 * hash engine and tamper reports; it is never re-derived from medicine_id or insertion order.
 *
 * Immutability guarantee (load-bearing for Modules 2–13):
 *   - There is NO generic update function in this module.
 *   - Clinical data is only ever written by INSERT_VERSION_SQL and INSERT_MEDICINE_SQL.
 *   - The ONLY UPDATE statement is SUPERSEDE_SQL, a constant string whose SET clause is hard-coded to `status` and
 *     `amended_at`. No column name is ever interpolated from caller input.
 *   - Medicine rows are never modified: every new version (amendment or revocation) gets its OWN copies of every
 *     medicine, so medicine_id values belong to exactly one version.
 *
 * Integrity (Module 2): every new version carries its own freshly generated salt, field_hashes and integrity_root,
 * computed from the exact values being written — the prescription fields and every medicine.
 *
 * Versioning governance (Module 3):
 *   - provider_id is the ORIGINAL prescriber: copied forward unchanged on every version.
 *   - An amendment changes ONE medicine (identified by its medicine_id in the current version), and only its
 *     dosage_value, dosage_unit, frequency, duration_days, quantity_prescribed. Adding or removing a medicine,
 *     changing drug name/class, patient, prescriber or recorded vitals requires a new prescription.
 *   - amended_by_provider_id and reason are metadata: stored on the row, never hashed.
 *
 * Ledger anchoring (Module 4): every new version (create, amend, revoke) is anchored to the ledger inside the SAME
 * transaction that inserts it and all of its medicine rows; its ledger_entry_id is written by the same INSERT.
 * Either the ledger entry, the version row and every medicine row commit together, or none of them does.
 * Lock order in every write transaction: ledger mutex → prescription rows.
 *
 * Inputs are camelCase ({ patientId, providerId, heightCm, weightKg, medicines: [...] }); returned rows are the
 * snake_case database columns with a `medicines` array (ordered by sequence_number) attached.
 */

const crypto = require('crypto');
const hashEngine = require('../../integrity/hashEngine');
const { createLedgerService } = require('../../ledger/ledgerService');

const SELECT_COLUMNS = `
  id, prescription_id, version_number, parent_version_id,
  patient_id, provider_id, height_cm, weight_kg, route,
  status, created_at, amended_at, amended_by_provider_id, reason,
  salt, field_hashes, integrity_root, ledger_anchor_ref`;

// Order matters: it is the INSERT parameter order for a medicine row. This is also the hashed per-medicine field set.
const MEDICINE_COLUMNS = Object.freeze([
  'drug_name',
  'drug_class',
  'dosage_value',
  'dosage_unit',
  'frequency',
  'duration_days',
  'quantity_prescribed',
]);

const SELECT_MEDICINE_COLUMNS = `medicine_id, prescription_version_id, sequence_number, ${MEDICINE_COLUMNS.join(', ')}`;

// The single write path for a version row. salt/field_hashes/integrity_root are computed per version and
// ledger_anchor_ref is that version's own ledger entry — none of them is ever copied forward.
// status is supplied only by this module (NEW_VERSION_STATUSES), never by a caller.
const INSERT_VERSION_SQL = `
  INSERT INTO prescription_version
    (prescription_id, version_number, parent_version_id,
     patient_id, provider_id, height_cm, weight_kg,
     salt, field_hashes, integrity_root, ledger_anchor_ref,
     status, amended_by_provider_id, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// The single write path for a medicine row (always for a brand-new version).
const INSERT_MEDICINE_SQL = `
  INSERT INTO prescription_medicine
    (prescription_version_id, sequence_number, ${MEDICINE_COLUMNS.join(', ')})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

// camelCase input key → column.
const PRESCRIPTION_INPUT = Object.freeze({ patientId: 'patient_id', providerId: 'provider_id', heightCm: 'height_cm', weightKg: 'weight_kg' });
const MEDICINE_INPUT = Object.freeze({
  drugName: 'drug_name',
  drugClass: 'drug_class',
  dosageValue: 'dosage_value',
  dosageUnit: 'dosage_unit',
  frequency: 'frequency',
  durationDays: 'duration_days',
  quantityPrescribed: 'quantity_prescribed',
});

// Per medicine, per amendment. drugName/drugClass: a different drug is a new prescription, not an amendment.
const AMENDABLE_MEDICINE_FIELDS = Object.freeze(['dosageValue', 'dosageUnit', 'frequency', 'durationDays', 'quantityPrescribed']);

// Keys that try to change WHICH medicines the prescription contains — never allowed in an amendment.
const MEDICINE_SET_CHANGE_KEY = /^(medicines|(add|remove|delete|insert|new)Medicines?(Ids?)?)$/i;

const STRING_MAX_LENGTH = Object.freeze({
  patient_id: 32,
  provider_id: 32,
  drug_name: 120,
  drug_class: 80,
  dosage_unit: 16,
  frequency: 64,
});

const PROVIDER_ID_MAX_LENGTH = 32;
const REASON_MAX_LENGTH = 255;
const PRESCRIPTION_ID_PATTERN = /^RX-[A-Z0-9-]{4,29}$/; // fits VARCHAR(32)
const DOSAGE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/; // fits DECIMAL(12,3)
const HEIGHT_PATTERN = /^\d{1,4}(\.\d)?$/; // fits DECIMAL(5,1)
const WEIGHT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/; // fits DECIMAL(5,2)

class RepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function generatePrescriptionId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `RX-${date}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function assertPrescriptionId(prescriptionId) {
  if (typeof prescriptionId !== 'string' || !PRESCRIPTION_ID_PATTERN.test(prescriptionId)) {
    throw new RepositoryError('INVALID_PRESCRIPTION_ID', `Invalid prescription_id: ${prescriptionId}`);
  }
}

/** Validates one value for its column and returns what is written. Decimals stay strings (never parsed to floats). */
function normalizeColumnValue(column, value, label) {
  const decimal = (pattern, description) => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !pattern.test(text.trim()) || Number(text) <= 0) {
      throw new RepositoryError('INVALID_FIELD', `${label} must be ${description}, got: ${value}`);
    }
    return text.trim();
  };
  const positiveInteger = () => {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new RepositoryError('INVALID_FIELD', `${label} must be a positive integer, got: ${value}`);
    }
    return n;
  };

  switch (column) {
    case 'dosage_value':
      return decimal(DOSAGE_PATTERN, 'a positive number with ≤3 decimals');
    case 'height_cm':
      return decimal(HEIGHT_PATTERN, 'a positive number of centimetres with ≤1 decimal');
    case 'weight_kg':
      return decimal(WEIGHT_PATTERN, 'a positive number of kilograms with ≤2 decimals');
    case 'duration_days':
    case 'quantity_prescribed':
      return positiveInteger();
    default: {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new RepositoryError('INVALID_FIELD', `${label} must be a non-empty string`);
      }
      const trimmed = value.trim();
      if (trimmed.length > STRING_MAX_LENGTH[column]) {
        throw new RepositoryError('INVALID_FIELD', `${label} exceeds ${STRING_MAX_LENGTH[column]} characters`);
      }
      return trimmed;
    }
  }
}

function rejectUnknownKeys(input, allowed, label) {
  const disallowed = Object.keys(input).filter((key) => !allowed.includes(key));
  if (disallowed.length > 0) {
    throw new RepositoryError('FIELD_NOT_ALLOWED', `${label}field(s) not allowed: ${disallowed.join(', ')}`);
  }
}

/** { patientId, providerId, heightCm?, weightKg?, medicines: [...] } → { top, medicines } (column names). */
function normalizeNewPrescription(data) {
  if (!isPlainObject(data)) {
    throw new RepositoryError('INVALID_INPUT', 'Expected an object: { patientId, providerId, heightCm, weightKg, medicines }');
  }
  rejectUnknownKeys(data, ['prescriptionId', ...Object.keys(PRESCRIPTION_INPUT), 'medicines'], '');

  const top = {};
  for (const [key, column] of Object.entries(PRESCRIPTION_INPUT)) {
    const optional = column === 'height_cm' || column === 'weight_kg';
    if (data[key] === undefined || (optional && data[key] === null)) {
      if (!optional) throw new RepositoryError('MISSING_FIELD', `Missing required field: ${key}`);
      top[column] = null; // vitals not recorded
      continue;
    }
    top[column] = normalizeColumnValue(column, data[key], key);
  }

  if (data.medicines === undefined) {
    throw new RepositoryError('MISSING_FIELD', 'Missing required field: medicines');
  }
  if (!Array.isArray(data.medicines)) {
    throw new RepositoryError('INVALID_INPUT', 'medicines must be an array');
  }
  if (data.medicines.length === 0) {
    throw new RepositoryError('NO_MEDICINES', 'A prescription must contain at least one medicine');
  }

  // sequence_number = 1-based position in the SUBMITTED array — assigned here, once, and stored.
  const medicines = data.medicines.map((input, index) => {
    const sequenceNumber = index + 1;
    const label = `medicine ${sequenceNumber}`;
    if (!isPlainObject(input)) {
      throw new RepositoryError('INVALID_INPUT', `${label} must be an object`);
    }
    rejectUnknownKeys(input, Object.keys(MEDICINE_INPUT), `${label}: `);
    const medicine = { sequence_number: sequenceNumber };
    for (const [key, column] of Object.entries(MEDICINE_INPUT)) {
      if (input[key] === undefined || input[key] === null) {
        throw new RepositoryError('MISSING_FIELD', `${label}: missing required field ${key}`);
      }
      medicine[column] = normalizeColumnValue(column, input[key], `${label} ${key}`);
    }
    return medicine;
  });

  return { top, medicines };
}

/** { medicineId, ...amendable fields } → { medicineId, updates } (column names). */
function normalizeAmendment(changes) {
  if (!isPlainObject(changes)) {
    throw new RepositoryError('INVALID_INPUT', 'changes must be an object: { medicineId, ...fields to change }');
  }
  const setChanges = Object.keys(changes).filter((key) => MEDICINE_SET_CHANGE_KEY.test(key));
  if (setChanges.length > 0) {
    throw new RepositoryError(
      'MEDICINE_SET_CHANGE_NOT_ALLOWED',
      `Adding or removing a medicine requires a new prescription, not an amendment (got: ${setChanges.join(', ')})`,
    );
  }
  rejectUnknownKeys(changes, ['medicineId', ...AMENDABLE_MEDICINE_FIELDS], '');

  const { medicineId } = changes;
  if (!Number.isSafeInteger(medicineId) || medicineId < 1) {
    throw new RepositoryError(
      'MEDICINE_ID_REQUIRED',
      'medicineId must identify exactly one medicine of the current version (a positive integer medicine_id)',
    );
  }

  const updates = {};
  for (const key of AMENDABLE_MEDICINE_FIELDS) {
    if (changes[key] !== undefined) updates[MEDICINE_INPUT[key]] = normalizeColumnValue(MEDICINE_INPUT[key], changes[key], key);
  }
  if (Object.keys(updates).length === 0) {
    throw new RepositoryError('NO_CHANGES', 'Amendment must change at least one field of the medicine');
  }
  return { medicineId, updates };
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

const copyPrescriptionFields = (row) => ({
  patient_id: row.patient_id,
  provider_id: row.provider_id,
  height_cm: row.height_cm,
  weight_kg: row.weight_kg,
});

function copyMedicine(row) {
  const medicine = { sequence_number: row.sequence_number };
  for (const column of MEDICINE_COLUMNS) medicine[column] = row[column];
  return medicine;
}

// Same comparison the hash engine makes (exact decimal strings, unit/class case-insensitive) — never a float compare.
const isSameValue = (column, a, b) => hashEngine.normalizeField(column, a) === hashEngine.normalizeField(column, b);

function mapDbError(err) {
  if (err instanceof RepositoryError) return err;
  if (err && err.code === 'ER_DUP_ENTRY') {
    return new RepositoryError('DUPLICATE_VERSION', 'prescription_id/version_number (or a medicine sequence_number) already exists');
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
  /** Medicine rows for the given version ids, grouped by version, each group ordered by sequence_number. */
  async function loadMedicines(executor, versionIds) {
    const byVersion = new Map(versionIds.map((id) => [id, []]));
    if (versionIds.length === 0) return byVersion;
    const placeholders = versionIds.map(() => '?').join(', ');
    const [rows] = await executor.execute(
      `SELECT ${SELECT_MEDICINE_COLUMNS} FROM prescription_medicine
        WHERE prescription_version_id IN (${placeholders})
        ORDER BY prescription_version_id, sequence_number`,
      versionIds,
    );
    for (const row of rows) byVersion.get(row.prescription_version_id).push({ ...row });
    return byVersion;
  }

  async function withMedicines(rows) {
    const byVersion = await loadMedicines(pool, rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, medicines: byVersion.get(row.id) }));
  }

  async function getVersionById(id) {
    const [rows] = await pool.execute(`SELECT ${SELECT_COLUMNS} FROM prescription_version WHERE id = ?`, [id]);
    return rows[0] ? (await withMedicines(rows))[0] : null;
  }

  async function getPrescriptionChain(prescriptionId) {
    assertPrescriptionId(prescriptionId);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLUMNS} FROM prescription_version
        WHERE prescription_id = ?
        ORDER BY version_number ASC`,
      [prescriptionId],
    );
    return withMedicines(rows);
  }

  async function getVersion(prescriptionId, versionNumber) {
    assertPrescriptionId(prescriptionId);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLUMNS} FROM prescription_version
        WHERE prescription_id = ? AND version_number = ?`,
      [prescriptionId, versionNumber],
    );
    return rows[0] ? (await withMedicines(rows))[0] : null;
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
    return rows[0] ? (await withMedicines(rows))[0] : null;
  }

  /**
   * Runs `work(conn)` in one transaction and returns its result. Any throw — from the ledger, hashing, or any SQL
   * statement (including any medicine INSERT) — rolls back EVERYTHING the transaction did: the supersede UPDATE, the
   * ledger entry, the version row and every medicine row. The ledger mutex is taken first (see lock order above).
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
   * Hash → anchor → insert version → insert every medicine, all on the caller's transaction connection. Never commits.
   * `medicines` must be ordered by sequence_number (1..N).
   * @returns {Promise<number>} the new version row id
   */
  async function hashAnchorAndInsert(conn, { prescriptionId, versionNumber, parentVersionId, prescription, medicines, status, amendedByProviderId, reason }) {
    if (!NEW_VERSION_STATUSES.includes(status)) {
      throw new Error(`Internal error: invalid status for new version: ${status}`);
    }

    // 1. Integrity data for exactly the values being written: prescription fields + every medicine (metadata never hashed).
    const salt = generateSalt({ prescription_id: prescriptionId, version_number: versionNumber });
    const fieldHashes = hashEngine.computeFieldHashes({ ...prescription, medicines }, salt);
    const integrityRoot = hashEngine.computeIntegrityRoot(fieldHashes);

    // 2. Anchor BEFORE inserting, on the SAME connection: joins this transaction, never opens a nested one.
    const ledgerEntryId = await ledger.anchorEntry(prescriptionId, versionNumber, integrityRoot, conn);

    // 3. One INSERT writes the version together with its ledger reference — no follow-up UPDATE.
    const [inserted] = await conn.execute(INSERT_VERSION_SQL, [
      prescriptionId,
      versionNumber,
      parentVersionId,
      prescription.patient_id,
      prescription.provider_id,
      prescription.height_cm,
      prescription.weight_kg,
      salt,
      JSON.stringify(fieldHashes),
      integrityRoot,
      ledgerEntryId,
      status,
      amendedByProviderId,
      reason,
    ]);

    // 4. Every medicine, in sequence order, as new rows of this version.
    for (const medicine of medicines) {
      await conn.execute(INSERT_MEDICINE_SQL, [inserted.insertId, medicine.sequence_number, ...MEDICINE_COLUMNS.map((column) => medicine[column])]);
    }
    return inserted.insertId;
  }

  /**
   * @param {object} data { patientId, providerId, heightCm?, weightKg?, medicines: [{ drugName, drugClass, dosageValue,
   *                      dosageUnit, frequency, durationDays, quantityPrescribed }, ...] } — at least one medicine;
   *                      optional prescriptionId (e.g. 'RX-DEMO-0001'), otherwise one is generated.
   * @returns {Promise<object>} the version row with its `medicines`
   */
  async function createPrescription(data) {
    const { top, medicines } = normalizeNewPrescription(data);

    let prescriptionId = generatePrescriptionId();
    if (data.prescriptionId !== undefined) {
      assertPrescriptionId(data.prescriptionId);
      prescriptionId = data.prescriptionId;
    }

    const id = await inWriteTransaction((conn) =>
      hashAnchorAndInsert(conn, {
        prescriptionId,
        versionNumber: 1,
        parentVersionId: null,
        prescription: top,
        medicines,
        status: 'active',
        amendedByProviderId: null, // version 1 is never "amended by" anyone
        reason: null,
      }),
    );
    return getVersionById(id);
  }

  /**
   * Shared path for version N+1: lock the latest row, require it to be active, load its medicines, derive the new
   * version via `build(latest, latestMedicines)`, supersede the latest (status/amended_at only), then
   * hash → anchor → insert. Never modifies clinical data of any existing row.
   */
  async function insertNextVersion(prescriptionId, build) {
    const id = await inWriteTransaction(async (conn) => {
      const [rows] = await conn.execute(SELECT_LATEST_FOR_UPDATE_SQL, [prescriptionId]);
      const latest = rows[0];
      if (!latest) {
        throw new RepositoryError('NOT_FOUND', `No prescription with id ${prescriptionId}`);
      }
      if (latest.status !== 'active') {
        throw new RepositoryError('NOT_AMENDABLE', `Latest version is '${latest.status}', only 'active' can be amended or revoked`);
      }
      const latestMedicines = (await loadMedicines(conn, [latest.id])).get(latest.id);

      const { prescription, medicines, status, amendedByProviderId, reason } = build(latest, latestMedicines);

      const [superseded] = await conn.execute(SUPERSEDE_SQL, [latest.id]);
      if (superseded.affectedRows !== 1) {
        throw new RepositoryError('CONCURRENT_MODIFICATION', 'Latest version changed during amendment');
      }

      return hashAnchorAndInsert(conn, {
        prescriptionId,
        versionNumber: latest.version_number + 1,
        parentVersionId: latest.id,
        prescription,
        medicines,
        status,
        amendedByProviderId,
        reason,
      });
    });
    return getVersionById(id);
  }

  /**
   * Creates version N+1 in which ONE medicine is changed and every other medicine is copied forward unchanged
   * (all as new rows). The prescription fields — patient, original prescriber, recorded vitals — are copied forward.
   *
   * @param {object} changes { medicineId, dosageValue?, dosageUnit?, frequency?, durationDays?, quantityPrescribed? }
   *        medicineId is the medicine_id of that medicine in the CURRENT (latest) version. medicine_id values are
   *        per version (every version has its own rows), so an id from an older version is rejected.
   * @param {string} [amendedByProviderId] who performed the amendment; defaults to the original provider_id
   * @param {string} [reason] optional human-readable reason
   */
  async function amendPrescription(prescriptionId, changes, amendedByProviderId, reason) {
    assertPrescriptionId(prescriptionId);
    const { medicineId, updates } = normalizeAmendment(changes);
    const amendedBy =
      amendedByProviderId === undefined || amendedByProviderId === null ? null : normalizeProviderRef('amendedByProviderId', amendedByProviderId);
    const amendmentReason = normalizeReason(reason, { required: false });

    return insertNextVersion(prescriptionId, (latest, latestMedicines) => {
      const target = latestMedicines.find((medicine) => medicine.medicine_id === medicineId);
      if (!target) {
        throw new RepositoryError(
          'MEDICINE_NOT_IN_CURRENT_VERSION',
          `medicineId ${medicineId} is not a medicine of the current version (v${latest.version_number}) of ${prescriptionId}`,
        );
      }
      if (Object.keys(updates).every((column) => isSameValue(column, updates[column], target[column]))) {
        throw new RepositoryError('NO_CHANGES', 'Amendment values are identical to the current version of this medicine');
      }
      return {
        prescription: copyPrescriptionFields(latest),
        medicines: latestMedicines.map((medicine) => (medicine.medicine_id === medicineId ? { ...copyMedicine(medicine), ...updates } : copyMedicine(medicine))),
        status: 'active',
        amendedByProviderId: amendedBy ?? latest.provider_id,
        reason: amendmentReason,
      };
    });
  }

  /**
   * Appends a terminal 'revoked' version: the prescription fields and every medicine copied forward unchanged,
   * hashed with a fresh salt and anchored like any other version. No further versions can follow it.
   */
  async function insertRevocationVersion(prescriptionId, providerId, reason) {
    assertPrescriptionId(prescriptionId);
    const revokedBy = normalizeProviderRef('providerId', providerId);
    const revocationReason = normalizeReason(reason, { required: true });

    return insertNextVersion(prescriptionId, (latest, latestMedicines) => ({
      prescription: copyPrescriptionFields(latest),
      medicines: latestMedicines.map(copyMedicine),
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
  MEDICINE_COLUMNS,
  AMENDABLE_MEDICINE_FIELDS,
};
