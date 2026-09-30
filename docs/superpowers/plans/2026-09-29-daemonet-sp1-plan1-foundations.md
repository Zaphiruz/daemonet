# Daemonet SP1 · Plan 1 — Foundations (monorepo, rules, protocol) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Daemonet pnpm monorepo with CI, the pure `@daemonet/rules` package (formulas, SP1 content, spawn rolls, the four SP1 capture-challenge families and chaining) and the `@daemonet/shared` wire protocol.

**Architecture:** Two TypeScript packages built with `tsc -b` (project references) and tested with Vitest from the repo root. `rules` is pure and deterministic — every random function takes an injected `Rng` — so later plans (sim, SDK) can replay anything from a seed. `shared` holds the zod schemas that are the single source of truth for every WebSocket message.

**Tech Stack:** Node 24 LTS, pnpm 10.33.2, TypeScript ~6.0.3 (NodeNext modules), Vitest ^4.1.11, fast-check ^4.10.2, zod ^4.6.5, ESLint ^10.11 + typescript-eslint ^8.71, GitHub Actions.

**Specs:** `docs/superpowers/specs/2026-09-27-daemonet-design.md` (game design), `docs/superpowers/specs/2026-09-27-daemonet-sp1-core-sim-design.md` (SP1), `docs/superpowers/specs/2026-09-29-daemonet-bestiary-design.md`.

**SP1 plan series:** Plan 1 Foundations (this) → Plan 2 Sim core → Plan 3 Runtime (db, net, auth, SDK) → Plan 4 Infrastructure & deploy.

## Global Constraints

- Node **24** everywhere (`.nvmrc` = `24`, `engines.node` = `>=24`, CI and Docker use Node 24). Vitest 4 does not support Node 23.
- pnpm **10.33.2** via `packageManager`; always run `pnpm install --frozen-lockfile` in CI.
- TypeScript **~6.0.3** (typescript-eslint 8.71 supports `<6.1`; do **not** use TypeScript 7).
- ESM only: `"type": "module"`, `module`/`moduleResolution` `NodeNext`, relative imports end in `.js`.
- `packages/rules` is pure: no I/O, no clocks, no `Math.random`; all randomness through the injected `Rng`.
- **Reference capture solvers live only under `packages/rules/test/`** and are never exported from `src/` (game design §6.4, SP1 spec §4).
- The repo is private: nothing player-facing may link to GitHub issues or the repo (game design §4.3).
- Base-2 constants from the spec: 16 Hz tick, level cap 64, IVs 0–31, energy max 128, RAM 8 / running 2, Disk 256, cooldowns 256–8192 ms, clean 1/4096, signature step 1/4, signature max 15.
- Line endings are LF (`.gitattributes`).
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` when committed by Claude.

## File map

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, tsconfig.json, tsconfig.tests.json,
vitest.config.ts, eslint.config.js, .gitignore, .gitattributes, .nvmrc, .github/workflows/ci.yml
packages/rules/
  src/index.ts            public exports
  src/rng.ts              xoshiro128** Rng
  src/constants.ts        base-2 constants, StatKey/StatBlock helpers
  src/types.ts            16 types + SP1 type chart
  src/natures.ts          16 natures
  src/stats.ts            stat formulas
  src/combat.ts           damage, cooldowns, energy
  src/xp.ts               XP curve and splits
  src/spawn.ts            clean/signature/IV rolls
  src/content/{moves,traits,species,items}.ts   SP1 content data
  src/capture/common.ts   Stage/ChallengeFamily types, byte helpers
  src/capture/size.ts     challenge sizing
  src/capture/{packet,crypto,glitch,null}.ts    challenge families
  src/capture/index.ts    registry, generateChallenge, checkAnswer, chaining
  test/*.test.ts, test/solvers.ts (reference solvers, test-only)
packages/shared/
  src/index.ts, src/protocol.ts   zod wire protocol + parseClientMessage
  test/protocol.test.ts
```

---

### Task 1: Monorepo scaffold, CI and the deterministic RNG

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `.nvmrc`, `.github/workflows/ci.yml`
- Create: `packages/rules/package.json`, `packages/rules/tsconfig.json`, `packages/rules/src/index.ts`, `packages/rules/src/rng.ts`
- Test: `packages/rules/test/rng.test.ts`

**Interfaces:**
- Produces: `interface Rng { nextU32(): number; float(): number; int(min, max): number; chance(p): boolean; pick<T>(items: readonly T[]): T; shuffle<T>(items: T[]): T[] }` and `createRng(seed: string | number): Rng`, exported from `@daemonet/rules`.

- [ ] **Step 1: Switch the workstation to Node 24 and pnpm 10.33.2**

```bash
nvm install 24
nvm use 24
node -v
npm i -g pnpm@10.33.2
pnpm -v
```

Expected: `v24.x.x` and `10.33.2`.

- [ ] **Step 2: Create the root files**

`package.json`:

```json
{
  "name": "daemonet",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.2",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b && tsc -p tsconfig.tests.json",
    "lint": "eslint .",
    "test": "tsc -b && vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "eslint": "^10.11.0",
    "fast-check": "^4.10.2",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.71.0",
    "vitest": "^4.1.11"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "types": ["node"]
  }
}
```

`tsconfig.json` (only `rules` for now; Task 9 adds `shared`):

```json
{
  "files": [],
  "references": [{ "path": "packages/rules" }]
}
```

