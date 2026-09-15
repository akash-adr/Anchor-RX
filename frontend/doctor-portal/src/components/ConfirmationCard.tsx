import { useState } from 'react';
import type { CreatedPrescription } from '../types';
import DownloadPrescriptionButton from './DownloadPrescriptionButton';
import QrCodeCard from './QrCodeCard';

function truncateHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function ConfirmationCard({
  result,
  onCreateAnother,
  onAmend,
}: {
  result: CreatedPrescription;
  onCreateAnother: () => void;
  onAmend?: (prescriptionId: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showFullRoot, setShowFullRoot] = useState(false);

  const onCopy = async () => {
    setCopyState((await copyText(result.integrityRoot)) ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <section aria-labelledby="confirmation-title" className="rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 rounded-t-2xl border-b border-emerald-100 bg-emerald-50 px-6 py-4">
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white">
          ✓
        </span>
        <div>
          <h2 id="confirmation-title" className="font-semibold text-emerald-900">
            Prescription authorized &amp; anchored
          </h2>
          <p className="text-sm text-emerald-800">Field hashes computed, integrity root recorded on the ledger.</p>
        </div>
      </div>

      <div className="grid gap-6 p-6 md:grid-cols-[1fr_auto]">
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-slate-500">Prescription ID</dt>
            <dd className="mt-0.5 font-mono text-lg font-semibold">{result.prescriptionId}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Version</dt>
            <dd className="mt-0.5 font-medium">v{result.versionNumber}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Integrity root (SHA-256)</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <code
                title={result.integrityRoot}
                className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs"
                data-testid="integrity-root"
              >
                {showFullRoot ? result.integrityRoot : truncateHash(result.integrityRoot)}
              </code>
              <button type="button" onClick={() => setShowFullRoot((v) => !v)} className="text-xs font-medium text-teal-700 hover:underline">
                {showFullRoot ? 'Shorten' : 'Show full'}
              </button>
              <button
                type="button"
                onClick={() => void onCopy()}
                className="rounded border border-slate-300 px-2 py-0.5 text-xs font-medium hover:bg-slate-100"
              >
                {copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? 'Copy failed' : 'Copy full'}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Ledger anchor reference</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{result.ledgerAnchorRef}</dd>
          </div>
        </dl>

        <div className="flex flex-col items-center gap-3">
          <QrCodeCard qrImage={result.qrImage} qrPayload={result.qrPayload} caption="Give to the patient — scanned at the pharmacy." />
          <DownloadPrescriptionButton prescriptionId={result.prescriptionId} versionNumber={result.versionNumber} />
        </div>
      </div>

      <div className="flex flex-wrap gap-3 border-t border-slate-100 px-6 py-4">
        {onAmend && (
          <button
            type="button"
            onClick={() => onAmend(result.prescriptionId)}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Amend this prescription
          </button>
        )}
        <button
          type="button"
          onClick={onCreateAnother}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
        >
          Create another prescription
        </button>
      </div>
    </section>
  );
}
