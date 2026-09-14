/**
 * ⚠ HACKATHON-ONLY MOCK LOGIN — ZERO REAL AUTHENTICATION.
 * Lists seeded providers from GET /api/providers and "signs in" as whichever one is clicked.
 * No credentials exist or are checked anywhere. See ProviderContext.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getProviders } from '../api';
import { useProvider } from '../context/ProviderContext';
import type { Provider } from '../types';
import ErrorNotice from './ErrorNotice';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; providers: Provider[] };

export default function ProviderLogin() {
  const { selectProvider } = useProvider();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', providers: await getProviders() });
    } catch (err) {
      setState({ status: 'error', error: err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN_ERROR', String(err)) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">Select your provider profile</h1>
      <p className="mt-1 text-sm text-slate-600">Every prescription you create will be issued under this provider.</p>

      <div role="note" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong className="font-semibold">Demo sign-in.</strong> No password or real authentication — these are synthetic, seeded
        providers for the hackathon prototype.
      </div>

      <div className="mt-6">
        {state.status === 'loading' && (
          <ul className="space-y-3" aria-busy="true" aria-label="Loading providers">
            {[0, 1].map((i) => (
              <li key={i} className="h-[68px] animate-pulse rounded-xl border border-slate-200 bg-white" />
            ))}
          </ul>
        )}

        {state.status === 'error' && (
          <div className="space-y-3">
            <ErrorNotice title="Couldn't load providers" error={state.error} />
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.providers.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            No active providers found. Run <code className="font-mono">npm run seed</code> and reload.
          </p>
        )}

        {state.status === 'ready' && state.providers.length > 0 && (
          <ul className="space-y-3">
            {state.providers.map((p) => (
              <li key={p.providerId}>
                <button
                  type="button"
                  onClick={() => selectProvider(p)}
                  className="group flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-teal-500 hover:shadow focus-visible:outline-2 focus-visible:outline-teal-600"
                >
                  <span>
                    <span className="block font-medium">{p.name}</span>
                    <span className="block font-mono text-xs text-slate-500">{p.providerId}</span>
                  </span>
                  <span className="text-sm font-medium text-teal-700 opacity-70 group-hover:opacity-100">Continue →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
