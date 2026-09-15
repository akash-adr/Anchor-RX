'use strict';

/**
 * Module 8 — ScoringPayload v1 contract (Node side), against the seeded anchor_rx_test database.
 * Seed: PAT-002 has RX-DEMO-0002 (Atorvastatin, statin, PRV-002) then RX-DEMO-0003 (Rosuvastatin, statin, PRV-001).
 * PRV-001 also wrote RX-DEMO-0001 (penicillin antibiotic, v2) and RX-DEMO-0004 (biguanide, PAT-003 — no weight).
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createScoringPayloadBuilder, ScoringPayloadError, DEFAULT_PATIENT_WEIGHT_KG } = require('../ml/buildScoringPayload');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const CONTRACT_KEYS = [
  'payloadVersion', 'prescriptionId', 'versionNumber', 'patientId', 'providerId', 'referenceTime',
  'drugName', 'drugClass', 'doseValue', 'doseUnit', 'frequency', 'durationDays', 'route',
  'patientAge', 'patientWeight', 'patientWeightIsDefault',
  'drugCombinationFlag', 'overlappingPrescriptionIds', 'providerDrugClassHistory', 'patientVelocity',
];

let pool;
let buildScoringPayload;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  ({ buildScoringPayload } = createScoringPayloadBuilder(pool, { now: () => new Date('2026-09-14T12:00:00Z') }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

test('builds the documented contract for the seeded statin-duplication prescription', async () => {
  const payload = await buildScoringPayload('RX-DEMO-0003', 1);

  expect(Object.keys(payload)).toEqual(CONTRACT_KEYS);
  expect(payload).toMatchObject({
    payloadVersion: 1,
    prescriptionId: 'RX-DEMO-0003',
    patientId: 'PAT-002',
    providerId: 'PRV-001',
    drugName: 'Rosuvastatin',
    drugClass: 'statin',
    doseValue: '10.000', // exact string, never a float
    doseUnit: 'mg',
    route: 'oral', // migration 007 default
    patientAge: 63, // dob 1962-11-03, birthday not yet reached on 2026-09-14
    patientWeight: 82,
    patientWeightIsDefault: false,
    drugCombinationFlag: true,
    overlappingPrescriptionIds: ['RX-DEMO-0002'],
    providerDrugClassHistory: { biguanide: 1, 'penicillin antibiotic': 1 }, // excludes RX-DEMO-0003 itself; v2 of 0001 counted once
    patientVelocity: 1,
  });
  expect(new Date(payload.referenceTime).toISOString()).toBe(payload.referenceTime);
});

test('null patient weight falls back to the documented placeholder and says so', async () => {
  const payload = await buildScoringPayload('RX-DEMO-0004', 1);
  expect(payload.patientWeight).toBe(DEFAULT_PATIENT_WEIGHT_KG);
  expect(payload.patientWeightIsDefault).toBe(true);
  expect(payload.drugCombinationFlag).toBe(false);
});

test('a same-class prescription only counts while its CURRENT version is active', async () => {
  await pool.execute("UPDATE prescription_version SET status = 'revoked' WHERE prescription_id = 'RX-DEMO-0002'");
  const payload = await buildScoringPayload('RX-DEMO-0003', 1);
  expect(payload.drugCombinationFlag).toBe(false);
  expect(payload.overlappingPrescriptionIds).toEqual([]);
});

test('patient velocity only counts other prescriptions in the 30 days before the scored version', async () => {
  await pool.execute(
    `UPDATE prescription_version SET created_at = DATE_SUB(
       (SELECT created_at FROM (SELECT created_at FROM prescription_version WHERE prescription_id = 'RX-DEMO-0003') t),
       INTERVAL 31 DAY)
     WHERE prescription_id = 'RX-DEMO-0002'`,
  );
  const payload = await buildScoringPayload('RX-DEMO-0003', 1);
  expect(payload.patientVelocity).toBe(0);
  expect(payload.drugCombinationFlag).toBe(true); // still active, just older
});

test('patient age uses whole years and respects the birthday boundary', async () => {
  const before = createScoringPayloadBuilder(pool, { now: () => new Date('2026-11-02T00:00:00Z') });
  const onBirthday = createScoringPayloadBuilder(pool, { now: () => new Date('2026-11-03T00:00:00Z') });
  expect((await before.buildScoringPayload('RX-DEMO-0003', 1)).patientAge).toBe(63);
  expect((await onBirthday.buildScoringPayload('RX-DEMO-0003', 1)).patientAge).toBe(64);
});

test('multi-medicine prescription: drug fields come from the FIRST medicine (sequence 1) — documented simplification', async () => {
  const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
  const v1 = await createPrescriptionVersionRepository(pool).createPrescription({
    patientId: 'PAT-001',
    providerId: 'PRV-002',
    medicines: [
      { drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400', dosageUnit: 'mg', frequency: 'every 8 hours', durationDays: 5, quantityPrescribed: 15 },
      { drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic', dosageValue: '500', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 7, quantityPrescribed: 21 },
    ],
  });
  const payload = await buildScoringPayload(v1.prescription_id, 1);
  expect(Object.keys(payload)).toEqual(CONTRACT_KEYS); // contract unchanged
  expect(payload).toMatchObject({ drugName: 'Ibuprofen', drugClass: 'nsaid', doseValue: '400.000', doseUnit: 'mg', frequency: 'every 8 hours', durationDays: 5 });
  expect(payload.providerDrugClassHistory).toEqual({ statin: 1 }); // PRV-002's other prescription (RX-DEMO-0002), by first medicine
});

test('unknown prescription versions raise VERSION_NOT_FOUND', async () => {
  await expect(buildScoringPayload('RX-DEMO-0003', 9)).rejects.toMatchObject({ name: 'ScoringPayloadError', code: 'VERSION_NOT_FOUND' });
  await expect(buildScoringPayload('RX-NOPE', 1)).rejects.toBeInstanceOf(ScoringPayloadError);
});
