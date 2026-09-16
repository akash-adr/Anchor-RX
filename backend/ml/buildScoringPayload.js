'use strict';

/**
 * Anchor Rx — Module 8: scoring payload assembly (Node side of the Node ↔ Python boundary), per medicine since Module 15.
 *
 * The Python AI service is stateless and never touches MySQL. Node gathers everything the risk engine needs into ONE
 * JSON object per MEDICINE — the exact contract ai-service/features/payload.py (ScoringPayload) consumes.
 *
 * Primary path (Module 15):
 *   buildSharedContext({ patientId, providerId, heightCm?, weightKg?, ... })   DB lookups, ONCE per submission
 *   buildScoringPayloadForMedicine(medicineData, sharedContext, siblingDrugClasses)   pure — no DB, no I/O
 * Legacy wrapper (Module 9's evaluateTrust, unchanged caller): buildScoringPayload(prescriptionId, versionNumber,
 * sequenceNumber = 1) builds the context from a STORED version and scores the requested medicine with the others as
 * siblings.
 *
 * ┌─────────────────────────── ScoringPayload v1 ───────────────────────────────────────────────────────────┐
 * │ payloadVersion            1                          contract version (bump on any breaking change)       │
 * │ prescriptionId            "RX-DEMO-0003" | null      traceability only — null while previewing            │
 * │ versionNumber             1 | null                   traceability only                                    │
 * │ patientId, providerId     "PAT-002", "PRV-001"       traceability only                                    │
 * │ referenceTime             ISO-8601 UTC               version created_at, or "now" while previewing        │
 * │ drugName                  "Rosuvastatin"             THIS medicine                                        │
 * │ drugClass                 "statin"                   as entered/stored                                    │
 * │ doseValue                 "10.000"                   EXACT decimal string (never a float in Node)         │
 * │ doseUnit                  "mg"                                                                            │
 * │ frequency                 "once daily"               free text as prescribed                             │
 * │ durationDays              30                                                                              │
 * │ route                     "oral"                                                                          │
 * │ patientAge                63                         whole years from patient.dob at call time            │
 * │ patientWeight             82 | 70                    kg: prescription weight_kg → patient.weight → 70     │
 * │ patientWeightIsDefault    false                      true → weight is the population placeholder         │
 * │ patientHeight             172.5 | null               cm recorded on the prescription (Module 14); not a   │
 * │                                                      model feature                                        │
 * │ drugCombinationFlag       true                       EITHER source below overlaps this medicine's class   │
 * │ overlappingPrescriptionIds ["RX-DEMO-0002"]          source 1: other ACTIVE prescriptions (any medicine)  │
 * │ siblingSameClassCount     1                          source 2: other medicines on THIS submission         │
 * │ providerDrugClassHistory  { "statin": 1, ... }       provider's OTHER prescriptions per drug class        │
 * │ patientVelocity           2                          patient's OTHER prescriptions in the 30 days before  │
 * └───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 */

const { createPrescriptionVersionRepository } = require('../db/repositories/prescriptionVersionRepository');
const { createMlFeatureRepository } = require('../db/repositories/mlFeatureRepository');

const PAYLOAD_VERSION = 1;

// PLACEHOLDER: synthetic population-average adult weight (kg), used only when neither the prescription nor the patient
// record has a weight. The same constant exists in ai-service/features/extract.py. Payloads using it set
// patientWeightIsDefault: true so downstream explanations don't overstate dose-per-kg findings.
const DEFAULT_PATIENT_WEIGHT_KG = 70;

const VELOCITY_WINDOW_DAYS = 30;
const DEFAULT_ROUTE = 'oral'; // prescription_version.route column default (migration 007)

const MEDICINE_FIELDS = Object.freeze(['drugName', 'drugClass', 'dosageValue', 'dosageUnit', 'frequency', 'durationDays']);

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

/** Same comparison the SQL and hash engine use: trimmed, case-insensitive. */
const normalizeClass = (drugClass) => String(drugClass).trim().toLowerCase();

const isPresent = (value) => value !== null && value !== undefined;

