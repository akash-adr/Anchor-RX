/**
 * Module 14 — per-medicine dispensing tracker, shown under the scan result card.
 *
 * This is a QUANTITY TRACKER, not the trust decision (that slot stays above the card, Module 9). Every rule is enforced
 * server-side by dispensePartial(): the disabled inputs here only save the pharmacist a request the server would refuse.
 *   - quantities (prescribed / already given / remaining) come from the server's records, never computed here
 *   - a medicine whose OWN data fails the fresh integrity check is blocked; other medicines on the same prescription
 *     stay independently dispensable, even when the overall scan result is "tampered" because of a different medicine
 */

import { useCallback, useEffect, useState } from 'react';
import { Pill } from 'lucide-react';
import { ApiError, dispenseMedicine, getDispensingStatus } from '../../api';
import { toApiError } from '../../components/ErrorNotice';
import { useCurrentPharmacy } from '../../context/PharmacyContext';
import type { DispensingMedicine, DispensingStatus, ScanResult } from '../../types';

/** Which version the pharmacist would dispense for this scan — or null when dispensing isn't offered at all. */
export function dispensingVersionFor(result: ScanResult): number | null {
  if (!result.prescriptionId) return null;
  if (result.scanResult === 'verified' || result.scanResult === 'tampered') return result.versionNumber;
  if (result.scanResult === 'stale_version') return result.currentActiveVersion; // always the current version
  return null; // forged / revoked / provider_identity_issue / unknown / malformed: no dispensing table
}

const formatDose = (value: string, unit: string) => `${value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value} ${unit}`;

type Load = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; data: DispensingStatus };

interface RowState {
  quantity: string;
  submitting: boolean;
  message: { tone: 'ok' | 'error'; text: string } | null;
}

