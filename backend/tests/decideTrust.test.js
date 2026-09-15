'use strict';

/**
 * Module 9 Step 1 — decideTrust in complete isolation (no database, no HTTP, no orchestration).
 */

const { decideTrust, TrustDecisionError, BLOCKING_SCAN_RESULTS, RISK_ASSESSED_SCAN_RESULTS } = require('../trust/decideTrust');
const { SCAN_RESULTS } = require('../qr/pharmacyVerification');

const FIXED_NOW = new Date('2026-09-15T10:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

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

const REASONS = [
  { source: 'rule_engine', feature: 'dose_value', explanation: 'Dose exceeds the typical maximum for this medication.' },
  { source: 'ml_model', feature: 'patient_velocity', explanation: 'Patient has received an unusually high number of prescriptions in the last 30 days.' },
];

function risk(riskBand, riskScore, reasons = REASONS) {
  return { riskScore, riskBand, reasons };
}

/** A fully populated risk result that records every way it is touched (property reads, `in`, key listing, …). */
function accessRecordingRisk() {
  const accessed = [];
  const target = risk('low', 5);
  const record = (trap) => (...args) => {
    accessed.push(`${trap}:${String(args[1] ?? '')}`);
    return Reflect[trap](...args);
  };
  const proxy = new Proxy(target, {
    get: record('get'),
    has: record('has'),
    ownKeys: record('ownKeys'),
    getOwnPropertyDescriptor: record('getOwnPropertyDescriptor'),
    getPrototypeOf: record('getPrototypeOf'),
  });
  return { proxy, accessed };
}

/** A risk result that throws on ANY interaction. */
const EXPLODING_RISK = new Proxy(
  {},
  Object.fromEntries(
    ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'set', 'defineProperty', 'deleteProperty'].map((trap) => [
      trap,
      () => {
        throw new Error(`riskResult was accessed via ${trap}`);
      },
    ]),
  ),
);

// ── 1. integrity failures → Block, risk never consulted ─────────────────────────────────────────────────────

describe('integrity failures block without consulting the risk result', () => {
  // Listed literally (not imported) so the policy list cannot silently shrink.
  const SPEC_BLOCKING = ['tampered', 'forged', 'provider_identity_issue', 'unknown_prescription', 'malformed_qr'];

  test.each([...SPEC_BLOCKING, 'revoked'])('%s → Block with every risk field null, even when a populated riskResult is passed', (value) => {
    const { proxy, accessed } = accessRecordingRisk();
    const decision = decideTrust(scan(value), proxy);

    expect(decision).toEqual({
      trustDecision: 'Block',
      primaryReason: value,
      scanResult: value,
      riskScore: null,
      riskBand: null,
      supportingDetail: {
        fieldVerification: { valid: true, mismatchedFields: [] },
        ledgerVerification: { chainIntact: true, integrityRootMatch: true },
        riskReasons: null,
      },
      decidedAt: FIXED_NOW.toISOString(),
    });
    expect(accessed).toEqual([]); // proves the function ignored riskResult, not that it merely didn't need it
  });

  test.each([...SPEC_BLOCKING, 'revoked'])('%s → Block even with a riskResult that throws on any access', (value) => {
    expect(() => decideTrust(scan(value), EXPLODING_RISK)).not.toThrow();
    expect(decideTrust(scan(value), EXPLODING_RISK).trustDecision).toBe('Block');
  });

  test.each([null, undefined])('Block handles a %s riskResult gracefully', (riskResult) => {
    const decision = decideTrust(scan('forged'), riskResult);
    expect(decision).toMatchObject({ trustDecision: 'Block', primaryReason: 'forged', riskScore: null, riskBand: null });
    expect(decision.supportingDetail.riskReasons).toBeNull();
  });

  test('integrity evidence is passed through, and absent evidence (malformed_qr) becomes null', () => {
    const tampered = decideTrust(scan('tampered', { fieldVerification: { valid: false, mismatchedFields: ['dosage_value'] } }), risk('high', 99));
    expect(tampered.supportingDetail.fieldVerification).toEqual({ valid: false, mismatchedFields: ['dosage_value'] });

    const malformed = decideTrust({ scanResult: 'malformed_qr', fieldVerification: null, ledgerVerification: undefined }, risk('low', 1));
    expect(malformed.supportingDetail).toEqual({ fieldVerification: null, ledgerVerification: null, riskReasons: null });
  });
});

// ── 2. authentic prescriptions → decided by risk band ───────────────────────────────────────────────────────

