'use strict';

/**
 * Module 1 demo seed. Wipes the target DB and rebuilds it.
 * Every prescription is a LEGITIMATE chain created through the repository —
 * tamper simulation belongs to Module 2.
 *
 * Module 14 note: converted to the multi-medicine shape with the SAME scenarios as before (one medicine each,
 * quantities added, vitals not recorded). New multi-medicine demo data belongs to the seed step of Module 14.
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
    // weight (kg) is synthetic; PAT-003 deliberately has none, to exercise the 70 kg placeholder in ML payloads.
    { patient_id: 'PAT-001', name: 'Demo Patient One', dob: '1985-04-12', weight: 68.5 },
    { patient_id: 'PAT-002', name: 'Demo Patient Two', dob: '1962-11-03', weight: 82.0 },
    { patient_id: 'PAT-003', name: 'Demo Patient Three', dob: '1978-07-21', weight: null },
  ],
  pharmacies: [
    { pharmacy_id: 'PHM-001', name: 'Demo Campus Pharmacy', license_number: 'DEMO-PHM-20001' },
    // Fictional names on purpose — no real pharmacy chains in demo data.
    { pharmacy_id: 'PHM-002', name: 'Marina Care Pharmacy — Tambaram (synthetic)', license_number: 'DEMO-PHM-20002' },
    { pharmacy_id: 'PHM-003', name: 'Harbour Health Chemists — Chennai Central (synthetic)', license_number: 'DEMO-PHM-20003' },
  ],
};

async function seed(pool) {
  // Deterministic salts: reseeding reproduces identical integrity roots for RX-DEMO-*.
  const repo = createPrescriptionVersionRepository(pool, { generateSalt: deterministicDemoSalt });

  await resetDatabase(pool);
  await insertReferenceData(pool, REFERENCE_DATA);

  // 1. RX-DEMO-0001 — clean prescription with one legitimate amendment (duration 5 → 7 days, quantity 15 → 21).
  const rx1 = await repo.createPrescription({
    prescriptionId: 'RX-DEMO-0001',
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [
      { drugName: 'Amoxicillin', drugClass: 'penicillin antibiotic', dosageValue: '500', dosageUnit: 'mg', frequency: 'three times daily', durationDays: 5, quantityPrescribed: 15 },
    ],
  });
  await repo.amendPrescription('RX-DEMO-0001', { medicineId: rx1.medicines[0].medicine_id, durationDays: 7, quantityPrescribed: 21 });

  // 2. Duplicate therapeutic class for PAT-002: two active statins (Module 8 anomaly input).
  await repo.createPrescription({
    prescriptionId: 'RX-DEMO-0002',
    patientId: 'PAT-002',
    providerId: 'PRV-002',
    medicines: [
      { drugName: 'Atorvastatin', drugClass: 'statin', dosageValue: '20', dosageUnit: 'mg', frequency: 'once daily', durationDays: 30, quantityPrescribed: 30 },
    ],
  });
  await repo.createPrescription({
    prescriptionId: 'RX-DEMO-0003',
    patientId: 'PAT-002',
    providerId: 'PRV-001',
    medicines: [
      { drugName: 'Rosuvastatin', drugClass: 'statin', dosageValue: '10', dosageUnit: 'mg', frequency: 'once daily', durationDays: 30, quantityPrescribed: 30 },
    ],
  });

  // 3. RX-DEMO-0004 — ordinary single-version prescription.
  await repo.createPrescription({
    prescriptionId: 'RX-DEMO-0004',
    patientId: 'PAT-003',
    providerId: 'PRV-001',
    medicines: [
      { drugName: 'Metformin', drugClass: 'biguanide', dosageValue: '500', dosageUnit: 'mg', frequency: 'twice daily', durationDays: 30, quantityPrescribed: 60 },
    ],
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
        const medicines = v.medicines
          .map((m) => `#${m.sequence_number} ${m.drug_name} ${m.dosage_value} ${m.dosage_unit}, ${m.frequency}, ${m.duration_days}d ×${m.quantity_prescribed} (${m.drug_class})`)
          .join(' | ');
        console.log(`${v.prescription_id} v${v.version_number} [${v.status.padEnd(7)}] ${v.patient_id} ${medicines} parent=${v.parent_version_id ?? '-'}`);
      }
    }

    const [dupes] = await pool.query(
      `SELECT pv.patient_id, pm.drug_class, COUNT(DISTINCT pv.prescription_id) AS active_count
         FROM prescription_version pv
         JOIN prescription_medicine pm ON pm.prescription_version_id = pv.id
        WHERE pv.status = 'active'
        GROUP BY pv.patient_id, pm.drug_class
       HAVING COUNT(DISTINCT pv.prescription_id) > 1`,
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
