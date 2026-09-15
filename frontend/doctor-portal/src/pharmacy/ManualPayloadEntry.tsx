import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ClipboardPaste } from 'lucide-react';

/**
 * Manual QR payload entry — a first-class path for bad lighting, projector glare or focus problems.
 * Sends exactly what was pasted to the same submitScan as the camera; the server decides what it is.
 */
export default function ManualPayloadEntry({ disabled, onSubmit }: { disabled: boolean; onSubmit: (raw: string) => void }) {
  const id = useId();
  const [value, setValue] = useState('');
  const canSubmit = !disabled && value.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSubmit) onSubmit(value); // raw, untrimmed — garbage still goes to the server and comes back malformed_qr
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <ClipboardPaste aria-hidden className="h-5 w-5 text-teal-700" />
        <h2 id={`${id}-title`} className="font-semibold">
          Paste QR payload
        </h2>
      </div>
      <p className="mt-1 text-sm text-slate-600">Use when the camera can’t read the code. Paste the exact text encoded in the QR.</p>

      <form onSubmit={submit} className="mt-4 flex flex-1 flex-col">
        <label htmlFor={`${id}-payload`} className="sr-only">
          QR payload
        </label>
        <textarea
          id={`${id}-payload`}
          data-testid="manual-payload"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          rows={7}
          placeholder={'{"prescriptionId":"RX-DEMO-0001","versionNumber":2,"issuedAt":"2026-09-14T16:27:53.696Z"}'}
          className="min-h-40 w-full flex-1 resize-y rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-60"
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            <kbd className="rounded border border-slate-300 px-1 font-mono">⌘/Ctrl</kbd> + <kbd className="rounded border border-slate-300 px-1 font-mono">Enter</kbd> to verify
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setValue('')} disabled={disabled || value === ''} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50">
              Clear
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="manual-submit"
              className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Verify payload
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
