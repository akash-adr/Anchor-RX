/**
 * Prescription history / provenance timeline (preview of Module 10's audit dashboard).
 * Default view: every prescription the signed-in provider ORIGINALLY issued, most recent first. Opening one (or looking
 * up any ID) shows the existing provenance timeline below. Everything here is DISPLAY data from the API. It does not
 * verify integrity or ledger anchors — that is the pharmacy verification module's job — so nothing here claims "verified".
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, getProvenance, getProviderPrescriptions, getProviders } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import type { PrescriptionVersion, Provenance, ProviderPrescriptionSummary, VersionDiff } from '../types';
import { isRevocationDiff } from '../types';
import ChangeList from './ChangeList';
import ErrorNotice, { toApiError } from './ErrorNotice';
import { inputClass } from './formControls';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const formatTime = (iso: string) => dateFormat.format(new Date(iso));
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

type Lookup =
  | { status: 'idle' }
  | { status: 'loading'; prescriptionId: string }
  | { status: 'error'; prescriptionId: string; error: ApiError }
  | { status: 'ready'; provenance: Provenance };

type IssuedList = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; prescriptions: ProviderPrescriptionSummary[] };

export default function HistoryView({
  initialPrescriptionId,
  onAmend,
}: {
  initialPrescriptionId?: string;
  onAmend?: (prescriptionId: string) => void;
}) {
  const provider = useCurrentProvider();
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const [issued, setIssued] = useState<IssuedList>({ status: 'loading' });
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  const [providerNamesFailed, setProviderNamesFailed] = useState(false);

  useEffect(() => {
    getProviders()
      .then((list) => setProviderNames(Object.fromEntries(list.map((p) => [p.providerId, p.name]))))
      .catch(() => setProviderNamesFailed(true)); // names are cosmetic (IDs are always shown), but say so
  }, []);

  // The default, primary view: loaded automatically for the signed-in provider — no search needed.
  const loadIssued = useCallback(async () => {
    setIssued({ status: 'loading' });
    try {
      setIssued({ status: 'ready', prescriptions: await getProviderPrescriptions(provider.providerId) });
    } catch (err) {
      setIssued({ status: 'error', error: toApiError(err) });
    }
  }, [provider.providerId]);

  useEffect(() => {
    void loadIssued();
  }, [loadIssued]);

  const load = useCallback(async (prescriptionId: string) => {
    setLookup({ status: 'loading', prescriptionId });
    try {
      setLookup({ status: 'ready', provenance: await getProvenance(prescriptionId) });
    } catch (err) {
      setLookup({ status: 'error', prescriptionId, error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    if (initialPrescriptionId) void load(initialPrescriptionId);
  }, [initialPrescriptionId, load]);

  const onLookup = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) void load(query.trim());
  };

  const backToList = () => {
    setLookup({ status: 'idle' });
    void loadIssued(); // statuses may have changed (e.g. amended from the detail view)
  };

  const who = (providerId: string | null) =>
    providerId ? (
      <>
        {providerNames[providerId] && <span className="font-medium text-slate-800">{providerNames[providerId]} </span>}
        <span className="font-mono text-xs text-slate-500">{providerId}</span>
      </>
    ) : (
      <span className="text-slate-500">unknown</span>
    );

  return (
    <section aria-labelledby="history-title" className="space-y-6">
      <div>
        <h1 id="history-title" className="text-2xl font-semibold tracking-tight">
          Prescription history
        </h1>
        <p className="mt-1 text-sm text-slate-600">Every version is immutable: amendments and revocations append to the chain, nothing is overwritten.</p>
        {providerNamesFailed && (
          <p role="status" className="mt-1 text-xs text-amber-700">
            Couldn't load provider names — showing provider IDs only.
          </p>
        )}
      </div>

      {/* Secondary: jump to a known ID, including prescriptions issued by someone else. */}
      <form onSubmit={onLookup} className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <label htmlFor="historyLookup" className="mb-1.5 block text-sm font-medium text-slate-700">
            Or look up a specific prescription by ID
          </label>
          <input
            id="historyLookup"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="e.g. RX-DEMO-0001"
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass(false)} font-mono`}
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || lookup.status === 'loading'}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {lookup.status === 'loading' ? 'Loading…' : 'Show history'}
        </button>
      </form>

      {lookup.status === 'idle' ? (
        <IssuedPrescriptions state={issued} providerName={provider.name} onOpen={(id) => void load(id)} onRetry={() => void loadIssued()} />
      ) : (
        <>
          <button type="button" onClick={backToList} className="text-sm font-medium text-teal-700 hover:underline" data-testid="back-to-issued">
            ← All prescriptions you issued
          </button>
          {lookup.status === 'loading' && <div className="h-32 animate-pulse rounded-2xl bg-slate-100" aria-label={`Loading ${lookup.prescriptionId}`} />}
          {lookup.status === 'error' && <ErrorNotice title={`Couldn't load history for ${lookup.prescriptionId}`} error={lookup.error} />}
          {lookup.status === 'ready' && <Timeline provenance={lookup.provenance} who={who} onAmend={onAmend} />}
        </>
      )}
    </section>
  );
}

