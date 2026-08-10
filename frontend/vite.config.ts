/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 localhost so start.bat port checks and the browser agree.
    // strictPort avoids silently hopping to 5174+ when orphans hold 5173.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Proxy API + SSE writing calls to the backend so the browser stays
    // same-origin (no CORS needed). The backend listens on :3000 by default.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
