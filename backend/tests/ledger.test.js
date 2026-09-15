'use strict';

/**
 * Module 4 completion gate — mock hash-chained ledger against a real MySQL database.
 *
 * Isolation: anchor_rx_test is reset before every test to reference data only (providers,
 * patients, pharmacy) with an EMPTY ledger, so every ledger entry seen here was written by the test.
 */

const crypto = require('crypto');
const { createPool } = require('../db/connection');
const { resetDatabase, insertReferenceData } = require('../db/reset');
const { REFERENCE_DATA } = require('../db/seed/seed');
const hashEngine = require('../integrity/hashEngine');
const { createLedgerService } = require('../ledger/ledgerService');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const RX_MEDICINE = Object.freeze({
  drugName: 'Paracetamol',
  drugClass: 'analgesic',
  dosageValue: '500',
  dosageUnit: 'mg',
  frequency: 'every 6 hours',
  durationDays: 3,
  quantityPrescribed: 12,
});

/** Module 14 input shape: a one-medicine prescription, with optional prescription-level and medicine overrides. */
const rx = (overrides = {}, medicineOverrides = {}) => ({
  patientId: 'PAT-001',
  providerId: 'PRV-001',
  ...overrides,
  medicines: [{ ...RX_MEDICINE, ...medicineOverrides }],
});
const RX = Object.freeze(rx());

let pool;
let ledger;
let recordingLedger; // real ledger whose anchorEntry is wrapped in jest.fn (calls + returned ids are observable)
let repository;
let service;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  ledger = createLedgerService(pool);
  recordingLedger = { ...ledger, anchorEntry: jest.fn((...args) => ledger.anchorEntry(...args)) };
  repository = createPrescriptionVersionRepository(pool, { ledger: recordingLedger });
  service = createAmendmentService(pool, { repository });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await insertReferenceData(pool, REFERENCE_DATA);
  recordingLedger.anchorEntry.mockClear();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function ledgerEntries(prescriptionId = null) {
  const where = prescriptionId ? 'WHERE prescription_id = ?' : '';
  const [rows] = await pool.execute(
    `SELECT ledger_entry_id, sequence_number, prescription_id, version_number, integrity_root,
            previous_entry_hash, entry_hash
       FROM ledger_entry ${where} ORDER BY sequence_number`,
    prescriptionId ? [prescriptionId] : [],
  );
  return rows;
}

async function count(table) {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return n;
}

// ids returned by every anchorEntry call since the last mockClear (including ones later rolled back)
async function anchoredIdsFromCalls() {
  return Promise.all(recordingLedger.anchorEntry.mock.results.map((r) => r.value));
}

/** medicine_id of the first medicine in the CURRENT version (medicine ids are per version). */
async function currentMedicineId(prescriptionId) {
  return (await repository.getLatestVersion(prescriptionId)).medicines[0].medicine_id;
}

async function createThreeVersionChain() {
  const v1 = await repository.createPrescription(RX);
  const v2 = await service.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v1.medicines[0].medicine_id, dosageValue: '650' }, 'PRV-001', 'Pain not controlled');
  const v3 = await service.amendPrescriptionAuthorized(v1.prescription_id, { medicineId: v2.medicines[0].medicine_id, durationDays: 5 }, 'PRV-001', 'Extend course');
  return [v1, v2, v3];
}

const otherRoot = (label) => crypto.createHash('sha256').update(`attacker:${label}`).digest('hex');

// ---------------------------------------------------------------------------
// 1. Clean chain
// ---------------------------------------------------------------------------

describe('1. clean ledger after create + 2 amendments', () => {
  test('verifyChainIntegrity() is intact, with 3 correctly linked entries', async () => {
    const versions = await createThreeVersionChain();
    const entries = await ledgerEntries();

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.ledger_entry_id)).toEqual(versions.map((v) => v.ledger_anchor_ref));
    expect(entries[0].previous_entry_hash).toBeNull();
    expect(entries[1].previous_entry_hash).toBe(entries[0].entry_hash);
    expect(entries[2].previous_entry_hash).toBe(entries[1].entry_hash);

    const result = await ledger.verifyChainIntegrity();
    console.log(
      `[TEST 1] ledger entries: ${entries.map((e) => `#${e.sequence_number} ${e.prescription_id} v${e.version_number} prev=${e.previous_entry_hash ? e.previous_entry_hash.slice(0, 10) : 'null'} hash=${e.entry_hash.slice(0, 10)}`).join(' | ')}\n` +
        `[TEST 1] verifyChainIntegrity() → ${JSON.stringify(result)}`,
    );
    expect(result).toEqual({ intact: true, brokenAtEntryId: null });
  });
});

