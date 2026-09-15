import { useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { recheckIntegrity, type ApiError } from '../api';
import ErrorNotice, { toApiError } from '../components/ErrorNotice';
import type { IntegrityRecheck } from '../types';
import { formatEpoch, isIntactNow, utcIso } from './auditUi';

/**
 * LIVE — "what's true right now". Structurally and visually SEPARATE from the History timeline below it:
 * its own component, its own request (GET /api/audit/prescriptions/:id/recheck, only when "Recheck now" is pressed),
 * its own state. It never reads, merges or annotates timeline data, and a recheck is not saved anywhere — so a live
 * result can never be mistaken for, or mixed into, the immutable history.
 */

type State = { status: 'idle' } | { status: 'checking' } | { status: 'done'; result: IntegrityRecheck } | { status: 'error'; error: ApiError };

export default function CurrentIntegrityCard({ prescriptionId }: { prescriptionId: string }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const checking = state.status === 'checking';

  const recheck = async () => {
    setState({ status: 'checking' });
    try {
      setState({ status: 'done', result: await recheckIntegrity(prescriptionId) });
    } catch (err) {
      setState({ status: 'error', error: toApiError(err) });
    }
  };

  return (
    <section data-testid="current-integrity" aria-labelledby="current-integrity-title" className="overflow-hidden rounded-2xl border-2 border-slate-900 bg-white shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 px-5 py-3 text-white">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-teal-300">
            <span aria-hidden className="h-2 w-2 rounded-full bg-teal-400" />
            Live · what's true right now
          </p>
          <h2 id="current-integrity-title" className="text-lg font-semibold tracking-tight">
            Current Integrity Status
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-teal-300 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
        >
          <RefreshCw aria-hidden className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'Rechecking…' : 'Recheck now'}
        </button>
      </div>

      <div className="space-y-4 p-5">
        <p className="text-sm text-slate-600">
          Recomputed on demand from this prescription's data <em>as it is stored at this moment</em> — field hashes and ledger anchor. It is not part of the
          History below, and nothing is saved when you run it.
        </p>

        {state.status === 'idle' && (
          <p data-testid="recheck-idle" className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Not checked yet in this view. Press <strong className="font-semibold text-slate-800">Recheck now</strong> to verify the current data.
          </p>
        )}
        {checking && (
          <p role="status" className="text-sm text-slate-600">
            Recomputing field hashes and verifying the ledger anchor…
          </p>
        )}
        {state.status === 'error' && <ErrorNotice title="The live recheck could not be completed" error={state.error} />}
        {state.status === 'done' && <RecheckResult result={state.result} />}
      </div>
    </section>
  );
}

function RecheckResult({ result }: { result: IntegrityRecheck }) {
  const intact = isIntactNow(result);
  const { fieldVerification: fields, ledgerVerification: ledger, version } = result;

  return (
    <div data-testid="recheck-result" data-intact={intact} className="space-y-4">
      {intact ? (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-emerald-950">
          <ShieldCheck aria-hidden className="h-7 w-7 shrink-0 text-emerald-600" />
          <div>
            <p className="font-semibold">Intact right now</p>
            <p className="text-sm text-emerald-900">The stored fields match their hashes and the ledger anchor verifies.</p>
          </div>
        </div>
      ) : (
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-red-400 bg-red-50 px-4 py-3 text-red-950 ring-2 ring-red-200">
          <ShieldAlert aria-hidden className="h-7 w-7 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold">Integrity check failed right now</p>
            <p className="text-sm text-red-900">
              {fields.tamperedFields.length > 0
                ? `The stored value of ${fields.tamperedFields.join(', ')} no longer matches its hash.`
                : 'The current data does not verify — see the failing checks below.'}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <CheckPanel
          title="Field hashes"
          source="Module 2"
          checks={[
            ['Every field matches its stored hash', fields.valid],
            ['Integrity root matches the fields', fields.integrityRootMatch],
          ]}
        >
          {fields.tamperedFields.length > 0 && (
            <p className="text-sm text-red-800">
              Altered:{' '}
              {fields.tamperedFields.map((field) => (
                <code key={field} className="mr-1 rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
                  {field}
                </code>
              ))}
            </p>
          )}
          {fields.unverifiable && <p className="text-sm text-red-800">Stored hashes could not be recomputed{fields.error ? `: ${fields.error}` : ''}.</p>}
        </CheckPanel>
        <CheckPanel
          title="Ledger anchor"
          source="Module 4"
          checks={[
            ['Anchored on the ledger', ledger.anchored],
            ['Anchored root matches the live data', ledger.integrityRootMatch],
            ['Ledger hash chain intact', ledger.chainIntact],
          ]}
        >
          {ledger.anchoredAt !== null && (
            <p className="text-xs text-slate-500" title={`UTC ${utcIso(ledger.anchoredAt)}`}>
              Anchored {formatEpoch(ledger.anchoredAt)}
            </p>
          )}
        </CheckPanel>
      </div>

      <p className="text-xs text-slate-500">
        Checked version {version.versionNumber} ({version.basis === 'latest_version_revoked' ? 'latest version — this prescription is revoked' : 'current active version'}) at{' '}
        <time dateTime={utcIso(result.checkedAt)} title={`UTC ${utcIso(result.checkedAt)}`} className="font-mono">
          {formatEpoch(result.checkedAt)}
        </time>
        .
      </p>
    </div>
  );
}

function CheckPanel({ title, source, checks, children }: { title: string; source: string; checks: Array<[string, boolean]>; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-900">
        {title} <span className="font-normal text-slate-400">· {source}</span>
      </p>
      <ul className="mt-2 space-y-1.5">
        {checks.map(([label, passed]) => (
          <li key={label} className={`flex items-center gap-2 text-sm ${passed ? 'text-slate-700' : 'font-medium text-red-800'}`}>
            {passed ? <CircleCheck aria-label="passed" className="h-4 w-4 shrink-0 text-emerald-600" /> : <CircleX aria-label="failed" className="h-4 w-4 shrink-0 text-red-600" />}
            {label}
          </li>
        ))}
      </ul>
      {children && <div className="mt-2 space-y-1">{children}</div>}
    </div>
  );
}