export default function DispensingPanel({ result }: { result: ScanResult }) {
  const pharmacy = useCurrentPharmacy();
  const versionNumber = dispensingVersionFor(result);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [rows, setRows] = useState<Record<number, RowState>>({});

  const refresh = useCallback(async () => {
    if (!result.prescriptionId || versionNumber === null) return;
    try {
      const data = await getDispensingStatus(result.prescriptionId, versionNumber);
      setLoad({ status: 'ready', data });
      setRows((previous) =>
        Object.fromEntries(
          data.medicines.map((m) => [m.medicineId, { quantity: String(m.remaining), submitting: false, message: previous[m.medicineId]?.message ?? null }]),
        ),
      );
    } catch (err) {
      setLoad({ status: 'error', error: toApiError(err) });
    }
  }, [result.prescriptionId, versionNumber]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (versionNumber === null) return null;

  const updateRow = (medicineId: number, patch: Partial<RowState>) =>
    setRows((previous) => ({ ...previous, [medicineId]: { ...previous[medicineId], ...patch } }));

  const onDispense = async (data: DispensingStatus, medicine: DispensingMedicine) => {
    const row = rows[medicine.medicineId];
    // Sent as a number only when it is a plain whole number; anything else is sent as-is for the server to reject by name.
    const quantity = /^\d+$/.test(row.quantity.trim()) ? Number(row.quantity.trim()) : Number.NaN;
    updateRow(medicine.medicineId, { submitting: true, message: null });
    try {
      const outcome = await dispenseMedicine(data.prescriptionVersionId, medicine.medicineId, quantity, pharmacy.pharmacyId);
      setLoad({
        status: 'ready',
        data: {
          ...data,
          medicines: data.medicines.map((m) =>
            m.medicineId === medicine.medicineId ? { ...m, prescribed: outcome.prescribed, alreadyGiven: outcome.alreadyGiven, remaining: outcome.remaining } : m,
          ),
        },
      });
      updateRow(medicine.medicineId, {
        submitting: false,
        quantity: String(outcome.remaining),
        message: { tone: 'ok', text: `Dispensed ${quantity}. ${outcome.remaining} remaining.` },
      });
    } catch (err) {
      const error = toApiError(err);
      updateRow(medicine.medicineId, { submitting: false, message: { tone: 'error', text: `${error.message} (${error.reason})` } });
      if (error.reason === 'MEDICINE_TAMPERED' || error.reason === 'EXCEEDS_REMAINING') void refresh(); // server knows better than this snapshot
    }
  };

  return (
    <section data-testid="dispensing-panel" aria-labelledby="dispensing-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
          <Pill aria-hidden className="h-4 w-4" />
        </span>
        <h2 id="dispensing-title" className="text-lg font-semibold tracking-tight text-slate-900">
          Dispensing · version {versionNumber}
        </h2>
        <span className="text-xs text-slate-500">Quantity tracker per medicine — the server re-checks every rule on each dispense.</span>
      </div>
      {result.scanResult === 'stale_version' && (
        <p className="mt-2 text-xs text-sky-900">The scanned QR is for v{result.versionNumber}; quantities below are for the current version v{versionNumber}.</p>
      )}
      {result.scanResult === 'tampered' && (
        <p className="mt-2 text-xs text-red-900">
          Medicines whose own data no longer matches issuance are blocked. Medicines that still match can be dispensed independently.
        </p>
      )}

      {load.status === 'loading' && <div className="mt-4 h-24 animate-pulse rounded-xl bg-slate-100" aria-label="Loading dispensing status" />}
      {load.status === 'error' && (
        <p role="alert" className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
          Couldn’t load dispensing status ({load.error.reason}). Nothing was dispensed.
        </p>
      )}

      {load.status === 'ready' && (
        <>
          {!load.data.dispensableVersion && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              Version {load.data.versionNumber} is {load.data.status}; only the current active version can be dispensed.
            </p>
          )}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm" data-testid="dispensing-table">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="py-2 pr-3 font-semibold">Medicine</th>
                  <th className="px-3 py-2 text-right font-semibold">Prescribed</th>
                  <th className="px-3 py-2 text-right font-semibold">Already given</th>
                  <th className="px-3 py-2 text-right font-semibold">Remaining</th>
                  <th className="py-2 pl-3 font-semibold">Dispense now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {load.data.medicines.map((medicine) => {
                  const row = rows[medicine.medicineId] ?? { quantity: String(medicine.remaining), submitting: false, message: null };
                  const blocked = medicine.tampered;
                  const done = medicine.remaining === 0;
                  const disabled = blocked || done || !load.data.dispensableVersion || row.submitting;
                  return (
                    <tr key={medicine.medicineId} data-testid={`dispense-row-${medicine.sequenceNumber}`} data-blocked={blocked || undefined} className={blocked ? 'bg-red-50/70' : undefined}>
                      <td className="py-3 pr-3 align-top">
                        <p className="font-medium text-slate-900">
                          <span className="mr-1.5 text-xs text-slate-400">{medicine.sequenceNumber}.</span>
                          {medicine.drugName}
                        </p>
                        <p className="text-xs text-slate-500">
                          {formatDose(medicine.dosageValue, medicine.dosageUnit)} · {medicine.frequency}
                        </p>
                        {blocked && (
                          <p className="mt-1 text-xs font-semibold text-red-800">
                            Blocked — this medicine’s data does not match its recorded hash
                            {medicine.tamperedFields.length > 0 && <code className="ml-1 font-mono font-normal">{medicine.tamperedFields.join(', ')}</code>}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right align-top font-mono">{medicine.prescribed}</td>
                      <td className="px-3 py-3 text-right align-top font-mono">{medicine.alreadyGiven}</td>
                      <td className="px-3 py-3 text-right align-top font-mono font-semibold">{medicine.remaining}</td>
                      <td className="py-3 pl-3 align-top">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={medicine.remaining}
                            step={1}
                            aria-label={`Quantity of ${medicine.drugName} to dispense now`}
                            value={row.quantity}
                            onChange={(e) => updateRow(medicine.medicineId, { quantity: e.target.value, message: null })}
                            disabled={disabled}
                            className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right font-mono outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                          <button
                            type="button"
                            onClick={() => void onDispense(load.data, medicine)}
                            disabled={disabled}
                            className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {row.submitting ? 'Dispensing…' : 'Dispense'}
                          </button>
                        </div>
                        {done && !blocked && <p className="mt-1 text-xs text-slate-500">Fully dispensed.</p>}
                        {row.message && (
                          <p role={row.message.tone === 'error' ? 'alert' : 'status'} className={`mt-1 text-xs ${row.message.tone === 'error' ? 'font-semibold text-red-800' : 'text-emerald-800'}`}>
                            {row.message.text}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
