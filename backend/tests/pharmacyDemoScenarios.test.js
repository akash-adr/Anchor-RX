'use strict';

/**
 * Regression gate for the Pharmacy Portal rehearsal seed (npm run seed:demo, Modules 6/7).
 * The script builds one example of every scan outcome; after the Module 14 schema change it silently failed with
 * nothing to catch it. This proves every scenario still produces its intended outcome, against anchor_rx_test.
 */

const { createPool } = require('../db/connection');
const { seedPharmacyDemoScenarios } = require('../db/seed/pharmacyDemoScenarios');
const { SEEDED_SCENARIOS } = require('../db/seed/demoScenarios');
const { generateQrPayload } = require('../qr/qrEngine');
const { createPharmacyVerification } = require('../qr/pharmacyVerification');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
});

afterAll(async () => {
  await pool.end();
});

test('every seeded rehearsal scenario scans as its expected outcome', async () => {
  const repository = await seedPharmacyDemoScenarios(pool);
  const { verifyScan } = createPharmacyVerification(pool, { repository });

  const outcomes = [];
  for (const scenario of SEEDED_SCENARIOS) {
    const row = await repository.getVersion(scenario.prescriptionId, scenario.versionNumber);
    const scan = await verifyScan(JSON.stringify(generateQrPayload(row.prescription_id, row.version_number, row.created_at)), 'PHM-001');
    outcomes.push([scenario.prescriptionId, scenario.versionNumber, scan.scanResult]);
    if (scenario.expected === 'tampered') {
      expect(scan.fieldVerification.tamperedFields).toEqual(['medicine_1.dosage_value']);
    }
  }

  expect(outcomes).toEqual(SEEDED_SCENARIOS.map((s) => [s.prescriptionId, s.versionNumber, s.expected]));

  // The stale scenario's current version really carries the amended dose, on its medicine row.
  const current = await repository.getLatestVersion('RX-DEMO-0006');
  expect(current.version_number).toBe(2);
  expect(current.medicines.map((m) => [m.sequence_number, m.drug_name, m.dosage_value])).toEqual([[1, 'Amlodipine', '10.000']]);
}, 30000);
