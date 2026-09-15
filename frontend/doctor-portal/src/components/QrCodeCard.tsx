import type { QrPayload } from '../types';

/**
 * Renders the QR returned by the API. The image encodes ONLY { prescriptionId, versionNumber, issuedAt };
 * the pharmacy looks everything else up server-side and verifies it there.
 */
export default function QrCodeCard({
  qrImage,
  qrPayload,
  caption,
}: {
  qrImage: string | null;
  qrPayload: QrPayload | null;
  caption: string;
}) {
  if (!qrImage || !qrPayload) {
    return (
      <div role="note" className="flex h-44 w-44 flex-col items-center justify-center rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 p-3 text-center text-xs text-amber-900">
        <span className="font-semibold">QR code unavailable</span>
        <span className="mt-1">The version was saved and anchored, but its QR could not be generated.</span>
      </div>
    );
  }

  return (
    <figure className="flex w-48 flex-col items-center gap-2">
      <img
        src={qrImage}
        alt={`QR code referencing ${qrPayload.prescriptionId} version ${qrPayload.versionNumber}`}
        width={176}
        height={176}
        data-testid="prescription-qr"
        className="h-44 w-44 rounded-lg border border-slate-200 bg-white p-1 [image-rendering:pixelated]"
      />
      <figcaption className="text-center text-[11px] leading-snug text-slate-500">{caption}</figcaption>
      <details className="w-full text-[11px] text-slate-500">
        <summary className="cursor-pointer text-center font-medium text-teal-700">What's inside this QR?</summary>
        <pre data-testid="qr-payload" className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 font-mono text-[10px] text-slate-700">
{JSON.stringify(qrPayload, null, 2)}
        </pre>
        <p className="mt-1">A reference only — no drug, dose or patient data.</p>
      </details>
    </figure>
  );
}
