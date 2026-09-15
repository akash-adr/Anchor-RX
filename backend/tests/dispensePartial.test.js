'use strict';

/**
 * Module 14 Step 6 — dispensePartial against a real anchor_rx_test database.
 * Prescriptions are created through the real repository; tampering is a raw SQL bypass of one prescription_medicine row.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createDispensing, DispensingError } = require('../dispensing/dispensePartial');
const { createApp } = require('../api/server');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';

const THREE_MEDICINES = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  heightCm: '172.5',
  weightKg: '68.40',
  medicines: [
    { drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic', dosageValue: '500', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 7, quantityPrescribed: 21 },
    { drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '650', dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 },
    { drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 5, quantityPrescribed: 5 },
  ],
});

let pool;
let repository;
let amendmentService;
let dispensePartial;
let getDispensingStatus;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  ({ dispensePartial, getDispensingStatus } = createDispensing(pool, { repository }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
});

const medicineBySequence = (row, sequenceNumber) => row.medicines.find((m) => m.sequence_number === sequenceNumber);

async function recordCount(medicineId) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM dispensing_record WHERE medicine_id = ?', [medicineId]);
  return n;
}

/** Expects the call to reject with this DispensingError code — and to have written NO dispensing_record row. */
async function expectRejected(call, code, medicineId) {
  const before = await recordCount(medicineId);
  const err = await call().then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DispensingError);
  expect(err.code).toBe(code);
  expect(await recordCount(medicineId)).toBe(before);
  return err;
}

test('rejects dispensing more than remaining (and quantity ≤ 0 / non-integer), writing nothing', async () => {
  const v1 = await repository.createPrescription(THREE_MEDICINES);
  const paracetamol = medicineBySequence(v1, 2); // 12 prescribed

  const tooMany = await expectRejected(() => dispensePartial(v1.id, paracetamol.medicine_id, 13, PHARMACY_ID), 'EXCEEDS_REMAINING', paracetamol.medicine_id);
  expect(tooMany.details).toEqual({ prescribed: 12, alreadyGiven: 0, remaining: 12 });

  for (const quantity of [0, -1, 1.5, '3', null]) {
    await expectRejected(() => dispensePartial(v1.id, paracetamol.medicine_id, quantity, PHARMACY_ID), 'INVALID_QUANTITY', paracetamol.medicine_id);
  }

  // After a partial dispense, the limit is the NEW remaining.
  await dispensePartial(v1.id, paracetamol.medicine_id, 10, PHARMACY_ID);
  const overRemaining = await expectRejected(() => dispensePartial(v1.id, paracetamol.medicine_id, 3, PHARMACY_ID), 'EXCEEDS_REMAINING', paracetamol.medicine_id);
  expect(overRemaining.details).toEqual({ prescribed: 12, alreadyGiven: 10, remaining: 2 });
});

test('rejects a tampered medicine while an untampered medicine on the SAME prescription dispenses normally', async () => {
  const v1 = await repository.createPrescription(THREE_MEDICINES);
  const [amoxicillin, paracetamol, cetirizine] = [1, 2, 3].map((n) => medicineBySequence(v1, n));

  // Raw SQL bypass on medicine 2 only.
  const [res] = await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', ['6500', paracetamol.medicine_id]);
  expect(res.affectedRows).toBe(1);

  const err = await expectRejected(() => dispensePartial(v1.id, paracetamol.medicine_id, 1, PHARMACY_ID), 'MEDICINE_TAMPERED', paracetamol.medicine_id);
  expect(err.message).toBe("This medicine's data does not match its recorded hash.");
  expect(err.details).toEqual({ tamperedFields: ['medicine_2.dosage_value'] });

  await expect(dispensePartial(v1.id, amoxicillin.medicine_id, 7, PHARMACY_ID)).resolves.toEqual({
    medicineId: amoxicillin.medicine_id, prescribed: 21, alreadyGiven: 7, remaining: 14,
  });
  await expect(dispensePartial(v1.id, cetirizine.medicine_id, 5, PHARMACY_ID)).resolves.toEqual({
    medicineId: cetirizine.medicine_id, prescribed: 5, alreadyGiven: 5, remaining: 0,
  });

  // The display status reports the same per-medicine picture.
  const status = await getDispensingStatus(v1.prescription_id, 1);
  expect(status.medicines.map((m) => [m.sequenceNumber, m.drugName, m.tampered, m.tamperedFields, m.alreadyGiven, m.remaining])).toEqual([
    [1, 'Amoxicillin', false, [], 7, 14],
    [2, 'Paracetamol', true, ['medicine_2.dosage_value'], 0, 12],
    [3, 'Cetirizine', false, [], 5, 0],
  ]);
});

