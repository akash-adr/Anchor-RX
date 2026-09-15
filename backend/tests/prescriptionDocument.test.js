'use strict';

/**
 * GET /api/prescriptions/:prescriptionId/versions/:versionNumber/document — over a real socket, anchor_rx_test.
 * Proves the regenerated QR is the SAME QR the create/amend flow issued, by image bytes and by decoding it.
 */

const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { createPool } = require('../db/connection');
const { seed, REFERENCE_DATA } = require('../db/seed/seed');
const { createApp } = require('../api/server');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

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

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function decodeQr(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded) throw new Error('QR image could not be decoded');
  return decoded.data;
}

// Module 14 request body: prescription-level fields + a medicines array.
const NEW_RX = {
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  heightCm: 172.5,
  weightKg: 68.4,
  medicines: [
    { drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic', dosageValue: '500', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 7, quantityPrescribed: 21 },
    { drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '650', dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 },
  ],
};

const DOCUMENT_KEYS = [
  'heightCm', 'integrityRoot', 'issuedAt', 'ledgerAnchorRef', 'medicines', 'patient', 'prescriptionId', 'provider',
  'qrImage', 'route', 'status', 'versionNumber', 'weightKg',
].sort();

test('returns the complete document for a freshly created version, with the SAME QR the creation flow issued', async () => {
  const created = await call('POST', '/api/prescriptions', NEW_RX);
  expect(created.status).toBe(201);
  const { prescriptionId } = created.body;

  expect(created.body.medicines.map((m) => [m.sequenceNumber, m.drugName, Number.isInteger(m.medicineId)])).toEqual([[1, 'Amoxicillin', true], [2, 'Paracetamol', true]]);

  const doc = await call('GET', `/api/prescriptions/${prescriptionId}/versions/1/document`);
  expect(doc.status).toBe(200);
  expect(Object.keys(doc.body).sort()).toEqual(DOCUMENT_KEYS);

  const patient = REFERENCE_DATA.patients.find((p) => p.patient_id === 'PAT-001');
  const provider = REFERENCE_DATA.providers.find((p) => p.provider_id === 'PRV-001');
  expect(doc.body).toMatchObject({
    prescriptionId,
    versionNumber: 1,
    status: 'active',
    patient: { name: patient.name, patientId: 'PAT-001', dob: patient.dob },
    provider: { name: provider.name, licenseNumber: provider.license_number },
    heightCm: '172.5',
    weightKg: '68.40',
    route: 'oral',
    medicines: [
      { sequenceNumber: 1, drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic', dosageValue: '500.000', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 7, quantityPrescribed: 21 },
      { sequenceNumber: 2, drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '650.000', dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 },
    ],
    integrityRoot: created.body.integrityRoot,
    ledgerAnchorRef: created.body.ledgerAnchorRef,
    issuedAt: created.body.qrPayload.issuedAt,
  });

  // Same QR as issued: identical image bytes, and it decodes to the exact creation payload.
  expect(doc.body.qrImage).toBe(created.body.qrImage);
  expect(JSON.parse(decodeQr(doc.body.qrImage))).toEqual(created.body.qrPayload);
  expect(decodeQr(doc.body.qrImage)).toBe(JSON.stringify(created.body.qrPayload));
});

test('an amended version gets its own QR; the superseded version still regenerates its ORIGINAL QR (created_at, not amended_at)', async () => {
  const created = await call('POST', '/api/prescriptions', NEW_RX);
  const { prescriptionId } = created.body;
  const amended = await call('POST', `/api/prescriptions/${prescriptionId}/amend`, {
    requestingProviderId: 'PRV-001',
    changes: { medicineId: created.body.medicines[0].medicineId, dosageValue: '875' },
    reason: 'Dose increase',
  });
  expect(amended.status).toBe(200);

  const [[v1]] = await pool.query('SELECT amended_at FROM prescription_version WHERE prescription_id = ? AND version_number = 1', [prescriptionId]);
  expect(v1.amended_at).toBeInstanceOf(Date); // v1 now HAS an amended_at…

  const doc1 = await call('GET', `/api/prescriptions/${prescriptionId}/versions/1/document`);
  expect(doc1.body.status).toBe('amended');
  expect(doc1.body.qrImage).toBe(created.body.qrImage); // …yet its QR is unchanged
  expect(JSON.parse(decodeQr(doc1.body.qrImage))).toEqual(created.body.qrPayload);

  const doc2 = await call('GET', `/api/prescriptions/${prescriptionId}/versions/2/document`);
  expect(doc2.body).toMatchObject({
    versionNumber: 2,
    status: 'active',
    issuedAt: amended.body.qrPayload.issuedAt,
    medicines: [{ sequenceNumber: 1, dosageValue: '875.000' }, { sequenceNumber: 2, dosageValue: '650.000' }], // only medicine 1 amended
  });
  expect(doc2.body.qrImage).toBe(amended.body.qrImage);
  expect(JSON.parse(decodeQr(doc2.body.qrImage))).toEqual(amended.body.qrPayload);

  // The decoded document QR verifies at the pharmacy.
  const scan = await call('POST', '/api/scan', { qrPayloadRaw: decodeQr(doc2.body.qrImage), pharmacyId: 'PHM-001' });
  expect(scan.body.scanResult).toBe('verified');
});

test('seeded demo prescription document', async () => {
  const doc = await call('GET', '/api/prescriptions/RX-DEMO-0002/versions/1/document');
  expect(doc.status).toBe(200);
  expect(doc.body).toMatchObject({ prescriptionId: 'RX-DEMO-0002', patient: { patientId: 'PAT-002', dob: '1962-11-03' }, medicines: [{ sequenceNumber: 1, drugName: 'Atorvastatin' }] });
  expect(JSON.parse(decodeQr(doc.body.qrImage))).toMatchObject({ prescriptionId: 'RX-DEMO-0002', versionNumber: 1 });
});

test.each([
  ['/api/prescriptions/RX-DEMO-0002/versions/2/document', 404, 'VERSION_NOT_FOUND'],
  ['/api/prescriptions/RX-NOPE-0001/versions/1/document', 404, 'VERSION_NOT_FOUND'],
  ['/api/prescriptions/RX-DEMO-0002/versions/0/document', 400, 'INVALID_VERSION'],
  ['/api/prescriptions/RX-DEMO-0002/versions/abc/document', 400, 'INVALID_VERSION'],
  ['/api/prescriptions/RX-DEMO-0002/versions/1.5/document', 400, 'INVALID_VERSION'],
])('%s → %i %s', async (path, status, reason) => {
  expect(await call('GET', path)).toEqual({ status, body: expect.objectContaining({ error: true, reason }) });
});
