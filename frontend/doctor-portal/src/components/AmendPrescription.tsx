/**
 * Amend screen.
 *
 * AUTHORIZATION IS NOT DECIDED HERE. This screen never checks whether the selected provider may amend a
 * prescription, and it does not validate the amended values: every attempt goes to the API, where
 * Module 3's canAmend() (and the repository's validation) decide. Whatever the server rejects is shown
 * with its exact `reason` code.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, amendPrescription, getProvenance } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import type { AmendChanges, AmendResult, PrescriptionVersion, Provenance, RevokeResult, VersionStatus } from '../types';
import ChangeSummary from './ChangeSummary';
import DownloadPrescriptionButton from './DownloadPrescriptionButton';
import RevokeDialog from './RevokeDialog';
import ErrorNotice, { isServerDecision, toApiError } from './ErrorNotice';
import { DosageUnitInput, Field, LockedInput, TextInput, inputClass } from './formControls';

const NEW_PRESCRIPTION_HINT = 'Changing this requires a new prescription, not an amendment.';

interface EditableState {
  dosageValue: string;
  dosageUnit: string;
  frequency: string;
  durationDays: string;
}

function editableFrom(version: PrescriptionVersion): EditableState {
  return {
    dosageValue: version.dosageValue, // exact DECIMAL string from the API, e.g. "500.000"
    dosageUnit: version.dosageUnit,
    frequency: version.frequency,
    durationDays: String(version.durationDays),
  };
}

/** Only fields that differ from the loaded latest version are sent. Values are sent as entered. */
function changesFrom(form: EditableState, latest: PrescriptionVersion): AmendChanges {
  const changes: AmendChanges = {};
  if (form.dosageValue.trim() !== latest.dosageValue) changes.dosageValue = form.dosageValue.trim();
  if (form.dosageUnit.trim() !== latest.dosageUnit) changes.dosageUnit = form.dosageUnit.trim();
  if (form.frequency.trim() !== latest.frequency) changes.frequency = form.frequency.trim();
  if (form.durationDays.trim() !== String(latest.durationDays)) {
    const days = form.durationDays.trim();
    changes.durationDays = /^\d+$/.test(days) ? Number(days) : days;
  }
  return changes;
}

const STATUS_STYLES: Record<VersionStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  amended: 'bg-slate-100 text-slate-700',
  dispensed: 'bg-sky-100 text-sky-800',
  revoked: 'bg-red-100 text-red-800',
};

type Lookup =
  | { status: 'idle' }
  | { status: 'loading'; prescriptionId: string }
  | { status: 'error'; prescriptionId: string; error: ApiError }
  | { status: 'ready'; provenance: Provenance; latest: PrescriptionVersion };

