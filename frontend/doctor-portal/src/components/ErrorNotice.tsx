import { ApiError } from '../api';

/**
 * True only when the API actually evaluated the request and said no (a 4xx carrying an Anchor Rx reason).
 * Outages, timeouts, 5xx and unreadable responses are NOT decisions — the UI must not call them "rejected".
 */
export function isServerDecision(error: ApiError): boolean {
  return error.status >= 400 && error.status < 500 && !error.reason.startsWith('HTTP_');
}

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN_ERROR', err instanceof Error ? err.message : String(err));
}

/**
 * Shows the API's `reason` code EXACTLY as returned (e.g. NOT_AUTHORIZED_PROVIDER), plus its message.
 * Never paraphrased into a generic "something failed" — the real backend reason must reach the screen.
 */
export default function ErrorNotice({ title, error }: { title: string; error: ApiError }) {
  const showMessage = error.message && error.message !== error.reason;
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">
        <code data-testid="error-reason" className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
          {error.reason}
        </code>
        {showMessage && <span className="ml-2">{error.message}</span>}
      </p>
      {error.status > 0 && <p className="mt-1 text-xs text-red-700">HTTP {error.status}</p>}
    </div>
  );
}
