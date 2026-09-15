'use strict';

/**
 * The fixed rehearsal scenarios for the Pharmacy Portal demo (anchor_rx).
 * Shared by pharmacyDemoScenarios.js (creates them) and printDemoPayloads.js (prints their QR payloads).
 * Listed in a demo-friendly order; verifyScan's precedence order is documented in pharmacyVerification.js.
 */

const DEMO_PROVIDER_FLAGGED = Object.freeze({
  provider_id: 'PRV-004',
  name: 'Dr. Meera Nair (synthetic)',
  license_number: 'DEMO-MED-10004',
  credentials: 'MBBS, MD (Internal Medicine)',
});

const SEEDED_SCENARIOS = Object.freeze([
  { expected: 'verified', prescriptionId: 'RX-DEMO-0001', versionNumber: 2, story: 'Clean, current (v2), untampered, active prescriber' },
  { expected: 'tampered', prescriptionId: 'RX-DEMO-0005', versionNumber: 1, story: 'Dose changed 500 → 5000 mg directly in the database' },
  { expected: 'forged', prescriptionId: 'RX-DEMO-0009', versionNumber: 1, story: "Ledger entry's anchored root rewritten; prescription row untouched" },
  { expected: 'stale_version', prescriptionId: 'RX-DEMO-0006', versionNumber: 1, story: 'Version 1 QR after a legitimate amendment to v2' },
  { expected: 'provider_identity_issue', prescriptionId: 'RX-DEMO-0007', versionNumber: 1, story: 'Clean prescription, but prescriber PRV-004 is flagged' },
  { expected: 'revoked', prescriptionId: 'RX-DEMO-0008', versionNumber: 1, story: 'Revoked by the prescriber — must never be dispensed' },
]);

const UNKNOWN_EXAMPLE = Object.freeze({
  expected: 'unknown_prescription',
  story: 'Well-formed QR for a prescription that does not exist',
  raw: JSON.stringify({ prescriptionId: 'RX-DEMO-9999', versionNumber: 1, issuedAt: '2026-09-15T09:00:00.000Z' }),
});

const MALFORMED_EXAMPLE = Object.freeze({
  expected: 'malformed_qr',
  story: 'Garbage that is not an Anchor Rx QR at all',
  raw: 'ANCHOR-RX::this-is-not-a-real-qr-code',
});

module.exports = { SEEDED_SCENARIOS, UNKNOWN_EXAMPLE, MALFORMED_EXAMPLE, DEMO_PROVIDER_FLAGGED };
