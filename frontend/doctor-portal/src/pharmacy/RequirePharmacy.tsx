import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { usePharmacy } from '../context/PharmacyContext';

/** Route guard: pharmacy screens need a selected (mock) pharmacy; otherwise go to the selection screen. */
export default function RequirePharmacy({ children }: { children: ReactNode }) {
  const { pharmacy } = usePharmacy();
  if (!pharmacy) return <Navigate to="/pharmacy" replace />;
  return <>{children}</>;
}
