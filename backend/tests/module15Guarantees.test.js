'use strict';

/**
 * Module 15 Step 6 — locked risk is permanent: retraining and amendment never touch a confirmed version's lock.
 * Every check reads the DATABASE directly (raw column text, hex bytes of the JSON reasons, and a SHA-256 digest).
 * The AI service is a stub whose "model" can be switched from original to retrained mid-test.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createApp } = require('../api/server');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createScoringPayloadBuilder } = require('../ml/buildScoringPayload');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer } = require('../ml/scoreAllMedicines');
const { createTrustEvaluator } = require('../trust/evaluateTrust');
const { generateQrPayload } = require('../qr/qrEngine');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const MODELS = {
  original: {
    Paracetamol: { risk_score: 65, risk_band: 'review', reasons: [{ source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' }] },
    Cetirizine: { risk_score: 12, risk_band: 'low', reasons: [] },
  },
  retrained: {
    Paracetamol: { risk_score: 90, risk_band: 'high', reasons: [{ source: 'ml_model', feature: 'dose_value', explanation: 'Retrained model: dose pattern unusual (simulated).' }] },
    Cetirizine: { risk_score: 88, risk_band: 'high', reasons: [{ source: 'ml_model', feature: 'patient_age', explanation: 'Retrained model: age pattern unusual (simulated).' }] },
  },
};

const SUBMISSION = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  heightCm: '172.5',
  weightKg: '68.40',
  medicines: [
    { drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '1000', dosageUnit: 'mg', frequency: 'four times daily', durationDays: 5, quantityPrescribed: 20 },
    { drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 7, quantityPrescribed: 7 },
  ],
});

const toScoringMedicine = ({ drugName, drugClass, dosageValue, dosageUnit, frequency, durationDays }) => ({ drugName, drugClass, dosageValue, dosageUnit, frequency, durationDays });

let pool;
let server;
let baseUrl;
let repository;
let amendmentService;
let scoreClient;
let medicineScorer;
let model;
const aiCalls = [];

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    aiCalls.push({ model, drugName: payload.drugName });
    return new Response(JSON.stringify({ ...MODELS[model][payload.drugName], details: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const payloadBuilder = createScoringPayloadBuilder(pool);
  scoreClient = createScoreClient(pool, { payloadBuilder, fetchImpl, baseUrl: 'http://ai.test' });
  medicineScorer = createMedicineScorer(pool, { payloadBuilder, scoreClient });
  server = createApp({ pool, repository, amendmentService, medicineScorer }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  model = 'original';
  aiCalls.length = 0;
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

/** The locked columns exactly as MySQL stores them: text, raw JSON bytes (hex), and a digest over all three. */
async function lockedBytes(versionRowId) {
  const [rows] = await pool.query(
    `SELECT medicine_id, sequence_number,
            CAST(locked_risk_score AS CHAR) AS score,
            locked_risk_band AS band,
            HEX(CAST(locked_risk_reasons AS BINARY)) AS reasons_hex,
            SHA2(CONCAT_WS('|', CAST(locked_risk_score AS CHAR), locked_risk_band, CAST(locked_risk_reasons AS CHAR)), 256) AS digest
       FROM prescription_medicine
      WHERE prescription_version_id = ?
      ORDER BY sequence_number`,
    [versionRowId],
  );
  return rows;
}

async function previewAndConfirm(submission) {
  const preview = await call('POST', '/api/prescriptions/assess-risk', submission);
  expect(preview.status).toBe(200);
  const confirmed = await call('POST', '/api/prescriptions/confirm-and-create', { previewToken: preview.body.previewToken });
  expect(confirmed.status).toBe(201);
  return repository.getLatestVersion(confirmed.body.prescriptionId);
}

