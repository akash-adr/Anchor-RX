'use strict';

/**
 * Module 15 Step 1 — per-medicine scoring payloads and scoreAllMedicines, against the seeded anchor_rx_test database.
 * The AI service is replaced by a recording fetch stub: every test sees the EXACT payload each medicine was scored with.
 *
 * Seed facts used here:
 *   PAT-001 has ONE other active prescription: RX-DEMO-0001 (penicillin antibiotic). No nsaid anywhere.
 *   PAT-002 has two active statin prescriptions: RX-DEMO-0002, RX-DEMO-0003.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createScoringPayloadBuilder, buildScoringPayloadForMedicine } = require('../ml/buildScoringPayload');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer } = require('../ml/scoreAllMedicines');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const NOW = new Date('2026-09-15T12:00:00Z');

let pool;
let payloadBuilder;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  payloadBuilder = createScoringPayloadBuilder(pool, { now: () => NOW });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

const medicine = (drugName, drugClass, overrides = {}) => ({
  drugName, drugClass, dosageValue: '400', dosageUnit: 'mg', frequency: 'every 8 hours', durationDays: 5, ...overrides,
});

/** A scorer whose AI service is a stub that records each payload and returns a distinct score per call. */
function recordingScorer() {
  const payloads = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    const body = {
      risk_score: 10 + payloads.length,
      risk_band: payload.drugCombinationFlag ? 'review' : 'low',
      reasons: payload.drugCombinationFlag ? [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'same class' }] : [],
      details: null,
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const scoreClient = createScoreClient(pool, { payloadBuilder, fetchImpl, baseUrl: 'http://ai.test' });
  return { ...createMedicineScorer(pool, { payloadBuilder, scoreClient }), payloads, fetchImpl };
}

async function tableCounts() {
  const [[row]] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM prescription_version) AS versions, (SELECT COUNT(*) FROM prescription_medicine) AS medicines, (SELECT COUNT(*) FROM ledger_entry) AS ledger',
  );
  return row;
}

test('two medicines in the SAME drug class on one submission → drugCombinationFlag true for BOTH, with no other active overlap', async () => {
  const { buildSharedContext, scoreAllMedicines, payloads, fetchImpl } = recordingScorer();
  const sharedContext = await buildSharedContext({ patientId: 'PAT-001', providerId: 'PRV-001' });
  expect(sharedContext.activePrescriptionDrugClasses).toEqual([{ prescriptionId: 'RX-DEMO-0001', drugClass: 'penicillin antibiotic' }]); // no nsaid

  const results = await scoreAllMedicines(
    [medicine('Ibuprofen', 'nsaid'), medicine('Naproxen', ' NSAID ', { dosageValue: '250' })], // class compared trimmed/case-insensitively
    sharedContext,
  );

  expect(fetchImpl).toHaveBeenCalledTimes(2); // exactly one AI call per medicine
  expect(payloads.map((p) => [p.drugName, p.drugCombinationFlag, p.overlappingPrescriptionIds, p.siblingSameClassCount])).toEqual([
    ['Ibuprofen', true, [], 1], // cross-prescription source is EMPTY — the flag comes from the sibling alone
    ['Naproxen', true, [], 1],
  ]);
  expect(results).toEqual([
    { medicineIndex: 0, drugName: 'Ibuprofen', riskScore: 11, riskBand: 'review', reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'same class' }] },
    { medicineIndex: 1, drugName: 'Naproxen', riskScore: 12, riskBand: 'review', reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'same class' }] },
  ]);
});

test('control: two medicines in DIFFERENT classes (no other active overlap) → flag false for both', async () => {
  const { buildSharedContext, scoreAllMedicines, payloads } = recordingScorer();
  const sharedContext = await buildSharedContext({ patientId: 'PAT-001', providerId: 'PRV-001' });

  await scoreAllMedicines([medicine('Ibuprofen', 'nsaid'), medicine('Cetirizine', 'antihistamine', { dosageValue: '10', frequency: 'once daily' })], sharedContext);

  expect(payloads.map((p) => [p.drugCombinationFlag, p.siblingSameClassCount, p.overlappingPrescriptionIds])).toEqual([
    [false, 0, []],
    [false, 0, []],
  ]);
});

