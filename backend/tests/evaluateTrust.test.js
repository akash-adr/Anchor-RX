'use strict';

/**
 * Module 9 completion gate — evaluateTrust orchestration.
 *
 * The behavioural guarantee under test: the AI risk model is NEVER invoked once integrity has failed. Checking only
 * the final decision is not enough — an implementation that called the scorer and ignored the answer would still
 * return Block — so every integrity-failure test asserts the scorer spy was called ZERO times.
 *
 * Mocked: Module 6's verifyScan and the AI score client (orchestration tests, not a live Python integration).
 * Real: anchor_rx_test. The mocked verifyScan logs a genuine verification_event row, exactly as Module 6 does, so
 * trust_decision_log.verification_event_id links are real and FK-checked. The database is reseeded before every test.
 *
 * Run:  npx jest backend/tests/evaluateTrust.test.js --verbose
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createTrustEvaluator } = require('../trust/evaluateTrust');
const { AIServiceError } = require('../ml/scoreClient');
const { TrustDecisionError } = require('../trust/decideTrust');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';
const RX = 'RX-DEMO-0001'; // seeded with versions 1 (amended) and 2 (active)
const RAW_QR = '{"prescriptionId":"RX-DEMO-0001","versionNumber":2,"issuedAt":"2026-09-15T00:00:00.000Z"}';

let pool;
let versionRowIds; // version_number → prescription_version.id for RX

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  const [rows] = await pool.query('SELECT id, version_number FROM prescription_version WHERE prescription_id = ?', [RX]);
  versionRowIds = Object.fromEntries(rows.map((row) => [row.version_number, row.id]));
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

const VALID_FIELDS = { valid: true, tamperedFields: [], integrityRootMatch: true };
const VALID_LEDGER = { anchored: true, integrityRootMatch: true, chainIntact: true };
const NO_CHECKS = { fieldVerification: null, ledgerVerification: null, providerStatus: null, currentActiveVersion: null };

/** verifyScan result shapes per branch, as Module 6 produces them. loggedVersion = which version row the event references. */
const SCANS = {
  malformed_qr: { fields: { prescriptionId: null, versionNumber: null, ...NO_CHECKS }, loggedVersion: null },
  unknown_prescription: { fields: { prescriptionId: 'RX-NOPE-0001', versionNumber: 1, ...NO_CHECKS }, loggedVersion: null },
  provider_identity_issue: { fields: { prescriptionId: RX, versionNumber: 2, ...NO_CHECKS, providerStatus: 'flagged' }, loggedVersion: 2 },
  tampered: {
    fields: {
      prescriptionId: RX, versionNumber: 2, providerStatus: 'active', currentActiveVersion: null, ledgerVerification: null,
      fieldVerification: { valid: false, tamperedFields: ['dosage_value'], integrityRootMatch: false },
    },
    loggedVersion: 2,
  },
  forged: {
    fields: {
      prescriptionId: RX, versionNumber: 2, providerStatus: 'active', currentActiveVersion: null, fieldVerification: VALID_FIELDS,
      ledgerVerification: { anchored: true, integrityRootMatch: false, chainIntact: true },
    },
    loggedVersion: 2,
  },
  revoked: {
    fields: { prescriptionId: RX, versionNumber: 2, providerStatus: 'active', currentActiveVersion: null, fieldVerification: VALID_FIELDS, ledgerVerification: VALID_LEDGER },
    loggedVersion: 2,
  },
  verified: {
    fields: { prescriptionId: RX, versionNumber: 2, providerStatus: 'active', currentActiveVersion: 2, fieldVerification: VALID_FIELDS, ledgerVerification: VALID_LEDGER },
    loggedVersion: 2,
  },
  stale_version: {
    fields: { prescriptionId: RX, versionNumber: 1, providerStatus: 'active', currentActiveVersion: 3, fieldVerification: VALID_FIELDS, ledgerVerification: VALID_LEDGER },
    loggedVersion: 1,
  },
};

/** A mocked verifyScan that behaves like Module 6: logs one verification_event and returns its eventId. */
function mockVerifyScan(scanResult, overrides = {}) {
  const template = SCANS[scanResult];
  return jest.fn(async (_rawScanData, pharmacyId) => {
    const scannedAt = new Date();
    let eventId = null;
    if (template) {
      const versionRowId = template.loggedVersion === null ? null : versionRowIds[template.loggedVersion];
      const [inserted] = await pool.execute(
        'INSERT INTO verification_event (prescription_version_id, pharmacy_id, result, `timestamp`) VALUES (?, ?, ?, ?)',
        [versionRowId, pharmacyId, scanResult, scannedAt],
      );
      eventId = inserted.insertId;
    }
    return { scanResult, ...(template ? template.fields : NO_CHECKS), scannedAt, eventId, ...overrides };
  });
}

