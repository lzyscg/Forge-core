import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Phase B Task 1: the one-process server (src/server/http-server.ts) serves
// the built client from dist/client in production mode, so the client build
// output moves below the shared dist/ directory. Dev/e2e behavior unchanged.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
