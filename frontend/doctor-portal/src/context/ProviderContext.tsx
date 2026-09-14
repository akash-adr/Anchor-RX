/**
 * ⚠ HACKATHON-ONLY MOCK LOGIN — ZERO REAL AUTHENTICATION.
 * The "signed-in" provider is simply picked from the seeded provider list; there is no password,
 * token or session on the server. The API trusts whatever providerId the client sends.
 * Real authentication (JWT + role-based access) is Module 11's job and must replace this.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Provider } from '../types';

const STORAGE_KEY = 'anchor-rx.doctor-portal.provider';

interface ProviderContextValue {
  provider: Provider | null;
  selectProvider: (provider: Provider) => void;
  clearProvider: () => void;
}

const ProviderContext = createContext<ProviderContextValue | null>(null);

// sessionStorage only so a page refresh mid-demo keeps the selection; it's a convenience, not a session.
function loadStoredProvider(): Provider | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'providerId' in parsed && 'name' in parsed) {
      return parsed as Provider;
    }
  } catch {
    // storage unavailable or corrupted: fall back to the selection screen
  }
  return null;
}

function storeProvider(provider: Provider | null) {
  try {
    if (provider) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(provider));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // non-fatal
  }
}

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<Provider | null>(loadStoredProvider);

  const selectProvider = useCallback((next: Provider) => {
    storeProvider(next);
    setProvider(next);
  }, []);

  const clearProvider = useCallback(() => {
    storeProvider(null);
    setProvider(null);
  }, []);

  const value = useMemo(() => ({ provider, selectProvider, clearProvider }), [provider, selectProvider, clearProvider]);
  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>;
}

export function useProvider(): ProviderContextValue {
  const context = useContext(ProviderContext);
  if (!context) throw new Error('useProvider must be used inside <ProviderProvider>');
  return context;
}

/** For screens that are only rendered once a provider is selected. */
export function useCurrentProvider(): Provider {
  const { provider } = useProvider();
  if (!provider) throw new Error('No provider selected');
  return provider;
}
