'use strict';

/**
 * Module 10 Step 4 — audit HTTP endpoints, over a real socket against anchor_rx_test.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createPharmacyVerification } = require('../qr/pharmacyVerification');
const { generateQrPayload } = require('../qr/qrEngine');
const { createTrustEvaluator } = require('../trust/evaluateTrust');
const { createApp } = require('../api/server');

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
let server;
let baseUrl;
let repository;
let amendmentService;
let evaluateTrust;

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  const pharmacyVerification = createPharmacyVerification(pool, { repository, amendmentService });
  const scoreClient = { scorePrescriptionViaAI: async () => ({ riskScore: 3, riskBand: 'low', reasons: [], details: null }) };
  ({ evaluateTrust } = createTrustEvaluator(pool, { pharmacyVerification, scoreClient }));

  server = createApp({ pool, repository, amendmentService, pharmacyVerification }).listen(0, '127.0.0.1');
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

/** No headers at all — the audit routes have no access control (prototype). */
async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

const qrFor = (row) => JSON.stringify(generateQrPayload(row.prescription_id, row.version_number, row.created_at));

async function scannedAndAmendedPrescription() {
  const v1 = await repository.createPrescription({ ...BASE_RX });
  expect((await evaluateTrust(qrFor(v1), PHARMACY_ID)).trustDecision).toBe('Dispense');
  await amendmentService.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v1.medicines[0].medicine_id, dosageValue: '650' }, 'PRV-001', 'Dose adjustment');
  return v1;
}

async function tamperedPrescription() {
  const v1 = await repository.createPrescription(withMedicine({ drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10' }));
  // Raw SQL bypass on the Module 14 schema: the dose lives on the medicine row.
  await pool.execute("UPDATE prescription_medicine SET dosage_value = '100' WHERE medicine_id = ?", [v1.medicines[0].medicine_id]);
  return v1;
}

describe('GET /api/audit/prescriptions/:id/timeline', () => {
  test('200 with the merged timeline shape (nested trust decision, epoch-ms timestamps)', async () => {
    const v1 = await scannedAndAmendedPrescription();
    const { status, body } = await get(`/api/audit/prescriptions/${v1.prescription_id}/timeline`);

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['currentStatus', 'prescriptionId', 'timeline', 'unlinkedTrustDecisions']);
    expect(body).toMatchObject({ prescriptionId: v1.prescription_id, currentStatus: 'active', unlinkedTrustDecisions: [] });
    expect(body.timeline.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['version_created', 'ledger_anchored', 'pharmacy_scan', 'version_amended']),
    );
    expect(body.timeline.every((event) => Number.isInteger(event.timestamp))).toBe(true);
    const scan = body.timeline.find((event) => event.eventType === 'pharmacy_scan');
    expect(scan.trustDecision).toMatchObject({ trustDecision: 'Dispense', primaryReason: 'clean', riskScore: 3, riskBand: 'low' });
  });

  test('404 PRESCRIPTION_NOT_FOUND for an unknown prescription', async () => {
    expect(await get('/api/audit/prescriptions/RX-NOPE-0001/timeline')).toEqual({
      status: 404,
      body: expect.objectContaining({ error: true, reason: 'PRESCRIPTION_NOT_FOUND' }),
    });
  });
});

describe('GET /api/audit/prescriptions/:id/recheck', () => {
  test('200 live recheck: tampered fails, clean passes — and nothing is written', async () => {
    const tampered = await tamperedPrescription();
    const [[{ eventsBefore }]] = await pool.query('SELECT COUNT(*) AS eventsBefore FROM verification_event');

    const bad = await get(`/api/audit/prescriptions/${tampered.prescription_id}/recheck`);
    expect(bad.status).toBe(200);
    expect(Object.keys(bad.body).sort()).toEqual(['checkedAt', 'fieldVerification', 'ledgerVerification', 'version']);
    expect(bad.body.fieldVerification).toMatchObject({ valid: false, tamperedFields: ['medicine_1.dosage_value'] });
    expect(bad.body.version).toMatchObject({ versionNumber: 1, basis: 'active_version' });
    expect(Number.isInteger(bad.body.checkedAt)).toBe(true);

    const good = await get('/api/audit/prescriptions/RX-DEMO-0002/recheck');
    expect(good.body.fieldVerification.valid).toBe(true);
    expect(good.body.ledgerVerification).toMatchObject({ anchored: true, integrityRootMatch: true, chainIntact: true });

    const [[{ eventsAfter }]] = await pool.query('SELECT COUNT(*) AS eventsAfter FROM verification_event');
    expect(Number(eventsAfter)).toBe(Number(eventsBefore));
  });

  test('404 for an unknown prescription', async () => {
    expect((await get('/api/audit/prescriptions/RX-NOPE-0001/recheck')).status).toBe(404);
  });
});

describe('GET /api/audit/summary', () => {
  test('200 list; query params are forwarded as filters', async () => {
    const tampered = await tamperedPrescription();
    const revoked = await repository.createPrescription(withMedicine({ drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400' }));
    await amendmentService.revokePrescription(revoked.prescription_id, 'PRV-001', 'No longer needed');

    const all = await get('/api/audit/summary');
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(Object.keys(all.body[0]).sort()).toEqual(
      ['currentStatus', 'integrityCheckedAt', 'lastScan', 'lastTrustDecision', 'latestIntegrityIntact', 'prescriptionId'],
    );

    const concerning = await get('/api/audit/summary?onlyConcerning=true');
    expect(concerning.body.map((row) => row.prescriptionId)).toEqual([tampered.prescription_id]);

    const revokedOnly = await get('/api/audit/summary?currentStatus=revoked');
    expect(revokedOnly.body.map((row) => [row.prescriptionId, row.currentStatus])).toEqual([[revoked.prescription_id, 'revoked']]);

    const notConcerning = await get('/api/audit/summary?onlyConcerning=false&currentStatus=active');
    expect(notConcerning.body.map((row) => row.prescriptionId)).toContain(tampered.prescription_id);
  });

  test.each([
    ['?currentStatus=amended', 'INVALID_FILTERS'],
    ['?onlyConcerning=yes', 'INVALID_FILTERS'],
    ['?status=active', 'INVALID_FILTERS'],
    ['?currentStatus=active&currentStatus=revoked', 'INVALID_FILTERS'],
  ])('400 for %s', async (query, reason) => {
    expect(await get(`/api/audit/summary${query}`)).toEqual({ status: 400, body: expect.objectContaining({ error: true, reason }) });
  });
});
