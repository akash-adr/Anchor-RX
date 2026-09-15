'use strict';

/**
 * Prints the exact scan payload for each rehearsal scenario, read live from the database, and writes
 * docs/demo-scan-payloads.md plus printable QR images in docs/demo-qr/. Read-only: logs no scans.
 *
 * Usage: npm run demo:payloads   (after npm run seed:demo)
 */

const fs = require('fs');
const path = require('path');
const { createPool } = require('../connection');
const { createPrescriptionVersionRepository } = require('../repositories/prescriptionVersionRepository');
const { generateQrPayload, generateQrImage } = require('../../qr/qrEngine');
const { SEEDED_SCENARIOS, UNKNOWN_EXAMPLE, MALFORMED_EXAMPLE } = require('./demoScenarios');

const DOCS_DIR = path.resolve(__dirname, '../../../docs');
const QR_DIR = path.join(DOCS_DIR, 'demo-qr');

const TONE = {
  verified: '🟢 expected: verified',
  stale_version: '🔵 expected: stale_version (calm — newer version exists)',
  tampered: '🔴 expected: tampered',
  forged: '🔴 expected: forged',
  revoked: '🔴 expected: revoked',
  provider_identity_issue: '🔴 expected: provider_identity_issue',
  unknown_prescription: '🟠 expected: unknown_prescription',
  malformed_qr: '🟠 expected: malformed_qr',
};

async function collectPayloads(pool) {
  const repository = createPrescriptionVersionRepository(pool);
  const entries = [];
  for (const scenario of SEEDED_SCENARIOS) {
    const row = await repository.getVersion(scenario.prescriptionId, scenario.versionNumber);
    if (!row) {
      throw new Error(`${scenario.prescriptionId} v${scenario.versionNumber} not found — run "npm run seed:demo" first`);
    }
    const payload = generateQrPayload(row.prescription_id, row.version_number, row.created_at);
    entries.push({ ...scenario, raw: JSON.stringify(payload), payload });
  }
  entries.push({ ...UNKNOWN_EXAMPLE, prescriptionId: 'RX-DEMO-9999', versionNumber: 1, payload: JSON.parse(UNKNOWN_EXAMPLE.raw) });
  entries.push({ ...MALFORMED_EXAMPLE, prescriptionId: null, versionNumber: null, payload: null });
  return entries;
}

async function main() {
  const pool = createPool();
  try {
    const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
    const entries = await collectPayloads(pool);

    fs.mkdirSync(QR_DIR, { recursive: true });
    const lines = [
      '# Anchor Rx — Pharmacy demo scan payloads',
      '',
      `Generated from the \`${db}\` database on ${new Date().toISOString()} by \`npm run demo:payloads\`.`,
      '',
      '**How to use:** in the Pharmacy Portal, open manual entry, copy the ONE line inside a grey box, paste, scan.',
      'Re-run `npm run seed:demo` before a rehearsal to restore every scenario (the IDs below stay the same).',
      '',
    ];

    for (const [index, entry] of entries.entries()) {
      const slug = entry.expected.replace(/_/g, '-');
      let qrLink = '';
      if (entry.payload) {
        const dataUrl = await generateQrImage(entry.payload);
        fs.writeFileSync(path.join(QR_DIR, `${index + 1}-${slug}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        qrLink = ` · [QR image](demo-qr/${index + 1}-${slug}.png)`;
      }
      lines.push(`## ${index + 1}. ${entry.expected}`, '', `${TONE[entry.expected]} — ${entry.story}${qrLink}`, '', '```', entry.raw, '```', '');
    }

    lines.push(
      '---',
      '',
      'Notes',
      '',
      '- Scanning logs a `verification_event` row; that is expected during rehearsal.',
      '- `RX-DEMO-0006` **version 2** is the current version and scans as `verified` (useful right after the stale demo).',
      '- The forged example keeps the ledger chain consistent, so prescriptions created live during the demo still verify.',
      '',
    );
    fs.writeFileSync(path.join(DOCS_DIR, 'demo-scan-payloads.md'), lines.join('\n'));

    console.log(`Scan payloads from ${db} (full copy sheet: docs/demo-scan-payloads.md, QR images: docs/demo-qr/)\n`);
    for (const [index, entry] of entries.entries()) {
      console.log(`${String(index + 1).padStart(2)}. ${entry.expected.padEnd(24)} ${entry.raw}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Could not print demo payloads:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { collectPayloads };
