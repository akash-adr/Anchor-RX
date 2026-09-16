// Shapes returned by the Anchor Rx API (backend/api). dosageValue is ALWAYS a string ("500.000"):
// it is never parsed to a number anywhere in the frontend, so no float drift can reach hashing.

export interface Provider {
  providerId: string;
  name: string;
}

export interface Pharmacy {
  pharmacyId: string;
  name: string;
}

/** Module 6 scan outcomes, as returned by POST /api/scan. There is NO dispense decision here (Module 9). */
export type ScanResultCode =
  | 'verified'
  | 'tampered'
  | 'forged'
  | 'revoked'
  | 'stale_version'
  | 'provider_identity_issue'
  | 'unknown_prescription'
  | 'malformed_qr';

export interface ScanResult {
  scanResult: ScanResultCode;
  prescriptionId: string | null;
  versionNumber: number | null;
  fieldVerification: {
    valid: boolean;
    tamperedFields: string[];
    integrityRootMatch: boolean;
    unverifiable?: boolean;
    error?: string;
  } | null;
  ledgerVerification: {
    anchored: boolean;
    integrityRootMatch: boolean;
    chainIntact: boolean;
    anchoredAt: string | null;
  } | null;
  providerStatus: string | null;
  currentActiveVersion: number | null;
  scannedAt: string;
  /**
   * Module 15, display only: the highest LOCKED risk score among the scanned version's medicines (null percentage when
   * none is locked). null when the scan resolved no version. Never used to gate dispensing.
   */
  pharmacistRiskDisplay?: { percentage: number | null } | null;
}

export interface Patient {
  patientId: string;
  name: string;
}

/** One medicine of a new prescription. Its position in `medicines` becomes its sequence_number (1-based). */
export interface NewMedicine {
  drugName: string;
  drugClass: string;
  dosageValue: string; // exact typed string, never parsed
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  quantityPrescribed: number;
}

/** POST /api/prescriptions body (Module 14). heightCm / weightKg are optional and sent as exact strings. */
export interface NewPrescription {
  patientId: string;
  providerId: string;
  heightCm?: string;
  weightKg?: string;
  medicines: NewMedicine[];
}

/** One DRUG_REFERENCE row, exactly as the AI service defines it (ai-service/data/dosage_reference.py). */
export interface DrugReferenceEntry {
  dose_min: number;
  dose_max: number;
  dosage_unit: string;
  dose_per_kg_max: number;
  freq_min: number;
  freq_max: number;
  dur_min: number;
  dur_max: number;
  drug_class: string;
}

/** GET /api/drug-reference — keyed by drug name. */
export type DrugReference = Record<string, DrugReferenceEntry>;

/** 'unavailable' = the AI service could not score this medicine; the prescriber still confirms it explicitly. */
export type RiskBand = 'low' | 'review' | 'high' | 'unavailable';

/** One ranked reason from the AI risk engine (Module 8), or the system's "unavailable" notice. */
export interface RiskReason {
  source: 'rule_engine' | 'ml_model' | 'system';
  feature: string;
  explanation: string;
}

/** Risk locked at confirmation — stored once, never recalculated. riskScore is null for an 'unavailable' lock. */
export interface LockedRisk {
  riskScore: number | null;
  riskBand: RiskBand;
  reasons: RiskReason[];
}

/** POST /api/prescriptions/assess-risk — scores every medicine, saves nothing. medicines are in submission order. */
export interface RiskPreview {
  previewToken: string;
  medicines: Array<{ medicineIndex: number; drugName: string; riskScore: number | null; riskBand: RiskBand; reasons: RiskReason[] }>;
}

/** A stored medicine of one prescription version. medicineId belongs to that version only (copied forward as new rows). */
export interface Medicine {
  medicineId: number;
  sequenceNumber: number;
  drugName: string;
  drugClass: string;
  dosageValue: string; // exact DECIMAL string, e.g. "500.000"
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  quantityPrescribed: number;
  lockedRisk?: LockedRisk | null; // Module 15: null when the prescription was not created through preview → confirm
}

/** Exactly what the QR code encodes: a pointer for server-side lookup, never clinical data. */
export interface QrPayload {
  prescriptionId: string;
  versionNumber: number;
  issuedAt: string;
}

export interface CreatedPrescription {
  prescriptionId: string;
  versionNumber: number;
  integrityRoot: string;
  ledgerAnchorRef: string;
  medicines: Medicine[]; // in sequence order
  qrPayload: QrPayload | null; // null only if QR generation failed after the version was committed
  qrImage: string | null; // PNG data URL
}

