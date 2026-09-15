'use strict';

/**
 * Generates the decideTrust golden baseline from a GIVEN source file (for Module 15: git HEAD's pre-Module-15 copy).
 *
 *   git show <commit>:backend/trust/decideTrust.js > /tmp/decideTrust.baseline.js
 *   node backend/tests/fixtures/generateDecideTrustBaseline.js /tmp/decideTrust.baseline.js \
 *        backend/tests/fixtures/decideTrust.module9-baseline.json "<commit> backend/trust/decideTrust.js"
 *
 * The clock is pinned (decidedAt) exactly as the regression test pins it with fake timers.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FIXED_NOW_ISO, buildCases, runCase } = require('./decideTrustRegressionCases');

const [sourcePath, outputPath, sourceDescription = sourcePath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  console.error('usage: node generateDecideTrustBaseline.js <decideTrust.js> <output.json> [source description]');
  process.exit(1);
}

const FIXED_MS = Date.parse(FIXED_NOW_ISO);
const RealDate = Date;
global.Date = class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : [FIXED_MS]));
  }

  static now() {
    return FIXED_MS;
  }
};

const { decideTrust } = require(path.resolve(sourcePath));
const source = fs.readFileSync(sourcePath);
const baseline = {
  description: 'decideTrust outputs for every Module 9 test input, generated from the pre-Module-15 source',
  source: sourceDescription,
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  fixedNow: FIXED_NOW_ISO,
  cases: buildCases().map((testCase) => ({ label: testCase.label, ...runCase(decideTrust, testCase) })),
};
fs.writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${baseline.cases.length} cases from ${sourceDescription} (sha256 ${baseline.sourceSha256}) → ${outputPath}`);