`tsconfig.tests.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "composite": false, "noEmit": true, "types": ["node"] },
  "include": ["packages/*/test/**/*.ts", "apps/*/test/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

`eslint.config.js`:

```js
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  tseslint.configs.recommended,
]);
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
coverage/
.env
.daemonet-token.json
```

`.gitattributes`:

```
* text=auto eol=lf
```

`.nvmrc`:

```
24
```

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: Create the `rules` package shell**

`packages/rules/package.json`:

```json
{
  "name": "@daemonet/rules",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": { "zod": "^4.6.5" }
}
```

`packages/rules/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/rules/src/index.ts`:

```ts
export * from './rng.js';
```

- [ ] **Step 4: Write the failing RNG test**

`packages/rules/test/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('daemonet');
    const b = createRng('daemonet');
    const seqA = Array.from({ length: 16 }, () => a.nextU32());
    const seqB = Array.from({ length: 16 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('differs for different seeds', () => {
    const a = createRng('daemonet');
    const b = createRng('daemonet2');
    expect(a.nextU32()).not.toEqual(b.nextU32());
  });

  it('accepts numeric seeds, including 0', () => {
    const r = createRng(0);
    const values = new Set(Array.from({ length: 8 }, () => r.nextU32()));
    expect(values.size).toBe(8);
  });

  it('float is in [0, 1)', () => {
    const r = createRng(1);
    for (let i = 0; i < 10_000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('int is inclusive and roughly uniform', () => {
    const r = createRng(2);
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 80_000; i++) counts[r.int(0, 7)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it('int rejects bad ranges', () => {
    const r = createRng(3);
    expect(() => r.int(5, 4)).toThrow(RangeError);
    expect(() => r.int(0.5, 4)).toThrow(RangeError);
  });

  it('pick throws on empty and shuffle permutes', () => {
    const r = createRng(4);
    expect(() => r.pick([])).toThrow(RangeError);
    const arr = Array.from({ length: 32 }, (_, i) => i);
    const shuffled = r.shuffle([...arr]);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(arr);
    expect(shuffled).not.toEqual(arr);
  });
});
```

- [ ] **Step 5: Install and run the test to verify it fails**

```bash
pnpm install
pnpm vitest run packages/rules/test/rng.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/rng.js"`.

- [ ] **Step 6: Implement the RNG**

`packages/rules/src/rng.ts`:

```ts
/** Deterministic PRNG (xoshiro128**) seeded via FNV-1a + splitmix32. */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextU32(): number;
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. Always consumes exactly one draw. */
  chance(p: number): boolean;
  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle in place; returns the same array. */
  shuffle<T>(items: T[]): T[];
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function createRng(seed: string | number): Rng {
  const sm = splitmix32(typeof seed === 'number' ? seed : fnv1a(seed));
  const s = new Uint32Array([sm(), sm(), sm(), sm()]);
  if ((s[0]! | s[1]! | s[2]! | s[3]!) === 0) s[0] = 1;

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return result;
  };

  const float = (): number => nextU32() / 4294967296;

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`bad int range [${min}, ${max}]`);
    }
    const range = max - min + 1;
    if (range > 4294967296) throw new RangeError('range too large');
    const limit = Math.floor(4294967296 / range) * range;
    for (;;) {
      const r = nextU32();
      if (r < limit) return min + (r % range);
    }
  };

  return {
    nextU32,
    float,
    int,
    chance: (p) => float() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick from empty array');
      return items[int(0, items.length - 1)]!;
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(0, i);
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
      }
      return items;
    },
  };
}
```

- [ ] **Step 7: Run the full check**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: lint clean, typecheck clean, `rng.test.ts` 7 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold, CI and deterministic rng"
```

---

### Task 2: Constants, types, natures and stat formulas

**Files:**
- Create: `packages/rules/src/constants.ts`, `packages/rules/src/types.ts`, `packages/rules/src/natures.ts`, `packages/rules/src/stats.ts`
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/test/stats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TICK_HZ, TICK_MS, LEVEL_CAP, MAX_IV, ENERGY_MAX, RAM_SLOTS, RUNNING_MAX, DISK_SLOTS, MAX_MOVES, SIGNATURE_MAX, SWAP_COOLDOWN_MS, TAG_WINDOW_MS, HARDENED_MS`
  - `STAT_KEYS` (order: hp, attack, defense, focus, resolve, speed, haste, energy), `type StatKey`, `type StatBlock = Record<StatKey, number>`, `msToTicks(ms): number`, `statBlock(fill): StatBlock`, `statBlockFromArray(values): StatBlock`, `statBlockToArray(block): number[]`
  - `TYPES`, `type TypeId`, `isTypeId(s)`, `typeMultiplier(attack: TypeId, defender: readonly TypeId[]): number`
  - `interface Nature { id; up: StatKey | null; down: StatKey | null }`, `NATURES` (16), `getNature(index)`, `natureModifier(nature, stat)`
  - `interface StatInput { base; ivs; bonus: StatBlock; level: number; nature: number }`, `computeStats(input): StatBlock`

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/stats.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STAT_KEYS, msToTicks, statBlock, statBlockFromArray, statBlockToArray } from '../src/constants.js';
import { NATURES, getNature, natureModifier } from '../src/natures.js';
import { computeStats } from '../src/stats.js';
import { TYPES, isTypeId, typeMultiplier } from '../src/types.js';

describe('constants', () => {
  it('msToTicks rounds up at 16 Hz', () => {
    expect(msToTicks(62.5)).toBe(1);
    expect(msToTicks(100)).toBe(2);
    expect(msToTicks(4096)).toBe(66);
  });

  it('stat blocks round-trip through arrays in STAT_KEYS order', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(statBlockToArray(statBlockFromArray(arr))).toEqual(arr);
    expect(statBlockFromArray(arr).haste).toBe(7);
    expect(() => statBlockFromArray([1, 2])).toThrow(RangeError);
  });
});

describe('types', () => {
  it('has 16 types', () => {
    expect(TYPES).toHaveLength(16);
    expect(isTypeId('glitch')).toBe(true);
    expect(isTypeId('fire')).toBe(false);
  });

  it('applies the SP1 chart and defaults to x1', () => {
    expect(typeMultiplier('packet', ['glitch'])).toBe(2);
    expect(typeMultiplier('crypto', ['packet'])).toBe(2);
    expect(typeMultiplier('glitch', ['crypto'])).toBe(2);
    expect(typeMultiplier('glitch', ['null'])).toBe(0);
    expect(typeMultiplier('null', ['glitch'])).toBe(1);
    expect(typeMultiplier('kernel', ['heap'])).toBe(1);
  });

  it('multiplies across dual types', () => {
    expect(typeMultiplier('packet', ['glitch', 'crypto'])).toBe(1);
    expect(typeMultiplier('glitch', ['crypto', 'null'])).toBe(0);
  });
});

describe('natures', () => {
  it('has 16 natures, never touching HP', () => {
    expect(NATURES).toHaveLength(16);
    for (const n of NATURES) {
      expect(n.up).not.toBe('hp');
      expect(n.down).not.toBe('hp');
    }
    expect(() => getNature(16)).toThrow(RangeError);
  });

  it('modifies +10% / -10%', () => {
    const aggressive = getNature(4);
    expect(natureModifier(aggressive, 'attack')).toBe(1.1);
    expect(natureModifier(aggressive, 'defense')).toBe(0.9);
    expect(natureModifier(aggressive, 'speed')).toBe(1);
  });
});

describe('computeStats', () => {
  const base = statBlock(64);

  it('matches the formula at the level cap', () => {
    const stats = computeStats({ base, ivs: statBlock(31), bonus: statBlock(0), level: 64, nature: 0 });
    expect(stats.attack).toBe(164);
    expect(stats.hp).toBe(233);
  });

  it('matches the formula at level 1', () => {
    const stats = computeStats({ base: statBlock(37), ivs: statBlock(0), bonus: statBlock(0), level: 1, nature: 0 });
    expect(stats.attack).toBe(6);
    expect(stats.hp).toBe(12);
  });

  it('applies nature and bonus points', () => {
    const stats = computeStats({ base, ivs: statBlock(31), bonus: { ...statBlock(0), attack: 1 }, level: 64, nature: 4 });
    expect(stats.attack).toBe(Math.floor(165 * 1.1));
    expect(stats.defense).toBe(Math.floor(164 * 0.9));
  });

  it('is monotonic in level and IV', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 63 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 256 }), (level, iv, b) => {
        const input = { base: statBlock(b), ivs: statBlock(iv), bonus: statBlock(0), level, nature: 0 };
        const now = computeStats(input);
        const higherLevel = computeStats({ ...input, level: level + 1 });
        const higherIv = computeStats({ ...input, ivs: statBlock(iv + 1) });
        for (const k of STAT_KEYS) {
          expect(higherLevel[k]).toBeGreaterThanOrEqual(now[k]);
          expect(higherIv[k]).toBeGreaterThanOrEqual(now[k]);
        }
      }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/stats.test.ts`
Expected: FAIL — cannot resolve `../src/constants.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/constants.ts`:

```ts
export const TICK_HZ = 16;
export const TICK_MS = 1000 / TICK_HZ;
export const LEVEL_CAP = 64;
export const MAX_IV = 31;
export const ENERGY_MAX = 128;
export const RAM_SLOTS = 8;
export const RUNNING_MAX = 2;
export const DISK_SLOTS = 256;
export const MAX_MOVES = 4;
export const SIGNATURE_MAX = 15;
export const SWAP_COOLDOWN_MS = 4096;
export const TAG_WINDOW_MS = 8192;
export const HARDENED_MS = 8192;

export const STAT_KEYS = [
  'hp',
  'attack',
  'defense',
  'focus',
  'resolve',
  'speed',
  'haste',
  'energy',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatBlock = Record<StatKey, number>;

/** Milliseconds to whole ticks, rounding up (a 100 ms cooldown lasts 2 ticks). */
export function msToTicks(ms: number): number {
  return Math.ceil(ms / TICK_MS);
}

export function statBlock(fill: number): StatBlock {
  return { hp: fill, attack: fill, defense: fill, focus: fill, resolve: fill, speed: fill, haste: fill, energy: fill };
}

/** The DB stores IVs/bonus as int[8] in STAT_KEYS order. */
export function statBlockFromArray(values: readonly number[]): StatBlock {
  if (values.length !== STAT_KEYS.length) throw new RangeError('expected 8 values');
  const out = statBlock(0);
  STAT_KEYS.forEach((k, i) => (out[k] = values[i]!));
  return out;
}

export function statBlockToArray(block: StatBlock): number[] {
  return STAT_KEYS.map((k) => block[k]);
}
```

`packages/rules/src/types.ts`:

```ts
export const TYPES = [
  'kernel',
  'packet',
  'crypto',
  'cache',
  'thread',
  'signal',
  'socket',
  'buffer',
  'shell',
  'root',
  'null',
  'glitch',
  'proxy',
  'cloud',
  'stack',
  'heap',
] as const;
export type TypeId = (typeof TYPES)[number];

/** Attacker -> defender multipliers. Unlisted pairs are x1 (SP3 fills the full chart). */
const CHART: Partial<Record<TypeId, Partial<Record<TypeId, number>>>> = {
  packet: { packet: 0.5, crypto: 0.5, glitch: 2 },
  crypto: { packet: 2, crypto: 0.5, glitch: 0.5 },
  glitch: { packet: 0.5, crypto: 2, glitch: 0.5, null: 0 },
};

export function isTypeId(value: string): value is TypeId {
  return (TYPES as readonly string[]).includes(value);
}

export function typeMultiplier(attack: TypeId, defender: readonly TypeId[]): number {
  return defender.reduce((m, d) => m * (CHART[attack]?.[d] ?? 1), 1);
}
```

`packages/rules/src/natures.ts`:

```ts
import type { StatKey } from './constants.js';

export interface Nature {
  id: string;
  up: StatKey | null;
  down: StatKey | null;
}

/** 16 natures (a 4-bit value). Index = the stored nature number. HP is never affected. */
export const NATURES: readonly Nature[] = [
  { id: 'steady', up: null, down: null },
  { id: 'idle', up: null, down: null },
  { id: 'nominal', up: null, down: null },
  { id: 'default', up: null, down: null },
  { id: 'aggressive', up: 'attack', down: 'defense' },
  { id: 'reckless', up: 'attack', down: 'resolve' },
  { id: 'guarded', up: 'defense', down: 'attack' },
  { id: 'stubborn', up: 'defense', down: 'speed' },
  { id: 'focused', up: 'focus', down: 'attack' },
  { id: 'analytic', up: 'focus', down: 'haste' },
  { id: 'calm', up: 'resolve', down: 'focus' },
  { id: 'patient', up: 'resolve', down: 'speed' },
  { id: 'eager', up: 'speed', down: 'defense' },
  { id: 'hasty', up: 'haste', down: 'resolve' },
  { id: 'frugal', up: 'energy', down: 'haste' },
  { id: 'bursty', up: 'haste', down: 'energy' },
];

export function getNature(index: number): Nature {
  const n = NATURES[index];
  if (!n) throw new RangeError(`unknown nature ${index}`);
  return n;
}

export function natureModifier(nature: Nature, stat: StatKey): number {
  if (nature.up === stat) return 1.1;
  if (nature.down === stat) return 0.9;
  return 1;
}
```

`packages/rules/src/stats.ts`:

```ts
import { STAT_KEYS, statBlock, type StatBlock } from './constants.js';
import { getNature, natureModifier } from './natures.js';

export interface StatInput {
  base: StatBlock;
  ivs: StatBlock;
  bonus: StatBlock;
  level: number;
  nature: number;
}

/**
 * stat = floor((2*base + IV + bonus) * level / 64) + 5, then * nature (floored)
 * HP   = floor((2*base + IV + bonus) * level / 64) + level + 10
 */
export function computeStats(input: StatInput): StatBlock {
  const nature = getNature(input.nature);
  const out = statBlock(0);
  for (const key of STAT_KEYS) {
    const core = Math.floor(((2 * input.base[key] + input.ivs[key] + input.bonus[key]) * input.level) / 64);
    out[key] = key === 'hp' ? core + input.level + 10 : Math.floor((core + 5) * natureModifier(nature, key));
  }
  return out;
}
```

Replace `packages/rules/src/index.ts` with:

```ts
export * from './constants.js';
export * from './rng.js';
export * from './types.js';
export * from './natures.js';
export * from './stats.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (rng + stats suites).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): constants, type chart, natures and stat formulas"
```

---

### Task 3: SP1 content — moves, traits, species, items

**Files:**
- Create: `packages/rules/src/content/moves.ts`, `packages/rules/src/content/traits.ts`, `packages/rules/src/content/species.ts`, `packages/rules/src/content/items.ts`
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/test/content.test.ts`

**Interfaces:**
- Consumes: `StatBlock`, `MAX_MOVES`, `TypeId` (Task 2).
- Produces:
  - `type Shape`, `type StatusId = 'throttled' | 'stalled'`, `interface MoveDef { id; name; type; category: 'physical'|'special'; power; energyCost; cooldownMs; range; shape; status? }`, `MOVES`, `getMove(id)`
  - `interface TraitDef`, `TRAITS` (16), `getTrait(id)`
  - `type Behaviour = 'timid'|'territorial'|'wanderer'`, `interface SpeciesDef { id; name; line; stage; types; base; traits; behaviour; baseYield; learnset; starter }`, `SPECIES` (8), `getSpecies(id)`, `movesAtLevel(species, level): string[]`
  - `type ToolId`, `type Noise = 0|1|2`, `interface ToolDef { id; kind: 'tool'; name; range; deadlineMs; noise; sizeMultiplier }`, `RestoreDef`, `ItemDef`, `ItemId`, `ITEMS`, `STARTING_INVENTORY`, `getItem(id)`, `isToolId(id)`, `getTool(id)`

Species base stats follow the bestiary budget: starters total 285, other base forms 300.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { ITEMS, STARTING_INVENTORY, getItem, getTool, isToolId } from '../src/content/items.js';
import { MOVES, getMove } from '../src/content/moves.js';
import { SPECIES, getSpecies, movesAtLevel } from '../src/content/species.js';
import { TRAITS, getTrait } from '../src/content/traits.js';

const COOLDOWNS = [256, 512, 1024, 2048, 4096, 8192];

describe('moves', () => {
  it('has 16 moves, 4 per SP1 type, with power-of-2 cooldowns', () => {
    expect(MOVES).toHaveLength(16);
    for (const type of ['packet', 'crypto', 'glitch', 'null'] as const) {
      expect(MOVES.filter((m) => m.type === type)).toHaveLength(4);
    }
    for (const m of MOVES) {
      expect(COOLDOWNS).toContain(m.cooldownMs);
      expect(m.energyCost).toBeGreaterThan(0);
      expect(m.energyCost).toBeLessThanOrEqual(128);
    }
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(16);
  });

  it('has exactly one throttled (crypto) and one stalled (glitch) move', () => {
    expect(MOVES.filter((m) => m.status?.id === 'throttled').map((m) => m.type)).toEqual(['crypto']);
    expect(MOVES.filter((m) => m.status?.id === 'stalled').map((m) => m.type)).toEqual(['glitch']);
  });

  it('getMove throws on unknown ids', () => {
    expect(getMove('ping').name).toBe('Ping');
    expect(() => getMove('nope')).toThrow(RangeError);
  });
});

describe('species', () => {
  it('has the 8 SP1 base forms, 4 of them starters', () => {
    expect(SPECIES).toHaveLength(8);
    expect(SPECIES.filter((s) => s.starter).map((s) => s.id).sort()).toEqual(['glitchmite', 'hashling', 'nullpup', 'pingling']);
  });

  it('keeps base-stat totals on budget (starters 285, others 300)', () => {
    for (const s of SPECIES) {
      const total = STAT_KEYS.reduce((sum, k) => sum + s.base[k], 0);
      expect(total).toBe(s.starter ? 285 : 300);
      for (const k of STAT_KEYS) {
        expect(s.base[k]).toBeGreaterThanOrEqual(1);
        expect(s.base[k]).toBeLessThanOrEqual(256);
      }
    }
  });

  it('references only known moves and traits', () => {
    for (const s of SPECIES) {
      for (const e of s.learnset) expect(() => getMove(e.move)).not.toThrow();
      for (const t of s.traits) expect(() => getTrait(t)).not.toThrow();
    }
    expect(TRAITS).toHaveLength(16);
  });

  it('movesAtLevel returns the latest 4 learned moves', () => {
    const pingling = getSpecies('pingling');
    expect(movesAtLevel(pingling, 1)).toEqual(['ping', 'traceroute']);
    expect(movesAtLevel(pingling, 8)).toEqual(['ping', 'traceroute', 'broadcast']);
    expect(movesAtLevel(pingling, 20)).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    expect(() => getSpecies('missingno')).toThrow(RangeError);
  });
});

describe('items', () => {
  it('has four tools and restore', () => {
    expect(ITEMS.map((i) => i.id)).toEqual(['sniff', 'tap', 'mirror', 'dump', 'restore']);
    expect(isToolId('dump')).toBe(true);
    expect(isToolId('restore')).toBe(false);
    expect(isToolId('bogus')).toBe(false);
    expect(getTool('dump').sizeMultiplier).toBe(0.5);
    expect(() => getItem('bogus')).toThrow(RangeError);
    expect(STARTING_INVENTORY).toEqual({ sniff: 8, restore: 2 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/content.test.ts`
Expected: FAIL — cannot resolve `../src/content/items.js`.

- [ ] **Step 3: Implement the content files**

`packages/rules/src/content/moves.ts`:

```ts
import type { TypeId } from '../types.js';

export type Shape =
  | { kind: 'single' }
  | { kind: 'cone'; length: number; angleDeg: number }
  | { kind: 'circle'; radius: number };

export type StatusId = 'throttled' | 'stalled';

export interface MoveDef {
  id: string;
  name: string;
  type: TypeId;
  category: 'physical' | 'special';
  power: number;
  energyCost: number;
  cooldownMs: number;
  /** single: max distance to target; cone: cone length from self; circle: max distance to the circle's centre. */
  range: number;
  shape: Shape;
  status?: { id: StatusId; chance: number; durationMs: number };
}

const single = { kind: 'single' } as const;

export const MOVES: readonly MoveDef[] = [
  // Packet
  { id: 'ping', name: 'Ping', type: 'packet', category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'traceroute', name: 'Traceroute', type: 'packet', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'broadcast', name: 'Broadcast', type: 'packet', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 } },
  { id: 'synflood', name: 'SYN Flood', type: 'packet', category: 'physical', power: 90, energyCost: 48, cooldownMs: 4096, range: 2, shape: single },
  // Crypto
  { id: 'hash', name: 'Hash', type: 'crypto', category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'encrypt', name: 'Encrypt', type: 'crypto', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single, status: { id: 'throttled', chance: 0.5, durationMs: 4096 } },
  { id: 'keyspray', name: 'Key Spray', type: 'crypto', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 4, shape: { kind: 'cone', length: 4, angleDeg: 60 } },
  { id: 'bruteforce', name: 'Brute Force', type: 'crypto', category: 'special', power: 100, energyCost: 56, cooldownMs: 8192, range: 6, shape: single },
  // Glitch
  { id: 'bitflip', name: 'Bit Flip', type: 'glitch', category: 'physical', power: 22, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'corrupt', name: 'Corrupt', type: 'glitch', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'static', name: 'Static', type: 'glitch', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 }, status: { id: 'stalled', chance: 0.5, durationMs: 2048 } },
  { id: 'cosmicray', name: 'Cosmic Ray', type: 'glitch', category: 'physical', power: 95, energyCost: 48, cooldownMs: 4096, range: 3, shape: single },
  // Null
  { id: 'nullref', name: 'Null Ref', type: 'null', category: 'physical', power: 20, energyCost: 4, cooldownMs: 512, range: 2, shape: single },
  { id: 'voidbolt', name: 'Void Bolt', type: 'null', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'blackhole', name: 'Black Hole', type: 'null', category: 'special', power: 35, energyCost: 24, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 } },
  { id: 'dereference', name: 'Dereference', type: 'null', category: 'physical', power: 100, energyCost: 56, cooldownMs: 8192, range: 2, shape: single },
];

const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function getMove(id: string): MoveDef {
  const m = BY_ID.get(id);
  if (!m) throw new RangeError(`unknown move ${id}`);
  return m;
}
```

`packages/rules/src/content/traits.ts`:

```ts
/** Traits are rolled and stored in SP1; their effects arrive in SP3. */
export interface TraitDef {
  id: string;
  name: string;
  description: string;
}

export const TRAITS: readonly TraitDef[] = [
  { id: 'echo', name: 'Echo', description: 'Repeats its last move at half power.' },
  { id: 'lowlatency', name: 'Low Latency', description: 'First move in a battle has no cooldown.' },
  { id: 'synburst', name: 'SYN Burst', description: 'Filler moves cost no energy below 25% HP.' },
  { id: 'retransmit', name: 'Retransmit', description: 'Missed area moves refund half their energy.' },
  { id: 'salted', name: 'Salted', description: 'Takes less damage from repeated moves.' },
  { id: 'onewayfn', name: 'One-Way', description: 'Status effects on it cannot be copied.' },
  { id: 'darkmode', name: 'Dark Mode', description: 'Harder to target from long range.' },
  { id: 'sonar', name: 'Sonar', description: 'Sees daemons through obstacles.' },
  { id: 'overclock', name: 'Overclock', description: 'Cooldowns -12.5% below 25% HP.' },
  { id: 'bitshield', name: 'Bitshield', description: 'Blocks the first hit in each battle.' },
  { id: 'entropy', name: 'Entropy', description: 'Statuses it inflicts last longer.' },
  { id: 'decay', name: 'Decay', description: 'Enemies it hits lose energy over time.' },
  { id: 'nullsafe', name: 'Null Safe', description: 'Survives one lethal hit per battle at 1 HP.' },
  { id: 'lazyeval', name: 'Lazy Eval', description: 'Heavy moves cost less energy.' },
  { id: 'voidstep', name: 'Void Step', description: 'Moves faster out of combat.' },
  { id: 'absorb', name: 'Absorb', description: 'Regains energy when hit.' },
];

const BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

export function getTrait(id: string): TraitDef {
  const t = BY_ID.get(id);
  if (!t) throw new RangeError(`unknown trait ${id}`);
  return t;
}
```

`packages/rules/src/content/species.ts`:

```ts
import { MAX_MOVES, type StatBlock } from '../constants.js';
import type { TypeId } from '../types.js';

export type Behaviour = 'timid' | 'territorial' | 'wanderer';

export interface LearnsetEntry {
  level: number;
  move: string;
}

export interface SpeciesDef {
  id: string;
  name: string;
  /** Bestiary line number (1-50). */
  line: number;
  /** 0 = base form. */
  stage: number;
  types: readonly TypeId[];
  base: StatBlock;
  traits: readonly [string, string];
  behaviour: Behaviour;
  baseYield: number;
  learnset: readonly LearnsetEntry[];
  starter: boolean;
}

const s = (hp: number, attack: number, defense: number, focus: number, resolve: number, speed: number, haste: number, energy: number): StatBlock => ({
  hp, attack, defense, focus, resolve, speed, haste, energy,
});

const learn = (filler: string, ranged: string, area: string, heavy: string): LearnsetEntry[] => [
  { level: 1, move: filler },
  { level: 1, move: ranged },
  { level: 8, move: area },
  { level: 16, move: heavy },
];

const PACKET = learn('ping', 'traceroute', 'broadcast', 'synflood');
const CRYPTO = learn('hash', 'encrypt', 'keyspray', 'bruteforce');
const GLITCH = learn('bitflip', 'corrupt', 'static', 'cosmicray');
const NULL = learn('nullref', 'voidbolt', 'blackhole', 'dereference');

/** SP1 content: the eight base forms of bestiary lines 05, 06, 08, 09, 32, 33, 36, 37. */
export const SPECIES: readonly SpeciesDef[] = [
  { id: 'pingling', name: 'Pingling', line: 5, stage: 0, types: ['packet'], base: s(34, 36, 28, 34, 28, 50, 42, 33), traits: ['echo', 'lowlatency'], behaviour: 'timid', baseYield: 32, learnset: PACKET, starter: true },
  { id: 'floodhound', name: 'Floodhound', line: 6, stage: 0, types: ['packet'], base: s(36, 48, 30, 30, 28, 42, 50, 36), traits: ['synburst', 'retransmit'], behaviour: 'territorial', baseYield: 36, learnset: PACKET, starter: false },
  { id: 'hashling', name: 'Hashling', line: 8, stage: 0, types: ['crypto'], base: s(36, 34, 36, 38, 38, 34, 34, 35), traits: ['salted', 'onewayfn'], behaviour: 'wanderer', baseYield: 32, learnset: CRYPTO, starter: true },
  { id: 'cipherbat', name: 'Cipherbat', line: 9, stage: 0, types: ['crypto'], base: s(32, 26, 30, 52, 40, 42, 40, 38), traits: ['darkmode', 'sonar'], behaviour: 'timid', baseYield: 36, learnset: CRYPTO, starter: false },
  { id: 'glitchmite', name: 'Glitchmite', line: 36, stage: 0, types: ['glitch'], base: s(32, 46, 28, 34, 26, 40, 46, 33), traits: ['overclock', 'bitshield'], behaviour: 'territorial', baseYield: 32, learnset: GLITCH, starter: true },
  { id: 'bitrot', name: 'Bitrot', line: 37, stage: 0, types: ['glitch'], base: s(40, 30, 36, 38, 40, 30, 40, 46), traits: ['entropy', 'decay'], behaviour: 'wanderer', baseYield: 36, learnset: GLITCH, starter: false },
  { id: 'nullpup', name: 'Nullpup', line: 32, stage: 0, types: ['null'], base: s(40, 36, 36, 32, 36, 34, 34, 37), traits: ['nullsafe', 'lazyeval'], behaviour: 'wanderer', baseYield: 32, learnset: NULL, starter: true },
  { id: 'voidlet', name: 'Voidlet', line: 33, stage: 0, types: ['null'], base: s(42, 26, 44, 30, 54, 28, 32, 44), traits: ['voidstep', 'absorb'], behaviour: 'territorial', baseYield: 36, learnset: NULL, starter: false },
];

const BY_ID = new Map(SPECIES.map((sp) => [sp.id, sp]));

export function getSpecies(id: string): SpeciesDef {
  const sp = BY_ID.get(id);
  if (!sp) throw new RangeError(`unknown species ${id}`);
  return sp;
}

/** The (up to) 4 most recently learned moves at `level`, in learn order. */
export function movesAtLevel(species: SpeciesDef, level: number): string[] {
  const known = species.learnset.filter((e) => e.level <= level).map((e) => e.move);
  return known.slice(-MAX_MOVES);
}
```

`packages/rules/src/content/items.ts`:

```ts
export type ToolId = 'sniff' | 'tap' | 'mirror' | 'dump';
export type Noise = 0 | 1 | 2;

export interface ToolDef {
  id: ToolId;
  kind: 'tool';
  name: string;
  /** Link range in tiles. */
  range: number;
  deadlineMs: number;
  noise: Noise;
  /** Multiplies the challenge size (dump halves it). */
  sizeMultiplier: number;
}

export interface RestoreDef {
  id: 'restore';
  kind: 'restore';
  name: string;
}

export type ItemDef = ToolDef | RestoreDef;
export type ItemId = ItemDef['id'];

export const ITEMS: readonly ItemDef[] = [
  { id: 'sniff', kind: 'tool', name: 'sniff', range: 4, deadlineMs: 2048, noise: 2, sizeMultiplier: 1 },
  { id: 'tap', kind: 'tool', name: 'tap', range: 6, deadlineMs: 4096, noise: 1, sizeMultiplier: 1 },
  { id: 'mirror', kind: 'tool', name: 'mirror', range: 8, deadlineMs: 4096, noise: 0, sizeMultiplier: 1 },
  { id: 'dump', kind: 'tool', name: 'dump', range: 8, deadlineMs: 8192, noise: 0, sizeMultiplier: 0.5 },
  { id: 'restore', kind: 'restore', name: 'restore' },
];

export const STARTING_INVENTORY: Readonly<Partial<Record<ItemId, number>>> = { sniff: 8, restore: 2 };

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): ItemDef {
  const item = BY_ID.get(id as ItemId);
  if (!item) throw new RangeError(`unknown item ${id}`);
  return item;
}

export function isToolId(id: string): id is ToolId {
  return getItemOrNull(id)?.kind === 'tool';
}

export function getTool(id: ToolId): ToolDef {
  const item = getItem(id);
  if (item.kind !== 'tool') throw new RangeError(`${id} is not a tool`);
  return item;
}

function getItemOrNull(id: string): ItemDef | null {
  return BY_ID.get(id as ItemId) ?? null;
}
```

Append to `packages/rules/src/index.ts`:

```ts
export * from './content/moves.js';
export * from './content/traits.js';
export * from './content/species.js';
export * from './content/items.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): SP1 moves, traits, species and items"
```

---

### Task 4: Combat math and XP

**Files:**
- Create: `packages/rules/src/combat.ts`, `packages/rules/src/xp.ts`
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/test/combat.test.ts`

**Interfaces:**
- Consumes: `Rng`, `StatBlock`, `ENERGY_MAX`, `TICK_HZ`, `LEVEL_CAP`, `MoveDef`, `typeMultiplier`.
- Produces:
  - `interface DamageInput { level; attacker: StatBlock; attackerTypes; defender: StatBlock; defenderTypes; move: MoveDef }`, `interface DamageResult { amount; multiplier }`, `damage(input, rng): DamageResult` (draws exactly one random number)
  - `effectiveCooldownMs(baseMs, haste, throttled): number`, `energyRegenPerSecond(energyStat)`, `regenEnergy(current, energyStat, ticks = 1)`
  - `xpForLevel(level)`, `levelForXp(xp)`, `xpYield(baseYield, level)`, `splitXp(total, recipients): number[]`

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/combat.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { damage, effectiveCooldownMs, energyRegenPerSecond, regenEnergy } from '../src/combat.js';
import { statBlock } from '../src/constants.js';
import { getMove } from '../src/content/moves.js';
import { createRng } from '../src/rng.js';
import { levelForXp, splitXp, xpForLevel, xpYield } from '../src/xp.js';

describe('damage', () => {
  const input = {
    level: 10,
    attacker: statBlock(40),
    attackerTypes: ['packet'] as const,
    defender: statBlock(40),
    defenderTypes: ['glitch'] as const,
    move: getMove('traceroute'),
  };

  it('applies type, same-type bonus and a bounded random factor', () => {
    // base = floor(((2*10/5 + 2) * 40 * 40) / 40 / 50) + 2 = floor(240 / 50) + 2 = 6
    // 6 * 2 (packet vs glitch) * 1.5 (same type) = 18, times random in [0.875, 1)
    const rng = createRng('dmg');
    for (let i = 0; i < 100; i++) {
      const { amount, multiplier } = damage(input, rng);
      expect(multiplier).toBe(2);
      expect(amount).toBeGreaterThanOrEqual(15);
      expect(amount).toBeLessThanOrEqual(18);
    }
  });

  it('deals 0 through an immunity', () => {
    const r = damage({ ...input, move: getMove('corrupt'), attackerTypes: ['glitch'], defenderTypes: ['null'] }, createRng(1));
    expect(r).toEqual({ amount: 0, multiplier: 0 });
  });

  it('always draws exactly one random number', () => {
    const a = createRng(9);
    const b = createRng(9);
    damage({ ...input, defenderTypes: ['null'], move: getMove('corrupt') }, a);
    b.float();
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it('is at least 1 whenever the multiplier is positive', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 400 }), fc.integer(), (level, atk, def, seed) => {
        const r = damage({ ...input, level, attacker: statBlock(atk), defender: statBlock(def) }, createRng(seed));
        expect(r.amount).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

describe('cooldowns and energy', () => {
  it('haste shortens cooldowns and throttled lengthens them', () => {
    expect(effectiveCooldownMs(1024, 0, false)).toBe(1024);
    expect(effectiveCooldownMs(1024, 256, false)).toBe(512);
    expect(effectiveCooldownMs(1024, 0, true)).toBe(1536);
  });

  it('regenerates per tick and caps at 128', () => {
    expect(energyRegenPerSecond(64)).toBe(2);
    expect(regenEnergy(0, 64, 16)).toBeCloseTo(2);
    expect(regenEnergy(127.9, 256, 16)).toBe(128);
  });
});

describe('xp', () => {
  it('uses 8 * n^3', () => {
    expect(xpForLevel(1)).toBe(8);
    expect(xpForLevel(64)).toBe(2_097_152);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(xpForLevel(10))).toBe(10);
    expect(levelForXp(xpForLevel(10) - 1)).toBe(9);
    expect(levelForXp(1e12)).toBe(64);
  });

  it('yields and splits XP', () => {
    expect(xpYield(32, 16)).toBe(64);
    expect(splitXp(7, 2)).toEqual([4, 3]);
    expect(splitXp(7, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/combat.test.ts`
Expected: FAIL — cannot resolve `../src/combat.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/combat.ts`:

```ts
import { ENERGY_MAX, TICK_HZ, type StatBlock } from './constants.js';
import type { MoveDef } from './content/moves.js';
import type { Rng } from './rng.js';
import { typeMultiplier, type TypeId } from './types.js';

export interface DamageInput {
  level: number;
  attacker: StatBlock;
  attackerTypes: readonly TypeId[];
  defender: StatBlock;
  defenderTypes: readonly TypeId[];
  move: MoveDef;
}

export interface DamageResult {
  amount: number;
  multiplier: number;
}

/**
 * floor(((2*level/5 + 2) * power * atk/def) / 50) + 2, then * type * same-type 1.5 * random [0.875, 1).
 * Physical moves use Attack/Defense, special moves Focus/Resolve. Always draws exactly one random number.
 * Result is >= 1 unless the type multiplier is 0.
 */
export function damage(input: DamageInput, rng: Rng): DamageResult {
  const random = 0.875 + rng.float() * 0.125;
  const { move } = input;
  const multiplier = typeMultiplier(move.type, input.defenderTypes);
  if (multiplier === 0 || move.power === 0) return { amount: 0, multiplier };
  const physical = move.category === 'physical';
  const atk = physical ? input.attacker.attack : input.attacker.focus;
  const def = Math.max(1, physical ? input.defender.defense : input.defender.resolve);
  const base = Math.floor((((2 * input.level) / 5 + 2) * move.power * atk) / def / 50) + 2;
  const stab = input.attackerTypes.includes(move.type) ? 1.5 : 1;
  return { amount: Math.max(1, Math.floor(base * multiplier * stab * random)), multiplier };
}

/** base * 256 / (256 + haste), floored; throttled multiplies by 1.5 (floored). */
export function effectiveCooldownMs(baseMs: number, haste: number, throttled: boolean): number {
  const ms = Math.floor((baseMs * 256) / (256 + haste));
  return throttled ? Math.floor(ms * 1.5) : ms;
}

/** Energy points per second. */
export function energyRegenPerSecond(energyStat: number): number {
  return 1 + energyStat / 64;
}

export function regenEnergy(current: number, energyStat: number, ticks = 1): number {
  return Math.min(ENERGY_MAX, current + (energyRegenPerSecond(energyStat) * ticks) / TICK_HZ);
}
```

`packages/rules/src/xp.ts`:

```ts
import { LEVEL_CAP } from './constants.js';

/** Total XP needed to be at `level`: 8 * level^3. */
export function xpForLevel(level: number): number {
  return 8 * level ** 3;
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < LEVEL_CAP && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** XP from defeating or capturing a daemon. */
export function xpYield(baseYield: number, level: number): number {
  return Math.floor((baseYield * level) / 8);
}

/** Split XP equally; the remainder goes to the first recipients. */
export function splitXp(total: number, recipients: number): number[] {
  if (recipients <= 0) return [];
  const share = Math.floor(total / recipients);
  const remainder = total - share * recipients;
  return Array.from({ length: recipients }, (_, i) => share + (i < remainder ? 1 : 0));
}
```

Append to `packages/rules/src/index.ts`:

```ts
export * from './combat.js';
export * from './xp.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): damage, cooldowns, energy and XP"
```

---

### Task 5: Spawn rolls — clean images and signatures

**Files:**
- Create: `packages/rules/src/spawn.ts`
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/test/spawn.test.ts`

**Interfaces:**
- Consumes: `Rng`, `MAX_IV`, `SIGNATURE_MAX`, `STAT_KEYS`, `statBlock`, `NATURES`.
- Produces: `interface SpawnOdds { clean; signatureStep }`, `DEFAULT_ODDS = { clean: 1/4096, signatureStep: 1/4 }`, `interface SpawnRoll { ivs; bonus: StatBlock; clean; signature; nature; traitSlot: 0|1 }`, `rollSpawn(rng, odds = DEFAULT_ODDS): SpawnRoll`.

Species and level are chosen by the spawner (Plan 2); `rollSpawn` only rolls the individual.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/spawn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { createRng } from '../src/rng.js';
import { DEFAULT_ODDS, rollSpawn } from '../src/spawn.js';

const sum = (b: Record<string, number>) => Object.values(b).reduce((a, x) => a + x, 0);

describe('rollSpawn', () => {
  it('uses 1/4096 and 1/4 by default', () => {
    expect(DEFAULT_ODDS).toEqual({ clean: 1 / 4096, signatureStep: 1 / 4 });
  });

  it('never produces a natural all-31 image unless clean', () => {
    const rng = createRng('spawn');
    for (let i = 0; i < 20_000; i++) {
      const roll = rollSpawn(rng, { clean: 0, signatureStep: 0.25 });
      expect(roll.clean).toBe(false);
      expect(roll.signature).toBe(0);
      expect(STAT_KEYS.every((k) => roll.ivs[k] === 31)).toBe(false);
      expect(roll.nature).toBeGreaterThanOrEqual(0);
      expect(roll.nature).toBeLessThanOrEqual(15);
    }
  });

  it('clean images have all IVs 31 and one bonus point per signature tier', () => {
    const rng = createRng('clean');
    for (let i = 0; i < 2_000; i++) {
      const roll = rollSpawn(rng, { clean: 1, signatureStep: 0.5 });
      expect(roll.clean).toBe(true);
      expect(STAT_KEYS.every((k) => roll.ivs[k] === 31)).toBe(true);
      expect(sum(roll.bonus)).toBe(roll.signature);
      expect(roll.signature).toBeLessThanOrEqual(15);
    }
  });

  it('caps the signature at 15', () => {
    const roll = rollSpawn(createRng(1), { clean: 1, signatureStep: 1 });
    expect(roll.signature).toBe(15);
  });

  it('matches P(tier >= k | clean) = 4^-k (2^20 rolls, clean injected at 1/4)', () => {
    const rng = createRng('stats');
    const n = 2 ** 20;
    const atLeast = new Array<number>(6).fill(0);
    let clean = 0;
    for (let i = 0; i < n; i++) {
      const roll = rollSpawn(rng, { clean: 1 / 4, signatureStep: 1 / 4 });
      if (!roll.clean) continue;
      clean++;
      for (let k = 0; k <= Math.min(5, roll.signature); k++) atLeast[k]!++;
    }
    const expectWithin = (observed: number, p: number, trials: number) => {
      const sd = Math.sqrt(trials * p * (1 - p));
      expect(Math.abs(observed - trials * p)).toBeLessThan(5 * sd + 1);
    };
    expectWithin(clean, 1 / 4, n);
    for (let k = 1; k <= 5; k++) expectWithin(atLeast[k]!, 4 ** -k, clean);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/spawn.test.ts`
Expected: FAIL — cannot resolve `../src/spawn.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/spawn.ts`:

```ts
import { MAX_IV, SIGNATURE_MAX, STAT_KEYS, statBlock, type StatBlock } from './constants.js';
import { NATURES } from './natures.js';
import type { Rng } from './rng.js';

export interface SpawnOdds {
  /** Probability a fresh spawn is a clean image (all IVs 31). */
  clean: number;
  /** Probability of each successive signature tier, given clean. */
  signatureStep: number;
}

export const DEFAULT_ODDS: SpawnOdds = { clean: 1 / 4096, signatureStep: 1 / 4 };

export interface SpawnRoll {
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  nature: number;
  traitSlot: 0 | 1;
}

/**
 * Clean with p = odds.clean. Clean: all IVs 31, signature = consecutive successes of odds.signatureStep
 * (capped at 15), each tier +1 bonus on a random stat. Not clean: IVs uniform 0-31, rerolled if all 31.
 * `odds` is injectable for tests only.
 */
export function rollSpawn(rng: Rng, odds: SpawnOdds = DEFAULT_ODDS): SpawnRoll {
  const clean = rng.chance(odds.clean);
  const bonus = statBlock(0);
  let ivs: StatBlock;
  let signature = 0;
  if (clean) {
    ivs = statBlock(MAX_IV);
    while (signature < SIGNATURE_MAX && rng.chance(odds.signatureStep)) signature++;
    for (let i = 0; i < signature; i++) bonus[rng.pick(STAT_KEYS)]++;
  } else {
    do {
      ivs = statBlock(0);
      for (const key of STAT_KEYS) ivs[key] = rng.int(0, MAX_IV);
    } while (STAT_KEYS.every((k) => ivs[k] === MAX_IV));
  }
  const nature = rng.int(0, NATURES.length - 1);
  const traitSlot = rng.int(0, 1) as 0 | 1;
  return { ivs, bonus, clean, signature, nature, traitSlot };
}
```

Append to `packages/rules/src/index.ts`:

```ts
export * from './spawn.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS; the statistical test runs 2^20 rolls in about a second.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): spawn rolls with clean images and signatures"
```

---

### Task 6: Capture challenge framework, sizing and the Packet family

**Files:**
- Create: `packages/rules/src/capture/common.ts`, `packages/rules/src/capture/size.ts`, `packages/rules/src/capture/packet.ts`, `packages/rules/src/capture/index.ts`
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/test/solvers.ts` (test-only reference solvers), `packages/rules/test/capture.test.ts`

**Interfaces:**
- Consumes: `Rng`, `TypeId`, `Noise`, `ToolDef`.
- Produces:
  - `interface Stage<P, Y, A> { params; payload; answer }`, `interface ChallengeFamily<P, Y, A> { type; answerSchema: z.ZodType<A>; generate(size, noise, rng): Stage; check(expected, submitted): boolean }`
  - helpers `toHex`, `fromHex`, `randomBytes`, `fnv1a32Hex`, `xorRepeating`, `utf8`, `fromUtf8`
  - `interface ChallengeTarget { stage; hpFraction; clean; signature; hardened; statused }`, `challengeSize(target, tool): number`
  - `interface PublicChallenge { kind: 'single' | 'chain'; families: TypeId[]; params; payload }`, `interface Challenge extends PublicChallenge { answer }`
  - `getFamily(type)`, `hasFamily(type)`, `generateChallenge(types, size, noise, rng): Challenge`, `publicChallenge(ch): PublicChallenge`, `type CheckResult = 'correct' | 'wrong' | 'invalid'`, `checkAnswer(ch, submitted): CheckResult`
  - Packet types `PacketParams`, `PacketPayload`, `PacketFragment`, `PacketAnswer`, and `packetCrc(seq, data)`.

- [ ] **Step 1: Write the test-only Packet solver**

`packages/rules/test/solvers.ts`:

```ts
/**
 * Reference solvers — TEST ONLY. Never import these from src/ (they must not ship in any package).
 * Each takes the public (params, payload) and returns the answer object.
 */
import { fnv1a32Hex, fromHex } from '../src/capture/common.js';
import { packetCrc, type PacketParams, type PacketPayload } from '../src/capture/packet.js';
import type { PublicChallenge } from '../src/capture/index.js';
import type { TypeId } from '../src/types.js';

export function solvePacket(params: PacketParams, payload: PacketPayload): { checksum: string } {
  const chunks = new Map<number, Uint8Array>();
  for (const f of payload.fragments) {
    const data = fromHex(f.data);
    if (packetCrc(f.seq, data) === f.crc) chunks.set(f.seq, data);
  }
  const message = new Uint8Array(params.count * 4);
  for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq)!, seq * 4);
  return { checksum: fnv1a32Hex(message) };
}

const SOLVERS: Partial<Record<TypeId, (params: never, payload: never) => unknown>> = {
  packet: solvePacket,
};

export function solve(challenge: PublicChallenge): unknown {
  const solveStage = (type: TypeId, params: unknown, payload: unknown) =>
    (SOLVERS[type] as (p: unknown, y: unknown) => unknown)(params, payload);
  return solveStage(challenge.families[0]!, challenge.params, challenge.payload);
}
```

- [ ] **Step 2: Write the failing tests**

`packages/rules/test/capture.test.ts` (Tasks 7 and 8 extend this file):

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkAnswer, generateChallenge, hasFamily, publicChallenge } from '../src/capture/index.js';
import { challengeSize, type ChallengeTarget } from '../src/capture/size.js';
import { getTool, type Noise } from '../src/content/items.js';
import { createRng } from '../src/rng.js';
import type { TypeId } from '../src/types.js';
import { solve } from './solvers.js';

const FAMILIES: TypeId[] = ['packet'];

/** Change the answer so it is still schema-valid but wrong. */
function mutate(answer: Record<string, unknown>): Record<string, unknown> {
  const [key, value] = Object.entries(answer)[0]!;
  if (typeof value === 'number') return { [key]: value + 1 };
  const s = value as string;
  if (key === 'checksum' || key === 'hex') {
    const flipped = s[0] === '0' ? '1' : '0';
    return { [key]: flipped + s.slice(1) };
  }
  return { [key]: s + 'x' };
}

describe('challengeSize', () => {
  const base: ChallengeTarget = { stage: 0, hpFraction: 1, clean: false, signature: 0, hardened: false, statused: false };
  const sniff = getTool('sniff');

  it('follows 16 * 2^stage * (1 + hp) with multipliers', () => {
    expect(challengeSize(base, sniff)).toBe(32);
    expect(challengeSize({ ...base, hpFraction: 0 }, sniff)).toBe(16);
    expect(challengeSize({ ...base, stage: 2 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, clean: true, signature: 3 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, hardened: true }, sniff)).toBe(64);
    expect(challengeSize({ ...base, statused: true }, sniff)).toBe(16);
    expect(challengeSize({ ...base, hpFraction: 0.25 }, getTool('dump'))).toBe(10);
  });

  it('never goes below 8 and clamps hp', () => {
    expect(challengeSize({ ...base, hpFraction: 0, statused: true }, getTool('dump'))).toBe(8);
    expect(challengeSize({ ...base, hpFraction: 5 }, sniff)).toBe(32);
  });
});

describe.each(FAMILIES)('%s family', (type) => {
  it('is registered', () => expect(hasFamily(type)).toBe(true));

  it('the reference solver passes and a mutated answer fails', () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 300 }), fc.constantFrom<Noise>(0, 1, 2), fc.integer(), (size, noise, seed) => {
        const challenge = generateChallenge([type], size, noise, createRng(seed));
        const answer = solve(publicChallenge(challenge)) as Record<string, unknown>;
        expect(checkAnswer(challenge, answer)).toBe('correct');
        expect(checkAnswer(challenge, mutate(answer))).toBe('wrong');
      }),
      { numRuns: 64 },
    );
  });

  it('is deterministic per seed', () => {
    const a = generateChallenge([type], 64, 2, createRng('same'));
    const b = generateChallenge([type], 64, 2, createRng('same'));
    expect(a).toEqual(b);
  });

  it('stays under 64 KiB at the largest SP1 size', () => {
    // stage 0, full HP, clean, signature, hardened: 16 * 2 * 2 * 2 * 2 = 256; allow 4x headroom.
    const challenge = generateChallenge([type], 1024, 2, createRng('big'));
    expect(JSON.stringify(publicChallenge(challenge)).length).toBeLessThan(65536);
  });

  it('rejects malformed answers as invalid', () => {
    const challenge = generateChallenge([type], 16, 0, createRng(1));
    expect(checkAnswer(challenge, { nope: true })).toBe('invalid');
    expect(checkAnswer(challenge, null)).toBe('invalid');
  });
});

describe('unsupported challenges', () => {
  it('rejects unknown families and bad type counts', () => {
    expect(() => generateChallenge(['kernel'], 16, 0, createRng(3))).toThrow(RangeError);
    expect(() => generateChallenge([], 16, 0, createRng(3))).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture/index.js`.

- [ ] **Step 4: Implement the framework and Packet family**

`packages/rules/src/capture/common.ts`:

```ts
import type { z } from 'zod';
import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';

/** One stage of a challenge. `answer` never leaves the server. */
export interface Stage<P = unknown, Y = unknown, A = unknown> {
  params: P;
  payload: Y;
  answer: A;
}

export interface ChallengeFamily<P = unknown, Y = unknown, A = unknown> {
  type: TypeId;
  answerSchema: z.ZodType<A>;
  generate(size: number, noise: Noise, rng: Rng): Stage<P, Y, A>;
  check(expected: A, submitted: A): boolean;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new RangeError('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomBytes(rng: Rng, length: number, min = 0, max = 255): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.int(min, max);
  return out;
}

/** 32-bit FNV-1a over bytes, as 8 lowercase hex chars. */
export function fnv1a32Hex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function xorRepeating(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new RangeError('empty key');
  return data.map((b, i) => b ^ key[i % key.length]!);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
```

`packages/rules/src/capture/size.ts`:

```ts
import type { ToolDef } from '../content/items.js';

export interface ChallengeTarget {
  /** 0 = base form. */
  stage: number;
  /** Current HP / max HP, clamped to [0, 1]. */
  hpFraction: number;
  clean: boolean;
  signature: number;
  hardened: boolean;
  statused: boolean;
}

/**
 * size = 16 * 2^stage * (1 + hpFraction), x2 clean, x2 signature >= 1, x2 hardened, x0.5 statused,
 * x tool.sizeMultiplier; rounded; minimum 8.
 */
export function challengeSize(target: ChallengeTarget, tool: ToolDef): number {
  const hp = Math.min(1, Math.max(0, target.hpFraction));
  let size = 16 * 2 ** target.stage * (1 + hp);
  if (target.clean) size *= 2;
  if (target.signature >= 1) size *= 2;
  if (target.hardened) size *= 2;
  if (target.statused) size *= 0.5;
  size *= tool.sizeMultiplier;
  return Math.max(8, Math.round(size));
}
```

`packages/rules/src/capture/packet.ts`:

```ts
import { z } from 'zod';
import { fnv1a32Hex, randomBytes, toHex, type ChallengeFamily } from './common.js';

/**
 * Packet: reassemble fragments.
 * The message is `count` chunks of 4 bytes, chunk `seq` = bytes [4*seq, 4*seq+4).
 * Each fragment has crc = (seq + sum of its 4 data bytes) mod 256.
 * The payload also holds exact duplicates (floor(count/4)) and, with noise, decoys that reuse a real seq
 * but carry different data and a wrong crc (noise 1: floor(count/8), noise 2: floor(count/4)).
 * Answer: 32-bit FNV-1a of the reassembled message, 8 lowercase hex chars.
 */
export interface PacketParams {
  count: number;
}
export interface PacketFragment {
  seq: number;
  data: string;
  crc: number;
}
export interface PacketPayload {
  fragments: PacketFragment[];
}
export interface PacketAnswer {
  checksum: string;
}

export function packetCrc(seq: number, data: Uint8Array): number {
  let sum = seq;
  for (const b of data) sum += b;
  return sum & 0xff;
}

export const packetFamily: ChallengeFamily<PacketParams, PacketPayload, PacketAnswer> = {
  type: 'packet',
  answerSchema: z.object({ checksum: z.string().regex(/^[0-9a-f]{8}$/) }),
  generate(size, noise, rng) {
    const count = size;
    const message = randomBytes(rng, count * 4);
    const real: PacketFragment[] = [];
    for (let seq = 0; seq < count; seq++) {
      const data = message.subarray(seq * 4, seq * 4 + 4);
      real.push({ seq, data: toHex(data), crc: packetCrc(seq, data) });
    }
    const fragments = [...real];
    for (let i = 0; i < Math.floor(count / 4); i++) fragments.push({ ...rng.pick(real) });
    const decoys = [0, Math.floor(count / 8), Math.floor(count / 4)][noise]!;
    for (let i = 0; i < decoys; i++) {
      const seq = rng.int(0, count - 1);
      const data = randomBytes(rng, 4);
      const wrongCrc = (packetCrc(seq, data) + rng.int(1, 255)) & 0xff;
      fragments.push({ seq, data: toHex(data), crc: wrongCrc });
    }
    rng.shuffle(fragments);
    return { params: { count }, payload: { fragments }, answer: { checksum: fnv1a32Hex(message) } };
  },
  check: (expected, submitted) => expected.checksum === submitted.checksum,
};
```

`packages/rules/src/capture/index.ts` (single-type challenges only; Task 8 adds chaining):

```ts
import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import type { ChallengeFamily } from './common.js';
import { packetFamily } from './packet.js';

const FAMILIES: Partial<Record<TypeId, ChallengeFamily>> = {
  packet: packetFamily as ChallengeFamily,
};

export function getFamily(type: TypeId): ChallengeFamily {
  const family = FAMILIES[type];
  if (!family) throw new RangeError(`no capture challenge family for type ${type}`);
  return family;
}

export function hasFamily(type: TypeId): boolean {
  return FAMILIES[type] !== undefined;
}

/** Wire shape of a challenge (what the operator receives). */
export interface PublicChallenge {
  kind: 'single' | 'chain';
  families: TypeId[];
  params: unknown;
  payload: unknown;
}

export interface Challenge extends PublicChallenge {
  /** Expected final answer. Server-side only. */
  answer: unknown;
}

/** Types are the target daemon's types. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length !== 1) throw new RangeError('a daemon has 1 or 2 types');
  const stage = getFamily(types[0]!).generate(size, noise, rng);
  return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
}

export function publicChallenge(challenge: Challenge): PublicChallenge {
  const { kind, families, params, payload } = challenge;
  return { kind, families, params, payload };
}

export type CheckResult = 'correct' | 'wrong' | 'invalid';

export function checkAnswer(challenge: Challenge, submitted: unknown): CheckResult {
  const family = getFamily(challenge.families[challenge.families.length - 1]!);
  const parsed = family.answerSchema.safeParse(submitted);
  if (!parsed.success) return 'invalid';
  return family.check(challenge.answer, parsed.data) ? 'correct' : 'wrong';
}
```

Append to `packages/rules/src/index.ts`:

```ts
export * from './capture/size.js';
export * from './capture/index.js';
export type { PacketParams, PacketPayload, PacketAnswer, PacketFragment } from './capture/packet.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(rules): capture challenge framework, sizing and packet family"
```

---

### Task 7: Crypto, Glitch and Null challenge families

**Files:**
- Create: `packages/rules/src/capture/crypto.ts`, `packages/rules/src/capture/glitch.ts`, `packages/rules/src/capture/null.ts`
- Modify: `packages/rules/src/capture/index.ts` (register families), `packages/rules/src/index.ts`
- Test: `packages/rules/test/solvers.ts`, `packages/rules/test/capture.test.ts`

**Interfaces:**
- Consumes: Task 6 framework.
- Produces: `CryptoParams`, `CryptoPayload`, `CryptoAnswer`, `WORDS`; `GlitchParams`, `GlitchPayload`, `GlitchAnswer`, `hammingEncode(nibble)`; `NullParams`, `NullPayload`, `NullAnswer`. `getFamily` resolves `crypto`, `glitch`, `null`.

- [ ] **Step 1: Extend the tests**

In `packages/rules/test/capture.test.ts` change the family list and add the Hamming known-value test:

```ts
const FAMILIES: TypeId[] = ['packet', 'crypto', 'glitch', 'null'];
```

Add this import at the top:

```ts
import { hammingEncode } from '../src/capture/glitch.js';
```

Add this block after the `challengeSize` describe:

```ts
describe('hammingEncode', () => {
  it('encodes known nibbles', () => {
    expect(hammingEncode(0b0000)).toBe(0);
    // d1..d4 = 1011 -> p1=0, p2=1, p3=0 -> bits p1 p2 d1 p3 d2 d3 d4 = 0 1 1 0 0 1 1
    expect(hammingEncode(0b1011)).toBe(0b1100110);
  });
});
```

- [ ] **Step 2: Add the test-only solvers**

In `packages/rules/test/solvers.ts`, replace the imports with:

```ts
import { fnv1a32Hex, fromHex, fromUtf8, utf8, xorRepeating } from '../src/capture/common.js';
import type { CryptoParams, CryptoPayload } from '../src/capture/crypto.js';
import type { GlitchPayload } from '../src/capture/glitch.js';
import type { NullParams, NullPayload } from '../src/capture/null.js';
import { packetCrc, type PacketParams, type PacketPayload } from '../src/capture/packet.js';
import type { PublicChallenge } from '../src/capture/index.js';
import type { TypeId } from '../src/types.js';
```

Add after `solvePacket`:

```ts
export function solveCrypto(params: CryptoParams, payload: CryptoPayload): { plaintext: string } {
  const cipher = fromHex(payload.ciphertext);
  const k = params.keyLength;
  const key = new Uint8Array(k);
  const known = utf8(params.known.text);
  for (let j = 0; j < k; j++) {
    const i = params.known.offset + j;
    key[i % k] = cipher[i]! ^ known[j]!;
  }
  return { plaintext: fromUtf8(xorRepeating(cipher, key)) };
}

export function solveGlitch(_params: unknown, payload: GlitchPayload): { hex: string } {
  const nibbles = payload.blocks.map((block) => {
    const b = (pos: number) => (block >> (pos - 1)) & 1;
    const syndrome = (b(1) ^ b(3) ^ b(5) ^ b(7)) | ((b(2) ^ b(3) ^ b(6) ^ b(7)) << 1) | ((b(4) ^ b(5) ^ b(6) ^ b(7)) << 2);
    const fixed = syndrome ? block ^ (1 << (syndrome - 1)) : block;
    const f = (pos: number) => (fixed >> (pos - 1)) & 1;
    return (f(3) << 3) | (f(5) << 2) | (f(6) << 1) | f(7);
  });
  let hex = '';
  for (let i = 0; i < nibbles.length; i += 2) hex += ((nibbles[i]! << 4) | nibbles[i + 1]!).toString(16).padStart(2, '0');
  return { hex };
}

export function solveNull(params: NullParams, payload: NullPayload): { sum: number } {
  let sum = 0;
  for (let addr = params.head; addr !== 0; addr = payload.memory[addr + 1]!) sum += payload.memory[addr]!;
  return { sum };
}
```

Replace the `SOLVERS` map with:

```ts
const SOLVERS: Partial<Record<TypeId, (params: never, payload: never) => unknown>> = {
  packet: solvePacket,
  crypto: solveCrypto,
  glitch: solveGlitch,
  null: solveNull,
};
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture/glitch.js` (and crypto/null).

- [ ] **Step 4: Implement the three families**

`packages/rules/src/capture/crypto.ts`:

```ts
import { z } from 'zod';
import { randomBytes, toHex, utf8, xorRepeating, type ChallengeFamily } from './common.js';

/**
 * Crypto: recover a repeating-XOR key from known plaintext, then decrypt.
 * Plaintext is `size` characters of lowercase words and single spaces (ASCII).
 * Key length k = min(16, 2 + floor(size / 32)); key bytes are 1-255.
 * ciphertext[i] = plaintext[i] XOR key[i mod k], sent as hex.
 * params.known gives k consecutive plaintext characters starting at `offset`
 * (offset 0 with noise 0; a random offset otherwise).
 * Answer: the full plaintext.
 */
export interface CryptoParams {
  keyLength: number;
  known: { offset: number; text: string };
}
export interface CryptoPayload {
  ciphertext: string;
}
export interface CryptoAnswer {
  plaintext: string;
}

export const WORDS = [
  'packet', 'daemon', 'kernel', 'socket', 'buffer', 'signal', 'thread', 'cache',
  'proxy', 'cloud', 'stack', 'heap', 'root', 'shell', 'null', 'glitch',
  'route', 'frame', 'queue', 'mutex', 'fork', 'exec', 'pipe', 'port',
  'bind', 'listen', 'accept', 'hash', 'salt', 'nonce', 'cipher', 'key',
  'byte', 'nibble', 'word', 'page', 'fault', 'trap', 'tick', 'jiffy',
  'mask', 'tunnel', 'relay', 'hop', 'ping', 'echo', 'trace', 'flood',
  'sniff', 'tap', 'mirror', 'dump', 'image', 'clean', 'patch', 'bit',
  'flip', 'parity', 'check', 'sum', 'loop', 'node', 'link', 'wire',
] as const;

export const cryptoFamily: ChallengeFamily<CryptoParams, CryptoPayload, CryptoAnswer> = {
  type: 'crypto',
  answerSchema: z.object({ plaintext: z.string().max(65536) }),
  generate(size, noise, rng) {
    let text = '';
    while (text.length < size) text += (text ? ' ' : '') + rng.pick(WORDS);
    const plaintext = text.slice(0, size);
    const keyLength = Math.min(16, 2 + Math.floor(size / 32), size);
    const key = randomBytes(rng, keyLength, 1, 255);
    const ciphertext = xorRepeating(utf8(plaintext), key);
    const offset = noise === 0 ? 0 : rng.int(0, size - keyLength);
    return {
      params: { keyLength, known: { offset, text: plaintext.slice(offset, offset + keyLength) } },
      payload: { ciphertext: toHex(ciphertext) },
      answer: { plaintext },
    };
  },
  check: (expected, submitted) => expected.plaintext === submitted.plaintext,
};
```

`packages/rules/src/capture/glitch.ts`:

```ts
import { z } from 'zod';
import { randomBytes, toHex, type ChallengeFamily } from './common.js';

/**
 * Glitch: correct Hamming(7,4) blocks.
 * Each data byte becomes two blocks: high nibble first, then low nibble.
 * Nibble bits d1..d4 = bits 3..0. Codeword positions 1..7 = p1 p2 d1 p3 d2 d3 d4, with
 *   p1 = d1^d2^d4, p2 = d1^d3^d4, p3 = d2^d3^d4.
 * A block is an integer 0-127 whose bit (pos - 1) holds position pos (position 1 = least significant bit).
 * Each block has at most one flipped bit; flip probability per block is 1/4, 1/2, 3/4 for noise 0, 1, 2.
 * Answer: the corrected data bytes as lowercase hex.
 */
export interface GlitchParams {
  encoding: 'hamming74';
  bytes: number;
}
export interface GlitchPayload {
  blocks: number[];
}
export interface GlitchAnswer {
  hex: string;
}

const bit = (value: number, index: number): number => (value >> index) & 1;

export function hammingEncode(nibble: number): number {
  const d1 = bit(nibble, 3);
  const d2 = bit(nibble, 2);
  const d3 = bit(nibble, 1);
  const d4 = bit(nibble, 0);
  const p1 = d1 ^ d2 ^ d4;
  const p2 = d1 ^ d3 ^ d4;
  const p3 = d2 ^ d3 ^ d4;
  return p1 | (p2 << 1) | (d1 << 2) | (p3 << 3) | (d2 << 4) | (d3 << 5) | (d4 << 6);
}

const FLIP_PROBABILITY = [0.25, 0.5, 0.75] as const;

export const glitchFamily: ChallengeFamily<GlitchParams, GlitchPayload, GlitchAnswer> = {
  type: 'glitch',
  answerSchema: z.object({ hex: z.string().max(65536).regex(/^(?:[0-9a-f]{2})*$/) }),
  generate(size, noise, rng) {
    const data = randomBytes(rng, size);
    const blocks: number[] = [];
    for (const byte of data) {
      for (const nibble of [byte >> 4, byte & 0x0f]) {
        let block = hammingEncode(nibble);
        if (rng.chance(FLIP_PROBABILITY[noise])) block ^= 1 << rng.int(0, 6);
        blocks.push(block);
      }
    }
    return { params: { encoding: 'hamming74', bytes: size }, payload: { blocks }, answer: { hex: toHex(data) } };
  },
  check: (expected, submitted) => expected.hex === submitted.hex,
};
```

`packages/rules/src/capture/null.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Null: chase pointers through a memory dump.
 * memory is an array of cells; a node is two consecutive cells [value, next] at an even address >= 2.
 * next is the address of the following node, or 0 (null) at the end. Cells 0 and 1 are always 0.
 * Start at params.head and follow `next` until 0. Values are 0-255.
 * With noise, an unreachable decoy chain is also present (noise 1: floor(n/4) nodes, noise 2: floor(n/2)).
 * Answer: the sum of the values of the reachable chain (`size` nodes).
 */
export interface NullParams {
  head: number;
  cellsPerNode: 2;
}
export interface NullPayload {
  memory: number[];
}
export interface NullAnswer {
  sum: number;
}

export const nullFamily: ChallengeFamily<NullParams, NullPayload, NullAnswer> = {
  type: 'null',
  answerSchema: z.object({ sum: z.number().int().nonnegative() }),
  generate(size, noise, rng) {
    const decoys = [0, Math.floor(size / 4), Math.floor(size / 2)][noise]!;
    const total = size + decoys;
    const memory = new Array<number>(2 + 2 * total).fill(0);
    const addresses = rng.shuffle(Array.from({ length: total }, (_, i) => 2 + 2 * i));
    const link = (chain: number[]): number => {
      let sum = 0;
      chain.forEach((addr, i) => {
        const value = rng.int(0, 255);
        sum += value;
        memory[addr] = value;
        memory[addr + 1] = chain[i + 1] ?? 0;
      });
      return sum;
    };
    const realChain = addresses.slice(0, size);
    const sum = link(realChain);
    link(addresses.slice(size));
    return { params: { head: realChain[0]!, cellsPerNode: 2 }, payload: { memory }, answer: { sum } };
  },
  check: (expected, submitted) => expected.sum === submitted.sum,
};
```

In `packages/rules/src/capture/index.ts` add the imports and register the families:

```ts
import { cryptoFamily } from './crypto.js';
import { glitchFamily } from './glitch.js';
import { nullFamily } from './null.js';

const FAMILIES: Partial<Record<TypeId, ChallengeFamily>> = {
  packet: packetFamily as ChallengeFamily,
  crypto: cryptoFamily as ChallengeFamily,
  glitch: glitchFamily as ChallengeFamily,
  null: nullFamily as ChallengeFamily,
};
```

Append to `packages/rules/src/index.ts`:

```ts
export type { CryptoParams, CryptoPayload, CryptoAnswer } from './capture/crypto.js';
export type { GlitchParams, GlitchPayload, GlitchAnswer } from './capture/glitch.js';
export type { NullParams, NullPayload, NullAnswer } from './capture/null.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test`
Expected: PASS — each of the four families passes the solver, mutation, determinism, size and invalid-answer tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(rules): crypto, glitch and null capture challenge families"
```

---

### Task 8: Chained challenges for dual-type daemons

**Files:**
- Modify: `packages/rules/src/capture/index.ts` (replace whole file)
- Test: `packages/rules/test/solvers.ts` (replace `solve`), `packages/rules/test/capture.test.ts` (replace the `unsupported challenges` block)

**Interfaces:**
- Produces: `interface ChainPayload { first: { params; payload }; sealed: string }`. `generateChallenge` accepts 2 types and returns `kind: 'chain'`. Wire contract: `sealed` = hex of UTF-8(`JSON.stringify({ params, payload })` of stage two) XOR the repeating key UTF-8(`JSON.stringify(stageOneAnswer)`); the submitted answer is stage two's answer.

- [ ] **Step 1: Write the failing chain tests**

In `packages/rules/test/capture.test.ts`, replace the `describe('unsupported challenges', …)` block with:

```ts
describe('chained challenges', () => {
  it('solving stage one unseals stage two', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FAMILIES), fc.constantFrom(...FAMILIES), fc.integer(), (a, b, seed) => {
        const challenge = generateChallenge([a, b], 24, 1, createRng(seed));
        expect(challenge.kind).toBe('chain');
        expect(challenge.families).toEqual([a, b]);
        const answer = solve(publicChallenge(challenge));
        expect(checkAnswer(challenge, answer)).toBe('correct');
      }),
      { numRuns: 48 },
    );
  });

  it('never exposes the answer publicly', () => {
    const challenge = generateChallenge(['packet', 'glitch'], 16, 0, createRng(2));
    expect(publicChallenge(challenge)).not.toHaveProperty('answer');
  });

  it('rejects unknown families and bad type counts', () => {
    expect(() => generateChallenge(['kernel'], 16, 0, createRng(3))).toThrow(RangeError);
    expect(() => generateChallenge([], 16, 0, createRng(3))).toThrow(RangeError);
  });
});
```

In `packages/rules/test/solvers.ts`, add `ChainPayload` to the `index.js` type import and replace `solve` with:

```ts
export function solve(challenge: PublicChallenge): unknown {
  const solveStage = (type: TypeId, params: unknown, payload: unknown) =>
    (SOLVERS[type] as (p: unknown, y: unknown) => unknown)(params, payload);
  if (challenge.kind === 'single') return solveStage(challenge.families[0]!, challenge.params, challenge.payload);
  const chain = challenge.payload as ChainPayload;
  const firstAnswer = solveStage(challenge.families[0]!, chain.first.params, chain.first.payload);
  const second = JSON.parse(fromUtf8(xorRepeating(fromHex(chain.sealed), utf8(JSON.stringify(firstAnswer))))) as {
    params: unknown;
    payload: unknown;
  };
  return solveStage(challenge.families[1]!, second.params, second.payload);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — typecheck/import error for `ChainPayload`, and `generateChallenge([a, b])` throws `RangeError`.

- [ ] **Step 3: Implement chaining**

Replace `packages/rules/src/capture/index.ts` with:

```ts
import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { toHex, utf8, xorRepeating, type ChallengeFamily } from './common.js';
import { cryptoFamily } from './crypto.js';
import { glitchFamily } from './glitch.js';
import { nullFamily } from './null.js';
import { packetFamily } from './packet.js';

const FAMILIES: Partial<Record<TypeId, ChallengeFamily>> = {
  packet: packetFamily as ChallengeFamily,
  crypto: cryptoFamily as ChallengeFamily,
  glitch: glitchFamily as ChallengeFamily,
  null: nullFamily as ChallengeFamily,
};

export function getFamily(type: TypeId): ChallengeFamily {
  const family = FAMILIES[type];
  if (!family) throw new RangeError(`no capture challenge family for type ${type}`);
  return family;
}

export function hasFamily(type: TypeId): boolean {
  return FAMILIES[type] !== undefined;
}

/**
 * Wire shape of a challenge (what the operator receives).
 * single: `params`/`payload` belong to families[0].
 * chain:  payload = { first: { params, payload }, sealed } where `sealed` is hex of
 *         UTF-8(JSON.stringify({ params, payload })) of the second stage, XORed with the repeating key
 *         UTF-8(JSON.stringify(firstStageAnswer)). The submitted answer is the second stage's answer.
 */
export interface PublicChallenge {
  kind: 'single' | 'chain';
  families: TypeId[];
  params: unknown;
  payload: unknown;
}

export interface Challenge extends PublicChallenge {
  /** Expected final answer. Server-side only. */
  answer: unknown;
}

export interface ChainPayload {
  first: { params: unknown; payload: unknown };
  sealed: string;
}

/** Types are the target daemon's types (1 or 2). Both stages of a chain use the same size and noise. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length === 1) {
    const stage = getFamily(types[0]!).generate(size, noise, rng);
    return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
  }
  if (types.length !== 2) throw new RangeError('a daemon has 1 or 2 types');
  const [a, b] = types as readonly [TypeId, TypeId];
  const first = getFamily(a).generate(size, noise, rng);
  const second = getFamily(b).generate(size, noise, rng);
  const key = utf8(JSON.stringify(first.answer));
  const sealed = toHex(xorRepeating(utf8(JSON.stringify({ params: second.params, payload: second.payload })), key));
  const payload: ChainPayload = { first: { params: first.params, payload: first.payload }, sealed };
  return { kind: 'chain', families: [a, b], params: {}, payload, answer: second.answer };
}

export function publicChallenge(challenge: Challenge): PublicChallenge {
  const { kind, families, params, payload } = challenge;
  return { kind, families, params, payload };
}

export type CheckResult = 'correct' | 'wrong' | 'invalid';

export function checkAnswer(challenge: Challenge, submitted: unknown): CheckResult {
  const family = getFamily(challenge.families[challenge.families.length - 1]!);
  const parsed = family.answerSchema.safeParse(submitted);
  if (!parsed.success) return 'invalid';
  return family.check(challenge.answer, parsed.data) ? 'correct' : 'wrong';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): chained capture challenges for dual-type daemons"
```

---

### Task 9: The `shared` wire protocol

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/protocol.ts`
- Modify: `tsconfig.json` (add the `shared` reference)
- Test: `packages/shared/test/protocol.test.ts`

**Interfaces:**
- Consumes: `TYPES` from `@daemonet/rules`.
- Produces (all from `@daemonet/shared`):
  - constants `MAX_MESSAGE_BYTES = 4096`, `MAX_SUBMIT_BYTES = 16384`, `HEARTBEAT_MS = 16000`, `RESUME_TICKS = 64`, `COMMANDS_PER_TICK = 8`
  - `ErrorCode` (`E_COOLDOWN | E_RANGE | E_ENERGY | E_RATE | E_STATE | E_AUTH | E_INVALID`)
  - `Command` (discriminated on `cmd`; operator-only commands require `actor: 'self'`; `moveTo`/`stop`/`use` take a daemon id or `'self'`), `CommandName`
  - `ClientMessage` (`auth` with `token`, `role` default `controller`, optional `resumeToken`/`lastTick`; `reauth`; `cmd` = `{ reqId } & Command`; `ping`)
  - `Entity` (`OperatorEntity | DaemonEntity`), `EntityPatch`, `RamDaemon`, `OperatorSelf`, `PublicChallengeSchema`, `GameEvent`, `ServerMessage` (`authOk`, `snapshot`, `delta`, `ack`, `err`, `pong`, `kick`)
  - `parseClientMessage(raw: string): { ok: true; message } | { ok: false; code: 'E_INVALID'; message }` enforcing the byte limits

- [ ] **Step 1: Create the package shell**

`packages/shared/package.json`:

```json
{
  "name": "@daemonet/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": { "@daemonet/rules": "workspace:*", "zod": "^4.6.5" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../rules" }]
}
```

Replace the root `tsconfig.json` with:

```json
{
  "files": [],
  "references": [{ "path": "packages/rules" }, { "path": "packages/shared" }]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, ServerMessage, parseClientMessage } from '../src/protocol.js';

const cmd = (d: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: 'r1', ...d } });

describe('parseClientMessage', () => {
  it('accepts auth and defaults the role to controller', () => {
    const r = parseClientMessage(JSON.stringify({ t: 'auth', seq: 0, d: { token: 'dev:alice' } }));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.t === 'auth') expect(r.message.d.role).toBe('controller');
  });

  it('accepts every SP1 command shape', () => {
    const good = [
      { cmd: 'moveTo', actor: 'self', args: { x: 1, y: 2 } },
      { cmd: 'moveTo', actor: 'dmn_1', args: { x: 1, y: 2 } },
      { cmd: 'stop', actor: 'self', args: {} },
      { cmd: 'run', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'recall', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'swap', actor: 'self', args: { outId: 'a', inId: 'b' } },
      { cmd: 'capture', actor: 'self', args: { targetId: 'w1', tool: 'sniff' } },
      { cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { checksum: '00000000' } } },
      { cmd: 'useItem', actor: 'self', args: { item: 'restore', daemonId: 'dmn_1' } },
      { cmd: 'restoreAll', actor: 'self', args: {} },
      { cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice_01' } },
      { cmd: 'store', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'load', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'use', actor: 'dmn_1', args: { move: 'ping', targetId: 'w1' } },
    ];
    for (const g of good) expect(parseClientMessage(cmd(g)).ok, g.cmd).toBe(true);
  });

  it('rejects operator-only commands sent by a daemon actor', () => {
    expect(parseClientMessage(cmd({ cmd: 'capture', actor: 'dmn_1', args: { targetId: 'w1', tool: 'sniff' } })).ok).toBe(false);
  });

  it('rejects bad names, unknown tools and malformed JSON', () => {
    expect(parseClientMessage(cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'x', operatorName: 'Bad Name!' } })).ok).toBe(false);
    expect(parseClientMessage(cmd({ cmd: 'capture', actor: 'self', args: { targetId: 'w1', tool: 'net' } })).ok).toBe(false);
    expect(parseClientMessage('{not json').ok).toBe(false);
  });

  it('enforces 4 KiB for normal messages and 16 KiB for submitCapture', () => {
    const big = 'a'.repeat(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(cmd({ cmd: 'moveTo', actor: big.slice(0, 64), args: { x: 0, y: 0 }, pad: big })).ok).toBe(false);
    const submit = cmd({ cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { plaintext: 'b'.repeat(8000) } } });
    expect(parseClientMessage(submit).ok).toBe(true);
    const tooBig = cmd({ cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { plaintext: 'b'.repeat(17000) } } });
    expect(parseClientMessage(tooBig).ok).toBe(false);
  });
});

describe('ServerMessage', () => {
  it('parses a delta with patches and events', () => {
    const msg = {
      t: 'delta',
      seq: 5,
      d: {
        tick: 100,
        upserts: [{ kind: 'daemon', id: 'w1', hp: 10 }],
        removes: ['w2'],
        events: [
          { e: 'hit', source: 'dmn_1', target: 'w1', move: 'ping', amount: 7, multiplier: 1 },
          { e: 'captureResult', captureId: 'c1', ok: false, reason: 'timeout' },
        ],
      },
    };
    expect(ServerMessage.safeParse(msg).success).toBe(true);
  });

  it('rejects a patch without an id', () => {
    const msg = { t: 'delta', seq: 5, d: { tick: 1, upserts: [{ kind: 'daemon', hp: 1 }], removes: [], events: [] } };
    expect(ServerMessage.safeParse(msg).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm install
pnpm vitest run packages/shared/test/protocol.test.ts
```

Expected: FAIL — cannot resolve `../src/protocol.js`.

- [ ] **Step 4: Implement the protocol**

`packages/shared/src/protocol.ts`:

```ts
import { TYPES } from '@daemonet/rules';
import { z } from 'zod';

/** Upstream limits (UTF-8 bytes). submitCapture gets the larger limit. */
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_SUBMIT_BYTES = 16384;
export const HEARTBEAT_MS = 16_000;
export const RESUME_TICKS = 64;
export const COMMANDS_PER_TICK = 8;

export const ERROR_CODES = ['E_COOLDOWN', 'E_RANGE', 'E_ENERGY', 'E_RATE', 'E_STATE', 'E_AUTH', 'E_INVALID'] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

const Id = z.string().min(1).max(64);
const Coord = z.number().finite();
const TypeIdSchema = z.enum(TYPES);
const Self = z.literal('self');
const OperatorName = z.string().regex(/^[a-z0-9_-]{3,16}$/);

// ---- Commands (client -> server, inside a `cmd` message) ----

export const Command = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('moveTo'), actor: Id, args: z.object({ x: Coord, y: Coord }) }),
  z.object({ cmd: z.literal('stop'), actor: Id, args: z.object({}) }),
  z.object({ cmd: z.literal('run'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('recall'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('swap'), actor: Self, args: z.object({ outId: Id, inId: Id }) }),
  z.object({ cmd: z.literal('capture'), actor: Self, args: z.object({ targetId: Id, tool: z.enum(['sniff', 'tap', 'mirror', 'dump']) }) }),
  z.object({ cmd: z.literal('submitCapture'), actor: Self, args: z.object({ captureId: Id, answer: z.unknown() }) }),
  z.object({ cmd: z.literal('useItem'), actor: Self, args: z.object({ item: z.literal('restore'), daemonId: Id }) }),
  z.object({ cmd: z.literal('restoreAll'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('claimStarter'), actor: Self, args: z.object({ species: Id, operatorName: OperatorName }) }),
  z.object({ cmd: z.literal('store'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('load'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({
    cmd: z.literal('use'),
    actor: Id,
    args: z.object({ move: Id, targetId: Id.optional(), x: Coord.optional(), y: Coord.optional() }),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandName = Command['cmd'];

// ---- Client messages ----

const Seq = z.number().int().nonnegative();

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('auth'),
    seq: Seq,
    d: z.object({
      token: z.string().min(1).max(8192),
      role: z.enum(['controller', 'spectator']).default('controller'),
      resumeToken: z.string().max(128).optional(),
      lastTick: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({ t: z.literal('reauth'), seq: Seq, d: z.object({ token: z.string().min(1).max(8192) }) }),
  z.object({ t: z.literal('cmd'), seq: Seq, d: z.intersection(z.object({ reqId: Id }), Command) }),
  z.object({ t: z.literal('ping'), seq: Seq, d: z.object({}) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- Entities (public, within interest radius) ----

export const StatusSchema = z.enum(['throttled', 'stalled']);

export const OperatorEntity = z.object({
  kind: z.literal('operator'),
  id: Id,
  name: z.string().nullable(),
  x: Coord,
  y: Coord,
});

export const DaemonEntity = z.object({
  kind: z.literal('daemon'),
  id: Id,
  species: Id,
  types: z.array(TypeIdSchema).min(1).max(2),
  level: z.number().int(),
  x: Coord,
  y: Coord,
  hp: z.number(),
  maxHp: z.number(),
  /** Operator id for running daemons, null for wild ones. */
  owner: Id.nullable(),
  /** Operator (or cluster) currently holding the tag on a wild daemon. */
  taggedBy: Id.nullable(),
  clean: z.boolean(),
  signature: z.number().int().min(0).max(15),
  statuses: z.array(StatusSchema),
  hardened: z.boolean(),
});

export const Entity = z.discriminatedUnion('kind', [OperatorEntity, DaemonEntity]);
export type Entity = z.infer<typeof Entity>;

/** Changed fields only; `kind` and `id` are always present. */
export const EntityPatch = z.discriminatedUnion('kind', [
  OperatorEntity.partial().extend({ kind: z.literal('operator'), id: Id }),
  DaemonEntity.partial().extend({ kind: z.literal('daemon'), id: Id }),
]);
export type EntityPatch = z.infer<typeof EntityPatch>;

// ---- Private operator state ----

export const RamDaemon = z.object({
  id: Id,
  species: Id,
  level: z.number().int(),
  xp: z.number().int(),
  nature: z.number().int().min(0).max(15),
  traitSlot: z.union([z.literal(0), z.literal(1)]),
  ivs: z.array(z.number().int()).length(8),
  bonus: z.array(z.number().int()).length(8),
  clean: z.boolean(),
  signature: z.number().int().min(0).max(15),
  hp: z.number(),
  maxHp: z.number(),
  energy: z.number(),
  moves: z.array(Id).max(4),
  crashed: z.boolean(),
  slot: z.number().int(),
  /** move id -> tick at which it is ready again. */
  cooldowns: z.record(z.string(), z.number().int()),
});
export type RamDaemon = z.infer<typeof RamDaemon>;

export const OperatorSelf = z.object({
  id: Id,
  name: z.string().nullable(),
  starterClaimed: z.boolean(),
  x: Coord,
  y: Coord,
  bits: z.number().int(),
  ram: z.array(RamDaemon).max(8),
  running: z.array(Id).max(2),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  swapReadyTick: z.number().int(),
  capture: z.object({ captureId: Id, targetId: Id, deadlineTick: z.number().int() }).nullable(),
});
export type OperatorSelf = z.infer<typeof OperatorSelf>;

// ---- Events ----

export const PublicChallengeSchema = z.object({
  kind: z.enum(['single', 'chain']),
  families: z.array(TypeIdSchema).min(1).max(2),
  params: z.unknown(),
  payload: z.unknown(),
});

export const GameEvent = z.discriminatedUnion('e', [
  z.object({ e: z.literal('hit'), source: Id, target: Id, move: Id, amount: z.number().int(), multiplier: z.number() }),
  z.object({ e: z.literal('crash'), daemon: Id }),
  z.object({ e: z.literal('battleStart'), wild: Id, operator: Id }),
  z.object({ e: z.literal('status'), target: Id, status: StatusSchema, untilTick: z.number().int() }),
  z.object({
    e: z.literal('captureStart'),
    captureId: Id,
    targetId: Id,
    challenge: PublicChallengeSchema,
    deadlineTick: z.number().int(),
  }),
  z.object({
    e: z.literal('captureResult'),
    captureId: Id,
    ok: z.boolean(),
    reason: z.enum(['wrong_answer', 'timeout', 'packet_loss', 'persist_failed']).optional(),
    daemon: RamDaemon.optional(),
  }),
  z.object({ e: z.literal('signatureSpawn'), daemon: Id, species: Id, signature: z.number().int(), clean: z.boolean() }),
  z.object({ e: z.literal('levelUp'), daemon: Id, level: z.number().int() }),
  z.object({ e: z.literal('restored'), daemons: z.array(Id) }),
  z.object({ e: z.literal('swap'), out: Id, in: Id }),
]);
export type GameEvent = z.infer<typeof GameEvent>;

// ---- Server messages ----

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('authOk'),
    seq: Seq,
    d: z.object({ operatorId: Id, role: z.enum(['controller', 'spectator']), resumeToken: z.string(), tick: z.number().int() }),
  }),
  z.object({
    t: z.literal('snapshot'),
    seq: Seq,
    d: z.object({ tick: z.number().int(), subnet: Id, self: OperatorSelf, entities: z.array(Entity) }),
  }),
  z.object({
    t: z.literal('delta'),
    seq: Seq,
    d: z.object({
      tick: z.number().int(),
      upserts: z.array(EntityPatch),
      removes: z.array(Id),
      events: z.array(GameEvent),
      self: OperatorSelf.optional(),
    }),
  }),
  z.object({ t: z.literal('ack'), seq: Seq, d: z.object({ reqId: Id, result: z.unknown().optional() }) }),
  z.object({ t: z.literal('err'), seq: Seq, d: z.object({ reqId: Id.optional(), code: ErrorCode, message: z.string() }) }),
  z.object({ t: z.literal('pong'), seq: Seq, d: z.object({}) }),
  z.object({ t: z.literal('kick'), seq: Seq, d: z.object({ reason: z.string() }) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- Parsing with size limits ----

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; code: 'E_INVALID'; message: string };

const encoder = new TextEncoder();

export function parseClientMessage(raw: string): ParseResult {
  const bytes = encoder.encode(raw).length;
  if (bytes > MAX_SUBMIT_BYTES) return { ok: false, code: 'E_INVALID', message: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'E_INVALID', message: 'malformed JSON' };
  }
  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'E_INVALID', message: parsed.error.issues[0]?.message ?? 'invalid message' };
  const isSubmit = parsed.data.t === 'cmd' && parsed.data.d.cmd === 'submitCapture';
  if (!isSubmit && bytes > MAX_MESSAGE_BYTES) return { ok: false, code: 'E_INVALID', message: 'message too large' };
  return { ok: true, message: parsed.data };
}
```

`packages/shared/src/index.ts`:

```ts
export * from './protocol.js';
```

- [ ] **Step 5: Run the full check**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS — 7 test files, 72 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shared): zod wire protocol with size-limited parsing"
```

---

### Task 10: Verify CI on GitHub

**Files:** none (verification only).

- [ ] **Step 1: Confirm `rules/src/index.ts` matches the final export list**

`packages/rules/src/index.ts` must now be exactly:

```ts
export * from './constants.js';
export * from './rng.js';
export * from './types.js';
export * from './natures.js';
export * from './stats.js';
export * from './combat.js';
export * from './xp.js';
export * from './spawn.js';
export * from './content/moves.js';
export * from './content/traits.js';
export * from './content/species.js';
export * from './content/items.js';
export * from './capture/size.js';
export * from './capture/index.js';
export type { PacketParams, PacketPayload, PacketAnswer, PacketFragment } from './capture/packet.js';
export type { CryptoParams, CryptoPayload, CryptoAnswer } from './capture/crypto.js';
export type { GlitchParams, GlitchPayload, GlitchAnswer } from './capture/glitch.js';
export type { NullParams, NullPayload, NullAnswer } from './capture/null.js';
```

- [ ] **Step 2: Confirm no reference solver is reachable from `src/`**

Run: `git grep -n "solvers" -- packages/rules/src packages/shared/src`
Expected: no output.

- [ ] **Step 3: Push and watch CI**

```bash
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: the `CI` workflow's `check` job passes (install, lint, typecheck, test).

- [ ] **Step 4: If CI fails only because `pnpm-lock.yaml` is missing or stale**, run `pnpm install`, commit `pnpm-lock.yaml` with message `chore: update lockfile`, push, and watch again.
