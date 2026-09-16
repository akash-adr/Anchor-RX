import type { DrugReference, DrugReferenceEntry } from './types';

/**
 * Medicine autofill helpers. The table itself is NEVER defined in the frontend: it is fetched once per page load from
 * GET /api/drug-reference (Node relays Python's DRUG_REFERENCE unchanged).
 */

/** Exact match only (trimmed, case-sensitive) — the datalist always yields the exact reference name. */
export function findReferenceEntry(reference: DrugReference | null, drugName: string): DrugReferenceEntry | null {
  if (!reference) return null;
  const name = drugName.trim();
  return Object.prototype.hasOwnProperty.call(reference, name) ? reference[name] : null;
}

const FREQUENCY_TEXT: Record<number, string> = { 1: 'once daily', 2: 'twice daily', 3: 'three times daily', 4: 'four times daily' };

/** freq_min (doses per day) → the free-text format the frequency field and the AI service's parser expect. */
export function frequencyText(timesPerDay: number): string {
  return FREQUENCY_TEXT[timesPerDay] ?? `${timesPerDay} times daily`;
}

/** Autofill defaults for a matched drug: starting dose (dose_min, not the max), exact unit, freq_min, dur_min, class. */
export function autofillFrom(entry: DrugReferenceEntry) {
  return {
    dosageValue: String(entry.dose_min),
    dosageUnit: entry.dosage_unit,
    frequency: frequencyText(entry.freq_min),
    durationDays: String(entry.dur_min),
    drugClass: entry.drug_class,
  };
}
