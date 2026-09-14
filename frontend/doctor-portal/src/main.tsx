import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ProviderProvider } from './context/ProviderContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProviderProvider>
      <App />
    </ProviderProvider>
  </StrictMode>,
);
