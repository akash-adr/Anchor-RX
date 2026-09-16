/**
 * The ONLY module that talks to the Anchor Rx API. Components import these functions; they never
 * call fetch() themselves. Each function is a thin wrapper: build the request, return the JSON.
 */

import type {
  AmendChanges,
  AmendResult,
  AuditSummaryFilters,
  AuditSummaryRow,
  AuditTimeline,
  CreatedPrescription,
  DispenseResult,
  DispensingStatus,
  IntegrityRecheck,
  NewPrescription,
  Patient,
  Pharmacy,
  PrescriptionDocument,
  Provenance,
  Provider,
  ProviderPrescriptionSummary,
  RevokeResult,
  RiskPreview,
  ScanResult,
 DrugReference } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

const GATEWAY_STATUSES = new Set([502, 503, 504]);
// A hung request must never leave a spinner running forever during a demo.
const REQUEST_TIMEOUT_MS = 15_000;
const UNREACHABLE_MESSAGE = 'Could not reach the Anchor Rx API. Is it running? (npm run api)';

/** Error carrying the API's specific `reason` code (e.g. NOT_AUTHORIZED_PROVIDER) for display. */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

function readErrorPayload(payload: unknown): { reason?: string; message?: string } {
  if (payload && typeof payload === 'object') {
    const { reason, message } = payload as Record<string, unknown>;
    return {
      reason: typeof reason === 'string' ? reason : undefined,
      message: typeof message === 'string' ? message : undefined,
    };
  }
  return {};
}

