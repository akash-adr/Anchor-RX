'use strict';

/**
 * Pure unit tests for the Module 2 hashing engine (multi-medicine field set, Module 14) — no database.
 */

const crypto = require('crypto');
const {
  HASHED_FIELDS,
  MEDICINE_HASHED_FIELDS,
  normalizeField,
  generateSalt,
  computeFieldHashes,
  computeIntegrityRoot,
  verifyIntegrity,
} = require('../integrity/hashEngine');

// Fixed salt so failures are reproducible.
const SALT = '0123456789abcdef0123456789abcdef';
const HEX_64 = /^[0-9a-f]{64}$/;

const AMOXICILLIN = Object.freeze({
  sequence_number: 1,
  drug_name: 'Amoxicillin',
  drug_class: 'penicillin antibiotic',
  dosage_value: '500.000',
  dosage_unit: 'mg',
  frequency: 'three times daily',
  duration_days: 7,
  quantity_prescribed: 21,
});

const PARACETAMOL = Object.freeze({
  sequence_number: 2,
  drug_name: 'Paracetamol',
  drug_class: 'analgesic',
  dosage_value: '650.000',
  dosage_unit: 'mg',
  frequency: 'every 6 hours',
  duration_days: 3,
  quantity_prescribed: 12,
});

const BASELINE = Object.freeze({
  patient_id: 'PAT-001',
  provider_id: 'PRV-001',
  height_cm: '172.5',
  weight_kg: '68.40',
  medicines: Object.freeze([AMOXICILLIN, PARACETAMOL]),
});

/** A copy of `base` with one medicine's fields patched. */
function withMedicine(sequenceNumber, patch, base = BASELINE) {
  return { ...base, medicines: base.medicines.map((m) => (m.sequence_number === sequenceNumber ? { ...m, ...patch } : { ...m })) };
}

/** Canonical key list for `count` medicines: prescription fields, then medicine_1.*, medicine_2.*, … */
function expectedKeys(count) {
  const keys = [...HASHED_FIELDS];
  for (let n = 1; n <= count; n += 1) for (const field of MEDICINE_HASHED_FIELDS) keys.push(`medicine_${n}.${field}`);
  return keys;
}

function prescriptionWith(count) {
  return {
    ...BASELINE,
    medicines: Array.from({ length: count }, (_, i) => ({ ...AMOXICILLIN, sequence_number: i + 1, dosage_value: String((i + 1) * 100) })),
  };
}

