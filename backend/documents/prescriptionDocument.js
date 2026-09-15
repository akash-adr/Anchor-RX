'use strict';

/**
 * Anchor Rx — data for a printable prescription document (read + assembly only).
 * No PDF is produced here; the Doctor Portal renders it client-side from this data.
 *
 *   getPrescriptionDocument(prescriptionId, versionNumber) → document data for that EXACT version, or null.
 *
 * The QR is regenerated on demand with Module 6's buildVersionQr (generateQrPayload + generateQrImage) from the
 * version's STORED created_at — the same inputs the create/amend responses used — so it is identical to the QR issued
 * with that version. Nothing new is stored. issuedAt is always created_at, never amended_at: amended_at is set later,
 * when the version is superseded, and would produce a different QR from the one already handed out.
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { buildVersionQr } = require('../qr/qrEngine');

// dob is a DATE: formatted in SQL so no time-zone conversion can shift it by a day.
const PARTIES_SQL = `
  SELECT pa.patient_id, pa.name AS patient_name, DATE_FORMAT(pa.dob, '%Y-%m-%d') AS patient_dob,
         pr.name AS provider_name, pr.license_number
    FROM patient pa
    JOIN provider pr ON pr.provider_id = ?
   WHERE pa.patient_id = ?`;

function createPrescriptionDocuments(pool, { repository = createPrescriptionVersionRepository(pool) } = {}) {
  /**
   * @returns {Promise<object|null>} null when that prescriptionId + versionNumber does not exist
   */
  async function getPrescriptionDocument(prescriptionId, versionNumber) {
    const row = await repository.getVersion(prescriptionId, versionNumber);
    if (!row) return null;

    const [[parties]] = await pool.execute(PARTIES_SQL, [row.provider_id, row.patient_id]);
    if (!parties) {
      // Foreign keys make this impossible in a consistent database; treat it as a server-side fault.
      throw new Error(`Patient/provider reference data missing for ${prescriptionId} v${versionNumber}`);
    }

    const { qrPayload, qrImage } = await buildVersionQr(row);

    return {
      prescriptionId: row.prescription_id,
      versionNumber: row.version_number,
      status: row.status,
      patient: { name: parties.patient_name, patientId: parties.patient_id, dob: parties.patient_dob },
      provider: { name: parties.provider_name, licenseNumber: parties.license_number },
      heightCm: row.height_cm, // exact DECIMAL string, or null when not recorded
      weightKg: row.weight_kg,
      route: row.route,
      // Module 14: every medicine of this exact version, in sequence (submission) order.
      medicines: row.medicines.map((medicine) => ({
        sequenceNumber: medicine.sequence_number,
        drugName: medicine.drug_name,
        drugClass: medicine.drug_class,
        dosageValue: medicine.dosage_value, // exact DECIMAL string, e.g. "500.000"
        dosageUnit: medicine.dosage_unit,
        frequency: medicine.frequency,
        durationDays: medicine.duration_days,
        quantityPrescribed: medicine.quantity_prescribed,
      })),
      integrityRoot: row.integrity_root,
      ledgerAnchorRef: row.ledger_anchor_ref,
      issuedAt: qrPayload.issuedAt, // exactly the issuedAt encoded in the QR
      qrImage,
    };
  }

  return Object.freeze({ getPrescriptionDocument });
}

module.exports = { createPrescriptionDocuments };
