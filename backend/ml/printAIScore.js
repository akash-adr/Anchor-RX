'use strict';

/**
 * Manual check: score a real prescription through the running AI service and print the camelCase result — or the
 * AIServiceError fields if the service is down.
 *   node backend/ml/printAIScore.js RX-DEMO-0001 2
 */

const { createPool } = require('../db/connection');
const { createScoreClient, AIServiceError } = require('./scoreClient');

async function main() {
  const [prescriptionId, versionArg] = process.argv.slice(2);
  if (!prescriptionId || !versionArg) {
    console.error('usage: node backend/ml/printAIScore.js <prescriptionId> <versionNumber>');
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  try {
    const { scorePrescriptionViaAI } = createScoreClient(pool);
    const started = Date.now();
    try {
      const risk = await scorePrescriptionViaAI(prescriptionId, Number(versionArg));
      console.log(JSON.stringify(risk, null, 2));
      console.log(`(ok in ${Date.now() - started} ms)`);
    } catch (err) {
      if (!(err instanceof AIServiceError)) throw err;
      console.log('caught AIServiceError — degraded gracefully:');
      console.log(JSON.stringify({ name: err.name, code: err.code, reason: err.reason, status: err.status, message: err.message }, null, 2));
      console.log(`(failed in ${Date.now() - started} ms)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('UNHANDLED:', error);
  process.exitCode = 1;
});
