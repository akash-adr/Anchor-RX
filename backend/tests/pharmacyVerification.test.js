'use strict';

/**
 * Module 6 completion gate — pharmacy scan precedence chain against a real MySQL database.
 *
 *   malformed_qr → unknown_prescription → provider_identity_issue → tampered → forged → revoked → stale_version → verified
 *
 * Isolation: anchor_rx_test is fully reseeded before every test (demo prescriptions, providers
 * PRV-001/PRV-002 active + PRV-003 inactive, pharmacy PHM-001, empty ledger/events before seeding).
 */

const crypto = require('crypto');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const { runTamperDemo } = require('../db/seed/tamperDemo');
const hashEngine = require('../integrity/hashEngine');
const { generateQrPayload, buildVersionQr } = require('../qr/qrEngine');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createLedgerService } = require('../ledger/ledgerService');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createPharmacyVerification, PharmacyVerificationError } = require('../qr/pharmacyVerification');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const PHARMACY_ID = 'PHM-001';

let pool;
let repository;
let ledger;
let amendmentService;
let verifyAnchorCalls; // counts calls through the injected ledger (for the precedence proof)
let verifyScan;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  ledger = createLedgerService(pool, { repository });
  amendmentService = createAmendmentService(pool, { repository });
  const countingLedger = {
    ...ledger,
    verifyAnchor: (...args) => {
      verifyAnchorCalls += 1;
      return ledger.verifyAnchor(...args);
    },
  };
  ({ verifyScan } = createPharmacyVerification(pool, { repository, ledger: countingLedger, amendmentService }));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  verifyAnchorCalls = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Module 14 input shape: one medicine.
const BASE_RX = Object.freeze({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  medicines: Object.freeze([
    Object.freeze({ drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '500', dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 }),
  ]),
});

async function eventCount() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM verification_event');
  return n;
}

/** The raw text a scanner would read from this version's QR (the payload JSON). */
async function qrTextFor(prescriptionId, versionNumber) {
  const row = await repository.getVersion(prescriptionId, versionNumber);
  return JSON.stringify(generateQrPayload(prescriptionId, versionNumber, row.created_at));
}

/** Decodes the real QR image with a QR reader — what a phone/scanner would actually hand over. */
async function scannedTextFromImage(prescriptionId, versionNumber) {
  const { qrImage } = await buildVersionQr(await repository.getVersion(prescriptionId, versionNumber));
  const png = PNG.sync.read(Buffer.from(qrImage.split(',')[1], 'base64'));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data;
}

/**
 * Scans and asserts the audit guarantee for that scan: exactly ONE new verification_event, whose result,
 * version reference, pharmacy and timestamp match what verifyScan returned — and whose event_id is the eventId
 * verifyScan returned (Module 9 Step 2), in every branch.
 */
async function scanExpectingOneEvent(rawScanData, { expectedVersionRowId }) {
  const before = await eventCount();
  const result = await verifyScan(rawScanData, PHARMACY_ID);
  const after = await eventCount();

  const [[event]] = await pool.query(
    'SELECT event_id, prescription_version_id, pharmacy_id, result, `timestamp` FROM verification_event ORDER BY event_id DESC LIMIT 1',
  );

  expect(after - before).toBe(1);
  expect(event.result).toBe(result.scanResult);
  expect(event.prescription_version_id).toBe(expectedVersionRowId);
  expect(event.pharmacy_id).toBe(PHARMACY_ID);
  expect(event.timestamp.getTime()).toBe(result.scannedAt.getTime());
  expect(Number.isInteger(result.eventId)).toBe(true);
  expect(result.eventId).toBe(event.event_id);

  return { result, event, eventsAdded: after - before };
}

const RESULT_KEYS = [
  'currentActiveVersion',
  'eventId',
  'fieldVerification',
  'ledgerVerification',
  'prescriptionId',
  'providerStatus',
  'scanResult',
  'scannedAt',
  'versionNumber',
].sort();

async function createClean(overrides = {}, medicineOverrides = {}) {
  return repository.createPrescription({ ...BASE_RX, ...overrides, medicines: [{ ...BASE_RX.medicines[0], ...medicineOverrides }] });
}

