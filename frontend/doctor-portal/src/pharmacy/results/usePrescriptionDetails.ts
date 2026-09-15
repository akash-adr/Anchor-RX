import { useEffect, useState } from 'react';
import { getPatients, getProvenance } from '../../api';
import type { Provenance } from '../../types';

export type DetailsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; provenance: Provenance; patientNames: Record<string, string> };

/**
 * Display-only lookup of a prescription's stored versions for result cards (the scan response carries no
 * clinical fields). Never used as a verification signal — verification already happened server-side.
 */
export function usePrescriptionDetails(prescriptionId: string | null): DetailsState {
  const [state, setState] = useState<DetailsState>({ status: 'loading' });

  useEffect(() => {
    if (!prescriptionId) {
      setState({ status: 'error' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([getProvenance(prescriptionId), getPatients().catch(() => [])])
      .then(([provenance, patients]) => {
        if (cancelled) return;
        setState({ status: 'ready', provenance, patientNames: Object.fromEntries(patients.map((p) => [p.patientId, p.name])) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [prescriptionId]);

  return state;
}
