import { defineConfig } from 'vite';

/**
 * Builds the SDK as one self-contained ES module for the sandboxed iframe (packages/sandbox
 * embeds it through an import map). Output: dist/sandbox/sdk.js — no external imports.
 */
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'sdk.js' },
    outDir: 'dist/sandbox',
    emptyOutDir: true,
    target: 'es2023',
    minify: false,
    sourcemap: false,
    rollupOptions: { external: [] },
  },
});
