'use strict';

/**
 * End-to-end risk wiring — POST /api/prescriptions/assess-risk and /confirm-and-create over a real socket, against
 * anchor_rx_test. Spies sit at the two boundaries that matter, so counts are OBSERVED, not inferred:
 *   - every SQL statement the app sends through its pool (a counting proxy);
 *   - every HTTP call to the AI service (a controllable fetch stub: ok / refused / HTTP 500 / hangs, per drug),
 *     plus jest spies on scoreAllMedicines / buildSharedContext / scorePayloadViaAI / scorePrescriptionViaAI.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createApp } = require('../api/server');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createScoringPayloadBuilder } = require('../ml/buildScoringPayload');
const { createScoreClient } = require('../ml/scoreClient');
const { createMedicineScorer, AI_RISK_UNAVAILABLE_REASON } = require('../ml/scoreAllMedicines');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const AI_TIMEOUT_MS = 300;

// Distinct SQL signatures of the live data bridge (and the older velocity query it replaces for this flow).
const SQL = {
  velocity: /version_number = 1 AND created_at > \(NOW\(\) - INTERVAL 30 DAY\)/,
  legacyVelocity: /created_at > DATE_SUB\(\?, INTERVAL \? DAY\)/,
  duplication: /pm\.drug_class = \? AND pv\.status = 'active'/,
  providerRarity: /SUM\(CASE WHEN pm\.drug_class = \?/,
  drugRarity: /SUM\(CASE WHEN pm\.drug_name = \?/,
};

const RESPONSES = {
  Amoxicillin: { risk_score: 25, risk_band: 'low', reasons: [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'Another active prescription or another medicine on this prescription is in the same drug class.' }] },
  Roxithromycin: { risk_score: 45, risk_band: 'review', reasons: [{ source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' }] },
};

const SUBMISSION = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  heightCm: '172.5',
  weightKg: '68.40',
  medicines: [
    { drugName: 'Amoxicillin', drugClass: 'antibiotic', dosageValue: '500', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 5, quantityPrescribed: 15 },
    { drugName: 'Roxithromycin', drugClass: 'antibiotic', dosageValue: '150', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 5, quantityPrescribed: 10 },
  ],
});

let pool;
let server;
let baseUrl;
let aiMode;
let inFlight = 0;
let maxInFlight = 0;
const statements = [];
const aiCalls = [];
const spies = {};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts every SQL statement sent through the pool; everything else passes straight through. */
function countingPool(target) {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (key === 'execute' || key === 'query') {
        return (sql, params) => {
          statements.push(typeof sql === 'string' ? sql : sql.sql);
          return value.call(object, sql, params);
        };
      }
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** The AI service, per drug: 'ok' (default), 'refused', 'http500', or 'hang' (only the client's timeout ends it). */
async function aiServiceStub(url, init) {
  const payload = JSON.parse(init.body);
  aiCalls.push(payload);
  const mode = aiMode[payload.drugName] ?? 'ok';
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (mode === 'hang') {
      return await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    await delay(50); // keep calls in flight long enough to observe that they overlap
    if (mode === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'http500') return new Response('internal error', { status: 500 });
    const body = RESPONSES[payload.drugName] ?? { risk_score: 5, risk_band: 'low', reasons: [] };
    return new Response(JSON.stringify({ ...body, details: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } finally {
    inFlight -= 1;
  }
}

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  const appPool = countingPool(pool);
  const payloadBuilder = createScoringPayloadBuilder(appPool);
  const realClient = createScoreClient(appPool, { payloadBuilder, fetchImpl: aiServiceStub, baseUrl: 'http://ai.test', timeoutMs: AI_TIMEOUT_MS });
  spies.scorePayloadViaAI = jest.fn(realClient.scorePayloadViaAI);
  spies.scorePrescriptionViaAI = jest.fn(realClient.scorePrescriptionViaAI);
  const realScorer = createMedicineScorer(appPool, {
    payloadBuilder,
    scoreClient: { scorePayloadViaAI: spies.scorePayloadViaAI, scorePrescriptionViaAI: spies.scorePrescriptionViaAI },
  });
  spies.buildSharedContext = jest.fn(realScorer.buildSharedContext);
  spies.scoreAllMedicines = jest.fn(realScorer.scoreAllMedicines);

  server = createApp({ pool: appPool, medicineScorer: { buildSharedContext: spies.buildSharedContext, scoreAllMedicines: spies.scoreAllMedicines } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  aiMode = {};
  maxInFlight = 0;
  statements.length = 0;
  aiCalls.length = 0;
  jest.clearAllMocks();
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const count = (pattern) => statements.filter((sql) => pattern.test(sql)).length;

async function allRowCounts() {
  const [tables] = await pool.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [TEST_DB_NAME]);
  const counts = {};
  for (const { name } of tables) {
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    counts[name] = n;
  }
  return counts;
}

// ── 1. call counts ──────────────────────────────────────────────────────────────────────────────────────────

test('assess-risk, 2 medicines: patient velocity ONCE; duplication, both rarities and the AI service exactly twice — concurrently', async () => {
  const before = await allRowCounts();

  const result = await call('POST', '/api/prescriptions/assess-risk', SUBMISSION);

  expect(result.status).toBe(200);
  expect({
    velocity: count(SQL.velocity),
    legacyVelocity: count(SQL.legacyVelocity),
    duplication: count(SQL.duplication),
    providerRarity: count(SQL.providerRarity),
    drugRarity: count(SQL.drugRarity),
    aiHttpCalls: aiCalls.length,
  }).toEqual({ velocity: 1, legacyVelocity: 0, duplication: 2, providerRarity: 2, drugRarity: 2, aiHttpCalls: 2 });
  expect(spies.scoreAllMedicines).toHaveBeenCalledTimes(1);
  expect(spies.scorePayloadViaAI).toHaveBeenCalledTimes(2);
  expect(spies.scorePrescriptionViaAI).not.toHaveBeenCalled();
  expect(maxInFlight).toBe(2); // both AI calls were in flight at the same time

  // Two antibiotics on one prescription: the live duplication flag reached both payloads.
  expect(aiCalls.map((payload) => [payload.drugName, payload.drugCombinationFlag])).toEqual([['Amoxicillin', true], ['Roxithromycin', true]]);
  expect(result.body.medicines).toEqual([
    { medicineIndex: 0, drugName: 'Amoxicillin', riskScore: 25, riskBand: 'low', reasons: RESPONSES.Amoxicillin.reasons },
    { medicineIndex: 1, drugName: 'Roxithromycin', riskScore: 45, riskBand: 'review', reasons: RESPONSES.Roxithromycin.reasons },
  ]);
  expect(typeof result.body.previewToken).toBe('string');
  expect(await allRowCounts()).toEqual(before); // assessment writes nothing
});

// ── 2. one medicine's failure ───────────────────────────────────────────────────────────────────────────────

describe("one medicine's AI failure never takes down the assessment", () => {
  test.each([
    ['connection refused', 'refused'],
    ['HTTP 500', 'http500'],
    ['timeout', 'hang'],
  ])('%s for Roxithromycin → Roxithromycin is "unavailable", Amoxicillin keeps its real score', async (_label, mode) => {
    aiMode = { Roxithromycin: mode };

    const result = await call('POST', '/api/prescriptions/assess-risk', SUBMISSION);

    expect(result.status).toBe(200);
    expect(result.body.medicines).toEqual([
      { medicineIndex: 0, drugName: 'Amoxicillin', riskScore: 25, riskBand: 'low', reasons: RESPONSES.Amoxicillin.reasons },
      { medicineIndex: 1, drugName: 'Roxithromycin', riskScore: null, riskBand: 'unavailable', reasons: [AI_RISK_UNAVAILABLE_REASON] },
    ]);
    expect(AI_RISK_UNAVAILABLE_REASON).toEqual({ source: 'system', feature: 'ai_service', explanation: 'AI risk assessment was unavailable at this time.' });
  });

  test('service hung for BOTH medicines → both unavailable after ONE timeout, not two (the calls are concurrent)', async () => {
    aiMode = { Amoxicillin: 'hang', Roxithromycin: 'hang' };
    const started = Date.now();

    const result = await call('POST', '/api/prescriptions/assess-risk', SUBMISSION);

    const elapsed = Date.now() - started;
    expect(result.body.medicines.map((m) => [m.drugName, m.riskBand])).toEqual([['Amoxicillin', 'unavailable'], ['Roxithromycin', 'unavailable']]);
    expect(elapsed).toBeGreaterThanOrEqual(AI_TIMEOUT_MS - 25);
    expect(elapsed).toBeLessThan(2 * AI_TIMEOUT_MS); // sequential calls would take at least 2 × timeout
  });
});

// ── 3. confirm-and-create locks exactly what was assessed ───────────────────────────────────────────────────

test('confirm-and-create locks EXACTLY the assessed results (a real score and an unavailable one) and never scores again', async () => {
  aiMode = { Roxithromycin: 'refused' };
  const assessed = await call('POST', '/api/prescriptions/assess-risk', SUBMISSION);
  const before = await allRowCounts();
  statements.length = 0;
  aiCalls.length = 0;
  jest.clearAllMocks();

  const confirmed = await call('POST', '/api/prescriptions/confirm-and-create', { previewToken: assessed.body.previewToken });

  expect(confirmed.status).toBe(201);
  // Nothing was re-scored or re-derived: no AI call, no scorer call, no live-data query.
  expect(aiCalls).toEqual([]);
  for (const spy of ['scoreAllMedicines', 'buildSharedContext', 'scorePayloadViaAI', 'scorePrescriptionViaAI']) expect(spies[spy]).not.toHaveBeenCalled();
  expect([SQL.velocity, SQL.legacyVelocity, SQL.duplication, SQL.providerRarity, SQL.drugRarity].map(count)).toEqual([0, 0, 0, 0, 0]);

  // Exactly one prescription: 1 version (with its hashes), 2 medicines, 1 ledger entry.
  const after = await allRowCounts();
  expect(after).toEqual({ ...before, prescription_version: before.prescription_version + 1, prescription_medicine: before.prescription_medicine + 2, ledger_entry: before.ledger_entry + 1 });

  const row = await createPrescriptionVersionRepository(pool).getLatestVersion(confirmed.body.prescriptionId);
  expect(row.medicines.map((m) => [m.sequence_number, m.drug_name, m.locked_risk_score, m.locked_risk_band, m.locked_risk_reasons])).toEqual([
    [1, 'Amoxicillin', '25.00', 'low', RESPONSES.Amoxicillin.reasons],
    [2, 'Roxithromycin', null, 'unavailable', [AI_RISK_UNAVAILABLE_REASON]],
  ]);
  expect(confirmed.body.medicines.map((m) => m.lockedRisk)).toEqual(assessed.body.medicines.map(({ riskScore, riskBand, reasons }) => ({ riskScore, riskBand, reasons })));

  // The unavailable lock is permanent too.
  await expect(pool.execute("UPDATE prescription_medicine SET locked_risk_score = 10, locked_risk_band = 'low' WHERE medicine_id = ?", [row.medicines[1].medicine_id])).rejects.toMatchObject({ sqlState: '45000' });
  // The client can't send prescription data or risk results alongside the token.
  expect(await call('POST', '/api/prescriptions/confirm-and-create', { previewToken: 'x', confirmedRiskResults: [] })).toMatchObject({ status: 400, body: { reason: 'FIELD_NOT_ALLOWED' } });
});

test('the repository refuses an inconsistent unavailable lock before writing anything', async () => {
  const repository = createPrescriptionVersionRepository(pool);
  const before = await allRowCounts();
  const data = { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [SUBMISSION.medicines[0]] };
  await expect(repository.createPrescription(data, { lockedRisks: [{ riskScore: 12, riskBand: 'unavailable', reasons: [AI_RISK_UNAVAILABLE_REASON] }] })).rejects.toMatchObject({ code: 'INVALID_LOCKED_RISK' });
  await expect(repository.createPrescription(data, { lockedRisks: [{ riskScore: null, riskBand: 'low', reasons: [] }] })).rejects.toMatchObject({ code: 'INVALID_LOCKED_RISK' });
  expect(await allRowCounts()).toEqual(before);
});

// ── 4. atomicity ────────────────────────────────────────────────────────────────────────────────────────────

test('a forced failure partway through createPrescription rolls back everything: no version, medicines, locked risk, hashes or ledger entry', async () => {
  // Medicine 2's INSERT fails — AFTER the ledger entry, the version row (with its hashes) and medicine 1 were written.
  const withTrap = { ...SUBMISSION, medicines: [SUBMISSION.medicines[0], { ...SUBMISSION.medicines[1], drugName: 'Rollbackomycin' }] };
  const assessed = await call('POST', '/api/prescriptions/assess-risk', withTrap);
  expect(assessed.status).toBe(200);

  const autoIncrement = async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET SESSION information_schema_stats_expiry = 0');
      const [rows] = await conn.query("SELECT table_name AS name, auto_increment AS next FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('prescription_version', 'prescription_medicine')", [TEST_DB_NAME]);
      return Object.fromEntries(rows.map((r) => [r.name, Number(r.next)]));
    } finally {
      conn.release();
    }
  };

  await pool.query(`CREATE TRIGGER trg_test_force_medicine_insert_failure BEFORE INSERT ON prescription_medicine FOR EACH ROW
    BEGIN
      IF NEW.drug_name = 'Rollbackomycin' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure for the rollback test';
      END IF;
    END`);
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const before = await allRowCounts();
    const [[{ locked: lockedBefore }]] = await pool.query('SELECT COUNT(*) AS locked FROM prescription_medicine WHERE locked_risk_band IS NOT NULL');
    const idsBefore = await autoIncrement();

    const confirmed = await call('POST', '/api/prescriptions/confirm-and-create', { previewToken: assessed.body.previewToken });

    expect(confirmed.status).toBe(500);
    expect(await allRowCounts()).toEqual(before); // no version (so no hashes), no medicine, no ledger entry — in any table
    const [[{ locked: lockedAfter }]] = await pool.query('SELECT COUNT(*) AS locked FROM prescription_medicine WHERE locked_risk_band IS NOT NULL');
    expect(lockedAfter).toBe(lockedBefore); // no locked risk data

    // Proof the failure really was PARTWAY: InnoDB does not roll back AUTO_INCREMENT, and the counters moved — the version
    // row and medicine 1 had been inserted inside the transaction before medicine 2 failed and everything was undone.
    const idsAfter = await autoIncrement();
    expect(idsAfter.prescription_version).toBeGreaterThan(idsBefore.prescription_version);
    expect(idsAfter.prescription_medicine).toBeGreaterThan(idsBefore.prescription_medicine);
  } finally {
    consoleError.mockRestore();
    await pool.query('DROP TRIGGER IF EXISTS trg_test_force_medicine_insert_failure');
  }
});