// ONE medicine per amendment (by its medicineId in the current version). Values are sent as entered; the API validates.
export interface AmendChanges {
  medicineId: number;
  dosageValue?: string;
  dosageUnit?: string;
  frequency?: string;
  durationDays?: number | string;
  quantityPrescribed?: number | string;
}

export interface ChangedField {
  medicine?: number; // sequence number of the amended medicine
  drugName?: string;
  field: string;
  old: string | number;
  new: string | number;
  unit?: string;
  oldUnit?: string;
}

interface DiffBase {
  prescriptionId: string;
  fromVersion: number;
  toVersion: number;
  changedFields: ChangedField[];
}

export interface AmendmentDiff extends DiffBase {
  amendedBy: string | null;
  amendedAt: string;
}

export interface RevocationDiff extends DiffBase {
  revoked: true;
  revokedBy: string | null;
  revokedReason: string | null;
  revokedAt: string;
}

export type VersionDiff = AmendmentDiff | RevocationDiff;

export function isRevocationDiff(diff: VersionDiff): diff is RevocationDiff {
  return 'revoked' in diff && diff.revoked === true;
}

export interface AmendResult {
  versionNumber: number;
  diff: VersionDiff;
  medicines: Medicine[];
  qrPayload: QrPayload | null;
  qrImage: string | null;
}

export interface RevokeResult {
  versionNumber: number;
  status: 'revoked';
}

export type VersionStatus = 'active' | 'amended' | 'dispensed' | 'revoked';

export interface PrescriptionVersion {
  id: number;
  prescriptionId: string;
  versionNumber: number;
  parentVersionId: number | null;
  patientId: string;
  providerId: string;
  heightCm: string | null; // exact DECIMAL string, or null when not recorded
  weightKg: string | null;
  medicines: Medicine[]; // in sequence order
  status: VersionStatus;
  createdAt: string;
  amendedAt: string | null;
  amendedByProviderId: string | null;
  reason: string | null;
  integrityRoot: string;
  ledgerAnchorRef: string;
}

/** GET /api/providers/:providerId/prescriptions — one row per prescription this provider ORIGINALLY issued. */
export interface ProviderPrescriptionSummary {
  prescriptionId: string;
  currentStatus: VersionStatus;
  latestVersionNumber: number;
  drugSummary: string; // first medicine of the latest version, plus "+N more"
  medicineCount: number;
  patientId: string;
  patientName: string | null;
  lastAnchoredAt: string; // ISO UTC — the latest version's created_at (written and anchored together)
}

export interface Provenance {
  prescriptionId: string;
  versions: PrescriptionVersion[];
  diffs: VersionDiff[];
}

// ── Module 10 — Audit Dashboard (GET /api/audit/…). Every timestamp is epoch milliseconds (UTC). ──────────────

export type AuditScanResult =
  | 'verified'
  | 'stale_version'
  | 'tampered'
  | 'forged'
  | 'revoked'
  | 'provider_identity_issue'
  | 'unknown_prescription'
  | 'malformed_qr';

export type AuditTrustDecisionValue = 'Dispense' | 'Review' | 'Block';
export type AuditRiskBand = 'low' | 'review' | 'high';

export interface AuditTrustDecision {
  decisionId: number;
  trustDecision: AuditTrustDecisionValue;
  primaryReason: string;
  riskScore: number | null;
  riskBand: AuditRiskBand | null;
  evaluatedVersionNumber: number | null;
  pharmacyId: string;
  decidedAt: number;
}

export interface AuditMedicineSnapshot {
  sequenceNumber: number;
  drugName: string;
  drugClass: string;
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  quantityPrescribed: number;
}

export interface AuditVersionSnapshot {
  status: VersionStatus;
  providerId: string;
  heightCm: string | null;
  weightKg: string | null;
  medicines: AuditMedicineSnapshot[];
  route: string;
  integrityRoot: string;
  ledgerAnchorRef: string | null;
}

export interface AuditFieldChange {
  medicine?: number;
  drugName?: string;
  field: string;
  old: string | number | null;
  new: string | number | null;
  unit?: string;
}

interface AuditEventBase {
  versionNumber: number;
  timestamp: number;
}

export interface VersionCreatedEvent extends AuditEventBase {
  eventType: 'version_created';
  detail: AuditVersionSnapshot;
}

export interface VersionAmendedEvent extends AuditEventBase {
  eventType: 'version_amended';
  detail: AuditVersionSnapshot & { fromVersion: number; changedFields: AuditFieldChange[]; amendedBy: string | null; reason: string | null };
}