function assertMedicineData(medicineData) {
  if (medicineData === null || typeof medicineData !== 'object' || Array.isArray(medicineData)) {
    throw new ScoringPayloadError('INVALID_MEDICINE', 'medicineData must be an object');
  }
  const missing = MEDICINE_FIELDS.filter((field) => !isPresent(medicineData[field]) || medicineData[field] === '');
  if (missing.length > 0) {
    throw new ScoringPayloadError('INVALID_MEDICINE', `medicineData is missing: ${missing.join(', ')}`);
  }
  if (typeof medicineData.dosageValue !== 'string') {
    // Exactness guarantee: a number here may already have lost precision; dose stays a string until Python parses it.
    throw new ScoringPayloadError('INVALID_MEDICINE', 'dosageValue must be the exact decimal string, never a number');
  }
}

/**
 * PURE. One medicine's ScoringPayload.
 *
 * @param {object} medicineData { drugName, drugClass, dosageValue (exact string), dosageUnit, frequency, durationDays }
 * @param {object} sharedContext from buildSharedContext — identical for every medicine of one submission
 * @param {string[]} [siblingDrugClasses] drug_class of every OTHER medicine on the same submission
 * @param {object|null} [featureInput] Module 16: this medicine's buildFeatureInputs() result. When given, its live
 *        drug_combination_flag and patient_velocity are what the payload carries. (Its rarity scores are HELD — not sent.)
 * @returns {object} ScoringPayload v1 (see table above)
 * @throws {ScoringPayloadError} INVALID_MEDICINE | INVALID_FEATURE_INPUT
 */
function buildScoringPayloadForMedicine(medicineData, sharedContext, siblingDrugClasses = [], featureInput = null) {
  assertMedicineData(medicineData);
  if (!Array.isArray(siblingDrugClasses)) {
    throw new ScoringPayloadError('INVALID_SIBLINGS', 'siblingDrugClasses must be an array of drug_class values');
  }
  if (featureInput !== null && (![0, 1].includes(featureInput?.drug_combination_flag) || !Number.isSafeInteger(featureInput?.patient_velocity) || featureInput.patient_velocity < 0)) {
    throw new ScoringPayloadError('INVALID_FEATURE_INPUT', 'featureInput needs drug_combination_flag (0|1) and a non-negative integer patient_velocity');
  }
  const ownClass = normalizeClass(medicineData.drugClass);

  // Duplication source 1: this patient's OTHER active prescriptions (any of their medicines).
  const overlappingPrescriptionIds = [
    ...new Set(sharedContext.activePrescriptionDrugClasses.filter((entry) => normalizeClass(entry.drugClass) === ownClass).map((entry) => entry.prescriptionId)),
  ].sort();
  // Duplication source 2: the other medicines prescribed alongside this one, in the same submission.
  const siblingSameClassCount = siblingDrugClasses.filter((drugClass) => normalizeClass(drugClass) === ownClass).length;

  return {
    payloadVersion: PAYLOAD_VERSION,
    prescriptionId: sharedContext.prescriptionId,
    versionNumber: sharedContext.versionNumber,
    patientId: sharedContext.patientId,
    providerId: sharedContext.providerId,
    referenceTime: sharedContext.referenceTime,
    drugName: medicineData.drugName,
    drugClass: medicineData.drugClass,
    doseValue: medicineData.dosageValue, // exact decimal string — parsed only inside the Python feature extractor
    doseUnit: medicineData.dosageUnit,
    frequency: medicineData.frequency,
    durationDays: Number(medicineData.durationDays),
    route: sharedContext.route,
    patientAge: sharedContext.patientAge,
    patientWeight: sharedContext.patientWeight,
    patientWeightIsDefault: sharedContext.patientWeightIsDefault,
    patientHeight: sharedContext.patientHeight,
    // Module 16: the live bridge's value when supplied; otherwise the two-source check above.
    drugCombinationFlag: featureInput ? featureInput.drug_combination_flag === 1 : overlappingPrescriptionIds.length > 0 || siblingSameClassCount > 0,
    overlappingPrescriptionIds,
    siblingSameClassCount,
    providerDrugClassHistory: sharedContext.providerDrugClassHistory,
    patientVelocity: featureInput ? featureInput.patient_velocity : sharedContext.patientVelocity,
  };
}

