import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, createPrescription, getPatients } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import type { CreatedPrescription, Patient } from '../types';
import ConfirmationCard from './ConfirmationCard';
import ErrorNotice, { toApiError } from './ErrorNotice';
import { DosageUnitInput, Field, TextInput, inputClass } from './formControls';
import PatientCombobox from './PatientCombobox';

// Mirror the backend's DECIMAL rules for early feedback; the API remains the authority.
const DOSAGE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/; // DECIMAL(12,3)
const HEIGHT_PATTERN = /^\d{1,4}(\.\d)?$/; // DECIMAL(5,1) cm
const WEIGHT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/; // DECIMAL(5,2) kg
const isZero = (value: string) => /^0+(\.0+)?$/.test(value);

interface MedicineForm {
  key: number; // stable React key only — never sent; order on screen is what becomes sequence_number
  drugName: string;
  drugClass: string;
  dosageValue: string; // kept as the exact typed string — never parsed to a float
  dosageUnit: string;
  frequency: string;
  durationDays: string;
  quantityPrescribed: string;
}

type MedicineField = Exclude<keyof MedicineForm, 'key'>;

interface FormState {
  patientId: string;
  // Optional (nullable in the schema). Sent as the exact typed string when filled, omitted when blank.
  heightCm: string;
  weightKg: string;
  medicines: MedicineForm[];
}

const emptyMedicine = (key: number): MedicineForm => ({
  key,
  drugName: '',
  drugClass: '',
  dosageValue: '',
  dosageUnit: 'mg',
  frequency: '',
  durationDays: '',
  quantityPrescribed: '',
});

const emptyForm = (key: number): FormState => ({ patientId: '', heightCm: '', weightKg: '', medicines: [emptyMedicine(key)] });

type TopErrors = Partial<Record<'patientId' | 'heightCm' | 'weightKg', string>>;
type MedicineErrors = Partial<Record<MedicineField, string>>;
interface FieldErrors {
  top: TopErrors;
  medicines: Record<number, MedicineErrors>; // by MedicineForm.key
}

const NO_ERRORS: FieldErrors = { top: {}, medicines: {} };

function validateMedicine(medicine: MedicineForm): MedicineErrors {
  const errors: MedicineErrors = {};
  if (!medicine.drugName.trim()) errors.drugName = 'Required';
  if (!medicine.drugClass.trim()) errors.drugClass = 'Required';
  const dose = medicine.dosageValue.trim();
  if (!dose) errors.dosageValue = 'Required';
  else if (!DOSAGE_PATTERN.test(dose) || isZero(dose)) errors.dosageValue = 'Positive number, up to 3 decimals';
  if (!medicine.dosageUnit.trim()) errors.dosageUnit = 'Enter a unit';
  if (!medicine.frequency.trim()) errors.frequency = 'Required';
  if (!/^\d+$/.test(medicine.durationDays.trim()) || Number(medicine.durationDays) < 1) errors.durationDays = 'Whole number of days, at least 1';
  if (!/^\d+$/.test(medicine.quantityPrescribed.trim()) || Number(medicine.quantityPrescribed) < 1) errors.quantityPrescribed = 'Whole number, at least 1';
  return errors;
}

function validate(form: FormState): FieldErrors {
  const top: TopErrors = {};
  if (!form.patientId) top.patientId = 'Select a patient';
  const height = form.heightCm.trim();
  if (height && (!HEIGHT_PATTERN.test(height) || isZero(height))) top.heightCm = 'Positive number of cm, up to 1 decimal';
  const weight = form.weightKg.trim();
  if (weight && (!WEIGHT_PATTERN.test(weight) || isZero(weight))) top.weightKg = 'Positive number of kg, up to 2 decimals';

  const medicines: Record<number, MedicineErrors> = {};
  for (const medicine of form.medicines) {
    const errors = validateMedicine(medicine);
    if (Object.keys(errors).length > 0) medicines[medicine.key] = errors;
  }
  return { top, medicines };
}

