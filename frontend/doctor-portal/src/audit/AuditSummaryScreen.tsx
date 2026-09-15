import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, CircleCheck, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { getAuditSummary, type ApiError } from '../api';
import ErrorNotice, { toApiError } from '../components/ErrorNotice';
import { inputClass } from '../components/formControls';
import type { AuditStatusFilter, AuditSummaryRow } from '../types';
import { Chip, DECISION_STYLE, SCAN_RESULT_STYLE, STATUS_STYLE, formatEpoch, utcIso } from './auditUi';

/**
 * The auditor's starting screen: every prescription, with the ones that FAIL a live integrity recheck flagged red.
 * The "Live integrity" column is recomputed server-side for every row on each load; the scan and trust-decision
 * columns are historical records (the last thing logged). Column headers say which is which.
 */

type Load = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; rows: AuditSummaryRow[] };

const STATUS_OPTIONS: Array<{ value: '' | AuditStatusFilter; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'dispensed', label: 'Dispensed' },
  { value: 'revoked', label: 'Revoked' },
];

const auditPath = (prescriptionId: string) => `/audit/prescriptions/${encodeURIComponent(prescriptionId)}`;

export default function AuditSummaryScreen() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'' | AuditStatusFilter>('');
  const [onlyConcerning, setOnlyConcerning] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [lookup, setLookup] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    getAuditSummary({ currentStatus: statusFilter || undefined, onlyConcerning })
      .then((rows) => {
        if (!cancelled) setLoad({ status: 'ready', rows });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', error: toApiError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, onlyConcerning, refreshToken]);

  const onOpen = (event: FormEvent) => {
    event.preventDefault();
    const id = lookup.trim();
    if (id) navigate(auditPath(id));
  };

  const rows = load.status === 'ready' ? load.rows : [];
  const concerning = rows.filter((row) => !row.latestIntegrityIntact).length;

  return (
    <section aria-labelledby="audit-summary-title" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Audit dashboard</p>
          <h1 id="audit-summary-title" className="mt-1 text-2xl font-semibold tracking-tight">
            Prescription audit overview
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            <strong className="font-semibold text-slate-800">Live integrity</strong> is rechecked for every row each time this list loads.
            Scan and trust-decision columns are <strong className="font-semibold text-slate-800">history</strong> — the last thing that was logged.
          </p>
        </div>
        <form onSubmit={onOpen} className="flex items-center gap-2">
          <label htmlFor="audit-lookup" className="sr-only">
            Prescription ID
          </label>
          <input
            id="audit-lookup"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            placeholder="Open prescription ID…"
            className={`${inputClass(false, 'w-56')} font-mono`}
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-teal-600"
          >
            <Search aria-hidden className="h-4 w-4" />
            Open
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-600">Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as '' | AuditStatusFilter)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-teal-600"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={onlyConcerning} onChange={(event) => setOnlyConcerning(event.target.checked)} className="h-4 w-4 accent-red-600" />
          <span className="text-slate-700">Only prescriptions that fail integrity now</span>
        </label>
        <button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          disabled={load.status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-teal-600"
        >
          <RefreshCw aria-hidden className={`h-4 w-4 ${load.status === 'loading' ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {load.status === 'error' && <ErrorNotice title="Couldn't load the audit summary" error={load.error} />}

      {load.status === 'ready' &&
        (concerning > 0 ? (
          <div role="alert" data-testid="attention-banner" className="flex items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-950 ring-2 ring-red-100">
            <ShieldAlert aria-hidden className="h-6 w-6 shrink-0 text-red-600" />
            <p className="text-sm">
              <strong className="font-semibold">
                {concerning} of {rows.length} prescription{rows.length === 1 ? '' : 's'}
              </strong>{' '}
              failed the live integrity recheck. Start with the rows marked in red.
            </p>
          </div>
        ) : (
          <div role="status" className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-950">
            <CircleCheck aria-hidden className="h-5 w-5 shrink-0 text-emerald-600" />
            <p className="text-sm">
              {rows.length === 0 ? 'No prescriptions match these filters.' : `All ${rows.length} listed prescriptions passed the live integrity recheck.`}
            </p>
          </div>
        ))}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">
                Live integrity
              </th>
              <th scope="col" className="px-4 py-3">
                Prescription
              </th>
              <th scope="col" className="px-4 py-3">
                Status
              </th>
              <th scope="col" className="px-4 py-3">
                Last scan <span className="font-normal normal-case text-slate-400">(history)</span>
              </th>
              <th scope="col" className="px-4 py-3">
                Last trust decision <span className="font-normal normal-case text-slate-400">(history)</span>
              </th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {load.status === 'loading' && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500" role="status">
                  Rechecking integrity for every prescription…
                </td>
              </tr>
            )}
            {load.status === 'ready' && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No prescriptions match these filters.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <SummaryRow key={row.prescriptionId} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SummaryRow({ row }: { row: AuditSummaryRow }) {
  const concerning = !row.latestIntegrityIntact;
  const { lastScan, lastTrustDecision } = row;

  return (
    <tr data-testid={`audit-row-${row.prescriptionId}`} data-concerning={concerning} className={concerning ? 'bg-red-50/80' : 'hover:bg-slate-50'}>
      <td className={`border-l-4 px-4 py-3 align-top ${concerning ? 'border-red-600' : 'border-transparent'}`}>
        {concerning ? (
          <span className="inline-flex items-center gap-2 font-semibold text-red-700">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-red-600 ring-4 ring-red-200" />
            Not intact
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <CircleCheck aria-hidden className="h-4 w-4" />
            Intact
          </span>
        )}
        <p className="mt-0.5 text-[11px] text-slate-500" title={`UTC ${utcIso(row.integrityCheckedAt)}`}>
          checked {formatEpoch(row.integrityCheckedAt)}
        </p>
      </td>
      <td className="px-4 py-3 align-top">
        <Link to={auditPath(row.prescriptionId)} className="font-mono font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-teal-600">
          {row.prescriptionId}
        </Link>
      </td>
      <td className="px-4 py-3 align-top">
        <Chip className={STATUS_STYLE[row.currentStatus]}>{row.currentStatus}</Chip>
      </td>
      <td className="px-4 py-3 align-top">
        {lastScan ? (
          <>
            <Chip className={SCAN_RESULT_STYLE[lastScan.result].chip}>{SCAN_RESULT_STYLE[lastScan.result].label}</Chip>
            <span className="ml-1.5 text-xs text-slate-500">v{lastScan.versionNumber}</span>
            <p className="mt-0.5 text-[11px] text-slate-500" title={`UTC ${utcIso(lastScan.timestamp)}`}>
              {formatEpoch(lastScan.timestamp)}
            </p>
          </>
        ) : (
          <span className="text-xs text-slate-400">No scans logged</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {lastTrustDecision ? (
          <>
            <Chip className={DECISION_STYLE[lastTrustDecision.trustDecision].chip}>{lastTrustDecision.trustDecision}</Chip>
            <code className="ml-1.5 font-mono text-xs text-slate-600">{lastTrustDecision.primaryReason}</code>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {lastTrustDecision.riskScore !== null ? `risk ${lastTrustDecision.riskScore} · ${lastTrustDecision.riskBand}` : 'no risk score'} ·{' '}
              <span title={`UTC ${utcIso(lastTrustDecision.decidedAt)}`}>{formatEpoch(lastTrustDecision.decidedAt)}</span>
            </p>
          </>
        ) : (
          <span className="text-xs text-slate-400">{lastScan ? 'No decision logged for its scans' : '—'}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right align-top">
        <Link
          to={auditPath(row.prescriptionId)}
          aria-label={`Open audit trail for ${row.prescriptionId}`}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-600"
        >
          Open
          <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </td>
    </tr>
  );
}
