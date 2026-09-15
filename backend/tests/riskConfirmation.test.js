'use strict';

/**
 * Module 15 Step 2 — POST /api/prescriptions/preview-risk and /confirm, over a real socket against anchor_rx_test.
 *
 * The AI service is a stub fetch; every scoring entry point is wrapped in a jest spy so the tests can prove WHERE
 * scoring happens: preview scores each medicine once; confirm scores NOTHING and locks exactly what was cached.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const hashEngine = require('../integrity/hashEngine');
const { createApp } = require('../api/server');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createLedgerService } = require('../ledger/ledgerService');
const { createScoringPayloadBuilder } = require('../ml/buildScoringPayload');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer } = require('../ml/scoreAllMedicines');
const { createPreviewCache, DEFAULT_TTL_MS } = require('../ml/previewCache');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

// Distinct, recognisable results per medicine, returned by the stub AI service.
const AI_RESULTS = {
  Ibuprofen: { risk_score: 62, risk_band: 'review', reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'Same-class sibling (stub).' }] },
  Naproxen: { risk_score: 58, risk_band: 'review', reasons: [{ source: 'ml_model', feature: 'dose_value', explanation: 'Unusual dose (stub).' }] },
  Cetirizine: { risk_score: 7, risk_band: 'low', reasons: [] },
};

const SUBMISSION = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  heightCm: '172.5',
  weightKg: '68.40',
  medicines: [
    { drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 5, quantityPrescribed: 15 },
    { drugName: 'Naproxen', drugClass: 'nsaid', dosageValue: '250', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 5, quantityPrescribed: 10 },
    { drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 7, quantityPrescribed: 7 },
  ],
});

let pool;
let server;
let baseUrl;
let clock;
let aiDown;
const spies = {};

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });

  spies.fetch = jest.fn(async (url, init) => {
    if (aiDown) throw new TypeError('fetch failed');
    const payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ...AI_RESULTS[payload.drugName], details: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const payloadBuilder = createScoringPayloadBuilder(pool);
  const realClient = createScoreClient(pool, { payloadBuilder, fetchImpl: spies.fetch, baseUrl: 'http://ai.test' });
  spies.scorePrescriptionViaAI = jest.fn(realClient.scorePrescriptionViaAI);
  spies.scorePayloadViaAI = jest.fn(realClient.scorePayloadViaAI);
  const realScorer = createMedicineScorer(pool, {
    payloadBuilder,
    scoreClient: { scorePrescriptionViaAI: spies.scorePrescriptionViaAI, scorePayloadViaAI: spies.scorePayloadViaAI },
  });
  spies.buildSharedContext = jest.fn(realScorer.buildSharedContext);
  spies.scoreAllMedicines = jest.fn(realScorer.scoreAllMedicines);

  const previewCache = createPreviewCache({ now: () => clock });
  server = createApp({ pool, medicineScorer: { buildSharedContext: spies.buildSharedContext, scoreAllMedicines: spies.scoreAllMedicines }, previewCache }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  clock = Date.now();
  aiDown = false;
  jest.clearAllMocks(); // resets call counts; the wrapped implementations stay
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Row count of EVERY table in the test database. */
async function allRowCounts() {
  const [tables] = await pool.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [TEST_DB_NAME]);
  const counts = {};
  for (const { name } of tables) {
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    counts[name] = n;
  }
  return counts;
}

const scoringCallCounts = () =>
  Object.fromEntries(['buildSharedContext', 'scoreAllMedicines', 'scorePayloadViaAI', 'scorePrescriptionViaAI', 'fetch'].map((name) => [name, spies[name].mock.calls.length]));

const ZERO_SCORING_CALLS = { buildSharedContext: 0, scoreAllMedicines: 0, scorePayloadViaAI: 0, scorePrescriptionViaAI: 0, fetch: 0 };

// ── (a) ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('(a) preview-risk scores every medicine once and creates ZERO database rows in any table', async () => {
  const before = await allRowCounts();

  const preview = await call('POST', '/api/prescriptions/preview-risk', SUBMISSION);

  expect(preview.status).toBe(200);
  expect(Object.keys(preview.body).sort()).toEqual(['medicines', 'previewToken']);
  expect(preview.body.previewToken).toMatch(/^[0-9a-f-]{36}$/);
  expect(preview.body.medicines).toEqual([
    { drugName: 'Ibuprofen', riskScore: 62, riskBand: 'review', reasons: AI_RESULTS.Ibuprofen.reasons },
    { drugName: 'Naproxen', riskScore: 58, riskBand: 'review', reasons: AI_RESULTS.Naproxen.reasons },
    { drugName: 'Cetirizine', riskScore: 7, riskBand: 'low', reasons: [] },
  ]);
  expect(scoringCallCounts()).toEqual({ buildSharedContext: 1, scoreAllMedicines: 1, scorePayloadViaAI: 3, scorePrescriptionViaAI: 0, fetch: 3 });

  expect(await allRowCounts()).toEqual(before);
});

