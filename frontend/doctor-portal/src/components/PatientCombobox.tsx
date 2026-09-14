import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Patient } from '../types';

interface Props {
  patients: Patient[];
  value: string; // selected patientId, '' when none
  onChange: (patientId: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}

/** Searchable patient select: type to filter by name or ID, pick with mouse or arrow keys + Enter. */
export default function PatientCombobox({ patients, value, onChange, disabled, invalid }: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = patients.find((p) => p.patientId === value) ?? null;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) => p.name.toLowerCase().includes(q) || p.patientId.toLowerCase().includes(q));
  }, [patients, query]);

  const choose = (patient: Patient) => {
    onChange(patient.patientId);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && open && matches[activeIndex]) {
      event.preventDefault();
      choose(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  if (selected && !open) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2">
        <span>
          <span className="font-medium">{selected.name}</span>
          <span className="ml-2 font-mono text-xs text-slate-500">{selected.patientId}</span>
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange('');
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="text-sm font-medium text-teal-700 hover:underline disabled:opacity-50"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id="patient"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-activedescendant={open && matches[activeIndex] ? `${listId}-${matches[activeIndex].patientId}` : undefined}
        autoComplete="off"
        placeholder="Search by name or patient ID…"
        disabled={disabled}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className={`w-full rounded-md border bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-teal-600 ${invalid ? 'border-red-400' : 'border-slate-300'}`}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {matches.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No patients match “{query}”</li>}
          {matches.map((p, index) => (
            <li
              key={p.patientId}
              id={`${listId}-${p.patientId}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${index === activeIndex ? 'bg-teal-50' : ''}`}
            >
              <span className="font-medium">{p.name}</span>
              <span className="font-mono text-xs text-slate-500">{p.patientId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
