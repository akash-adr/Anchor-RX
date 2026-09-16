import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, assessPrescriptionRisk, confirmAndCreatePrescription, getDrugReference, getPatients } from '../api';
import { useCurrentProvider } from '../context/ProviderContext';
import { autofillFrom, findReferenceEntry } from '../drugReference';
import type { CreatedPrescription, DrugReference, NewPrescription, Patient, RiskPreview } from '../types';
import ConfirmationCard from './ConfirmationCard';
import ErrorNotice, { toApiError } from './ErrorNotice';
import { DosageUnitInput, Field, TextInput, inputClass } from './formControls';
import PatientCombobox from './PatientCombobox';
import RiskConfirmation from './RiskConfirmation';

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
  // UI state only — never sent. The reference drug name this block was autofilled from; while set, drugClass is
  // read-only (it came from the reference, protecting the exact-string duplication check from typos).
  matchedDrug: string | null;
}

type MedicineField = Exclude<keyof MedicineForm, 'key' | 'matchedDrug'>;
const AUTOFILLED_FIELDS = ['dosageValue', 'dosageUnit', 'frequency', 'durationDays', 'drugClass'] as const;

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
  matchedDrug: null,
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
  // Module 15: the risk preview being reviewed (nothing saved yet) and the exact submission it scored. The form state
  // above is never touched by the review, so "Go back and edit" returns to everything the doctor entered.
  const [review, setReview] = useState<{ preview: RiskPreview; submission: NewPrescription } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<ApiError | null>(null);
  const previewRequest = useRef(0); // a preview response that arrives after the doctor has moved on is ignored
  // Autofill source, loaded once. null (still loading, or unavailable) = fully manual entry, exactly as before.
  const [drugReference, setDrugReference] = useState<DrugReference | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDrugReference()
      .then((reference) => {
        if (!cancelled) setDrugReference(reference);
      })
      .catch(() => {
        /* reference unavailable: the form simply stays manual */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /**
   * Drug name changes re-evaluate the reference match fresh every time. On becoming a match for a (different) known
   * drug, the block's dose, unit, frequency, duration and class are filled from the reference; all but class stay
   * editable. Staying on the same match never overwrites the doctor's edits. No match → the lock is released and
   * nothing is filled: fully manual, as before.
   */
  const updateDrugName = (medicineKey: number, value: string) => {
    const entry = findReferenceEntry(drugReference, value);
    const matchedName = entry ? value.trim() : null;
    setForm((prev) => ({
      ...prev,
      medicines: prev.medicines.map((m) => {
        if (m.key !== medicineKey) return m;
        if (entry && m.matchedDrug !== matchedName) return { ...m, drugName: value, ...autofillFrom(entry), matchedDrug: matchedName };
        return { ...m, drugName: value, matchedDrug: matchedName };
      }),
    }));
    setFieldErrors((prev) => {
      const cleared: MedicineErrors = { ...prev.medicines[medicineKey], drugName: undefined };
      if (entry) for (const field of AUTOFILLED_FIELDS) cleared[field] = undefined;
      return { ...prev, medicines: { ...prev.medicines, [medicineKey]: cleared } };
    });
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

  /** Exactly what gets scored — and, through the server's cached copy, saved. On-screen order = sequence_number. */
  const buildSubmission = (): NewPrescription => {
    const height = form.heightCm.trim();
    const weight = form.weightKg.trim();
    return {
      patientId: form.patientId,
      providerId: provider.providerId, // from the (mock) signed-in provider, never typed by the user
      ...(height ? { heightCm: height } : {}),
      ...(weight ? { weightKg: weight } : {}),
      medicines: form.medicines.map((m) => ({
        drugName: m.drugName.trim(),
        drugClass: m.drugClass.trim(),
        dosageValue: m.dosageValue.trim(),
        dosageUnit: m.dosageUnit.trim(),
        frequency: m.frequency.trim(),
        durationDays: Number(m.durationDays),
        quantityPrescribed: Number(m.quantityPrescribed),
      })),
    };
  };

  /** Always a FRESH assess-risk call from the current form: nothing from a discarded or expired preview carries over. */
  const runPreview = async (onError: (error: ApiError) => void) => {
    const requestId = ++previewRequest.current;
    const submission = buildSubmission();
    setSubmitting(true);
    try {
      const preview = await assessPrescriptionRisk(submission); // scores every medicine; saves nothing
      if (requestId !== previewRequest.current) return;
      setConfirmError(null);
      setReview({ preview, submission });
    } catch (err) {
      if (requestId === previewRequest.current) onError(toApiError(err));
    } finally {
      if (requestId === previewRequest.current) setSubmitting(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validate(form);
    setFieldErrors(errors);
    if (hasErrors(errors)) return;
    setSubmitError(null);
    await runPreview(setSubmitError);
  };

  const onConfirm = async () => {
    if (!review) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      // The token ONLY — the server creates the prescription from its cached copy, with exactly the risk shown here.
      const created = await confirmAndCreatePrescription(review.preview.previewToken);
      setResult(created);
      setReview(null);
      setForm(emptyForm(nextKey.current++));
      setFieldErrors(NO_ERRORS);
    } catch (err) {
      setConfirmError(toApiError(err));
    } finally {
      setConfirming(false);
    }
  };

  const backToEdit = () => {
    previewRequest.current += 1;
    setReview(null); // the preview and its token are discarded; the server's copy simply expires
    setConfirmError(null);
    setSubmitError(null);
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

  if (review) {
    const patientName = patients.status === 'ready' ? patients.patients.find((p) => p.patientId === review.submission.patientId)?.name : undefined;
    return (
      <RiskConfirmation
        preview={review.preview}
        submittedMedicines={review.submission.medicines}
        patientLabel={patientName ? `${patientName} (${review.submission.patientId})` : review.submission.patientId}
        confirming={confirming}
        rechecking={submitting}
        error={confirmError}
        onConfirm={() => void onConfirm()}
        onBack={backToEdit}
        onRecheck={() => void runPreview(setConfirmError)}
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
        the integrity root is anchored to the ledger. You'll review the AI risk for every medicine before anything is saved.
      </p>

      {drugReference && (
        <datalist id="drug-reference-names">
          {Object.keys(drugReference)
            .sort()
            .map((name) => (
              <option key={name} value={name} />
            ))}
        </datalist>
      )}

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
                <Field
                  label="Drug name"
                  htmlFor={id('drugName')}
                  error={errors.drugName}
                  hint={drugReference ? 'Pick a known drug to autofill, or type any other name' : undefined}
                >
                  <TextInput
                    id={id('drugName')}
                    value={medicine.drugName}
                    onChange={(v) => updateDrugName(medicine.key, v)}
                    placeholder="e.g. Amoxicillin"
                    disabled={submitting}
                    invalid={Boolean(errors.drugName)}
                    list={drugReference ? 'drug-reference-names' : undefined}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Drug class"
                  htmlFor={id('drugClass')}
                  error={errors.drugClass}
                  hint={medicine.matchedDrug ? `Set from the drug reference for ${medicine.matchedDrug} — change the drug name to edit` : undefined}
                >
                  {medicine.matchedDrug ? (
                    <input
                      id={id('drugClass')}
                      type="text"
                      value={medicine.drugClass}
                      readOnly
                      data-testid={`drug-class-locked-${position}`}
                      aria-describedby={`${id('drugClass')}-hint`}
                      className={`${inputClass(false)} cursor-not-allowed bg-slate-100 text-slate-700`}
                    />
                  ) : (
                    <TextInput id={id('drugClass')} value={medicine.drugClass} onChange={(v) => updateMedicine(medicine.key, 'drugClass', v)} placeholder="e.g. penicillin antibiotic" disabled={submitting} invalid={Boolean(errors.drugClass)} />
                  )}
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
            {submitting ? 'Checking AI risk…' : 'Authorize & anchor'}
          </button>
        </div>
      </form>
    </section>
  );
}
