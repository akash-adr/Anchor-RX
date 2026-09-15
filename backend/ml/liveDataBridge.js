'use strict';

/**
 * Anchor Rx — Module 16: live data bridge. Real risk-feature inputs computed from actual prescription data, replacing
 * placeholder / synthetic-corpus values. Step 1: the four query functions in isolation (no orchestration yet).
 *
 *   checkDrugClassDuplication(patientId, drugClass, excludePrescriptionVersionId, otherMedicinesInThisSubmission) → 0 | 1
 *   getPatientVelocity30d(patientId)                                                                          → integer
 *   getProviderRarityScore(providerId, drugClass)                                                             → 0..1
 *   getDrugRarityScore(drugName)                                                                              → 0..1
 *
 * Counting semantics — ONE PER PRESCRIPTION (decided in Module 16 Step 2; Step 1 counted rows):
 *   velocity     prescriptions ISSUED to the patient in the last 30 days (version 1 rows) — amendments add nothing
 *   rarity       medicines on each prescription's CURRENT (latest) version only — an amendment's copied-forward medicines
 *                are not counted again. Revoked prescriptions still count toward rarity (they were prescribed).
 *   duplication  ACTIVE versions only; a prescription has at most one active version, so it was already per prescription.
 *
 * Status in the scoring flow (Module 16 Step 2):
 *   - buildFeatureInputs feeds drug_combination_flag and patient_velocity into POST /api/prescriptions/preview-risk.
 *   - HELD: drug_rarity_score / provider_rarity_score are computed but NOT sent to the AI service. Their live definitions
 *     differ from what the trained Isolation Forest expects (measured on 600 normal corpus prescriptions: Review went
 *     from 1 to 20), and renaming provider_pattern_score breaks the saved pipeline. Python keeps its corpus-derived
 *     values until the model is retrained on — or Node is aligned to — one definition.
 *   - KNOWN GAP: existingPrescriptionVersionId has no caller. Amendments have no preview/confirm/lock step (Module 15
 *     covers creation only), so amended versions are not risk-scored.
 *
 * Drug class/name equality uses the column collation (utf8mb4_0900_ai_ci: case-insensitive);
 * inputs are trimmed. Rarity = (total − count) / total — the same value as 1 − count/total, computed without the
 * floating-point error (1 − 8/10 is 0.19999999999999996 in JS; (10 − 8)/10 is exactly 0.2).
 */

const NEUTRAL_RARITY = 0.5; // no history at all → neither common nor rare

class LiveDataBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveDataBridgeError';
    this.code = code;
  }
}

function requireText(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LiveDataBridgeError('INVALID_INPUT', `${name} must be a non-empty string`);
  }
  return value.trim();
}

const sameClass = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

function rarity(count, total) {
  const n = Number(total);
  if (n === 0) return NEUTRAL_RARITY;
  return (n - Number(count ?? 0)) / n;
}