/**
 * Every failure mode becomes an ApiError with a specific reason — callers always get something to show:
 * API_UNREACHABLE (network/proxy), TIMEOUT, the API's own reason (4xx/5xx), HTTP_<status>, INVALID_RESPONSE.
 */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  let payload: unknown = null;
  try {
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new ApiError(0, 'TIMEOUT', `The Anchor Rx API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
      }
      throw new ApiError(0, 'API_UNREACHABLE', UNREACHABLE_MESSAGE);
    }
    payload = await response.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const { reason, message } = readErrorPayload(payload);
    if (!reason && GATEWAY_STATUSES.has(response.status)) {
      // No Anchor Rx error body: the Vite dev proxy (or a gateway) answered because the API is down.
      throw new ApiError(response.status, 'API_UNREACHABLE', UNREACHABLE_MESSAGE);
    }
    throw new ApiError(response.status, reason ?? `HTTP_${response.status}`, message);
  }
  if (payload === null || typeof payload !== 'object') {
    // A "successful" response we can't read must not reach the screens as null and crash them.
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'The API returned a response the portal could not read.');
  }
  return payload as T;
}

const rxPath = (prescriptionId: string) => `/api/prescriptions/${encodeURIComponent(prescriptionId)}`;

export function createPrescription(data: NewPrescription): Promise<CreatedPrescription> {
  return request('POST', '/api/prescriptions', data);
}

/** Medicine autofill source: the AI service's DRUG_REFERENCE, relayed unchanged (and cached) by Node. */
export function getDrugReference(): Promise<DrugReference> {
  return request('GET', '/api/drug-reference');
}

/**
 * "Authorize & anchor": score every medicine. Saves NOTHING; returns a single-use token valid for 10 minutes.
 * A medicine the AI service could not score comes back with riskBand 'unavailable' and riskScore null.
 */
export function assessPrescriptionRisk(data: NewPrescription): Promise<RiskPreview> {
  return request('POST', '/api/prescriptions/assess-risk', data);
}

/**
 * "Confirm & Authorize": create the assessed prescription with its risk locked. Sends ONLY the token — the server uses
 * its cached copy of the prescription and risk results (never recomputed, never resent from here).
 * 410 RISK_PREVIEW_EXPIRED if the token is expired, used, or unknown.
 */
export function confirmAndCreatePrescription(previewToken: string): Promise<CreatedPrescription> {
  return request('POST', '/api/prescriptions/confirm-and-create', { previewToken });
}

export function amendPrescription(
  prescriptionId: string,
  changes: AmendChanges,
  requestingProviderId: string,
  reason?: string,
): Promise<AmendResult> {
  return request('POST', `${rxPath(prescriptionId)}/amend`, { requestingProviderId, changes, reason });
}

export function revokePrescription(prescriptionId: string, providerId: string, reason: string): Promise<RevokeResult> {
  return request('POST', `${rxPath(prescriptionId)}/revoke`, { providerId, reason });
}

/** Everything needed to render the printable PDF for one exact version (the QR is the one issued with it). */
export function getPrescriptionDocument(prescriptionId: string, versionNumber: number): Promise<PrescriptionDocument> {
  return request('GET', `${rxPath(prescriptionId)}/versions/${versionNumber}/document`);
}

export function getProvenance(prescriptionId: string): Promise<Provenance> {
  return request('GET', `${rxPath(prescriptionId)}/provenance`);
}

export function getProviders(): Promise<Provider[]> {
  return request('GET', '/api/providers');
}

/** Every prescription this provider originally issued, most recent first ([] when none). */
export function getProviderPrescriptions(providerId: string): Promise<ProviderPrescriptionSummary[]> {
  return request('GET', `/api/providers/${encodeURIComponent(providerId)}/prescriptions`);
}

export function getPatients(): Promise<Patient[]> {
  return request('GET', '/api/patients');
}

export function getPharmacies(): Promise<Pharmacy[]> {
  return request('GET', '/api/pharmacies');
}

/** Any scan the server evaluated (including malformed_qr / unknown_prescription) resolves; only a failed request rejects. */
export function scanPrescription(qrPayloadRaw: string, pharmacyId: string): Promise<ScanResult> {
  return request('POST', '/api/scan', { qrPayloadRaw, pharmacyId });
}

// ── Module 10 — Audit Dashboard. ⚠ Prototype: these endpoints have no access control (backend/api/routes/audit.js). ──

const auditRxPath = (prescriptionId: string) => `/api/audit/prescriptions/${encodeURIComponent(prescriptionId)}`;

/** Summary list. Integrity is rechecked live server-side for every row; scan / decision columns are history. */
export function getAuditSummary(filters: AuditSummaryFilters = {}): Promise<AuditSummaryRow[]> {
  const params = new URLSearchParams();
  if (filters.currentStatus) params.set('currentStatus', filters.currentStatus);
  if (filters.onlyConcerning) params.set('onlyConcerning', 'true');
  const query = params.toString();
  return request('GET', `/api/audit/summary${query ? `?${query}` : ''}`);
}

/** HISTORY: the recorded, merged audit trail for one prescription (oldest first). */
export function getAuditTimeline(prescriptionId: string): Promise<AuditTimeline> {
  return request('GET', `${auditRxPath(prescriptionId)}/timeline`);
}

/** LIVE: recomputes integrity from the data as stored right now. Writes nothing. */
export function recheckIntegrity(prescriptionId: string): Promise<IntegrityRecheck> {
  return request('GET', `${auditRxPath(prescriptionId)}/recheck`);
}

// ── Module 14 — per-medicine dispensing. The server enforces every rule; the table's disabled inputs are convenience only. ──

/** Quantities and fresh per-medicine integrity flags for one exact version. */
export function getDispensingStatus(prescriptionId: string, versionNumber: number): Promise<DispensingStatus> {
  return request('GET', `/api/dispensing/${encodeURIComponent(prescriptionId)}/versions/${versionNumber}`);
}

export function dispenseMedicine(prescriptionVersionId: number, medicineId: number, quantity: number, pharmacyId: string): Promise<DispenseResult> {
  return request('POST', '/api/dispense', { prescriptionVersionId, medicineId, quantity, pharmacyId });
}
