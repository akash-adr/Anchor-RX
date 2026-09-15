'use strict';

/**
 * Read-only queries for the AI risk engine's scoring payload (Module 8).
 * Only aggregate lookups the prescription_version repository doesn't already provide live here.
 * Drug classes are compared trimmed and case-insensitively (the hash engine also lowercases drug_class).
 */

// The latest version of each of a patient's prescriptions (a prescription's "current" row).
const LATEST_VERSIONS_FOR_PATIENT = `
  SELECT pv.prescription_id, pv.drug_class, pv.status
    FROM prescription_version pv
    JOIN (SELECT prescription_id, MAX(version_number) AS latest
            FROM prescription_version
           WHERE patient_id = ?
           GROUP BY prescription_id) l
      ON l.prescription_id = pv.prescription_id AND l.latest = pv.version_number`;

function createMlFeatureRepository(pool) {
  async function getPatient(patientId) {
    const [rows] = await pool.execute('SELECT patient_id, dob, weight FROM patient WHERE patient_id = ?', [patientId]);
    return rows[0] || null;
  }

  /** OTHER prescriptions of this patient whose CURRENT version is active and in the same drug class. */
  async function findActiveSameClassPrescriptions(patientId, drugClass, excludePrescriptionId) {
    const [rows] = await pool.execute(
      `SELECT prescription_id FROM (${LATEST_VERSIONS_FOR_PATIENT}) latest
        WHERE prescription_id <> ? AND status = 'active' AND LOWER(TRIM(drug_class)) = LOWER(TRIM(?))
        ORDER BY prescription_id`,
      [patientId, excludePrescriptionId, drugClass],
    );
    return rows.map((row) => row.prescription_id);
  }

  /**
   * { drugClass: count } over the provider's OTHER prescriptions (one count per prescription, using its
   * version 1 row — provider_id and drug_class never change across a prescription's versions).
   */
  async function getProviderDrugClassHistory(providerId, excludePrescriptionId) {
    const [rows] = await pool.execute(
      `SELECT LOWER(TRIM(drug_class)) AS drug_class, COUNT(*) AS n
         FROM prescription_version
        WHERE provider_id = ? AND version_number = 1 AND prescription_id <> ?
        GROUP BY LOWER(TRIM(drug_class))
        ORDER BY drug_class`,
      [providerId, excludePrescriptionId],
    );
    return Object.fromEntries(rows.map((row) => [row.drug_class, Number(row.n)]));
  }

  /** OTHER prescriptions issued to the patient in the 30 days up to (and including) referenceTime. */
  async function countRecentPatientPrescriptions(patientId, referenceTime, excludePrescriptionId, windowDays = 30) {
    const [[row]] = await pool.execute(
      `SELECT COUNT(*) AS n
         FROM prescription_version
        WHERE patient_id = ? AND version_number = 1 AND prescription_id <> ?
          AND created_at > DATE_SUB(?, INTERVAL ? DAY) AND created_at <= ?`,
      [patientId, excludePrescriptionId, referenceTime, windowDays, referenceTime],
    );
    return Number(row.n);
  }

  return Object.freeze({ getPatient, findActiveSameClassPrescriptions, getProviderDrugClassHistory, countRecentPatientPrescriptions });
}

module.exports = { createMlFeatureRepository };
