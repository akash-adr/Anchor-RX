import type { ReactNode } from 'react';

export const DOSAGE_UNITS = ['mg', 'mcg', 'g', 'ml', 'IU', 'tablet', 'capsule'] as const;
const OTHER_UNIT = '__other__';

// Exactly one width class per field: combining w-full with another width lets w-full win in the generated CSS.
export function inputClass(invalid: boolean, width = 'w-full') {
  return `${width} rounded-md border bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100 disabled:text-slate-500 ${invalid ? 'border-red-400' : 'border-slate-300'}`;
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function TextInput(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      id={props.id}
      type="text"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-invalid={props.invalid || undefined}
      className={inputClass(Boolean(props.invalid))}
    />
  );
}

/**
 * Dose unit as its own field (never merged with the dose value): common units in a select, plus
 * "Other…" for free text. The selected option is derived from `value`, so a loaded unit that is not
 * in the list (e.g. "puff") shows as Other with its text filled in.
 */
export function DosageUnitInput({
  id,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (unit: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const isListed = (DOSAGE_UNITS as readonly string[]).includes(value);
  const choice = isListed ? value : OTHER_UNIT;

  return (
    <div className="flex gap-2">
      <select
        id={id}
        value={choice}
        onChange={(e) => onChange(e.target.value === OTHER_UNIT ? '' : e.target.value)}
        disabled={disabled}
        className={inputClass(false, choice === OTHER_UNIT ? 'w-32 shrink-0' : 'w-full')}
      >
        {DOSAGE_UNITS.map((unit) => (
          <option key={unit} value={unit}>
            {unit}
          </option>
        ))}
        <option value={OTHER_UNIT}>Other…</option>
      </select>
      {choice === OTHER_UNIT && (
        <input
          aria-label="Custom dosage unit"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="unit"
          maxLength={16}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={inputClass(Boolean(invalid), 'min-w-0 flex-1')}
        />
      )}
    </div>
  );
}

/** Read-only display of a field that cannot be amended (rendered as a disabled input). */
export function LockedInput({ id, value, hint }: { id: string; value: string; hint: string }) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      readOnly
      disabled
      title={hint}
      aria-describedby={`${id}-hint`}
      className={`${inputClass(false)} cursor-not-allowed`}
    />
  );
}
