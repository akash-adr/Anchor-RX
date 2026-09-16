/**
 * Module 15 — review the AI risk for EVERY medicine before the prescription is authorized.
 *
 * Shown between "Authorize & anchor" (assess-risk: scores, saves nothing) and "Confirm & Authorize" (confirm-and-create:
 * creates the prescription with exactly this risk locked per medicine). A medicine the AI service could not score is
 * shown as "AI risk assessment unavailable" and still has to be confirmed — the safeguard is never skipped. Display only: the numbers come from the server's
 * preview response, and confirming sends only the previewToken — this screen never sends risk data back.
 */

import { AlertTriangle, ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ApiError } from '../api';
import { Chip, RISK_BAND_STYLE } from '../audit/auditUi';
import type { NewMedicine, RiskPreview } from '../types';
import ErrorNotice from './ErrorNotice';

const SOURCE_LABEL = { rule_engine: 'Rule', ml_model: 'Model', system: 'System' } as const;

const formatDose = (value: string, unit: string) => `${value} ${unit}`;

export default function RiskConfirmation({
  preview,
  submittedMedicines,
  patientLabel,
  confirming,
  rechecking,
  error,
  onConfirm,
  onBack,
  onRecheck,
}: {
  preview: RiskPreview;
  submittedMedicines: NewMedicine[]; // snapshot of exactly what was sent for scoring (same order)
  patientLabel: string;
  confirming: boolean;
  rechecking: boolean;
  error: ApiError | null;
  onConfirm: () => void;
  onBack: () => void;
  onRecheck: () => void;
}) {
  const expired = error?.reason === 'RISK_PREVIEW_EXPIRED';
  const busy = confirming || rechecking;
  const flagged = preview.medicines.filter((m) => m.riskBand === 'review' || m.riskBand === 'high').length;
  const unavailable = preview.medicines.filter((m) => m.riskBand === 'unavailable').length;

  return (
    <section aria-labelledby="risk-confirm-title" data-testid="risk-confirmation" className="space-y-5">
      <div>
        <h1 id="risk-confirm-title" className="text-2xl font-semibold tracking-tight">
          Review AI risk before authorizing
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Nothing has been saved yet. {preview.medicines.length} medicine{preview.medicines.length === 1 ? '' : 's'} for{' '}
          <span className="font-medium text-slate-800">{patientLabel}</span> were checked
          {flagged > 0 ? ` · ${flagged} in the review or high band` : unavailable === 0 ? ' · all in the low band' : ''}
          {unavailable > 0 ? ` · AI risk assessment unavailable for ${unavailable}` : ''}. Confirming locks these results to the prescription.
        </p>
      </div>

      <ol className="space-y-3" data-testid="risk-medicines">
        {preview.medicines.map((medicine, index) => {
          const band = RISK_BAND_STYLE[medicine.riskBand];
          const sent = submittedMedicines[index];
          return (
            <li key={index} data-testid={`risk-medicine-${index + 1}`} data-band={medicine.riskBand} className={`rounded-2xl border p-4 shadow-sm ${band.frame}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">
                    <span className="mr-1.5 text-xs font-normal text-slate-500">{index + 1}.</span>
                    {medicine.drugName}
                  </p>
                  {sent && (
                    <p className="text-xs text-slate-600">
                      {sent.drugClass} · {formatDose(sent.dosageValue, sent.dosageUnit)} · {sent.frequency} · {sent.durationDays} days · qty {sent.quantityPrescribed}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {medicine.riskScore === null ? (
                    <span className="font-mono text-lg font-semibold text-slate-500" aria-label="No AI risk score">
                      —
                    </span>
                  ) : (
                    <span className="font-mono text-lg font-semibold text-slate-900" aria-label={`Risk score ${medicine.riskScore} out of 100`}>
                      {medicine.riskScore}
                      <span className="text-xs font-normal text-slate-500">/100</span>
                    </span>
                  )}
                  <Chip className={band.chip}>{band.label}</Chip>
                </div>
              </div>

              {medicine.reasons.length > 0 ? (
                <ol className="mt-3 space-y-1.5" aria-label={`Reasons for ${medicine.drugName}, most important first`}>
                  {medicine.reasons.map((reason, rank) => (
                    <li key={`${reason.feature}-${rank}`} className="flex items-start gap-2 rounded-lg bg-white/80 px-3 py-2 text-sm ring-1 ring-black/5">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-white">{rank + 1}</span>
                      <span className="min-w-0 flex-1 text-slate-800">{reason.explanation}</span>
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{SOURCE_LABEL[reason.source] ?? reason.source}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-3 flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-sm text-emerald-900 ring-1 ring-black/5" data-testid="no-concerns">
                  <ShieldCheck aria-hidden className="h-4 w-4 text-emerald-700" />
                  {medicine.riskBand === 'low' ? 'No concerns flagged' : 'No specific reasons were returned for this score'}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-slate-500">
        AI risk is decision support from synthetic reference data and a model trained on synthetic prescriptions — it does not establish that a
        prescription is clinically safe. Your clinical judgement decides.
      </p>

      {error && (
        <div className="space-y-2">
          <ErrorNotice title={expired ? 'This risk assessment is no longer valid — nothing was created' : 'The prescription was not created'} error={error} />
          {expired && (
            <button
              type="button"
              onClick={onRecheck}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              <RefreshCw aria-hidden className={`h-4 w-4 ${rechecking ? 'animate-spin' : ''}`} />
              {rechecking ? 'Checking AI risk…' : 'Run the risk check again'}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Go back and edit
        </button>
        <div className="flex items-center gap-3">
          {flagged > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-900">
              <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
              Review the flagged reasons before confirming
            </span>
          )}
          {unavailable > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-700" data-testid="unavailable-note">
              <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
              No AI assessment for {unavailable} medicine{unavailable === 1 ? '' : 's'} — confirm using your clinical review
            </span>
          )}
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || expired}
            className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirming && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {confirming ? 'Authorizing & anchoring…' : 'Confirm & Authorize'}
          </button>
        </div>
      </div>
    </section>
  );
}