export default function AmendPrescription({
  initialPrescriptionId,
  onViewHistory,
}: {
  initialPrescriptionId?: string;
  onViewHistory?: (prescriptionId: string) => void;
}) {
  const provider = useCurrentProvider();
  const [query, setQuery] = useState(initialPrescriptionId ?? '');
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const [form, setForm] = useState<EditableState | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [lastResult, setLastResult] = useState<AmendResult | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeResult, setRevokeResult] = useState<(RevokeResult & { reason: string }) | null>(null);

  const load = useCallback(async (prescriptionId: string, { keepResult = false } = {}) => {
    setLookup({ status: 'loading', prescriptionId });
    setSubmitError(null);
    if (!keepResult) {
      setLastResult(null);
      setRevokeResult(null);
    }
    try {
      const provenance = await getProvenance(prescriptionId);
      const latest = provenance.versions[provenance.versions.length - 1];
      setLookup({ status: 'ready', provenance, latest });
      setForm(editableFrom(latest));
      setReason('');
    } catch (err) {
      setLookup({ status: 'error', prescriptionId, error: toApiError(err) });
      setForm(null);
    }
  }, []);

  useEffect(() => {
    if (initialPrescriptionId) void load(initialPrescriptionId);
  }, [initialPrescriptionId, load]);

  const onLookup = (event: FormEvent) => {
    event.preventDefault();
    const id = query.trim();
    if (id) void load(id);
  };

  const latest = lookup.status === 'ready' ? lookup.latest : null;

  // ⚠ UX CONVENIENCE ONLY — NOT ENFORCEMENT.
  // Locking the form for dispensed/revoked prescriptions just saves the doctor a pointless attempt. It is
  // based on the snapshot loaded above, which can be stale (e.g. revoked or dispensed elsewhere after this
  // page loaded). The submit handler below therefore never re-checks status or permissions itself: any
  // request that gets through always goes to the API, and Module 3's canAmend() on the backend is the only
  // actual authority — its rejection reason is what the user sees.
  const lockedStatus = latest && (latest.status === 'dispensed' || latest.status === 'revoked') ? latest.status : null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!latest || !form) return;
    setSubmitting(true);
    setSubmitError(null);
    setLastResult(null);
    setRevokeResult(null);
    try {
      const result = await amendPrescription(
        latest.prescriptionId,
        changesFrom(form, latest), // may be empty: the API answers NO_CHANGES, which is shown verbatim
        provider.providerId,
        reason.trim() || undefined,
      );
      setLastResult(result);
      await load(latest.prescriptionId, { keepResult: true }); // show the new latest version
    } catch (err) {
      setSubmitError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pendingChanges = latest && form ? Object.keys(changesFrom(form, latest)) : [];
  const disabled = submitting || Boolean(lockedStatus);

  return (
    <section aria-labelledby="amend-title" className="space-y-6">
      <div>
        <h1 id="amend-title" className="text-2xl font-semibold tracking-tight">
          Amend a prescription
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Acting as <span className="font-medium text-slate-800">{provider.name}</span>. Only dose, unit, frequency and duration can be
          amended — the server decides whether you may.
        </p>
      </div>

      <form onSubmit={onLookup} className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <label htmlFor="lookup" className="mb-1.5 block text-sm font-medium text-slate-700">
            Prescription ID
          </label>
          <input
            id="lookup"
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
          disabled={!query.trim() || lookup.status === 'loading' || submitting}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {lookup.status === 'loading' ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {lookup.status === 'error' && <ErrorNotice title={`Couldn't load ${lookup.prescriptionId}`} error={lookup.error} />}

      {lastResult && <ChangeSummary result={lastResult} />}

      {revokeResult && (
        <section role="status" aria-labelledby="revoke-result-title" className="rounded-2xl border border-red-200 bg-white px-5 py-4 shadow-sm">
          <h2 id="revoke-result-title" className="font-semibold text-red-900">
            Prescription revoked as v{revokeResult.versionNumber}
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">
            Reason: “{revokeResult.reason}”. The revoked version was hashed and anchored like any other version.
          </p>
        </section>
      )}

      {lookup.status === 'ready' && latest && form && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
            <div>
              <p className="font-mono text-lg font-semibold">{latest.prescriptionId}</p>
              <p className="text-xs text-slate-500">
                Current version v{latest.versionNumber} of {lookup.provenance.versions.length} · original prescriber{' '}
                <span className="font-mono">{latest.providerId}</span>
                {latest.amendedByProviderId && (
                  <>
                    {' '}
                    · last change by <span className="font-mono">{latest.amendedByProviderId}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {onViewHistory && (
                <button type="button" onClick={() => onViewHistory(latest.prescriptionId)} className="text-sm font-medium text-teal-700 hover:underline">
                  View full history →
                </button>
              )}
              <span data-testid="version-status" className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${STATUS_STYLES[latest.status]}`}>
                {latest.status}
              </span>
            </div>
          </div>

          {/* A revoked record is not a prescription to hand out, so there is nothing to download for it. */}
          {latest.status !== 'revoked' && (
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-6 py-3">
              <DownloadPrescriptionButton prescriptionId={latest.prescriptionId} versionNumber={latest.versionNumber} />
              <p className="text-xs text-slate-500">One-page PDF of the current version (v{latest.versionNumber}) with its QR code.</p>
            </div>
          )}

          {lockedStatus && (
            <div role="note" className="mx-6 mt-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">This prescription is {lockedStatus} and can no longer be amended.</p>
              <p className="mt-0.5">
                {lockedStatus === 'revoked'
                  ? `Revoked${latest.amendedByProviderId ? ` by ${latest.amendedByProviderId}` : ''}${latest.reason ? `: “${latest.reason}”` : ''}. Create a new prescription instead.`
                  : 'It has already been dispensed. Create a new prescription if therapy needs to change.'}
              </p>
            </div>
          )}

          <form onSubmit={onSubmit} noValidate className="p-6">
            <fieldset disabled={disabled} className="space-y-6">
              <legend className="sr-only">Amend prescription fields</legend>

              <div className="grid gap-6 sm:grid-cols-3">
                <Field label="Patient" htmlFor="lockedPatient" hint={NEW_PRESCRIPTION_HINT}>
                  <LockedInput id="lockedPatient" value={latest.patientId} hint={NEW_PRESCRIPTION_HINT} />
                </Field>
                <Field label="Drug name" htmlFor="lockedDrugName" hint={NEW_PRESCRIPTION_HINT}>
                  <LockedInput id="lockedDrugName" value={latest.drugName} hint={NEW_PRESCRIPTION_HINT} />
                </Field>
                <Field label="Drug class" htmlFor="lockedDrugClass" hint={NEW_PRESCRIPTION_HINT}>
                  <LockedInput id="lockedDrugClass" value={latest.drugClass} hint={NEW_PRESCRIPTION_HINT} />
                </Field>
              </div>

              <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-4">
                <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-teal-800">Amendable fields</p>
                <div className="grid gap-6 sm:grid-cols-2">
                  <Field label="Dosage value" htmlFor="amendDosageValue">
                    <input
                      id="amendDosageValue"
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={form.dosageValue}
                      onChange={(e) => setForm({ ...form, dosageValue: e.target.value })}
                      className={inputClass(false)}
                    />
                  </Field>
                  <Field label="Dosage unit" htmlFor="amendDosageUnit">
                    <DosageUnitInput id="amendDosageUnit" value={form.dosageUnit} onChange={(v) => setForm({ ...form, dosageUnit: v })} />
                  </Field>
                  <Field label="Frequency" htmlFor="amendFrequency">
                    <TextInput id="amendFrequency" value={form.frequency} onChange={(v) => setForm({ ...form, frequency: v })} />
                  </Field>
                  <Field label="Duration (days)" htmlFor="amendDurationDays">
                    <input
                      id="amendDurationDays"
                      type="number"
                      inputMode="numeric"
                      step="1"
                      value={form.durationDays}
                      onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
                      className={inputClass(false)}
                    />
                  </Field>
                </div>
              </div>

              <Field label="Reason for this amendment (optional)" htmlFor="amendReason">
                <textarea
                  id="amendReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={255}
                  placeholder="e.g. Pain not controlled at current dose"
                  className={inputClass(false)}
                />
              </Field>

              {submitError && (
                <ErrorNotice
                  title={isServerDecision(submitError) ? 'Amendment rejected by the server' : "Couldn't submit the amendment — nothing was changed"}
                  error={submitError}
                />
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
                <p className="text-sm text-slate-500" data-testid="pending-changes">
                  {pendingChanges.length === 0
                    ? 'No fields changed yet.'
                    : `Changing: ${pendingChanges.join(', ')}`}
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setForm(editableFrom(latest));
                      setSubmitError(null);
                    }}
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
                  >
                    Reset
                  </button>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                    {submitting ? 'Submitting…' : 'Submit amendment'}
                  </button>
                </div>
              </div>
            </fieldset>
          </form>

          {/* Deliberately a separate section under the amend form, left-aligned, never next to "Submit amendment". */}
          <section aria-labelledby="revoke-section-title" className="mx-6 mb-6 mt-4 rounded-xl border border-red-200 bg-red-50/50 p-5">
            <h2 id="revoke-section-title" className="text-sm font-semibold uppercase tracking-wide text-red-800">
              Revoke prescription
            </h2>
            <p className="mt-1 text-sm text-red-900/80">
              Ends this prescription permanently with a terminal revoked version. A reason is required.
            </p>
            <button
              type="button"
              onClick={() => setRevokeOpen(true)}
              // Same UX-only lock as the amend form — NOT enforcement; the API's canAmend() decides.
              disabled={Boolean(lockedStatus) || submitting}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-red-700"
            >
              <span aria-hidden>⚠</span> Revoke…
            </button>
          </section>

          <RevokeDialog
            prescriptionId={latest.prescriptionId}
            currentVersion={latest.versionNumber}
            open={revokeOpen}
            onClose={() => setRevokeOpen(false)}
            onRevoked={(result, revokedReason) => {
              setRevokeOpen(false);
              setLastResult(null);
              setRevokeResult({ ...result, reason: revokedReason });
              void load(latest.prescriptionId, { keepResult: true });
            }}
          />
        </div>
      )}
    </section>
  );
}
