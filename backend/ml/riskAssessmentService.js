'use strict';

/**
 * Anchor Rx — risk assessment for prescription CREATION: assess → confirm-and-create.
 * (Module 15's preview → confirm flow, renamed and upgraded when the Doctor Portal was wired end to end.)
 *
 *   assessPrescriptionRisk(submission)        POST /api/prescriptions/assess-risk
 *     validate exactly as createPrescription will → patient/provider exist
 *     → liveDataBridge.buildFeatureInputs (patient velocity ONCE; per-medicine queries concurrent across medicines)
 *     → scoreAllMedicines (one AI-service call per medicine, all concurrent; a failed call → that medicine only is
 *       { riskScore: null, riskBand: 'unavailable', reasons: [system reason] })
 *     → cache { submission, scores } SERVER-SIDE → { previewToken, medicines: [{ medicineIndex, drugName, riskScore,
 *       riskBand, reasons }] } in submission order. Writes NOTHING to the database.
 *
 *   confirmAndCreate(previewToken)            POST /api/prescriptions/confirm-and-create
 *     retrieve (single use) → the ONE createPrescription (hash → ledger anchor → version INSERT → medicine INSERTs
 *     carrying locked_risk_*, one transaction). It NEVER scores again and never accepts prescription or risk data from
 *     the client: what is locked is exactly what the prescriber was shown, for exactly what was scored.
 *
 * An unavailable AI assessment never skips the safeguard: the medicine is shown as unavailable, the prescriber still has
 * to confirm, and the lock records band 'unavailable' permanently (migration 014).
 *
 * KNOWN GAP: creation only. Amendments have no assess/confirm/lock step, so nothing passes existingPrescriptionVersionId.
 */

const { createPrescriptionVersionRepository, validateNewPrescription } = require('../db/repositories/prescriptionVersionRepository');
const { createMedicineScorer } = require('./scoreAllMedicines');
const { createPreviewCache } = require('./previewCache');
const { createLiveDataBridge } = require('./liveDataBridge');

class RiskPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskPreviewError';
    this.code = code;
  }
}

const RISK_PREVIEW_EXPIRED_MESSAGE =
  'This risk assessment has expired, was already used, or is not valid. Review the risk assessment again and resubmit the prescription.';

function createRiskAssessmentService(
  pool,
  {
    repository = createPrescriptionVersionRepository(pool),
    medicineScorer = createMedicineScorer(pool),
    previewCache = createPreviewCache(),
    liveDataBridge = createLiveDataBridge(pool),
  } = {},
) {
  /**
   * @param {object} submission { patientId, providerId, heightCm?, weightKg?, medicines: [...] } — createPrescription's
   *        input. Patient age is derived server-side from the patient's date of birth, never taken from the client.
   * @throws {RepositoryError} the submission would be rejected by createPrescription (same validation, run first)
   * @throws {RiskPreviewError} UNKNOWN_REFERENCE
   */
  async function assessPrescriptionRisk(submission) {
    // Exactly the normalization createPrescription applies, so what is scored is what will be saved.
    const { top, medicines } = validateNewPrescription(submission);

    const [[patient], [provider]] = await Promise.all([
      pool.execute('SELECT patient_id FROM patient WHERE patient_id = ?', [top.patient_id]).then(([rows]) => rows),
      pool.execute('SELECT provider_id FROM provider WHERE provider_id = ?', [top.provider_id]).then(([rows]) => rows),
    ]);
    if (!patient || !provider) {
      throw new RiskPreviewError('UNKNOWN_REFERENCE', `${!patient ? `patientId ${top.patient_id}` : `providerId ${top.provider_id}`} does not exist`);
    }

    // Live feature inputs first: velocity once for the patient, duplication/rarity per medicine (concurrently).
    const featureInputs = await liveDataBridge.buildFeatureInputs({
      patientId: top.patient_id,
      providerId: top.provider_id,
      heightCm: top.height_cm,
      weightKg: top.weight_kg,
      medicines: medicines.map((m) => ({
        drugName: m.drug_name,
        drugClass: m.drug_class,
        doseValue: m.dosage_value,
        doseUnit: m.dosage_unit,
        frequency: m.frequency,
        duration: m.duration_days,
      })),
    });

    const sharedContext = await medicineScorer.buildSharedContext({
      patientId: top.patient_id,
      providerId: top.provider_id,
      heightCm: top.height_cm,
      weightKg: top.weight_kg,
      knownPatientVelocity: featureInputs[0].patient_velocity, // already queried once — don't query it again
    });
    const scores = await medicineScorer.scoreAllMedicines(
      medicines.map((m) => ({
        drugName: m.drug_name,
        drugClass: m.drug_class,
        dosageValue: m.dosage_value,
        dosageUnit: m.dosage_unit,
        frequency: m.frequency,
        durationDays: m.duration_days,
      })),
      sharedContext,
      featureInputs,
    );

    const medicineResults = scores.map(({ medicineIndex, drugName, riskScore, riskBand, reasons }) => ({ medicineIndex, drugName, riskScore, riskBand, reasons }));
    const previewToken = previewCache.store({ submission, scores: medicineResults });
    return { previewToken, medicines: medicineResults };
  }

  /**
   * @returns {Promise<object>} the created version row (with medicines carrying locked_risk_*)
   * @throws {RiskPreviewError} PREVIEW_TOKEN_REQUIRED | RISK_PREVIEW_EXPIRED (expired, already used, or unknown)
   * @throws {RepositoryError} createPrescription refused — nothing was written (one transaction)
   */
  async function confirmAndCreate(previewToken) {
    if (typeof previewToken !== 'string' || previewToken.trim() === '') {
      throw new RiskPreviewError('PREVIEW_TOKEN_REQUIRED', 'previewToken is required: assess the risk before confirming');
    }
    const cached = previewCache.retrieve(previewToken);
    if (!cached) {
      throw new RiskPreviewError('RISK_PREVIEW_EXPIRED', RISK_PREVIEW_EXPIRED_MESSAGE);
    }
    // No scoring call here — deliberately. The cached result (including any 'unavailable' medicine) IS the locked risk.
    return repository.createPrescription(cached.submission, {
      lockedRisks: cached.scores.map(({ riskScore, riskBand, reasons }) => ({ riskScore, riskBand, reasons })),
    });
  }

  return Object.freeze({ assessPrescriptionRisk, confirmAndCreate });
}

module.exports = { createRiskAssessmentService, RiskPreviewError, RISK_PREVIEW_EXPIRED_MESSAGE };
