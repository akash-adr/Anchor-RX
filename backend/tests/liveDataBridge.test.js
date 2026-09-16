'use strict';

/**
 * Module 16 Step 1 — liveDataBridge query functions in isolation, against anchor_rx_test.
 *
 * Each test starts from an EMPTY prescription history (reference data only: patients, providers, pharmacies), so
 * every count below is exactly what the test created. A counting pool wrapper records each SQL statement the bridge
 * sends, to prove which checks hit the database and which are in-memory only.
 */

const { createPool } = require('../db/connection');
const { resetDatabase, insertReferenceData } = require('../db/reset');
const { REFERENCE_DATA } = require('../db/seed/seed');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../versioning/amendmentService');
const { createLiveDataBridge, NEUTRAL_RARITY } = require('../ml/liveDataBridge');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let repository;
let amendmentService;
let bridge;
const statements = []; // [sql, params] for every query the bridge sends

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
  repository = createPrescriptionVersionRepository(pool);
  amendmentService = createAmendmentService(pool, { repository });
  const countingPool = {
    execute: (sql, params) => {
      statements.push([sql, params]);
      return pool.execute(sql, params);
    },
  };
  bridge = createLiveDataBridge(countingPool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await insertReferenceData(pool, REFERENCE_DATA); // no prescriptions at all
  statements.length = 0;
});

const medicine = (drugName, drugClass) => ({ drugName, drugClass, dosageValue: '5', dosageUnit: 'mg', frequency: 'once daily', durationDays: 30, quantityPrescribed: 30 });
const prescribe = (patientId, providerId, ...medicines) => repository.createPrescription({ patientId, providerId, medicines });

// ── checkDrugClassDuplication ───────────────────────────────────────────────────────────────────────────────

describe('checkDrugClassDuplication', () => {
  test('an ACTIVE prescription in the same class for this patient → 1', async () => {
    await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', null, [])).resolves.toBe(1);
    // Another patient's anticoagulant is irrelevant.
    await expect(bridge.checkDrugClassDuplication('PAT-002', 'anticoagulant', null, [])).resolves.toBe(0);
  });

  test('the same setup with the existing prescription REVOKED → 0 (both a real Module 3 revocation and a raw status change)', async () => {
    const revokedViaModule3 = await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));
    await amendmentService.revokePrescription(revokedViaModule3.prescription_id, 'PRV-001', 'Switched therapy');
    // v1 is now 'amended', v2 (with a copied anticoagulant medicine row) is 'revoked' — neither is 'active'.
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', null, [])).resolves.toBe(0);

    const statusFlip = await prescribe('PAT-002', 'PRV-001', medicine('Apixaban', 'anticoagulant'));
    await expect(bridge.checkDrugClassDuplication('PAT-002', 'anticoagulant', null, [])).resolves.toBe(1);
    await pool.execute("UPDATE prescription_version SET status = 'revoked' WHERE id = ?", [statusFlip.id]);
    await expect(bridge.checkDrugClassDuplication('PAT-002', 'anticoagulant', null, [])).resolves.toBe(0);
  });

  test('two medicines in the SAME new submission sharing a class are flagged in memory — for a class with ZERO database rows, with no extra query', async () => {
    const [[{ matching }]] = await pool.query("SELECT COUNT(*) AS matching FROM prescription_medicine WHERE drug_class = 'antiplatelet'");
    expect(matching).toBe(0); // nothing in the database could produce this flag

    statements.length = 0;
    const flagged = await bridge.checkDrugClassDuplication('PAT-001', 'antiplatelet', null, [medicine('Clopidogrel', ' Antiplatelet ')]);
    expect(flagged).toBe(1);
    expect(statements).toHaveLength(1); // only the one COUNT query — the sibling check itself never touched the database
    expect(statements[0][0]).toMatch(/SELECT COUNT\(\*\)/);

    statements.length = 0;
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'antiplatelet', null, [medicine('Omeprazole', 'proton pump inhibitor')])).resolves.toBe(0);
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'antiplatelet', null, [])).resolves.toBe(0);
    expect(statements).toHaveLength(2); // still exactly one query per call, flagged or not
  });

  test('a database match returns 1 immediately, before looking at the submission', async () => {
    await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));
    const exploding = new Proxy([], { get: (target, key) => (key === Symbol.iterator || key === 'some' ? () => { throw new Error('siblings were read'); } : Reflect.get(target, key)) });
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', null, exploding)).resolves.toBe(1);
  });

  test('excludePrescriptionVersionId matching the only duplicate excludes it → 0; null omits the clause entirely', async () => {
    const only = await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));

    statements.length = 0;
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', only.id, [])).resolves.toBe(0);
    expect(statements[0][0]).toMatch(/pv\.id != \?/);
    expect(statements[0][1]).toEqual(['PAT-001', 'anticoagulant', only.id]);

    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', only.id + 999, [])).resolves.toBe(1); // a different id excludes nothing

    statements.length = 0;
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', null, [])).resolves.toBe(1);
    expect(statements[0][0]).not.toMatch(/pv\.id\s*!=/); // the exclusion clause is absent — never "pv.id != NULL"
    expect(statements[0][1]).toEqual(['PAT-001', 'anticoagulant']);
  });
});