const hasErrors = (errors: FieldErrors) => Object.keys(errors.top).length > 0 || Object.keys(errors.medicines).length > 0;

type PatientsState = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; patients: Patient[] };

export default function CreatePrescription({ onAmend }: { onAmend?: (prescriptionId: string) => void }) {
  const provider = useCurrentProvider();
  const nextKey = useRef(1);
  const [patients, setPatients] = useState<PatientsState>({ status: 'loading' });
  const [form, setForm] = useState<FormState>(() => emptyForm(0));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_ERRORS);
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

  const updateTop = (key: 'patientId' | 'heightCm' | 'weightKg', value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, top: { ...prev.top, [key]: undefined } }));
  };

  const updateMedicine = (medicineKey: number, field: MedicineField, value: string) => {
    setForm((prev) => ({ ...prev, medicines: prev.medicines.map((m) => (m.key === medicineKey ? { ...m, [field]: value } : m)) }));
    setFieldErrors((prev) => ({ ...prev, medicines: { ...prev.medicines, [medicineKey]: { ...prev.medicines[medicineKey], [field]: undefined } } }));
  };

  const addMedicine = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setForm((prev) => ({ ...prev, medicines: [...prev.medicines, emptyMedicine(key)] }));
    // Move focus to the new block's first field so keyboard users land where they need to type.
    requestAnimationFrame(() => document.getElementById(`drugName-${key}`)?.focus());
  };

  const removeMedicine = (medicineKey: number) => {
    setForm((prev) => ({ ...prev, medicines: prev.medicines.filter((m) => m.key !== medicineKey) }));
    setFieldErrors((prev) => {
      const medicines = { ...prev.medicines };
      delete medicines[medicineKey];
      return { ...prev, medicines };
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validate(form);
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const height = form.heightCm.trim();
      const weight = form.weightKg.trim();
      const created = await createPrescription({
        patientId: form.patientId,
        providerId: provider.providerId, // from the (mock) signed-in provider, never typed by the user
        ...(height ? { heightCm: height } : {}),
        ...(weight ? { weightKg: weight } : {}),
        // In the order the blocks appear on screen: this order becomes each medicine's sequence_number.
        medicines: form.medicines.map((m) => ({
          drugName: m.drugName.trim(),
          drugClass: m.drugClass.trim(),
          dosageValue: m.dosageValue.trim(),
          dosageUnit: m.dosageUnit.trim(),
          frequency: m.frequency.trim(),
          durationDays: Number(m.durationDays),
          quantityPrescribed: Number(m.quantityPrescribed),
        })),
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
          setForm(emptyForm(nextKey.current++));
          setFieldErrors(NO_ERRORS);
        }}
      />
    );
  }

  const medicineCount = form.medicines.length;

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
        <Field label="Patient" htmlFor="patient" error={fieldErrors.top.patientId}>
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
              onChange={(id) => updateTop('patientId', id)}
              disabled={submitting}
              invalid={Boolean(fieldErrors.top.patientId)}
            />
          )}
        </Field>

        {/* Patient vitals: shared by the whole prescription, optional (nullable in the schema). */}
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Height (cm)" htmlFor="heightCm" error={fieldErrors.top.heightCm} hint="Optional">
            <input
              id="heightCm"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.1"
              value={form.heightCm}
              onChange={(e) => updateTop('heightCm', e.target.value)}
              placeholder="e.g. 172.5"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.top.heightCm) || undefined}
              className={inputClass(Boolean(fieldErrors.top.heightCm))}
            />
          </Field>
          <Field label="Weight (kg)" htmlFor="weightKg" error={fieldErrors.top.weightKg} hint="Optional">
            <input
              id="weightKg"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.weightKg}
              onChange={(e) => updateTop('weightKg', e.target.value)}
              placeholder="e.g. 68.4"
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.top.weightKg) || undefined}
              className={inputClass(Boolean(fieldErrors.top.weightKg))}
            />
          </Field>
        </div>

        {form.medicines.map((medicine, index) => {
          const errors = fieldErrors.medicines[medicine.key] ?? {};
          const id = (field: MedicineField) => `${field}-${medicine.key}`;
          const position = index + 1;
          return (
            <fieldset key={medicine.key} data-testid={`medicine-block-${position}`} className={`space-y-6 ${index > 0 ? 'border-t border-slate-100 pt-6' : ''}`}>
              <legend className={medicineCount > 1 ? 'contents' : 'sr-only'}>
                <span className="flex w-full items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800">Medicine {position}</span>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => removeMedicine(medicine.key)}
                      disabled={submitting}
                      aria-label={`Remove medicine ${position}`}
                      className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </span>
              </legend>

              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Drug name" htmlFor={id('drugName')} error={errors.drugName}>
                  <TextInput id={id('drugName')} value={medicine.drugName} onChange={(v) => updateMedicine(medicine.key, 'drugName', v)} placeholder="e.g. Amoxicillin" disabled={submitting} invalid={Boolean(errors.drugName)} />
                </Field>
                <Field label="Drug class" htmlFor={id('drugClass')} error={errors.drugClass}>
                  <TextInput id={id('drugClass')} value={medicine.drugClass} onChange={(v) => updateMedicine(medicine.key, 'drugClass', v)} placeholder="e.g. penicillin antibiotic" disabled={submitting} invalid={Boolean(errors.drugClass)} />
                </Field>
              </div>

              {/* Dose value and unit are deliberately TWO separate fields (Module 1/2 schema), never one text box. */}
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Dosage value" htmlFor={id('dosageValue')} error={errors.dosageValue}>
                  <input
                    id={id('dosageValue')}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={medicine.dosageValue}
                    onChange={(e) => updateMedicine(medicine.key, 'dosageValue', e.target.value)}
                    placeholder="e.g. 500"
                    disabled={submitting}
                    aria-invalid={Boolean(errors.dosageValue) || undefined}
                    className={inputClass(Boolean(errors.dosageValue))}
                  />
                </Field>
                <Field label="Dosage unit" htmlFor={id('dosageUnit')} error={errors.dosageUnit}>
                  <DosageUnitInput id={id('dosageUnit')} value={medicine.dosageUnit} onChange={(v) => updateMedicine(medicine.key, 'dosageUnit', v)} disabled={submitting} invalid={Boolean(errors.dosageUnit)} />
                </Field>
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Frequency" htmlFor={id('frequency')} error={errors.frequency}>
                  <TextInput id={id('frequency')} value={medicine.frequency} onChange={(v) => updateMedicine(medicine.key, 'frequency', v)} placeholder="e.g. twice daily" disabled={submitting} invalid={Boolean(errors.frequency)} />
                </Field>
                {/* Duration is stored as a plain day count — there is no separate duration unit in the schema. */}
                <Field label="Duration (days)" htmlFor={id('durationDays')} error={errors.durationDays}>
                  <input
                    id={id('durationDays')}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={medicine.durationDays}
                    onChange={(e) => updateMedicine(medicine.key, 'durationDays', e.target.value)}
                    placeholder="e.g. 7"
                    disabled={submitting}
                    aria-invalid={Boolean(errors.durationDays) || undefined}
                    className={inputClass(Boolean(errors.durationDays))}
                  />
                </Field>
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Quantity prescribed" htmlFor={id('quantityPrescribed')} error={errors.quantityPrescribed}>
                  <input
                    id={id('quantityPrescribed')}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={medicine.quantityPrescribed}
                    onChange={(e) => updateMedicine(medicine.key, 'quantityPrescribed', e.target.value)}
                    placeholder="e.g. 21"
                    disabled={submitting}
                    aria-invalid={Boolean(errors.quantityPrescribed) || undefined}
                    className={inputClass(Boolean(errors.quantityPrescribed))}
                  />
                </Field>
              </div>
            </fieldset>
          );
        })}

        <div>
          <button
            type="button"
            onClick={addMedicine}
            disabled={submitting}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            + Add medicine
          </button>
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
