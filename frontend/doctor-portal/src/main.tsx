import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import App from './App';
import { PharmacyProvider } from './context/PharmacyContext';
import { ProviderProvider } from './context/ProviderContext';
import LandingPage from './landing/LandingPage';
import PharmacyLayout from './pharmacy/PharmacyLayout';
import PharmacyLogin from './pharmacy/PharmacyLogin';
import PharmacyScanScreen from './pharmacy/PharmacyScanScreen';
import RequirePharmacy from './pharmacy/RequirePharmacy';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        {/* The existing Doctor Portal, unchanged: its screens are still switched internally by App. */}
        <Route
          path="/portal"
          element={
            <ProviderProvider>
              <App />
            </ProviderProvider>
          }
        />
        {/* Pharmacy Portal: /pharmacy = mock pharmacy selection, /pharmacy/scan = verification (needs a pharmacy). */}
        <Route
          path="/pharmacy"
          element={
            <PharmacyProvider>
              <PharmacyLayout />
            </PharmacyProvider>
          }
        >
          <Route index element={<PharmacyLogin />} />
          <Route
            path="scan"
            element={
              <RequirePharmacy>
                <PharmacyScanScreen />
              </RequirePharmacy>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