const REASONS = [{ source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' }];

function riskResult(riskBand, riskScore) {
  return {
    riskScore,
    riskBand,
    reasons: REASONS,
    details: { mlSubscore: 10, ruleSubscore: 0, rulesNotEvaluated: [], patientWeightIsDefault: false, modelVersion: 'test-model' },
  };
}

/**
 * A spied score client. `spy` counts calls to scorePrescriptionViaAI; the Proxy additionally records every property
 * lookup on the client, so a test can prove the method was never even looked up.
 */
function spyScoreClient(implementation) {
  const accessed = [];
  const target = { scorePrescriptionViaAI: jest.fn(implementation) };
  const scoreClient = new Proxy(target, {
    get(obj, property, receiver) {
      accessed.push(String(property));
      return Reflect.get(obj, property, receiver);
    },
  });
  return { scoreClient, spy: target.scorePrescriptionViaAI, accessed };
}

async function decisionRowCount() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM trust_decision_log');
  return Number(n);
}

/**
 * Runs evaluateTrust and asserts set 7's audit guarantee for that call: exactly ONE new trust_decision_log row whose
 * decision fields match the returned decision and whose verification_event_id is the scan's eventId.
 */
async function evaluateExpectingOneDecisionRow({ verifyScan, scoreClient }) {
  const { evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification: { verifyScan }, scoreClient });

  const before = await decisionRowCount();
  const decision = await evaluateTrust(RAW_QR, PHARMACY_ID);
  const after = await decisionRowCount();

  expect(verifyScan).toHaveBeenCalledTimes(1);
  expect(verifyScan).toHaveBeenCalledWith(RAW_QR, PHARMACY_ID);
  const scan = await verifyScan.mock.results[0].value;

  const [[row]] = await pool.query(
    `SELECT d.*, v.result AS event_result, v.prescription_version_id AS event_version_row_id
       FROM trust_decision_log d
  LEFT JOIN verification_event v ON v.event_id = d.verification_event_id
      ORDER BY d.decision_id DESC LIMIT 1`,
  );

  expect(after - before).toBe(1);
  expect(row).toMatchObject({
    trust_decision: decision.trustDecision,
    primary_reason: decision.primaryReason,
    risk_score: decision.riskScore,
    risk_band: decision.riskBand,
    pharmacy_id: PHARMACY_ID,
    prescription_id: scan.prescriptionId,
    verification_event_id: scan.eventId,
    event_result: scan.scanResult, // the linked verification_event is the scan this decision was computed from
  });
  expect(row.decided_at.getTime()).toBe(Date.parse(decision.decidedAt));

  return { decision, row, scan };
}

// ── set 1 ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('set 1 — integrity failures never reach the AI risk model', () => {
  const INTEGRITY_FAILURES = ['tampered', 'forged', 'provider_identity_issue', 'unknown_prescription', 'malformed_qr'];

  async function expectBlockWithoutScoring(scanResult) {
    // If asked, this scorer would return a clean "low" risk. A call-and-ignore bug would therefore still yield the
    // correct Block — which is exactly why assertion (b) below, not (a), is the point of this test.
    const { scoreClient, spy, accessed } = spyScoreClient(async () => riskResult('low', 1));

    const { decision, row, scan } = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan(scanResult), scoreClient });

    // (a) the decision
    expect(decision).toMatchObject({ trustDecision: 'Block', primaryReason: scanResult, scanResult, riskScore: null, riskBand: null });
    expect(decision.supportingDetail.riskReasons).toBeNull();
    expect(decision.supportingDetail.riskEngine).toEqual({ status: 'not_consulted' });

    // (b) THE GUARANTEE: the risk model was never invoked — zero calls, and the method was never even looked up.
    expect(spy).toHaveBeenCalledTimes(0);
    expect(accessed).toEqual([]);

    expect(row.version_number).toBe(scan.versionNumber);
    expect(row.risk_score).toBeNull();
    expect(row.risk_band).toBeNull();
  }

  test.each(INTEGRITY_FAILURES)('%s → Block, and scorePrescriptionViaAI is called ZERO times', expectBlockWithoutScoring);

  test.each(['revoked'])('%s (added in Step 1) → Block, and scorePrescriptionViaAI is called ZERO times', expectBlockWithoutScoring);

  test('an unrecognised future scan result never reaches the scorer either: it throws and logs no decision', async () => {
    const { scoreClient, spy, accessed } = spyScoreClient(async () => riskResult('low', 1));
    const { evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification: { verifyScan: mockVerifyScan('quarantined') }, scoreClient });

    await expect(evaluateTrust(RAW_QR, PHARMACY_ID)).rejects.toThrow(TrustDecisionError);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(accessed).toEqual([]);
    expect(await decisionRowCount()).toBe(0);
  });
});