export interface VersionRevokedEvent extends AuditEventBase {
  eventType: 'version_revoked';
  detail: { fromVersion: number; revoked: true; revokedBy: string | null; revokedReason: string | null };
}

export interface LedgerAnchoredEvent extends AuditEventBase {
  eventType: 'ledger_anchored';
  detail: { ledgerEntryId: string; entryHash: string; previousEntryHash: string | null; integrityRoot: string; anchorType: string; chainPosition: number };
}

export interface PharmacyScanEvent extends AuditEventBase {
  eventType: 'pharmacy_scan';
  detail: { eventId: number; pharmacyId: string; scanResult: AuditScanResult };
  trustDecision?: AuditTrustDecision;
}

/** Module 14: one dispensing_record row. drugName is as stored on the medicine row. */
export interface MedicineDispensedEvent extends AuditEventBase {
  eventType: 'medicine_dispensed';
  detail: { dispensingId: number; medicineId: number; sequenceNumber: number; drugName: string; quantityDispensed: number; pharmacyId: string };
}

export type AuditEvent = VersionCreatedEvent | VersionAmendedEvent | VersionRevokedEvent | LedgerAnchoredEvent | PharmacyScanEvent | MedicineDispensedEvent;

export interface AuditTimeline {
  prescriptionId: string;
  currentStatus: VersionStatus;
  timeline: AuditEvent[];
  unlinkedTrustDecisions: Array<AuditTrustDecision & { verificationEventId: number | null }>;
}

export interface IntegrityRecheck {
  fieldVerification: { valid: boolean; tamperedFields: string[]; integrityRootMatch: boolean; unverifiable?: boolean; error?: string };
  ledgerVerification: { anchored: boolean; integrityRootMatch: boolean; chainIntact: boolean; anchoredAt: number | null };
  checkedAt: number;
  version: { prescriptionId: string; versionNumber: number; status: VersionStatus; basis: 'active_version' | 'latest_version_revoked' };
}

export type AuditStatusFilter = 'active' | 'dispensed' | 'revoked';

export interface AuditSummaryFilters {
  currentStatus?: AuditStatusFilter;
  onlyConcerning?: boolean;
}

export interface AuditSummaryRow {
  prescriptionId: string;
  currentStatus: VersionStatus;
  lastScan: { eventId: number; result: AuditScanResult; versionNumber: number; timestamp: number } | null;
  lastTrustDecision: {
    decisionId: number;
    trustDecision: AuditTrustDecisionValue;
    primaryReason: string;
    riskScore: number | null;
    riskBand: AuditRiskBand | null;
    versionNumber: number | null;
    verificationEventId: number | null;
    decidedAt: number;
  } | null;
  latestIntegrityIntact: boolean;
  integrityCheckedAt: number;
}

/** GET /api/prescriptions/:id/versions/:n/document — data for the printable PDF (rendered client-side). */
export interface PrescriptionDocument {
  prescriptionId: string;
  versionNumber: number;
  status: VersionStatus;
  patient: { name: string; patientId: string; dob: string }; // dob "YYYY-MM-DD"
  provider: { name: string; licenseNumber: string };
  heightCm: string | null;
  weightKg: string | null;
  medicines: AuditMedicineSnapshot[]; // same shape: every medicine of this version, in sequence order
  route: string;
  integrityRoot: string;
  ledgerAnchorRef: string | null;
  issuedAt: string; // ISO UTC — identical to the issuedAt inside the QR
  qrImage: string; // PNG data URL, regenerated server-side from the stored created_at
}

// ── Module 14 — per-medicine dispensing (GET /api/dispensing/…, POST /api/dispense) ───────────────────────────────

export interface DispensingMedicine {
  medicineId: number;
  sequenceNumber: number;
  drugName: string; // as stored — may itself be a tampered value (see tamperedFields)
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  prescribed: number;
  alreadyGiven: number;
  remaining: number;
  tampered: boolean; // fresh medicine-scoped integrity check; the server re-checks on every dispense
  tamperedFields: string[];
}

export interface DispensingStatus {
  prescriptionId: string;
  versionNumber: number;
  prescriptionVersionId: number;
  status: VersionStatus;
  dispensableVersion: boolean;
  integrityUnverifiable: boolean;
  medicines: DispensingMedicine[];
}

export interface DispenseResult {
  medicineId: number;
  prescribed: number;
  alreadyGiven: number; // includes this dispense
  remaining: number;
}
