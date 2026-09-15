import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, scanPrescription } from '../api';
import { toApiError } from '../components/ErrorNotice';
import { useCurrentPharmacy, usePharmacy } from '../context/PharmacyContext';
import type { ScanResult } from '../types';
import CameraScanner from './CameraScanner';
import ManualPayloadEntry from './ManualPayloadEntry';
import ScanHistory, { type ScanHistoryEntry } from './ScanHistory';
import ScanServiceError from './ScanServiceError';
import ScanResultView, { type InputSource } from './results/ScanResultCards';

// Local verification answers in milliseconds; keep "Verifying…" on screen long enough to be read.
// Display-only: never alters or delays the result itself beyond this floor.
const MIN_VERIFYING_MS = 500;

type ScanState =
  | { status: 'idle' }
  | { status: 'verifying'; raw: string; source: InputSource }
  | { status: 'result'; raw: string; source: InputSource; result: ScanResult }
  | { status: 'service-error'; raw: string; source: InputSource; error: ApiError };

export default function PharmacyScanScreen() {
  const pharmacy = useCurrentPharmacy();
  const { clearPharmacy } = usePharmacy();
  const navigate = useNavigate();
  const [scan, setScan] = useState<ScanState>({ status: 'idle' });
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]); // session-local preview, not the audit log
  const historyCounter = useRef(0);
  const inFlight = useRef(false);
  const sourceRef = useRef<InputSource>('manual');
  const outcomeRef = useRef<HTMLDivElement>(null);

  // On narrow screens the outcome renders below the tall input panels: bring "Verifying…", the result card
  // or the service error into view so the pharmacist never has to hunt for what happened.
  useEffect(() => {
    if (scan.status === 'idle') return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    outcomeRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, [scan.status, scan]);

  /**
   * THE single submission path for both camera and manual input.
   * Resolves → the server evaluated the scan (any scanResult, including malformed_qr / unknown_prescription).
   * Rejects → the request itself failed (network, timeout, 5xx, unknown pharmacy): shown as a service error.
   */
  const submitScan = useCallback(
    async (rawString: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const source = sourceRef.current;
      setScan({ status: 'verifying', raw: rawString, source });
      const startedAt = Date.now();
      let next: ScanState;
      try {
        const result = await scanPrescription(rawString, pharmacy.pharmacyId);
        next = { status: 'result', raw: rawString, source, result };
      } catch (err) {
        next = { status: 'service-error', raw: rawString, source, error: toApiError(err) };
      }
      const remaining = MIN_VERIFYING_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      historyCounter.current += 1;
      const entry: ScanHistoryEntry =
        next.status === 'result'
          ? { key: `scan-${historyCounter.current}`, prescriptionId: next.result.prescriptionId, outcome: next.result.scanResult, detail: null, at: next.result.scannedAt, source }
          : { key: `scan-${historyCounter.current}`, prescriptionId: null, outcome: 'not_checked', detail: next.status === 'service-error' ? next.error.reason : null, at: new Date().toISOString(), source };
      setHistory((previous) => [entry, ...previous]); // most recent first
      setScan(next);
      inFlight.current = false;
    },
    [pharmacy.pharmacyId],
  );

  const busy = scan.status === 'verifying';

  return (
    <section aria-labelledby="scan-title" className="space-y-6">
      <div>
        <h1 id="scan-title" className="text-2xl font-semibold tracking-tight">
          Verify a prescription
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Scans are recorded for <span className="font-medium text-slate-800">{pharmacy.name}</span>{' '}
          <span className="font-mono text-xs text-slate-500">{pharmacy.pharmacyId}</span>. Both inputs run the same verification.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <CameraScanner
          disabled={busy}
          onDecode={(raw) => {
            sourceRef.current = 'camera';
            void submitScan(raw);
          }}
        />
        <ManualPayloadEntry
          disabled={busy}
          onSubmit={(raw) => {
            sourceRef.current = 'manual';
            void submitScan(raw);
          }}
        />
      </div>

      <div ref={outcomeRef} aria-live="polite" className="scroll-mt-4">
        {scan.status === 'verifying' && (
          <section data-testid="scan-verifying" className="flex items-center gap-4 rounded-2xl border border-teal-200 bg-teal-50 p-6">
            <span aria-hidden className="h-8 w-8 shrink-0 animate-spin rounded-full border-4 border-teal-200 border-t-teal-700" />
            <div>
              <p className="font-semibold text-teal-900">Verifying prescription…</p>
              <p className="text-sm text-teal-800">Checking prescriber status, field hashes, ledger anchor and current version.</p>
            </div>
          </section>
        )}

        {scan.status === 'service-error' && (
          <ScanServiceError
            error={scan.error}
            onRetry={() => {
              sourceRef.current = scan.source;
              void submitScan(scan.raw);
            }}
            onSwitchPharmacy={() => {
              clearPharmacy();
              navigate('/pharmacy', { replace: true });
            }}
          />
        )}

        {scan.status === 'result' && (
          <ScanResultView
            result={scan.result}
            source={scan.source}
            onVerifyPayload={(raw) => {
              sourceRef.current = 'follow-up';
              void submitScan(raw);
            }}
            onScanAnother={() => setScan({ status: 'idle' })}
          />
        )}
      </div>

      <ScanHistory entries={history} />
    </section>
  );
}
