import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies /api to the Express API (npm run api, port 4000), so the browser only ever
// talks to its own origin. Set VITE_API_BASE_URL to call a different API host directly instead.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
