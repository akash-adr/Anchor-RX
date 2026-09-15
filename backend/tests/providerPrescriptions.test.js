'use strict';

/**
 * getPrescriptionsByProvider + GET /api/providers/:providerId/prescriptions against a real anchor_rx_test database.
 * "Issued by" = version 1's provider_id — a delegate who only amended a prescription must NOT see it as theirs.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createApp } = require('../api/server');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let repository;
let amendmentService;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

const medicine = (drugName, overrides = {}) => ({
  drugName, drugClass: 'test class', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 5, quantityPrescribed: 5, ...overrides,
});

const at = (minute) => new Date(Date.UTC(2026, 8, 15, 12, minute, 0, 0));

async function pinCreatedAt(prescriptionId, versionNumber, date) {
  await pool.execute('UPDATE prescription_version SET created_at = ? WHERE prescription_id = ? AND version_number = ?', [date, prescriptionId, versionNumber]);
}

test('lists only prescriptions whose ORIGINAL prescriber is the provider, latest-version summaries, most recent first', async () => {
  // PRV-002 issues two; PRV-001 issues one that PRV-002 later amends as a delegate (must not be PRV-002's).
  const single = await repository.createPrescription({ patientId: 'PAT-003', providerId: 'PRV-002', medicines: [medicine('Metformin')] });
  const multi = await repository.createPrescription({
    patientId: 'PAT-001', providerId: 'PRV-002', medicines: [medicine('Amoxicillin'), medicine('Paracetamol'), medicine('Cetirizine')],
  });
  const delegated = await repository.createPrescription({ patientId: 'PAT-002', providerId: 'PRV-001', medicines: [medicine('Ibuprofen')] });
  await repository.amendPrescription(delegated.prescription_id, { medicineId: delegated.medicines[0].medicine_id, dosageValue: '20' }, 'PRV-002', 'delegate change');
  // multi gets amended (v2) → its lastAnchoredAt is v2's created_at, status active; still PRV-002's.
  await repository.amendPrescription(multi.prescription_id, { medicineId: multi.medicines[1].medicine_id, quantityPrescribed: 9 }, 'PRV-002');

  await pinCreatedAt('RX-DEMO-0002', 1, at(1));
  await pinCreatedAt(single.prescription_id, 1, at(30));
  await pinCreatedAt(multi.prescription_id, 1, at(10));
  await pinCreatedAt(multi.prescription_id, 2, at(40));

  const list = await repository.getPrescriptionsByProvider('PRV-002');

  expect(list.map((p) => p.prescriptionId)).toEqual([multi.prescription_id, single.prescription_id, 'RX-DEMO-0002']);
  expect(list[0]).toEqual({
    prescriptionId: multi.prescription_id,
    currentStatus: 'active',
    latestVersionNumber: 2,
    drugSummary: 'Amoxicillin +2 more',
    medicineCount: 3,
    patientId: 'PAT-001',
    patientName: 'Demo Patient One',
    lastAnchoredAt: at(40),
  });
  expect(list[1]).toMatchObject({ drugSummary: 'Metformin', medicineCount: 1, patientName: 'Demo Patient Three', latestVersionNumber: 1 });

  // The delegate-amended prescription belongs to its original prescriber only.
  expect(list.some((p) => p.prescriptionId === delegated.prescription_id)).toBe(false);
  const prv001 = await repository.getPrescriptionsByProvider('PRV-001');
  expect(prv001.find((p) => p.prescriptionId === delegated.prescription_id)).toMatchObject({ latestVersionNumber: 2, drugSummary: 'Ibuprofen' });
  expect(prv001.some((p) => p.prescriptionId === multi.prescription_id)).toBe(false);
});

test('a revoked prescription is listed with currentStatus "revoked"', async () => {
  const rx = await repository.createPrescription({ patientId: 'PAT-001', providerId: 'PRV-002', medicines: [medicine('Tramadol')] });
  await amendmentService.revokePrescription(rx.prescription_id, 'PRV-002', 'No longer needed');

  const entry = (await repository.getPrescriptionsByProvider('PRV-002')).find((p) => p.prescriptionId === rx.prescription_id);
  expect(entry).toMatchObject({ currentStatus: 'revoked', latestVersionNumber: 2, drugSummary: 'Tramadol' });
});

test('a known provider with nothing issued gets []; an unknown provider gets null', async () => {
  await expect(repository.getPrescriptionsByProvider('PRV-003')).resolves.toEqual([]);
  await expect(repository.getPrescriptionsByProvider('PRV-GHOST')).resolves.toBeNull();
});

test('HTTP: 200 list, 200 [] for no prescriptions, 404 PROVIDER_NOT_FOUND for an unknown provider', async () => {
  const server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    const ok = await get('/api/providers/PRV-002/prescriptions');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([
      expect.objectContaining({ prescriptionId: 'RX-DEMO-0002', currentStatus: 'active', patientName: expect.any(String), lastAnchoredAt: expect.any(String) }),
    ]);
    expect(await get('/api/providers/PRV-003/prescriptions')).toEqual({ status: 200, body: [] });
    expect(await get('/api/providers/PRV-GHOST/prescriptions')).toMatchObject({ status: 404, body: { error: true, reason: 'PROVIDER_NOT_FOUND' } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
