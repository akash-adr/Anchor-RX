'use strict';

/**
 * Module 1 demo seed. Wipes the target DB and rebuilds it.
 * Every prescription is a LEGITIMATE chain created through the repository —
 * tamper simulation belongs to Module 2.
 *
 * Usage: npm run seed
 */

const { createPool } = require('../connection');
const { resetDatabase, insertReferenceData } = require('../reset');
const { createPrescriptionVersionRepository } = require('../repositories/prescriptionVersionRepository');
const { deterministicDemoSalt } = require('./demoSalt');

// Synthetic data only — no real people, licenses, or patients.
const REFERENCE_DATA = {
  providers: [
    { provider_id: 'PRV-001', name: 'Dr. Asha Verma (synthetic)', license_number: 'DEMO-MED-10001', credentials: 'MBBS, MD (General Medicine)', status: 'active' },
    { provider_id: 'PRV-002', name: 'Dr. Rohan Iyer (synthetic)', license_number: 'DEMO-MED-10002', credentials: 'MBBS, MD (Cardiology)', status: 'active' },
    { provider_id: 'PRV-003', name: 'Dr. Kiran Das (synthetic)', license_number: 'DEMO-MED-10003', credentials: 'MBBS', status: 'inactive' },
  ],
  patients: [
    { patient_id: 'PAT-001', name: 'Demo Patient One', dob: '1985-04-12' },
    { patient_id: 'PAT-002', name: 'Demo Patient Two', dob: '1962-11-03' },
    { patient_id: 'PAT-003', name: 'Demo Patient Three', dob: '1978-07-21' },
  ],
  pharmacies: [{ pharmacy_id: 'PHM-001', name: 'Demo Campus Pharmacy', license_number: 'DEMO-PHM-20001' }],
};

async function seed(pool) {
  // Deterministic salts: reseeding reproduces identical integrity roots for RX-DEMO-*.
  const repo = createPrescriptionVersionRepository(pool, { generateSalt: deterministicDemoSalt });

  await resetDatabase(pool);
  await insertReferenceData(pool, REFERENCE_DATA);

  // 1. RX-DEMO-0001 — clean prescription with one legitimate amendment (duration 5 → 7 days).
  await repo.createPrescription({
    prescription_id: 'RX-DEMO-0001',
    patient_id: 'PAT-001',
    provider_id: 'PRV-001',
    drug_name: 'Amoxicillin',
    dosage_value: '500',
    dosage_unit: 'mg',
    frequency: 'three times daily',
    duration_days: 5,
    drug_class: 'penicillin antibiotic',
  });
  await repo.amendPrescription('RX-DEMO-0001', { duration_days: 7 });

  // 2. Duplicate therapeutic class for PAT-002: two active statins (Module 8 anomaly input).
  await repo.createPrescription({
    prescription_id: 'RX-DEMO-0002',
    patient_id: 'PAT-002',
    provider_id: 'PRV-002',
    drug_name: 'Atorvastatin',
    dosage_value: '20',
    dosage_unit: 'mg',
    frequency: 'once daily',
    duration_days: 30,
    drug_class: 'statin',
  });
  await repo.createPrescription({
    prescription_id: 'RX-DEMO-0003',
    patient_id: 'PAT-002',
    provider_id: 'PRV-001',
    drug_name: 'Rosuvastatin',
    dosage_value: '10',
    dosage_unit: 'mg',
    frequency: 'once daily',
    duration_days: 30,
    drug_class: 'statin',
  });

  // 3. RX-DEMO-0004 — ordinary single-version prescription.
  await repo.createPrescription({
    prescription_id: 'RX-DEMO-0004',
    patient_id: 'PAT-003',
    provider_id: 'PRV-001',
    drug_name: 'Metformin',
    dosage_value: '500',
    dosage_unit: 'mg',
    frequency: 'twice daily',
    duration_days: 30,
    drug_class: 'biguanide',
  });

  return repo;
}

async function main() {
  const pool = createPool();
  try {
    const repo = await seed(pool);
    const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
    console.log(`Seeded database: ${db}\n`);

    for (const id of ['RX-DEMO-0001', 'RX-DEMO-0002', 'RX-DEMO-0003', 'RX-DEMO-0004']) {
      const chain = await repo.getPrescriptionChain(id);
      for (const v of chain) {
        console.log(
          `${v.prescription_id} v${v.version_number} [${v.status.padEnd(7)}] ` +
            `${v.patient_id} ${v.drug_name} ${v.dosage_value} ${v.dosage_unit}, ${v.frequency}, ` +
            `${v.duration_days}d (${v.drug_class}) parent=${v.parent_version_id ?? '-'}`,
        );
      }
    }

    const [dupes] = await pool.query(
      `SELECT patient_id, drug_class, COUNT(*) AS active_count
         FROM prescription_version
        WHERE status = 'active'
        GROUP BY patient_id, drug_class
       HAVING COUNT(*) > 1`,
    );
    console.log('\nActive duplicate drug classes:', dupes.map((d) => `${d.patient_id}/${d.drug_class} x${d.active_count}`).join(', '));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { seed, REFERENCE_DATA };
