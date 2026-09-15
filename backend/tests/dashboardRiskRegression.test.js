'use strict';

/**
 * Module 15 Step 6 — the audit dashboards are unaffected.
 *
 * The trust-risk dashboard queries that exist are Module 10's getAuditSummaryList (lastTrustDecision) and
 * getMergedTimeline (a scan's nested trustDecision), plus their HTTP routes; Module 10b is the printable document.
 * (No getImpactCounters / getModelPerformanceSummary exists, and trust_decision_log has no risk_reasons column.)
 *
 * Fixture: a prescription whose medicine is LOCKED at 78/high, scanned, with a trust_decision_log row of 45/review.
 * The dashboards must keep reporting the log's 45/review — in exactly their pre-Module-15 shapes — never the lock.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createApp } = require('../api/server');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAuditSummary } = require('../audit/summary');
const { createAuditTimeline } = require('../audit/timeline');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';
const at = (minute) => new Date(Date.UTC(2026, 8, 15, 11, minute, 0, 0));

let pool;
let server;
let baseUrl;

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
};

async function fixture() {
  const rx = await createPrescriptionVersionRepository(pool).createPrescription(
    { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [{ drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '1000', dosageUnit: 'mg', frequency: 'four times daily', durationDays: 5, quantityPrescribed: 20 }] },
    { lockedRisks: [{ riskScore: 78, riskBand: 'high', reasons: [] }] },
  );
  const [scan] = await pool.execute('INSERT INTO verification_event (prescription_version_id, pharmacy_id, result, `timestamp`) VALUES (?, ?, ?, ?)', [rx.id, PHARMACY_ID, 'verified', at(5)]);
  const [decision] = await pool.execute(
    `INSERT INTO trust_decision_log (prescription_id, version_number, pharmacy_id, verification_event_id, trust_decision, primary_reason, risk_score, risk_band, decided_at)
     VALUES (?, 1, ?, ?, 'Review', 'reviewRiskScore', 45, 'review', ?)`,
    [rx.prescription_id, PHARMACY_ID, scan.insertId, at(6)],
  );
  return { prescriptionId: rx.prescription_id, eventId: scan.insertId, decisionId: decision.insertId };
}

test('audit summary + timeline report trust_decision_log risk (45/review) in unchanged shapes — never the locked 78', async () => {
  const { prescriptionId, eventId, decisionId } = await fixture();

  const expectedSummaryDecision = {
    decisionId, trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review', versionNumber: 1, verificationEventId: eventId, decidedAt: at(6).getTime(),
  };
  const expectedTimelineDecision = {
    decisionId, trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review', evaluatedVersionNumber: 1, pharmacyId: PHARMACY_ID, decidedAt: at(6).getTime(),
  };

  // Module functions
  const summaryRow = (await createAuditSummary(pool).getAuditSummaryList()).find((row) => row.prescriptionId === prescriptionId);
  expect(Object.keys(summaryRow)).toEqual(['prescriptionId', 'currentStatus', 'lastScan', 'lastTrustDecision', 'latestIntegrityIntact', 'integrityCheckedAt']);
  expect(summaryRow.lastTrustDecision).toEqual(expectedSummaryDecision);

  const { timeline, unlinkedTrustDecisions } = await createAuditTimeline(pool).getMergedTimeline(prescriptionId);
  const scanEvent = timeline.find((event) => event.eventType === 'pharmacy_scan');
  expect(scanEvent.trustDecision).toEqual(expectedTimelineDecision);
  expect(unlinkedTrustDecisions).toEqual([]);

  // HTTP routes the dashboards call
  const summary = await get('/api/audit/summary');
  expect(summary.status).toBe(200);
  expect(summary.body.find((row) => row.prescriptionId === prescriptionId).lastTrustDecision).toEqual(expectedSummaryDecision);
  const timelineResponse = await get(`/api/audit/prescriptions/${prescriptionId}/timeline`);
  expect(timelineResponse.body.timeline.find((event) => event.eventType === 'pharmacy_scan').trustDecision).toEqual(expectedTimelineDecision);
});

test('trust_decision_log schema is exactly migration 008 (no risk columns added or removed)', async () => {
  const [columns] = await pool.query(
    "SELECT column_name AS name, column_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'trust_decision_log' ORDER BY ordinal_position",
    [TEST_DB_NAME],
  );
  expect(columns.map((c) => `${c.name} ${c.type}`)).toEqual([
    'decision_id bigint unsigned',
    'prescription_id varchar(32)',
    'version_number int unsigned',
    'pharmacy_id varchar(32)',
    'verification_event_id bigint unsigned',
    "trust_decision enum('Dispense','Review','Block')",
    'primary_reason varchar(40)',
    'risk_score tinyint unsigned',
    'risk_band enum(\'low\',\'review\',\'high\')',
    'decided_at timestamp(3)',
  ]);
});

test('Module 10b printable document keeps its exact shape (no locked risk leaks into it)', async () => {
  const { prescriptionId } = await fixture();
  const doc = await get(`/api/prescriptions/${prescriptionId}/versions/1/document`);
  expect(doc.status).toBe(200);
  expect(Object.keys(doc.body).sort()).toEqual(
    ['heightCm', 'integrityRoot', 'issuedAt', 'ledgerAnchorRef', 'medicines', 'patient', 'prescriptionId', 'provider', 'qrImage', 'route', 'status', 'versionNumber', 'weightKg'].sort(),
  );
  expect(Object.keys(doc.body.medicines[0])).toEqual(['sequenceNumber', 'drugName', 'drugClass', 'dosageValue', 'dosageUnit', 'frequency', 'durationDays', 'quantityPrescribed']);
});