// ── getPatientVelocity30d ───────────────────────────────────────────────────────────────────────────────────

describe('getPatientVelocity30d', () => {
  test('counts prescriptions issued to this patient in the last 30 days, as an integer', async () => {
    await expect(bridge.getPatientVelocity30d('PAT-001')).resolves.toBe(0);

    const a = await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));
    const b = await prescribe('PAT-001', 'PRV-002', medicine('Atorvastatin', 'statin'));
    await prescribe('PAT-002', 'PRV-001', medicine('Metformin', 'biguanide'));
    const velocity = await bridge.getPatientVelocity30d('PAT-001');
    expect(velocity).toBe(2);
    expect(Number.isInteger(velocity)).toBe(true);

    await pool.execute('UPDATE prescription_version SET created_at = NOW(3) - INTERVAL 31 DAY WHERE id = ?', [a.id]);
    await expect(bridge.getPatientVelocity30d('PAT-001')).resolves.toBe(1);

    // One per prescription (Step 2 decision): an amendment adds a version row, not a prescription.
    await repository.amendPrescription(b.prescription_id, { medicineId: b.medicines[0].medicine_id, durationDays: 60 });
    await expect(bridge.getPatientVelocity30d('PAT-001')).resolves.toBe(1);
  });
});

// ── rarity scores ───────────────────────────────────────────────────────────────────────────────────────────

