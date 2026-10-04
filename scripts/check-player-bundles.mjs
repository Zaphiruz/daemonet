// Fails when evolution requirement data reaches a player-delivered build (SP3a: hidden requirements never
// leave the server undiscovered). Run after `pnpm --filter @daemonet/frontend build` (which also builds the
// sandbox static files); needs the compiled rules package (`tsc -b`).
//
// Markers, all taken from the server-only subpath `@daemonet/rules/evolution`:
//   1. EVOLUTION_RULES_TAG — a unique string stored inside the requirement table itself, so any bundle that
//      contains the table contains it;
//   2. for every hidden form, its requirement array as a quote-/whitespace-insensitive regex (survives
//      minification: property names and values are kept, quotes and spacing may change).
// Positive control: the markers must all be found in a minified vite build of the server module, so a
// broken matcher cannot pass vacuously. Scanned: apps/frontend/dist/** and packages/sandbox/dist/static/**.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverModule = join(root, 'packages/rules/dist/evolution/index.js');
const { EVOLUTION_RULES, EVOLUTION_RULES_TAG } = await import(pathToFileURL(serverModule).href);

const TARGETS = ['apps/frontend/dist', 'packages/sandbox/dist/static'];
const TEXT = /\.(m?js|cjs|html|css|json|map|txt|svg)$/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (k) => `["'\`]?${escape(k)}["'\`]?\\s*:\\s*`;
/** A non-string literal (numbers here); `4096` must not match `40960`. */
const literal = (v) => `${escape(String(v))}(?![0-9])`;

/** `[{kind:"subnet",subnet:"cloudnet"}]` in any quoting/spacing (numbered backreferences per string value). */
function requirementPattern(reqs) {
  let group = 0;
  const obj = (r) =>
    Object.entries(r)
      .map(([k, v]) => {
        if (typeof v !== 'string') return key(k) + literal(v);
        group++;
        return `${key(k)}(["'\`])${escape(v)}\\${group}`;
      })
      .join('\\s*,\\s*');
  return new RegExp(reqs.map((r) => `\\{\\s*${obj(r)}\\s*\\}`).join('\\s*,\\s*'));
}

const markers = [
  { name: 'EVOLUTION_RULES_TAG', test: (text) => text.includes(EVOLUTION_RULES_TAG) },
  ...Object.entries(EVOLUTION_RULES)
    .filter(([, rule]) => rule.hidden)
    .map(([form, rule]) => {
      const re = requirementPattern(rule.requirement);
      return { name: `hidden requirement of ${form} (${re.source})`, test: (text) => re.test(text) };
    }),
];
if (markers.length < 2) throw new Error('no hidden requirements found in the server module: check the import');

async function positiveControl() {
  const vite = await import(pathToFileURL(join(root, 'apps/frontend/node_modules/vite/dist/node/index.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'daemonet-bundle-check-'));
  try {
    const entry = join(dir, 'entry.js');
    writeFileSync(entry, `import { EVOLUTION_RULES } from ${JSON.stringify(pathToFileURL(serverModule).href)};\nconsole.log(EVOLUTION_RULES);\n`);
    const out = await vite.build({
      configFile: false,
      logLevel: 'silent',
      root: dir,
      build: { write: false, minify: true, lib: { entry, formats: ['es'], fileName: () => 'out.js' }, reportCompressedSize: false },
    });
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    const code = outputs.map((o) => o.code ?? '').join('\n');
    if (code.length === 0) throw new Error('positive control: empty minified build');
    const missed = markers.filter((m) => !m.test(code)).map((m) => m.name);
    if (missed.length > 0) throw new Error(`positive control: markers not found in a minified build of the server module:\n  ${missed.join('\n  ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

await positiveControl();

const leaks = [];
for (const target of TARGETS) {
  const dir = join(root, target);
  let scanned = 0;
  let scripts = 0;
  try {
    statSync(dir);
  } catch {
    throw new Error(`${target} does not exist: build it first (pnpm --filter @daemonet/frontend build)`);
  }
  for (const file of files(dir)) {
    if (!TEXT.test(file)) continue;
    scanned++;
    if (/\.m?js$/i.test(file)) scripts++;
    const text = readFileSync(file, 'utf8');
    for (const m of markers) if (m.test(text)) leaks.push(`${relative(root, file)}: ${m.name}`);
  }
  if (scripts === 0) throw new Error(`${target} contains no JavaScript: is the build complete?`);
  console.log(`scanned ${scanned} files (${scripts} scripts) in ${target}`);
}

if (leaks.length > 0) {
  console.error(`server-only evolution data found in player-delivered builds:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok: none of ${markers.length} markers (tag + ${markers.length - 1} hidden requirements) in player builds`);
