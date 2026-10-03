import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: here,
  resolve: { alias: { '@daemonet/sandbox': fileURLToPath(new URL('../../sandbox/src/index.ts', import.meta.url)), '@daemonet/sdk': fileURLToPath(new URL('../src/index.ts', import.meta.url)) } },
  build: { lib: { entry: 'host.ts', formats: ['es'], fileName: () => 'host.js' }, outDir: fileURLToPath(new URL('../dist/verify', import.meta.url)), emptyOutDir: true, target: 'es2023', minify: false, rollupOptions: { external: [] } },
});
