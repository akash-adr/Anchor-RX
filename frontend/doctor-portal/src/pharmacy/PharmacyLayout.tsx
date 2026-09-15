import { useEffect } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { Pill } from 'lucide-react';
import ErrorBoundary from '../components/ErrorBoundary';
import { usePharmacy } from '../context/PharmacyContext';

/** Shell for every /pharmacy route: header with the selected pharmacy, then the routed screen. */
export default function PharmacyLayout() {
  const { pharmacy, clearPharmacy } = usePharmacy();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Anchor Rx · Pharmacy Portal';
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label="Anchor Rx home" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-teal-600">
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Pill className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="font-semibold tracking-tight">Anchor Rx</p>
              <p className="text-xs text-slate-500">Pharmacy Portal</p>
            </div>
          </Link>

          {pharmacy && (
            <div className="flex items-center gap-3">
              <div className="text-right leading-tight">
                <p className="text-sm font-medium">{pharmacy.name}</p>
                <p className="font-mono text-xs text-slate-500">{pharmacy.pharmacyId}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearPharmacy();
                  navigate('/pharmacy', { replace: true });
                }}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-teal-600"
              >
                Switch pharmacy
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
