import type { AmendResult } from '../types';
import ChangeList from './ChangeList';

/** "What changed" card, rendered straight from the diff the API returned (display only, not verification). */
export default function ChangeSummary({ result }: { result: AmendResult }) {
  const { diff } = result;
  return (
    <section aria-labelledby="change-summary-title" role="status" className="rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 rounded-t-2xl border-b border-emerald-100 bg-emerald-50 px-5 py-3">
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-sm text-white">
          ✓
        </span>
        <div>
          <h2 id="change-summary-title" className="font-semibold text-emerald-900">
            Amendment recorded as v{result.versionNumber}
          </h2>
          <p className="text-xs text-emerald-800">
            v{diff.fromVersion} → v{diff.toVersion}
            {'amendedBy' in diff && diff.amendedBy ? ` · amended by ${diff.amendedBy}` : ''} · new version hashed and anchored
          </p>
        </div>
      </div>
      {diff.changedFields.length === 0 ? (
        <p className="px-5 py-3 text-sm text-slate-600">No field-level changes in this version.</p>
      ) : (
        <ChangeList changes={diff.changedFields} />
      )}
    </section>
  );
}
