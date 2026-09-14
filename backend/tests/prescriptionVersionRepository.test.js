'use strict';

/**
 * Isolation: runs against a separate database (TEST_DB_NAME, default anchor_rx_test),
 * wiped before every test. Transaction rollback is not usable here because
 * amendPrescription opens its own transaction and MySQL implicitly commits
 * an outer one on BEGIN.
 */

const { createPool } = require('../db/connection');
const { resetDatabase, insertReferenceData } = require('../db/reset');
const { createPrescriptionVersionRepository, RepositoryError } = require('../db/repositories/prescriptionVersionRepository');
const hashEngine = require('../integrity/hashEngine');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

const CLINICAL_FIELDS = ['dosage_value', 'dosage_unit', 'drug_name', 'frequency', 'duration_days', 'drug_class'];

const BASE_RX = Object.freeze({
  patient_id: 'PAT-T1',
  provider_id: 'PRV-T1',
  drug_name: 'Paracetamol',
  dosage_value: '500',
  dosage_unit: 'mg',
  frequency: 'twice daily',
  duration_days: 5,
  drug_class: 'analgesic',
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

async function createWithAmendments(count) {
  const v1 = await repo.createPrescription(BASE_RX);
  const doses = ['650', '750', '1000', '1250', '1500'];
  for (let i = 0; i < count; i += 1) {
    await repo.amendPrescription(v1.prescription_id, { dosage_value: doses[i] });
  }
  return v1;
}

describe('createPrescription', () => {
  test('creates version 1 with no parent, active status, and populated integrity data', async () => {
    const v1 = await repo.createPrescription(BASE_RX);

    expect(v1.prescription_id).toMatch(/^RX-\d{8}-[0-9A-F]{8}$/);
    expect(v1.version_number).toBe(1);
    expect(v1.parent_version_id).toBeNull();
    expect(v1.status).toBe('active');
    expect(v1.amended_at).toBeNull();
    expect(v1.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(v1.field_hashes).sort()).toEqual([...hashEngine.HASHED_FIELDS].sort());
    expect(v1.integrity_root).toBe(hashEngine.computeIntegrityRoot(v1.field_hashes));
    expect(hashEngine.verifyIntegrity(v1, v1.field_hashes, v1.salt).valid).toBe(true);
    // Module 4: every version is anchored in the same transaction; the ref points at a real ledger entry.
    expect(v1.ledger_anchor_ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [[entry]] = await pool.execute('SELECT prescription_id, version_number, integrity_root FROM ledger_entry WHERE ledger_entry_id = ?', [v1.ledger_anchor_ref]);
    expect(entry).toEqual({ prescription_id: v1.prescription_id, version_number: 1, integrity_root: v1.integrity_root });
    expect(v1.dosage_value).toBe('500.000'); // exact string, never a float
    expect(v1.amended_by_provider_id).toBeNull(); // version 1 is never "amended by" anyone
    expect(v1.reason).toBeNull();
  });

  test('accepts an explicit prescription_id', async () => {
    const v1 = await repo.createPrescription({ ...BASE_RX, prescription_id: 'RX-DEMO-0001' });
    expect(v1.prescription_id).toBe('RX-DEMO-0001');
  });
});

describe('amendPrescription immutability', () => {
  test('never mutates clinical fields (or placeholders) of the old row', async () => {
    const v1 = await repo.createPrescription(BASE_RX);

    // Overwrite v1's integrity columns with sentinel values, so we also prove amend leaves them alone.
    await pool.execute(
      'UPDATE prescription_version SET field_hashes = ?, integrity_root = ?, ledger_anchor_ref = ? WHERE id = ?',
      [JSON.stringify({ drug_name: 'a'.repeat(64) }), 'b'.repeat(64), 'MOCK-TX-0001', v1.id],
    );
    const snapshot = await repo.getVersionById(v1.id);

    // Module 3: only dosage_value, dosage_unit, frequency, duration_days are amendable.
    const v2 = await repo.amendPrescription(v1.prescription_id, {
      dosage_value: '5000',
      dosage_unit: 'mcg',
      frequency: 'every 8 hours',
      duration_days: 10,
    });
    const oldRow = await repo.getVersionById(v1.id);

    for (const field of CLINICAL_FIELDS) {
      expect({ field, value: oldRow[field] }).toEqual({ field, value: snapshot[field] });
    }
    for (const field of ['id', 'prescription_id', 'version_number', 'parent_version_id', 'patient_id', 'provider_id',
      'created_at', 'salt', 'field_hashes', 'integrity_root', 'ledger_anchor_ref']) {
      expect({ field, value: oldRow[field] }).toEqual({ field, value: snapshot[field] });
    }

    // Only allowed lifecycle transition on the old row.
    expect(snapshot.status).toBe('active');
    expect(snapshot.amended_at).toBeNull();
    expect(oldRow.status).toBe('amended');
    expect(oldRow.amended_at).toBeInstanceOf(Date);

    // New row carries the changes and its own freshly computed integrity data.
    expect(v2.dosage_value).toBe('5000.000');
    expect(v2.dosage_unit).toBe('mcg');
    expect(v2.frequency).toBe('every 8 hours');
    expect(v2.duration_days).toBe(10);
    // Identity fields are copied forward; provider_id stays the ORIGINAL prescriber.
    expect(v2.drug_name).toBe(snapshot.drug_name);
    expect(v2.drug_class).toBe(snapshot.drug_class);
    expect(v2.provider_id).toBe('PRV-T1');
    expect(v2.amended_by_provider_id).toBe('PRV-T1'); // defaults to the original provider
    expect(v2.status).toBe('active');
    expect(v2.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(v2.salt).not.toBe(oldRow.salt);
    expect(v2.integrity_root).not.toBe(oldRow.integrity_root);
    expect(v2.integrity_root).toBe(hashEngine.computeIntegrityRoot(v2.field_hashes));
    expect(hashEngine.verifyIntegrity(v2, v2.field_hashes, v2.salt).valid).toBe(true);
    expect(v2.ledger_anchor_ref).toMatch(/^[0-9a-f-]{36}$/); // Module 4: its own ledger entry
    expect(v2.ledger_anchor_ref).not.toBe(oldRow.ledger_anchor_ref);
  });

  test('copies forward unchanged fields into the new version', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const v2 = await repo.amendPrescription(v1.prescription_id, { duration_days: 7 });

    expect(v2.duration_days).toBe(7);
    expect(v2.amended_by_provider_id).toBe(v1.provider_id);
    expect(v2.reason).toBeNull();
    for (const field of ['patient_id', 'provider_id', 'drug_name', 'dosage_value', 'dosage_unit', 'frequency', 'drug_class']) {
      expect({ field, value: v2[field] }).toEqual({ field, value: v1[field] });
    }
  });
});

describe('version chain', () => {
  test('getPrescriptionChain returns strictly ascending version_number after multiple amendments', async () => {
    const v1 = await createWithAmendments(4);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);

    expect(chain).toHaveLength(5);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i].version_number).toBeGreaterThan(chain[i - 1].version_number);
    }
  });

  test('version_number increments by exactly 1 across 3+ sequential amendments', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    const numbers = [v1.version_number];
    for (const dose of ['650', '750', '1000']) {
      const next = await repo.amendPrescription(v1.prescription_id, { dosage_value: dose });
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
    await pool.execute(
      "UPDATE prescription_version SET created_at = '2037-12-31 23:59:59.000' WHERE id = ?",
      [v1.id],
    );

    const [[newestByTime]] = await pool.execute(
      'SELECT version_number FROM prescription_version WHERE prescription_id = ? ORDER BY created_at DESC LIMIT 1',
      [v1.prescription_id],
    );
    expect(newestByTime.version_number).toBe(1);

    const latest = await repo.getLatestVersion(v1.prescription_id);
    expect(latest.version_number).toBe(4);
    expect(latest.status).toBe('active');
  });

  test('returns null for an unknown prescription', async () => {
    expect(await repo.getLatestVersion('RX-DOES-NOT-EXIST')).toBeNull();
  });
});

