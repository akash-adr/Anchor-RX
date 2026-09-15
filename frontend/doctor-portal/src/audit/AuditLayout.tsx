import { useEffect } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import ErrorBoundary from '../components/ErrorBoundary';

/**
 * Shell for every /audit route (Module 10 Audit Dashboard).
 *
 * ⚠ PROTOTYPE SIMPLIFICATION — ZERO REAL ACCESS CONTROL.
 * The landing page's "Enter Audit Dashboard" link is the entire "gate": there is no auditor identity, no login and no
 * session, and the backend audit routes have no auth either (backend/api/routes/audit.js). This is deliberately even
 * more minimal than the Doctor/Pharmacy mock logins, which at least select a seeded identity. The header badge below
 * says so on screen as well, so nobody mistakes this for a secured area.
 */
export default function AuditLayout() {
  useEffect(() => {
    document.title = 'Anchor Rx · Audit Dashboard';
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label="Anchor Rx home" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-teal-600">
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="font-semibold tracking-tight">Anchor Rx</p>
              <p className="text-xs text-slate-500">Audit Dashboard</p>
            </div>
          </Link>

          <div className="flex flex-wrap items-center gap-3">
            <p
              data-testid="audit-prototype-badge"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
            >
              <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
              Prototype · no access control
            </p>
            <NavLink
              to="/audit"
              end
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-teal-600 ${
                  isActive ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-700 hover:bg-slate-100'
                }`
              }
            >
              All prescriptions
            </NavLink>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