async function rawTamperDosage(versionRow, newDosage = '5000') {
  // Module 2 demo pattern on the Module 14 schema: edit the first medicine's row directly, bypassing the repository.
  const [res] = await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', [newDosage, versionRow.medicines[0].medicine_id]);
  expect(res.affectedRows).toBe(1);
}

async function mutateLedgerEntry(versionRow) {
  const forgedRoot = crypto.createHash('sha256').update(`forged:${versionRow.id}`).digest('hex');
  const [res] = await pool.execute('UPDATE ledger_entry SET integrity_root = ? WHERE ledger_entry_id = ?', [
    forgedRoot,
    versionRow.ledger_anchor_ref,
  ]);
  expect(res.affectedRows).toBe(1);
}

async function setProviderStatus(providerId, status) {
  await pool.execute('UPDATE provider SET status = ? WHERE provider_id = ?', [status, providerId]);
}

// ---------------------------------------------------------------------------
// 1–8: one test per branch, in precedence-chain order (verified first, as specified)
// ---------------------------------------------------------------------------

describe('pharmacy scan precedence chain', () => {
  test('1. verified — fresh, untampered, current version (scanned from a real QR image)', async () => {
    const v1 = await createClean();
    const scannedText = await scannedTextFromImage(v1.prescription_id, 1);

    const { result } = await scanExpectingOneEvent(scannedText, { expectedVersionRowId: v1.id });

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      scanResult: 'verified',
      prescriptionId: v1.prescription_id,
      versionNumber: 1,
      providerStatus: 'active',
      currentActiveVersion: 1,
      fieldVerification: { valid: true, tamperedFields: [], integrityRootMatch: true },
      ledgerVerification: { anchored: true, integrityRootMatch: true, chainIntact: true },
    });
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  test('2. malformed_qr — invalid JSON never throws and logs an event with prescription_version_id NULL', async () => {
    let outcome;
    await expect(
      (async () => {
        outcome = await scanExpectingOneEvent('{"prescriptionId": "RX-DEMO-0001", versionNumber: oops', { expectedVersionRowId: null });
      })(),
    ).resolves.not.toThrow();

    expect(outcome.result).toEqual({
      scanResult: 'malformed_qr',
      prescriptionId: null,
      versionNumber: null,
      fieldVerification: null,
      ledgerVerification: null,
      providerStatus: null,
      currentActiveVersion: null,
      scannedAt: expect.any(Date),
      eventId: outcome.event.event_id, // logged even though there is no version to reference
    });
    expect(outcome.event.prescription_version_id).toBeNull();
  });

  test('3. unknown_prescription — well-formed payload for a prescriptionId that does not exist', async () => {
    const raw = JSON.stringify(generateQrPayload('RX-NOPE-0001', 1, new Date()));

    const { result } = await scanExpectingOneEvent(raw, { expectedVersionRowId: null });

    expect(result).toMatchObject({
      scanResult: 'unknown_prescription',
      prescriptionId: 'RX-NOPE-0001',
      versionNumber: 1,
      fieldVerification: null,
      ledgerVerification: null,
      providerStatus: null,
      currentActiveVersion: null,
    });
  });

  test('4. provider_identity_issue — flagged provider on an OTHERWISE clean, anchored, current version', async () => {
    const v1 = await createClean({ providerId: 'PRV-002' });

    // Prove every later check WOULD pass for this version before flagging the provider.
    expect(hashEngine.verifyIntegrity(v1, v1.field_hashes, v1.salt).valid).toBe(true);
    expect(await ledger.verifyAnchor(v1.prescription_id, 1)).toMatchObject({ anchored: true, integrityRootMatch: true, chainIntact: true });
    expect((await amendmentService.getActiveVersion(v1.prescription_id)).version_number).toBe(1);

    await setProviderStatus('PRV-002', 'flagged');
    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });

    expect(result).toMatchObject({
      scanResult: 'provider_identity_issue',
      providerStatus: 'flagged',
      fieldVerification: null, // checks after (c) never ran
      ledgerVerification: null,
      currentActiveVersion: null,
    });
  });

  test('5. tampered — raw SQL dosage edit (Module 2 demo pattern) pinpoints exactly ["medicine_1.dosage_value"]', async () => {
    const { prescriptionId, versionId } = await runTamperDemo(pool); // RX-DEMO-0005: 500 → 5000, repository bypassed

    const { result } = await scanExpectingOneEvent(await qrTextFor(prescriptionId, 1), { expectedVersionRowId: versionId });

    expect(result.scanResult).toBe('tampered');
    expect(result.fieldVerification.valid).toBe(false);
    expect(result.fieldVerification.tamperedFields).toEqual(['medicine_1.dosage_value']);
    expect(result.ledgerVerification).toBeNull(); // (e) never ran
    expect(result.providerStatus).toBe('active');
  });

  test('6. forged — raw SQL mutation of the ledger entry (Module 4 pattern), distinct from tampered', async () => {
    const forgedTarget = await createClean({}, { drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic' });
    const tamperedTarget = await createClean({ patientId: 'PAT-002' });

    await mutateLedgerEntry(forgedTarget); // ledger bypassed, prescription row untouched
    const forged = (await scanExpectingOneEvent(await qrTextFor(forgedTarget.prescription_id, 1), { expectedVersionRowId: forgedTarget.id })).result;

    await rawTamperDosage(tamperedTarget); // prescription row bypassed, ledger untouched
    const tampered = (await scanExpectingOneEvent(await qrTextFor(tamperedTarget.prescription_id, 1), { expectedVersionRowId: tamperedTarget.id })).result;

    expect(forged.scanResult).toBe('forged');
    expect(forged.fieldVerification).toEqual({ valid: true, tamperedFields: [], integrityRootMatch: true }); // the row itself is consistent
    expect(forged.ledgerVerification).toMatchObject({ anchored: true, chainIntact: false, integrityRootMatch: false });

    expect(tampered.scanResult).toBe('tampered');
    expect(tampered.fieldVerification.valid).toBe(false);
    expect(tampered.ledgerVerification).toBeNull();

    expect(forged.scanResult).not.toBe(tampered.scanResult);
  });

  test('7. revoked — create, then revokePrescription; scanning v1 is revoked, not stale_version', async () => {
    const v1 = await createClean();
    const revocation = await amendmentService.revokePrescription(v1.prescription_id, 'PRV-001', 'Patient reported allergy');
    expect(revocation.version_number).toBe(2); // the chain now HAS a newer version — still must not read as stale

    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });

    expect(result.scanResult).toBe('revoked');
    expect(result.scanResult).not.toBe('stale_version');
    expect(result.currentActiveVersion).toBeNull();
    expect(result.fieldVerification.valid).toBe(true);
    expect(result.ledgerVerification).toMatchObject({ anchored: true, integrityRootMatch: true, chainIntact: true });
  });

  test('8. stale_version — scanning the ORIGINAL v1 QR after a legitimate amendment', async () => {
    const v1 = await createClean();
    const v1Qr = await qrTextFor(v1.prescription_id, 1); // printed before the amendment
    await amendmentService.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v1.medicines[0].medicine_id, dosageValue: '650' }, 'PRV-001', 'Pain not controlled');

    const { result } = await scanExpectingOneEvent(v1Qr, { expectedVersionRowId: v1.id });

    expect(result).toMatchObject({
      scanResult: 'stale_version',
      prescriptionId: v1.prescription_id,
      versionNumber: 1,
      currentActiveVersion: 2,
      providerStatus: 'active',
      fieldVerification: { valid: true },
      ledgerVerification: { anchored: true, integrityRootMatch: true, chainIntact: true },
    });
  });
});