describe('guards', () => {
  test.each([
    ['status', { status: 'dispensed' }],
    ['version_number', { version_number: 9 }],
    ['integrity_root', { integrity_root: 'x' }],
    ['patient_id', { patient_id: 'PAT-T1' }],
    ['provider_id', { provider_id: 'PRV-T2' }],
    ['drug_name', { drug_name: 'Ibuprofen' }],
    ['drug_class', { drug_class: 'nsaid' }],
  ])('rejects amending non-amendable field %s', async (_label, changes) => {
    const v1 = await repo.createPrescription(BASE_RX);
    await expect(repo.amendPrescription(v1.prescription_id, changes)).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
    expect(await repo.getPrescriptionChain(v1.prescription_id)).toHaveLength(1);
  });

  test('rejects a no-op amendment without creating a version', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    await expect(repo.amendPrescription(v1.prescription_id, { dosage_value: '500.000' })).rejects.toMatchObject({ code: 'NO_CHANGES' });
    expect(await repo.getPrescriptionChain(v1.prescription_id)).toHaveLength(1);
  });

  test('rejects amending a prescription that does not exist', async () => {
    await expect(repo.amendPrescription('RX-NOPE-0001', { duration_days: 3 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('rejects amending a non-active latest version and rolls back fully', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    await pool.execute("UPDATE prescription_version SET status = 'dispensed' WHERE id = ?", [v1.id]);

    await expect(repo.amendPrescription(v1.prescription_id, { duration_days: 9 })).rejects.toBeInstanceOf(RepositoryError);
    const chain = await repo.getPrescriptionChain(v1.prescription_id);
    expect(chain).toHaveLength(1);
    expect(chain[0].status).toBe('dispensed');
  });

  test('rejects an unknown amendedByProviderId via FK and leaves the chain untouched', async () => {
    const v1 = await repo.createPrescription(BASE_RX);
    await expect(repo.amendPrescription(v1.prescription_id, { duration_days: 9 }, 'PRV-GHOST')).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    const chain = await repo.getPrescriptionChain(v1.prescription_id);
    expect(chain).toHaveLength(1);
    expect(chain[0].status).toBe('active'); // supersede UPDATE was rolled back
  });
});
