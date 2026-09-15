'use strict';

/**
 * Module 10 Step 3 — live integrity recheck and the audit summary list, against anchor_rx_test.
 * History (scans, trust decisions) is produced by the REAL Module 6 / Module 9 code before any tampering, so the
 * difference between "what was recorded then" and "what is true now" is genuinely exercised.
 */

const crypto = require('crypto');
const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createLedgerService } = require('../ledger/ledgerService');
const { createPharmacyVerification } = require('../qr/pharmacyVerification');
const { generateQrPayload } = require('../qr/qrEngine');
const { createTrustEvaluator } = require('../trust/evaluateTrust');
const { createIntegrityRecheck, isIntegrityIntact, AuditRecheckError } = require('../audit/recheck');
const { createAuditSummary, AuditSummaryError } = require('../audit/summary');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';
const SEEDED_IDS = ['RX-DEMO-0001', 'RX-DEMO-0002', 'RX-DEMO-0003', 'RX-DEMO-0004'];
// Module 14 input shape: one medicine.
const BASE_RX = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  medicines: Object.freeze([
    Object.freeze({ drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '500', dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 }),
  ]),
});
const withMedicine = (overrides) => ({ ...BASE_RX, medicines: [{ ...BASE_RX.medicines[0], ...overrides }] });

let pool;
let repository;
let amendmentService;
let pharmacyVerification;
let recheckCurrentIntegrity;
let getAuditSummaryList;
let evaluateTrust;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  const ledger = createLedgerService(pool, { repository });
  pharmacyVerification = createPharmacyVerification(pool, { repository, ledger, amendmentService });
  const integrityRecheck = createIntegrityRecheck(pool, { repository, amendmentService, ledger });
  ({ recheckCurrentIntegrity } = integrityRecheck);
  ({ getAuditSummaryList } = createAuditSummary(pool, { integrityRecheck }));
  const lowRiskScorer = { scorePrescriptionViaAI: async () => ({ riskScore: 3, riskBand: 'low', reasons: [], details: null }) };
  ({ evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification, scoreClient: lowRiskScorer }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const qrFor = (row) => JSON.stringify(generateQrPayload(row.prescription_id, row.version_number, row.created_at));

async function tamperDosage(row, value = '5000') {
  // Module 2 demo pattern (Module 14 schema): a raw SQL edit of the first medicine's row, bypassing the application.
  const [res] = await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', [value, row.medicines[0].medicine_id]);
  expect(res.affectedRows).toBe(1);
}

async function countRows(table) {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(n);
}

/** Records every SQL statement sent through the pool while `fn` runs. */
async function recordSql(fn) {
  const spies = [jest.spyOn(pool, 'query'), jest.spyOn(pool, 'execute')];
  const connectionSpy = jest.spyOn(pool, 'getConnection');
  try {
    const result = await fn();
    const statements = spies.flatMap((spy) => spy.mock.calls.map(([sql]) => (typeof sql === 'string' ? sql : sql?.sql ?? '')));
    return { result, statements, connectionsOpened: connectionSpy.mock.calls.length };
  } finally {
    [...spies, connectionSpy].forEach((spy) => spy.mockRestore());
  }
}

// ── recheckCurrentIntegrity ─────────────────────────────────────────────────────────────────────────────────

test('LIVE, not history: tampered after a recorded "verified" scan → the recheck fails while history still says verified', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const rx = v1.prescription_id;

  // 1. History, written by the real Module 6 code BEFORE tampering.
  const scan = await pharmacyVerification.verifyScan(qrFor(v1), PHARMACY_ID);
  expect(scan.scanResult).toBe('verified');

  // 2. Control: the live recheck agrees before tampering, so the later failure is caused by the tampering.
  const beforeTamper = await recheckCurrentIntegrity(rx);
  expect(beforeTamper.fieldVerification).toMatchObject({ valid: true, tamperedFields: [] });
  expect(isIntegrityIntact(beforeTamper)).toBe(true);

  // 3. Tamper.
  await tamperDosage(v1);

  // 4. History is unchanged: the most recent recorded scan for this version still says "verified".
  const [[lastRecordedScan]] = await pool.query(
    'SELECT event_id, result FROM verification_event WHERE prescription_version_id = ? ORDER BY `timestamp` DESC, event_id DESC LIMIT 1',
    [v1.id],
  );
  expect(lastRecordedScan).toEqual({ event_id: scan.eventId, result: 'verified' });

  // 5. The live recheck reflects the data as it is NOW.
  const eventsBefore = await countRows('verification_event');
  const { result: live, statements, connectionsOpened } = await recordSql(() => recheckCurrentIntegrity(rx));

  expect(live.fieldVerification).toMatchObject({ valid: false, tamperedFields: ['medicine_1.dosage_value'] });
  expect(isIntegrityIntact(live)).toBe(false);
  expect(live.version).toEqual({ prescriptionId: rx, versionNumber: 1, status: 'active', basis: 'active_version' });
  expect(Number.isInteger(live.checkedAt)).toBe(true);
  expect(live.checkedAt).toBeGreaterThanOrEqual(beforeTamper.checkedAt);

  // 6. Structurally separate from the historical timeline: never read the history tables, wrote nothing.
  expect(statements.length).toBeGreaterThan(0); // the spy really saw the recheck's queries…
  expect(statements.some((sql) => /prescription_version/.test(sql))).toBe(true);
  expect(statements.some((sql) => /ledger_entry/.test(sql))).toBe(true);
  expect(statements.filter((sql) => /verification_event|trust_decision_log/i.test(sql))).toEqual([]); // …and none touch history
  expect(statements.filter((sql) => /^\s*(insert|update|delete|replace)\b/i.test(sql))).toEqual([]);
  expect(connectionsOpened).toBe(0); // no transactions either
  expect(await countRows('verification_event')).toBe(eventsBefore);
});