function IssuedPrescriptions({
  state,
  providerName,
  onOpen,
  onRetry,
}: {
  state: IssuedList;
  providerName: string;
  onOpen: (prescriptionId: string) => void;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="issued-title" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <h2 id="issued-title" className="font-semibold text-slate-900">
          Prescriptions you issued
        </h2>
        <p className="text-xs text-slate-500">
          Originally prescribed by {providerName} · most recent first
          {state.status === 'ready' && state.prescriptions.length > 0 && ` · ${state.prescriptions.length} total`}
        </p>
      </div>

      {state.status === 'loading' && (
        <div className="space-y-2 p-5" aria-label="Loading your prescriptions">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-slate-100" />
          ))}
        </div>
      )}

      {state.status === 'error' && (
        <div className="space-y-2 p-5">
          <ErrorNotice title="Couldn't load the prescriptions you issued" error={state.error} />
          <button type="button" onClick={onRetry} className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800">
            Retry
          </button>
        </div>
      )}

      {state.status === 'ready' && state.prescriptions.length === 0 && (
        <p className="px-5 py-10 text-center text-sm text-slate-600" data-testid="issued-empty">
          You haven't issued any prescriptions yet.
        </p>
      )}

      {state.status === 'ready' && state.prescriptions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="issued-prescriptions">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="px-5 py-2 font-semibold">Prescription</th>
                <th className="px-3 py-2 font-semibold">Patient</th>
                <th className="px-3 py-2 font-semibold">Medicines</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-5 py-2 font-semibold">Last anchored</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.prescriptions.map((rx) => (
                <tr
                  key={rx.prescriptionId}
                  data-testid={`issued-row-${rx.prescriptionId}`}
                  onClick={() => onOpen(rx.prescriptionId)}
                  className="cursor-pointer hover:bg-teal-50/50"
                >
                  <td className="px-5 py-3">
                    {/* The row is clickable; this button is its keyboard/screen-reader entry point. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(rx.prescriptionId);
                      }}
                      className="whitespace-nowrap font-mono font-semibold text-teal-800 hover:underline"
                    >
                      {rx.prescriptionId}
                    </button>
                    <span className="block text-xs text-slate-500">v{rx.latestVersionNumber}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="whitespace-nowrap font-medium text-slate-800">{rx.patientName ?? 'Unknown patient'}</span>
                    <span className="block font-mono text-xs text-slate-500">{rx.patientId}</span>
                  </td>
                  <td className="px-3 py-3 text-slate-800">{rx.drugSummary}</td>
                  <td className="px-3 py-3">
                    <StatusPill version={{ status: rx.currentStatus }} isLatest />
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-slate-600">
                    <time dateTime={rx.lastAnchoredAt} title={rx.lastAnchoredAt}>
                      {formatTime(rx.lastAnchoredAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Timeline({
  provenance,
  who,
  onAmend,
}: {
  provenance: Provenance;
  who: (providerId: string | null) => React.ReactNode;
  onAmend?: (prescriptionId: string) => void;
}) {
  const { versions, diffs } = provenance;
  const latest = versions[versions.length - 1];
  const first = versions[0];
  const diffByVersion = useMemo(() => new Map<number, VersionDiff>(diffs.map((d) => [d.toVersion, d])), [diffs]);

  const summaryTone =
    latest.status === 'revoked' ? 'border-red-200 bg-red-50' : latest.status === 'dispensed' ? 'border-sky-200 bg-sky-50' : 'border-emerald-200 bg-emerald-50';

  return (
    <>
      <div className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-6 py-4 ${summaryTone}`}>
        <div>
          <p className="font-mono text-lg font-semibold">{provenance.prescriptionId}</p>
          <p className="text-sm text-slate-700">
            {first.medicines.map((m) => m.drugName).join(', ')} · patient <span className="font-mono">{first.patientId}</span> · prescribed by {who(first.providerId)}
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-600">
            {versions.length} version{versions.length === 1 ? '' : 's'} · latest v{latest.versionNumber}
          </span>
          <StatusPill version={latest} isLatest />
          {onAmend && latest.status === 'active' && (
            <button type="button" onClick={() => onAmend(provenance.prescriptionId)} className="font-medium text-teal-700 hover:underline">
              Amend →
            </button>
          )}
        </div>
      </div>

      <ol className="relative space-y-5 border-l-2 border-slate-200 pl-6 sm:ml-3" aria-label="Version timeline">
        {versions.map((version) => {
          const diff = diffByVersion.get(version.versionNumber);
          const isLatest = version.versionNumber === latest.versionNumber;
          const revoked = version.status === 'revoked';
          return (
            <li key={version.id} className="relative" data-testid={`timeline-v${version.versionNumber}`}>
              <span
                aria-hidden
                className={`absolute -left-[33px] top-5 h-4 w-4 rounded-full border-2 border-white ring-2 ${
                  revoked ? 'bg-red-500 ring-red-200' : isLatest ? 'bg-emerald-500 ring-emerald-200' : 'bg-slate-300 ring-slate-100'
                }`}
              />
              <article
                className={`rounded-2xl border shadow-sm ${
                  revoked ? 'border-red-200 bg-red-50/60' : isLatest ? 'border-emerald-200 bg-white' : 'border-slate-200 bg-white/80'
                }`}
              >
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`rounded-md px-2 py-0.5 font-mono text-sm font-semibold ${revoked ? 'bg-red-100 text-red-800' : 'bg-slate-900 text-white'}`}>
                      v{version.versionNumber}
                    </span>
                    <StatusPill version={version} isLatest={isLatest} />
                  </div>
                  <time dateTime={version.createdAt} title={version.createdAt} className="text-xs text-slate-500">
                    {formatTime(version.createdAt)}
                  </time>
                </header>

                <div className="space-y-3 px-5 py-4">
                  <p className="text-sm text-slate-600">
                    {version.versionNumber === 1 ? (
                      <>
                        <span className="font-semibold text-slate-800">Initial version</span> · prescribed by {who(version.providerId)}
                      </>
                    ) : revoked ? (
                      <>
                        <span className="font-semibold text-red-800">Revoked</span> by {who(diff && isRevocationDiff(diff) ? diff.revokedBy : version.amendedByProviderId)}
                      </>
                    ) : (
                      <>
                        <span className="font-semibold text-slate-800">Amended</span> by {who(diff && !isRevocationDiff(diff) ? diff.amendedBy : version.amendedByProviderId)}
                      </>
                    )}
                  </p>

                  {revoked && (
                    <p data-testid="revoked-badge" className="inline-flex max-w-full items-start gap-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800">
                      <span aria-hidden>⛔</span>
                      <span>Revoked — reason: {version.reason ?? '(none recorded)'}</span>
                    </p>
                  )}

                  {!revoked && version.versionNumber > 1 && version.reason && (
                    <p className="text-sm text-slate-700">
                      <span className="text-slate-500">Reason:</span> “{version.reason}”
                    </p>
                  )}

                  {version.versionNumber === 1 && <Snapshot version={version} />}

                  {version.versionNumber > 1 && !revoked && diff && (
                    <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3">
                      {diff.changedFields.length > 0 ? (
                        <ChangeList changes={diff.changedFields} compact />
                      ) : (
                        <p className="py-2 text-sm text-slate-500">No field-level changes.</p>
                      )}
                    </div>
                  )}

                  {revoked && <p className="text-sm text-red-900/70">No clinical changes — the prescription was terminated. No further versions can follow.</p>}
                </div>

                <footer className="flex flex-wrap gap-x-5 gap-y-1 rounded-b-2xl border-t border-slate-100 px-5 py-2 font-mono text-[11px] text-slate-400">
                  <span title={version.integrityRoot}>integrity root {shortHash(version.integrityRoot)}</span>
                  <span title={version.ledgerAnchorRef}>anchor ref {shortHash(version.ledgerAnchorRef)}</span>
                </footer>
              </article>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function StatusPill({ version, isLatest }: { version: Pick<PrescriptionVersion, 'status'>; isLatest: boolean }) {
  const { label, style } =
    version.status === 'revoked'
      ? { label: 'Revoked', style: 'bg-red-600 text-white' }
      : version.status === 'dispensed'
        ? { label: 'Dispensed', style: 'bg-sky-100 text-sky-800' }
        : version.status === 'active' && isLatest
          ? { label: 'Current', style: 'bg-emerald-100 text-emerald-800' }
          : { label: 'Superseded', style: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${style}`}>{label}</span>;
}

function Snapshot({ version }: { version: PrescriptionVersion }) {
  const vitals: Array<[string, string]> = [
    ['Height', version.heightCm ? `${version.heightCm} cm` : 'not recorded'],
    ['Weight', version.weightKg ? `${version.weightKg} kg` : 'not recorded'],
  ];
  return (
    <div className="space-y-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm">
      <ol className="space-y-1">
        {version.medicines.map((m) => (
          <li key={m.medicineId} className="flex flex-wrap gap-x-2">
            <span className="w-5 shrink-0 text-slate-400">{m.sequenceNumber}.</span>
            <span className="font-medium text-slate-800">
              {m.drugName} <span className="font-normal text-slate-500">({m.drugClass})</span>
            </span>
            <span className="text-slate-600">
              {m.dosageValue} {m.dosageUnit} · {m.frequency} · {m.durationDays} days · qty {m.quantityPrescribed}
            </span>
          </li>
        ))}
      </ol>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {vitals.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
            <dd className="font-medium text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
