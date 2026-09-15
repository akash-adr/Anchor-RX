'use strict';

/**
 * Anchor Rx — Module 15: score every medicine of a submission (a PURE scoring pass — nothing is written anywhere).
 *
 *   const sharedContext = await buildSharedContext({ patientId, providerId, heightCm, weightKg });
 *   const results = await scoreAllMedicines(medicines, sharedContext);
 *   // → [{ medicineIndex, drugName, riskScore, riskBand, reasons }]  in submission order (medicineIndex 0-based)
 *
 * Call count: exactly ONE AI-service call per medicine per scoreAllMedicines() call — N medicines, N calls, made one at
 * a time in submission order. Every payload is built BEFORE the first call, so an invalid medicine fails the pass
 * without any AI call. If any AI call fails, the whole pass throws that AIServiceError (no partial result is returned);
 * the confirm flow (Step 3) decides what the prescriber sees.
 *
 * Duplication context: each medicine gets every OTHER medicine's drug_class as siblings, so two same-class medicines
 * in one visit are flagged even when neither overlaps any other active prescription.
 */

const { createScoringPayloadBuilder, buildScoringPayloadForMedicine, ScoringPayloadError } = require('./buildScoringPayload');
const { createScoreClient } = require('./scoreClient');

function createMedicineScorer(pool, { payloadBuilder = createScoringPayloadBuilder(pool), scoreClient = createScoreClient(pool, { payloadBuilder }) } = {}) {
  /**
   * @param {Array<{ drugName, drugClass, dosageValue, dosageUnit, frequency, durationDays }>} medicines in submission order
   * @param {object} sharedContext from buildSharedContext
   * @returns {Promise<Array<{ medicineIndex: number, drugName: string, riskScore: number, riskBand: string, reasons: Array }>>}
   * @throws {ScoringPayloadError} NO_MEDICINES | INVALID_MEDICINE (before any AI call)
   * @throws {AIServiceError} any AI-service failure
   */
  async function scoreAllMedicines(medicines, sharedContext, featureInputs = null) {
    if (!Array.isArray(medicines) || medicines.length === 0) {
      throw new ScoringPayloadError('NO_MEDICINES', 'scoreAllMedicines needs at least one medicine');
    }
    // Module 16: optional live feature inputs from buildFeatureInputs, one per medicine in the same order.
    if (featureInputs !== null && (!Array.isArray(featureInputs) || featureInputs.length !== medicines.length)) {
      throw new ScoringPayloadError('INVALID_FEATURE_INPUTS', 'featureInputs must have exactly one entry per medicine');
    }

    const payloads = medicines.map((medicine, index) =>
      buildScoringPayloadForMedicine(
        medicine,
        sharedContext,
        medicines.filter((_, otherIndex) => otherIndex !== index).map((other) => other.drugClass),
        featureInputs ? featureInputs[index] : null,
      ),
    );

    const results = [];
    for (const [medicineIndex, payload] of payloads.entries()) {
      const risk = await scoreClient.scorePayloadViaAI(payload); // one call for this medicine — the only call site here
      results.push({ medicineIndex, drugName: medicines[medicineIndex].drugName, riskScore: risk.riskScore, riskBand: risk.riskBand, reasons: risk.reasons });
    }
    return results;
  }

  return Object.freeze({ buildSharedContext: payloadBuilder.buildSharedContext, scoreAllMedicines });
}

module.exports = { createMedicineScorer };
