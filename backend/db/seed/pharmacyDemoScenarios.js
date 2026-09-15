'use strict';

/**
 * Rehearsal seed for the Pharmacy Portal demo. RESETS the target database (like `npm run seed`), then
 * builds one persistent, reproducible example of every seeded scan outcome:
 *
 *   RX-DEMO-0001 v2 verified · RX-DEMO-0005 tampered (medicine_1.dosage_value) · RX-DEMO-0006 v1 stale_version ·
 *   RX-DEMO-0007 provider_identity_issue · RX-DEMO-0008 revoked · RX-DEMO-0009 forged
 *
 * Usage: npm run seed:demo   (then: npm run demo:payloads)
 */

const { createPool } = require('../connection');
const { seed } = require('./seed');
const { runTamperDemo } = require('./tamperDemo');
const { deterministicDemoSalt } = require('./demoSalt');
const { DEMO_PROVIDER_FLAGGED } = require('./demoScenarios');
const { createPrescriptionVersionRepository } = require('../repositories/prescriptionVersionRepository');
const { createAmendmentService } = require('../../versioning/amendmentService');
const { computeEntryHash } = require('../../ledger/ledgerService');

/** A one-medicine prescription in the Module 14 input shape (the rehearsal scenarios each have one medicine). */
function onePrescription(prescriptionId, patientId, providerId, medicine) {
  return { prescriptionId, patientId, providerId, medicines: [{ dosageUnit: 'mg', ...medicine }] };
}

async function seedPharmacyDemoScenarios(pool) {
  // Deterministic salts: integrity roots for these IDs are identical on every rehearsal reseed.
  const repository = createPrescriptionVersionRepository(pool, { generateSalt: deterministicDemoSalt });
  const amendmentService = createAmendmentService(pool, { repository });

  await seed(pool); // reset + RX-DEMO-0001..0004 (RX-DEMO-0001 v2 = verified example)
  await runTamperDemo(pool); // RX-DEMO-0005: raw SQL edit of medicine_1.dosage_value = tampered example

  // stale_version: v1 QR after a legitimate amendment.
  const stale = await repository.createPrescription(
    onePrescription('RX-DEMO-0006', 'PAT-002', 'PRV-001', {
      drugName: 'Amlodipine', drugClass: 'calcium channel blocker', dosageValue: '5', frequency: 'once daily', durationDays: 30, quantityPrescribed: 30,
    }),
  );
  await amendmentService.amendPrescriptionAuthorized(
    'RX-DEMO-0006',
    { medicineId: stale.medicines[0].medicine_id, dosageValue: '10' },
    'PRV-001',
    'BP above target at 5 mg',
  );

  // provider_identity_issue: a clean prescription by a dedicated provider who is then flagged.
  // (A dedicated provider so no other demo prescription is affected — the provider check overrides all others.)
  await pool.execute(
    "INSERT INTO provider (provider_id, name, license_number, credentials, status) VALUES (?, ?, ?, ?, 'active')",
    [DEMO_PROVIDER_FLAGGED.provider_id, DEMO_PROVIDER_FLAGGED.name, DEMO_PROVIDER_FLAGGED.license_number, DEMO_PROVIDER_FLAGGED.credentials],
  );
  await repository.createPrescription(
    onePrescription('RX-DEMO-0007', 'PAT-003', DEMO_PROVIDER_FLAGGED.provider_id, {
      drugName: 'Azithromycin', drugClass: 'macrolide antibiotic', dosageValue: '500', frequency: 'once daily', durationDays: 3, quantityPrescribed: 3,
    }),
  );
  await pool.execute("UPDATE provider SET status = 'flagged' WHERE provider_id = ?", [DEMO_PROVIDER_FLAGGED.provider_id]);

  // revoked.
  await repository.createPrescription(
    onePrescription('RX-DEMO-0008', 'PAT-001', 'PRV-001', {
      drugName: 'Ibuprofen', drugClass: 'nsaid', dosageValue: '400', frequency: 'three times daily', durationDays: 5, quantityPrescribed: 15,
    }),
  );
  await amendmentService.revokePrescription('RX-DEMO-0008', 'PRV-001', 'Patient reported NSAID sensitivity');

  // forged — MUST be the last ledger write of this script.
  const forged = await repository.createPrescription(
    onePrescription('RX-DEMO-0009', 'PAT-002', 'PRV-001', {
      drugName: 'Cefalexin', drugClass: 'cephalosporin', dosageValue: '500', frequency: 'four times daily', durationDays: 7, quantityPrescribed: 28,
    }),
  );
  await forgeNewestLedgerEntry(pool, forged);

  return repository;
}

/**
 * Raw SQL on the ledger only (the prescription row is untouched): rewrites the anchored integrity_root of
 * the NEWEST ledger entry, and recomputes that entry's own entry_hash.
 *
 * Why the recomputation: a bare root edit breaks the chain at this entry, and verifyAnchor walks the
 * chain up to whichever entry it checks — so every prescription created or amended later (e.g. live on
 * stage in the Doctor Portal) would ALSO scan as "forged". Re-hashing the newest entry keeps the chain
 * consistent for future entries, while the scan still fails where it should: the live prescription's
 * root no longer matches the anchored root (integrityRootMatch: false) → "forged".
 */
async function forgeNewestLedgerEntry(pool, version) {
  const [[newest]] = await pool.query('SELECT * FROM ledger_entry ORDER BY sequence_number DESC LIMIT 1');
  if (!newest || newest.ledger_entry_id !== version.ledger_anchor_ref) {
    throw new Error('Refusing to forge: the target is not the newest ledger entry (later entries would be poisoned)');
  }
  const forgedRoot = 'f0'.repeat(32); // obviously fabricated 64-hex root
  const forgedHash = computeEntryHash({
    prescriptionId: newest.prescription_id,
    versionNumber: newest.version_number,
    integrityRoot: forgedRoot,
    previousEntryHash: newest.previous_entry_hash,
    anchoredAt: newest.anchored_at,
  });
  const [result] = await pool.execute('UPDATE ledger_entry SET integrity_root = ?, entry_hash = ? WHERE ledger_entry_id = ?', [
    forgedRoot,
    forgedHash,
    newest.ledger_entry_id,
  ]);
  if (result.affectedRows !== 1) throw new Error('Ledger forge UPDATE did not affect exactly one row');
}

async function main() {
  const pool = createPool();
  try {
    await seedPharmacyDemoScenarios(pool);
    const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
    const [rows] = await pool.query(
      `SELECT p.prescription_id, MAX(p.version_number) AS latest_version,
              SUBSTRING_INDEX(GROUP_CONCAT(p.status ORDER BY p.version_number DESC), ',', 1) AS latest_status,
              MAX(pr.provider_id) AS provider_id, MAX(pr.status) AS provider_status
         FROM prescription_version p JOIN provider pr ON pr.provider_id = p.provider_id
        WHERE p.prescription_id LIKE 'RX-DEMO-%'
        GROUP BY p.prescription_id ORDER BY p.prescription_id`,
    );
    console.log(`Pharmacy demo scenarios seeded into: ${db}`);
    console.table(rows);
    console.log('Next: npm run demo:payloads  (prints copy-paste scan payloads and writes docs/demo-scan-payloads.md)');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Pharmacy demo seed failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { seedPharmacyDemoScenarios };
