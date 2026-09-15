'use strict';

/**
 * Anchor Rx — Module 15: the pharmacist's quiet "AI Risk: N%" line, read from LOCKED data only.
 *
 * forScan(scan) → { percentage } for the SCANNED prescription version (the QR's own version number):
 *   percentage = the HIGHEST locked_risk_score among that version's medicines (not an average, not the first medicine),
 *                or null when none of its medicines has a locked score (created before Module 15, or an amended version —
 *                amendments don't copy locked risk forward).
 *   null       → the scan resolved no version (malformed_qr / unknown_prescription).
 *
 * Read-only and additive: it never calls the AI service, never recomputes risk, and never touches verifyScan's,
 * evaluateTrust's or decideTrust's output. It is display data only — nothing may gate dispensing on it.
 */

const MAX_LOCKED_RISK_SQL = `
  SELECT MAX(pm.locked_risk_score) AS max_score, COUNT(pm.medicine_id) AS medicine_count
    FROM prescription_version pv
    JOIN prescription_medicine pm ON pm.prescription_version_id = pv.id
   WHERE pv.prescription_id = ? AND pv.version_number = ?`;

function createPharmacistRiskDisplay(pool) {
  async function forScan(scan) {
    if (!scan || typeof scan.prescriptionId !== 'string' || !Number.isInteger(scan.versionNumber)) return null;
    const [[row]] = await pool.execute(MAX_LOCKED_RISK_SQL, [scan.prescriptionId, scan.versionNumber]);
    if (!row || Number(row.medicine_count) === 0) return null; // no such version
    return { percentage: row.max_score === null ? null : Number(row.max_score) };
  }

  return Object.freeze({ forScan });
}

module.exports = { createPharmacistRiskDisplay };
