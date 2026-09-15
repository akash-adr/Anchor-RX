import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, History } from 'lucide-react';
import { getAuditTimeline, type ApiError } from '../api';
import ErrorNotice, { toApiError } from '../components/ErrorNotice';
import type { AuditTimeline } from '../types';
import CurrentIntegrityCard from './CurrentIntegrityCard';
import HistoryTimeline from './HistoryTimeline';

type Load = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; timeline: AuditTimeline };

/**
 * One prescription: LIVE status on top, immutable HISTORY below.
 * The two are separate components with separate requests and separate state; nothing is passed between them.
 */
export default function AuditDetailScreen() {
  const { prescriptionId = '' } = useParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    document.title = `Anchor Rx · Audit · ${prescriptionId}`;
    let cancelled = false;
    setLoad({ status: 'loading' });
    getAuditTimeline(prescriptionId)
      .then((timeline) => {
        if (!cancelled) setLoad({ status: 'ready', timeline });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', error: toApiError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [prescriptionId]);

  return (
    <div className="space-y-8">
      <div>
        <Link to="/audit" className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-teal-600">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          All prescriptions
        </Link>
        <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-teal-700">Audit trail</p>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{prescriptionId}</h1>
      </div>

      {/* 1 — LIVE: what's true right now (top). */}
      <CurrentIntegrityCard key={prescriptionId} prescriptionId={prescriptionId} />

      {/* 2 — HISTORY: what was recorded (below). */}
      <section aria-labelledby="history-title" className="space-y-4 border-t-2 border-dashed border-slate-300 pt-8">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
            <History aria-hidden className="h-4 w-4" />
            Immutable record
          </p>
          <h2 id="history-title" className="text-xl font-semibold tracking-tight">
            History
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            What was logged, in chronological order (oldest first). These records are never rechecked or rewritten — for the current state, use the live card above.
          </p>
        </div>

        {load.status === 'loading' && (
          <p role="status" className="text-sm text-slate-500">
            Loading history…
          </p>
        )}
        {load.status === 'error' && <ErrorNotice title="Couldn't load the audit history" error={load.error} />}
        {load.status === 'ready' && <HistoryTimeline data={load.timeline} />}
      </section>
    </div>
  );
}
