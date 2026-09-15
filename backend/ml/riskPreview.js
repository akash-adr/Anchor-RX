'use strict';

/**
 * Anchor Rx — Module 15: preview-then-confirm prescription creation.
 *
 *   previewRisk(submission)          validate → score every medicine (scoreAllMedicines) → cache { submission, scores }
 *                                    → { previewToken, medicines: [{ drugName, riskScore, riskBand, reasons }] }
 *                                    Writes NOTHING to the database.
 *   confirmPrescription(previewToken) retrieve (single use) → createPrescription(cached submission, cached scores)
 *                                    NEVER scores again: the locked risk is exactly what the prescriber was shown, and
 *                                    the saved prescription is exactly what was scored (the client resubmits nothing).
 *
 * Module 16: previewRisk calls liveDataBridge.buildFeatureInputs FIRST and scores with its live per-medicine
 * drug_combination_flag and patient_velocity. The two rarity scores are HELD (not sent) — see ml/liveDataBridge.js.
 *
 * KNOWN GAP (Module 16 Step 2 decision): this preview → confirm → lock flow covers prescription CREATION only.
 * Amendments have no preview/confirm/lock step, so amended versions are not risk-scored and nothing passes
 * existingPrescriptionVersionId to buildFeatureInputs yet.
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

function createRiskPreviewService(
  pool,
  {
    repository = createPrescriptionVersionRepository(pool),
    medicineScorer = createMedicineScorer(pool),
    previewCache = createPreviewCache(),
    liveDataBridge = createLiveDataBridge(pool),
  } = {},
) {
  /**
   * @param {object} submission { patientId, providerId, heightCm?, weightKg?, medicines: [...] } — createPrescription's input
   * @throws {RepositoryError} the submission would be rejected by createPrescription (same validation, run first)
   * @throws {RiskPreviewError} UNKNOWN_REFERENCE
   * @throws {AIServiceError} the AI service failed — nothing is cached
   */
  async function previewRisk(submission) {
    // Exactly the normalization createPrescription applies, so what is scored is what will be saved.
    const { top, medicines } = validateNewPrescription(submission);

    const [[patient], [provider]] = await Promise.all([
      pool.execute('SELECT patient_id FROM patient WHERE patient_id = ?', [top.patient_id]).then(([rows]) => rows),
      pool.execute('SELECT provider_id FROM provider WHERE provider_id = ?', [top.provider_id]).then(([rows]) => rows),
    ]);
    if (!patient || !provider) {
      throw new RiskPreviewError('UNKNOWN_REFERENCE', `${!patient ? `patientId ${top.patient_id}` : `providerId ${top.provider_id}`} does not exist`);
    }

    // Module 16: real per-medicine feature inputs from live data, BEFORE scoring. Creation only — no
    // existingPrescriptionVersionId (amendments have no preview/confirm/lock step: known gap).
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

    const medicineResults = scores.map(({ drugName, riskScore, riskBand, reasons }) => ({ drugName, riskScore, riskBand, reasons }));
    const previewToken = previewCache.store({ submission, scores: medicineResults });
    return { previewToken, medicines: medicineResults };
  }

  /**
   * @returns {Promise<object>} the created version row (with medicines carrying locked_risk_*)
   * @throws {RiskPreviewError} PREVIEW_TOKEN_REQUIRED | RISK_PREVIEW_EXPIRED (expired, already used, or unknown)
   * @throws {RepositoryError} createPrescription refused (e.g. a reference disappeared) — nothing was written
   */
  async function confirmPrescription(previewToken) {
    if (typeof previewToken !== 'string' || previewToken.trim() === '') {
      throw new RiskPreviewError('PREVIEW_TOKEN_REQUIRED', 'previewToken is required: preview the risk assessment before confirming');
    }
    const cached = previewCache.retrieve(previewToken);
    if (!cached) {
      throw new RiskPreviewError('RISK_PREVIEW_EXPIRED', RISK_PREVIEW_EXPIRED_MESSAGE);
    }
    // No scoring call here — deliberately. The cached result IS the locked risk.
    return repository.createPrescription(cached.submission, {
      lockedRisks: cached.scores.map(({ riskScore, riskBand, reasons }) => ({ riskScore, riskBand, reasons })),
    });
  }

  return Object.freeze({ previewRisk, confirmPrescription });
}

module.exports = { createRiskPreviewService, RiskPreviewError, RISK_PREVIEW_EXPIRED_MESSAGE };
