'use strict';

/**
 * Anchor Rx — Module 6: QR generation (pure functions, no DB).
 *
 * SECURITY PROPERTY: the QR code is a POINTER, never a carrier of clinical content.
 * It encodes only { prescriptionId, versionNumber, issuedAt }. The pharmacy uses it to look the
 * prescription up server-side, where hashes and the ledger anchor are checked. If the QR carried drug
 * name, dose or patient data, anyone could print a QR with fabricated-but-plausible content and there
 * would be no independent record in the code itself to check it against. A pointer can be forged too —
 * but a forged pointer can only point at records that exist and verify, or at nothing.
 *
 * Payloads are never stored: they are regenerated on demand from the version's identifiers and its
 * creation time, so the same version always yields the same payload and image.
 */

const QRCode = require('qrcode');

const PAYLOAD_KEYS = Object.freeze(['prescriptionId', 'versionNumber', 'issuedAt']);
const PRESCRIPTION_ID_PATTERN = /^RX-[A-Z0-9-]{4,29}$/; // same rule as the prescription_version repository

function normalizeIssuedAt(issuedAt) {
  const date = issuedAt instanceof Date ? issuedAt : typeof issuedAt === 'string' ? new Date(issuedAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new TypeError(`issuedAt must be a Date or date string, got ${JSON.stringify(issuedAt)}`);
  }
  return date.toISOString(); // UTC, millisecond precision — deterministic across regenerations
}

/**
 * @param {string} prescriptionId e.g. "RX-DEMO-0001"
 * @param {number} versionNumber positive integer
 * @param {Date|string} issuedAt the version's created_at (never amended_at, which changes when superseded)
 * @returns {{ prescriptionId: string, versionNumber: number, issuedAt: string }}
 */
function generateQrPayload(prescriptionId, versionNumber, issuedAt) {
  if (typeof prescriptionId !== 'string' || !PRESCRIPTION_ID_PATTERN.test(prescriptionId)) {
    throw new TypeError(`Invalid prescriptionId: ${JSON.stringify(prescriptionId)}`);
  }
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new TypeError(`versionNumber must be a positive integer, got ${JSON.stringify(versionNumber)}`);
  }

  // Deliberately ONLY these three fields — no drug name, dosage, patient or provider data (see header).
  return { prescriptionId, versionNumber, issuedAt: normalizeIssuedAt(issuedAt) };
}

/**
 * Encodes JSON.stringify(payload) as a PNG QR code data URL.
 * Refuses anything other than an exact three-key payload, so a full prescription row can never be
 * encoded by mistake.
 *
 * @returns {Promise<string>} "data:image/png;base64,…"
 */
async function generateQrImage(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload must be an object produced by generateQrPayload');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => keys.includes(key))) {
    throw new TypeError(`payload must contain exactly ${PAYLOAD_KEYS.join(', ')}; got: ${keys.join(', ')}`);
  }
  // Re-validate through generateQrPayload so a hand-built payload gets the same checks and key order.
  const canonical = generateQrPayload(payload.prescriptionId, payload.versionNumber, payload.issuedAt);

  return QRCode.toDataURL(JSON.stringify(canonical), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
}

/**
 * QR for a committed prescription_version row (snake_case, as returned by the repository).
 * issuedAt is the version's created_at — never amended_at, which is set later when the version is
 * superseded and would make a regenerated QR differ from the one already printed.
 *
 * @returns {Promise<{ qrPayload: { prescriptionId: string, versionNumber: number, issuedAt: string }, qrImage: string }>}
 */
async function buildVersionQr(version) {
  if (version === null || typeof version !== 'object') {
    throw new TypeError('version must be a prescription_version row');
  }
  const qrPayload = generateQrPayload(version.prescription_id, version.version_number, version.created_at);
  return { qrPayload, qrImage: await generateQrImage(qrPayload) };
}

const MAX_SCAN_LENGTH = 1024; // a real payload is ~90 characters
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MALFORMED = Object.freeze({ valid: false, error: 'malformed_qr' });

/**
 * Scan-side parser. Treats input as hostile: NEVER throws, and returns either
 *   { valid: true, payload: { prescriptionId, versionNumber, issuedAt } }
 * or
 *   { valid: false, error: 'malformed_qr' }.
 *
 * Deliberately strict (a scanner glitch or a forged QR must not slip through as "almost valid"):
 *   - input must be a string of at most MAX_SCAN_LENGTH characters
 *   - JSON must be a plain object with EXACTLY the three payload keys (extra keys = not our QR)
 *   - prescriptionId must match the real ID format; versionNumber a JSON integer >= 1
 *   - issuedAt must be the exact ISO-8601 UTC form the generator writes, and a real calendar instant
 * A well-formed but non-existent prescriptionId is valid here; the lookup decides it's unknown.
 */
function parseQrPayload(rawScanData) {
  try {
    if (typeof rawScanData !== 'string' || rawScanData.length === 0 || rawScanData.length > MAX_SCAN_LENGTH) {
      return { ...MALFORMED };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawScanData);
    } catch {
      return { ...MALFORMED };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...MALFORMED };

    const keys = Object.keys(parsed);
    if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => keys.includes(key))) {
      return { ...MALFORMED };
    }

    const { prescriptionId, versionNumber, issuedAt } = parsed;
    if (typeof prescriptionId !== 'string' || !PRESCRIPTION_ID_PATTERN.test(prescriptionId)) return { ...MALFORMED };
    if (typeof versionNumber !== 'number' || !Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      return { ...MALFORMED };
    }
    if (typeof issuedAt !== 'string' || !ISO_UTC_MILLIS.test(issuedAt)) return { ...MALFORMED };
    const instant = new Date(issuedAt);
    // Round-trip rejects impossible dates that Date silently rolls over (e.g. 2026-02-30 → March 2).
    if (Number.isNaN(instant.getTime()) || instant.toISOString() !== issuedAt) return { ...MALFORMED };

    return { valid: true, payload: { prescriptionId, versionNumber, issuedAt } };
  } catch {
    return { ...MALFORMED }; // belt and braces: nothing escapes as an exception
  }
}

module.exports = { generateQrPayload, generateQrImage, buildVersionQr, parseQrPayload, PAYLOAD_KEYS };
