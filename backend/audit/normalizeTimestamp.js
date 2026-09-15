'use strict';

/**
 * Anchor Rx — Module 10: ONE timestamp representation for the audit timeline.
 *
 *   normalizeTimestamp(rawTimestamp) → integer milliseconds since the Unix epoch (UTC), or null for a SQL NULL
 *
 * The timeline merges prescription_version.created_at / amended_at, ledger_entry.anchored_at,
 * verification_event.timestamp and trust_decision_log.decided_at. All five are TIMESTAMP(3). In this project mysql2
 * returns them as JS Date objects (MySQL session time_zone '+00:00', pool timezone 'Z'), but the same instants also
 * travel as strings: MySQL text ("2026-09-15 10:00:00.180" — CAST(... AS CHAR), dateStrings), ISO with a zone from API
 * JSON ("2026-09-15T10:00:00.450Z"), or second precision ("2026-09-15 10:00:01"). Comparing those raw values as
 * strings, or feeding zone-less strings to new Date(), orders events wrongly. Convert everything here; sort numbers only.
 *
 * Accepted input:
 *   Date                                    → getTime() (must be a valid Date; checked by tag, so cross-realm safe)
 *   number                                  → already epoch ms (must be a safe integer) — normalizing twice is harmless
 *   "YYYY-MM-DD[T| ]HH:MM[:SS[.fraction]]"  → NO zone: interpreted as UTC, the database session's zone. Deliberately
 *                                             never passed to new Date()/Date.parse, which treat zone-less date-times
 *                                             as LOCAL time (on this IST server 10:00 silently becomes 04:30Z).
 *   …followed by "Z", "±HH:MM" or "±HHMM"   → that offset is applied
 *   fractional seconds beyond milliseconds  → truncated, never rounded up past the real instant
 *   null                                    → null (e.g. amended_at of a version that was never amended)
 * Anything else — undefined, an invalid Date, NaN, a non-integer, unparseable or impossible text — throws
 * AuditTimestampError. A bad value must never reach a sort comparator as NaN, which silently scrambles the order.
 */

class AuditTimestampError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'AuditTimestampError';
    this.code = 'INVALID_TIMESTAMP';
  }
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Object.prototype.toString.call(value) === '[object Date]') return 'Invalid Date';
  return `${typeof value} ${String(value)}`;
}

/** Epoch ms for a date-time string, or null if it is not a real, well-formed date-time. */
function parseDateTimeString(text) {
  const match = DATE_TIME_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3)); // truncate: ".180999" → 180
  let epoch = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);

  const check = new Date(epoch); // reject calendar rollover such as 2026-02-30
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = Number(digits.slice(2, 4));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    epoch -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  return epoch;
}

/**
 * @param {Date|string|number|null} rawTimestamp a timestamp as it arrives from any audit source
 * @returns {number|null} epoch milliseconds (UTC), or null for a SQL NULL
 * @throws {AuditTimestampError}
 */
function normalizeTimestamp(rawTimestamp) {
  if (rawTimestamp === null) return null;

  if (Object.prototype.toString.call(rawTimestamp) === '[object Date]') {
    const epoch = rawTimestamp.getTime();
    if (Number.isNaN(epoch)) throw new AuditTimestampError('Invalid Date cannot be placed on the audit timeline');
    return epoch;
  }

  if (typeof rawTimestamp === 'number') {
    if (!Number.isSafeInteger(rawTimestamp)) throw new AuditTimestampError(`Epoch milliseconds must be a safe integer, got ${describe(rawTimestamp)}`);
    return rawTimestamp;
  }

  if (typeof rawTimestamp === 'string') {
    const epoch = parseDateTimeString(rawTimestamp);
    if (epoch === null) throw new AuditTimestampError(`Unrecognised timestamp ${describe(rawTimestamp)}`);
    return epoch;
  }

  throw new AuditTimestampError(`Unsupported timestamp value: ${describe(rawTimestamp)}`);
}

module.exports = { normalizeTimestamp, AuditTimestampError };
