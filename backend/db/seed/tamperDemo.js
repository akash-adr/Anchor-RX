'use strict';

/**
 * Tamper simulation for demo scenario B.
 *
 *   1. createPrescription (real repository) → legitimate version with correct salt/hashes/root.
 *   2. RAW SQL UPDATE of the first medicine's dosage_value only (500 → 5000), bypassing the repository on purpose,
 *      simulating an attacker or a buggy external system editing the database directly.
 *      salt, field_hashes and integrity_root are left as the ORIGINAL stored values.
 *   verifyIntegrity then reports it as "medicine_1.dosage_value".
 *
 * Usage: npm run seed && npm run demo:tamper
 * Requires reference data from the seed (PAT-001, PRV-001).
 */

const { createPool } = require('../connection');
const { createPrescriptionVersionRepository } = require('../repositories/prescriptionVersionRepository');
const { verifyIntegrity } = require('../../integrity/hashEngine');
const { deterministicDemoSalt } = require('./demoSalt');

const TAMPER_PRESCRIPTION_ID = 'RX-DEMO-0005';
const ORIGINAL_DOSAGE = '500';
const TAMPERED_DOSAGE = '5000';

// Deliberately NOT in the repository: this is the out-of-band edit the hashes must catch.
const RAW_TAMPER_SQL = 'UPDATE prescription_medicine SET dosage_value = ? WHERE prescription_version_id = ? AND sequence_number = 1';

async function runTamperDemo(pool, { prescriptionId = TAMPER_PRESCRIPTION_ID } = {}) {
  // Demo prescription: deterministic salt so its original root is stable across rehearsals.
  const repo = createPrescriptionVersionRepository(pool, { generateSalt: deterministicDemoSalt });

  if (await repo.getLatestVersion(prescriptionId)) {
    throw new Error(`${prescriptionId} already exists — run "npm run seed" first to reset the demo database`);
  }

  const before = await repo.createPrescription({
    prescriptionId,
    patientId: 'PAT-001',
    providerId: 'PRV-001',
    medicines: [
      { drugName: 'Paracetamol', drugClass: 'analgesic', dosageValue: ORIGINAL_DOSAGE, dosageUnit: 'mg', frequency: 'every 6 hours', durationDays: 3, quantityPrescribed: 12 },
    ],
  });

  const [result] = await pool.execute(RAW_TAMPER_SQL, [TAMPERED_DOSAGE, before.id]);
  if (result.affectedRows !== 1) {
    throw new Error(`Tamper UPDATE affected ${result.affectedRows} rows, expected 1`);
  }

  const after = await repo.getVersionById(before.id);
  return { prescriptionId, versionId: before.id, before, after };
}

async function main() {
  const pool = createPool();
  try {
    const { prescriptionId, versionId, before, after } = await runTamperDemo(pool);
    const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
    const [was, now] = [before.medicines[0], after.medicines[0]];

    console.log(`Database:        ${db}`);
    console.log(`prescription_id: ${prescriptionId}`);
    console.log(`version id:      ${versionId} (version_number ${after.version_number})`);
    console.log(`medicine_1:      ${was.drug_name} ${was.dosage_value} ${was.dosage_unit} → ${now.dosage_value} ${now.dosage_unit}  (raw SQL, repository bypassed)`);
    console.log(`integrity_root:  ${after.integrity_root}  (unchanged: ${after.integrity_root === before.integrity_root})`);
    console.log('\nverifyIntegrity(current row + medicines, stored field_hashes, stored salt):');
    console.log(JSON.stringify(verifyIntegrity(after, after.field_hashes, after.salt), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Tamper demo failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { runTamperDemo, TAMPER_PRESCRIPTION_ID, ORIGINAL_DOSAGE, TAMPERED_DOSAGE, RAW_TAMPER_SQL };
