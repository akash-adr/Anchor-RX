'use strict';

/**
 * Read-only queries for the AI risk engine's scoring payload (Module 8; per-medicine since Module 15).
 * Only aggregate lookups the prescription_version repository doesn't already provide live here.
 * Drug classes are compared trimmed and case-insensitively (the hash engine also lowercases drug_class).
 *
 * Every `excludePrescriptionId` may be null: a prescription that is being PREVIEWED (Module 15) has no ID yet, and
 * `prescription_id <> NULL` would silently match nothing — so each query uses `(? IS NULL OR prescription_id <> ?)`.
 *
 * providerDrugClassHistory still counts each prescription's FIRST medicine (sequence_number = 1) — unchanged from
 * Module 14 and outside Module 15's scope.
 */

const PRIMARY_MEDICINE_JOIN = 'JOIN prescription_medicine pm ON pm.prescription_version_id = pv.id AND pm.sequence_number = 1';

// Every medicine's class on the CURRENT (latest) version of each of the patient's OTHER prescriptions that is active.
const ACTIVE_DRUG_CLASSES_FOR_PATIENT_SQL = `
  SELECT DISTINCT pv.prescription_id, LOWER(TRIM(pm.drug_class)) AS drug_class
    FROM prescription_version pv
    JOIN (SELECT prescription_id, MAX(version_number) AS latest
            FROM prescription_version
           WHERE patient_id = ?
           GROUP BY prescription_id) l
      ON l.prescription_id = pv.prescription_id AND l.latest = pv.version_number
    JOIN prescription_medicine pm ON pm.prescription_version_id = pv.id
   WHERE pv.status = 'active' AND (? IS NULL OR pv.prescription_id <> ?)
   ORDER BY pv.prescription_id, drug_class`;

function createMlFeatureRepository(pool) {
  async function getPatient(patientId) {
    const [rows] = await pool.execute('SELECT patient_id, dob, weight FROM patient WHERE patient_id = ?', [patientId]);
    return rows[0] || null;
  }

  /**
   * [{ prescriptionId, drugClass }] for every medicine on the current version of the patient's OTHER active
   * prescriptions (any medicine, not just the first). Fetched once per scoring pass; the per-medicine duplication
   * check filters it in memory, so all medicines of one submission are compared against the same snapshot.
   */
  async function getActiveDrugClassesForPatient(patientId, excludePrescriptionId = null) {
    const [rows] = await pool.execute(ACTIVE_DRUG_CLASSES_FOR_PATIENT_SQL, [patientId, excludePrescriptionId, excludePrescriptionId]);
    return rows.map((row) => ({ prescriptionId: row.prescription_id, drugClass: row.drug_class }));
  }

  /**
   * { drugClass: count } over the provider's OTHER prescriptions (one count per prescription, using its version 1 row
   * and first medicine — provider_id and drug classes never change across a prescription's versions).
   */
  async function getProviderDrugClassHistory(providerId, excludePrescriptionId = null) {
    const [rows] = await pool.execute(
      `SELECT LOWER(TRIM(pm.drug_class)) AS drug_class, COUNT(*) AS n
         FROM prescription_version pv
         ${PRIMARY_MEDICINE_JOIN}
        WHERE pv.provider_id = ? AND pv.version_number = 1 AND (? IS NULL OR pv.prescription_id <> ?)
        GROUP BY LOWER(TRIM(pm.drug_class))
        ORDER BY drug_class`,
      [providerId, excludePrescriptionId, excludePrescriptionId],
    );
    return Object.fromEntries(rows.map((row) => [row.drug_class, Number(row.n)]));
  }

  /** OTHER prescriptions issued to the patient in the 30 days up to (and including) referenceTime. */
  async function countRecentPatientPrescriptions(patientId, referenceTime, excludePrescriptionId = null, windowDays = 30) {
    const [[row]] = await pool.execute(
      `SELECT COUNT(*) AS n
         FROM prescription_version
        WHERE patient_id = ? AND version_number = 1 AND (? IS NULL OR prescription_id <> ?)
          AND created_at > DATE_SUB(?, INTERVAL ? DAY) AND created_at <= ?`,
      [patientId, excludePrescriptionId, excludePrescriptionId, referenceTime, windowDays, referenceTime],
    );
    return Number(row.n);
  }

  return Object.freeze({ getPatient, getActiveDrugClassesForPatient, getProviderDrugClassHistory, countRecentPatientPrescriptions });
}

module.exports = { createMlFeatureRepository };