test('alreadyGiven accumulates across partial dispenses, and remaining shrinks on every subsequent calculation', async () => {
  const v1 = await repository.createPrescription(THREE_MEDICINES);
  const paracetamol = medicineBySequence(v1, 2); // 12 prescribed
  const dispense = (quantity) => dispensePartial(v1.id, paracetamol.medicine_id, quantity, PHARMACY_ID);

  await expect(dispense(5)).resolves.toMatchObject({ prescribed: 12, alreadyGiven: 5, remaining: 7 });
  await expect(dispense(4)).resolves.toMatchObject({ prescribed: 12, alreadyGiven: 9, remaining: 3 });
  await expectRejected(() => dispense(4), 'EXCEEDS_REMAINING', paracetamol.medicine_id);
  await expect(dispense(3)).resolves.toMatchObject({ prescribed: 12, alreadyGiven: 12, remaining: 0 });
  await expectRejected(() => dispense(1), 'EXCEEDS_REMAINING', paracetamol.medicine_id);

  const [rows] = await pool.query('SELECT quantity_dispensed, dispensed_by FROM dispensing_record WHERE medicine_id = ? ORDER BY dispensing_id', [paracetamol.medicine_id]);
  expect(rows.map((r) => [r.quantity_dispensed, r.dispensed_by])).toEqual([[5, PHARMACY_ID], [4, PHARMACY_ID], [3, PHARMACY_ID]]);
  // Other medicines are unaffected.
  const status = await getDispensingStatus(v1.prescription_id, 1);
  expect(status.medicines.map((m) => m.remaining)).toEqual([21, 0, 5]);
});

test('concurrent dispenses of the same medicine can never together exceed quantity_prescribed', async () => {
  const v1 = await repository.createPrescription(THREE_MEDICINES);
  const paracetamol = medicineBySequence(v1, 2); // 12 prescribed

  const outcomes = await Promise.allSettled([8, 8, 8].map((q) => dispensePartial(v1.id, paracetamol.medicine_id, q, PHARMACY_ID)));

  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === 'rejected').map((o) => o.reason.code)).toEqual(['EXCEEDS_REMAINING', 'EXCEEDS_REMAINING']);
  const [[{ total }]] = await pool.query('SELECT SUM(quantity_dispensed) AS total FROM dispensing_record WHERE medicine_id = ?', [paracetamol.medicine_id]);
  expect(Number(total)).toBe(8);
});

test('rejects superseded versions, medicines of another version, and unknown pharmacies', async () => {
  const v1 = await repository.createPrescription(THREE_MEDICINES);
  const v1Paracetamol = medicineBySequence(v1, 2);
  const v2 = await amendmentService.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v1Paracetamol.medicine_id, quantityPrescribed: 16 }, 'PRV-001');

  await expectRejected(() => dispensePartial(v1.id, v1Paracetamol.medicine_id, 1, PHARMACY_ID), 'VERSION_NOT_DISPENSABLE', v1Paracetamol.medicine_id);
  await expectRejected(() => dispensePartial(v2.id, v1Paracetamol.medicine_id, 1, PHARMACY_ID), 'MEDICINE_NOT_FOUND', v1Paracetamol.medicine_id);
  const v2Paracetamol = medicineBySequence(v2, 2);
  await expectRejected(() => dispensePartial(v2.id, v2Paracetamol.medicine_id, 1, 'PHM-GHOST'), 'UNKNOWN_PHARMACY', v2Paracetamol.medicine_id);
  await expect(dispensePartial(v2.id, v2Paracetamol.medicine_id, 16, PHARMACY_ID)).resolves.toMatchObject({ prescribed: 16, remaining: 0 });
});

test('HTTP: GET status and POST /api/dispense expose the same rules (tampered medicine → 409, others 201)', async () => {
  const server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const v1 = await repository.createPrescription(THREE_MEDICINES);
    const paracetamol = medicineBySequence(v1, 2);
    await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', ['6500', paracetamol.medicine_id]);

    const status = await call('GET', `/api/dispensing/${v1.prescription_id}/versions/1`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ prescriptionId: v1.prescription_id, versionNumber: 1, prescriptionVersionId: v1.id, dispensableVersion: true, integrityUnverifiable: false });
    expect(status.body.medicines.map((m) => [m.drugName, m.tampered])).toEqual([['Amoxicillin', false], ['Paracetamol', true], ['Cetirizine', false]]);

    const blocked = await call('POST', '/api/dispense', { prescriptionVersionId: v1.id, medicineId: paracetamol.medicine_id, quantity: 2, pharmacyId: PHARMACY_ID });
    expect(blocked).toEqual({
      status: 409,
      body: { error: true, reason: 'MEDICINE_TAMPERED', message: "This medicine's data does not match its recorded hash.", details: { tamperedFields: ['medicine_2.dosage_value'] } },
    });

    const cetirizine = medicineBySequence(v1, 3);
    const ok = await call('POST', '/api/dispense', { prescriptionVersionId: v1.id, medicineId: cetirizine.medicine_id, quantity: 2, pharmacyId: PHARMACY_ID });
    expect(ok).toEqual({ status: 201, body: { medicineId: cetirizine.medicine_id, prescribed: 5, alreadyGiven: 2, remaining: 3 } });

    expect((await call('POST', '/api/dispense', { prescriptionVersionId: v1.id, medicineId: cetirizine.medicine_id, quantity: 4, pharmacyId: PHARMACY_ID })).status).toBe(409);
    expect((await call('POST', '/api/dispense', { prescriptionVersionId: v1.id, medicineId: cetirizine.medicine_id, quantity: '1', pharmacyId: PHARMACY_ID })).body.reason).toBe('INVALID_QUANTITY');
    expect((await call('GET', `/api/dispensing/${v1.prescription_id}/versions/9`)).status).toBe(404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
