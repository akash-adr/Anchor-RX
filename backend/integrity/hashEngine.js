'use strict';

/**
 * Anchor Rx — Field-Level SHA-256 Hashing Engine (Module 2, multi-medicine since Module 14).
 *
 * Pure functions only: no DB, no repository, no I/O.
 *
 * Why field-level instead of hashing the whole record:
 *   A single whole-record hash can only say "this record is invalid". Hashing each
 *   field separately lets verification name the exact field that changed
 *   (e.g. medicine_2.dosage_value), which is what the pharmacist needs to see. The integrity
 *   root then folds all field hashes into one value that can be anchored to a ledger.
 *
 * Why a salt:
 *   The salt provides UNIQUENESS, not secrecy. It is stored next to the data.
 *   Without it, two prescriptions with the same dose would produce identical
 *   dosage_value hashes, and low-variety fields (dose, unit, frequency) could be
 *   recovered from a published hash with a trivial lookup table. A per-version
 *   random salt makes every version's hashes unique. It is generated once when a
 *   version is created and never regenerated on amendment or verification.
 *
 * Hashed field set (Module 14):
 *   prescription level   patient_id, provider_id, height_cm, weight_kg          → hash key = the field name
 *   per medicine         drug_name, drug_class, dosage_value, dosage_unit,
 *                        frequency, duration_days, quantity_prescribed          → hash key = "medicine_{N}.{field}"
 *   N is the medicine's sequence_number (1-based position in submission order) — never medicine_id or row order.
 *   The FULL key is part of every hash input (`${key}:${value}${salt}`), so a hash is bound to its medicine's position:
 *   the same dose in medicine_1 and medicine_2 hashes differently, and swapping two medicines changes both.
 *   height_cm / weight_kg are always hashed; an unrecorded (NULL) value is hashed as an explicit null marker, so
 *   recording a weight later is detectable too.
 */

const crypto = require('crypto');

// Prescription-level fields. Lifecycle/bookkeeping columns (id, version_number, status, created_at, amended_at, ...)
// change for non-tampering reasons and must never affect the hash.
const HASHED_FIELDS = Object.freeze(['patient_id', 'provider_id', 'height_cm', 'weight_kg']);

// Per-medicine fields, hashed once per medicine under "medicine_{sequence_number}.{field}".
const MEDICINE_HASHED_FIELDS = Object.freeze([
  'drug_name',
  'drug_class',
  'dosage_value',
  'dosage_unit',
  'frequency',
  'duration_days',
  'quantity_prescribed',
]);

const NULLABLE_HASHED_FIELDS = Object.freeze(['height_cm', 'weight_kg']);
const NULL_MARKER = '<null>'; // can never collide with a normalized decimal

const MEDICINE_KEY_PATTERN = /^medicine_([1-9]\d*)\.([a-z_]+)$/;

const SALT_BYTES = 16;
// Fixed-length salt keeps `fieldName:value + salt` unambiguous: the salt is always
// the final 32 hex characters, so no value/salt pair can collide with another.
const SALT_PATTERN = /^[0-9a-f]{32}$/;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const medicineHashKey = (sequenceNumber, field) => `medicine_${sequenceNumber}.${field}`;

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

/**
 * String-based on purpose: never parse a decimal to a float, or drift becomes a false tamper.
 * Canonical form has exactly `scale` decimals ("500" → "500.000" for dosage). Digits beyond the column's scale are
 * refused rather than rounded — rounding would hide a real change the database would also silently round.
 */