function createLiveDataBridge(pool) {
  /**
   * 1 if the patient has another ACTIVE prescription version with a medicine in this class (DB), or if another
   * medicine on the current, not-yet-saved submission shares the class (in memory — those medicines aren't in the DB).
   * @param {number|null} excludePrescriptionVersionId the version being amended; null for a brand-new prescription
   * @param {Array<{drugClass: string}>} otherMedicinesInThisSubmission the OTHER medicines on the form (not this one)
   */
  async function checkDrugClassDuplication(patientId, drugClass, excludePrescriptionVersionId, otherMedicinesInThisSubmission = []) {
    const patient = requireText('patientId', patientId);
    const cls = requireText('drugClass', drugClass);
    if (excludePrescriptionVersionId !== null && excludePrescriptionVersionId !== undefined && !Number.isSafeInteger(excludePrescriptionVersionId)) {
      throw new LiveDataBridgeError('INVALID_INPUT', 'excludePrescriptionVersionId must be an integer id or null');
    }
    if (!Array.isArray(otherMedicinesInThisSubmission)) {
      throw new LiveDataBridgeError('INVALID_INPUT', 'otherMedicinesInThisSubmission must be an array');
    }

    const exclude = excludePrescriptionVersionId !== null && excludePrescriptionVersionId !== undefined;
    // A brand-new prescription omits the exclusion clause entirely — never "pv.id != NULL" (which matches nothing).
    const sql = `SELECT COUNT(*) AS n
                   FROM prescription_medicine pm
                   JOIN prescription_version pv ON pm.prescription_version_id = pv.id
                  WHERE pv.patient_id = ? AND pm.drug_class = ? AND pv.status = 'active'${exclude ? ' AND pv.id != ?' : ''}`;
    const [[row]] = await pool.execute(sql, exclude ? [patient, cls, excludePrescriptionVersionId] : [patient, cls]);
    if (Number(row.n) > 0) return 1;

    // In-memory only: the other medicines on this submission do not exist in the database yet.
    return otherMedicinesInThisSubmission.some((medicine) => sameClass(medicine?.drugClass, cls)) ? 1 : 0;
  }

  /** Prescriptions issued to this patient (version 1 rows) in the last 30 days (database clock, UTC session). */
  async function getPatientVelocity30d(patientId) {
    const [[row]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM prescription_version WHERE patient_id = ? AND version_number = 1 AND created_at > (NOW() - INTERVAL 30 DAY)',
      [requireText('patientId', patientId)],
    );
    return Number(row.n);
  }

  /** 1 − (medicines in the class / all medicines) on the CURRENT version of each of this provider's prescriptions; 0.5 with no history. */
  async function getProviderRarityScore(providerId, drugClass) {
    const provider = requireText('providerId', providerId);
    const [[row]] = await pool.execute(
      `SELECT SUM(CASE WHEN pm.drug_class = ? THEN 1 ELSE 0 END) AS class_count, COUNT(*) AS total_count
         FROM prescription_medicine pm
         JOIN prescription_version pv ON pm.prescription_version_id = pv.id
         JOIN (SELECT prescription_id, MAX(version_number) AS latest
                 FROM prescription_version WHERE provider_id = ? GROUP BY prescription_id) cur
           ON cur.prescription_id = pv.prescription_id AND cur.latest = pv.version_number
        WHERE pv.provider_id = ?`,
      [requireText('drugClass', drugClass), provider, provider],
    );
    return rarity(row.class_count, row.total_count);
  }

  /** 1 − (medicines with this drug name / all medicines) across every prescription's CURRENT version; 0.5 with no history. */
  async function getDrugRarityScore(drugName) {
    const [[row]] = await pool.execute(
      `SELECT SUM(CASE WHEN pm.drug_name = ? THEN 1 ELSE 0 END) AS drug_count, COUNT(*) AS total_count
         FROM prescription_medicine pm
         JOIN prescription_version pv ON pm.prescription_version_id = pv.id
         JOIN (SELECT prescription_id, MAX(version_number) AS latest FROM prescription_version GROUP BY prescription_id) cur
           ON cur.prescription_id = pv.prescription_id AND cur.latest = pv.version_number`,
      [requireText('drugName', drugName)],
    );
    return rarity(row.drug_count, row.total_count);
  }

  /**
   * Step 2: real feature inputs for EVERY medicine of a draft prescription, in the draft's order.
   *
   * @param {object} prescriptionDraft { patientId, providerId, heightCm?, weightKg?,
   *        medicines: [{ drugName, drugClass, doseValue, doseUnit, frequency, duration }],
   *        existingPrescriptionVersionId? (only when amending — excluded from the duplication check) }
   * @returns {Promise<object[]>} one object per medicine. Keys use Python's EXISTING feature names
   *        (drug_combination_flag, patient_velocity, drug_rarity_score) plus provider_rarity_score, and carry the
   *        medicine's own dose/frequency/duration and the shared height/weight. doseValue stays the exact string.
   *        All four queries run for each medicine (velocity is per patient, so it is the same for every medicine).
   * Read-only: writes nothing.
   */
  async function buildFeatureInputs(prescriptionDraft) {
    if (prescriptionDraft === null || typeof prescriptionDraft !== 'object' || Array.isArray(prescriptionDraft)) {
      throw new LiveDataBridgeError('INVALID_INPUT', 'prescriptionDraft must be an object');
    }
    const { patientId, providerId, heightCm = null, weightKg = null, medicines, existingPrescriptionVersionId = null } = prescriptionDraft;
    if (!Array.isArray(medicines) || medicines.length === 0) {
      throw new LiveDataBridgeError('INVALID_INPUT', 'prescriptionDraft.medicines must be a non-empty array');
    }
    medicines.forEach((medicine, index) => {
      if (medicine === null || typeof medicine !== 'object') throw new LiveDataBridgeError('INVALID_INPUT', `medicines[${index}] must be an object`);
      requireText(`medicines[${index}].drugName`, medicine.drugName);
      requireText(`medicines[${index}].drugClass`, medicine.drugClass);
    });

    const features = [];
    for (const [index, medicine] of medicines.entries()) {
      const others = medicines.filter((_, otherIndex) => otherIndex !== index);
      const [drugCombinationFlag, patientVelocity, providerRarity, drugRarity] = await Promise.all([
        checkDrugClassDuplication(patientId, medicine.drugClass, existingPrescriptionVersionId, others),
        getPatientVelocity30d(patientId),
        getProviderRarityScore(providerId, medicine.drugClass),
        getDrugRarityScore(medicine.drugName),
      ]);
      features.push({
        medicine_index: index,
        drug_name: medicine.drugName,
        drug_class: medicine.drugClass,
        dose_value: medicine.doseValue, // exact decimal string — never parsed here
        dose_unit: medicine.doseUnit,
        frequency: medicine.frequency,
        duration_days: medicine.duration,
        height_cm: heightCm === null || heightCm === undefined ? null : Number(heightCm),
        weight_kg: weightKg === null || weightKg === undefined ? null : Number(weightKg),
        drug_combination_flag: drugCombinationFlag, // ← checkDrugClassDuplication (Python's existing key)
        patient_velocity: patientVelocity, // ← getPatientVelocity30d (Python's existing key)
        drug_rarity_score: drugRarity, // ← getDrugRarityScore
        provider_rarity_score: providerRarity, // ← getProviderRarityScore
      });
    }
    return features;
  }

  return Object.freeze({ checkDrugClassDuplication, getPatientVelocity30d, getProviderRarityScore, getDrugRarityScore, buildFeatureInputs });
}

module.exports = { createLiveDataBridge, LiveDataBridgeError, NEUTRAL_RARITY };