test('(a) preview-risk validates like create, refuses client-supplied risk, and caches nothing when the AI service is down', async () => {
  const before = await allRowCounts();

  const invalid = await call('POST', '/api/prescriptions/preview-risk', { ...SUBMISSION, medicines: [{ ...SUBMISSION.medicines[0], dosageValue: '-5' }] });
  expect(invalid).toMatchObject({ status: 400, body: { reason: 'INVALID_FIELD' } });

  const smuggled = await call('POST', '/api/prescriptions/preview-risk', { ...SUBMISSION, medicines: [{ ...SUBMISSION.medicines[0], lockedRisk: { riskScore: 1, riskBand: 'low', reasons: [] } }] });
  expect(smuggled).toMatchObject({ status: 400, body: { reason: 'FIELD_NOT_ALLOWED' } });

  const unknownPatient = await call('POST', '/api/prescriptions/preview-risk', { ...SUBMISSION, patientId: 'PAT-GHOST' });
  expect(unknownPatient).toMatchObject({ status: 400, body: { reason: 'UNKNOWN_REFERENCE' } });
  expect(spies.fetch).not.toHaveBeenCalled(); // nothing scored for an invalid submission

  aiDown = true;
  const down = await call('POST', '/api/prescriptions/preview-risk', SUBMISSION);
  expect(down).toMatchObject({ status: 503, body: { reason: 'AI_SERVICE_UNAVAILABLE' } });
  expect(down.body.previewToken).toBeUndefined();

  expect(await allRowCounts()).toEqual(before);
});

// ── (b) ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('(b) confirm creates the prescription with locked_risk_* EXACTLY as cached — and scores nothing again', async () => {
  const preview = await call('POST', '/api/prescriptions/preview-risk', SUBMISSION);
  const before = await allRowCounts();
  jest.clearAllMocks(); // from here on, ANY scoring call would be counted against confirm

  const confirmed = await call('POST', '/api/prescriptions/confirm', { previewToken: preview.body.previewToken });

  expect(confirmed.status).toBe(201);
  expect(scoringCallCounts()).toEqual(ZERO_SCORING_CALLS); // no scoreAllMedicines, no scorePrescriptionViaAI, no HTTP call

  // Exactly one prescription: 1 version, 3 medicines, 1 ledger entry — and nothing else.
  const after = await allRowCounts();
  expect(after).toEqual({ ...before, prescription_version: before.prescription_version + 1, prescription_medicine: before.prescription_medicine + 3, ledger_entry: before.ledger_entry + 1 });

  // Stored locked risk === the cached preview result, per medicine, in submission order.
  const repository = createPrescriptionVersionRepository(pool);
  const row = await repository.getLatestVersion(confirmed.body.prescriptionId);
  expect(row.medicines.map((m) => [m.sequence_number, m.drug_name, m.locked_risk_score, m.locked_risk_band, m.locked_risk_reasons])).toEqual([
    [1, 'Ibuprofen', '62.00', 'review', AI_RESULTS.Ibuprofen.reasons],
    [2, 'Naproxen', '58.00', 'review', AI_RESULTS.Naproxen.reasons],
    [3, 'Cetirizine', '7.00', 'low', []],
  ]);
  expect(row.medicines.map((m) => ({ drugName: m.drug_name, riskScore: Number(m.locked_risk_score), riskBand: m.locked_risk_band, reasons: m.locked_risk_reasons }))).toEqual(preview.body.medicines);
  expect(confirmed.body.medicines.map((m) => [m.sequenceNumber, m.lockedRisk])).toEqual(
    preview.body.medicines.map(({ riskScore, riskBand, reasons }, index) => [index + 1, { riskScore, riskBand, reasons }]),
  );

  // The saved prescription is exactly what was previewed, with normal integrity + ledger anchoring.
  expect(row).toMatchObject({ patient_id: 'PAT-001', provider_id: 'PRV-001', height_cm: '172.5', weight_kg: '68.40', status: 'active', version_number: 1 });
  expect(row.medicines.map((m) => [m.dosage_value, m.quantity_prescribed])).toEqual([['400.000', 15], ['250.000', 10], ['10.000', 7]]);
  expect(hashEngine.verifyIntegrity(row, row.field_hashes, row.salt)).toMatchObject({ valid: true, tamperedFields: [] });
  const anchor = await createLedgerService(pool, { repository }).verifyAnchor(row.prescription_id, 1);
  expect(anchor).toMatchObject({ anchored: true, integrityRootMatch: true, chainIntact: true });
  expect(confirmed.body.qrPayload).toMatchObject({ prescriptionId: row.prescription_id, versionNumber: 1 });
});

