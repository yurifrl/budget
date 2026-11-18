import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// The admin imports the jobs contracts from ../shared/src (zod only). Install
// shared/ first: its node_modules holds the single zod, and admin/package.json
// overrides zod to link:../shared/node_modules/zod.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(here, '../shared/src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5191, fs: { allow: [path.join(here, '..')] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