function createScoringPayloadBuilder(
  pool,
  { repository = createPrescriptionVersionRepository(pool), featureRepository = createMlFeatureRepository(pool), now = () => new Date() } = {},
) {
  /**
   * Everything that is the SAME for every medicine of one prescription, looked up once.
   *
   * @param {object} input { patientId, providerId, heightCm?, weightKg?, prescriptionId? (null while previewing),
   *        versionNumber?, referenceTime? (defaults to now), route? }
   * @throws {ScoringPayloadError} PATIENT_NOT_FOUND
   */
  async function buildSharedContext({ patientId, providerId, heightCm = null, weightKg = null, prescriptionId = null, versionNumber = null, referenceTime = null, route = DEFAULT_ROUTE, knownPatientVelocity = null }) {
    const patient = await featureRepository.getPatient(patientId);
    if (!patient) {
      throw new ScoringPayloadError('PATIENT_NOT_FOUND', `Patient ${patientId} does not exist`);
    }
    const reference = referenceTime === null ? now() : new Date(referenceTime);

    const [activePrescriptionDrugClasses, providerDrugClassHistory, patientVelocity] = await Promise.all([
      featureRepository.getActiveDrugClassesForPatient(patientId, prescriptionId),
      featureRepository.getProviderDrugClassHistory(providerId, prescriptionId),
      // Already computed once for this prescription (live data bridge)? Reuse it instead of a second velocity query.
      knownPatientVelocity !== null ? knownPatientVelocity : featureRepository.countRecentPatientPrescriptions(patientId, reference, prescriptionId, VELOCITY_WINDOW_DAYS),
    ]);

    // Weight precedence: recorded on THIS prescription (Module 14) → patient record → documented placeholder.
    const weightSource = isPresent(weightKg) ? weightKg : patient.weight;
    const weightKnown = isPresent(weightSource);

    return {
      prescriptionId,
      versionNumber,
      patientId,
      providerId,
      referenceTime: reference.toISOString(),
      route: route ?? DEFAULT_ROUTE,
      patientAge: wholeYearsBetween(patient.dob, now()),
      patientWeight: weightKnown ? Number(weightSource) : DEFAULT_PATIENT_WEIGHT_KG,
      patientWeightIsDefault: !weightKnown,
      patientHeight: isPresent(heightCm) ? Number(heightCm) : null,
      activePrescriptionDrugClasses,
      providerDrugClassHistory,
      patientVelocity,
    };
  }

  /**
   * Legacy entry point for a STORED version (Module 9's evaluateTrust calls this with two arguments): scores medicine
   * `sequenceNumber` (default 1) with every other medicine of that version as sibling context.
   * @throws {ScoringPayloadError} VERSION_NOT_FOUND | PATIENT_NOT_FOUND | MEDICINE_NOT_FOUND
   */
  async function buildScoringPayload(prescriptionId, versionNumber, sequenceNumber = 1) {
    const version = await repository.getVersion(prescriptionId, versionNumber);
    if (!version) {
      throw new ScoringPayloadError('VERSION_NOT_FOUND', `${prescriptionId} v${versionNumber} does not exist`);
    }
    const medicine = version.medicines.find((m) => m.sequence_number === sequenceNumber);
    if (!medicine) {
      throw new ScoringPayloadError('MEDICINE_NOT_FOUND', `${prescriptionId} v${versionNumber} has no medicine with sequence_number ${sequenceNumber}`);
    }

    const sharedContext = await buildSharedContext({
      patientId: version.patient_id,
      providerId: version.provider_id,
      heightCm: version.height_cm,
      weightKg: version.weight_kg,
      prescriptionId: version.prescription_id,
      versionNumber: version.version_number,
      referenceTime: version.created_at,
      route: version.route,
    });
    const siblingDrugClasses = version.medicines.filter((m) => m !== medicine).map((m) => m.drug_class);

    return buildScoringPayloadForMedicine(
      {
        drugName: medicine.drug_name,
        drugClass: medicine.drug_class,
        dosageValue: medicine.dosage_value,
        dosageUnit: medicine.dosage_unit,
        frequency: medicine.frequency,
        durationDays: medicine.duration_days,
      },
      sharedContext,
      siblingDrugClasses,
    );
  }

  return Object.freeze({ buildSharedContext, buildScoringPayload });
}

module.exports = {
  createScoringPayloadBuilder,
  buildScoringPayloadForMedicine,
  ScoringPayloadError,
  PAYLOAD_VERSION,
  DEFAULT_PATIENT_WEIGHT_KG,
  wholeYearsBetween, // exported so the patients endpoint DISPLAYS exactly the age the AI is scored with
};
