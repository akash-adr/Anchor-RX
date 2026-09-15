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