describe('getProviderRarityScore', () => {
  test('exactly 0.5 with zero prior history', async () => {
    expect(NEUTRAL_RARITY).toBe(0.5);
    await expect(bridge.getProviderRarityScore('PRV-002', 'anticoagulant')).resolves.toBe(0.5);
  });

  test('8 of 10 of the provider\'s medicines in the class → exactly 0.2; other providers do not count', async () => {
    for (let i = 0; i < 8; i += 1) await prescribe('PAT-001', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    for (let i = 0; i < 2; i += 1) await prescribe('PAT-002', 'PRV-002', medicine('Atorvastatin', 'statin'));
    for (let i = 0; i < 5; i += 1) await prescribe('PAT-003', 'PRV-001', medicine('Rosuvastatin', 'statin')); // another provider

    await expect(bridge.getProviderRarityScore('PRV-002', 'anticoagulant')).resolves.toBe(0.2);
    await expect(bridge.getProviderRarityScore('PRV-002', 'ANTICOAGULANT')).resolves.toBe(0.2); // column collation is case-insensitive
    await expect(bridge.getProviderRarityScore('PRV-002', 'statin')).resolves.toBe(0.8);
    await expect(bridge.getProviderRarityScore('PRV-002', 'antiplatelet')).resolves.toBe(1);
    await expect(bridge.getProviderRarityScore('PRV-001', 'statin')).resolves.toBe(0);
  });
});

describe('getDrugRarityScore', () => {
  test('exactly 0.5 with zero prior history (empty prescription_medicine)', async () => {
    await expect(bridge.getDrugRarityScore('Warfarin')).resolves.toBe(0.5);
  });

  test('8 of 10 medicine rows are the drug → exactly 0.2', async () => {
    for (let i = 0; i < 8; i += 1) await prescribe('PAT-001', i % 2 ? 'PRV-001' : 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-001', medicine('Atorvastatin', 'statin'));
    await prescribe('PAT-003', 'PRV-002', medicine('Metformin', 'biguanide'));
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM prescription_medicine');
    expect(total).toBe(10);

    await expect(bridge.getDrugRarityScore('Warfarin')).resolves.toBe(0.2);
    await expect(bridge.getDrugRarityScore('Metformin')).resolves.toBe(0.9);
    await expect(bridge.getDrugRarityScore('Dabigatran')).resolves.toBe(1);
  });
});

test('invalid inputs are refused before any query', async () => {
  statements.length = 0;
  await expect(bridge.checkDrugClassDuplication('', 'anticoagulant', null, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', 'abc', [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(bridge.getProviderRarityScore('PRV-001', '  ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(bridge.getDrugRarityScore(null)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(statements).toEqual([]);
});

// ── buildFeatureInputs (Step 2) ─────────────────────────────────────────────────────────────────────────────

describe('buildFeatureInputs', () => {
  // History: PAT-001 has an active Warfarin (anticoagulant) from PRV-002. PRV-002 also wrote 2 Warfarin and 1 Ibuprofen
  // for PAT-002. So: PRV-002 = 4 medicine rows (3 anticoagulant, 1 nsaid); prescription_medicine = 4 rows (3 Warfarin, 1 Ibuprofen).
  async function history() {
    const existing = await prescribe('PAT-001', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Ibuprofen', 'nsaid'));
    return existing;
  }

  const draftMedicine = (drugName, drugClass, doseValue) => ({ drugName, drugClass, doseValue, doseUnit: 'mg', frequency: 'twice daily', duration: 7 });

  test('one feature object per medicine, in draft order, with exact real values from all four queries', async () => {
    await history();
    const [[before]] = await pool.query('SELECT (SELECT COUNT(*) FROM prescription_version) AS v, (SELECT COUNT(*) FROM prescription_medicine) AS m');
    statements.length = 0;

    const features = await bridge.buildFeatureInputs({
      patientId: 'PAT-001',
      providerId: 'PRV-002',
      heightCm: '172.5',
      weightKg: '68.40',
      medicines: [draftMedicine('Apixaban', 'anticoagulant', '5.000'), draftMedicine('Ibuprofen', 'nsaid', '400'), draftMedicine('Naproxen', 'nsaid', '250.125')],
    });

    expect(features).toEqual([
      // DB duplicate (PAT-001's active Warfarin); provider 3/4 anticoagulant → 0.25; Apixaban never prescribed → 1
      { medicine_index: 0, drug_name: 'Apixaban', drug_class: 'anticoagulant', dose_value: '5.000', dose_unit: 'mg', frequency: 'twice daily', duration_days: 7, height_cm: 172.5, weight_kg: 68.4, drug_combination_flag: 1, patient_velocity: 1, drug_rarity_score: 1, provider_rarity_score: 0.25 },
      // sibling duplicate (Naproxen, same draft); provider 1/4 nsaid → 0.75; Ibuprofen 1 of 4 rows → 0.75
      { medicine_index: 1, drug_name: 'Ibuprofen', drug_class: 'nsaid', dose_value: '400', dose_unit: 'mg', frequency: 'twice daily', duration_days: 7, height_cm: 172.5, weight_kg: 68.4, drug_combination_flag: 1, patient_velocity: 1, drug_rarity_score: 0.75, provider_rarity_score: 0.75 },
      { medicine_index: 2, drug_name: 'Naproxen', drug_class: 'nsaid', dose_value: '250.125', dose_unit: 'mg', frequency: 'twice daily', duration_days: 7, height_cm: 172.5, weight_kg: 68.4, drug_combination_flag: 1, patient_velocity: 1, drug_rarity_score: 1, provider_rarity_score: 0.75 },
    ]);
    // Python's existing keys are used for the two renamed inputs; no other risk-feature names are introduced.
    expect(Object.keys(features[0])).toEqual(expect.arrayContaining(['drug_combination_flag', 'patient_velocity', 'drug_rarity_score', 'provider_rarity_score']));
    expect(Object.keys(features[0]).some((key) => /duplication|velocity30d|pattern/i.test(key))).toBe(false);

    expect(statements).toHaveLength(1 + 3 * 3); // patient velocity ONCE, then duplication + both rarity queries per medicine
    const [[after]] = await pool.query('SELECT (SELECT COUNT(*) FROM prescription_version) AS v, (SELECT COUNT(*) FROM prescription_medicine) AS m');
    expect(after).toEqual(before); // read-only
  });

  test('a unique-class medicine with no sibling and no active match → drug_combination_flag 0; missing vitals → null', async () => {
    await history();
    const [features] = await bridge.buildFeatureInputs({ patientId: 'PAT-003', providerId: 'PRV-001', medicines: [draftMedicine('Cetirizine', 'antihistamine', '10')] });
    expect(features).toMatchObject({ drug_combination_flag: 0, patient_velocity: 0, provider_rarity_score: 0.5, drug_rarity_score: 1, height_cm: null, weight_kg: null });
  });

  test('existingPrescriptionVersionId (amending) excludes that version from the duplication check', async () => {
    const existing = await history();
    const draft = { patientId: 'PAT-001', providerId: 'PRV-002', medicines: [draftMedicine('Warfarin', 'anticoagulant', '5')] };
    expect((await bridge.buildFeatureInputs(draft))[0].drug_combination_flag).toBe(1);
    expect((await bridge.buildFeatureInputs({ ...draft, existingPrescriptionVersionId: existing.id }))[0].drug_combination_flag).toBe(0);
  });

  test('invalid drafts are refused before any query', async () => {
    statements.length = 0;
    await expect(bridge.buildFeatureInputs(null)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bridge.buildFeatureInputs({ patientId: 'PAT-001', providerId: 'PRV-001', medicines: [{ drugName: 'X', drugClass: '' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(statements).toEqual([]);
  });
});

// ── one count per prescription (Module 16 Step 2 decision) ─────────────────────────────────────────────────────

describe('one count per prescription', () => {
  test('amendments do not inflate rarity or velocity: only each prescription\'s current version counts', async () => {
    const rx = await prescribe('PAT-001', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Atorvastatin', 'statin'));
    await expect(bridge.getProviderRarityScore('PRV-002', 'anticoagulant')).resolves.toBe(0.5); // 1 of 2
    await expect(bridge.getDrugRarityScore('Warfarin')).resolves.toBe(0.5); // 1 of 2

    for (const durationDays of [31, 32, 33]) {
      const latest = await repository.getLatestVersion(rx.prescription_id);
      await repository.amendPrescription(rx.prescription_id, { medicineId: latest.medicines[0].medicine_id, durationDays });
    }
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM prescription_medicine');
    expect(n).toBe(5); // 4 Warfarin rows (v1..v4) + 1 Atorvastatin — row counting would now give 0.2

    await expect(bridge.getProviderRarityScore('PRV-002', 'anticoagulant')).resolves.toBe(0.5);
    await expect(bridge.getDrugRarityScore('Warfarin')).resolves.toBe(0.5);
    await expect(bridge.getPatientVelocity30d('PAT-001')).resolves.toBe(1);
  });

  test('a revoked prescription still counts toward rarity (it was prescribed) but never toward duplication', async () => {
    const rx = await prescribe('PAT-001', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Atorvastatin', 'statin'));
    await amendmentService.revokePrescription(rx.prescription_id, 'PRV-002', 'Stopped');

    await expect(bridge.getProviderRarityScore('PRV-002', 'anticoagulant')).resolves.toBe(0.5);
    await expect(bridge.getDrugRarityScore('Warfarin')).resolves.toBe(0.5);
    await expect(bridge.checkDrugClassDuplication('PAT-001', 'anticoagulant', null, [])).resolves.toBe(0);
  });
});

// ── Module 16 Step 3: completion gate ───────────────────────────────────────────────────────────────────────

describe('Step 3 gate', () => {
  test('3-medicine draft → exactly 3 feature objects, each reflecting ITS OWN medicine; shared values shared, per-medicine values differ', async () => {
    // History (one per prescription): PAT-001 has an active anticoagulant from PRV-002; PRV-002 also wrote 2 Atorvastatin
    // for PAT-002. → PRV-002: 3 prescriptions (1 anticoagulant, 2 statin). All current medicines: Warfarin 1, Atorvastatin 2.
    await prescribe('PAT-001', 'PRV-002', medicine('Warfarin', 'anticoagulant'));
    await prescribe('PAT-002', 'PRV-002', medicine('Atorvastatin', 'statin'));
    await prescribe('PAT-002', 'PRV-002', medicine('Atorvastatin', 'statin'));
    const draft = {
      patientId: 'PAT-001',
      providerId: 'PRV-002',
      heightCm: '160.0',
      weightKg: '55.25',
      medicines: [
        { drugName: 'Apixaban', drugClass: 'anticoagulant', doseValue: '5.000', doseUnit: 'mg', frequency: 'twice daily', duration: 30 },
        { drugName: 'Atorvastatin', drugClass: 'statin', doseValue: '40', doseUnit: 'mg', frequency: 'once daily', duration: 90 },
        { drugName: 'Cetirizine', drugClass: 'antihistamine', doseValue: '10', doseUnit: 'mcg', frequency: 'at night', duration: 7 },
      ],
    };

    const features = await bridge.buildFeatureInputs(draft);

    expect(features).toHaveLength(3);
    features.forEach((f, i) => {
      const own = draft.medicines[i];
      expect([f.medicine_index, f.drug_name, f.drug_class, f.dose_value, f.dose_unit, f.frequency, f.duration_days]).toEqual([i, own.drugName, own.drugClass, own.doseValue, own.doseUnit, own.frequency, own.duration]);
    });
    // Per-medicine live values (exact): flag, provider rarity, drug rarity.
    expect(features.map((f) => [f.drug_combination_flag, f.provider_rarity_score, f.drug_rarity_score])).toEqual([
      [1, 2 / 3, 1], // anticoagulant: PAT-001's active Warfarin; PRV-002 1 of 3 in class; Apixaban never prescribed
      [0, 1 / 3, 1 / 3], // statin: no statin for PAT-001; PRV-002 2 of 3; Atorvastatin 2 of 3 medicines
      [0, 1, 1], // antihistamine: nothing anywhere
    ]);
    expect(new Set(features.map((f) => JSON.stringify([f.drug_combination_flag, f.provider_rarity_score, f.drug_rarity_score]))).size).toBe(3); // not identical
    // Shared patient/provider-level values are the same for every medicine.
    expect(new Set(features.map((f) => `${f.patient_velocity}|${f.height_cm}|${f.weight_kg}`))).toEqual(new Set(['1|160|55.25']));
  });

  test('performance: a realistic 5-medicine draft over a 300-prescription history — buildFeatureInputs queries measured under 200 ms', async () => {
    const drugs = [
      ['Warfarin', 'anticoagulant'], ['Apixaban', 'anticoagulant'], ['Atorvastatin', 'statin'], ['Rosuvastatin', 'statin'],
      ['Metformin', 'biguanide'], ['Amlodipine', 'calcium channel blocker'], ['Amoxicillin', 'penicillin antibiotic'],
      ['Cefalexin', 'cephalosporin'], ['Ibuprofen', 'nsaid'], ['Paracetamol', 'analgesic'], ['Cetirizine', 'antihistamine'], ['Omeprazole', 'proton pump inhibitor'],
    ];
    const patients = ['PAT-001', 'PAT-002', 'PAT-003'];
    const providers = ['PRV-001', 'PRV-002'];
    for (let i = 0; i < 300; i += 1) {
      const [a, b] = [drugs[i % drugs.length], drugs[(i * 7 + 3) % drugs.length]];
      await prescribe(patients[i % 3], providers[i % 2], medicine(a[0], a[1]), medicine(b[0], b[1]));
    }
    const [[{ versions, medicines: medicineRows }]] = await pool.query('SELECT (SELECT COUNT(*) FROM prescription_version) AS versions, (SELECT COUNT(*) FROM prescription_medicine) AS medicines');
    expect([versions, medicineRows]).toEqual([300, 600]);

    const draft = {
      patientId: 'PAT-002',
      providerId: 'PRV-001',
      heightCm: '170.0',
      weightKg: '72.00',
      medicines: [drugs[0], drugs[2], drugs[4], drugs[8], drugs[8]].map(([drugName, drugClass]) => ({ drugName, drugClass, doseValue: '10', doseUnit: 'mg', frequency: 'once daily', duration: 30 })),
    };
    await bridge.buildFeatureInputs(draft); // warm-up (connection + plan cache), not measured

    const timings = [];
    for (let run = 0; run < 10; run += 1) {
      const started = process.hrtime.bigint();
      const features = await bridge.buildFeatureInputs(draft);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(features).toHaveLength(5);
    }
    const sorted = [...timings].sort((x, y) => x - y);
    console.log(`buildFeatureInputs, 5 medicines × 4 queries over 300 prescriptions / 600 medicines — ms per call: median ${sorted[5].toFixed(1)}, max ${sorted[9].toFixed(1)} (runs: ${timings.map((t) => t.toFixed(1)).join(', ')})`);
    expect(Math.max(...timings)).toBeLessThan(200);
  }, 120_000);

  test('brand-new patient AND brand-new provider → the neutral defaults through the full pipeline, without throwing', async () => {
    await pool.execute("INSERT INTO patient (patient_id, name, dob, weight) VALUES ('PAT-NEW', 'New Patient (synthetic)', '1990-01-01', NULL)");
    await pool.execute("INSERT INTO provider (provider_id, name, license_number, credentials, status) VALUES ('PRV-NEW', 'Dr. New (synthetic)', 'DEMO-MED-NEW', 'MBBS', 'active')");
    const draft = {
      patientId: 'PAT-NEW',
      providerId: 'PRV-NEW',
      medicines: [
        { drugName: 'Warfarin', drugClass: 'anticoagulant', doseValue: '5', doseUnit: 'mg', frequency: 'once daily', duration: 30 },
        { drugName: 'Cetirizine', drugClass: 'antihistamine', doseValue: '10', doseUnit: 'mg', frequency: 'once daily', duration: 7 },
      ],
    };
    const neutral = { drug_combination_flag: 0, patient_velocity: 0, provider_rarity_score: 0.5, drug_rarity_score: 0.5, height_cm: null, weight_kg: null };

    // No prescriptions in the database at all: every one of the four functions is at its neutral default.
    const empty = await bridge.buildFeatureInputs(draft);
    expect(empty).toHaveLength(2);
    empty.forEach((f) => expect(f).toMatchObject(neutral));

    // Other people's history exists: the patient- and provider-specific inputs stay neutral for the new pair; drug rarity is
    // global (it describes the medicine across all prescriptions), so it now reflects the table.
    await prescribe('PAT-001', 'PRV-001', medicine('Warfarin', 'anticoagulant'));
    const withOthers = await bridge.buildFeatureInputs(draft);
    expect(withOthers.map((f) => [f.drug_combination_flag, f.patient_velocity, f.provider_rarity_score, f.drug_rarity_score])).toEqual([
      [0, 0, 0.5, 0], // Warfarin is the only medicine prescribed so far
      [0, 0, 0.5, 1], // Cetirizine never prescribed
    ]);
  });
});