describe.each(['verified', 'stale_version'])('%s → decision follows the risk band', (value) => {
  test('low → Dispense, primaryReason "clean"', () => {
    const decision = decideTrust(scan(value), risk('low', 12));
    expect(decision).toEqual({
      trustDecision: 'Dispense',
      primaryReason: 'clean',
      scanResult: value,
      riskScore: 12,
      riskBand: 'low',
      supportingDetail: {
        fieldVerification: { valid: true, mismatchedFields: [] },
        ledgerVerification: { chainIntact: true, integrityRootMatch: true },
        riskReasons: REASONS,
      },
      decidedAt: FIXED_NOW.toISOString(),
    });
  });

  test('review → Review, primaryReason "reviewRiskScore"', () => {
    const decision = decideTrust(scan(value), risk('review', 45));
    expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'reviewRiskScore', riskScore: 45, riskBand: 'review' });
    expect(decision.supportingDetail.riskReasons).toBe(REASONS);
  });

  // REGRESSION GUARD: "high" must stay Review, never Block. The risk engine flags unusual-but-authentic prescriptions
  // for human judgment; it must not override a verified doctor's decision. If this test fails, a policy changed —
  // revisit the reasoning in decideTrust.js deliberately rather than updating the expectation.
  test('high → Review (explicitly NOT Block), primaryReason "highRiskScore"', () => {
    const decision = decideTrust(scan(value), risk('high', 100));
    expect(decision.trustDecision).toBe('Review');
    expect(decision.trustDecision).not.toBe('Block');
    expect(decision).toMatchObject({ primaryReason: 'highRiskScore', riskScore: 100, riskBand: 'high' });
  });
});

test('stale_version produces exactly the same decision as verified for every risk band', () => {
  for (const [band, score] of [['low', 0], ['review', 70], ['high', 71]]) {
    const { scanResult: verifiedScan, ...verified } = decideTrust(scan('verified'), risk(band, score));
    const { scanResult: staleScan, ...stale } = decideTrust(scan('stale_version'), risk(band, score));
    expect([verifiedScan, staleScan]).toEqual(['verified', 'stale_version']);
    expect(stale).toEqual(verified);
  }
});

// ── risk result unavailable (e.g. AI service down) ──────────────────────────────────────────────────────────

describe('authentic prescription without a usable risk result → Review "riskEngineUnavailable", never Dispense', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['unknown band', risk('medium', 40)],
    ['missing score', { riskBand: 'low', reasons: [] }],
    ['NaN score', risk('low', Number.NaN)],
    ['score above 100', risk('low', 101)],
    ['reasons not an array', { riskScore: 5, riskBand: 'low', reasons: null }],
    ['snake_case service shape (untranslated)', { risk_score: 5, risk_band: 'low', reasons: [] }],
  ])('%s', (_label, riskResult) => {
    for (const value of ['verified', 'stale_version']) {
      const decision = decideTrust(scan(value), riskResult);
      expect(decision).toMatchObject({ trustDecision: 'Review', primaryReason: 'riskEngineUnavailable', riskScore: null, riskBand: null });
      expect(decision.supportingDetail.riskReasons).toBeNull();
    }
  });
});

// ── contract & validation ───────────────────────────────────────────────────────────────────────────────────

test('every scan result Module 6 can produce is classified exactly once', () => {
  const produced = Object.values(SCAN_RESULTS).sort();
  const classified = [...BLOCKING_SCAN_RESULTS, ...RISK_ASSESSED_SCAN_RESULTS].sort();
  expect(classified).toEqual(produced);
  expect(new Set(classified).size).toBe(classified.length);
});

test('output has exactly the contract keys in order, and decidedAt is the decision time', () => {
  const decision = decideTrust(scan('verified'), risk('low', 3));
  expect(Object.keys(decision)).toEqual(['trustDecision', 'primaryReason', 'scanResult', 'riskScore', 'riskBand', 'supportingDetail', 'decidedAt']);
  expect(Object.keys(decision.supportingDetail)).toEqual(['fieldVerification', 'ledgerVerification', 'riskReasons']);
  expect(decision.decidedAt).toBe('2026-09-15T10:00:00.000Z');
});

test('inputs are not mutated', () => {
  const frozenScan = Object.freeze(scan('verified', { fieldVerification: Object.freeze({ valid: true }) }));
  const frozenRisk = Object.freeze(risk('review', 50, Object.freeze([...REASONS])));
  expect(() => decideTrust(frozenScan, frozenRisk)).not.toThrow();
});

test.each([null, undefined, 'verified', {}, { scanResult: 42 }])('invalid scan input %p throws INVALID_SCAN_RESULT', (input) => {
  expect(() => decideTrust(input, risk('low', 1))).toThrow(expect.objectContaining({ name: 'TrustDecisionError', code: 'INVALID_SCAN_RESULT' }));
});

test('an unknown scanResult value throws UNKNOWN_SCAN_RESULT without touching the risk result', () => {
  const { proxy, accessed } = accessRecordingRisk();
  expect(() => decideTrust(scan('pending'), proxy)).toThrow(TrustDecisionError);
  expect(() => decideTrust(scan('pending'), proxy)).toThrow(expect.objectContaining({ code: 'UNKNOWN_SCAN_RESULT' }));
  expect(accessed).toEqual([]);
});