test('cross-prescription source still works on its own — and now matches ANY medicine of the other prescription', async () => {
  // PAT-003 gets a stored 2-medicine prescription whose SECOND medicine is an antihistamine.
  const other = await createPrescriptionVersionRepository(pool).createPrescription({
    patientId: 'PAT-003',
    providerId: 'PRV-002',
    medicines: [
      { drugName: 'Metformin', drugClass: 'biguanide', dosageValue: '500', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 30, quantityPrescribed: 60 },
      { drugName: 'Loratadine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 10, quantityPrescribed: 10 },
    ],
  });
  const { buildSharedContext, scoreAllMedicines, payloads } = recordingScorer();

  await scoreAllMedicines([medicine('Cetirizine', 'antihistamine', { dosageValue: '10' })], await buildSharedContext({ patientId: 'PAT-003', providerId: 'PRV-001' }));
  expect(payloads[0]).toMatchObject({ drugCombinationFlag: true, overlappingPrescriptionIds: [other.prescription_id], siblingSameClassCount: 0 });

  const statin = recordingScorer();
  await statin.scoreAllMedicines([medicine('Simvastatin', 'statin', { dosageValue: '20' })], await statin.buildSharedContext({ patientId: 'PAT-002', providerId: 'PRV-001' }));
  expect(statin.payloads[0]).toMatchObject({ drugCombinationFlag: true, overlappingPrescriptionIds: ['RX-DEMO-0002', 'RX-DEMO-0003'], siblingSameClassCount: 0 });
});

test('per-medicine payload: full contract, shared context (prescription weight/height win), exact dose string, and nothing is written', async () => {
  const before = await tableCounts();
  const { buildSharedContext, scoreAllMedicines, payloads } = recordingScorer();
  // PAT-002's patient record weighs 82 kg; the weight recorded on THIS prescription takes precedence.
  // The seed stamps prescriptions with the REAL clock, so the velocity window must end after seeding (not the pinned NOW).
  const referenceTime = new Date();
  const sharedContext = await buildSharedContext({ patientId: 'PAT-002', providerId: 'PRV-002', heightCm: '168.5', weightKg: '79.25', referenceTime });

  await scoreAllMedicines([medicine('Amoxicillin', 'penicillin antibiotic', { dosageValue: '500.125', frequency: 'three times daily', durationDays: 7 })], sharedContext);

  expect(payloads[0]).toEqual({
    payloadVersion: 1,
    prescriptionId: null, // not created yet
    versionNumber: null,
    patientId: 'PAT-002',
    providerId: 'PRV-002',
    referenceTime: referenceTime.toISOString(),
    drugName: 'Amoxicillin',
    drugClass: 'penicillin antibiotic',
    doseValue: '500.125', // exact string, never a float
    doseUnit: 'mg',
    frequency: 'three times daily',
    durationDays: 7,
    route: 'oral',
    patientAge: 63,
    patientWeight: 79.25,
    patientWeightIsDefault: false,
    patientHeight: 168.5,
    drugCombinationFlag: false,
    overlappingPrescriptionIds: [],
    siblingSameClassCount: 0,
    providerDrugClassHistory: { statin: 1 }, // PRV-002's RX-DEMO-0002 — nothing excluded while previewing
    patientVelocity: 2, // RX-DEMO-0002 and RX-DEMO-0003, both seeded within the last 30 days
  });
  expect(await tableCounts()).toEqual(before); // pure scoring pass
});

test('an invalid medicine fails the whole pass BEFORE any AI call; a non-string dose is refused', async () => {
  const { buildSharedContext, scoreAllMedicines, fetchImpl } = recordingScorer();
  const sharedContext = await buildSharedContext({ patientId: 'PAT-001', providerId: 'PRV-001' });

  await expect(scoreAllMedicines([medicine('Ibuprofen', 'nsaid'), medicine('Mystery', '')], sharedContext)).rejects.toMatchObject({ code: 'INVALID_MEDICINE' });
  await expect(scoreAllMedicines([medicine('Ibuprofen', 'nsaid', { dosageValue: 400 })], sharedContext)).rejects.toMatchObject({ code: 'INVALID_MEDICINE' });
  await expect(scoreAllMedicines([], sharedContext)).rejects.toMatchObject({ code: 'NO_MEDICINES' });
  expect(fetchImpl).not.toHaveBeenCalled();

  // The pure function can be used directly too (no database).
  expect(buildScoringPayloadForMedicine(medicine('Ibuprofen', 'nsaid'), sharedContext, ['NSAID'])).toMatchObject({ drugCombinationFlag: true, siblingSameClassCount: 1 });
});

test('Module 16: per-medicine featureInputs set drugCombinationFlag and patientVelocity in each payload', async () => {
  const { buildSharedContext, scoreAllMedicines, payloads, fetchImpl } = recordingScorer();
  const sharedContext = await buildSharedContext({ patientId: 'PAT-001', providerId: 'PRV-001' });

  await scoreAllMedicines(
    [medicine('Ibuprofen', 'nsaid'), medicine('Cetirizine', 'antihistamine', { dosageValue: '10' })],
    sharedContext,
    [{ drug_combination_flag: 1, patient_velocity: 7 }, { drug_combination_flag: 0, patient_velocity: 7 }],
  );
  // Neither medicine duplicates anything by the old computation — the flag and velocity come from featureInputs.
  expect(payloads.map((p) => [p.drugName, p.drugCombinationFlag, p.patientVelocity, p.siblingSameClassCount])).toEqual([
    ['Ibuprofen', true, 7, 0],
    ['Cetirizine', false, 7, 0],
  ]);
  expect(payloads[0]).not.toHaveProperty('drugRarityScore'); // rarity HELD: not sent
  expect(payloads[0]).not.toHaveProperty('providerRarityScore');

  fetchImpl.mockClear();
  await expect(scoreAllMedicines([medicine('Ibuprofen', 'nsaid')], sharedContext, [])).rejects.toMatchObject({ code: 'INVALID_FEATURE_INPUTS' });
  await expect(scoreAllMedicines([medicine('Ibuprofen', 'nsaid')], sharedContext, [{ drug_combination_flag: 2, patient_velocity: 1 }])).rejects.toMatchObject({ code: 'INVALID_FEATURE_INPUT' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
