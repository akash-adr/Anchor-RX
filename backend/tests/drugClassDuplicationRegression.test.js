'use strict';

/**
 * REGRESSION LOCK — drug_combination_flag (the "drug class duplication" signal) must be 1 ONLY for a genuine
 * duplication: another ACTIVE prescription for this patient in the same class, or another medicine in the SAME
 * not-yet-saved submission. A single-medicine prescription for a patient with no same-class history must be 0.
 *
 * Investigated after a false-positive report; the two suspected causes are asserted directly here so a future edit
 * cannot reintroduce them:
 *   (1) a medicine compared against ITSELF — buildFeatureInputs must exclude the current medicine BY INDEX;
 *   (2) "AND pv.id != ?" sent with a NULL id — the clause must be OMITTED entirely for a brand-new prescription.
 *
 * Each test starts from an empty prescription history, so every flag below is exactly what the test created.
 */

const { createPool } = require('../db/connection');
const { resetDatabase, insertReferenceData } = require('../db/reset');
const { REFERENCE_DATA } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createLiveDataBridge } = require('../ml/liveDataBridge');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let repository;
let amendmentService;
let bridge;
const statements = [];

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  const countingPool = {
    execute: (sql, params) => {
      statements.push([sql, params]);
      return pool.execute(sql, params);
    },
  };
  bridge = createLiveDataBridge(countingPool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await insertReferenceData(pool, REFERENCE_DATA); // reference data only: no prescriptions at all
  statements.length = 0;
});

const draftMedicine = (drugName, drugClass) => ({ drugName, drugClass, doseValue: '500', doseUnit: 'mg', frequency: 'twice daily', duration: 5 });
const storedMedicine = (drugName, drugClass) => ({ drugName, drugClass, dosageValue: '500', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 5, quantityPrescribed: 10 });
const flags = (featureInputs) => featureInputs.map((input) => input.drug_combination_flag);
const duplicationQueries = () => statements.filter(([sql]) => /pm\.drug_class = \? AND pv\.status = 'active'/.test(sql));

test('single medicine, patient has ZERO active prescriptions in that class → drug_combination_flag is 0 (not a self-match)', async () => {
  const featureInputs = await bridge.buildFeatureInputs({
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [draftMedicine('Amoxicillin', 'antibiotic')],
  });

  expect(flags(featureInputs)).toEqual([0]);

  // Cause (2): a brand-new prescription has no version id to exclude, so the clause must be absent entirely —
  // "AND pv.id != NULL" would match no rows at all and silently change the count.
  const [[sql, params]] = duplicationQueries();
  expect(sql).not.toMatch(/pv\.id\s*!=/);
  expect(params).toEqual(['PAT-001', 'antibiotic']);
});

test('single medicine stays 0 even when the patient has OTHER active prescriptions in DIFFERENT classes', async () => {
  await repository.createPrescription({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [storedMedicine('Atorvastatin', 'statin'), storedMedicine('Omeprazole', 'ppi')] });

  const featureInputs = await bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [draftMedicine('Amoxicillin', 'antibiotic')] });

  expect(flags(featureInputs)).toEqual([0]);
});

test('several medicines in one submission, all DIFFERENT classes → every flag is 0 (cause 1: no medicine matches itself)', async () => {
  const featureInputs = await bridge.buildFeatureInputs({
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [draftMedicine('Amoxicillin', 'antibiotic'), draftMedicine('Ibuprofen', 'nsaid'), draftMedicine('Omeprazole', 'ppi')],
  });

  expect(flags(featureInputs)).toEqual([0, 0, 0]);
});

test('two medicines in the SAME new submission sharing a class → 1 for BOTH', async () => {
  const featureInputs = await bridge.buildFeatureInputs({
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [draftMedicine('Amoxicillin', 'antibiotic'), draftMedicine('Roxithromycin', 'antibiotic')],
  });

  expect(flags(featureInputs)).toEqual([1, 1]);
});

test('only the SHARED class is flagged when a submission mixes a duplicate pair with an unrelated medicine', async () => {
  const featureInputs = await bridge.buildFeatureInputs({
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [draftMedicine('Amoxicillin', 'antibiotic'), draftMedicine('Ibuprofen', 'nsaid'), draftMedicine('Roxithromycin', 'antibiotic')],
  });

  expect(flags(featureInputs)).toEqual([1, 0, 1]);
});

test('patient has a genuine pre-existing ACTIVE prescription in the same class → 1', async () => {
  await repository.createPrescription({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [storedMedicine('Azithromycin', 'antibiotic')] });

  const featureInputs = await bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [draftMedicine('Amoxicillin', 'antibiotic')] });

  expect(flags(featureInputs)).toEqual([1]);
  // ...and it is that patient's history only: another patient's active antibiotic never flags this one.
  const otherPatient = await bridge.buildFeatureInputs({ patientId: 'PAT-002', providerId: 'PRV-001', medicines: [draftMedicine('Amoxicillin', 'antibiotic')] });
  expect(flags(otherPatient)).toEqual([0]);
});

test('a REVOKED same-class prescription does not flag a new one (active versions only)', async () => {
  const created = await repository.createPrescription({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [storedMedicine('Azithromycin', 'antibiotic')] });
  await amendmentService.revokePrescription(created.prescription_id, 'PRV-001', 'Course completed');

  const featureInputs = await bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [draftMedicine('Amoxicillin', 'antibiotic')] });

  expect(flags(featureInputs)).toEqual([0]);
});

test('the other live signals are unaffected: patient velocity is queried once and is identical for a 0-flag and a 1-flag draft', async () => {
  await repository.createPrescription({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [storedMedicine('Azithromycin', 'antibiotic')] });

  const clean = await bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [draftMedicine('Ibuprofen', 'nsaid')] });
  const duplicate = await bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [draftMedicine('Amoxicillin', 'antibiotic')] });

  expect([flags(clean), flags(duplicate)]).toEqual([[0], [1]]);
  // Velocity counts prescriptions, not classes: the duplication flag must not move it.
  expect(clean[0].patient_velocity).toBe(1);
  expect(duplicate[0].patient_velocity).toBe(1);
  // Dose fields are passed through untouched (the exact submitted string).
  expect([clean[0].dose_value, clean[0].dose_unit, clean[0].duration_days]).toEqual(['500', 'mg', 5]);
});
