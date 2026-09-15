'use strict';

/**
 * Module 1 repository — multi-medicine shape (Module 14).
 *
 * Isolation: runs against a separate database (TEST_DB_NAME, default anchor_rx_test),
 * wiped before every test. Transaction rollback is not usable here because
 * amendPrescription opens its own transaction and MySQL implicitly commits
 * an outer one on BEGIN.
 */

const fs = require('fs');
const { createPool } = require('../db/connection');
const { resetDatabase, insertReferenceData } = require('../db/reset');
const { createPrescriptionVersionRepository, RepositoryError } = require('../db/repositories/prescriptionVersionRepository');
const hashEngine = require('../integrity/hashEngine');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const MEDICINE_COLUMNS = ['drug_name', 'drug_class', 'dosage_value', 'dosage_unit', 'frequency', 'duration_days', 'quantity_prescribed'];

const BASE_RX = Object.freeze({
  patientId: 'PAT-T1',
  providerId: 'PRV-T1',
  heightCm: 172.5,
  weightKg: '68.4',
  medicines: Object.freeze([
    Object.freeze({ drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: '500', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 5, quantityPrescribed: 10 }),
    Object.freeze({ drugName: 'Cetirizine', drugClass: 'antihistamine', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 7, quantityPrescribed: 7 }),
  ]),
});

