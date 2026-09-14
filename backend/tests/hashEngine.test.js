'use strict';

/**
 * Pure unit tests for the Module 2 hashing engine — no database.
 */

const {
  HASHED_FIELDS,
  normalizeField,
  generateSalt,
  computeFieldHashes,
  computeIntegrityRoot,
  verifyIntegrity,
} = require('../integrity/hashEngine');

// Fixed salt so failures are reproducible.
const SALT = '0123456789abcdef0123456789abcdef';

const BASELINE = Object.freeze({
  patient_id: 'PAT-001',
  provider_id: 'PRV-001',
  drug_name: 'Amoxicillin',
  dosage_value: '500.000',
  dosage_unit: 'mg',
  frequency: 'three times daily',
  duration_days: 7,
  drug_class: 'penicillin antibiotic',
});

const HEX_64 = /^[0-9a-f]{64}$/;

describe('computeFieldHashes', () => {
  test('is deterministic for identical data and salt', () => {
    const first = computeFieldHashes({ ...BASELINE }, SALT);
    const second = computeFieldHashes({ ...BASELINE }, SALT);

    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([...HASHED_FIELDS].sort());
    for (const hash of Object.values(first)) expect(hash).toMatch(HEX_64);
  });

  test('changing one field changes only that field hash, and the root', () => {
    const baseline = computeFieldHashes(BASELINE, SALT);
    const changed = computeFieldHashes({ ...BASELINE, frequency: 'twice daily' }, SALT);

    expect(changed.frequency).not.toBe(baseline.frequency);
    const others = HASHED_FIELDS.filter((f) => f !== 'frequency');
    expect(others).toHaveLength(7);
    for (const field of others) {
      expect({ field, hash: changed[field] }).toEqual({ field, hash: baseline[field] });
    }
    expect(computeIntegrityRoot(changed)).not.toBe(computeIntegrityRoot(baseline));
  });

  test('dosage_value "500", 500 and "500.0" produce the identical hash', () => {
    const hashes = ['500', 500, '500.0'].map(
      (dosage_value) => computeFieldHashes({ ...BASELINE, dosage_value }, SALT).dosage_value,
    );

    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(computeFieldHashes(BASELINE, SALT).dosage_value); // "500.000" too
  });

  test('ignores non-hashed columns (status, version_number, timestamps)', () => {
    const withLifecycle = {
      ...BASELINE,
      id: 42,
      status: 'dispensed',
      version_number: 9,
      created_at: new Date(),
      amended_at: new Date(),
    };
    expect(computeFieldHashes(withLifecycle, SALT)).toEqual(computeFieldHashes(BASELINE, SALT));
  });

  test('different salts give different hashes for the same data', () => {
    const a = computeFieldHashes(BASELINE, generateSalt());
    const b = computeFieldHashes(BASELINE, generateSalt());
    expect(a.dosage_value).not.toBe(b.dosage_value);
  });

  test('throws when a hashed field is missing', () => {
    const { drug_class, ...incomplete } = BASELINE;
    expect(() => computeFieldHashes(incomplete, SALT)).toThrow(/drug_class/);
  });
});

describe('computeIntegrityRoot', () => {
  test('is independent of key insertion order', () => {
    const hashes = computeFieldHashes(BASELINE, SALT);

    const forward = {};
    for (const field of HASHED_FIELDS) forward[field] = hashes[field];
    const reversed = {};
    for (const field of [...HASHED_FIELDS].reverse()) reversed[field] = hashes[field];

    expect(Object.keys(forward)).not.toEqual(Object.keys(reversed));
    expect(computeIntegrityRoot(reversed)).toBe(computeIntegrityRoot(forward));
    expect(computeIntegrityRoot(forward)).toMatch(HEX_64);
  });
});

describe('verifyIntegrity', () => {
  test('untampered record is valid', () => {
    const stored = computeFieldHashes(BASELINE, SALT);

    expect(verifyIntegrity({ ...BASELINE }, stored, SALT)).toEqual({
      valid: true,
      tamperedFields: [],
      integrityRootMatch: true,
    });
  });

  test('tampered dosage_value is detected and pinpointed', () => {
    const stored = computeFieldHashes(BASELINE, SALT);
    const tampered = { ...BASELINE, dosage_value: '5000.000' };

    expect(verifyIntegrity(tampered, stored, SALT)).toEqual({
      valid: false,
      tamperedFields: ['dosage_value'],
      integrityRootMatch: false,
    });
  });

  test('a deleted stored hash key is reported as tampering, not thrown', () => {
    const { frequency, ...partial } = computeFieldHashes(BASELINE, SALT);

    expect(verifyIntegrity(BASELINE, partial, SALT)).toEqual({
      valid: false,
      tamperedFields: ['frequency'],
      integrityRootMatch: false,
    });
  });
});

describe('verifyIntegrity with expectedRoot (external anchor)', () => {
  test('sophisticated tamper (data + hashes rewritten together) passes internally but fails the anchor', () => {
    // Legitimate state at creation: this root is what Module 4 anchors to the ledger.
    const originalRoot = computeIntegrityRoot(computeFieldHashes(BASELINE, SALT));

    // Attacker with DB access: changes the dose AND recomputes hashes/root with the stored salt.
    const tamperedData = { ...BASELINE, dosage_value: '5000.000' };
    const rewrittenHashes = computeFieldHashes(tamperedData, SALT);
    expect(computeIntegrityRoot(rewrittenHashes)).not.toBe(originalRoot);

    // Known gap: without the external anchor, the row is internally consistent.
    expect(verifyIntegrity(tamperedData, rewrittenHashes, SALT)).toEqual({
      valid: true,
      tamperedFields: [],
      integrityRootMatch: true,
    });

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
  test.each(['status', 'version_number', 'created_at', 'id', 'integrity_root'])(
    'throws on non-hashed field "%s"',
    (field) => {
      expect(() => normalizeField(field, 'x')).toThrow(/not a hashed field/);
    },
  );

  test('refuses to round dosage beyond 3 decimals', () => {
    expect(() => normalizeField('dosage_value', '500.0005')).toThrow(RangeError);
    expect(() => normalizeField('dosage_value', 0.1 + 0.2)).toThrow(RangeError);
  });
});