// ---------------------------------------------------------------------------
// 9: audit completeness across all eight branches in one database state
// ---------------------------------------------------------------------------

describe('9. verification_event audit trail', () => {
  test('each of the eight branches adds exactly one event with the matching result', async () => {
    // Fixtures (everything that writes to the ledger happens BEFORE the ledger mutation, and the forged
    // target is the newest ledger entry, so earlier entries' chains stay intact).
    const verifiedRx = await createClean();
    const flaggedRx = await createClean({ providerId: 'PRV-002' });
    const { prescriptionId: tamperedRxId, versionId: tamperedRowId } = await runTamperDemo(pool);
    const revokedRx = await createClean({ patientId: 'PAT-003' });
    await amendmentService.revokePrescription(revokedRx.prescription_id, 'PRV-001', 'Therapy changed');
    const staleRx = await createClean({ patientId: 'PAT-002' });
    const staleV1Qr = await qrTextFor(staleRx.prescription_id, 1);
    await amendmentService.amendPrescriptionAuthorized(staleRx.prescription_id, { medicineId: staleRx.medicines[0].medicine_id, durationDays: 5 }, 'PRV-001');
    const forgedRx = await createClean({}, { drugName: 'Cefalexin', drugClass: 'cephalosporin' });
    await mutateLedgerEntry(forgedRx);

    const scenarios = [
      ['malformed_qr', 'definitely-not-json', null],
      ['unknown_prescription', JSON.stringify(generateQrPayload('RX-NOPE-0002', 3, new Date())), null],
      ['provider_identity_issue', await qrTextFor(flaggedRx.prescription_id, 1), flaggedRx.id],
      ['tampered', await qrTextFor(tamperedRxId, 1), tamperedRowId],
      ['forged', await qrTextFor(forgedRx.prescription_id, 1), forgedRx.id],
      ['revoked', await qrTextFor(revokedRx.prescription_id, 1), revokedRx.id],
      ['stale_version', staleV1Qr, staleRx.id],
      ['verified', await qrTextFor(verifiedRx.prescription_id, 1), verifiedRx.id],
    ];

    const table = [];
    for (const [expected, raw, rowId] of scenarios) {
      if (expected === 'provider_identity_issue') await setProviderStatus('PRV-002', 'flagged');
      const { result, event, eventsAdded } = await scanExpectingOneEvent(raw, { expectedVersionRowId: rowId });
      if (expected === 'provider_identity_issue') await setProviderStatus('PRV-002', 'active');
      expect(result.scanResult).toBe(expected);
      table.push({ expected, scanResult: result.scanResult, eventsAdded, eventResult: event.result, eventVersionRowId: event.prescription_version_id });
    }

    console.log(`[TEST 9] one event per scan:\n${table.map((r) => `  ${r.expected.padEnd(24)} → scanResult=${r.scanResult.padEnd(24)} eventsAdded=${r.eventsAdded} event.result=${r.eventResult.padEnd(24)} prescription_version_id=${r.eventVersionRowId}`).join('\n')}`);
    expect(await eventCount()).toBe(scenarios.length);
  });
});