test('1. retraining: re-scoring the same medicines through EVERY path leaves the stored lock byte-for-byte unchanged', async () => {
  const v1 = await previewAndConfirm(SUBMISSION);
  const before = await lockedBytes(v1.id);
  expect(before.map((r) => [r.sequence_number, r.score, r.band])).toEqual([[1, '65.00', 'review'], [2, '12.00', 'low']]);
  expect(before.every((r) => r.reasons_hex !== null && r.digest !== null)).toBe(true);

  model = 'retrained';
  const retrainedCallsBefore = aiCalls.length;

  // (a) scoreAllMedicines on the same medicine data
  const sharedContext = await medicineScorer.buildSharedContext({ patientId: SUBMISSION.patientId, providerId: SUBMISSION.providerId, heightCm: SUBMISSION.heightCm, weightKg: SUBMISSION.weightKg });
  const rescored = await medicineScorer.scoreAllMedicines(SUBMISSION.medicines.map(toScoringMedicine), sharedContext);
  expect(rescored.map((r) => [r.drugName, r.riskScore, r.riskBand])).toEqual([['Paracetamol', 90, 'high'], ['Cetirizine', 88, 'high']]);

  // (b) scorePrescriptionViaAI on the STORED version (Module 9's scoring path)
  expect(await scoreClient.scorePrescriptionViaAI(v1.prescription_id, 1)).toMatchObject({ riskScore: 90, riskBand: 'high' });

  // (c) a full Module 9 trust evaluation of a real scan — its decision (and trust_decision_log row) uses the new 90
  const qr = JSON.stringify(generateQrPayload(v1.prescription_id, 1, v1.created_at));
  const decision = await createTrustEvaluator(pool, { scoreClient }).evaluateTrust(qr, 'PHM-001');
  expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'highRiskScore', riskScore: 90, riskBand: 'high' });
  const [[logged]] = await pool.query('SELECT risk_score, risk_band FROM trust_decision_log WHERE prescription_id = ? ORDER BY decision_id DESC LIMIT 1', [v1.prescription_id]);
  expect(logged).toEqual({ risk_score: 90, risk_band: 'high' });

  // (d) a fresh assess-risk for the identical submission (never confirmed)
  const again = await call('POST', '/api/prescriptions/assess-risk', SUBMISSION);
  expect(again.body.medicines.map((m) => m.riskScore)).toEqual([90, 88]);

  expect(aiCalls.slice(retrainedCallsBefore).every((c) => c.model === 'retrained')).toBe(true);
  expect(aiCalls.length - retrainedCallsBefore).toBe(2 + 1 + 1 + 2); // the retrained model really was consulted, 6 times

  const after = await lockedBytes(v1.id);
  expect(after).toEqual(before); // every column, every medicine, identical
  expect(after.map((r) => r.digest)).toEqual(before.map((r) => r.digest));
});

test('2. amendment: the ORIGINAL version lock stays byte-for-byte identical; the new version has its own independent rows', async () => {
  const v1 = await previewAndConfirm(SUBMISSION);
  const before = await lockedBytes(v1.id);

  const v2 = await amendmentService.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v1.medicines[0].medicine_id, dosageValue: '500' }, 'PRV-001', 'Lower dose');
  expect(v2.version_number).toBe(2);

  expect(await lockedBytes(v1.id)).toEqual(before); // original untouched by the amendment

  const v2Bytes = await lockedBytes(v2.id);
  expect(v2Bytes.map((r) => r.medicine_id).some((id) => before.map((r) => r.medicine_id).includes(id))).toBe(false); // separate rows
  // CURRENT BEHAVIOUR — the gap reported with this step: no amendment preview→confirm flow exists, so the new version
  // does NOT get a lock of its own; its locked columns are NULL (the original's lock is not copied either).
  expect(v2Bytes.map((r) => [r.score, r.band, r.reasons_hex])).toEqual([[null, null, null], [null, null, null]]);

  // A fresh preview of the AMENDED medicines (retrained model) scores independently and changes neither version.
  model = 'retrained';
  const amended = { ...SUBMISSION, medicines: [{ ...SUBMISSION.medicines[0], dosageValue: '500' }, SUBMISSION.medicines[1]] };
  const preview = await call('POST', '/api/prescriptions/assess-risk', amended);
  expect(preview.body.medicines.map((m) => m.riskScore)).toEqual([90, 88]);
  expect(await lockedBytes(v1.id)).toEqual(before);
  expect(await lockedBytes(v2.id)).toEqual(v2Bytes);
});