// ── sets 2–4 ────────────────────────────────────────────────────────────────────────────────────────────────

describe('sets 2–4 — verified scans are decided by the risk band of the scanned version', () => {
  async function verifiedWith(riskBand, riskScore) {
    const { scoreClient, spy } = spyScoreClient(async () => riskResult(riskBand, riskScore));
    const outcome = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan('verified'), scoreClient });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(RX, 2);
    expect(outcome.decision.supportingDetail.riskReasons).toEqual(REASONS);
    expect(outcome.decision.supportingDetail.riskEngine).toEqual({ status: 'consulted', evaluatedVersionNumber: 2, modelVersion: 'test-model' });
    expect(outcome.row.version_number).toBe(2);
    return outcome;
  }

  test('2. verified + risk "low" → Dispense', async () => {
    const { decision, row } = await verifiedWith('low', 12);
    expect(decision).toMatchObject({ trustDecision: 'Dispense', primaryReason: 'clean', scanResult: 'verified', riskScore: 12, riskBand: 'low' });
    expect(row).toMatchObject({ risk_score: 12, risk_band: 'low' });
  });

  test('3. verified + risk "review" → Review', async () => {
    const { decision } = await verifiedWith('review', 45);
    expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review' });
  });

  // REGRESSION GUARD (through the full orchestration path): "high" must stay Review, never Block. The risk engine
  // flags unusual-but-authentic prescriptions for human judgment; it must not override a verified doctor's decision.
  test('4. verified + risk "high" → Review, NOT Block', async () => {
    const { decision, row } = await verifiedWith('high', 88);
    expect(decision.trustDecision).toBe('Review');
    expect(decision.trustDecision).not.toBe('Block');
    expect(decision).toMatchObject({ primaryReason: 'highRiskScore', riskScore: 88, riskBand: 'high' });
    expect(row.trust_decision).toBe('Review');
  });
});

// ── set 5 ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('set 5 — stale_version scores the CURRENT active version, not the stale one', () => {
  test('5. scanned v1 with current active v3 → scorer called with version 3, never 1', async () => {
    const { scoreClient, spy } = spyScoreClient(async () => riskResult('low', 7));
    const { decision, row, scan } = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan('stale_version'), scoreClient });

    expect(scan).toMatchObject({ versionNumber: 1, currentActiveVersion: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(RX, 3);
    expect(spy).not.toHaveBeenCalledWith(RX, 1);
    expect(spy.mock.calls[0][1]).toBe(3);

    expect(decision).toMatchObject({ trustDecision: 'Dispense', primaryReason: 'clean', scanResult: 'stale_version', riskScore: 7, riskBand: 'low' });
    expect(decision.supportingDetail.riskEngine.evaluatedVersionNumber).toBe(3);
    expect(row.version_number).toBe(3); // the version actually evaluated…
    expect(row.event_version_row_id).toBe(versionRowIds[1]); // …while the linked scan event still references the scanned v1
  });
});

