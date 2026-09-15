'use strict';

/**
 * Manual check: run the full trust evaluation for a real scan and print the decision plus its trust_decision_log row.
 * Writes a verification_event and a trust_decision_log row, exactly like a real scan (npm run seed:demo resets).
 *
 *   node backend/trust/printTrustDecision.js <pharmacyId> <prescriptionId> <versionNumber>   # QR text built from the DB
 *   node backend/trust/printTrustDecision.js <pharmacyId> --raw '<scanned text>'
 */

const { createPool } = require('../db/connection');
const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { generateQrPayload } = require('../qr/qrEngine');
const { createTrustEvaluator } = require('./evaluateTrust');

async function main() {
  const [pharmacyId, second, third] = process.argv.slice(2);
  if (!pharmacyId || !second || !third) {
    console.error("usage: printTrustDecision.js <pharmacyId> <prescriptionId> <versionNumber> | <pharmacyId> --raw '<text>'");
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  try {
    let raw = third;
    if (second !== '--raw') {
      const row = await createPrescriptionVersionRepository(pool).getVersion(second, Number(third));
      if (!row) throw new Error(`${second} v${third} not found`);
      raw = JSON.stringify(generateQrPayload(row.prescription_id, row.version_number, row.created_at));
    }
    const started = Date.now();
    const decision = await createTrustEvaluator(pool).evaluateTrust(raw, pharmacyId);
    const elapsed = Date.now() - started;
    const [[logged]] = await pool.query(
      `SELECT d.decision_id, d.prescription_id, d.version_number, d.pharmacy_id, d.verification_event_id, d.trust_decision,
              d.primary_reason, d.risk_score, d.risk_band, v.result AS event_result, pv.version_number AS scanned_version
         FROM trust_decision_log d
         JOIN verification_event v ON v.event_id = d.verification_event_id
    LEFT JOIN prescription_version pv ON pv.id = v.prescription_version_id
        ORDER BY d.decision_id DESC LIMIT 1`,
    );
    console.log(JSON.stringify({ decision, logged, elapsedMs: elapsed }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('UNHANDLED:', error);
  process.exitCode = 1;
});
