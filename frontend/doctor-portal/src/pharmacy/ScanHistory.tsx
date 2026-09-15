import { History } from 'lucide-react';
import type { ScanResultCode } from '../types';
import type { InputSource } from './results/ScanResultCards';

export interface ScanHistoryEntry {
  key: string;
  prescriptionId: string | null;
  outcome: ScanResultCode | 'not_checked';
  detail: string | null; // failure reason for not_checked
  at: string; // ISO timestamp (server scannedAt for results, client time for failed requests)
  source: InputSource;
}

// Small severity dots — same colour families as the result cards (see README "Scan result → visual treatment").
const OUTCOME_STYLE: Record<ScanHistoryEntry['outcome'], { dot: string; label: string }> = {
  verified: { dot: 'bg-emerald-500', label: 'verified' },
  stale_version: { dot: 'bg-sky-500', label: 'stale_version' },
  tampered: { dot: 'bg-red-600', label: 'tampered' },
  forged: { dot: 'bg-red-600', label: 'forged' },
  revoked: { dot: 'bg-red-600', label: 'revoked' },
  provider_identity_issue: { dot: 'bg-orange-500', label: 'provider_identity_issue' },
  unknown_prescription: { dot: 'bg-slate-500', label: 'unknown_prescription' },
  malformed_qr: { dot: 'bg-slate-300', label: 'malformed_qr' },
  not_checked: { dot: 'bg-transparent ring-2 ring-slate-400', label: 'not checked' },
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Session-local list of scans (plain React state, lost on reload). A lightweight preview only —
 * the authoritative audit trail is verification_event on the server (Module 10's dashboard).
 */
export default function ScanHistory({ entries }: { entries: ScanHistoryEntry[] }) {
  return (
    <section aria-labelledby="scan-history-title" data-testid="scan-history" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="scan-history-title" className="flex items-center gap-2 font-semibold">
          <History aria-hidden className="h-5 w-5 text-slate-500" />
          Scan history
        </h2>
        <p className="text-xs text-slate-500">This session only — not the audit log (Module 10)</p>
      </div>

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No scans yet this session.</p>
      ) : (
        <ol className="mt-3 divide-y divide-slate-100">
          {entries.map((entry) => {
            const style = OUTCOME_STYLE[entry.outcome];
            return (
              <li key={entry.key} data-outcome={entry.outcome} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <span className="w-20 shrink-0 font-mono text-xs text-slate-500">{timeFormat.format(new Date(entry.at))}</span>
                <span className="w-36 shrink-0 font-mono text-xs font-medium text-slate-800">{entry.prescriptionId ?? '—'}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
                  <span className={entry.outcome === 'not_checked' ? 'italic text-slate-500' : 'font-mono text-xs text-slate-700'}>
                    {style.label}
                    {entry.detail && <span className="ml-1 not-italic text-slate-400">({entry.detail})</span>}
                  </span>
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {entry.source === 'camera' ? 'camera' : entry.source === 'follow-up' ? 'current-version check' : 'manual'}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
