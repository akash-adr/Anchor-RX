'use strict';

/**
 * Anchor Rx — Field-Level SHA-256 Hashing Engine (Module 2).
 *
 * Pure functions only: no DB, no repository, no I/O.
 *
 * Why field-level instead of hashing the whole record:
 *   A single whole-record hash can only say "this record is invalid". Hashing each
 *   field separately lets verification name the exact field that changed
 *   (e.g. dosage_value), which is what the pharmacist needs to see. The integrity
 *   root then folds all field hashes into one value that can be anchored to a ledger.
 *
 * Why a salt:
 *   The salt provides UNIQUENESS, not secrecy. It is stored next to the data.
 *   Without it, two prescriptions with the same dose would produce identical
 *   dosage_value hashes, and low-variety fields (dose, unit, frequency) could be
 *   recovered from a published hash with a trivial lookup table. A per-version
 *   random salt makes every version's hashes unique. It is generated once when a
 *   version is created and never regenerated on amendment or verification.
 */

const crypto = require('crypto');

// The only fields that participate in hashing. Lifecycle/bookkeeping columns
// (id, version_number, status, created_at, amended_at, ...) change for
// non-tampering reasons and must never affect the hash.
const HASHED_FIELDS = Object.freeze([
  'patient_id',
  'provider_id',
  'drug_name',
  'dosage_value',
  'dosage_unit',
  'frequency',
  'duration_days',
  'drug_class',
]);

const SALT_BYTES = 16;
// Fixed-length salt keeps `fieldName:value + salt` unambiguous: the salt is always
// the final 32 hex characters, so no value/salt pair can collide with another.
const SALT_PATTERN = /^[0-9a-f]{32}$/;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function requireNonEmptyString(fieldName, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string, got ${value === null ? 'null' : typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new TypeError(`${fieldName} must not be empty`);
  }
  return trimmed;
}

// String-based on purpose: never parse dosage to a float, or drift becomes a false tamper.
function normalizeDosageValue(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`dosage_value must be finite, got ${value}`);
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new TypeError(`dosage_value must be a string or number, got ${value === null ? 'null' : typeof value}`);
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new TypeError(`dosage_value must be a non-negative decimal, got "${text}"`);
  }

  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fraction = match[2] || '';
  if (/[^0]/.test(fraction.slice(3))) {
    // Refuse to round: rounding would hide a real change beyond the column's precision.
    throw new RangeError(`dosage_value "${text}" exceeds 3 decimal places`);
  }
  return `${integerPart}.${fraction.slice(0, 3).padEnd(3, '0')}`;
}

function normalizeDurationDays(value) {
  let n = value;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`duration_days must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return String(n);
}

/**
 * The single normalization used by every hash computation in this module.
 */
function normalizeField(fieldName, value) {
  switch (fieldName) {
    case 'dosage_value':
      return normalizeDosageValue(value);
    case 'duration_days':
      return normalizeDurationDays(value);
    case 'dosage_unit':
    case 'drug_class':
      // Case carries no meaning: "MG" and "mg" are the same unit.
      return requireNonEmptyString(fieldName, value).toLowerCase();
    case 'drug_name':
    case 'patient_id':
    case 'provider_id':
    case 'frequency':
      // Case preserved: brand names and opaque IDs may be case-sensitive.
      return requireNonEmptyString(fieldName, value);
    default:
      throw new Error(`"${fieldName}" is not a hashed field (allowed: ${HASHED_FIELDS.join(', ')})`);
  }
}

function generateSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

function assertSalt(salt) {
  if (typeof salt !== 'string' || !SALT_PATTERN.test(salt)) {
    throw new TypeError('salt must be a 32-character lowercase hex string (use generateSalt())');
  }
}

/**
 * @returns {{ [fieldName: string]: string }} SHA256(fieldName + ":" + normalized + salt) per hashed field
 */
function computeFieldHashes(prescriptionData, salt) {
  if (prescriptionData === null || typeof prescriptionData !== 'object') {
    throw new TypeError('prescriptionData must be an object');
  }
  assertSalt(salt);

  const missing = HASHED_FIELDS.filter((f) => prescriptionData[f] === undefined || prescriptionData[f] === null);
  if (missing.length > 0) {
    throw new Error(`prescriptionData is missing required field(s): ${missing.join(', ')}`);
  }

  const hashes = {};
  for (const fieldName of HASHED_FIELDS) {
    hashes[fieldName] = sha256Hex(`${fieldName}:${normalizeField(fieldName, prescriptionData[fieldName])}${salt}`);
  }
  return hashes;
}

/**
 * SHA256 of the field hashes concatenated in alphabetical field-name order.
 * Independent of the object's key insertion order.
 */
function computeIntegrityRoot(fieldHashes) {
  if (fieldHashes === null || typeof fieldHashes !== 'object' || Array.isArray(fieldHashes)) {
    throw new TypeError('fieldHashes must be an object');
  }
  const names = Object.keys(fieldHashes).sort();
  for (const name of names) {
    if (typeof fieldHashes[name] !== 'string') {
      throw new TypeError(`fieldHashes.${name} must be a hex string`);
    }
  }
  return sha256Hex(names.map((name) => fieldHashes[name]).join(''));
}

/**
 * Recomputes hashes from currentData with the stored salt and compares them to storedFieldHashes.
 * A malformed or incomplete storedFieldHashes is reported as tampering, not thrown.
 *
 * expectedRoot (optional): the integrity root anchored OUTSIDE this database (ledger, Module 4).
 * Stored hashes live next to the data, so an attacker who rewrites a field AND its hashes stays
 * internally consistent and passes the checks above. Only an external anchor catches that.
 * When expectedRoot is given, the result gains `rootAnchorMismatch`, and a mismatch makes
 * `valid` false. When omitted, the result shape and behavior are unchanged.
 */
function verifyIntegrity(currentData, storedFieldHashes, salt, expectedRoot) {
  if (storedFieldHashes === null || typeof storedFieldHashes !== 'object' || Array.isArray(storedFieldHashes)) {
    throw new TypeError('storedFieldHashes must be an object (was this version ever hashed?)');
  }
  // null is rejected rather than treated as "omitted": a missing anchor must never silently skip the check.
  if (expectedRoot !== undefined && typeof expectedRoot !== 'string') {
    throw new TypeError('expectedRoot must be a hex string when provided');
  }

  const recomputed = computeFieldHashes(currentData, salt);
  const recomputedRoot = computeIntegrityRoot(recomputed);
  const tamperedFields = HASHED_FIELDS.filter((f) => recomputed[f] !== storedFieldHashes[f]);

  let integrityRootMatch;
  try {
    integrityRootMatch = recomputedRoot === computeIntegrityRoot(storedFieldHashes);
  } catch {
    integrityRootMatch = false; // stored hashes are structurally corrupted
  }

  const result = {
    valid: tamperedFields.length === 0 && integrityRootMatch,
    tamperedFields,
    integrityRootMatch,
  };

  if (expectedRoot !== undefined) {
    result.rootAnchorMismatch = recomputedRoot !== expectedRoot;
    result.valid = result.valid && !result.rootAnchorMismatch;
  }

  return result;
}

module.exports = {
  HASHED_FIELDS,
  normalizeField,
  generateSalt,
  computeFieldHashes,
  computeIntegrityRoot,
  verifyIntegrity,
};