describe('computeFieldHashes', () => {
  test('is deterministic, and hashes exactly 4 prescription fields + 7 fields per medicine, keyed "medicine_N.field"', () => {
    const first = computeFieldHashes(BASELINE, SALT);
    const second = computeFieldHashes({ ...BASELINE, medicines: BASELINE.medicines.map((m) => ({ ...m })) }, SALT);

    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual(expectedKeys(2)); // 4 + 7×2 = 18, in canonical order
    expect(Object.keys(first)).toHaveLength(18);
    expect(first).toHaveProperty(['medicine_2.dosage_value']);
    for (const hash of Object.values(first)) expect(hash).toMatch(HEX_64);
  });

  test('changing one field of one medicine changes only that key\'s hash, and the root', () => {
    const baseline = computeFieldHashes(BASELINE, SALT);
    const changed = computeFieldHashes(withMedicine(2, { frequency: 'twice daily' }), SALT);

    expect(changed['medicine_2.frequency']).not.toBe(baseline['medicine_2.frequency']);
    const others = expectedKeys(2).filter((key) => key !== 'medicine_2.frequency');
    expect(others).toHaveLength(17);
    for (const key of others) expect({ key, hash: changed[key] }).toEqual({ key, hash: baseline[key] });
    expect(computeIntegrityRoot(changed)).not.toBe(computeIntegrityRoot(baseline));
  });

  test('dosage_value "500", 500 and "500.0" produce the identical hash', () => {
    const hashes = ['500', 500, '500.0'].map((dosage_value) => computeFieldHashes(withMedicine(1, { dosage_value }), SALT)['medicine_1.dosage_value']);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(computeFieldHashes(BASELINE, SALT)['medicine_1.dosage_value']); // "500.000" too
  });

  test('height_cm / weight_kg are always hashed: equivalent decimals match, and an unrecorded value is hashed explicitly', () => {
    const base = computeFieldHashes(BASELINE, SALT);
    for (const weight_kg of ['68.4', 68.4, '068.40']) {
      expect(computeFieldHashes({ ...BASELINE, weight_kg }, SALT).weight_kg).toBe(base.weight_kg);
    }
    const unrecorded = computeFieldHashes({ ...BASELINE, height_cm: null, weight_kg: null }, SALT);
    expect(unrecorded.height_cm).toMatch(HEX_64);
    expect(unrecorded.weight_kg).not.toBe(base.weight_kg); // null ≠ 68.40 — recording a weight later is detectable
    expect(computeFieldHashes({ ...BASELINE, height_cm: null, weight_kg: null }, SALT)).toEqual(unrecorded);
  });

  test('a hash is bound to its medicine position: identical values in medicine_1 and medicine_2 hash differently', () => {
    const twins = { ...BASELINE, medicines: [AMOXICILLIN, { ...AMOXICILLIN, sequence_number: 2 }] };
    const hashes = computeFieldHashes(twins, SALT);
    for (const field of MEDICINE_HASHED_FIELDS) {
      expect(hashes[`medicine_1.${field}`]).not.toBe(hashes[`medicine_2.${field}`]);
    }
  });

  test('swapping which medicine is 1st and 2nd changes their hashes and the root', () => {
    const swapped = { ...BASELINE, medicines: [{ ...PARACETAMOL, sequence_number: 1 }, { ...AMOXICILLIN, sequence_number: 2 }] };
    const original = computeFieldHashes(BASELINE, SALT);
    const reordered = computeFieldHashes(swapped, SALT);
    expect(reordered['medicine_1.drug_name']).not.toBe(original['medicine_1.drug_name']);
    expect(computeIntegrityRoot(reordered)).not.toBe(computeIntegrityRoot(original));
  });

  test('identity comes from sequence_number, not from the order the medicines array happens to list them in', () => {
    const listedBackwards = { ...BASELINE, medicines: [PARACETAMOL, AMOXICILLIN] };
    expect(computeFieldHashes(listedBackwards, SALT)).toEqual(computeFieldHashes(BASELINE, SALT));
  });

  test('ignores non-hashed columns on the prescription and on each medicine', () => {
    const withBookkeeping = {
      ...BASELINE,
      id: 42,
      status: 'dispensed',
      version_number: 9,
      route: 'oral',
      created_at: new Date(),
      amended_at: new Date(),
      medicines: BASELINE.medicines.map((m, i) => ({ ...m, medicine_id: 900 + i, prescription_version_id: 42 })),
    };
    expect(computeFieldHashes(withBookkeeping, SALT)).toEqual(computeFieldHashes(BASELINE, SALT));
  });

  test('different salts give different hashes for the same data', () => {
    const a = computeFieldHashes(BASELINE, generateSalt());
    const b = computeFieldHashes(BASELINE, generateSalt());
    expect(a['medicine_1.dosage_value']).not.toBe(b['medicine_1.dosage_value']);
  });

  test.each([
    ['a prescription field', (({ provider_id, ...rest }) => rest)(BASELINE), /provider_id/],
    ['a medicine field (named with its medicine)', withMedicine(2, { drug_class: undefined }), /medicine_2\.drug_class/],
    ['the medicines list', (({ medicines, ...rest }) => rest)(BASELINE), /medicines/],
    ['every medicine (empty list)', { ...BASELINE, medicines: [] }, /at least one medicine/],
    ['a sequence number (gap: 1 and 3)', { ...BASELINE, medicines: [AMOXICILLIN, { ...PARACETAMOL, sequence_number: 3 }] }, /no gaps/],
    ['a unique sequence number (duplicate)', { ...BASELINE, medicines: [AMOXICILLIN, { ...PARACETAMOL, sequence_number: 1 }] }, /duplicate/],
    ['a valid sequence number (0)', { ...BASELINE, medicines: [{ ...AMOXICILLIN, sequence_number: 0 }] }, /positive integer/],
  ])('throws when missing %s', (_label, data, message) => {
    expect(() => computeFieldHashes(data, SALT)).toThrow(message);
  });
});

