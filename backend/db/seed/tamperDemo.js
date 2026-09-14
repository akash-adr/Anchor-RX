'use strict';

/**
 * Tamper simulation for demo scenario B.
 *
 *   1. createPrescription (real repository) → legitimate row with correct salt/hashes/root.
 *   2. RAW SQL UPDATE of dosage_value only (500 → 5000), bypassing the repository on purpose,
 *      simulating an attacker or a buggy external system editing the database directly.
 *      salt, field_hashes and integrity_root are left as the ORIGINAL stored values.
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
const RAW_TAMPER_SQL = 'UPDATE prescription_version SET dosage_value = ? WHERE id = ?';

async function runTamperDemo(pool, { prescriptionId = TAMPER_PRESCRIPTION_ID } = {}) {
  // Demo prescription: deterministic salt so its original root is stable across rehearsals.
  const repo = createPrescriptionVersionRepository(pool, { generateSalt: deterministicDemoSalt });

  if (await repo.getLatestVersion(prescriptionId)) {
    throw new Error(`${prescriptionId} already exists — run "npm run seed" first to reset the demo database`);
  }

  const before = await repo.createPrescription({
    prescription_id: prescriptionId,
    patient_id: 'PAT-001',
    provider_id: 'PRV-001',
    drug_name: 'Paracetamol',
    dosage_value: ORIGINAL_DOSAGE,
    dosage_unit: 'mg',
    frequency: 'every 6 hours',
    duration_days: 3,
    drug_class: 'analgesic',
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

    console.log(`Database:        ${db}`);
    console.log(`prescription_id: ${prescriptionId}`);
    console.log(`version id:      ${versionId} (version_number ${after.version_number})`);
    console.log(`dosage_value:    ${before.dosage_value} ${before.dosage_unit} → ${after.dosage_value} ${after.dosage_unit}  (raw SQL, repository bypassed)`);
    console.log(`integrity_root:  ${after.integrity_root}  (unchanged: ${after.integrity_root === before.integrity_root})`);
    console.log('\nverifyIntegrity(current row, stored field_hashes, stored salt):');
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

module.exports = { runTamperDemo, TAMPER_PRESCRIPTION_ID, ORIGINAL_DOSAGE, TAMPERED_DOSAGE };
