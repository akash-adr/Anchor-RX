'use strict';

/**
 * Anchor Rx — Module 8: scoring payload assembly (Node side of the Node ↔ Python boundary).
 *
 * The Python AI service is stateless and never touches MySQL. Node gathers everything the risk engine needs
 * into ONE JSON object — this is the exact contract ai-service/features/payload.py (ScoringPayload) consumes.
 *
 * ┌─────────────────────────── ScoringPayload v1 ───────────────────────────────────────────────────────────┐
 * │ payloadVersion            1                          contract version (bump on any breaking change)       │
 * │ prescriptionId            "RX-DEMO-0003"             traceability only — not a model feature              │
 * │ versionNumber             1                          traceability only                                    │
 * │ patientId, providerId     "PAT-002", "PRV-001"       traceability only                                    │
 * │ referenceTime             ISO-8601 UTC               the scored version's created_at; time windows use it │
 * │ drugName                  "Rosuvastatin"                                                                  │
 * │ drugClass                 "statin"                   as stored                                            │
 * │ doseValue                 "10.000"                   EXACT decimal string (never a float in Node)         │
 * │ doseUnit                  "mg"                                                                            │
 * │ frequency                 "once daily"               free text as prescribed                             │
 * │ durationDays              30                                                                              │
 * │ route                     "oral"                                                                          │
 * │ patientAge                63                         whole years from patient.dob at call time            │
 * │ patientWeight             82 | 70                    kg; 70 when unknown (see patientWeightIsDefault)     │
 * │ patientWeightIsDefault    false                      true → weight is the population placeholder         │
 * │ drugCombinationFlag       true                       another ACTIVE prescription in the same drug class   │
 * │ overlappingPrescriptionIds ["RX-DEMO-0002"]          which ones (for explanations)                        │
 * │ providerDrugClassHistory  { "statin": 1, ... }       provider's OTHER prescriptions per drug class        │
 * │ patientVelocity           2                          patient's OTHER prescriptions in the 30 days before  │
 * └───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createMlFeatureRepository } = require('../db/repositories/mlFeatureRepository');

const PAYLOAD_VERSION = 1;

// PLACEHOLDER: synthetic population-average adult weight (kg), used only until real patient weight is captured
// consistently. The same constant exists in ai-service/features/extract.py. Payloads using it set
// patientWeightIsDefault: true so downstream explanations don't overstate dose-per-kg findings.
const DEFAULT_PATIENT_WEIGHT_KG = 70;

const VELOCITY_WINDOW_DAYS = 30;

class ScoringPayloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScoringPayloadError';
    this.code = code;
  }
}

function wholeYearsBetween(dob, now) {
  const birth = new Date(dob);
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  const birthdayNotYetReached =
    now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (birthdayNotYetReached) years -= 1;
  return years;
}

function createScoringPayloadBuilder(
  pool,
  { repository = createPrescriptionVersionRepository(pool), featureRepository = createMlFeatureRepository(pool), now = () => new Date() } = {},
) {
  /**
   * @returns {Promise<object>} ScoringPayload v1 (see table above)
   * @throws {ScoringPayloadError} VERSION_NOT_FOUND | PATIENT_NOT_FOUND
   */
  async function buildScoringPayload(prescriptionId, versionNumber) {
    const version = await repository.getVersion(prescriptionId, versionNumber);
    if (!version) {
      throw new ScoringPayloadError('VERSION_NOT_FOUND', `${prescriptionId} v${versionNumber} does not exist`);
    }
    const patient = await featureRepository.getPatient(version.patient_id);
    if (!patient) {
      throw new ScoringPayloadError('PATIENT_NOT_FOUND', `Patient ${version.patient_id} does not exist`);
    }

    const referenceTime = version.created_at;
    const [overlappingPrescriptionIds, providerDrugClassHistory, patientVelocity] = await Promise.all([
      featureRepository.findActiveSameClassPrescriptions(version.patient_id, version.drug_class, prescriptionId),
      featureRepository.getProviderDrugClassHistory(version.provider_id, prescriptionId),
      featureRepository.countRecentPatientPrescriptions(version.patient_id, referenceTime, prescriptionId, VELOCITY_WINDOW_DAYS),
    ]);

    const weightKnown = patient.weight !== null && patient.weight !== undefined;

    return {
      payloadVersion: PAYLOAD_VERSION,
      prescriptionId: version.prescription_id,
      versionNumber: version.version_number,
      patientId: version.patient_id,
      providerId: version.provider_id,
      referenceTime: new Date(referenceTime).toISOString(),
      drugName: version.drug_name,
      drugClass: version.drug_class,
      doseValue: version.dosage_value, // exact DECIMAL string — parsed only inside the Python feature extractor
      doseUnit: version.dosage_unit,
      frequency: version.frequency,
      durationDays: version.duration_days,
      route: version.route,
      patientAge: wholeYearsBetween(patient.dob, now()),
      patientWeight: weightKnown ? Number(patient.weight) : DEFAULT_PATIENT_WEIGHT_KG,
      patientWeightIsDefault: !weightKnown,
      drugCombinationFlag: overlappingPrescriptionIds.length > 0,
      overlappingPrescriptionIds,
      providerDrugClassHistory,
      patientVelocity,
    };
  }

  return Object.freeze({ buildScoringPayload });
}

module.exports = { createScoringPayloadBuilder, ScoringPayloadError, PAYLOAD_VERSION, DEFAULT_PATIENT_WEIGHT_KG };
