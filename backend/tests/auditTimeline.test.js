'use strict';

/**
 * Module 10 Step 2 — getMergedTimeline against a real anchor_rx_test database.
 *
 * Prescriptions, amendments, revocations and ledger anchors are created through the real Module 1/3/4 code paths.
 * Timestamps are then pinned to explicit, closely spaced values so the expected chronological order is known exactly.
 * Scans and trust decisions are inserted as Modules 6/9 write them, with real verification_event_id foreign keys.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createAuditTimeline, AuditTimelineError, EVENT_TYPES } = require('../audit/timeline');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';
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
let getMergedTimeline;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  ({ getMergedTimeline } = createAuditTimeline(pool, { amendmentService }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool); // resets every table (incl. trust_decision_log) and anchors the demo prescriptions first
});

// ── fixture helpers ─────────────────────────────────────────────────────────────────────────────────────────

const at = (hour, minute, second, ms) => new Date(Date.UTC(2026, 8, 15, hour, minute, second, ms));

async function versionRowId(prescriptionId, versionNumber) {
  const [[row]] = await pool.query('SELECT id FROM prescription_version WHERE prescription_id = ? AND version_number = ?', [prescriptionId, versionNumber]);
  return row.id;
}

async function pinVersionTimes(prescriptionId, versionNumber, { createdAt, amendedAt }) {
  await pool.execute('UPDATE prescription_version SET created_at = ?, amended_at = COALESCE(?, amended_at) WHERE prescription_id = ? AND version_number = ?', [
    createdAt,
    amendedAt ?? null,
    prescriptionId,
    versionNumber,
  ]);
}

async function pinAnchoredAt(prescriptionId, versionNumber, anchoredAt) {
  const [res] = await pool.execute('UPDATE ledger_entry SET anchored_at = ? WHERE prescription_id = ? AND version_number = ?', [anchoredAt, prescriptionId, versionNumber]);
  expect(res.affectedRows).toBe(1);
}

/** As Module 6 logs it: referenced by the internal version row id, not the prescription id. */
async function insertScan(prescriptionId, versionNumber, result, timestamp) {
  const rowId = versionNumber === null ? null : await versionRowId(prescriptionId, versionNumber);
  const [inserted] = await pool.execute('INSERT INTO verification_event (prescription_version_id, pharmacy_id, result, `timestamp`) VALUES (?, ?, ?, ?)', [
    rowId,
    PHARMACY_ID,
    result,
    timestamp,
  ]);
  return inserted.insertId;
}