describe('computeIntegrityRoot', () => {
  test('is independent of key insertion order', () => {
    const hashes = computeFieldHashes(BASELINE, SALT);
    const keys = expectedKeys(2);

    const forward = {};
    for (const key of keys) forward[key] = hashes[key];
    const reversed = {};
    for (const key of [...keys].reverse()) reversed[key] = hashes[key];

    expect(Object.keys(forward)).not.toEqual(Object.keys(reversed));
    expect(computeIntegrityRoot(reversed)).toBe(computeIntegrityRoot(forward));
    expect(computeIntegrityRoot(forward)).toMatch(HEX_64);
  });

  test.each([1, 2, 9, 10, 12])('is deterministic for %i medicine(s): sorted full keys, regardless of insertion order', (count) => {
    const hashes = computeFieldHashes(prescriptionWith(count), SALT);
    const keys = Object.keys(hashes);
    expect(keys).toHaveLength(4 + 7 * count);

    // Insert keys in a scrambled (but reproducible) order.
    const scrambled = {};
    for (const key of [...keys].sort((a, b) => crypto.createHash('md5').update(a).digest('hex').localeCompare(crypto.createHash('md5').update(b).digest('hex')))) {
      scrambled[key] = hashes[key];
    }
    expect(computeIntegrityRoot(scrambled)).toBe(computeIntegrityRoot(hashes));

    // It is exactly: SHA-256 of the hashes concatenated in plain alphabetical key order.
    const manual = crypto.createHash('sha256').update([...keys].sort().map((key) => hashes[key]).join(''), 'utf8').digest('hex');
    expect(computeIntegrityRoot(hashes)).toBe(manual);

    if (count >= 10) {
      const sorted = [...keys].sort();
      expect(sorted.indexOf('medicine_10.drug_name')).toBeLessThan(sorted.indexOf('medicine_2.drug_name')); // lexicographic, stable
    }
    // Adding a medicine changes the root.
    expect(computeIntegrityRoot(computeFieldHashes(prescriptionWith(count + 1), SALT))).not.toBe(computeIntegrityRoot(hashes));
  });
});

describe('verifyIntegrity', () => {
  test('untampered record is valid', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    expect(verifyIntegrity(withMedicine(1, {}), stored, SALT)).toEqual({ valid: true, tamperedFields: [], integrityRootMatch: true });
  });

  test('a tampered dosage in the SECOND medicine is pinpointed as "medicine_2.dosage_value"', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const tampered = withMedicine(2, { dosage_value: '6500.000' });

    expect(verifyIntegrity(tampered, stored, SALT)).toEqual({
      valid: false,
      tamperedFields: ['medicine_2.dosage_value'],
      integrityRootMatch: false,
    });
  });

  test('tampered prescription-level vitals are reported under their own names', () => {
    const stored = computeFieldHashes({ ...BASELINE, weight_kg: null }, SALT);
    expect(verifyIntegrity({ ...BASELINE, weight_kg: '95.00' }, stored, SALT)).toEqual({
      valid: false,
      tamperedFields: ['weight_kg'],
      integrityRootMatch: false,
    });
  });

  test('changes in several medicines are all reported, in canonical order', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const tampered = withMedicine(1, { quantity_prescribed: 99 }, withMedicine(2, { drug_name: 'Tramadol', frequency: 'hourly' }));
    expect(verifyIntegrity({ ...tampered, patient_id: 'PAT-999' }, stored, SALT).tamperedFields).toEqual([
      'patient_id',
      'medicine_1.quantity_prescribed',
      'medicine_2.drug_name',
      'medicine_2.frequency',
    ]);
  });

  test('a deleted stored hash key is reported as tampering, not thrown', () => {
    const { 'medicine_2.frequency': removed, ...partial } = computeFieldHashes(BASELINE, SALT);
    expect(removed).toMatch(HEX_64);
    expect(verifyIntegrity(BASELINE, partial, SALT)).toEqual({
      valid: false,
      tamperedFields: ['medicine_2.frequency'],
      integrityRootMatch: false,
    });
  });

  test('a medicine removed from the current data is reported as all of its keys (not thrown)', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const result = verifyIntegrity({ ...BASELINE, medicines: [AMOXICILLIN] }, stored, SALT);
    expect(result.valid).toBe(false);
    expect(result.tamperedFields).toEqual(MEDICINE_HASHED_FIELDS.map((field) => `medicine_2.${field}`));
  });

  test('a medicine inserted into the current data is reported as its keys', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const extra = { ...PARACETAMOL, sequence_number: 3, drug_name: 'Oxycodone' };
    const result = verifyIntegrity({ ...BASELINE, medicines: [...BASELINE.medicines, extra] }, stored, SALT);
    expect(result.tamperedFields).toEqual(MEDICINE_HASHED_FIELDS.map((field) => `medicine_3.${field}`));
  });

  test('swapping the positions of two medicines is detected on both', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const swapped = { ...BASELINE, medicines: [{ ...PARACETAMOL, sequence_number: 1 }, { ...AMOXICILLIN, sequence_number: 2 }] };
    const differing = MEDICINE_HASHED_FIELDS.filter((field) => AMOXICILLIN[field] !== PARACETAMOL[field]);
    expect(verifyIntegrity(swapped, stored, SALT).tamperedFields).toEqual([
      ...differing.map((field) => `medicine_1.${field}`),
      ...differing.map((field) => `medicine_2.${field}`),
    ]);
  });
});

