import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Builds verify/host.ts (and the sandbox modules it imports) into dist/verify/host.js. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    lib: { entry: 'host.ts', formats: ['es'], fileName: () => 'host.js' },
    outDir: fileURLToPath(new URL('../dist/verify', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
    minify: false,
    rollupOptions: { external: [] },
  },
});