let pool;
let repo;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repo = createPrescriptionVersionRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await insertReferenceData(pool, {
    providers: [
      { provider_id: 'PRV-T1', name: 'Test Provider 1', license_number: 'TEST-1', credentials: 'MBBS', status: 'active' },
      { provider_id: 'PRV-T2', name: 'Test Provider 2', license_number: 'TEST-2', credentials: 'MBBS', status: 'active' },
    ],
    patients: [{ patient_id: 'PAT-T1', name: 'Test Patient', dob: '1990-01-01' }],
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const medicineOf = (version, sequenceNumber) => version.medicines.find((m) => m.sequence_number === sequenceNumber);
// Clinical content of a medicine row: everything except its per-version ids and Module 15's locked_risk_* (asserted separately).
const clinical = (medicine) => {
  const { medicine_id: _id, prescription_version_id: _versionId, locked_risk_score: _score, locked_risk_band: _band, locked_risk_reasons: _reasons, ...rest } = medicine;
  return rest;
};

/** Amends the medicine at `sequenceNumber` of the CURRENT version (its medicine_id is re-read, since ids are per version). */
async function amendMedicine(prescriptionId, sequenceNumber, fields, ...rest) {
  const latest = await repo.getLatestVersion(prescriptionId);
  return repo.amendPrescription(prescriptionId, { medicineId: medicineOf(latest, sequenceNumber).medicine_id, ...fields }, ...rest);
}

async function createWithAmendments(count) {
  const v1 = await repo.createPrescription(BASE_RX);
  const doses = ['650', '750', '1000', '1250', '1500'];
  for (let i = 0; i < count; i += 1) {
    await amendMedicine(v1.prescription_id, 1, { dosageValue: doses[i] });
  }
  return v1;
}

async function countRows(table) {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(n);
}

const countAll = async () => ({
  versions: await countRows('prescription_version'),
  medicines: await countRows('prescription_medicine'),
  ledgerEntries: await countRows('ledger_entry'),
});

const expectedHashKeys = (medicineCount) => [
  ...hashEngine.HASHED_FIELDS,
  ...Array.from({ length: medicineCount }, (_, i) => hashEngine.MEDICINE_HASHED_FIELDS.map((f) => `medicine_${i + 1}.${f}`)).flat(),
];

// ── createPrescription ───────────────────────────────────────────────────────────────────────────────────

describe('createPrescription', () => {
  test('creates version 1 with its medicines in submission order, vitals, and integrity data covering every medicine', async () => {
    const v1 = await repo.createPrescription(BASE_RX);

    expect(v1.prescription_id).toMatch(/^RX-\d{8}-[0-9A-F]{8}$/);
    expect(v1).toMatchObject({ version_number: 1, parent_version_id: null, status: 'active', amended_at: null, amended_by_provider_id: null, reason: null });
    expect(v1).toMatchObject({ patient_id: 'PAT-T1', provider_id: 'PRV-T1', height_cm: '172.5', weight_kg: '68.40' });
    expect(v1).not.toHaveProperty('drug_name'); // flat drug columns are gone from the version row

    expect(v1.medicines).toHaveLength(2);
    expect(v1.medicines.map(clinical)).toEqual([
      { sequence_number: 1, drug_name: 'Paracetamol', drug_class: 'analgesic', dosage_value: '500.000', dosage_unit: 'mg', frequency: 'twice daily', duration_days: 5, quantity_prescribed: 10 },
      { sequence_number: 2, drug_name: 'Cetirizine', drug_class: 'antihistamine', dosage_value: '10.000', dosage_unit: 'mg', frequency: 'once daily', duration_days: 7, quantity_prescribed: 7 },
    ]);
    expect(v1.medicines.every((m) => m.prescription_version_id === v1.id)).toBe(true);
    // Created without lockedRisks → Module 15's locked_risk_* stay NULL.
    expect(v1.medicines.map((m) => [m.locked_risk_score, m.locked_risk_band, m.locked_risk_reasons])).toEqual([[null, null, null], [null, null, null]]);

    expect(v1.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(v1.field_hashes).sort()).toEqual(expectedHashKeys(2).sort()); // 4 + 7×2 keys
    expect(v1.integrity_root).toBe(hashEngine.computeIntegrityRoot(v1.field_hashes));
    expect(hashEngine.verifyIntegrity(v1, v1.field_hashes, v1.salt)).toEqual({ valid: true, tamperedFields: [], integrityRootMatch: true });

    // Module 4: anchored in the same transaction; the ref points at a real ledger entry with this root.
    expect(v1.ledger_anchor_ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [[entry]] = await pool.execute('SELECT prescription_id, version_number, integrity_root FROM ledger_entry WHERE ledger_entry_id = ?', [v1.ledger_anchor_ref]);
    expect(entry).toEqual({ prescription_id: v1.prescription_id, version_number: 1, integrity_root: v1.integrity_root });
  });

  test('sequence_number is the SUBMITTED position; reordering medicines afterwards is detected as tampering', async () => {
    const submitted = ['Zinc sulfate', 'Amoxicillin', 'Cetirizine'];
    const v1 = await repo.createPrescription({
      ...BASE_RX,
      medicines: submitted.map((drugName, i) => ({ ...BASE_RX.medicines[0], drugName, dosageValue: String((i + 1) * 100) })),
    });
    expect(v1.medicines.map((m) => [m.sequence_number, m.drug_name])).toEqual([[1, 'Zinc sulfate'], [2, 'Amoxicillin'], [3, 'Cetirizine']]);
    const [dbOrder] = await pool.execute('SELECT drug_name FROM prescription_medicine WHERE prescription_version_id = ? ORDER BY sequence_number', [v1.id]);
    expect(dbOrder.map((r) => r.drug_name)).toEqual(submitted);

    // Swap medicines 1 and 2 by editing sequence_number directly (bypassing the repository).
    const [m1, m2] = v1.medicines;
    await pool.execute('UPDATE prescription_medicine SET sequence_number = 99 WHERE medicine_id = ?', [m1.medicine_id]);
    await pool.execute('UPDATE prescription_medicine SET sequence_number = 1 WHERE medicine_id = ?', [m2.medicine_id]);
    await pool.execute('UPDATE prescription_medicine SET sequence_number = 2 WHERE medicine_id = ?', [m1.medicine_id]);

    const reread = await repo.getVersionById(v1.id);
    expect(reread.medicines.map((m) => m.drug_name)).toEqual(['Amoxicillin', 'Zinc sulfate', 'Cetirizine']); // ordered by sequence_number
    const result = hashEngine.verifyIntegrity(reread, reread.field_hashes, reread.salt);
    expect(result.valid).toBe(false);
    expect(result.tamperedFields).toEqual(['medicine_1.drug_name', 'medicine_1.dosage_value', 'medicine_2.drug_name', 'medicine_2.dosage_value']);
  });

  test('vitals are optional, stored as NULL, and still hashed (recording one later is detected)', async () => {
    const { heightCm: _h, weightKg: _w, ...withoutVitals } = BASE_RX;
    const v1 = await repo.createPrescription(withoutVitals);
    expect(v1).toMatchObject({ height_cm: null, weight_kg: null });
    expect(v1.field_hashes).toHaveProperty('height_cm');
    expect(v1.field_hashes).toHaveProperty('weight_kg');
    expect(hashEngine.verifyIntegrity(v1, v1.field_hashes, v1.salt).valid).toBe(true);

    await pool.execute('UPDATE prescription_version SET weight_kg = 70 WHERE id = ?', [v1.id]);
    const tampered = await repo.getVersionById(v1.id);
    expect(hashEngine.verifyIntegrity(tampered, tampered.field_hashes, tampered.salt).tamperedFields).toEqual(['weight_kg']);
  });

  test('accepts an explicit prescriptionId', async () => {
    const v1 = await repo.createPrescription({ ...BASE_RX, prescriptionId: 'RX-DEMO-0001' });
    expect(v1.prescription_id).toBe('RX-DEMO-0001');
  });

  test.each([
    ['an empty medicines list', { ...BASE_RX, medicines: [] }, 'NO_MEDICINES', /at least one medicine/],
    ['no medicines key', (({ medicines: _m, ...rest }) => rest)(BASE_RX), 'MISSING_FIELD', /medicines/],
    ['medicines that is not an array', { ...BASE_RX, medicines: { drugName: 'x' } }, 'INVALID_INPUT', /array/],
    ['a medicine with dosage 0', { ...BASE_RX, medicines: [{ ...BASE_RX.medicines[0], dosageValue: '0' }] }, 'INVALID_FIELD', /medicine 1 dosageValue/],
    ['a medicine missing quantityPrescribed', { ...BASE_RX, medicines: [BASE_RX.medicines[0], (({ quantityPrescribed: _q, ...m }) => m)(BASE_RX.medicines[1])] }, 'MISSING_FIELD', /medicine 2: missing required field quantityPrescribed/],
    ['an unknown medicine field', { ...BASE_RX, medicines: [{ ...BASE_RX.medicines[0], route: 'iv' }] }, 'FIELD_NOT_ALLOWED', /route/],
    ['the old flat drug fields at prescription level', { ...BASE_RX, drugName: 'Paracetamol' }, 'FIELD_NOT_ALLOWED', /drugName/],
    ['weightKg beyond the column precision', { ...BASE_RX, weightKg: '68.456' }, 'INVALID_FIELD', /weightKg/],
    ['a missing patientId', (({ patientId: _p, ...rest }) => rest)(BASE_RX), 'MISSING_FIELD', /patientId/],
  ])('rejects %s and writes nothing', async (_label, input, code, message) => {
    const before = await countAll();
    await expect(repo.createPrescription(input)).rejects.toMatchObject({ name: 'RepositoryError', code, message: expect.stringMatching(message) });
    expect(await countAll()).toEqual(before);
  });

  test('ATOMIC: a failure inserting the 2nd medicine rolls back the version row, every medicine row and the ledger entry', async () => {
    const failingPool = createPool({ database: TEST_DB_NAME });
    const realGetConnection = failingPool.getConnection.bind(failingPool);
    failingPool.getConnection = async () => {
      const conn = await realGetConnection();
      const execute = conn.execute.bind(conn);
      conn.execute = (sql, params) =>
        /INSERT INTO prescription_medicine/.test(sql) && params[1] === 2 ? Promise.reject(new Error('simulated failure inserting medicine 2')) : execute(sql, params);
      return conn;
    };
    const before = await countAll();
    try {
      await expect(createPrescriptionVersionRepository(failingPool).createPrescription(BASE_RX)).rejects.toThrow('simulated failure inserting medicine 2');
    } finally {
      await failingPool.end();
    }
    expect(await countAll()).toEqual(before); // version, medicine 1 and the ledger entry were all rolled back

    const ok = await repo.createPrescription(BASE_RX); // and the ledger mutex was released
    expect(ok.medicines).toHaveLength(2);
  });
});

// ── amendPrescription ────────────────────────────────────────────────────────────────────────────────────

describe('amendPrescription immutability', () => {
  test('never mutates the old version or ANY of its medicine rows; every medicine is copied forward into new rows', async () => {
    const v1 = await repo.createPrescription(BASE_RX);

    // Overwrite v1's integrity columns with sentinel values, so we also prove amend leaves them alone.
    await pool.execute('UPDATE prescription_version SET field_hashes = ?, integrity_root = ?, ledger_anchor_ref = ? WHERE id = ?', [
      JSON.stringify({ patient_id: 'a'.repeat(64) }),
      'b'.repeat(64),
      'MOCK-TX-0001',
      v1.id,
    ]);
    const snapshot = await repo.getVersionById(v1.id);

    // Module 3 / 14: one medicine per amendment; only its dose, unit, frequency, duration and quantity are amendable.
    const v2 = await amendMedicine(v1.prescription_id, 2, { dosageValue: '20', dosageUnit: 'mcg', frequency: 'twice daily', durationDays: 10, quantityPrescribed: 20 });
    const oldRow = await repo.getVersionById(v1.id);

    // Old version: identical in every column and in every medicine row (ids and values) — except the lifecycle pair.
    const { status: s0, amended_at: a0, ...stableSnapshot } = snapshot;
    const { status: s1, amended_at: a1, ...stableOldRow } = oldRow;
    expect(stableOldRow).toEqual(stableSnapshot);
    expect([s0, a0]).toEqual(['active', null]);
    expect(s1).toBe('amended');
    expect(a1).toBeInstanceOf(Date);
    expect(await countRows('prescription_medicine')).toBe(4); // 2 rows per version

    // New version: its own medicine rows (new ids), same sequence numbers; medicine 1 copied unchanged, medicine 2 amended.
    expect(v2.medicines.map((m) => m.sequence_number)).toEqual([1, 2]);
    for (const medicine of v2.medicines) {
      expect(medicine.prescription_version_id).toBe(v2.id);
      expect(oldRow.medicines.map((m) => m.medicine_id)).not.toContain(medicine.medicine_id);
    }
    expect(clinical(medicineOf(v2, 1))).toEqual(clinical(medicineOf(oldRow, 1)));
    expect(clinical(medicineOf(v2, 2))).toEqual({
      sequence_number: 2, drug_name: 'Cetirizine', drug_class: 'antihistamine', dosage_value: '20.000', dosage_unit: 'mcg', frequency: 'twice daily', duration_days: 10, quantity_prescribed: 20,
    });

    // Prescription fields are copied forward; provider_id stays the ORIGINAL prescriber.
    expect(v2).toMatchObject({ patient_id: 'PAT-T1', provider_id: 'PRV-T1', height_cm: '172.5', weight_kg: '68.40', amended_by_provider_id: 'PRV-T1', status: 'active' });

    // Fresh integrity data of its own, covering both medicines, anchored separately.
    expect(v2.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(v2.salt).not.toBe(oldRow.salt);
    expect(Object.keys(v2.field_hashes).sort()).toEqual(expectedHashKeys(2).sort());
    expect(v2.integrity_root).toBe(hashEngine.computeIntegrityRoot(v2.field_hashes));
    expect(hashEngine.verifyIntegrity(v2, v2.field_hashes, v2.salt).valid).toBe(true);
    expect(v2.ledger_anchor_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(v2.ledger_anchor_ref).not.toBe(oldRow.ledger_anchor_ref);
  });

  test('copies forward the unchanged medicine and prescription fields; quantityPrescribed alone is amendable', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const v2 = await amendMedicine(v1.prescription_id, 1, { quantityPrescribed: 14 });

    expect(medicineOf(v2, 1).quantity_prescribed).toBe(14);
    expect(v2.reason).toBeNull();
    for (const column of MEDICINE_COLUMNS.filter((c) => c !== 'quantity_prescribed')) {
      expect({ column, value: medicineOf(v2, 1)[column] }).toEqual({ column, value: medicineOf(v1, 1)[column] });
    }
    expect(clinical(medicineOf(v2, 2))).toEqual(clinical(medicineOf(v1, 2)));
    for (const field of ['patient_id', 'provider_id', 'height_cm', 'weight_kg']) {
      expect({ field, value: v2[field] }).toEqual({ field, value: v1[field] });
    }
  });

  test('a medicineId from an OLDER version is rejected (ids are per version) and nothing is written', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    await amendMedicine(v1.prescription_id, 1, { durationDays: 6 });
    const before = await countAll();

    await expect(
      repo.amendPrescription(v1.prescription_id, { medicineId: medicineOf(v1, 1).medicine_id, durationDays: 9 }),
    ).rejects.toMatchObject({ code: 'MEDICINE_NOT_IN_CURRENT_VERSION' });

    expect(await countAll()).toEqual(before);
    expect((await repo.getLatestVersion(v1.prescription_id)).version_number).toBe(2);
    expect((await repo.getLatestVersion(v1.prescription_id)).status).toBe('active'); // supersede rolled back
  });

  test('insertRevocationVersion copies every medicine forward unchanged into new rows', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const revoked = await repo.insertRevocationVersion(v1.prescription_id, 'PRV-T1', 'No longer needed');
    expect(revoked.status).toBe('revoked');
    expect(revoked.medicines.map(clinical)).toEqual(v1.medicines.map(clinical));
    expect(revoked.medicines.map((m) => m.medicine_id)).not.toEqual(v1.medicines.map((m) => m.medicine_id));
    expect(hashEngine.verifyIntegrity(revoked, revoked.field_hashes, revoked.salt).valid).toBe(true);
  });

  test('the repository has no code path that updates a medicine row, and exactly one that updates a version row', () => {
    const source = fs.readFileSync(require.resolve('../db/repositories/prescriptionVersionRepository'), 'utf8');
    expect(source.match(/UPDATE\s+prescription_medicine/gi)).toBeNull();
    expect(source.match(/UPDATE\s+prescription_version/gi)).toHaveLength(1); // SUPERSEDE_SQL (status, amended_at)
  });
});

// ── version chain ────────────────────────────────────────────────────────────────────────────────────────

describe('version chain', () => {
  test('getPrescriptionChain returns strictly ascending version_number after multiple amendments, each with its medicines', async () => {
    const v1 = await createWithAmendments(4);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);

    expect(chain).toHaveLength(5);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i].version_number).toBeGreaterThan(chain[i - 1].version_number);
    }
    expect(chain.map((v) => v.medicines.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chain.map((v) => medicineOf(v, 1).dosage_value)).toEqual(['500.000', '650.000', '750.000', '1000.000', '1250.000']);
  });

  test('version_number increments by exactly 1 across 3+ sequential amendments', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const numbers = [v1.version_number];
    for (const dose of ['650', '750', '1000']) {
      const next = await amendMedicine(v1.prescription_id, 1, { dosageValue: dose });
      numbers.push(next.version_number);
    }

    expect(numbers).toEqual([1, 2, 3, 4]);
    expect((await repo.getPrescriptionChain(v1.prescription_id)).map((v) => v.version_number)).toEqual([1, 2, 3, 4]);
  });

  test('parent_version_id points to the immediately preceding version row id', async () => {
    const v1 = await createWithAmendments(3);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);

    expect(chain[0].parent_version_id).toBeNull();
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i].parent_version_id).toBe(chain[i - 1].id);
    }
  });

  test('only the latest version is active; all earlier versions are amended', async () => {
    const v1 = await createWithAmendments(3);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);

    expect(chain.map((v) => v.status)).toEqual(['amended', 'amended', 'amended', 'active']);
  });

  test('chains of different prescriptions do not interleave', async () => {
    const a = await createWithAmendments(2);
    const b = await createWithAmendments(1);

    expect((await repo.getPrescriptionChain(a.prescription_id)).map((v) => v.version_number)).toEqual([1, 2, 3]);
    expect((await repo.getPrescriptionChain(b.prescription_id)).map((v) => v.version_number)).toEqual([1, 2]);
  });
});

