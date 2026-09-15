'use strict';

/**
 * Module 15 Step 4 — POST /api/scan's pharmacistRiskDisplay, over a real socket against anchor_rx_test.
 *
 * The value must come from locked_risk_* columns ONLY. To prove no scoring happens anywhere during a scan, every score
 * client and medicine scorer the app can construct (including the one inside Module 9's evaluateTrust) is wrapped to
 * record calls, and fetch is watched for any request to an AI-service /score endpoint.
 */

const mockScoringCalls = [];

jest.mock('../ml/scoreClient', () => {
  const actual = jest.requireActual('../ml/scoreClient');
  return {
    ...actual,
    createScoreClient: (...args) => {
      const client = actual.createScoreClient(...args);
      return {
        scorePrescriptionViaAI: (...callArgs) => {
          mockScoringCalls.push('scorePrescriptionViaAI');
          return client.scorePrescriptionViaAI(...callArgs);
        },
        scorePayloadViaAI: (...callArgs) => {
          mockScoringCalls.push('scorePayloadViaAI');
          return client.scorePayloadViaAI(...callArgs);
        },
      };
    },
  };
});

jest.mock('../ml/scoreAllMedicines', () => {
  const actual = jest.requireActual('../ml/scoreAllMedicines');
  return {
    ...actual,
    createMedicineScorer: (...args) => {
      const scorer = actual.createMedicineScorer(...args);
      return {
        buildSharedContext: scorer.buildSharedContext,
        scoreAllMedicines: (...callArgs) => {
          mockScoringCalls.push('scoreAllMedicines');
          return scorer.scoreAllMedicines(...callArgs);
        },
      };
    },
  };
});

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createApp } = require('../api/server');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { generateQrPayload } = require('../qr/qrEngine');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';
const VERIFY_SCAN_KEYS = ['currentActiveVersion', 'eventId', 'fieldVerification', 'ledgerVerification', 'prescriptionId', 'providerStatus', 'scanResult', 'scannedAt', 'versionNumber'];

const medicine = (drugName, drugClass) => ({ drugName, drugClass, dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 5, quantityPrescribed: 5 });
const risk = (riskScore, riskBand) => ({ riskScore, riskBand, reasons: [] });

let pool;
let server;
let baseUrl;
let repository;
let fetchSpy;

beforeAll(async () => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  fetchSpy = jest.spyOn(globalThis, 'fetch'); // passes through; created before the app so every default client uses it
  server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fetchSpy.mockRestore();
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  mockScoringCalls.length = 0;
  fetchSpy.mockClear();
});

async function scan(qrPayloadRaw) {
  const response = await fetch(`${baseUrl}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrPayloadRaw, pharmacyId: PHARMACY_ID }) });
  return { status: response.status, body: await response.json() };
}

const qrFor = async (prescriptionId, versionNumber) =>
  JSON.stringify(generateQrPayload(prescriptionId, versionNumber, (await repository.getVersion(prescriptionId, versionNumber)).created_at));

const aiServiceCalls = () => fetchSpy.mock.calls.filter(([url]) => /\/score\b/.test(String(url)));

function expectNoScoring() {
  expect(mockScoringCalls).toEqual([]);
  expect(aiServiceCalls()).toEqual([]);
}

test('3 medicines locked at 20, 45, 78 → percentage is 78 (the max), not the average or the first medicine — and nothing is scored', async () => {
  const rx = await repository.createPrescription(
    { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [medicine('Loratadine', 'antihistamine'), medicine('Omeprazole', 'proton pump inhibitor'), medicine('Metformin', 'biguanide')] },
    { lockedRisks: [risk(20, 'low'), risk(45, 'review'), risk(78, 'high')] },
  );

  const { status, body } = await scan(await qrFor(rx.prescription_id, 1));

  expect(status).toBe(200);
  expect(body.scanResult).toBe('verified');
  expect(body.pharmacistRiskDisplay).toEqual({ percentage: 78 });
  expect(body.pharmacistRiskDisplay.percentage).not.toBe(20); // first medicine
  expect(body.pharmacistRiskDisplay.percentage).not.toBeCloseTo((20 + 45 + 78) / 3); // average
  // Additive only: every verifyScan field is still there, unchanged in shape; nothing else was added.
  expect(Object.keys(body).sort()).toEqual([...VERIFY_SCAN_KEYS, 'pharmacistRiskDisplay'].sort());
  expectNoScoring();
});

test('the max wins wherever it sits, and 2-decimal locked scores come through exactly', async () => {
  const rx = await repository.createPrescription(
    { patientId: 'PAT-003', providerId: 'PRV-002', medicines: [medicine('Loratadine', 'antihistamine'), medicine('Omeprazole', 'proton pump inhibitor'), medicine('Metformin', 'biguanide')] },
    { lockedRisks: [risk(20, 'low'), risk(81.25, 'high'), risk(45, 'review')] },
  );
  expect((await scan(await qrFor(rx.prescription_id, 1))).body.pharmacistRiskDisplay).toEqual({ percentage: 81.25 });
  expectNoScoring();
});

test('other outcomes: tampered still shows the locked max; stale uses the SCANNED version; unlocked → null percentage; no version → null', async () => {
  const rx = await repository.createPrescription(
    { patientId: 'PAT-001', providerId: 'PRV-001', medicines: [medicine('Loratadine', 'antihistamine'), medicine('Metformin', 'biguanide')] },
    { lockedRisks: [risk(33, 'low'), risk(64, 'review')] },
  );
  const v1Qr = await qrFor(rx.prescription_id, 1);

  // Amend → v2 (medicines copied forward without locked risk); the v1 QR is now stale.
  await repository.amendPrescription(rx.prescription_id, { medicineId: rx.medicines[1].medicine_id, quantityPrescribed: 9 });
  const stale = await scan(v1Qr);
  expect(stale.body).toMatchObject({ scanResult: 'stale_version', versionNumber: 1, currentActiveVersion: 2, pharmacistRiskDisplay: { percentage: 64 } });
  const current = await scan(await qrFor(rx.prescription_id, 2));
  expect(current.body).toMatchObject({ scanResult: 'verified', pharmacistRiskDisplay: { percentage: null } });

  // Tampered (raw SQL on a v1 medicine row): the verdict is tampered, and the locked max is still reported as stored.
  await pool.execute("UPDATE prescription_medicine SET dosage_value = '9000' WHERE medicine_id = ?", [rx.medicines[0].medicine_id]);
  expect((await scan(v1Qr)).body).toMatchObject({ scanResult: 'tampered', versionNumber: 1, pharmacistRiskDisplay: { percentage: 64 } });

  // Seeded prescription created before Module 15 → nothing locked.
  expect((await scan(await qrFor('RX-DEMO-0003', 1))).body.pharmacistRiskDisplay).toEqual({ percentage: null });

  // No version resolved.
  expect((await scan('not a qr')).body).toMatchObject({ scanResult: 'malformed_qr', pharmacistRiskDisplay: null });
  expect((await scan(JSON.stringify({ prescriptionId: 'RX-NOPE-0001', versionNumber: 1, issuedAt: new Date().toISOString() }))).body).toMatchObject({
    scanResult: 'unknown_prescription',
    pharmacistRiskDisplay: null,
  });

  expectNoScoring();
});
