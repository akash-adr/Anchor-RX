'use strict';

/**
 * Manual check: print the real ScoringPayload for seeded prescriptions.
 *   node backend/ml/printScoringPayload.js RX-DEMO-0003 1 [RX-DEMO-0004 1 ...]
 */

const { createPool } = require('../db/connection');
const { createScoringPayloadBuilder } = require('./buildScoringPayload');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error('usage: node backend/ml/printScoringPayload.js <prescriptionId> <versionNumber> [...]');
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  try {
    const { buildScoringPayload } = createScoringPayloadBuilder(pool);
    for (let i = 0; i < args.length; i += 2) {
      const payload = await buildScoringPayload(args[i], Number(args[i + 1]));
      console.log(JSON.stringify(payload, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
