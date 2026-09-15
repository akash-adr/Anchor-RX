import type { ChangedField } from '../types';

const FIELD_LABELS: Record<string, string> = {
  dosageValue: 'Dosage value',
  dosageUnit: 'Dosage unit',
  frequency: 'Frequency',
  durationDays: 'Duration (days)',
  quantityPrescribed: 'Quantity prescribed',
};

function formatValue(entry: ChangedField, side: 'old' | 'new') {
  const value = String(entry[side]);
  if (entry.field !== 'dosageValue') return value;
  const unit = side === 'old' ? (entry.oldUnit ?? entry.unit) : entry.unit;
  return unit ? `${value} ${unit}` : value;
}

/** Field-by-field "old → new" rows from an API diff, labelled with the medicine they belong to. Display only. */
export default function ChangeList({ changes, compact = false }: { changes: ChangedField[]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100" data-testid="change-list">
      {changes.map((entry, index) => (
        <li key={`${entry.medicine ?? 0}-${entry.field}-${index}`} className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm ${compact ? 'py-2' : 'px-5 py-3'}`}>
          <span className="flex w-40 shrink-0 flex-col font-medium leading-tight text-slate-700">
            {entry.medicine !== undefined && (
              <span className="text-[11px] font-semibold uppercase tracking-wide text-teal-800">
                Medicine {entry.medicine}
                {entry.drugName ? ` · ${entry.drugName}` : ''}
              </span>
            )}
            {FIELD_LABELS[entry.field] ?? entry.field}
            <code className="font-mono text-[11px] font-normal text-slate-400">{entry.field}</code>
          </span>
          <span className="font-mono">
            <span className="text-slate-500 line-through decoration-slate-300">{formatValue(entry, 'old')}</span>
            <span aria-label="changed to" className="mx-2 text-slate-400">
              →
            </span>
            <span className="font-semibold text-slate-900">{formatValue(entry, 'new')}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
