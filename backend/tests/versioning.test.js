'use strict';

/**
 * Module 3 completion gate — versioning governance against a real MySQL database.
 *
 * Isolation: anchor_rx_test, fully reseeded before every test (demo prescriptions
 * RX-DEMO-0001..0004, providers PRV-001..003, empty amendment_attempts/delegated_amendments).
 *
 * Seed facts used below:
 *   RX-DEMO-0002  PAT-002  original provider PRV-002  Atorvastatin 20 mg
 *   RX-DEMO-0003  PAT-002  original provider PRV-001  Rosuvastatin 10 mg
 *   RX-DEMO-0004  PAT-003  original provider PRV-001  Metformin 500 mg twice daily 30 days
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');
const hashEngine = require('../integrity/hashEngine');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAuthorization } = require('../versioning/authorization');
const { createAmendmentService } = require('../versioning/amendmentService');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let baseRepo;
let repository; // baseRepo with every write function wrapped in a jest.fn so calls can be counted
let authorization;
let service;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  baseRepo = createPrescriptionVersionRepository(pool);
  repository = {
    ...baseRepo,
    createPrescription: jest.fn((...args) => baseRepo.createPrescription(...args)),
    amendPrescription: jest.fn((...args) => baseRepo.amendPrescription(...args)),
    insertRevocationVersion: jest.fn((...args) => baseRepo.insertRevocationVersion(...args)),
  };
  authorization = createAuthorization(pool, { repository });
  service = createAmendmentService(pool, { repository, authorization });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  repository.createPrescription.mockClear();
  repository.amendPrescription.mockClear();
  repository.insertRevocationVersion.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks(); // removes hashEngine spies created inside individual tests
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function totalVersionRows() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM prescription_version');
  return n;
}

async function attemptRows() {
  const [rows] = await pool.query(
    'SELECT prescription_id, requesting_provider_id, allowed, reason FROM amendment_attempts ORDER BY id',
  );
  return rows.map((r) => ({
    prescriptionId: r.prescription_id,
    provider: r.requesting_provider_id,
    allowed: Boolean(r.allowed),
    reason: r.reason,
  }));
}

async function grantDelegation(prescriptionId, delegateId, grantedById) {
  await pool.execute(
    'INSERT INTO delegated_amendments (prescription_id, delegated_provider_id, granted_by_provider_id) VALUES (?, ?, ?)',
    [prescriptionId, delegateId, grantedById],
  );
}

// No dispense function exists until the pharmacy module; simulate the status directly (test DB only).
async function markDispensed(prescriptionId) {
  const latest = await baseRepo.getLatestVersion(prescriptionId);
  await pool.execute("UPDATE prescription_version SET status = 'dispensed' WHERE id = ?", [latest.id]);
}

/**
 * Runs a rejected amendment attempt and asserts the module's core guarantee:
 * the attempt is logged as rejected, but NOTHING reaches the repository's write path or the
 * hash engine, and no prescription_version row is created.
 */
async function expectRejectedWithoutSideEffects({ prescriptionId, changes, providerId, code, message }) {
  const chainBefore = (await baseRepo.getPrescriptionChain(prescriptionId)).length;
  const rowsBefore = await totalVersionRows();
  const attemptsBefore = (await attemptRows()).length;

  // Counters reset and spies installed only now, after all fixture setup (which legitimately writes and hashes).
  repository.createPrescription.mockClear();
  repository.amendPrescription.mockClear();
  repository.insertRevocationVersion.mockClear();
  const fieldHashSpy = jest.spyOn(hashEngine, 'computeFieldHashes');
  const rootSpy = jest.spyOn(hashEngine, 'computeIntegrityRoot');
  const saltSpy = jest.spyOn(hashEngine, 'generateSalt');

  const expectedError = { code };
  if (message) expectedError.message = expect.stringMatching(message);
  await expect(
    service.amendPrescriptionAuthorized(prescriptionId, changes, providerId, 'attempted change'),
  ).rejects.toMatchObject(expectedError);

  // No hashing of any kind.
  expect(fieldHashSpy).not.toHaveBeenCalled();
  expect(rootSpy).not.toHaveBeenCalled();
  expect(saltSpy).not.toHaveBeenCalled();
  // No repository write was attempted.
  expect(repository.amendPrescription).not.toHaveBeenCalled();
  expect(repository.insertRevocationVersion).not.toHaveBeenCalled();
  expect(repository.createPrescription).not.toHaveBeenCalled();
  // No row created — neither in this chain nor anywhere in the table.
  expect((await baseRepo.getPrescriptionChain(prescriptionId)).length).toBe(chainBefore);
  expect(await totalVersionRows()).toBe(rowsBefore);
  // Exactly one new attempt row, logged as rejected with the matching reason.
  const attempts = await attemptRows();
  expect(attempts).toHaveLength(attemptsBefore + 1);
  expect(attempts[attempts.length - 1]).toEqual({ prescriptionId, provider: String(providerId), allowed: false, reason: code });
}

