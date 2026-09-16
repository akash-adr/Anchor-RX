'use strict';

/**
 * Module 16 Step 2 — POST /api/prescriptions/assess-risk runs liveDataBridge.buildFeatureInputs FIRST and scores with
 * its live drug_combination_flag / patient_velocity. Real anchor_rx_test data; the AI service is a recording stub.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createApp } = require('../api/server');
const { createScoringPayloadBuilder } = require('../ml/buildScoringPayload');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer } = require('../ml/scoreAllMedicines');
const { createLiveDataBridge } = require('../ml/liveDataBridge');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const DUPLICATION_REASON = { source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'Another active prescription or another medicine on this prescription is in the same drug class.' };
const CONTRACT_KEYS = [
  'payloadVersion', 'prescriptionId', 'versionNumber', 'patientId', 'providerId', 'referenceTime',
  'drugName', 'drugClass', 'doseValue', 'doseUnit', 'frequency', 'durationDays', 'route',
  'patientAge', 'patientWeight', 'patientWeightIsDefault', 'patientHeight',
  'drugCombinationFlag', 'overlappingPrescriptionIds', 'siblingSameClassCount', 'providerDrugClassHistory', 'patientVelocity',
];

let pool;
let server;
let baseUrl;
let bridgeOverride; // when set, replaces buildFeatureInputs' result (to prove where the payload's values come from)
const calls = [];
const payloads = [];
const featureResults = [];

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  // Stub AI service: explains duplication exactly when the payload carries the flag (like the real rule engine).
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    const body = payload.drugCombinationFlag
      ? { risk_score: 25, risk_band: 'low', reasons: [DUPLICATION_REASON], details: null }
      : { risk_score: 4, risk_band: 'low', reasons: [], details: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const payloadBuilder = createScoringPayloadBuilder(pool);
  const realScorer = createMedicineScorer(pool, { payloadBuilder, scoreClient: createScoreClient(pool, { payloadBuilder, fetchImpl, baseUrl: 'http://ai.test' }) });
  const medicineScorer = {
    buildSharedContext: realScorer.buildSharedContext,
    scoreAllMedicines: (...args) => {
      calls.push('scoreAllMedicines');
      return realScorer.scoreAllMedicines(...args);
    },
  };
  const realBridge = createLiveDataBridge(pool);
  const liveDataBridge = {
    ...realBridge,
    buildFeatureInputs: async (draft) => {
      calls.push('buildFeatureInputs');
      const result = bridgeOverride ? bridgeOverride(draft) : await realBridge.buildFeatureInputs(draft);
      featureResults.push({ draft, result });
      return result;
    },
  };
  server = createApp({ pool, medicineScorer, liveDataBridge }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await seed(pool); // PAT-002 has two ACTIVE statins: RX-DEMO-0002, RX-DEMO-0003
  bridgeOverride = null;
  calls.length = 0;
  payloads.length = 0;
  featureResults.length = 0;
});

async function preview(body) {
  const response = await fetch(`${baseUrl}/api/prescriptions/assess-risk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const statin = { drugName: 'Simvastatin', drugClass: 'statin', dosageValue: '20', dosageUnit: 'mg', frequency: 'once daily', durationDays: 30, quantityPrescribed: 30 };
const antihistamine = { drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 7, quantityPrescribed: 7 };

test('patient with an ACTIVE same-class prescription → buildFeatureInputs runs first and its real flag drives the duplication reason', async () => {
  const [[before]] = await pool.query('SELECT (SELECT COUNT(*) FROM prescription_version) AS v, (SELECT COUNT(*) FROM prescription_medicine) AS m');

  const result = await preview({ patientId: 'PAT-002', providerId: 'PRV-001', medicines: [statin, antihistamine] });

  expect(result.status).toBe(200);
  expect(calls).toEqual(['buildFeatureInputs', 'scoreAllMedicines']); // FIRST, then scoring
  const [{ draft, result: features }] = featureResults;
  expect(draft).toEqual({
    patientId: 'PAT-002',
    providerId: 'PRV-001',
    heightCm: null,
    weightKg: null,
    medicines: [
      { drugName: 'Simvastatin', drugClass: 'statin', doseValue: '20', doseUnit: 'mg', frequency: 'once daily', duration: 30 },
      { drugName: 'Cetirizine', drugClass: 'antihistamine', doseValue: '10', doseUnit: 'mg', frequency: 'once daily', duration: 7 },
    ],
  }); // creation: no existingPrescriptionVersionId (amendment gap)
  expect(features.map((f) => [f.drug_name, f.drug_combination_flag, f.patient_velocity])).toEqual([['Simvastatin', 1, 2], ['Cetirizine', 0, 2]]);

  // The payloads carry exactly the bridge's values, per medicine; the contract is unchanged (no rarity fields sent).
  expect(payloads.map((p) => [p.drugName, p.drugCombinationFlag, p.patientVelocity])).toEqual([['Simvastatin', true, 2], ['Cetirizine', false, 2]]);
  payloads.forEach((p) => expect(Object.keys(p)).toEqual(CONTRACT_KEYS));

  expect(result.body.medicines).toEqual([
    { medicineIndex: 0, drugName: 'Simvastatin', riskScore: 25, riskBand: 'low', reasons: [DUPLICATION_REASON] },
    { medicineIndex: 1, drugName: 'Cetirizine', riskScore: 4, riskBand: 'low', reasons: [] },
  ]);
  const [[after]] = await pool.query('SELECT (SELECT COUNT(*) FROM prescription_version) AS v, (SELECT COUNT(*) FROM prescription_medicine) AS m');
  expect(after).toEqual(before); // preview still writes nothing
});

test('the payload value really comes from buildFeatureInputs, not the older computation', async () => {
  // Cetirizine for PAT-003 duplicates nothing anywhere; the bridge (overridden) says otherwise, with a distinctive velocity.
  bridgeOverride = (draft) => draft.medicines.map((m, index) => ({ medicine_index: index, drug_name: m.drugName, drug_combination_flag: 1, patient_velocity: 42, drug_rarity_score: 0.5, provider_rarity_score: 0.5 }));

  const result = await preview({ patientId: 'PAT-003', providerId: 'PRV-001', medicines: [antihistamine] });

  expect(result.status).toBe(200);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ drugCombinationFlag: true, patientVelocity: 42, overlappingPrescriptionIds: [], siblingSameClassCount: 0 });
  expect(result.body.medicines[0].reasons).toEqual([DUPLICATION_REASON]);
});