// ── set 6 ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('set 6 — AI service down → Review "riskEngineUnavailable", never Dispense, never a crash', () => {
  test.each(['network', 'timeout', 'http_status', 'invalid_response'])('6. verified scan, scorer rejects with AIServiceError (%s)', async (reason) => {
    const { scoreClient, spy } = spyScoreClient(async () => {
      throw new AIServiceError(reason, `simulated ${reason} failure`, { status: reason === 'http_status' ? 503 : null });
    });

    const { decision, row } = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan('verified'), scoreClient });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'riskEngineUnavailable', riskScore: null, riskBand: null });
    expect(decision.trustDecision).not.toBe('Dispense');
    expect(decision.supportingDetail.riskReasons).toBeNull();
    expect(decision.supportingDetail.riskEngine).toEqual({
      status: 'unavailable',
      evaluatedVersionNumber: 2,
      errorCode: 'AI_SERVICE_UNAVAILABLE',
      reason,
    });
    expect(row).toMatchObject({ trust_decision: 'Review', primary_reason: 'riskEngineUnavailable', risk_score: null, risk_band: null, version_number: 2 });
  });

  test('6. the outage does not surface as an exception to the caller (resolves, not rejects)', async () => {
    const { scoreClient } = spyScoreClient(async () => {
      throw new AIServiceError('network', 'AI service unreachable (ECONNREFUSED)');
    });
    const { evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification: { verifyScan: mockVerifyScan('verified') }, scoreClient });
    await expect(evaluateTrust(RAW_QR, PHARMACY_ID)).resolves.toMatchObject({ trustDecision: 'Review', primaryReason: 'riskEngineUnavailable' });
  });

  test('6. stale_version during an outage also degrades to Review, having tried the current version', async () => {
    const { scoreClient, spy } = spyScoreClient(async () => {
      throw new AIServiceError('timeout', 'simulated timeout');
    });
    const { decision, row } = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan('stale_version'), scoreClient });
    expect(spy).toHaveBeenCalledWith(RX, 3);
    expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'riskEngineUnavailable', scanResult: 'stale_version' });
    expect(row.version_number).toBe(3);
  });

  test('a non-AI failure is NOT disguised as an outage: it propagates and no decision is logged', async () => {
    const { scoreClient } = spyScoreClient(async () => {
      throw new Error('ER_LOCK_WAIT_TIMEOUT: simulated database failure while building the payload');
    });
    const { evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification: { verifyScan: mockVerifyScan('verified') }, scoreClient });
    await expect(evaluateTrust(RAW_QR, PHARMACY_ID)).rejects.toThrow('ER_LOCK_WAIT_TIMEOUT');
    expect(await decisionRowCount()).toBe(0);
  });
});

// ── set 7 ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('set 7 — every evaluateTrust call writes exactly one linked trust_decision_log row', () => {
  test('7. all scenarios in one run: one row per call, each linked to its own scan event', async () => {
    const outage = async () => {
      throw new AIServiceError('network', 'simulated outage');
    };
    const scenarios = [
      { scanResult: 'tampered', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'tampered', scorerCalls: 0 },
      { scanResult: 'forged', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'forged', scorerCalls: 0 },
      { scanResult: 'provider_identity_issue', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'provider_identity_issue', scorerCalls: 0 },
      { scanResult: 'unknown_prescription', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'unknown_prescription', scorerCalls: 0 },
      { scanResult: 'malformed_qr', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'malformed_qr', scorerCalls: 0 },
      { scanResult: 'revoked', scorer: async () => riskResult('low', 1), decision: 'Block', reason: 'revoked', scorerCalls: 0 },
      { scanResult: 'verified', scorer: async () => riskResult('low', 5), decision: 'Dispense', reason: 'clean', scorerCalls: 1 },
      { scanResult: 'verified', scorer: async () => riskResult('review', 50), decision: 'Review', reason: 'reviewRiskScore', scorerCalls: 1 },
      { scanResult: 'verified', scorer: async () => riskResult('high', 90), decision: 'Review', reason: 'highRiskScore', scorerCalls: 1 },
      { scanResult: 'stale_version', scorer: async () => riskResult('low', 3), decision: 'Dispense', reason: 'clean', scorerCalls: 1 },
      { scanResult: 'verified', scorer: outage, decision: 'Review', reason: 'riskEngineUnavailable', scorerCalls: 1 },
    ];

    const eventIds = [];
    for (const scenario of scenarios) {
      const { scoreClient, spy } = spyScoreClient(scenario.scorer);
      const { decision, row, scan } = await evaluateExpectingOneDecisionRow({ verifyScan: mockVerifyScan(scenario.scanResult), scoreClient });
      expect([decision.trustDecision, decision.primaryReason]).toEqual([scenario.decision, scenario.reason]);
      expect([row.trust_decision, row.primary_reason]).toEqual([scenario.decision, scenario.reason]);
      expect(spy).toHaveBeenCalledTimes(scenario.scorerCalls);
      eventIds.push(scan.eventId);
    }

    const [rows] = await pool.query('SELECT verification_event_id, trust_decision, primary_reason FROM trust_decision_log ORDER BY decision_id');
    expect(rows).toHaveLength(scenarios.length);
    expect(rows.map((row) => row.verification_event_id)).toEqual(eventIds);
    expect(new Set(eventIds).size).toBe(scenarios.length);
    expect(rows.map((row) => [row.trust_decision, row.primary_reason])).toEqual(scenarios.map((s) => [s.decision, s.reason]));
  });
});