// ---------------------------------------------------------------------------
// 10: precedence proof — provider check (c) runs before the integrity check (d)
// ---------------------------------------------------------------------------

describe('10. precedence: provider_identity_issue beats tampered', () => {
  test('a version that is BOTH tampered AND by a flagged provider returns provider_identity_issue', async () => {
    const v1 = await createClean({ providerId: 'PRV-002' });
    await rawTamperDosage(v1); // genuinely tampered…
    expect(hashEngine.verifyIntegrity(await repository.getVersion(v1.prescription_id, 1), v1.field_hashes, v1.salt).tamperedFields).toEqual(['medicine_1.dosage_value']);
    await setProviderStatus('PRV-002', 'flagged'); // …and the provider is flagged

    const verifyIntegritySpy = jest.spyOn(hashEngine, 'verifyIntegrity');
    verifyAnchorCalls = 0;
    const qr = await qrTextFor(v1.prescription_id, 1);

    const flagged = (await scanExpectingOneEvent(qr, { expectedVersionRowId: v1.id })).result;

    expect(flagged.scanResult).toBe('provider_identity_issue');
    expect(flagged.providerStatus).toBe('flagged');
    expect(flagged.fieldVerification).toBeNull();
    expect(verifyIntegritySpy).not.toHaveBeenCalled(); // step (d) never ran
    expect(verifyAnchorCalls).toBe(0); // step (e) never ran

    // Control: the same tampered version with the provider restored falls through to (d) → tampered.
    await setProviderStatus('PRV-002', 'active');
    const unflagged = (await scanExpectingOneEvent(qr, { expectedVersionRowId: v1.id })).result;

    expect(unflagged.scanResult).toBe('tampered');
    expect(unflagged.fieldVerification.tamperedFields).toEqual(['medicine_1.dosage_value']);
    expect(verifyIntegritySpy).toHaveBeenCalledTimes(1);

    console.log(
      `[TEST 10] tampered + flagged provider → ${flagged.scanResult} (providerStatus=${flagged.providerStatus}, verifyIntegrity calls=0, verifyAnchor calls=0)\n` +
        `[TEST 10] same version, provider active → ${unflagged.scanResult} (tamperedFields=${JSON.stringify(unflagged.fieldVerification.tamperedFields)})`,
    );
  });
});

