'use strict';

/**
 * Module 10 completion criterion — timestamp normalization for the audit timeline.
 *
 * These tests prove the bug is REAL before proving the fix: the same raw timestamps, merged from different audit
 * sources, sort into the wrong order with a naive comparison and into the right order only through normalizeTimestamp.
 */

const { createPool } = require('../db/connection');
const { normalizeTimestamp, AuditTimestampError } = require('../audit/normalizeTimestamp');

const ids = (events) => events.map((event) => event.id);

// Four audit events that happened within ONE second, listed in their TRUE chronological order. Each timestamp is in a
// format that source really produces somewhere in this codebase.
const EVENTS_IN_TRUE_ORDER = Object.freeze([
  // mysql2 row: TIMESTAMP(3) → JS Date
  { id: 'version-created', source: 'prescription_version.created_at', raw: new Date(Date.UTC(2026, 8, 15, 10, 0, 0, 120)) },
  // MySQL text with milliseconds (CAST(... AS CHAR) / dateStrings), UTC session
  { id: 'ledger-anchored', source: 'ledger_entry.anchored_at', raw: '2026-09-15 10:00:00.180' },
  // ISO 8601 with Z, as it comes back through the JSON API
  { id: 'pharmacy-scan', source: 'verification_event.timestamp', raw: '2026-09-15T10:00:00.450Z' },
  // MySQL text with only second precision
  { id: 'trust-decision', source: 'trust_decision_log.decided_at', raw: '2026-09-15 10:00:01' },
]);

// Arrive out of order, as they would when merged from four separate queries.
const MERGED_UNSORTED = Object.freeze([EVENTS_IN_TRUE_ORDER[3], EVENTS_IN_TRUE_ORDER[2], EVENTS_IN_TRUE_ORDER[0], EVENTS_IN_TRUE_ORDER[1]]);

/** The tempting shortcut: "timestamps sort as strings". Compares the raw values directly, no normalization. */
function naiveSort(events) {
  return [...events].sort((a, b) => {
    const left = String(a.raw);
    const right = String(b.raw);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function normalizedSort(events) {
  return [...events].sort((a, b) => normalizeTimestamp(a.raw) - normalizeTimestamp(b.raw));
}

describe('merging audit events from different sources', () => {
  test('the fixture events are genuinely close together (all within one second)', () => {
    const epochs = EVENTS_IN_TRUE_ORDER.map((event) => normalizeTimestamp(event.raw));
    expect(Math.max(...epochs) - Math.min(...epochs)).toBeLessThan(1000);
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b)); // the "true order" list really is chronological
  });

  test('BUG IS REAL: naive comparison of the raw timestamps sorts the events into the WRONG order', () => {
    const naive = ids(naiveSort(MERGED_UNSORTED));
    // Space < "T" < letters: MySQL text sorts before ISO text regardless of the time, and a Date's
    // string form ("Tue Sep 15 2026 …") sorts after every digit-leading string.
    expect(naive).toEqual(['ledger-anchored', 'trust-decision', 'pharmacy-scan', 'version-created']);
    expect(naive).not.toEqual(ids(EVENTS_IN_TRUE_ORDER));
  });

  test('FIX: sorting by normalizeTimestamp puts the same events in the CORRECT order', () => {
    expect(ids(normalizedSort(MERGED_UNSORTED))).toEqual(['version-created', 'ledger-anchored', 'pharmacy-scan', 'trust-decision']);
    expect(ids(normalizedSort(MERGED_UNSORTED))).toEqual(ids(EVENTS_IN_TRUE_ORDER));
  });
});

describe('the local-time parsing bug (this server runs in IST)', () => {
  const originalTimeZone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata';
  });

  afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  test('new Date() reads a zone-less MySQL timestamp as local time; normalizeTimestamp reads it as UTC', () => {
    expect(new Date(Date.UTC(2026, 8, 15)).getTimezoneOffset()).toBe(-330); // precondition: IST is in effect

    const anchored = { id: 'ledger-anchored', raw: '2026-09-15 10:00:00.180' }; // UTC, from the database
    const scanned = { id: 'pharmacy-scan', raw: '2026-09-15T07:00:00.000Z' }; // really happened ~3 h EARLIER

    const byNewDate = [anchored, scanned].sort((a, b) => new Date(a.raw).getTime() - new Date(b.raw).getTime());
    expect(new Date(anchored.raw).toISOString()).toBe('2026-09-15T04:30:00.180Z'); // silently shifted by −5:30
    expect(ids(byNewDate)).toEqual(['ledger-anchored', 'pharmacy-scan']); // WRONG

    expect(ids(normalizedSort([anchored, scanned]))).toEqual(['pharmacy-scan', 'ledger-anchored']); // correct
    expect(normalizeTimestamp(anchored.raw)).toBe(Date.UTC(2026, 8, 15, 10, 0, 0, 180));
  });
});

