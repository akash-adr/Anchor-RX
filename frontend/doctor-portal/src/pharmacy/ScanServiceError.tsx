import { PlugZap, Store } from 'lucide-react';
import type { ApiError } from '../api';

/**
 * The request did not produce a scan result at all. Deliberately styled unlike ANY result card
 * (dark panel, "not checked" wording): "the system couldn't be reached" must never look like
 * "the system checked and found a problem".
 */
export default function ScanServiceError({
  error,
  onRetry,
  onSwitchPharmacy,
}: {
  error: ApiError;
  onRetry: () => void;
  onSwitchPharmacy: () => void;
}) {
  const unknownPharmacy = error.reason === 'UNKNOWN_PHARMACY';
  const Icon = unknownPharmacy ? Store : PlugZap;

  return (
    <section role="alert" data-testid="scan-service-error" className="rounded-2xl bg-slate-900 p-6 text-slate-100 shadow-lg ring-1 ring-slate-700">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-amber-300">
          <Icon aria-hidden className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white">
            {unknownPharmacy ? 'The verification service doesn’t recognize this pharmacy' : 'Unable to reach verification service'}
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            <strong className="font-semibold text-white">This prescription was NOT checked.</strong> This is not a verification result — do
            not treat it as one.
          </p>
          <p className="mt-3 text-sm">
            <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-amber-200">{error.reason}</code>
            {error.message && error.message !== error.reason && <span className="ml-2 text-slate-300">{error.message}</span>}
          </p>
          {error.status > 0 && <p className="mt-1 text-xs text-slate-400">HTTP {error.status}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            {unknownPharmacy ? (
              <button type="button" onClick={onSwitchPharmacy} className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200">
                Switch pharmacy
              </button>
            ) : (
              <button type="button" onClick={onRetry} className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200">
                Retry verification
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
