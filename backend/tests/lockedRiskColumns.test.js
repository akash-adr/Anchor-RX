'use strict';

/**
 * Module 15 Step 1 — migration 012: locked_risk_* on prescription_medicine are write-once, enforced by the database
 * (CHECKs + trg_medicine_locked_risk_write_once), not by application convention. Runs against anchor_rx_test.
 */

const { createPool } = require('../db/connection');
const { seed } = require('../db/seed/seed');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'anchor_rx_test';
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against non-test database "${TEST_DB_NAME}"`);
}

let pool;
let medicineId;

beforeAll(() => {
  pool = createPool({ database: TEST_DB_NAME });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await seed(pool);
  const [[row]] = await pool.query(
    "SELECT pm.medicine_id FROM prescription_medicine pm JOIN prescription_version pv ON pv.id = pm.prescription_version_id WHERE pv.prescription_id = 'RX-DEMO-0003'",
  );
  medicineId = row.medicine_id;
});

const lock = (score, band, reasons) =>
  pool.execute('UPDATE prescription_medicine SET locked_risk_score = ?, locked_risk_band = ?, locked_risk_reasons = ? WHERE medicine_id = ?', [
    score,
    band,
    JSON.stringify(reasons),
    medicineId,
  ]);

const read = async () => {
  const [[row]] = await pool.query('SELECT locked_risk_score, locked_risk_band, locked_risk_reasons, dosage_value FROM prescription_medicine WHERE medicine_id = ?', [medicineId]);
  return row;
};

test('columns start NULL for every medicine', async () => {
  const [[{ locked }]] = await pool.query('SELECT COUNT(*) AS locked FROM prescription_medicine WHERE locked_risk_score IS NOT NULL OR locked_risk_band IS NOT NULL OR locked_risk_reasons IS NOT NULL');
  expect(locked).toBe(0);
});

test('can be written once; any later change — new values, a "recalculation", or clearing — is rejected by the database', async () => {
  const reasons = [{ source: 'rule_engine', feature: 'drug_combination_flag', explanation: 'same class' }];
  await lock(25, 'low', reasons);
  expect(await read()).toMatchObject({ locked_risk_score: '25.00', locked_risk_band: 'low', locked_risk_reasons: reasons });

  await expect(lock(71, 'high', reasons)).rejects.toMatchObject({ sqlState: '45000' });
  await expect(lock(25, 'low', [])).rejects.toMatchObject({ sqlState: '45000' });
  await expect(pool.execute('UPDATE prescription_medicine SET locked_risk_score = NULL, locked_risk_band = NULL, locked_risk_reasons = NULL WHERE medicine_id = ?', [medicineId])).rejects.toMatchObject({ sqlState: '45000' });
  expect(await read()).toMatchObject({ locked_risk_score: '25.00', locked_risk_band: 'low', locked_risk_reasons: reasons });

  // The trigger guards ONLY locked_risk_*: other columns (e.g. the raw-SQL tamper demos) are unaffected.
  await pool.execute("UPDATE prescription_medicine SET dosage_value = '99' WHERE medicine_id = ?", [medicineId]);
  expect((await read()).dosage_value).toBe('99.000');
});

test('CHECKs: all-or-nothing, score 0–100, band low/review/high', async () => {
  await expect(pool.execute('UPDATE prescription_medicine SET locked_risk_score = 10 WHERE medicine_id = ?', [medicineId])).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  await expect(lock(101, 'high', [])).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  await expect(lock(-1, 'low', [])).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  await expect(lock(50, 'medium', [])).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  expect(await read()).toMatchObject({ locked_risk_score: null, locked_risk_band: null, locked_risk_reasons: null });
});