describe('guard', () => {
  test('unknown pharmacy throws UNKNOWN_PHARMACY and logs nothing', async () => {
    const before = await eventCount();
    await expect(verifyScan(await qrTextFor('RX-DEMO-0001', 2), 'PHM-GHOST')).rejects.toBeInstanceOf(PharmacyVerificationError);
    expect(await eventCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Module 14 Step 5 — per-medicine tamper isolation (no change to verifyScan's logic: this proves what it reports)
// ---------------------------------------------------------------------------

describe('multi-medicine tamper isolation', () => {
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

  /** Raw SQL bypass of ONE medicine row (by medicine_id). Column names come only from the hashed-field whitelist. */
  async function rawTamperMedicine(versionRow, sequenceNumber, column, value) {
    if (!hashEngine.MEDICINE_HASHED_FIELDS.includes(column)) throw new Error(`not a medicine column: ${column}`);
    const medicine = versionRow.medicines.find((m) => m.sequence_number === sequenceNumber);
    const [res] = await pool.execute(`UPDATE prescription_medicine SET ${column} = ? WHERE medicine_id = ?`, [value, medicine.medicine_id]);
    expect(res.affectedRows).toBe(1);
  }

  const otherMedicineKeys = (fields, sequenceNumber) => fields.filter((field) => field.startsWith('medicine_') && !field.startsWith(`medicine_${sequenceNumber}.`));

  test('an untampered 3-medicine prescription scans verified (control)', async () => {
    const v1 = await repository.createPrescription(THREE_MEDICINES);
    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });
    expect(result.scanResult).toBe('verified');
    expect(result.fieldVerification.tamperedFields).toEqual([]);
  });

  test('tampering medicine 2 reports exactly "medicine_2.dosage_value"; medicines 1 and 3 do not appear', async () => {
    const v1 = await repository.createPrescription(THREE_MEDICINES);
    await rawTamperMedicine(v1, 2, 'dosage_value', '6500');

    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });

    expect(result.scanResult).toBe('tampered');
    expect(result.fieldVerification.tamperedFields).toEqual(['medicine_2.dosage_value']);
    expect(result.fieldVerification.tamperedFields.filter((f) => f.startsWith('medicine_1.') || f.startsWith('medicine_3.'))).toEqual([]);
    expect(result.fieldVerification.integrityRootMatch).toBe(false);
  });

  test("copying ANOTHER medicine's value into medicine 2 is still attributed to medicine 2 only (hashes are position-bound)", async () => {
    const v1 = await repository.createPrescription(THREE_MEDICINES);
    await rawTamperMedicine(v1, 2, 'dosage_value', '500'); // medicine 1's exact dose

    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });

    expect(result.scanResult).toBe('tampered');
    expect(result.fieldVerification.tamperedFields).toEqual(['medicine_2.dosage_value']);
  });

  test('two medicines tampered in different fields → each tagged with its own medicine; the untouched medicine 2 is absent', async () => {
    const v1 = await repository.createPrescription(THREE_MEDICINES);
    await rawTamperMedicine(v1, 3, 'frequency', 'four times daily');
    await rawTamperMedicine(v1, 1, 'quantity_prescribed', 90);

    const { result } = await scanExpectingOneEvent(await qrTextFor(v1.prescription_id, 1), { expectedVersionRowId: v1.id });

    expect(result.scanResult).toBe('tampered');
    expect(result.fieldVerification.tamperedFields).toEqual(['medicine_1.quantity_prescribed', 'medicine_3.frequency']);
    expect(result.fieldVerification.tamperedFields.some((f) => f.startsWith('medicine_2.'))).toBe(false);
    expect(otherMedicineKeys(result.fieldVerification.tamperedFields, 1)).toEqual(['medicine_3.frequency']);
  });
});
