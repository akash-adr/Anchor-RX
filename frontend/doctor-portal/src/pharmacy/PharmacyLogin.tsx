/**
 * ⚠ HACKATHON-ONLY MOCK LOGIN — ZERO REAL AUTHENTICATION.
 * Mirrors the Doctor Portal's ProviderLogin: lists seeded pharmacies from GET /api/pharmacies and
 * "signs in" as whichever one is clicked. No credentials exist or are checked anywhere. See PharmacyContext.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, getPharmacies } from '../api';
import ErrorNotice, { toApiError } from '../components/ErrorNotice';
import { usePharmacy } from '../context/PharmacyContext';
import type { Pharmacy } from '../types';

type LoadState = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; pharmacies: Pharmacy[] };

export default function PharmacyLogin() {
  const { pharmacy, selectPharmacy } = usePharmacy();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', pharmacies: await getPharmacies() });
    } catch (err) {
      setState({ status: 'error', error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    if (!pharmacy) void load();
  }, [pharmacy, load]);

  // Already signed in (e.g. page refresh): go straight to the scan screen.
  if (pharmacy) return <Navigate to="/pharmacy/scan" replace />;

  return (
    <section className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">Select your pharmacy</h1>
      <p className="mt-1 text-sm text-slate-600">Every scan you verify will be recorded against this pharmacy.</p>

      <div role="note" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong className="font-semibold">Demo sign-in.</strong> No password or real authentication — these are synthetic, seeded
        pharmacies for the hackathon prototype.
      </div>

      <div className="mt-6">
        {state.status === 'loading' && (
          <ul className="space-y-3" aria-busy="true" aria-label="Loading pharmacies">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-[68px] animate-pulse rounded-xl border border-slate-200 bg-white" />
            ))}
          </ul>
        )}

        {state.status === 'error' && (
          <div className="space-y-3">
            <ErrorNotice title="Couldn't load pharmacies" error={state.error} />
            <button type="button" onClick={() => void load()} className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.pharmacies.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            No pharmacies found. Run <code className="font-mono">npm run seed:demo</code> and reload.
          </p>
        )}

        {state.status === 'ready' && state.pharmacies.length > 0 && (
          <ul className="space-y-3">
            {state.pharmacies.map((p) => (
              <li key={p.pharmacyId}>
                <button
                  type="button"
                  onClick={() => {
                    selectPharmacy(p);
                    navigate('/pharmacy/scan', { replace: true });
                  }}
                  className="group flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-teal-500 hover:shadow focus-visible:outline-2 focus-visible:outline-teal-600"
                >
                  <span className="min-w-0 pr-3">
                    <span className="block font-medium">{p.name}</span>
                    <span className="block font-mono text-xs text-slate-500">{p.pharmacyId}</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-sm font-medium text-teal-700 opacity-70 group-hover:opacity-100">Continue →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
