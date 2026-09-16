'use strict';

/**
 * Anchor Rx — Module 15: score every medicine of a submission (a PURE scoring pass — nothing is written anywhere).
 *
 *   const sharedContext = await buildSharedContext({ patientId, providerId, heightCm, weightKg });
 *   const results = await scoreAllMedicines(medicines, sharedContext);
 *   // → [{ medicineIndex, drugName, riskScore, riskBand, reasons }]  in submission order (medicineIndex 0-based)
 *
 * Call count: exactly ONE AI-service call per medicine per scoreAllMedicines() call — N medicines, N calls, all made
 * CONCURRENTLY (a slow or dead service costs one timeout for the whole prescription, not N × timeout). Every payload is
 * built BEFORE any call, so an invalid medicine fails the pass without any AI call.
 *
 * Per-medicine failure: when the call for ONE medicine fails with an AIServiceError (timeout, connection refused,
 * non-200, unreadable response), only that medicine becomes
 *   { riskScore: null, riskBand: 'unavailable', reasons: [AI_RISK_UNAVAILABLE_REASON] }
 * and every other medicine keeps its real result. Any other error is a bug, not an outage, and is thrown.
 *
 * Duplication context: each medicine gets every OTHER medicine's drug_class as siblings, so two same-class medicines
 * in one visit are flagged even when neither overlaps any other active prescription.
 */

const { createScoringPayloadBuilder, buildScoringPayloadForMedicine, ScoringPayloadError } = require('./buildScoringPayload');
const { createScoreClient, AIServiceError } = require('./scoreClient');

const UNAVAILABLE_RISK_BAND = 'unavailable';
const AI_RISK_UNAVAILABLE_REASON = Object.freeze({ source: 'system', feature: 'ai_service', explanation: 'AI risk assessment was unavailable at this time.' });

function unavailableResult(medicineIndex, drugName) {
  return { medicineIndex, drugName, riskScore: null, riskBand: UNAVAILABLE_RISK_BAND, reasons: [{ ...AI_RISK_UNAVAILABLE_REASON }] };
}

function createMedicineScorer(pool, { payloadBuilder = createScoringPayloadBuilder(pool), scoreClient = createScoreClient(pool, { payloadBuilder }) } = {}) {
  /**
   * @param {Array<{ drugName, drugClass, dosageValue, dosageUnit, frequency, durationDays }>} medicines in submission order
   * @param {object} sharedContext from buildSharedContext
   * @returns {Promise<Array<{ medicineIndex: number, drugName: string, riskScore: number, riskBand: string, reasons: Array }>>}
   * @throws {ScoringPayloadError} NO_MEDICINES | INVALID_MEDICINE (before any AI call)
   * AI-service failures do not throw: the affected medicine is returned as 'unavailable'.
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

    // One call per medicine — the only call site here — all started together.
    const settled = await Promise.allSettled(payloads.map((payload) => scoreClient.scorePayloadViaAI(payload)));
    return settled.map((outcome, medicineIndex) => {
      const { drugName } = medicines[medicineIndex];
      if (outcome.status === 'fulfilled') {
        const { riskScore, riskBand, reasons } = outcome.value;
        return { medicineIndex, drugName, riskScore, riskBand, reasons };
      }
      if (!(outcome.reason instanceof AIServiceError)) throw outcome.reason; // not an AI outage — surface it
      return unavailableResult(medicineIndex, drugName);
    });
  }

  return Object.freeze({ buildSharedContext: payloadBuilder.buildSharedContext, scoreAllMedicines });
}

module.exports = { createMedicineScorer, UNAVAILABLE_RISK_BAND, AI_RISK_UNAVAILABLE_REASON };
