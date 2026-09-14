'use strict';

/**
 * DEMO SEED ONLY. Deterministic salt so reseeding yields identical integrity roots
 * across rehearsals (stable QR codes / ledger anchors for RX-DEMO-*).
 *
 * Derived from prescription_id AND version_number, so each version still has its own salt.
 * Because it is derivable from a public ID it gives weaker uniqueness than a random salt —
 * never use this for real prescriptions; the repository defaults to hashEngine.generateSalt().
 */

const crypto = require('crypto');

function deterministicDemoSalt({ prescription_id, version_number }) {
  return crypto
    .createHash('sha256')
    .update(`anchor-rx-demo-salt:${prescription_id}:v${version_number}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

module.exports = { deterministicDemoSalt };
