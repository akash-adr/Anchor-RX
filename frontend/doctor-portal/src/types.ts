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
}

export interface Patient {
  patientId: string;
  name: string;
}

export interface NewPrescription {
  patientId: string;
  providerId: string;
  drugName: string;
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  drugClass: string;
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
  qrPayload: QrPayload | null; // null only if QR generation failed after the version was committed
  qrImage: string | null; // PNG data URL
}

// Values are sent as entered (strings); the API validates them. durationDays may be a numeric string.
export interface AmendChanges {
  dosageValue?: string;
  dosageUnit?: string;
  frequency?: string;
  durationDays?: number | string;
}

export interface ChangedField {
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
  drugName: string;
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  drugClass: string;
  status: VersionStatus;
  createdAt: string;
  amendedAt: string | null;
  amendedByProviderId: string | null;
  reason: string | null;
  integrityRoot: string;
  ledgerAnchorRef: string;
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

export interface AuditVersionSnapshot {
  status: VersionStatus;
  providerId: string;
  drugName: string;
  drugClass: string;
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  route: string;
  integrityRoot: string;
  ledgerAnchorRef: string | null;
}

export interface AuditFieldChange {
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

export type AuditEvent = VersionCreatedEvent | VersionAmendedEvent | VersionRevokedEvent | LedgerAnchoredEvent | PharmacyScanEvent;

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
  drugName: string;
  dosageValue: string; // exact stored string, e.g. "500.000"
  dosageUnit: string;
  frequency: string;
  durationDays: number;
  drugClass: string;
  route: string;
  integrityRoot: string;
  ledgerAnchorRef: string | null;
  issuedAt: string; // ISO UTC — identical to the issuedAt inside the QR
  qrImage: string; // PNG data URL, regenerated server-side from the stored created_at
}
