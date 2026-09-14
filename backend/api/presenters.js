'use strict';

/**
 * Request/response shaping only: camelCase at the HTTP boundary, snake_case (the schema's names) inside.
 * dosageValue is passed through untouched — it stays the exact DECIMAL string (e.g. "500.000").
 */

const { ApiError } = require('./errors');

const COLUMN_TO_API = Object.freeze({
  patient_id: 'patientId',
  provider_id: 'providerId',
  drug_name: 'drugName',
  dosage_value: 'dosageValue',
  dosage_unit: 'dosageUnit',
  frequency: 'frequency',
  duration_days: 'durationDays',
  drug_class: 'drugClass',
});

const CREATE_BODY_TO_COLUMN = Object.freeze(
  Object.fromEntries(Object.entries(COLUMN_TO_API).map(([column, apiKey]) => [apiKey, column])),
);

const camelToSnake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** POST /prescriptions body → createPrescription input. Unknown keys are rejected, not ignored. */
function toCreateInput(body) {
  if (!isPlainObject(body)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !(key in CREATE_BODY_TO_COLUMN));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'FIELD_NOT_ALLOWED',
      `Unknown field(s): ${unknown.join(', ')} (allowed: ${Object.keys(CREATE_BODY_TO_COLUMN).join(', ')})`,
    );
  }
  const input = {};
  for (const [apiKey, column] of Object.entries(CREATE_BODY_TO_COLUMN)) {
    if (body[apiKey] !== undefined) input[column] = body[apiKey];
  }
  return input;
}

/**
 * Amendment `changes` → column names. EVERY key is converted and passed through (not just the four
 * amendable ones), so Module 3 sees e.g. patient_id, returns its specific rejection, and logs the attempt.
 */
function toAmendChanges(changes) {
  if (!isPlainObject(changes)) return changes; // Module 3 rejects and logs non-object input
  return Object.fromEntries(Object.entries(changes).map(([key, value]) => [camelToSnake(key), value]));
}

/** prescription_version row → API shape. salt and field_hashes are deliberately not exposed. */
function presentVersion(row) {
  return {
    id: row.id,
    prescriptionId: row.prescription_id,
    versionNumber: row.version_number,
    parentVersionId: row.parent_version_id,
    patientId: row.patient_id,
    providerId: row.provider_id,
    drugName: row.drug_name,
    dosageValue: row.dosage_value,
    dosageUnit: row.dosage_unit,
    frequency: row.frequency,
    durationDays: row.duration_days,
    drugClass: row.drug_class,
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
    changedFields: diff.changedFields.map((entry) => ({ ...entry, field: COLUMN_TO_API[entry.field] || entry.field })),
  };
}

module.exports = { toCreateInput, toAmendChanges, presentVersion, presentDiff };