test('(b) locked risk is all-or-nothing with the version: a failure inside the transaction writes no row of any kind', async () => {
  await pool.execute("INSERT INTO provider (provider_id, name, license_number, credentials, status) VALUES ('PRV-TEMP', 'Temp (synthetic)', 'LIC-TEMP', 'MBBS', 'active')");
  const preview = await call('POST', '/api/prescriptions/preview-risk', { ...SUBMISSION, providerId: 'PRV-TEMP' });
  expect(preview.status).toBe(200);
  await pool.execute("DELETE FROM provider WHERE provider_id = 'PRV-TEMP'"); // the FK now fails inside createPrescription's transaction
  const before = await allRowCounts();

  const confirmed = await call('POST', '/api/prescriptions/confirm', { previewToken: preview.body.previewToken });

  expect(confirmed).toMatchObject({ status: 400, body: { reason: 'UNKNOWN_REFERENCE' } });
  expect(await allRowCounts()).toEqual(before); // no version, no medicine (no locked risk), no ledger entry
});

// ── (c) ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('(c) confirm rejects invalid, already-used and expired tokens (and resubmitted data) without creating anything', async () => {
  const expectExpired = (result) => {
    expect(result.status).toBe(410);
    expect(result.body).toMatchObject({ error: true, reason: 'RISK_PREVIEW_EXPIRED' });
    expect(result.body.message).toMatch(/Review the risk assessment again and resubmit/);
  };

  // Already used: the first confirm succeeds, the second is refused.
  const used = await call('POST', '/api/prescriptions/preview-risk', SUBMISSION);
  expect((await call('POST', '/api/prescriptions/confirm', { previewToken: used.body.previewToken })).status).toBe(201);
  const expiring = await call('POST', '/api/prescriptions/preview-risk', SUBMISSION);
  const before = await allRowCounts();
  jest.clearAllMocks();

  expectExpired(await call('POST', '/api/prescriptions/confirm', { previewToken: used.body.previewToken }));

  // Invalid / unknown.
  expectExpired(await call('POST', '/api/prescriptions/confirm', { previewToken: '00000000-0000-4000-8000-000000000000' }));
  expectExpired(await call('POST', '/api/prescriptions/confirm', { previewToken: 'not-a-real-token' }));
  expect(await call('POST', '/api/prescriptions/confirm', {})).toMatchObject({ status: 400, body: { reason: 'PREVIEW_TOKEN_REQUIRED' } });
  expect(await call('POST', '/api/prescriptions/confirm', { previewToken: 12345 })).toMatchObject({ status: 400, body: { reason: 'PREVIEW_TOKEN_REQUIRED' } });

  // The client can't resubmit data or risk alongside the token.
  expect(await call('POST', '/api/prescriptions/confirm', { previewToken: expiring.body.previewToken, medicines: SUBMISSION.medicines })).toMatchObject({
    status: 400,
    body: { reason: 'FIELD_NOT_ALLOWED' },
  });

  // Expired: 10 minutes after the preview.
  clock += DEFAULT_TTL_MS;
  expectExpired(await call('POST', '/api/prescriptions/confirm', { previewToken: expiring.body.previewToken }));

  expect(await allRowCounts()).toEqual(before);
  expect(scoringCallCounts()).toEqual(ZERO_SCORING_CALLS); // rejected confirms never fall back to scoring either
});

test('the old create endpoint cannot be used to smuggle risk numbers: lockedRisk in its body is refused', async () => {
  const before = await allRowCounts();
  const result = await call('POST', '/api/prescriptions', { ...SUBMISSION, medicines: [{ ...SUBMISSION.medicines[0], lockedRisk: { riskScore: 1, riskBand: 'low', reasons: [] } }] });
  expect(result).toMatchObject({ status: 400, body: { reason: 'FIELD_NOT_ALLOWED' } });
  expect(await allRowCounts()).toEqual(before);
});

// ── repository contract ────────────────────────────────────────────────────────────────────────────────────

test('repository: lockedRisks must be one valid entry per medicine; amendments copy medicines forward WITHOUT locked risk', async () => {
  const repository = createPrescriptionVersionRepository(pool);
  const data = { patientId: 'PAT-003', providerId: 'PRV-002', medicines: SUBMISSION.medicines.slice(0, 2) };
  const risk = { riskScore: 40.5, riskBand: 'review', reasons: [] };
  const before = await allRowCounts();

  for (const lockedRisks of [[risk], [risk, { ...risk, riskBand: 'medium' }], [risk, { ...risk, riskScore: 101 }], [risk, { ...risk, reasons: 'x' }], 'nope']) {
    await expect(repository.createPrescription(data, { lockedRisks })).rejects.toMatchObject({ code: 'INVALID_LOCKED_RISK' });
  }
  expect(await allRowCounts()).toEqual(before);

  const v1 = await repository.createPrescription(data, { lockedRisks: [risk, { riskScore: 3, riskBand: 'low', reasons: [] }] });
  expect(v1.medicines.map((m) => [m.locked_risk_score, m.locked_risk_band])).toEqual([['40.50', 'review'], ['3.00', 'low']]);

  const v2 = await repository.amendPrescription(v1.prescription_id, { medicineId: v1.medicines[1].medicine_id, quantityPrescribed: 8 });
  expect(v2.medicines.map((m) => m.locked_risk_score)).toEqual([null, null]); // open decision: not copied forward
});
