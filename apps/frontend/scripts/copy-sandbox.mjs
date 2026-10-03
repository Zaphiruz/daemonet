// Copies the static sandbox (sandbox.html + sandbox/*.js, built by `@daemonet/sandbox build:static`)
// into public/ so Vite serves it in dev and copies it into dist/. The copies are git- and lint-ignored.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = here('../../../packages/sandbox/dist/static/');
rmSync(here('../public/sandbox'), { recursive: true, force: true });
rmSync(here('../public/sandbox.html'), { force: true });
cpSync(src, here('../public/'), { recursive: true });