// ---------------------------------------------------------------------------
// 1. Non-original, non-delegated provider
// ---------------------------------------------------------------------------

describe('1. unauthorized provider', () => {
  test('canAmend rejects a provider who is neither original nor delegated', async () => {
    expect(await authorization.canAmend('RX-DEMO-0004', 'PRV-003')).toEqual({
      allowed: false,
      reason: 'NOT_AUTHORIZED_PROVIDER',
    });
  });

  test('a delegation granted for a DIFFERENT prescription does not authorize', async () => {
    await grantDelegation('RX-DEMO-0003', 'PRV-003', 'PRV-001');
    expect(await authorization.canAmend('RX-DEMO-0004', 'PRV-003')).toEqual({
      allowed: false,
      reason: 'NOT_AUTHORIZED_PROVIDER',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Delegated provider
// ---------------------------------------------------------------------------

describe('2. delegated provider', () => {
  test('is authorized and amends; amended_by is the delegate, provider_id stays the original', async () => {
    await grantDelegation('RX-DEMO-0004', 'PRV-002', 'PRV-001');

    expect(await authorization.canAmend('RX-DEMO-0004', 'PRV-002')).toEqual({
      allowed: true,
      reason: 'DELEGATED_PROVIDER',
    });

    const v2 = await service.amendPrescriptionAuthorized(
      'RX-DEMO-0004',
      { duration_days: 60 },
      'PRV-002',
      'Covering physician extended course',
    );
    const [v1] = await baseRepo.getPrescriptionChain('RX-DEMO-0004');

    expect(v2.version_number).toBe(2);
    expect(v2.amended_by_provider_id).toBe('PRV-002');
    expect(v2.provider_id).toBe(v1.provider_id);
    expect(v2.provider_id).toBe('PRV-001');
    expect(v2.reason).toBe('Covering physician extended course');
    expect(v2.duration_days).toBe(60);
    expect(hashEngine.verifyIntegrity(v2, v2.field_hashes, v2.salt).valid).toBe(true);

    expect(await attemptRows()).toEqual([
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-002', allowed: true, reason: 'DELEGATED_PROVIDER' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Non-amendable status
// ---------------------------------------------------------------------------

describe('3. dispensed or revoked prescriptions', () => {
  test('dispensed latest version → NOT_AMENDABLE_STATUS, even for the original provider', async () => {
    await markDispensed('RX-DEMO-0002');
    expect(await authorization.canAmend('RX-DEMO-0002', 'PRV-002')).toEqual({
      allowed: false,
      reason: 'NOT_AMENDABLE_STATUS',
    });
  });

  test('revoked latest version → NOT_AMENDABLE_STATUS, even for the original provider', async () => {
    await service.revokePrescription('RX-DEMO-0003', 'PRV-001', 'Duplicate statin therapy');
    expect(await authorization.canAmend('RX-DEMO-0003', 'PRV-001')).toEqual({
      allowed: false,
      reason: 'NOT_AMENDABLE_STATUS',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Identity-field changes
// ---------------------------------------------------------------------------

describe('4. patient_id / drug_name changes', () => {
  test.each([
    ['patient_id', { patient_id: 'PAT-001' }, /patient_id changes require a new prescription/],
    ['drug_name', { drug_name: 'Glipizide' }, /drug_name changes require a new prescription/],
    ['drug_name mixed with a valid dose change', { drug_name: 'Glipizide', dosage_value: '850' }, /drug_name changes require a new prescription/],
  ])('%s is rejected with a clear error and no new row', async (_label, changes, message) => {
    const chainBefore = await baseRepo.getPrescriptionChain('RX-DEMO-0004');

    await expect(
      service.amendPrescriptionAuthorized('RX-DEMO-0004', changes, 'PRV-001', 'attempted change'),
    ).rejects.toMatchObject({ code: 'INVALID_AMENDMENT_FIELD', message: expect.stringMatching(message) });

    const chainAfter = await baseRepo.getPrescriptionChain('RX-DEMO-0004');
    expect(chainAfter).toHaveLength(chainBefore.length);
    expect(chainAfter[chainAfter.length - 1].id).toBe(chainBefore[chainBefore.length - 1].id);
  });
});

// ---------------------------------------------------------------------------
// 5. Valid dosage amendment + diff
// ---------------------------------------------------------------------------

describe('5. valid dosage amendment by the original provider', () => {
  test('succeeds and diffVersions(1, 2) reports old/new dosage_value with unit', async () => {
    const v2 = await service.amendPrescriptionAuthorized('RX-DEMO-0004', { dosage_value: '1000' }, 'PRV-001', 'HbA1c above target');
    expect(v2.version_number).toBe(2);
    expect(v2.dosage_value).toBe('1000.000');
    expect(v2.amended_by_provider_id).toBe('PRV-001');

    expect(await service.diffVersions('RX-DEMO-0004', 1, 2)).toEqual({
      prescriptionId: 'RX-DEMO-0004',
      fromVersion: 1,
      toVersion: 2,
      changedFields: [{ field: 'dosage_value', old: '500.000', new: '1000.000', unit: 'mg' }],
      amendedBy: 'PRV-001',
      amendedAt: v2.created_at,
    });
  });

  test('dose + unit change reports both, with oldUnit on the dosage entry', async () => {
    await service.amendPrescriptionAuthorized('RX-DEMO-0004', { dosage_value: '850', dosage_unit: 'mcg' }, 'PRV-001');

    const { changedFields } = await service.diffVersions('RX-DEMO-0004', 1, 2);
    expect(changedFields).toEqual([
      { field: 'dosage_value', old: '500.000', new: '850.000', unit: 'mcg', oldUnit: 'mg' },
      { field: 'dosage_unit', old: 'mg', new: 'mcg' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Revocation
// ---------------------------------------------------------------------------

describe('6. revokePrescription by the original provider', () => {
  test('creates a revoked version with the reason, then blocks further amendments', async () => {
    const [v1] = await baseRepo.getPrescriptionChain('RX-DEMO-0004');
    const revoked = await service.revokePrescription('RX-DEMO-0004', 'PRV-001', 'Switched to insulin');

    expect(revoked.version_number).toBe(2);
    expect(revoked.status).toBe('revoked');
    expect(revoked.reason).toBe('Switched to insulin');
    expect(revoked.amended_by_provider_id).toBe('PRV-001');
    for (const field of hashEngine.HASHED_FIELDS) {
      expect({ field, value: revoked[field] }).toEqual({ field, value: v1[field] }); // clinical data unchanged
    }
    expect(hashEngine.verifyIntegrity(revoked, revoked.field_hashes, revoked.salt).valid).toBe(true);

    expect(await authorization.canAmend('RX-DEMO-0004', 'PRV-001')).toEqual({
      allowed: false,
      reason: 'NOT_AMENDABLE_STATUS',
    });
    expect(await service.getActiveVersion('RX-DEMO-0004')).toBeNull();
  });

  test('requires a reason', async () => {
    await expect(service.revokePrescription('RX-DEMO-0004', 'PRV-001', '  ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await baseRepo.getPrescriptionChain('RX-DEMO-0004')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. Provenance
// ---------------------------------------------------------------------------

describe('7. getFullProvenance on a 3-version chain', () => {
  test('returns the chain and exactly 2 diffs in order', async () => {
    const v1 = await baseRepo.createPrescription({
      patient_id: 'PAT-001',
      provider_id: 'PRV-002',
      drug_name: 'Lisinopril',
      dosage_value: '10',
      dosage_unit: 'mg',
      frequency: 'once daily',
      duration_days: 30,
      drug_class: 'ace inhibitor',
    });
    const id = v1.prescription_id;
    await service.amendPrescriptionAuthorized(id, { dosage_value: '20' }, 'PRV-002', 'BP not controlled');
    await service.amendPrescriptionAuthorized(id, { duration_days: 90 }, 'PRV-002', 'Stable, extend');

    const provenance = await service.getFullProvenance(id);

    expect(provenance.prescriptionId).toBe(id);
    expect(provenance.chain.map((v) => v.version_number)).toEqual([1, 2, 3]);
    expect(provenance.diffs).toHaveLength(2);
    expect(provenance.diffs.map((d) => [d.fromVersion, d.toVersion])).toEqual([[1, 2], [2, 3]]);
    expect(provenance.diffs[0].changedFields).toEqual([{ field: 'dosage_value', old: '10.000', new: '20.000', unit: 'mg' }]);
    expect(provenance.diffs[1].changedFields).toEqual([{ field: 'duration_days', old: 30, new: 90 }]);
  });
});

describe('8. getFullProvenance with a revoked version', () => {
  test('the revocation diff is { revoked, revokedBy, revokedReason }, not a field diff', async () => {
    await service.amendPrescriptionAuthorized('RX-DEMO-0004', { frequency: 'once daily' }, 'PRV-001');
    await service.revokePrescription('RX-DEMO-0004', 'PRV-001', 'Adverse GI effects');

    const { chain, diffs } = await service.getFullProvenance('RX-DEMO-0004');

    expect(chain.map((v) => v.status)).toEqual(['amended', 'amended', 'revoked']);
    expect(diffs).toHaveLength(2);
    expect(diffs[0].changedFields).toEqual([{ field: 'frequency', old: 'twice daily', new: 'once daily' }]);
    expect(diffs[1]).toEqual({
      prescriptionId: 'RX-DEMO-0004',
      fromVersion: 2,
      toVersion: 3,
      changedFields: [],
      revoked: true,
      revokedBy: 'PRV-001',
      revokedReason: 'Adverse GI effects',
      revokedAt: chain[2].created_at,
    });
    expect(diffs[1]).not.toHaveProperty('amendedBy');
  });
});

// ---------------------------------------------------------------------------
// 9. Attempt log completeness
// ---------------------------------------------------------------------------

describe('9. amendment_attempts records every attempt', () => {
  test('rejected attempts (tests 1, 3, 4) are logged allowed=false; the allowed dosage amendment (test 5) allowed=true', async () => {
    // Fixtures for test 3 (the revocation itself is an allowed, logged attempt).
    await markDispensed('RX-DEMO-0002');
    await service.revokePrescription('RX-DEMO-0003', 'PRV-001', 'Duplicate statin therapy');

    const attempt = (...args) => service.amendPrescriptionAuthorized(...args).catch((err) => err);
    await attempt('RX-DEMO-0004', { duration_days: 60 }, 'PRV-003');                  // 1
    await attempt('RX-DEMO-0002', { duration_days: 60 }, 'PRV-002');                  // 3 dispensed
    await attempt('RX-DEMO-0003', { duration_days: 60 }, 'PRV-001');                  // 3 revoked
    await attempt('RX-DEMO-0004', { patient_id: 'PAT-001' }, 'PRV-001');              // 4
    await attempt('RX-DEMO-0004', { drug_name: 'Glipizide' }, 'PRV-001');             // 4
    await service.amendPrescriptionAuthorized('RX-DEMO-0004', { dosage_value: '1000' }, 'PRV-001'); // 5

    expect(await attemptRows()).toEqual([
      { prescriptionId: 'RX-DEMO-0003', provider: 'PRV-001', allowed: true, reason: 'REVOCATION:ORIGINAL_PROVIDER' },
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-003', allowed: false, reason: 'NOT_AUTHORIZED_PROVIDER' },
      { prescriptionId: 'RX-DEMO-0002', provider: 'PRV-002', allowed: false, reason: 'NOT_AMENDABLE_STATUS' },
      { prescriptionId: 'RX-DEMO-0003', provider: 'PRV-001', allowed: false, reason: 'NOT_AMENDABLE_STATUS' },
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-001', allowed: false, reason: 'INVALID_AMENDMENT_FIELD' },
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-001', allowed: false, reason: 'INVALID_AMENDMENT_FIELD' },
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-001', allowed: true, reason: 'ORIGINAL_PROVIDER' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 10. THE CRITICAL GUARANTEE
// ---------------------------------------------------------------------------

describe('10. rejected attempts never reach hashing and never insert a row', () => {
  test.each([
    {
      label: '1 · non-original, non-delegated provider',
      setup: async () => {},
      prescriptionId: 'RX-DEMO-0004',
      changes: { dosage_value: '5000' },
      providerId: 'PRV-003',
      code: 'NOT_AUTHORIZED_PROVIDER',
    },
    {
      label: '3 · dispensed prescription',
      setup: () => markDispensed('RX-DEMO-0002'),
      prescriptionId: 'RX-DEMO-0002',
      changes: { dosage_value: '80' },
      providerId: 'PRV-002',
      code: 'NOT_AMENDABLE_STATUS',
    },
    {
      label: '3 · revoked prescription',
      setup: () => service.revokePrescription('RX-DEMO-0003', 'PRV-001', 'Duplicate statin therapy'),
      prescriptionId: 'RX-DEMO-0003',
      changes: { dosage_value: '40' },
      providerId: 'PRV-001',
      code: 'NOT_AMENDABLE_STATUS',
    },
    {
      label: '4 · patient_id change by the original provider',
      setup: async () => {},
      prescriptionId: 'RX-DEMO-0004',
      changes: { patient_id: 'PAT-001' },
      providerId: 'PRV-001',
      code: 'INVALID_AMENDMENT_FIELD',
      message: /patient_id changes require a new prescription/,
    },
    {
      label: '4 · drug_name change by the original provider',
      setup: async () => {},
      prescriptionId: 'RX-DEMO-0004',
      changes: { drug_name: 'Glipizide', dosage_value: '850' },
      providerId: 'PRV-001',
      code: 'INVALID_AMENDMENT_FIELD',
      message: /drug_name changes require a new prescription/,
    },
    {
      label: '4 · patient_id change even by a DELEGATED provider',
      setup: () => grantDelegation('RX-DEMO-0004', 'PRV-002', 'PRV-001'),
      prescriptionId: 'RX-DEMO-0004',
      changes: { patient_id: 'PAT-001' },
      providerId: 'PRV-002',
      code: 'INVALID_AMENDMENT_FIELD',
    },
  ])('$label', async ({ setup, ...scenario }) => {
    await setup();
    await expectRejectedWithoutSideEffects(scenario);
  });

  test('control: the same spies DO fire on an authorized amendment (proves the spies work)', async () => {
    const fieldHashSpy = jest.spyOn(hashEngine, 'computeFieldHashes');
    const rowsBefore = await totalVersionRows();

    await service.amendPrescriptionAuthorized('RX-DEMO-0004', { dosage_value: '1000' }, 'PRV-001');

    expect(fieldHashSpy).toHaveBeenCalledTimes(1);
    expect(repository.amendPrescription).toHaveBeenCalledTimes(1);
    expect(await totalVersionRows()).toBe(rowsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// 11. Delegated revocation
// ---------------------------------------------------------------------------

describe('11. delegated provider can revoke', () => {
  test('a delegate (not the original prescriber) revokes successfully', async () => {
    // Deliberate hackathon scope simplification, not an oversight: delegation is one undifferentiated trust tier (amend AND revoke), not split into amend-only vs. amend-and-revoke permissions.
    await grantDelegation('RX-DEMO-0004', 'PRV-002', 'PRV-001');
    const [v1] = await baseRepo.getPrescriptionChain('RX-DEMO-0004');

    const revoked = await service.revokePrescription('RX-DEMO-0004', 'PRV-002', 'Covering physician: switched to insulin');

    expect(revoked.version_number).toBe(2);
    expect(revoked.status).toBe('revoked');
    expect(revoked.reason).toBe('Covering physician: switched to insulin');
    expect(revoked.amended_by_provider_id).toBe('PRV-002'); // the delegate performed it
    expect(revoked.provider_id).toBe(v1.provider_id); // original prescriber unchanged
    expect(revoked.provider_id).toBe('PRV-001');
    expect(hashEngine.verifyIntegrity(revoked, revoked.field_hashes, revoked.salt).valid).toBe(true);

    expect(await attemptRows()).toEqual([
      { prescriptionId: 'RX-DEMO-0004', provider: 'PRV-002', allowed: true, reason: 'REVOCATION:DELEGATED_PROVIDER' },
    ]);
    expect(await authorization.canAmend('RX-DEMO-0004', 'PRV-002')).toEqual({
      allowed: false,
      reason: 'NOT_AMENDABLE_STATUS',
    });
  });
});
