import { useState } from 'react';
import { Download } from 'lucide-react';
import { getPrescriptionDocument, type ApiError } from '../api';
import ErrorNotice, { toApiError } from './ErrorNotice';

/**
 * Fetches the document data for ONE exact version and renders the one-page PDF client-side.
 * The PDF code (jsPDF + layout) is loaded on first click via dynamic import, so the rest of the app doesn't carry it.
 */
export default function DownloadPrescriptionButton({ prescriptionId, versionNumber }: { prescriptionId: string; versionNumber: number }) {
  const [state, setState] = useState<{ status: 'idle' } | { status: 'loading' } | { status: 'error'; error: ApiError }>({ status: 'idle' });
  const loading = state.status === 'loading';

  const onDownload = async () => {
    setState({ status: 'loading' });
    try {
      const [documentData, { generatePrescriptionPdf }] = await Promise.all([
        getPrescriptionDocument(prescriptionId, versionNumber),
        import('../generatePrescriptionPdf'),
      ]);
      generatePrescriptionPdf(documentData);
      setState({ status: 'idle' });
    } catch (err) {
      setState({ status: 'error', error: toApiError(err) });
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void onDownload()}
        disabled={loading}
        aria-busy={loading}
        data-testid="download-prescription"
        className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-teal-700 bg-white px-4 py-2 text-sm font-semibold text-teal-800 shadow-sm hover:bg-teal-50 disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-teal-600"
      >
        {loading ? (
          <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-teal-700/30 border-t-teal-700" />
        ) : (
          <Download aria-hidden className="h-4 w-4" />
        )}
        {loading ? 'Preparing PDF…' : 'Download Prescription'}
      </button>
      {state.status === 'error' && <ErrorNotice title="Couldn't prepare the prescription PDF" error={state.error} />}
    </div>
  );
}
