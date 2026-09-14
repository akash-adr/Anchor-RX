import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, createPrescription, getPatients } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import type { CreatedPrescription, Patient } from '../types';
import ConfirmationCard from './ConfirmationCard';
import ErrorNotice, { toApiError } from './ErrorNotice';
import { DosageUnitInput, Field, TextInput, inputClass } from './formControls';
import PatientCombobox from './PatientCombobox';

// Mirrors the backend's DECIMAL(12,3) rule for early feedback; the API remains the authority.
const DOSAGE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;

interface FormState {
  patientId: string;
  drugName: string;
  dosageValue: string; // kept as the exact typed string — never parsed to a float
  dosageUnit: string;
  frequency: string;
  durationDays: string;
  drugClass: string;
}

const EMPTY_FORM: FormState = {
  patientId: '',
  drugName: '',
  dosageValue: '',
  dosageUnit: 'mg',
  frequency: '',
  durationDays: '',
  drugClass: '',
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.patientId) errors.patientId = 'Select a patient';
  if (!form.drugName.trim()) errors.drugName = 'Required';
  const dose = form.dosageValue.trim();
  if (!dose) errors.dosageValue = 'Required';
  else if (!DOSAGE_PATTERN.test(dose) || /^0+(\.0+)?$/.test(dose)) errors.dosageValue = 'Positive number, up to 3 decimals';
  if (!form.dosageUnit.trim()) errors.dosageUnit = 'Enter a unit';
  if (!form.frequency.trim()) errors.frequency = 'Required';
  if (!/^\d+$/.test(form.durationDays.trim()) || Number(form.durationDays) < 1) errors.durationDays = 'Whole number of days, at least 1';
  if (!form.drugClass.trim()) errors.drugClass = 'Required';
  return errors;
}

type PatientsState = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; patients: Patient[] };

export default function CreatePrescription({ onAmend }: { onAmend?: (prescriptionId: string) => void }) {
  const provider = useCurrentProvider();
  const [patients, setPatients] = useState<PatientsState>({ status: 'loading' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CreatedPrescription | null>(null);

  const loadPatients = useCallback(async () => {
    setPatients({ status: 'loading' });
    try {
      setPatients({ status: 'ready', patients: await getPatients() });
    } catch (err) {
      setPatients({ status: 'error', error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createPrescription({
        patientId: form.patientId,
        providerId: provider.providerId, // from the (mock) signed-in provider, never typed by the user
        drugName: form.drugName.trim(),
        dosageValue: form.dosageValue.trim(),
        dosageUnit: form.dosageUnit.trim(),
        frequency: form.frequency.trim(),
        durationDays: Number(form.durationDays),
        drugClass: form.drugClass.trim(),
      });
      setResult(created);
    } catch (err) {
      setSubmitError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <ConfirmationCard
        result={result}
        onAmend={onAmend}
        onCreateAnother={() => {
          setResult(null);
          setForm(EMPTY_FORM);
          setFieldErrors({});
        }}
      />
    );
  }

  return (
    <section aria-labelledby="create-title">
      <h1 id="create-title" className="text-2xl font-semibold tracking-tight">
        New prescription
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Issued by <span className="font-medium text-slate-800">{provider.name}</span>. On authorization every field is hashed and
        the integrity root is anchored to the ledger.
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <Field label="Patient" htmlFor="patient" error={fieldErrors.patientId}>
          {patients.status === 'loading' && <div className="h-10 animate-pulse rounded-md bg-slate-100" aria-label="Loading patients" />}
          {patients.status === 'error' && (
            <div className="space-y-2">
              <ErrorNotice title="Couldn't load patients — the form can't be submitted until they load" error={patients.error} />
              <button
                type="button"
                onClick={() => void loadPatients()}
                className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800"
              >
                Retry loading patients
              </button>
            </div>
          )}
          {patients.status === 'ready' && (
            <PatientCombobox
              patients={patients.patients}
              value={form.patientId}
              onChange={(id) => update('patientId', id)}
              disabled={submitting}
              invalid={Boolean(fieldErrors.patientId)}
            />
          )}
        </Field>

        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Drug name" htmlFor="drugName" error={fieldErrors.drugName}>
            <TextInput id="drugName" value={form.drugName} onChange={(v) => update('drugName', v)} placeholder="e.g. Amoxicillin" disabled={submitting} invalid={Boolean(fieldErrors.drugName)} />
          </Field>
          <Field label="Drug class" htmlFor="drugClass" error={fieldErrors.drugClass}>
            <TextInput id="drugClass" value={form.drugClass} onChange={(v) => update('drugClass', v)} placeholder="e.g. penicillin antibiotic" disabled={submitting} invalid={Boolean(fieldErrors.drugClass)} />
          </Field>
        </div>

        {/* Dose value and unit are deliberately TWO separate fields (Module 1/2 schema), never one text box. */}
        <fieldset className="grid gap-6 sm:grid-cols-2">
          <legend className="sr-only">Dose</legend>
          <Field label="Dosage value" htmlFor="dosageValue" error={fieldErrors.dosageValue}>
            <input
              id="dosageValue"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={form.dosageValue}
              onChange={(e) => update('dosageValue', e.target.value)}
              placeholder="e.g. 500"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.dosageValue) || undefined}
              className={inputClass(Boolean(fieldErrors.dosageValue))}
            />
          </Field>
          <Field label="Dosage unit" htmlFor="dosageUnit" error={fieldErrors.dosageUnit}>
            <DosageUnitInput id="dosageUnit" value={form.dosageUnit} onChange={(v) => update('dosageUnit', v)} disabled={submitting} invalid={Boolean(fieldErrors.dosageUnit)} />
          </Field>
        </fieldset>

        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Frequency" htmlFor="frequency" error={fieldErrors.frequency}>
            <TextInput id="frequency" value={form.frequency} onChange={(v) => update('frequency', v)} placeholder="e.g. twice daily" disabled={submitting} invalid={Boolean(fieldErrors.frequency)} />
          </Field>
          {/* Duration is stored as a plain day count — there is no separate duration unit in the schema. */}
          <Field label="Duration (days)" htmlFor="durationDays" error={fieldErrors.durationDays}>
            <input
              id="durationDays"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={form.durationDays}
              onChange={(e) => update('durationDays', e.target.value)}
              placeholder="e.g. 7"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.durationDays) || undefined}
              className={inputClass(Boolean(fieldErrors.durationDays))}
            />
          </Field>
        </div>

        {submitError && <ErrorNotice title="Prescription was not created" error={submitError} />}

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-5">
          <button
            type="submit"
            disabled={submitting || patients.status !== 'ready'}
            className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {submitting ? 'Authorizing & anchoring…' : 'Authorize & anchor'}
          </button>
        </div>
      </form>
    </section>
  );
}