describe('normalizeTimestamp', () => {
  const INSTANT = Date.UTC(2026, 8, 15, 10, 0, 0, 180);

  test.each([
    ['JS Date (mysql2 row value)', new Date(INSTANT)],
    ['MySQL text with milliseconds', '2026-09-15 10:00:00.180'],
    ['MySQL text with microseconds (truncated)', '2026-09-15 10:00:00.180999'],
    ['ISO with Z', '2026-09-15T10:00:00.180Z'],
    ['ISO with lowercase z', '2026-09-15t10:00:00.180z'],
    ['ISO without a zone (UTC)', '2026-09-15T10:00:00.180'],
    ['ISO with +05:30 offset', '2026-09-15T15:30:00.180+05:30'],
    ['ISO with -0400 offset', '2026-09-15T06:00:00.180-0400'],
    ['epoch milliseconds', INSTANT],
  ])('%s → the same epoch milliseconds', (_label, raw) => {
    expect(normalizeTimestamp(raw)).toBe(INSTANT);
  });

  test('second-precision and minute-precision text', () => {
    expect(normalizeTimestamp('2026-09-15 10:00:01')).toBe(Date.UTC(2026, 8, 15, 10, 0, 1, 0));
    expect(normalizeTimestamp('2026-09-15 10:00')).toBe(Date.UTC(2026, 8, 15, 10, 0, 0, 0));
    expect(normalizeTimestamp('2026-09-15 10:00:00.1')).toBe(Date.UTC(2026, 8, 15, 10, 0, 0, 100));
  });

  test('is idempotent and returns null for SQL NULL', () => {
    expect(normalizeTimestamp(normalizeTimestamp('2026-09-15 10:00:00.180'))).toBe(INSTANT);
    expect(normalizeTimestamp(null)).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['invalid Date', new Date('not a date')],
    ['NaN', Number.NaN],
    ['fractional number', 1.5],
    ['empty string', ''],
    ['free text', 'yesterday'],
    ['impossible date', '2026-02-30 10:00:00'],
    ['hour 24', '2026-09-15 24:00:00'],
    ['date only', '2026-09-15'],
    ['boolean', true],
    ['object', { timestamp: '2026-09-15 10:00:00' }],
  ])('rejects %s with AuditTimestampError', (_label, raw) => {
    expect(() => normalizeTimestamp(raw)).toThrow(AuditTimestampError);
    expect(() => normalizeTimestamp(raw)).toThrow(expect.objectContaining({ code: 'INVALID_TIMESTAMP' }));
  });

  test('agrees with what mysql2 really returns for a TIMESTAMP(3) value in this project (Date vs its text form)', async () => {
    const pool = createPool({ database: process.env.TEST_DB_NAME || 'anchor_rx_test' });
    try {
      const [[row]] = await pool.query(
        "SELECT CAST('2026-09-15 10:00:00.180' AS DATETIME(3)) AS asValue, CAST(CAST('2026-09-15 10:00:00.180' AS DATETIME(3)) AS CHAR) AS asText",
      );
      expect(Object.prototype.toString.call(row.asValue)).toBe('[object Date]');
      expect(typeof row.asText).toBe('string');
      expect(normalizeTimestamp(row.asValue)).toBe(INSTANT);
      expect(normalizeTimestamp(row.asText)).toBe(INSTANT);
    } finally {
      await pool.end();
    }
  });
});
