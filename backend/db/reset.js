'use strict';

// Child tables first. FK checks are disabled on this one connection so the
// self-referencing prescription_version chain can be truncated in one pass.
// ledger_lock is intentionally absent: its single mutex row must survive resets.
const TABLES = [
  'ledger_entry',
  'amendment_attempts',
  'delegated_amendments',
  'verification_event',
  'prescription_version',
  'patient',
  'pharmacy',
  'provider',
];

async function resetDatabase(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    conn.release();
  }
}

// Reference data has no repository (Module 1 only guards prescription_version),
// so it is inserted with plain parameterized SQL.
async function insertReferenceData(pool, { providers = [], patients = [], pharmacies = [] }) {
  for (const p of providers) {
    await pool.execute(
      'INSERT INTO provider (provider_id, name, license_number, credentials, status) VALUES (?, ?, ?, ?, ?)',
      [p.provider_id, p.name, p.license_number, p.credentials, p.status],
    );
  }
  for (const p of patients) {
    await pool.execute('INSERT INTO patient (patient_id, name, dob, weight) VALUES (?, ?, ?, ?)', [
      p.patient_id,
      p.name,
      p.dob,
      p.weight ?? null,
    ]);
  }
  for (const p of pharmacies) {
    await pool.execute('INSERT INTO pharmacy (pharmacy_id, name, license_number) VALUES (?, ?, ?)', [
      p.pharmacy_id,
      p.name,
      p.license_number,
    ]);
  }
}

module.exports = { resetDatabase, insertReferenceData };