function normalizeDecimal(fieldName, value, scale, { nullable = false } = {}) {
  if (value === null && nullable) return NULL_MARKER;
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${fieldName} must be finite, got ${value}`);
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new TypeError(`${fieldName} must be a string or number, got ${value === null ? 'null' : typeof value}`);
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new TypeError(`${fieldName} must be a non-negative decimal, got "${text}"`);
  }

  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fraction = match[2] || '';
  if (/[^0]/.test(fraction.slice(scale))) {
    throw new RangeError(`${fieldName} "${text}" exceeds ${scale} decimal place${scale === 1 ? '' : 's'}`);
  }
  return `${integerPart}.${fraction.slice(0, scale).padEnd(scale, '0')}`;
}

function normalizeNonNegativeInteger(fieldName, value) {
  let n = value;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return String(n);
}

/**
 * The single normalization used by every hash computation in this module.
 * Accepts a plain field name ("dosage_value") or a medicine hash key ("medicine_2.dosage_value"); a medicine key is
 * normalized exactly like its base field.
 */
function normalizeField(fieldName, value) {
  const medicineKey = MEDICINE_KEY_PATTERN.exec(fieldName);
  const base = medicineKey ? medicineKey[2] : fieldName;
  if (medicineKey && !MEDICINE_HASHED_FIELDS.includes(base)) {
    throw new Error(`"${fieldName}" is not a hashed field (medicine fields: ${MEDICINE_HASHED_FIELDS.join(', ')})`);
  }

  switch (base) {
    case 'dosage_value':
      return normalizeDecimal(fieldName, value, 3);
    case 'height_cm':
      return normalizeDecimal(fieldName, value, 1, { nullable: true });
    case 'weight_kg':
      return normalizeDecimal(fieldName, value, 2, { nullable: true });
    case 'duration_days':
    case 'quantity_prescribed':
      return normalizeNonNegativeInteger(fieldName, value);
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
      throw new Error(
        `"${fieldName}" is not a hashed field (prescription: ${HASHED_FIELDS.join(', ')}; per medicine: ${MEDICINE_HASHED_FIELDS.join(', ')})`,
      );
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
 * Medicines ordered by sequence_number. Creation is strict (exactly 1..N, at least one); verification is lenient so
 * that a medicine row deleted or inserted outside the application is REPORTED as tampering instead of throwing.
 */
function orderedMedicines(medicines, { strict }) {
  if (!Array.isArray(medicines)) {
    throw new TypeError('prescriptionData.medicines must be an array');
  }
  if (strict && medicines.length === 0) {
    throw new Error('prescriptionData.medicines must contain at least one medicine');
  }
  const seen = new Set();
  medicines.forEach((medicine, index) => {
    if (medicine === null || typeof medicine !== 'object') {
      throw new TypeError(`medicines[${index}] must be an object`);
    }
    const sequence = medicine.sequence_number;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TypeError(`medicines[${index}].sequence_number must be a positive integer, got ${JSON.stringify(sequence)}`);
    }
    if (seen.has(sequence)) throw new Error(`duplicate medicine sequence_number ${sequence}`);
    seen.add(sequence);
  });
  const sorted = [...medicines].sort((a, b) => a.sequence_number - b.sequence_number);
  if (strict) {
    sorted.forEach((medicine, index) => {
      if (medicine.sequence_number !== index + 1) {
        throw new Error(`medicine sequence_numbers must be exactly 1..${sorted.length} (no gaps); missing ${index + 1}`);
      }
    });
  }
  return sorted;
}

function computeHashes(prescriptionData, salt, { strict }) {
  if (prescriptionData === null || typeof prescriptionData !== 'object') {
    throw new TypeError('prescriptionData must be an object');
  }
  assertSalt(salt);

  const missing = HASHED_FIELDS.filter(
    (field) => prescriptionData[field] === undefined || (prescriptionData[field] === null && !NULLABLE_HASHED_FIELDS.includes(field)),
  );
  if (prescriptionData.medicines === undefined) missing.push('medicines');
  if (missing.length > 0) {
    throw new Error(`prescriptionData is missing required field(s): ${missing.join(', ')}`);
  }

  const hashes = {};
  for (const field of HASHED_FIELDS) {
    hashes[field] = sha256Hex(`${field}:${normalizeField(field, prescriptionData[field])}${salt}`);
  }
  for (const medicine of orderedMedicines(prescriptionData.medicines, { strict })) {
    const missingInMedicine = MEDICINE_HASHED_FIELDS.filter((field) => medicine[field] === undefined || medicine[field] === null);
    if (missingInMedicine.length > 0) {
      const keys = missingInMedicine.map((field) => medicineHashKey(medicine.sequence_number, field));
      throw new Error(`prescriptionData is missing required field(s): ${keys.join(', ')}`);
    }
    for (const field of MEDICINE_HASHED_FIELDS) {
      const key = medicineHashKey(medicine.sequence_number, field);
      hashes[key] = sha256Hex(`${key}:${normalizeField(key, medicine[field])}${salt}`);
    }
  }
  return hashes;
}

/**
 * Canonical DISPLAY order for hash keys: prescription fields first, then medicines by sequence number (numerically),
 * each medicine's fields in MEDICINE_HASHED_FIELDS order. Used for readable tamper reports only — the integrity root
 * uses plain alphabetical order (see computeIntegrityRoot).
 */
function compareHashKeys(a, b) {
  const rank = (key) => {
    const top = HASHED_FIELDS.indexOf(key);
    if (top >= 0) return [0, top, 0];
    const match = MEDICINE_KEY_PATTERN.exec(key);
    if (match) {
      const field = MEDICINE_HASHED_FIELDS.indexOf(match[2]);
      return [1, Number(match[1]), field >= 0 ? field : MEDICINE_HASHED_FIELDS.length];
    }
    return [2, 0, 0];
  };
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < 3; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {object} prescriptionData { patient_id, provider_id, height_cm, weight_kg,
 *        medicines: [{ sequence_number, drug_name, drug_class, dosage_value, dosage_unit, frequency, duration_days, quantity_prescribed }] }
 *        — e.g. a repository row (which carries its medicines). Other columns are ignored.
 * @returns {{ [hashKey: string]: string }} SHA256(hashKey + ":" + normalized + salt) per hashed field, in canonical order
 */
function computeFieldHashes(prescriptionData, salt) {
  return computeHashes(prescriptionData, salt, { strict: true });
}

/**
 * SHA256 of the field hashes concatenated in alphabetical hash-KEY order (plain string sort).
 * Independent of the object's key insertion order and of the order medicines were listed in, and deterministic for
 * any number of medicines: the key SET fully determines the order. (Alphabetical means "medicine_10.*" sorts before
 * "medicine_2.*" — that is fine; it only has to be the same order every time, and it is.)
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
 * tamperedFields lists every hash key whose value differs — including keys present on only one side (a medicine row
 * deleted or inserted after issuance shows up as its medicine_N.* keys) — in canonical order.
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

  const recomputed = computeHashes(currentData, salt, { strict: false });
  const recomputedRoot = computeIntegrityRoot(recomputed);
  const allKeys = new Set([...Object.keys(recomputed), ...Object.keys(storedFieldHashes)]);
  const tamperedFields = [...allKeys].filter((key) => recomputed[key] !== storedFieldHashes[key]).sort(compareHashKeys);

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
  MEDICINE_HASHED_FIELDS,
  medicineHashKey,
  compareHashKeys,
  normalizeField,
  generateSalt,
  computeFieldHashes,
  computeIntegrityRoot,
  verifyIntegrity,
};
