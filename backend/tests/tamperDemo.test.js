'use strict';

/**
 * Module 2 completion gate: demo scenario B (tampered dosage) against a real MySQL row.
 * Runs against anchor_rx_test; the full demo seed is rebuilt before each test.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { runTamperDemo, TAMPER_PRESCRIPTION_ID } = require('../db/seed/tamperDemo');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { verifyIntegrity } = require('../integrity/hashEngine');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let repo;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repo = createPrescriptionVersionRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool); // resets anchor_rx_test and rebuilds RX-DEMO-0001..0004
});

describe('tamper simulation (scenario B)', () => {
  test('raw SQL dosage edit is detected and pinpointed to medicine_1.dosage_value', async () => {
    const { prescriptionId, versionId, before } = await runTamperDemo(pool);
    expect(prescriptionId).toBe(TAMPER_PRESCRIPTION_ID);

    const row = await repo.getVersionById(versionId);

    // The edit really happened, and only on the first medicine's dosage_value.
    expect(before.medicines[0].dosage_value).toBe('500.000');
    expect(row.medicines[0].dosage_value).toBe('5000.000');
    for (const field of ['patient_id', 'provider_id', 'height_cm', 'weight_kg', 'status', 'version_number', 'salt', 'field_hashes', 'integrity_root']) {
      expect({ field, value: row[field] }).toEqual({ field, value: before[field] });
    }
    for (const column of ['medicine_id', 'sequence_number', 'drug_name', 'drug_class', 'dosage_unit', 'frequency', 'duration_days', 'quantity_prescribed']) {
      expect({ column, value: row.medicines[0][column] }).toEqual({ column, value: before.medicines[0][column] });
    }

    const result = verifyIntegrity(row, row.field_hashes, row.salt);
    console.log(`verifyIntegrity(${prescriptionId}, tampered):`, JSON.stringify(result));

    expect(result).toEqual({
      valid: false,
      tamperedFields: ['medicine_1.dosage_value'],
      integrityRootMatch: false,
    });
  });

  test('untampered seeded prescription RX-DEMO-0001 (both versions) verifies clean', async () => {
    await runTamperDemo(pool); // tampering one prescription must not affect others

    const chain = await repo.getPrescriptionChain('RX-DEMO-0001');
    expect(chain).toHaveLength(2);

    for (const version of chain) {
      const result = verifyIntegrity(version, version.field_hashes, version.salt);
      console.log(`verifyIntegrity(RX-DEMO-0001 v${version.version_number}, untampered):`, JSON.stringify(result));
      expect(result).toEqual({ valid: true, tamperedFields: [], integrityRootMatch: true });
    }
  });

  test('refuses to run twice without a reseed', async () => {
    await runTamperDemo(pool);
    await expect(runTamperDemo(pool)).rejects.toThrow(/already exists/);
  });
});