// ---------------------------------------------------------------------------
// 2. Ledger entry tampered directly in SQL
// ---------------------------------------------------------------------------

describe('2. raw SQL mutation of one ledger entry', () => {
  test.each([
    ['first', 0],
    ['middle', 1],
    ['last (no successor link to break)', 2],
  ])('changing integrity_root of the %s entry is detected at exactly that entry', async (position, index) => {
    await createThreeVersionChain();
    const entries = await ledgerEntries();
    const target = entries[index];

    const [result] = await pool.execute('UPDATE ledger_entry SET integrity_root = ? WHERE ledger_entry_id = ?', [
      otherRoot(position),
      target.ledger_entry_id,
    ]);
    expect(result.affectedRows).toBe(1);

    const verification = await ledger.verifyChainIntegrity();
    console.log(
      `[TEST 2 · ${position}] tampered entry #${target.sequence_number} id=${target.ledger_entry_id} ` +
        `integrity_root ${target.integrity_root.slice(0, 10)}… → ${otherRoot(position).slice(0, 10)}…\n` +
        `[TEST 2 · ${position}] verifyChainIntegrity() → ${JSON.stringify(verification)}`,
    );
    expect(verification).toEqual({ intact: false, brokenAtEntryId: target.ledger_entry_id });

    // Entries strictly before the tampered one still verify.
    if (index > 0) {
      expect(await ledger.verifyChainIntegrity(entries[index - 1].ledger_entry_id)).toEqual({ intact: true, brokenAtEntryId: null });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Prescription row tampered, ledger untouched
// ---------------------------------------------------------------------------

describe('3. verifyAnchor on a tampered prescription row', () => {
  test('raw dosage edit → integrityRootMatch false while chainIntact stays true', async () => {
    const clean = await repository.createPrescription(RX);
    expect(await ledger.verifyAnchor(clean.prescription_id, 1)).toEqual({
      anchored: true,
      integrityRootMatch: true,
      chainIntact: true,
      anchoredAt: expect.any(Date),
    });

    // Same pattern as Module 2's tamperDemo: bypass the repository entirely (Module 14: the dose lives on the medicine row).
    await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', ['5000', clean.medicines[0].medicine_id]);

    const result = await ledger.verifyAnchor(clean.prescription_id, 1);
    expect(result).toEqual({
      anchored: true,
      integrityRootMatch: false,
      chainIntact: true,
      anchoredAt: expect.any(Date),
    });

    // The row's own stored hashes still pinpoint the field (sloppy tamper).
    const row = await repository.getVersion(clean.prescription_id, 1);
    expect(hashEngine.verifyIntegrity(row, row.field_hashes, row.salt).tamperedFields).toEqual(['medicine_1.dosage_value']);
  });

  test('consistent rewrite of data + field_hashes + integrity_root is still caught by the anchor', async () => {
    const clean = await repository.createPrescription(RX);
    const forged = { ...clean, medicines: [{ ...clean.medicines[0], dosage_value: '5000.000' }] };
    const forgedHashes = hashEngine.computeFieldHashes(forged, clean.salt);
    // The data (medicine row) and the stored hashes + root (version row) are rewritten consistently.
    await pool.execute('UPDATE prescription_medicine SET dosage_value = ? WHERE medicine_id = ?', ['5000', clean.medicines[0].medicine_id]);
    await pool.execute('UPDATE prescription_version SET field_hashes = ?, integrity_root = ? WHERE id = ?', [
      JSON.stringify(forgedHashes),
      hashEngine.computeIntegrityRoot(forgedHashes),
      clean.id,
    ]);

    const row = await repository.getVersion(clean.prescription_id, 1);
    expect(hashEngine.verifyIntegrity(row, row.field_hashes, row.salt).valid).toBe(true); // DB-only check fooled
    expect(await ledger.verifyAnchor(clean.prescription_id, 1)).toMatchObject({
      anchored: true,
      integrityRootMatch: false,
      chainIntact: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Rejected amendments never reach the ledger
// ---------------------------------------------------------------------------

describe('4. rejected amendment attempts produce no ledger entry', () => {
  test.each([
    ['wrong provider', { dosageValue: '5000' }, 'PRV-002', 'NOT_AUTHORIZED_PROVIDER'],
    ['patientId change', { patientId: 'PAT-002' }, 'PRV-001', 'INVALID_AMENDMENT_FIELD'],
    ['drugName change', { drugName: 'Tramadol' }, 'PRV-001', 'INVALID_AMENDMENT_FIELD'],
    ['adding a medicine', { addMedicine: { drugName: 'Tramadol' } }, 'PRV-001', 'MEDICINE_SET_CHANGE_NOT_ALLOWED'],
  ])('%s', async (_label, fields, providerId, code) => {
    const v1 = await repository.createPrescription(RX);
    const changes = { medicineId: v1.medicines[0].medicine_id, ...fields };
    const entriesBefore = await ledgerEntries(v1.prescription_id);
    const totalBefore = await count('ledger_entry');
    recordingLedger.anchorEntry.mockClear();

    await expect(service.amendPrescriptionAuthorized(v1.prescription_id, changes, providerId, 'attempt')).rejects.toMatchObject({ code });

    expect(recordingLedger.anchorEntry).not.toHaveBeenCalled();
    expect(await ledgerEntries(v1.prescription_id)).toEqual(entriesBefore);
    expect(await count('ledger_entry')).toBe(totalBefore);
  });

  test('rejected revocation by an unauthorized provider produces no ledger entry', async () => {
    const v1 = await repository.createPrescription(RX);
    const totalBefore = await count('ledger_entry');
    recordingLedger.anchorEntry.mockClear();

    await expect(service.revokePrescription(v1.prescription_id, 'PRV-003', 'not mine')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_PROVIDER' });

    expect(recordingLedger.anchorEntry).not.toHaveBeenCalled();
    expect(await count('ledger_entry')).toBe(totalBefore);
  });
});

// ---------------------------------------------------------------------------
// 5. 1:1 between versions and ledger entries
// ---------------------------------------------------------------------------

describe('5. every version has exactly one ledger entry, and vice versa', () => {
  test('mixed create / amend / delegated amend / revoke across several prescriptions', async () => {
    const a = await repository.createPrescription(RX);
    const b = await repository.createPrescription(rx({ patientId: 'PAT-002', providerId: 'PRV-002' }, { drugName: 'Atorvastatin', dosageValue: '20', frequency: 'once daily', durationDays: 30, drugClass: 'statin' }));
    const c = await repository.createPrescription(rx({ patientId: 'PAT-003' }, { drugName: 'Metformin', frequency: 'twice daily', durationDays: 30, drugClass: 'biguanide' }));
    // Amend the (single) medicine of the prescription's CURRENT version.
    const amend = async (prescription, fields, providerId, reason) =>
      service.amendPrescriptionAuthorized(prescription.prescription_id, { medicineId: await currentMedicineId(prescription.prescription_id), ...fields }, providerId, reason);
    await pool.execute(
      'INSERT INTO delegated_amendments (prescription_id, delegated_provider_id, granted_by_provider_id) VALUES (?, ?, ?)',
      [b.prescription_id, 'PRV-001', 'PRV-002'],
    );

    await amend(a, { dosageValue: '650' }, 'PRV-001');
    await amend(b, { dosageValue: '40' }, 'PRV-001', 'delegate');
    await service.revokePrescription(c.prescription_id, 'PRV-001', 'Switched therapy');
    await amend(a, { frequency: 'every 8 hours' }, 'PRV-001');
    await amend(b, { durationDays: 60, quantityPrescribed: 60 }, 'PRV-002');
    await service.revokePrescription(a.prescription_id, 'PRV-001', 'Course complete');
    // plus some rejected noise that must not create anything
    await amend(c, { durationDays: 9 }, 'PRV-001').catch(() => {});
    await amend(b, { patientId: 'PAT-001' }, 'PRV-002').catch(() => {});

    const versions = await count('prescription_version');
    const entries = await count('ledger_entry');
    expect(versions).toBe(9); // a: create+2 amends+revoke = 4, b: create+2 amends = 3, c: create+revoke = 2; rejected attempts add nothing
    expect(entries).toBe(versions);

    const [[stats]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM prescription_version WHERE ledger_anchor_ref IS NULL) AS unanchored_versions,
        (SELECT COUNT(DISTINCT ledger_anchor_ref) FROM prescription_version) AS distinct_refs,
        (SELECT COUNT(*) FROM prescription_version p
           LEFT JOIN ledger_entry l ON l.ledger_entry_id = p.ledger_anchor_ref
          WHERE l.ledger_entry_id IS NULL) AS versions_without_entry,
        (SELECT COUNT(*) FROM ledger_entry l
           LEFT JOIN prescription_version p ON p.ledger_anchor_ref = l.ledger_entry_id
          WHERE p.id IS NULL) AS orphan_entries,
        (SELECT COUNT(*) FROM prescription_version p
           JOIN ledger_entry l ON l.ledger_entry_id = p.ledger_anchor_ref
          WHERE l.prescription_id <> p.prescription_id
             OR l.version_number <> p.version_number
             OR l.integrity_root <> p.integrity_root) AS mismatched_pairs`);

    expect(stats).toEqual({
      unanchored_versions: 0,
      distinct_refs: versions,
      versions_without_entry: 0,
      orphan_entries: 0,
      mismatched_pairs: 0,
    });
    expect(await ledger.verifyChainIntegrity()).toEqual({ intact: true, brokenAtEntryId: null });
  });
});

// ---------------------------------------------------------------------------
// 6. Rollback: anchor succeeded, version insert failed
// ---------------------------------------------------------------------------

describe('6. failed version insert leaves no orphaned ledger entry', () => {
  test.each([
    ['createPrescription with unknown patientId (FK)', async () => repository.createPrescription(rx({ patientId: 'PAT-GHOST' }))],
    ['amendPrescription with unknown amended_by_provider_id (FK)', async (existing) => repository.amendPrescription(existing.prescription_id, { medicineId: existing.medicines[0].medicine_id, durationDays: 9 }, 'PRV-GHOST')],
    ['insertRevocationVersion with unknown provider (FK)', async (existing) => repository.insertRevocationVersion(existing.prescription_id, 'PRV-GHOST', 'x')],
  ])('%s', async (_label, failingWrite) => {
    const existing = await repository.createPrescription(RX);
    const [lastCommitted] = (await ledgerEntries()).slice(-1);
    const entriesBefore = await count('ledger_entry');
    const versionsBefore = await count('prescription_version');
    recordingLedger.anchorEntry.mockClear();

    await expect(failingWrite(existing)).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    // anchorEntry really ran and returned an id inside the failed transaction...
    expect(recordingLedger.anchorEntry).toHaveBeenCalledTimes(1);
    const [rolledBackEntryId] = await anchoredIdsFromCalls();
    expect(rolledBackEntryId).toMatch(/^[0-9a-f-]{36}$/);
    // ...and that entry is gone, along with any version row.
    const [ghost] = await pool.execute('SELECT ledger_entry_id FROM ledger_entry WHERE ledger_entry_id = ?', [rolledBackEntryId]);
    expect(ghost).toHaveLength(0);
    expect(await count('ledger_entry')).toBe(entriesBefore);
    expect(await count('prescription_version')).toBe(versionsBefore);
    expect((await repository.getLatestVersion(existing.prescription_id)).status).toBe('active'); // supersede rolled back too

    // The next successful write links to the last COMMITTED entry, not the rolled-back one.
    const next = await repository.amendPrescription(existing.prescription_id, { medicineId: existing.medicines[0].medicine_id, durationDays: 4 });
    const nextEntry = (await ledgerEntries()).find((e) => e.ledger_entry_id === next.ledger_anchor_ref);
    expect(nextEntry.previous_entry_hash).toBe(lastCommitted.entry_hash);
    expect(await ledger.verifyChainIntegrity()).toEqual({ intact: true, brokenAtEntryId: null });
  });
});
