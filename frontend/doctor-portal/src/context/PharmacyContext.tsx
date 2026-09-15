/**
 * ⚠ HACKATHON-ONLY MOCK LOGIN — ZERO REAL AUTHENTICATION.
 * Mirrors the Doctor Portal's ProviderContext: the "signed-in" pharmacy is simply picked from the seeded
 * pharmacy list; there is no password, token or session on the server. The API trusts whatever
 * pharmacyId the client sends with a scan. Real authentication (JWT + role-based access) is Module 11's job.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Pharmacy } from '../types';

const STORAGE_KEY = 'anchor-rx.pharmacy-portal.pharmacy';

interface PharmacyContextValue {
  pharmacy: Pharmacy | null;
  selectPharmacy: (pharmacy: Pharmacy) => void;
  clearPharmacy: () => void;
}

const PharmacyContext = createContext<PharmacyContextValue | null>(null);

// sessionStorage only so a page refresh mid-demo keeps the selection; it's a convenience, not a session.
function loadStoredPharmacy(): Pharmacy | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'pharmacyId' in parsed && 'name' in parsed) {
      return parsed as Pharmacy;
    }
  } catch {
    // storage unavailable or corrupted: fall back to the selection screen
  }
  return null;
}

function storePharmacy(pharmacy: Pharmacy | null) {
  try {
    if (pharmacy) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pharmacy));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // non-fatal
  }
}

export function PharmacyProvider({ children }: { children: ReactNode }) {
  const [pharmacy, setPharmacy] = useState<Pharmacy | null>(loadStoredPharmacy);

  const selectPharmacy = useCallback((next: Pharmacy) => {
    storePharmacy(next);
    setPharmacy(next);
  }, []);

  const clearPharmacy = useCallback(() => {
    storePharmacy(null);
    setPharmacy(null);
  }, []);

  const value = useMemo(() => ({ pharmacy, selectPharmacy, clearPharmacy }), [pharmacy, selectPharmacy, clearPharmacy]);
  return <PharmacyContext.Provider value={value}>{children}</PharmacyContext.Provider>;
}

export function usePharmacy(): PharmacyContextValue {
  const context = useContext(PharmacyContext);
  if (!context) throw new Error('usePharmacy must be used inside <PharmacyProvider>');
  return context;
}

/** For screens that are only rendered once a pharmacy is selected (see RequirePharmacy). */
export function useCurrentPharmacy(): Pharmacy {
  const { pharmacy } = usePharmacy();
  if (!pharmacy) throw new Error('No pharmacy selected');
  return pharmacy;
}