/** As Module 9 logs it: linked to its scan by verification_event_id. */
async function insertDecision({ prescriptionId, versionNumber, eventId, trustDecision, primaryReason, riskScore = null, riskBand = null, decidedAt }) {
  const [inserted] = await pool.execute(
    `INSERT INTO trust_decision_log (prescription_id, version_number, pharmacy_id, verification_event_id, trust_decision, primary_reason, risk_score, risk_band, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [prescriptionId, versionNumber, PHARMACY_ID, eventId, trustDecision, primaryReason, riskScore, riskBand, decidedAt],
  );
  return inserted.insertId;
}

/**
 * 2 versions, 2 ledger anchors, 2 scans, 2 trust decisions — plus a DECOY scan/decision for another prescription
 * one millisecond after ours, which a timestamp-proximity match would wrongly attach.
 *
 *   10:00:00.000  version_created  v1
 *   10:00:00.040  ledger_anchored  v1
 *   10:05:00.000  pharmacy_scan    v1 verified        → decision 10:05:00.030 Dispense
 *   10:10:00.000  version_amended  v2
 *   10:10:00.010  ledger_anchored  v2
 *   10:10:00.020  pharmacy_scan    v1 stale_version   → decision 10:10:00.045 Review (evaluated v2)
 *   (decoy) 10:10:00.021 scan of RX-DEMO-0002 → decision 10:10:00.046
 */
async function buildTwoVersionFixture() {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const rx = v1.prescription_id;
  await amendmentService.amendPrescriptionAuthorized(rx, { medicineId: v1.medicines[0].medicine_id, dosageValue: '650' }, 'PRV-001', 'Pain not controlled at 500 mg');

  await pinVersionTimes(rx, 1, { createdAt: at(10, 0, 0, 0), amendedAt: at(10, 10, 0, 0) });
  await pinVersionTimes(rx, 2, { createdAt: at(10, 10, 0, 0) });
  await pinAnchoredAt(rx, 1, at(10, 0, 0, 40));
  await pinAnchoredAt(rx, 2, at(10, 10, 0, 10));

  const scan1 = await insertScan(rx, 1, 'verified', at(10, 5, 0, 0));
  const decision1 = await insertDecision({
    prescriptionId: rx, versionNumber: 1, eventId: scan1, trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 4, riskBand: 'low', decidedAt: at(10, 5, 0, 30),
  });
  const scan2 = await insertScan(rx, 1, 'stale_version', at(10, 10, 0, 20));
  const decision2 = await insertDecision({
    prescriptionId: rx, versionNumber: 2, eventId: scan2, trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review', decidedAt: at(10, 10, 0, 45),
  });

  const decoyScan = await insertScan('RX-DEMO-0002', 1, 'verified', at(10, 10, 0, 21));
  const decoyDecision = await insertDecision({
    prescriptionId: 'RX-DEMO-0002', versionNumber: 1, eventId: decoyScan, trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 2, riskBand: 'low', decidedAt: at(10, 10, 0, 46),
  });

  return { rx, scan1, scan2, decision1, decision2, decoyScan, decoyDecision };
}

// ── required tests ──────────────────────────────────────────────────────────────────────────────────────────

test('2 versions + 2 anchors + 2 scans + 2 decisions → 6 top-level events in strictly ascending order', async () => {
  const { rx } = await buildTwoVersionFixture();
  const result = await getMergedTimeline(rx);

  expect(result.prescriptionId).toBe(rx);
  expect(result.currentStatus).toBe('active');

  // COUNT ASSERTED: 6. Two version events + two ledger anchors + two pharmacy scans are top-level entries. The two
  // trust decisions are NESTED inside their scan events, so they add no entries: a flat timeline would have 8.
  expect(result.timeline).toHaveLength(6);
  const nestedDecisions = result.timeline.filter((event) => 'trustDecision' in event).length;
  expect(nestedDecisions).toBe(2);
  expect(result.timeline.length + nestedDecisions).toBe(8);

  expect(result.timeline.map((event) => [event.eventType, event.versionNumber])).toEqual([
    ['version_created', 1],
    ['ledger_anchored', 1],
    ['pharmacy_scan', 1],
    ['version_amended', 2],
    ['ledger_anchored', 2],
    ['pharmacy_scan', 1], // the stale scan of v1 happens after v2 exists
  ]);

  const timestamps = result.timeline.map((event) => event.timestamp);
  expect(timestamps.every(Number.isInteger)).toBe(true); // normalized epoch ms, not Dates or strings
  for (let i = 1; i < timestamps.length; i += 1) {
    expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]); // strictly ascending
  }
  expect(timestamps).toEqual([at(10, 0, 0, 0), at(10, 0, 0, 40), at(10, 5, 0, 0), at(10, 10, 0, 0), at(10, 10, 0, 10), at(10, 10, 0, 20)].map((d) => d.getTime()));

  // details come straight from the owning modules
  const [created, anchor1, , amended, anchor2] = result.timeline;
  expect(created.detail).toMatchObject({
    providerId: 'PRV-001',
    status: 'amended',
    medicines: [{ sequenceNumber: 1, drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '500.000', dosageUnit: 'mg', quantityPrescribed: 12 }],
  });
  expect(created.detail).not.toHaveProperty('drugName'); // Module 14: clinical fields live on each medicine
  expect(amended.detail).toMatchObject({
    fromVersion: 1,
    changedFields: [{ medicine: 1, drugName: 'Paracetamol', field: 'dosage_value', old: '500.000', new: '650.000', unit: 'mg' }],
    amendedBy: 'PRV-001',
    reason: 'Pain not controlled at 500 mg',
    status: 'active',
    medicines: [{ sequenceNumber: 1, dosageValue: '650.000' }],
  });

  const [ledgerRows] = await pool.query('SELECT version_number, sequence_number, entry_hash FROM ledger_entry WHERE prescription_id = ? ORDER BY version_number', [rx]);
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM ledger_entry');
  expect(anchor1.detail).toMatchObject({ entryHash: ledgerRows[0].entry_hash, chainPosition: Number(ledgerRows[0].sequence_number) });
  expect(anchor2.detail).toMatchObject({ entryHash: ledgerRows[1].entry_hash, chainPosition: Number(ledgerRows[1].sequence_number) });
  // GLOBAL position: the seeded demo prescriptions were anchored first, so these are not simply 1 and 2
  expect(anchor1.detail.chainPosition).toBeGreaterThan(2);
  expect(anchor2.detail.chainPosition).toBeGreaterThan(anchor1.detail.chainPosition);
  expect(anchor2.detail.chainPosition).toBeLessThanOrEqual(Number(total));
});

test('each scan nests its own trust decision via the verification_event_id FK, never as a separate top-level entry', async () => {
  const { rx, scan1, scan2, decision1, decision2, decoyScan, decoyDecision } = await buildTwoVersionFixture();
  const { timeline, unlinkedTrustDecisions } = await getMergedTimeline(rx);

  const scans = timeline.filter((event) => event.eventType === EVENT_TYPES.PHARMACY_SCAN);
  expect(scans.map((scan) => scan.detail.eventId)).toEqual([scan1, scan2]);

  expect(scans[0].detail).toEqual({ eventId: scan1, pharmacyId: PHARMACY_ID, scanResult: 'verified' });
  expect(scans[0].trustDecision).toEqual({
    decisionId: decision1, trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 4, riskBand: 'low',
    evaluatedVersionNumber: 1, pharmacyId: PHARMACY_ID, decidedAt: at(10, 5, 0, 30).getTime(),
  });
  expect(scans[1].detail).toEqual({ eventId: scan2, pharmacyId: PHARMACY_ID, scanResult: 'stale_version' });
  expect(scans[1].trustDecision).toEqual({
    decisionId: decision2, trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review',
    evaluatedVersionNumber: 2, pharmacyId: PHARMACY_ID, decidedAt: at(10, 10, 0, 45).getTime(),
  });

  // The nesting agrees with the FK in the database.
  const [links] = await pool.query('SELECT decision_id, verification_event_id FROM trust_decision_log WHERE decision_id IN (?, ?) ORDER BY decision_id', [decision1, decision2]);
  expect(links.map((row) => [row.decision_id, row.verification_event_id])).toEqual([[decision1, scan1], [decision2, scan2]]);

  // NOT a separate top-level entry: only the five event types exist, every entry has exactly the contract keys,
  // and no decision identifier appears anywhere except inside a scan's trustDecision.
  expect(timeline.every((event) => Object.values(EVENT_TYPES).includes(event.eventType))).toBe(true);
  for (const event of timeline) {
    const expectedKeys = ['eventType', 'versionNumber', 'timestamp', 'detail', ...('trustDecision' in event ? ['trustDecision'] : [])];
    expect(Object.keys(event).sort()).toEqual(expectedKeys.sort());
    expect(event.detail).not.toHaveProperty('decisionId');
    if (event.eventType !== EVENT_TYPES.PHARMACY_SCAN) expect(event).not.toHaveProperty('trustDecision');
  }
  const topLevelDecisionIds = timeline.flatMap((event) => [event.decisionId, event.detail.decisionId]).filter((id) => id !== undefined);
  expect(topLevelDecisionIds).toEqual([]);

  // The decoy (another prescription, 1 ms away) is neither on the timeline nor attached to our scan.
  expect(scans.some((scan) => scan.detail.eventId === decoyScan)).toBe(false);
  expect(scans.map((scan) => scan.trustDecision.decisionId)).not.toContain(decoyDecision);
  expect(unlinkedTrustDecisions).toEqual([]);
});

// ── additional coverage ─────────────────────────────────────────────────────────────────────────────────────

test('a revoked chain produces version_revoked with Module 3 revocation detail, and currentStatus "revoked"', async () => {
  const v1 = await repository.createPrescription(withMedicine({ drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400' }));
  await amendmentService.revokePrescription(v1.prescription_id, 'PRV-001', 'Patient reported NSAID sensitivity');

  const { currentStatus, timeline } = await getMergedTimeline(v1.prescription_id);

  expect(currentStatus).toBe('revoked');
  const revokedEvent = timeline.find((event) => event.eventType === EVENT_TYPES.VERSION_REVOKED);
  expect(revokedEvent).toMatchObject({
    versionNumber: 2,
    detail: { fromVersion: 1, revoked: true, revokedBy: 'PRV-001', revokedReason: 'Patient reported NSAID sensitivity' },
  });
  expect(timeline.filter((event) => event.eventType === EVENT_TYPES.VERSION_AMENDED)).toEqual([]);
  // First VERSION event is the creation. (Not timeline[0]: this test doesn't pin created_at, and the ledger's anchored_at
  // (Node clock, stamped just before the INSERT) can read 1 ms earlier than created_at (MySQL clock) — a Module 4 property.)
  expect(timeline.filter((event) => event.eventType !== EVENT_TYPES.LEDGER_ANCHORED).map((event) => event.eventType)).toEqual([
    EVENT_TYPES.VERSION_CREATED,
    EVENT_TYPES.VERSION_REVOKED,
  ]);
  const timestamps = timeline.map((event) => event.timestamp);
  expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
});

test('currentStatus comes from the latest version in the chain (dispensed)', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  await pool.execute("UPDATE prescription_version SET status = 'dispensed' WHERE id = ?", [v1.id]);
  expect((await getMergedTimeline(v1.prescription_id)).currentStatus).toBe('dispensed');
});

test('events sharing a millisecond are ordered deterministically: version → ledger anchor → scan', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const rx = v1.prescription_id;
  const same = at(9, 0, 0, 500);
  await insertScan(rx, 1, 'verified', same); // inserted first on purpose
  await pinAnchoredAt(rx, 1, same);
  await pinVersionTimes(rx, 1, { createdAt: same });

  const first = await getMergedTimeline(rx);
  expect(first.timeline.map((event) => event.eventType)).toEqual(['version_created', 'ledger_anchored', 'pharmacy_scan']);
  expect(first.timeline.every((event) => event.timestamp === same.getTime())).toBe(true);
  expect((await getMergedTimeline(rx)).timeline).toEqual(first.timeline);
});

test('a scan without a trust decision simply has no trustDecision key', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const eventId = await insertScan(v1.prescription_id, 1, 'verified', at(11, 0, 0, 0));
  const scan = (await getMergedTimeline(v1.prescription_id)).timeline.find((event) => event.eventType === EVENT_TYPES.PHARMACY_SCAN);
  expect(scan.detail.eventId).toBe(eventId);
  expect(scan).not.toHaveProperty('trustDecision');
});

test('a decision whose scan cannot be joined to a version (e.g. unknown version) is surfaced as unlinked, not dropped', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const rx = v1.prescription_id;
  const orphanScan = await insertScan(rx, null, 'unknown_prescription', at(12, 0, 0, 0)); // scanned a non-existent v9
  const orphanDecision = await insertDecision({ prescriptionId: rx, versionNumber: 9, eventId: orphanScan, trustDecision: 'Block', primaryReason: 'unknown_prescription', decidedAt: at(12, 0, 0, 5) });

  const { timeline, unlinkedTrustDecisions } = await getMergedTimeline(rx);
  expect(timeline.some((event) => event.eventType === EVENT_TYPES.PHARMACY_SCAN)).toBe(false);
  expect(unlinkedTrustDecisions).toEqual([
    expect.objectContaining({ decisionId: orphanDecision, verificationEventId: orphanScan, trustDecision: 'Block', primaryReason: 'unknown_prescription', evaluatedVersionNumber: 9 }),
  ]);
});

test('two trust decisions for one scan is an integrity problem and throws', async () => {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  const rx = v1.prescription_id;
  const eventId = await insertScan(rx, 1, 'verified', at(13, 0, 0, 0));
  for (const ms of [10, 20]) {
    await insertDecision({ prescriptionId: rx, versionNumber: 1, eventId, trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 1, riskBand: 'low', decidedAt: at(13, 0, 0, ms) });
  }
  await expect(getMergedTimeline(rx)).rejects.toMatchObject({ name: 'AuditTimelineError', code: 'DUPLICATE_TRUST_DECISION' });
});

test('unknown or invalid prescription ids are rejected', async () => {
  await expect(getMergedTimeline('RX-NOPE-0001')).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  await expect(getMergedTimeline('')).rejects.toBeInstanceOf(AuditTimelineError);
  await expect(getMergedTimeline(undefined)).rejects.toMatchObject({ code: 'INVALID_PRESCRIPTION_ID' });
});
