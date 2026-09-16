'use strict';

/**
 * Request/response shaping only: camelCase at the HTTP boundary, snake_case (the schema's names) inside.
 * dosageValue is passed through untouched — it stays the exact DECIMAL string (e.g. "500.000").
 *
 * Module 14: a prescription version has a `medicines` array. The repository and Module 3 take camelCase input
 * directly, so create/amend bodies are passed through; only unknown TOP-LEVEL create keys are rejected here, and every
 * value (including each medicine) is validated by the repository / amendment service.
 */

const { ApiError } = require('./errors');

const CREATE_BODY_KEYS = Object.freeze(['patientId', 'providerId', 'heightCm', 'weightKg', 'medicines']);

// Stored medicine column → API field name (also used for field names in amendment diffs).
const MEDICINE_COLUMN_TO_API = Object.freeze({
  drug_name: 'drugName',
  drug_class: 'drugClass',
  dosage_value: 'dosageValue',
  dosage_unit: 'dosageUnit',
  frequency: 'frequency',
  duration_days: 'durationDays',
  quantity_prescribed: 'quantityPrescribed',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** POST /prescriptions body → createPrescription input. Unknown keys are rejected, not ignored. */
function toCreateInput(body) {
  if (!isPlainObject(body)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !CREATE_BODY_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(400, 'FIELD_NOT_ALLOWED', `Unknown field(s): ${unknown.join(', ')} (allowed: ${CREATE_BODY_KEYS.join(', ')})`);
  }
  const input = {};
  for (const key of CREATE_BODY_KEYS) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  return input;
}

/**
 * Amendment `changes` ({ medicineId, ...fields }) are passed through UNCHANGED — every key, not just the amendable
 * ones — so Module 3 sees e.g. patientId or addMedicine, returns its specific rejection, and logs the attempt.
 */
function toAmendChanges(changes) {
  return changes;
}

/** prescription_medicine row → API shape. */
function presentMedicine(row) {
  return {
    medicineId: row.medicine_id,
    sequenceNumber: row.sequence_number,
    drugName: row.drug_name,
    drugClass: row.drug_class,
    dosageValue: row.dosage_value,
    dosageUnit: row.dosage_unit,
    frequency: row.frequency,
    durationDays: row.duration_days,
    quantityPrescribed: row.quantity_prescribed,
    // Module 15: the AI risk shown to the prescriber at confirmation — stored once, never recalculated. null if not locked.
    lockedRisk:
      row.locked_risk_band === null || row.locked_risk_band === undefined
        ? null
        : {
            riskScore: row.locked_risk_score === null ? null : Number(row.locked_risk_score), // null for an 'unavailable' lock
            riskBand: row.locked_risk_band,
            reasons: row.locked_risk_reasons,
          },
  };
}

/** prescription_version row (with its medicines) → API shape. salt and field_hashes are deliberately not exposed. */
function presentVersion(row) {
  return {
    id: row.id,
    prescriptionId: row.prescription_id,
    versionNumber: row.version_number,
    parentVersionId: row.parent_version_id,
    patientId: row.patient_id,
    providerId: row.provider_id,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    medicines: (row.medicines || []).map(presentMedicine),
    status: row.status,
    createdAt: row.created_at,
    amendedAt: row.amended_at,
    amendedByProviderId: row.amended_by_provider_id,
    reason: row.reason,
    integrityRoot: row.integrity_root,
    ledgerAnchorRef: row.ledger_anchor_ref,
  };
}

/** diffVersions result → API shape (changed field names in camelCase). Display data, not verification. */
function presentDiff(diff) {
  return {
    ...diff,
    changedFields: diff.changedFields.map((entry) => ({ ...entry, field: MEDICINE_COLUMN_TO_API[entry.field] || entry.field })),
  };
}

module.exports = { toCreateInput, toAmendChanges, presentMedicine, presentVersion, presentDiff };
