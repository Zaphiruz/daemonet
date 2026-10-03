// Writes the static sandbox into packages/sandbox/dist/static/ (run after `tsc -b`):
//   sandbox.html, sandbox/bootstrap.js, sandbox/worker.js, sandbox/sdk.js
// Serve sandbox.html with the SANDBOX_CSP response header (see src/document.ts).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildSandboxDocument, SANDBOX_STATIC_FILES } from '../dist/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here('../dist/static/');

/** One self-contained classic script (IIFE): no imports, so it loads in an opaque-origin document and via importScripts. */
const bundle = (entry, name, fileName) =>
  build({
    configFile: false,
    logLevel: 'warn',
    build: {
      lib: { entry, formats: ['iife'], name, fileName: () => fileName },
      outDir: join(out, 'sandbox'),
      emptyOutDir: false,
      target: 'es2023',
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
    },
  });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'sandbox'), { recursive: true });
await bundle(here('../../sdk/src/index.ts'), 'DaemonetSDK', 'sdk.js');
await bundle(here('../src/entry/bootstrap.ts'), 'DaemonetSandboxFrame', 'bootstrap.js');
await bundle(here('../src/entry/worker.ts'), 'DaemonetSandboxWorker', 'worker.js');
writeFileSync(join(out, 'sandbox.html'), buildSandboxDocument());
console.log(`sandbox static files in ${out}: ${SANDBOX_STATIC_FILES.join(', ')}`);
