import type { ReactNode } from 'react';
import type { AuditScanResult, AuditTrustDecisionValue, IntegrityRecheck, VersionStatus } from '../types';

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
} as Intl.DateTimeFormatOptions);

/** Audit events can be milliseconds apart, so times always show milliseconds; the exact UTC value goes in the tooltip. */
export const formatEpoch = (epochMs: number) => timestampFormat.format(new Date(epochMs));
export const utcIso = (epochMs: number) => new Date(epochMs).toISOString();
export const shortHash = (value: string) => (value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value);

/**
 * Same four conditions as the backend's isIntegrityIntact (backend/audit/recheck.js): field hashes valid AND anchored
 * AND anchored root matches AND ledger chain intact. Display only — the individual checks are always shown as well.
 */
export function isIntactNow({ fieldVerification, ledgerVerification }: IntegrityRecheck): boolean {
  return fieldVerification.valid && ledgerVerification.anchored && ledgerVerification.integrityRootMatch && ledgerVerification.chainIntact;
}

/**
 * Scan-result chips mirror the severity calibration in pharmacy/results/ScanResultCards.tsx:
 * verified green · stale_version blue (routine) · tampered/forged/revoked red · provider issue orange · unknown/malformed grey.
 * Keep the two in sync; never make stale_version look alarming.
 */
export const SCAN_RESULT_STYLE: Record<AuditScanResult, { label: string; chip: string }> = {
  verified: { label: 'Verified', chip: 'bg-emerald-100 text-emerald-900 ring-emerald-300' },
  stale_version: { label: 'Stale version', chip: 'bg-sky-100 text-sky-900 ring-sky-200' },
  tampered: { label: 'Tampered', chip: 'bg-red-600 text-white ring-red-700' },
  forged: { label: 'Forged', chip: 'bg-red-600 text-white ring-red-700' },
  revoked: { label: 'Revoked', chip: 'bg-red-100 text-red-900 ring-red-300' },
  provider_identity_issue: { label: 'Provider identity issue', chip: 'bg-orange-100 text-orange-900 ring-orange-300' },
  unknown_prescription: { label: 'Unknown prescription', chip: 'bg-slate-200 text-slate-800 ring-slate-300' },
  malformed_qr: { label: 'Malformed QR', chip: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

export const DECISION_STYLE: Record<AuditTrustDecisionValue, { chip: string; frame: string }> = {
  Dispense: { chip: 'bg-emerald-600 text-white ring-emerald-700', frame: 'border-emerald-200 bg-emerald-50' },
  Review: { chip: 'bg-amber-400 text-amber-950 ring-amber-500', frame: 'border-amber-200 bg-amber-50' },
  Block: { chip: 'bg-red-600 text-white ring-red-700', frame: 'border-red-200 bg-red-50' },
};

export const STATUS_STYLE: Record<VersionStatus, string> = {
  active: 'bg-teal-50 text-teal-800 ring-teal-200',
  amended: 'bg-slate-100 text-slate-700 ring-slate-200',
  dispensed: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  revoked: 'bg-slate-800 text-white ring-slate-800',
};

export function Chip({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${className}`}>
      {children}
    </span>
  );
}
