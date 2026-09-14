import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, revokePrescription } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import type { RevokeResult } from '../types';
import ErrorNotice, { isServerDecision, toApiError } from './ErrorNotice';
import { inputClass } from './formControls';

interface Props {
  prescriptionId: string;
  currentVersion: number;
  open: boolean;
  onClose: () => void;
  onRevoked: (result: RevokeResult, reason: string) => void;
}

/**
 * Confirmation modal for revocation. The reason is mandatory here (confirm stays disabled until it is
 * non-empty) AND on the server (REASON_REQUIRED). Authorization is decided only by the API; any
 * rejection is shown verbatim inside the dialog.
 */
export default function RevokeDialog({ prescriptionId, currentVersion, open, onClose, onRevoked }: Props) {
  const provider = useCurrentProvider();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setReason('');
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const canConfirm = reason.trim().length > 0 && !submitting;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      const result = await revokePrescription(prescriptionId, provider.providerId, trimmed);
      onRevoked(result, trimmed);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault(); // Esc: close through React state so `open` stays in sync
        if (!submitting) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-red-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/50"
    >
      <form onSubmit={onSubmit} noValidate>
        <div className="border-b border-red-100 bg-red-50 px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-red-900">
            Revoke {prescriptionId}?
          </h2>
          <p className="mt-1 text-sm text-red-800">
            This appends a terminal <strong>revoked</strong> version (v{currentVersion + 1}). It can’t be amended or revoked again.
            The clinical data stays in the audit trail.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <p className="text-sm text-slate-600">
            Revoking as <span className="font-medium text-slate-900">{provider.name}</span>{' '}
            <span className="font-mono text-xs text-slate-500">{provider.providerId}</span>
          </p>
          <div>
            <label htmlFor={`${titleId}-reason`} className="mb-1.5 block text-sm font-medium text-slate-700">
              Reason for revocation <span className="text-red-700">(required)</span>
            </label>
            <textarea
              id={`${titleId}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={255}
              autoFocus
              required
              disabled={submitting}
              placeholder="e.g. Patient reported penicillin allergy"
              className={inputClass(false)}
            />
            <p className="mt-1 text-right text-xs text-slate-400">{reason.length}/255</p>
          </div>

          {error && (
            <ErrorNotice
              title={isServerDecision(error) ? 'Revocation rejected by the server' : "Couldn't submit the revocation — nothing was changed"}
              error={error}
            />
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-100 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className="inline-flex items-center gap-2 rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            {submitting && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {submitting ? 'Revoking…' : 'Confirm revocation'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