describe('verifyIntegrity with expectedRoot (external anchor)', () => {
  test('sophisticated tamper (data + hashes rewritten together) passes internally but fails the anchor', () => {
    // Legitimate state at creation: this root is what Module 4 anchors to the ledger.
    const originalRoot = computeIntegrityRoot(computeFieldHashes(BASELINE, SALT));

    // Attacker with DB access: changes a dose AND recomputes hashes/root with the stored salt.
    const tamperedData = withMedicine(1, { dosage_value: '5000.000' });
    const rewrittenHashes = computeFieldHashes(tamperedData, SALT);
    expect(computeIntegrityRoot(rewrittenHashes)).not.toBe(originalRoot);

    // Known gap: without the external anchor, the row is internally consistent.
    expect(verifyIntegrity(tamperedData, rewrittenHashes, SALT)).toEqual({ valid: true, tamperedFields: [], integrityRootMatch: true });

    // With the anchored root, the rewrite is caught even though every internal check matched.
    expect(verifyIntegrity(tamperedData, rewrittenHashes, SALT, originalRoot)).toEqual({
      valid: false,
      tamperedFields: [],
      integrityRootMatch: true,
      rootAnchorMismatch: true,
    });

    // Control: the genuine record against its own anchor is clean.
    expect(verifyIntegrity(BASELINE, computeFieldHashes(BASELINE, SALT), SALT, originalRoot)).toEqual({
      valid: true,
      tamperedFields: [],
      integrityRootMatch: true,
      rootAnchorMismatch: false,
    });
  });
});

describe('normalizeField', () => {
  test.each(['status', 'version_number', 'created_at', 'id', 'integrity_root', 'medicine_1.patient_id', 'medicine_0.dosage_value', 'medicine_1.route'])(
    'throws on non-hashed field "%s"',
    (field) => {
      expect(() => normalizeField(field, 'x')).toThrow(/not a hashed field/);
    },
  );

  test('a medicine key normalizes exactly like its base field', () => {
    expect(normalizeField('medicine_7.dosage_value', '500')).toBe(normalizeField('dosage_value', 500));
    expect(normalizeField('medicine_2.dosage_unit', 'MG')).toBe('mg');
    expect(normalizeField('medicine_3.quantity_prescribed', ' 21 ')).toBe('21');
  });

  test('refuses to round dosage beyond 3 decimals, height beyond 1, weight beyond 2', () => {
    expect(() => normalizeField('dosage_value', '500.0005')).toThrow(RangeError);
    expect(() => normalizeField('medicine_1.dosage_value', 0.1 + 0.2)).toThrow(RangeError);
    expect(() => normalizeField('height_cm', '172.55')).toThrow(RangeError);
    expect(() => normalizeField('weight_kg', '68.456')).toThrow(RangeError);
    expect(normalizeField('height_cm', 172.5)).toBe('172.5');
    expect(normalizeField('weight_kg', null)).toBe('<null>');
  });
});
