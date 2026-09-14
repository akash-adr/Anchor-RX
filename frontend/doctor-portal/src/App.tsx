import { useState } from 'react';
import { useProvider } from './context/ProviderContext';
import AmendPrescription from './components/AmendPrescription';
import CreatePrescription from './components/CreatePrescription';
import HistoryView from './components/HistoryView';
import ErrorBoundary from './components/ErrorBoundary';
import ProviderLogin from './components/ProviderLogin';

type View =
  | { name: 'create' }
  | { name: 'amend'; prescriptionId?: string; nonce: number }
  | { name: 'history'; prescriptionId?: string; nonce: number };

export default function App() {
  const { provider, clearProvider } = useProvider();
  const [view, setView] = useState<View>({ name: 'create' });

  const openAmend = (prescriptionId?: string) => setView({ name: 'amend', prescriptionId, nonce: Date.now() });
  const openHistory = (prescriptionId?: string) => setView({ name: 'history', prescriptionId, nonce: Date.now() });

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${active ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`;

  const tabs: Array<{ name: View['name']; label: string; open: () => void }> = [
    { name: 'create', label: 'New prescription', open: () => setView({ name: 'create' }) },
    { name: 'amend', label: 'Amend', open: () => openAmend() },
    { name: 'history', label: 'History', open: () => openHistory() },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700 text-lg text-white">
              ⚓
            </span>
            <div className="leading-tight">
              <p className="font-semibold tracking-tight">Anchor Rx</p>
              <p className="text-xs text-slate-500">Doctor Portal</p>
            </div>
          </div>

          {provider && (
            <nav aria-label="Doctor portal" className="order-last flex w-full gap-1 sm:order-none sm:w-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.name}
                  type="button"
                  aria-current={view.name === tab.name ? 'page' : undefined}
                  onClick={tab.open}
                  className={tabClass(view.name === tab.name)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          )}

          {provider && (
            <div className="flex items-center gap-3">
              <div className="text-right leading-tight">
                <p className="text-sm font-medium">{provider.name}</p>
                <p className="font-mono text-xs text-slate-500">{provider.providerId}</p>
              </div>
              <button
                type="button"
                onClick={clearProvider}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-teal-600"
              >
                Switch provider
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* key: navigating to another screen clears a previous render error */}
        <ErrorBoundary key={view.name === 'create' ? 'create' : `${view.name}:${view.nonce}`}>
        {!provider && <ProviderLogin />}
        {provider && view.name === 'create' && <CreatePrescription onAmend={openAmend} />}
        {provider && view.name === 'amend' && (
          // key: switching provider or jumping in from another screen remounts with fresh state
          <AmendPrescription key={`${provider.providerId}:${view.nonce}`} initialPrescriptionId={view.prescriptionId} onViewHistory={openHistory} />
        )}
        {provider && view.name === 'history' && (
          <HistoryView key={`history:${view.nonce}`} initialPrescriptionId={view.prescriptionId} onAmend={openAmend} />
        )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
