'use strict';

/**
 * Module 9's decideTrust inputs — every scanResult / riskResult combination exercised by tests/decideTrust.test.js,
 * expressed as data. Shared by the baseline generator (run against the PRE-Module-15 source) and the Module 15
 * regression test (run against the current source), so both see exactly the same inputs.
 */

const FIXED_NOW_ISO = '2026-09-15T10:00:00.000Z';

const REASONS = [
  { source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' },
  { source: 'ml_model', feature: 'patient_velocity', explanation: 'Patient has received an unusually high number of prescriptions in the last 30 days.' },
];

function scan(scanResult, overrides = {}) {
  return {
    scanResult,
    prescriptionId: 'RX-DEMO-0001',
    versionNumber: 2,
    fieldVerification: { valid: true, mismatchedFields: [] },
    ledgerVerification: { chainIntact: true, integrityRootMatch: true },
    providerStatus: 'active',
    currentActiveVersion: 2,
    scannedAt: '2026-09-15T09:59:59.000Z',
    ...overrides,
  };
}

const risk = (riskBand, riskScore, reasons = REASONS) => ({ riskScore, riskBand, reasons });

const BLOCKING = ['tampered', 'forged', 'provider_identity_issue', 'unknown_prescription', 'malformed_qr', 'revoked'];

function buildCases() {
  const cases = [];
  const add = (label, scanInput, riskResult) => cases.push({ label, scanInput, riskResult });

  // 1. integrity failures → Block
  for (const value of BLOCKING) add(`${value} + populated low 5`, scan(value), risk('low', 5));
  add('forged + null risk', scan('forged'), null);
  add('forged + undefined risk', scan('forged'), undefined);
  add('tampered with mismatched field + high 99', scan('tampered', { fieldVerification: { valid: false, mismatchedFields: ['dosage_value'] } }), risk('high', 99));
  add('malformed_qr minimal scan + low 1', { scanResult: 'malformed_qr', fieldVerification: null, ledgerVerification: undefined }, risk('low', 1));

  for (const value of ['verified', 'stale_version']) {
    // 2. authentic → decided by band (every score used in the Module 9 suite)
    for (const [band, score] of [['low', 12], ['review', 45], ['high', 100], ['low', 0], ['review', 70], ['high', 71], ['review', 50], ['low', 3]]) {
      add(`${value} + ${band} ${score}`, scan(value), risk(band, score));
    }
    // 3. no usable risk result → Review riskEngineUnavailable
    for (const [label, riskResult] of [
      ['null', null],
      ['undefined', undefined],
      ['unknown band', risk('medium', 40)],
      ['missing score', { riskBand: 'low', reasons: [] }],
      ['NaN score', risk('low', Number.NaN)],
      ['score above 100', risk('low', 101)],
      ['reasons not an array', { riskScore: 5, riskBand: 'low', reasons: null }],
      ['snake_case service shape', { risk_score: 5, risk_band: 'low', reasons: [] }],
    ]) {
      add(`${value} + ${label}`, scan(value), riskResult);
    }
  }

  // 4. validation errors (compared as data)
  for (const [label, input] of [['null', null], ['undefined', undefined], ['string', 'verified'], ['empty object', {}], ['numeric scanResult', { scanResult: 42 }]]) {
    add(`invalid scan input: ${label}`, input, risk('low', 1));
  }
  add('unknown scanResult "pending"', scan('pending'), risk('low', 5));

  return cases;
}

/** One case through a decideTrust implementation; a thrown error is captured as data so errors are compared too. */
function runCase(decideTrust, { scanInput, riskResult }) {
  try {
    return { output: decideTrust(scanInput, riskResult) };
  } catch (err) {
    return { error: { name: err.name, code: err.code, message: err.message } };
  }
}

module.exports = { FIXED_NOW_ISO, buildCases, runCase };