describe('getLatestVersion', () => {
  test('returns the highest version_number, not the newest created_at', async () => {
    const v1 = await createWithAmendments(3);

    // Test-only fixture: push v1's timestamp to TIMESTAMP's max range (2038) so "newest by time" and
    // "highest version" disagree. Done with raw SQL because the repository cannot do it.
    await pool.execute("UPDATE prescription_version SET created_at = '2037-12-31 23:59:59.000' WHERE id = ?", [v1.id]);

    const [[newestByTime]] = await pool.execute(
      'SELECT version_number FROM prescription_version WHERE prescription_id = ? ORDER BY created_at DESC LIMIT 1',
      [v1.prescription_id],
    );
    expect(newestByTime.version_number).toBe(1);

    const latest = await repo.getLatestVersion(v1.prescription_id);
    expect(latest.version_number).toBe(4);
    expect(latest.status).toBe('active');
    expect(latest.medicines).toHaveLength(2);
  });

  test('returns null for an unknown prescription', async () => {
    expect(await repo.getLatestVersion('RX-DOES-NOT-EXIST')).toBeNull();
  });
});

// ── guards ───────────────────────────────────────────────────────────────────────────────────────────────

describe('guards', () => {
  test.each([
    ['status', { status: 'dispensed' }],
    ['versionNumber', { versionNumber: 9 }],
    ['integrityRoot', { integrityRoot: 'x' }],
    ['patientId', { patientId: 'PAT-T1' }],
    ['providerId', { providerId: 'PRV-T2' }],
    ['drugName', { drugName: 'Ibuprofen' }],
    ['drugClass', { drugClass: 'nsaid' }],
    ['heightCm', { heightCm: 180 }],
    ['weightKg', { weightKg: 90 }],
  ])('rejects amending non-amendable field %s', async (_label, fields) => {
    const v1 = await repo.createPrescription(BASE_RX);
    await expect(repo.amendPrescription(v1.prescription_id, { medicineId: medicineOf(v1, 1).medicine_id, ...fields })).rejects.toMatchObject({
      code: 'FIELD_NOT_ALLOWED',
    });
    expect(await repo.getPrescriptionChain(v1.prescription_id)).toHaveLength(1);
  });

  test.each([
    ['a replacement medicines list', () => ({ medicines: [BASE_RX.medicines[0]] })],
    ['addMedicine', () => ({ addMedicine: BASE_RX.medicines[0] })],
    ['removeMedicineId', (v1) => ({ removeMedicineId: medicineOf(v1, 2).medicine_id })],
    ['removeMedicine alongside a valid change', (v1) => ({ medicineId: medicineOf(v1, 1).medicine_id, dosageValue: '650', removeMedicine: true })],
  ])('rejects adding/removing a medicine (%s): requires a new prescription', async (_label, buildChanges) => {
    const v1 = await repo.createPrescription(BASE_RX);
    const before = await countAll();
    await expect(repo.amendPrescription(v1.prescription_id, buildChanges(v1))).rejects.toMatchObject({
      code: 'MEDICINE_SET_CHANGE_NOT_ALLOWED',
      message: expect.stringMatching(/Adding or removing a medicine requires a new prescription/),
    });
    expect(await countAll()).toEqual(before);
  });

  test.each([
    ['missing', { dosageValue: '650' }],
    ['a string', { medicineId: '12', dosageValue: '650' }],
    ['an array of ids', { medicineId: [1, 2], dosageValue: '650' }],
    ['zero', { medicineId: 0, dosageValue: '650' }],
  ])('rejects a medicineId that is %s', async (_label, changes) => {
    const v1 = await repo.createPrescription(BASE_RX);
    await expect(repo.amendPrescription(v1.prescription_id, changes)).rejects.toMatchObject({ code: 'MEDICINE_ID_REQUIRED' });
    expect(await repo.getPrescriptionChain(v1.prescription_id)).toHaveLength(1);
  });

  test('rejects a no-op amendment without creating a version (exact decimal and case-insensitive unit comparison)', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    for (const fields of [{ dosageValue: '10.000' }, { dosageUnit: 'MG' }, { quantityPrescribed: 7, durationDays: 7 }]) {
      await expect(amendMedicine(v1.prescription_id, 2, fields)).rejects.toMatchObject({ code: 'NO_CHANGES' });
    }
    expect(await repo.getPrescriptionChain(v1.prescription_id)).toHaveLength(1);
  });

  test('rejects amending a prescription that does not exist', async () => {
    await expect(repo.amendPrescription('RX-NOPE-0001', { medicineId: 1, durationDays: 3 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('rejects amending a non-active latest version and rolls back fully', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    await pool.execute("UPDATE prescription_version SET status = 'dispensed' WHERE id = ?", [v1.id]);

    await expect(amendMedicine(v1.prescription_id, 1, { durationDays: 9 })).rejects.toBeInstanceOf(RepositoryError);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);
    expect(chain).toHaveLength(1);
    expect(chain[0].status).toBe('dispensed');
  });

  test('rejects an unknown amendedByProviderId via FK and leaves the chain and medicine rows untouched', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const before = await countAll();
    await expect(amendMedicine(v1.prescription_id, 1, { durationDays: 9 }, 'PRV-GHOST')).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    expect(await countAll()).toEqual(before);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);
    expect(chain).toHaveLength(1);
    expect(chain[0].status).toBe('active'); // supersede UPDATE was rolled back
  });
});