test('a forged ledger anchor (fields untouched) is caught by the live ledger verification', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const forgedRoot = crypto.createHash('sha256').update(`forged:${v1.id}`).digest('hex');
  await pool.execute('UPDATE ledger_entry SET integrity_root = ? WHERE ledger_entry_id = ?', [forgedRoot, v1.ledger_anchor_ref]);

  const live = await recheckCurrentIntegrity(v1.prescription_id);
  expect(live.fieldVerification.valid).toBe(true);
  expect(live.ledgerVerification.anchored).toBe(true);
  expect(live.ledgerVerification.integrityRootMatch && live.ledgerVerification.chainIntact).toBe(false);
  expect(isIntegrityIntact(live)).toBe(false);
});

test('a revoked prescription is checked at its latest (revoked) version, and a clean one is intact', async () => {
  const v1 = await repository.createPrescription(withMedicine({ drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400' }));
  await amendmentService.revokePrescription(v1.prescription_id, 'PRV-001', 'Patient reported NSAID sensitivity');

  const live = await recheckCurrentIntegrity(v1.prescription_id);
  expect(live.version).toEqual({ prescriptionId: v1.prescription_id, versionNumber: 2, status: 'revoked', basis: 'latest_version_revoked' });
  expect(live.fieldVerification.valid).toBe(true);
  expect(live.ledgerVerification).toMatchObject({ anchored: true, integrityRootMatch: true, chainIntact: true });
  expect(Number.isInteger(live.ledgerVerification.anchoredAt)).toBe(true);
  expect(isIntegrityIntact(live)).toBe(true);
});

test('unknown and invalid prescription ids are rejected', async () => {
  await expect(recheckCurrentIntegrity('RX-NOPE-0001')).rejects.toMatchObject({ name: 'AuditRecheckError', code: 'PRESCRIPTION_NOT_FOUND' });
  await expect(recheckCurrentIntegrity('')).rejects.toBeInstanceOf(AuditRecheckError);
});

// ── getAuditSummaryList ─────────────────────────────────────────────────────────────────────────────────────

test('summary: latestIntegrityIntact is false for the tampered fixture and true for a clean one', async () => {
  // Tampered fixture: a real scan → Dispense trust decision is recorded while it is still clean, THEN it is tampered.
  const tampered = await repository.createPrescription({ ...BASE_RX });
  const tamperedDecision = await evaluateTrust(qrFor(tampered), PHARMACY_ID);
  expect(tamperedDecision.trustDecision).toBe('Dispense');
  await tamperDosage(tampered);

  // Clean fixture: same history, never tampered.
  const clean = await repository.createPrescription(withMedicine({ drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10' }));
  expect((await evaluateTrust(qrFor(clean), PHARMACY_ID)).trustDecision).toBe('Dispense');

  const rows = await getAuditSummaryList();
  const byId = Object.fromEntries(rows.map((row) => [row.prescriptionId, row]));

  expect(byId[tampered.prescription_id]).toMatchObject({
    currentStatus: 'active',
    lastScan: { result: 'verified', versionNumber: 1 }, // history: it WAS verified…
    lastTrustDecision: { trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 3, riskBand: 'low' },
    latestIntegrityIntact: false, // …live: it is NOT intact now
  });
  expect(byId[clean.prescription_id]).toMatchObject({
    currentStatus: 'active',
    lastScan: { result: 'verified' },
    lastTrustDecision: { trustDecision: 'Dispense' },
    latestIntegrityIntact: true,
  });

  // the nested decision links back to the scan it was computed from
  expect(byId[tampered.prescription_id].lastTrustDecision.verificationEventId).toBe(byId[tampered.prescription_id].lastScan.eventId);
  expect(Number.isInteger(byId[tampered.prescription_id].lastScan.timestamp)).toBe(true);
  expect(Number.isInteger(byId[tampered.prescription_id].integrityCheckedAt)).toBe(true);

  // seeded demo prescriptions (never scanned) are listed, intact, with no history
  for (const id of SEEDED_IDS) {
    expect(byId[id]).toMatchObject({ latestIntegrityIntact: true, lastScan: null, lastTrustDecision: null });
  }
  expect(rows.map((row) => row.prescriptionId)).toEqual([...rows.map((row) => row.prescriptionId)].sort());
});

test('summary filters: onlyConcerning and currentStatus', async () => {
  const tampered = await repository.createPrescription({ ...BASE_RX });
  await tamperDosage(tampered);
  const revoked = await repository.createPrescription(withMedicine({ drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400' }));
  await amendmentService.revokePrescription(revoked.prescription_id, 'PRV-001', 'No longer needed');

  const concerning = await getAuditSummaryList({ onlyConcerning: true });
  expect(concerning.map((row) => row.prescriptionId)).toEqual([tampered.prescription_id]);

  const revokedOnly = await getAuditSummaryList({ currentStatus: 'revoked' });
  expect(revokedOnly.map((row) => [row.prescriptionId, row.currentStatus, row.latestIntegrityIntact])).toEqual([[revoked.prescription_id, 'revoked', true]]);

  expect(await getAuditSummaryList({ currentStatus: 'revoked', onlyConcerning: true })).toEqual([]);
  const active = await getAuditSummaryList({ currentStatus: 'active' });
  expect(active.every((row) => row.currentStatus === 'active')).toBe(true);
  expect(active.map((row) => row.prescriptionId)).toContain(tampered.prescription_id);
});

test.each([
  [{ status: 'active' }],
  [{ currentStatus: 'amended' }],
  [{ onlyConcerning: 'yes' }],
  ['active'],
])('summary rejects invalid filters %p', async (filters) => {
  await expect(getAuditSummaryList(filters)).rejects.toMatchObject({ name: 'AuditSummaryError', code: 'INVALID_FILTERS' });
});
