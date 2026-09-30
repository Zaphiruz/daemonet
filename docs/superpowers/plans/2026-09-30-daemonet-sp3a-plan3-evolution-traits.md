# Daemonet SP3a · Plan 3 — Evolution and traits in the sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daemons evolve. Pure evolution rules in `@daemonet/rules` (options, requirement evaluation, IV growth → clean check → 1/256 signature upgrade → form change), a durable `evolve` intent with server-wide `Discovery` rows, `hold`/`unhold` and the Bit Flipper, lifetime counters (`moveTypeUses`, `crashes`), per-daemon history, all 16 trait effects, the 4 held-item effects and the `leaking` / `exposed` statuses in combat, and the protocol/SDK surface (`evolve`, `hold`, `unhold`, `useBitFlipper`, `RamDaemon.evolutions`, `evolved` / `discovery` events).

**Architecture:** `packages/rules/src/evolution.ts` is pure: `evolutionOptions(daemon, ctx)` and `applyEvolution(daemon, form, rng)` know nothing about the world. The sim evaluates the context (subnet, nearby operators, original operator, discovered forms), rolls the outcome with the world RNG, and persists it as an `evolve` intent before anything changes — exactly like captures. The store answers `discovered: true` when it created the first `Discovery` row for that form; the sim then adds the form to `World.discovered` (hidden requirements become visible to everyone) and broadcasts `discovery`. Trait and held-item effects live in `combat.ts` (`energyCost`, `cooldownMs`, `scaleDamage`, `applyHit`), `upkeep.ts` (leaking, battery), `movement.ts` (voidstep) and `progress.ts` (crashes), keyed off `Daemon.trait` (= `species.traits[traitSlot]`) and a per-engagement state block reset on activation / battle start.

**Tech Stack:** as before (Node 24, pnpm 10.33, TypeScript ~6.0, Vitest 4, zod 4, Prisma 7.10). Nothing new.

**Prerequisites:** SP3a plans 1 and 2 merged (`packages/rules` has the 256-species bestiary with `Requirement`s and all 16 challenge families).

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3a-daemon-depth-design.md` §3.5, §3.6, §4, §7, §8. Decisions this plan fixes:
- `evolve` requires the daemon **in RAM and not running** (spec §4.2's "must not be running"); a crashed daemon may evolve (its HP stays 0).
- A `Discovery` row is written for **every** form's first evolution (not just hidden ones) so the Codex trees can mark discovered forms; only hidden forms hide their requirement until discovered.
- History entries carry an ISO timestamp from `World.now()` (`clock` option; tests inject a constant). The world is otherwise unchanged in determinism: `now()` feeds only history text.
- `hold` / `unhold` / Bit Flipper are plain commands persisted by checkpoints (like inventory today); checkpoints now also write `ivs`, `patched`, `heldItem`, `moveTypeUses`, `crashes`, `history`.
- `originalOperatorId` joins `OwnedDaemonRecord` (the column already exists) so `originalOperator` requirements work before trading exists.

## Global Constraints

- Everything from the earlier plans (LF endings, `tsc -b` clean, `eslint .` clean, `pnpm test` green).
- No player-facing links to the GitHub repository or issues.
- Rules stay pure: `packages/rules/src/evolution.ts` imports nothing from the sim; the sim never re-implements a rule the package exports.
- Every gameplay effect gets a test (one per trait, one per held item, each status, each command guard).

## File map

```
packages/rules/src/evolution.ts                requirementMet, evolutionOptions, applyEvolution, emptyMoveTypeUses, typeIndex
packages/rules/src/content/species.ts          SpeciesDef gains requirement + hidden
packages/rules/test/evolution.test.ts
packages/db/prisma/schema.prisma               Daemon +heldItem/patched/moveTypeUses/crashes/arenaWins/history; Discovery
packages/db/prisma/migrations/20260930000002_sp3a_evolution/migration.sql
packages/shared/src/protocol.ts                evolve/hold/unhold commands, useItem bitflipper, RamDaemon extras, evolved/discovery events
packages/sdk/src/client.ts                     operator.evolve/hold/unhold/useBitFlipper
apps/sim/src/core/model.ts                     HistoryEntry, Engagement, Daemon/OwnedDaemonRecord fields, evolve intent
apps/sim/src/core/world.ts                     discovered, now(), engagement reset, record fields, evolve completion
apps/sim/src/core/systems/evolve.ts            evolutionContext, evolve command, completeEvolveIntent
apps/sim/src/core/systems/commands.ts          hold, unhold, evolve, bitflipper; starter record fields
apps/sim/src/core/systems/capture.ts           captured record fields + history
apps/sim/src/core/systems/combat.ts            trait / held-item / status effects, moveTypeUses
apps/sim/src/core/systems/upkeep.ts            leaking, battery, engagement reset on tag expiry
apps/sim/src/core/systems/movement.ts          voidstep
apps/sim/src/core/systems/progress.ts          crashes counter
apps/sim/src/core/view.ts                      RamDaemon extras + evolutions
apps/sim/src/runtime/store.ts                  evolve intent, listDiscoveries (MemoryStore)
apps/sim/src/runtime/prisma-store.ts           evolve intent, Discovery, listDiscoveries, wider checkpoint
apps/sim/src/runtime/main.ts                   World gets discovered ids at boot
apps/sim/test/{evolve,traits}.test.ts, store/integration/combat tests, helpers
apps/frontend/src/sdk-types.ts                 Monaco declarations for the new SDK surface
```

---

### Task 1: Evolution rules (pure)

**Files:**
- Create: `packages/rules/src/evolution.ts`, `packages/rules/test/evolution.test.ts`
- Modify: `packages/rules/src/content/species.ts`, `packages/rules/src/index.ts`, `packages/rules/test/capture.test.ts`

**Interfaces:**
- Consumes: `evolutionsOf`, `getSpecies`, `movesAtLevel`, `dominantStat` (species.ts), `Requirement` (bestiary.ts), `computeStats`, `Rng`, `TYPES`.
- Produces:
  ```ts
  interface EvolvableDaemon { species; level; nature; ivs: StatBlock; bonus: StatBlock; clean; signature; patched; heldItem: string | null; moveTypeUses: readonly number[]; crashes; arenaWins }
  interface EvolutionContext { subnet: string; unobserved: boolean; originalOperator: boolean; discovered: ReadonlySet<string> }
  interface EvolutionOption { form; name; level; hidden; revealed; met; requirement: readonly Requirement[] | null }
  function requirementMet(req: Requirement, d: EvolvableDaemon, ctx: EvolutionContext): boolean
  function evolutionOptions(d: EvolvableDaemon, ctx: EvolutionContext): EvolutionOption[]
  type EvolutionChange = { kind: 'iv'; stat; from; to } | { kind: 'clean' } | { kind: 'signature'; from; to; bonusStat } | { kind: 'consumed'; item }
  interface EvolutionResult { species; ivs; bonus; clean; signature; heldItem; moves: string[]; maxHp: number; changes: EvolutionChange[] }
  function applyEvolution(d: EvolvableDaemon, formId: string, rng: Rng, chances = { iv: 0.5, signature: 1 / 256 }): EvolutionResult
  function emptyMoveTypeUses(): number[]   // 16 zeros, TYPES order
  function typeIndex(type: TypeId): number
  ```
  `SpeciesDef` gains `requirement: readonly Requirement[] | null` and `hidden: boolean` (copied from the bestiary row).

- [ ] **Step 1: Carry `requirement` and `hidden` onto `SpeciesDef`**

In `packages/rules/src/content/species.ts`:

1. Change the bestiary import to `import { BESTIARY, type BestiaryRow, type Role, type Requirement } from './bestiary.js';`
2. Add to the end of `interface SpeciesDef`:
   ```ts
     /** Extra conditions beyond the level (bestiary spec §4); null = level only. */
     requirement: readonly Requirement[] | null;
     /** Requirement is not shown in the Codex until someone discovers it. */
     hidden: boolean;
   ```
3. Add to the `SPECIES` mapping after `evolvesAt: row.evolvesAt,`:
   ```ts
     requirement: row.requirement,
     hidden: row.hidden,
   ```

- [ ] **Step 2: Write the failing test**

`packages/rules/test/evolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAT_KEYS, statBlock } from '../src/constants.js';
import { getSpecies } from '../src/content/species.js';
import { applyEvolution, emptyMoveTypeUses, evolutionOptions, requirementMet, typeIndex, type EvolvableDaemon, type EvolutionContext } from '../src/evolution.js';
import { createRng } from '../src/rng.js';

const base = (over: Partial<EvolvableDaemon> = {}): EvolvableDaemon => ({
  species: 'echolet', level: 16, nature: 0, ivs: statBlock(20), bonus: statBlock(0), clean: false, signature: 0, patched: false, heldItem: null,
  moveTypeUses: emptyMoveTypeUses(), crashes: 0, arenaWins: 0, ...over,
});
const ctx = (over: Partial<EvolutionContext> = {}): EvolutionContext => ({ subnet: 'lo', unobserved: false, originalOperator: true, discovered: new Set(), ...over });

describe('requirementMet', () => {
  it('evaluates every requirement kind', () => {
    const uses = emptyMoveTypeUses();
    uses[typeIndex('packet')] = 4096;
    const d = base({ heldItem: 'jumboframe', ivs: { ...statBlock(10), speed: 31 }, moveTypeUses: uses, clean: true, signature: 2, crashes: 3, arenaWins: 16 });
    expect(requirementMet({ kind: 'heldItem', item: 'jumboframe' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'heldItem', item: 'sigmask' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'dominantIV', stat: 'speed' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'dominantIV', stat: 'attack' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'moveTypeUses', type: 'packet', count: 4096 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'moveTypeUses', type: 'glitch', count: 1 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'subnet', subnet: 'lo' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'subnet', subnet: 'darknet' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'clean' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'signature', min: 2 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'signature', min: 3 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'originalOperator' }, d, ctx({ originalOperator: false }))).toBe(false);
    expect(requirementMet({ kind: 'crashes', op: 'max', count: 0 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'crashes', op: 'min', count: 3 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'arenaWins', count: 16 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'unobserved' }, d, ctx({ unobserved: true }))).toBe(true);
  });
});

describe('evolutionOptions', () => {
  it('lists both branches of Echolet, gating on level and items, hiding undiscovered requirements', () => {
    const opts = evolutionOptions(base({ level: 15 }), ctx());
    expect(opts.map((o) => o.form)).toEqual(['tracerat', 'broadcaw']);
    expect(opts.every((o) => !o.met)).toBe(true);
    const at16 = evolutionOptions(base(), ctx());
    expect(at16.find((o) => o.form === 'tracerat')!.met).toBe(true);
    expect(at16.find((o) => o.form === 'broadcaw')).toMatchObject({ met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] });
    expect(evolutionOptions(base({ heldItem: 'jumboframe' }), ctx()).find((o) => o.form === 'broadcaw')!.met).toBe(true);
  });

  it('hides hidden branch requirements until discovered', () => {
    const d = base({ species: 'broadcaw', level: 32, ivs: { ...statBlock(10), speed: 31 } });
    const hidden = evolutionOptions(d, ctx()).find((o) => o.form === 'anycastrel')!;
    expect(hidden).toMatchObject({ hidden: true, revealed: false, requirement: null, met: true });
    const shown = evolutionOptions(d, ctx({ discovered: new Set(['anycastrel']) })).find((o) => o.form === 'anycastrel')!;
    expect(shown.requirement).toEqual([{ kind: 'dominantIV', stat: 'speed' }]);
  });
});

describe('applyEvolution', () => {
  it('grows IVs with p = 1/2, keeps signature, relearns moves and consumes the required item', () => {
    const rng = createRng('evo');
    const r = applyEvolution(base({ heldItem: 'jumboframe', signature: 2, clean: true, ivs: statBlock(31) }), 'broadcaw', rng, { iv: 0.5, signature: 0 });
    expect(r.species).toBe('broadcaw');
    expect(r.signature).toBe(2);
    expect(r.heldItem).toBeNull();
    expect(r.changes).toContainEqual({ kind: 'consumed', item: 'jumboframe' });
    expect(r.moves).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    expect(r.maxHp).toBeGreaterThan(0);
  });

  it('IV growth averages +1/2 per stat and can create a clean image; patched daemons never become clean', () => {
    let gained = 0;
    for (let i = 0; i < 2000; i++) gained += STAT_KEYS.reduce((a, k) => a + applyEvolution(base(), 'tracerat', createRng(i)).ivs[k] - 20, 0);
    expect(gained / 2000 / 8).toBeGreaterThan(0.45);
    expect(gained / 2000 / 8).toBeLessThan(0.55);
    const almost = { ...statBlock(31), hp: 30 };
    const clean = applyEvolution(base({ ivs: almost }), 'tracerat', createRng(0), { iv: 1, signature: 0 });
    expect(clean.clean).toBe(true);
    expect(clean.changes).toContainEqual({ kind: 'clean' });
    const patched = applyEvolution(base({ ivs: almost, patched: true }), 'tracerat', createRng(0), { iv: 1, signature: 0 });
    expect(patched.clean).toBe(false);
  });

  it('upgrades the signature of clean images at the given chance, adding one bonus point', () => {
    const r = applyEvolution(base({ clean: true, ivs: statBlock(31), signature: 3 }), 'tracerat', createRng(1), { iv: 0, signature: 1 });
    expect(r.signature).toBe(4);
    expect(STAT_KEYS.reduce((a, k) => a + r.bonus[k], 0)).toBe(1);
    expect(r.changes.some((c) => c.kind === 'signature')).toBe(true);
    const never = applyEvolution(base({ clean: false, signature: 0 }), 'tracerat', createRng(1), { iv: 0, signature: 1 });
    expect(never.signature).toBe(0);
  });

  it('rejects forms that do not evolve from the species', () => {
    expect(() => applyEvolution(base(), 'pidzero', createRng(1))).toThrow(RangeError);
    expect(getSpecies('tracerat').evolvesFrom).toBe('echolet');
  });
});
```

Run: `pnpm exec vitest run packages/rules/test/evolution.test.ts` — expected: fails to import `../src/evolution.js`.

- [ ] **Step 3: Write `packages/rules/src/evolution.ts`**

```ts
import { MAX_IV, SIGNATURE_MAX, STAT_KEYS, statBlock, type StatBlock } from './constants.js';
import { type Requirement } from './content/bestiary.js';
import { computeStats, } from './stats.js';
import { dominantStat, evolutionsOf, getSpecies, movesAtLevel, type SpeciesDef } from './content/species.js';
import type { Rng } from './rng.js';
import { TYPES, type TypeId } from './types.js';

/** What the requirement checks and the evolution itself need to know about a daemon. */
export interface EvolvableDaemon {
  species: string;
  level: number;
  nature: number;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  patched: boolean;
  heldItem: string | null;
  /** Lifetime uses per type, in TYPES order. */
  moveTypeUses: readonly number[];
  crashes: number;
  arenaWins: number;
}

export interface EvolutionContext {
  subnet: string;
  /** No other operator within the interest radius right now. */
  unobserved: boolean;
  /** The daemon is still with the operator in its capture log. */
  originalOperator: boolean;
  /** Form ids whose hidden requirement has been discovered server-wide. */
  discovered: ReadonlySet<string>;
}

export function requirementMet(req: Requirement, d: EvolvableDaemon, ctx: EvolutionContext): boolean {
  switch (req.kind) {
    case 'heldItem':
      return d.heldItem === req.item;
    case 'dominantIV':
      return dominantStat(d.ivs) === req.stat;
    case 'moveTypeUses':
      return (d.moveTypeUses[TYPES.indexOf(req.type)] ?? 0) >= req.count;
    case 'subnet':
      return ctx.subnet === req.subnet;
    case 'clean':
      return d.clean;
    case 'signature':
      return d.signature >= req.min;
    case 'originalOperator':
      return ctx.originalOperator;
    case 'crashes':
      return req.op === 'max' ? d.crashes <= req.count : d.crashes >= req.count;
    case 'arenaWins':
      return d.arenaWins >= req.count;
    case 'unobserved':
      return ctx.unobserved;
  }
}

export interface EvolutionOption {
  form: string;
  name: string;
  level: number;
  hidden: boolean;
  /** Hidden requirements become public once anyone has met them. */
  revealed: boolean;
  /** Level reached and every requirement satisfied. */
  met: boolean;
  /** Requirements to show (null while hidden and unrevealed). */
  requirement: readonly Requirement[] | null;
}

/** Every form the daemon's species can evolve into, with requirement status. */
export function evolutionOptions(d: EvolvableDaemon, ctx: EvolutionContext): EvolutionOption[] {
  return evolutionsOf(d.species).map((form) => {
    const reqs = form.requirement ?? [];
    const revealed = !form.hidden || ctx.discovered.has(form.id);
    const met = d.level >= (form.evolvesAt ?? Infinity) && reqs.every((r) => requirementMet(r, d, ctx));
    return { form: form.id, name: form.name, level: form.evolvesAt ?? 0, hidden: form.hidden, revealed, met, requirement: revealed ? reqs : null };
  });
}

export type EvolutionChange =
  | { kind: 'iv'; stat: (typeof STAT_KEYS)[number]; from: number; to: number }
  | { kind: 'clean' }
  | { kind: 'signature'; from: number; to: number; bonusStat: (typeof STAT_KEYS)[number] }
  | { kind: 'consumed'; item: string };

export interface EvolutionResult {
  species: string;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  heldItem: string | null;
  moves: string[];
  /** New max HP; the caller scales current HP by the same fraction. */
  maxHp: number;
  changes: EvolutionChange[];
}

export const SIGNATURE_UPGRADE_CHANCE = 1 / 256;

/**
 * Game design §7.1, in order: IV growth (each IV below 31 gains +1 with p = ½), the clean check (all 31
 * and not patched → clean, entering at T0), the signature upgrade (clean → 1/256 chance of +1 tier with
 * +1 bonus on a random stat), then the species change. Consumes a held evolution item the branch requires.
 */
export function applyEvolution(d: EvolvableDaemon, formId: string, rng: Rng, chances = { iv: 0.5, signature: SIGNATURE_UPGRADE_CHANCE }): EvolutionResult {
  const form: SpeciesDef = getSpecies(formId);
  if (form.evolvesFrom !== d.species) throw new RangeError(`${formId} does not evolve from ${d.species}`);
  const changes: EvolutionChange[] = [];
  const ivs = { ...d.ivs };
  for (const k of STAT_KEYS) {
    if (ivs[k] < MAX_IV && rng.chance(chances.iv)) {
      changes.push({ kind: 'iv', stat: k, from: ivs[k], to: ivs[k] + 1 });
      ivs[k]++;
    }
  }
  let clean = d.clean;
  if (!clean && !d.patched && STAT_KEYS.every((k) => ivs[k] === MAX_IV)) {
    clean = true;
    changes.push({ kind: 'clean' });
  }
  let signature = d.signature;
  const bonus = { ...d.bonus };
  if (clean && signature < SIGNATURE_MAX && rng.chance(chances.signature)) {
    const bonusStat = rng.pick(STAT_KEYS);
    bonus[bonusStat]++;
    changes.push({ kind: 'signature', from: signature, to: signature + 1, bonusStat });
    signature++;
  }
  let heldItem = d.heldItem;
  const consumed = (form.requirement ?? []).find((r) => r.kind === 'heldItem');
  if (consumed && consumed.kind === 'heldItem' && heldItem === consumed.item) {
    heldItem = null;
    changes.push({ kind: 'consumed', item: consumed.item });
  }
  const maxHp = computeStats({ base: form.base, ivs, bonus, level: d.level, nature: d.nature }).hp;
  return { species: form.id, ivs, bonus, clean, signature, heldItem, moves: movesAtLevel(form, d.level), maxHp, changes };
}

export function emptyMoveTypeUses(): number[] {
  return TYPES.map(() => 0);
}

export function typeIndex(type: TypeId): number {
  return TYPES.indexOf(type);
}

export const ZERO_BLOCK = statBlock(0);
```

Add `export * from './evolution.js';` to `packages/rules/src/index.ts` (after the `spawn.js` line).

- [ ] **Step 4: Fix the capture-test mutation for empty numeric arrays**

In `packages/rules/test/capture.test.ts`, inside `mutate`, the array branch appended `'x'` when the array was empty (an empty `leaked: []` from the heap family then failed schema validation instead of being *wrong*). Replace

```ts
    return { [key]: [...value, typeof value[0] === 'number' ? 1 : 'x'] };
```

with

```ts
    return { [key]: [...value, key === 'output' ? 'x' : 1] };
```

(`output` — the shell family — is the only string-array answer.)

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules` — expected: all green (evolution 7 tests; 248 in the whole repo).

- [ ] **Step 6: Commit**

```bash
git add packages/rules
git commit -m "feat(rules): evolution options, requirement evaluation and applyEvolution"
```

---

### Task 2: Evolution in the sim — schema, protocol, model, intents, commands, stores

Everything needed for a daemon to evolve end to end (rules → command → intent → store → events), plus `hold` / `unhold` / Bit Flipper and the persistence of the new fields. Trait *effects* come in Task 3; this task only adds the fields they read.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000002_sp3a_evolution/migration.sql`
- Modify: `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/core/systems/capture.ts`
- Create: `apps/sim/src/core/systems/evolve.ts`
- Modify: `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/src/runtime/main.ts`
- Tests: create `apps/sim/test/evolve.test.ts`; modify `apps/sim/test/helpers.ts`, `apps/sim/test/store.test.ts`, `apps/sim/test/integration.test.ts`

**Interfaces:**
- Protocol commands: `evolve { daemonId, formId }`, `hold { daemonId, itemId }`, `unhold { daemonId }`, `useItem { item: 'restore' | 'bitflipper', daemonId, stat? }`. Events: `evolved { daemon, from, to, changes }` (private), `discovery { form, operator, operatorName }` (everyone). `RamDaemon` gains `heldItem, patched, moveTypeUses[16], crashes, evolutions[{ form, name, level, hidden, revealed, met, requirement | null }]`.
- Model: `HistoryEntry { at: string; kind: 'captured' | 'evolved' | 'clean' | 'signature' | 'patched'; detail }`, `Engagement { freeMove, blocked, survived, lastHitMove }` + `freshEngagement()`; `OwnedDaemonRecord` gains `heldItem, patched, moveTypeUses, crashes, arenaWins, history, originalOperatorId`; `Daemon` gains the same plus `trait: string` and `engagement`; `Intent` gains `evolve { daemonId, from, to, ivs, bonus, clean, signature, heldItem, moves, hp, changes, history }`; `IntentResult.discovered?: boolean`.
- World: options `discovered?: Iterable<string>`, `clock?: () => string`; fields `discovered: Set<string>`, `now()`.
- Store: `listDiscoveries(): Promise<string[]>`; `applyIntent` handles `evolve` (idempotent; `ok: false, reason: 'daemon not found'` when the row is missing, elsewhere, or no longer the `from` species; `discovered` = first `Discovery` row for the form).
- Sim: `evolutionContext(world, op, d)`, `evolve(world, op, d, formId, input, out)`, `completeEvolveIntent(world, op, intent, result, out)` in `systems/evolve.ts`.

- [ ] **Step 1: Schema and migration**

In `packages/db/prisma/schema.prisma`, add to `model Daemon` right after `slot Int`:

```prisma
  heldItem           String?
  patched            Boolean  @default(false)
  /// lifetime move uses per type, TYPES order (16)
  moveTypeUses       Int[]
  crashes            Int      @default(0)
  arenaWins          Int      @default(0)
  /// [{ at, kind: captured|evolved|clean|signature|patched, detail }]
  history            Json     @default("[]")
```

and add before `model AppliedAction`:

```prisma
/// First operator to meet a hidden evolution requirement (reveals it in the Codex).
model Discovery {
  formId       String   @id
  operatorId   String
  discoveredAt DateTime @default(now())
}
```

Create `packages/db/prisma/migrations/20260930000002_sp3a_evolution/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Daemon" ADD COLUMN     "arenaWins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "crashes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "heldItem" TEXT,
ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "moveTypeUses" INTEGER[],
ADD COLUMN     "patched" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Discovery" (
    "formId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discovery_pkey" PRIMARY KEY ("formId")
);
```

Run (with `DATABASE_URL` set to a dev database): `pnpm --filter @daemonet/db exec prisma migrate deploy && pnpm --filter @daemonet/db exec prisma generate`.

- [ ] **Step 2: Protocol**

In `packages/shared/src/protocol.ts`:

1. Replace the `useItem` command with
   ```ts
     z.object({
       cmd: z.literal('useItem'),
       actor: Self,
       args: z.object({ item: z.enum(['restore', 'bitflipper']), daemonId: Id, stat: z.enum(['hp', 'attack', 'defense', 'focus', 'resolve', 'speed', 'haste', 'energy']).optional() }),
     }),
     z.object({ cmd: z.literal('evolve'), actor: Self, args: z.object({ daemonId: Id, formId: Id }) }),
     z.object({ cmd: z.literal('hold'), actor: Self, args: z.object({ daemonId: Id, itemId: Id }) }),
     z.object({ cmd: z.literal('unhold'), actor: Self, args: z.object({ daemonId: Id }) }),
   ```
2. In `RamDaemon`, after `cooldowns`:
   ```ts
     heldItem: z.string().nullable(),
     patched: z.boolean(),
     /** lifetime move uses per type, TYPES order */
     moveTypeUses: z.array(z.number().int()).length(16),
     crashes: z.number().int(),
     evolutions: z.array(
       z.object({
         form: Id,
         name: z.string(),
         level: z.number().int(),
         hidden: z.boolean(),
         revealed: z.boolean(),
         met: z.boolean(),
         requirement: z.array(z.unknown()).nullable(),
       }),
     ),
   ```
3. Append to `GameEvent` after the `swap` event:
   ```ts
     z.object({ e: z.literal('evolved'), daemon: Id, from: Id, to: Id, changes: z.array(z.unknown()) }),
     z.object({ e: z.literal('discovery'), form: Id, operator: Id, operatorName: z.string().nullable() }),
   ```

- [ ] **Step 3: SDK**

In `packages/sdk/src/client.ts`, import `type StatKey` from `@daemonet/rules` (alongside `getMove, typeMultiplier, type ToolId`) and add to `OperatorApi` after `useRestore`:

```ts
  /** Raises one IV by 1 (cap 31) and marks the daemon patched forever. */
  useBitFlipper(daemonId: string, stat: StatKey) {
    return this.client.command({ cmd: 'useItem', actor: 'self', args: { item: 'bitflipper', daemonId, stat } });
  }
  evolve(daemonId: string, formId: string) {
    return this.client.command({ cmd: 'evolve', actor: 'self', args: { daemonId, formId } });
  }
  hold(daemonId: string, itemId: string) {
    return this.client.command({ cmd: 'hold', actor: 'self', args: { daemonId, itemId } });
  }
  unhold(daemonId: string) {
    return this.client.command({ cmd: 'unhold', actor: 'self', args: { daemonId } });
  }
```

`ram.evolutions` and the two new events need no SDK code: `RamDaemon` flows through `self`, and every server event is re-emitted by name.

- [ ] **Step 4: Model**

Replace `apps/sim/src/core/model.ts`:

```ts
import type { Behaviour, EvolutionChange, StatBlock, StatusId, ToolId, TypeId, Challenge } from '@daemonet/rules';
import type { Command, ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';

/** One line of a daemon's life story (SP3a spec §7). `at` is an ISO timestamp. */
export interface HistoryEntry {
  at: string;
  kind: 'captured' | 'evolved' | 'clean' | 'signature' | 'patched';
  detail: string;
}

/** A daemon as persisted (RAM or Disk). Arrays are in STAT_KEYS order. */
export interface OwnedDaemonRecord {
  id: string;
  species: string;
  level: number;
  xp: number;
  nature: number;
  traitSlot: 0 | 1;
  ivs: number[];
  bonus: number[];
  clean: boolean;
  signature: number;
  hp: number;
  energy: number;
  moves: string[];
  crashed: boolean;
  /** RAM slot 0-7. */
  slot: number;
  heldItem: string | null;
  /** Ever touched by a Bit Flipper: can never become a clean image. */
  patched: boolean;
  /** Lifetime move uses per type, TYPES order (16). */
  moveTypeUses: number[];
  crashes: number;
  arenaWins: number;
  history: HistoryEntry[];
  originalOperatorId: string | null;
}

/** What the runtime loads from the DB when an operator connects. */
export interface OperatorRecord {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  x: number;
  y: number;
  bits: number;
  inventory: Record<string, number>;
  ram: OwnedDaemonRecord[];
  /** Occupied Disk slots (0-255). */
  diskSlots: number[];
}

export interface WildState {
  behaviour: Behaviour;
  region: number;
  spawnIndex: number;
  tagOwner: string | null;
  tagUntil: number;
  hardenedUntil: number;
  /** Id of the entity (daemon or operator) this wild daemon is attacking. */
  aggro: string | null;
  fleeUntil: number;
  /** Owned daemon ids that damaged it while tagged (for XP). */
  damagedBy: Set<string>;
}

export interface Daemon {
  id: string;
  species: string;
  types: readonly TypeId[];
  level: number;
  xp: number;
  nature: number;
  traitSlot: 0 | 1;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  moves: string[];
  stats: StatBlock;
  hp: number;
  energy: number;
  crashed: boolean;
  /** null = wild. */
  ownerId: string | null;
  /** RAM slot for owned daemons. */
  slot: number;
  /** In the world (wild, or owned and running). */
  active: boolean;
  x: number;
  y: number;
  path: Point[];
  /** move id -> tick when ready. */
  cooldowns: Record<string, number>;
  statuses: Partial<Record<StatusId, number>>;
  lastCombatTick: number;
  /** Owned daemon locked by a pending store or evolve intent. */
  pending: boolean;
  wild: WildState | null;
  /** Trait id (ROLE_TRAITS[species.role][traitSlot]). */
  trait: string;
  heldItem: string | null;
  patched: boolean;
  moveTypeUses: number[];
  crashes: number;
  arenaWins: number;
  history: HistoryEntry[];
  originalOperatorId: string | null;
  /** Per-engagement trait state; reset when the daemon activates or a battle starts. */
  engagement: Engagement;
}

export interface Engagement {
  /** lowlatency: next move ignores its cooldown. */
  freeMove: boolean;
  /** bitshield: the first hit has been blocked. */
  blocked: boolean;
  /** nullsafe: the lethal hit has been survived. */
  survived: boolean;
  /** salted: move id of the last hit taken. */
  lastHitMove: string | null;
}

export function freshEngagement(): Engagement {
  return { freeMove: true, blocked: false, survived: false, lastHitMove: null };
}

export interface Operator {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  x: number;
  y: number;
  path: Point[];
  bits: number;
  inventory: Record<string, number>;
  /** Daemon ids in RAM (owned daemons live in World.daemons). */
  ram: string[];
  running: string[];
  diskSlots: Set<number>;
  /** RAM slots reserved by pending load intents. */
  reservedSlots: Set<number>;
  swapReadyTick: number;
  captureId: string | null;
  restoreUntil: number | null;
  hitTick: number;
  pendingClaim: boolean;
}

export interface Capture {
  id: string;
  operatorId: string;
  targetId: string;
  tool: ToolId;
  challenge: Challenge;
  deadlineTick: number;
  state: 'open' | 'committing';
}

export interface CaptureLog {
  originalOperatorId: string;
  capturedAtTick: number;
  subnet: string;
  tool: ToolId | 'starter';
  seedId: string;
  spawnIndex: number | null;
}

export type Intent =
  | { id: string; kind: 'claimStarter'; operatorId: string; reqId: string; name: string; daemon: OwnedDaemonRecord; inventory: Record<string, number>; log: CaptureLog }
  | { id: string; kind: 'capture'; operatorId: string; captureId: string; daemon: OwnedDaemonRecord; location: 'RAM' | 'DISK'; tool: ToolId; log: CaptureLog }
  | { id: string; kind: 'store'; operatorId: string; reqId: string; daemonId: string; diskSlot: number }
  | { id: string; kind: 'load'; operatorId: string; reqId: string; daemonId: string; ramSlot: number }
  | {
      id: string;
      kind: 'evolve';
      operatorId: string;
      reqId: string;
      daemonId: string;
      from: string;
      to: string;
      ivs: number[];
      bonus: number[];
      clean: boolean;
      signature: number;
      heldItem: string | null;
      moves: string[];
      hp: number;
      changes: EvolutionChange[];
      history: HistoryEntry[];
    };

/** `discovered`: an evolve intent created the first Discovery row for its form. */
export type IntentResult = { ok: true; daemon?: OwnedDaemonRecord; discovered?: boolean } | { ok: false; reason: string };

export interface Input {
  operatorId: string;
  reqId: string;
  command: Command;
}

export type Reply =
  | { operatorId: string; reqId: string; ok: true; result?: unknown }
  | { operatorId: string; reqId: string; ok: false; code: ErrorCode; message: string };

/** `to` = one operator only; otherwise public: everyone within interest radius of `at`, or everyone if `at` is null. */
export interface ScopedEvent {
  event: GameEvent;
  to: string | null;
  at: Point | null;
}

export interface StepResult {
  tick: number;
  events: ScopedEvent[];
  replies: Reply[];
  intents: Intent[];
}

export class Rejection extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
```

- [ ] **Step 5: World**

Replace `apps/sim/src/core/world.ts`:

```ts
import {
  DEFAULT_ODDS,
  RAM_SLOTS,
  emptyMoveTypeUses,
  computeStats,
  createRng,
  getSpecies,
  msToTicks,
  movesAtLevel,
  statBlockFromArray,
  statBlockToArray,
  xpForLevel,
  type Rng,
  type SpawnOdds,
  type SpawnRoll,
  type SubnetDef,
} from '@daemonet/rules';
import { Grid, type Point } from './grid.js';
import { freshEngagement, type Capture, type Daemon, type Input, type Intent, type IntentResult, type Operator, type OperatorRecord, type OwnedDaemonRecord, type StepResult } from './model.js';
import { Out } from './out.js';
import { planWild } from './systems/ai.js';
import { executeQueuedUses, type QueuedUse } from './systems/combat.js';
import { handleCommands } from './systems/commands.js';
import { completeCaptureIntent, progressCaptures } from './systems/capture.js';
import { completeEvolveIntent } from './systems/evolve.js';
import { moveAll } from './systems/movement.js';
import { resolveDefeats } from './systems/progress.js';
import { runSpawner } from './systems/spawner.js';
import { upkeep } from './systems/upkeep.js';
import { toRamDaemon } from './view.js';

export interface WorldOptions {
  subnet: SubnetDef;
  /** Seeds the world RNG. */
  seed: string;
  /** Short id of this seed row (SubnetSeed.id); prefixes generated ids. */
  seedId: string;
  /** Run the wild spawner (default true). Tests turn it off and place wilds by hand. */
  spawner?: boolean;
  /** Spawn odds (tests only). */
  odds?: SpawnOdds;
  /** Form ids already discovered server-wide (loaded from the store at boot). */
  discovered?: Iterable<string>;
  /** Wall-clock ISO timestamp for history entries (tests inject a fixed one). */
  clock?: () => string;
}

export class World {
  readonly subnet: SubnetDef;
  readonly grid: Grid;
  readonly rng: Rng;
  readonly seedId: string;
  readonly odds: SpawnOdds;
  readonly spawnerEnabled: boolean;
  tick = 0;
  spawnIndex = 0;
  readonly operators = new Map<string, Operator>();
  /** Wild daemons and the RAM daemons of connected operators. */
  readonly daemons = new Map<string, Daemon>();
  readonly captures = new Map<string, Capture>();
  readonly regionCounts: number[];
  readonly nextSpawnTick: number[];
  /** Evolution forms whose first evolution has been recorded (hidden requirements are revealed). */
  readonly discovered: Set<string>;
  readonly now: () => string;
  queuedUses: QueuedUse[] = [];
  private readonly pending = new Map<string, Intent>();
  private counter = 0;
  private carry = new Out();

  constructor(opts: WorldOptions) {
    this.subnet = opts.subnet;
    this.grid = new Grid(opts.subnet);
    this.rng = createRng(opts.seed);
    this.seedId = opts.seedId.slice(0, 8);
    this.odds = opts.odds ?? DEFAULT_ODDS;
    this.spawnerEnabled = opts.spawner ?? true;
    this.regionCounts = opts.subnet.regions.map(() => 0);
    this.nextSpawnTick = opts.subnet.regions.map(() => 0);
    this.discovered = new Set(opts.discovered ?? []);
    this.now = opts.clock ?? (() => new Date().toISOString());
    if (this.spawnerEnabled) runSpawner(this, this.carry, true);
  }

  newId(prefix: string): string {
    return `${this.seedId}-${prefix}${++this.counter}`;
  }

  ticks(ms: number): number {
    return msToTicks(ms);
  }

  // ---- operators ----

  addOperator(rec: OperatorRecord): Operator {
    const pos = this.grid.isWalkablePoint(rec) ? { x: rec.x, y: rec.y } : { ...this.subnet.spawn };
    const op: Operator = {
      id: rec.id,
      name: rec.name,
      starterClaimed: rec.starterClaimed,
      x: pos.x,
      y: pos.y,
      path: [],
      bits: rec.bits,
      inventory: { ...rec.inventory },
      ram: [],
      running: [],
      diskSlots: new Set(rec.diskSlots),
      reservedSlots: new Set(),
      swapReadyTick: 0,
      captureId: null,
      restoreUntil: null,
      hitTick: -1,
      pendingClaim: false,
    };
    this.operators.set(op.id, op);
    for (const d of [...rec.ram].sort((a, b) => a.slot - b.slot)) this.addOwned(op, d);
    return op;
  }

  removeOperator(id: string): void {
    const op = this.operators.get(id);
    if (!op) return;
    if (op.captureId) this.captures.delete(op.captureId);
    for (const d of op.ram) this.daemons.delete(d);
    this.operators.delete(id);
  }

  checkpoint(operatorId: string): OperatorRecord {
    const op = this.operators.get(operatorId);
    if (!op) throw new RangeError(`unknown operator ${operatorId}`);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: op.bits,
      inventory: { ...op.inventory },
      ram: op.ram.map((id) => this.toRecord(this.daemons.get(id)!)),
      diskSlots: [...op.diskSlots].sort((a, b) => a - b),
    };
  }

  // ---- daemons ----

  private makeDaemon(species: string, level: number, fields: Omit<Daemon, 'species' | 'types' | 'level' | 'stats' | 'trait' | 'engagement'>): Daemon {
    const sp = getSpecies(species);
    const stats = computeStats({ base: sp.base, ivs: fields.ivs, bonus: fields.bonus, level, nature: fields.nature });
    return { ...fields, species, types: sp.types, level, stats, trait: sp.traits[fields.traitSlot], engagement: freshEngagement() };
  }

  addOwned(op: Operator, rec: OwnedDaemonRecord): Daemon {
    const d = this.makeDaemon(rec.species, rec.level, {
      id: rec.id,
      xp: rec.xp,
      nature: rec.nature,
      traitSlot: rec.traitSlot,
      ivs: statBlockFromArray(rec.ivs),
      bonus: statBlockFromArray(rec.bonus),
      clean: rec.clean,
      signature: rec.signature,
      moves: [...rec.moves],
      hp: rec.hp,
      energy: rec.energy,
      crashed: rec.crashed,
      ownerId: op.id,
      slot: rec.slot,
      active: false,
      x: op.x,
      y: op.y,
      path: [],
      cooldowns: {},
      statuses: {},
      lastCombatTick: -Infinity,
      pending: false,
      wild: null,
      heldItem: rec.heldItem,
      patched: rec.patched,
      moveTypeUses: [...rec.moveTypeUses],
      crashes: rec.crashes,
      arenaWins: rec.arenaWins,
      history: rec.history.map((h) => ({ ...h })),
      originalOperatorId: rec.originalOperatorId,
    });
    this.daemons.set(d.id, d);
    op.ram.push(d.id);
    return d;
  }

  toRecord(d: Daemon): OwnedDaemonRecord {
    return {
      id: d.id,
      species: d.species,
      level: d.level,
      xp: d.xp,
      nature: d.nature,
      traitSlot: d.traitSlot,
      ivs: statBlockToArray(d.ivs),
      bonus: statBlockToArray(d.bonus),
      clean: d.clean,
      signature: d.signature,
      hp: Math.max(0, Math.floor(d.hp)),
      energy: Math.floor(d.energy),
      moves: [...d.moves],
      crashed: d.crashed,
      slot: d.slot,
      heldItem: d.heldItem,
      patched: d.patched,
      moveTypeUses: [...d.moveTypeUses],
      crashes: d.crashes,
      arenaWins: d.arenaWins,
      history: d.history.map((h) => ({ ...h })),
      originalOperatorId: d.originalOperatorId,
    };
  }

  /** Place a wild daemon. `region` -1 = not owned by any spawn region (tests). */
  spawnWild(species: string, level: number, pos: Point, region: number, roll: SpawnRoll): Daemon {
    const sp = getSpecies(species);
    const d = this.makeDaemon(species, level, {
      id: this.newId('w'),
      xp: xpForLevel(level),
      nature: roll.nature,
      traitSlot: roll.traitSlot,
      ivs: roll.ivs,
      bonus: roll.bonus,
      clean: roll.clean,
      signature: roll.signature,
      moves: movesAtLevel(sp, level),
      hp: 0,
      energy: 128,
      crashed: false,
      ownerId: null,
      slot: -1,
      active: true,
      x: pos.x,
      y: pos.y,
      path: [],
      cooldowns: {},
      statuses: {},
      lastCombatTick: -Infinity,
      pending: false,
      heldItem: null,
      patched: false,
      moveTypeUses: emptyMoveTypeUses(),
      crashes: 0,
      arenaWins: 0,
      history: [],
      originalOperatorId: null,
      wild: {
        behaviour: sp.behaviour,
        region,
        spawnIndex: this.spawnIndex++,
        tagOwner: null,
        tagUntil: 0,
        hardenedUntil: 0,
        aggro: null,
        fleeUntil: 0,
        damagedBy: new Set(),
      },
    });
    d.hp = d.stats.hp;
    this.daemons.set(d.id, d);
    if (region >= 0) this.regionCounts[region]!++;
    return d;
  }

  removeDaemon(id: string): void {
    const d = this.daemons.get(id);
    if (!d) return;
    this.daemons.delete(id);
    if (d.wild && d.wild.region >= 0) this.regionCounts[d.wild.region]!--;
    if (d.ownerId) {
      const op = this.operators.get(d.ownerId);
      if (op) {
        op.ram = op.ram.filter((x) => x !== id);
        op.running = op.running.filter((x) => x !== id);
      }
    }
  }

  activate(d: Daemon, op: Operator): void {
    d.active = true;
    d.engagement = freshEngagement();
    d.x = op.x;
    d.y = op.y;
    d.path = [];
    op.running.push(d.id);
  }

  deactivate(d: Daemon): void {
    d.active = false;
    d.path = [];
    const op = d.ownerId ? this.operators.get(d.ownerId) : undefined;
    if (op) op.running = op.running.filter((x) => x !== d.id);
  }

  freeRamSlot(op: Operator): number | null {
    const used = new Set([...op.ram.map((id) => this.daemons.get(id)!.slot), ...op.reservedSlots]);
    for (let s = 0; s < RAM_SLOTS; s++) if (!used.has(s)) return s;
    return null;
  }

  /** Resolves an entity id to a position (daemon or operator). */
  locate(id: string): Point | null {
    const d = this.daemons.get(id);
    if (d) return d.active ? d : null;
    return this.operators.get(id) ?? null;
  }

  // ---- intents ----

  trackIntent(intent: Intent, out: Out): void {
    this.pending.set(intent.id, intent);
    out.intent(intent);
  }

  completeIntent(id: string, result: IntentResult): void {
    const intent = this.pending.get(id);
    if (!intent) throw new RangeError(`unknown intent ${id}`);
    this.pending.delete(id);
    const out = this.carry;
    const op = this.operators.get(intent.operatorId);
    if (!op) return;
    switch (intent.kind) {
      case 'claimStarter': {
        op.pendingClaim = false;
        if (!result.ok) return out.fail(intent, 'E_STATE', result.reason);
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.addOwned(op, intent.daemon);
        return out.ok(intent, { daemonId: intent.daemon.id });
      }
      case 'capture':
        return completeCaptureIntent(this, op, intent, result, out);
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!result.ok) {
          if (d) d.pending = false;
          op.diskSlots.delete(intent.diskSlot);
          return out.fail(intent, 'E_STATE', result.reason);
        }
        this.removeDaemon(intent.daemonId);
        return out.ok(intent);
      }
      case 'load': {
        op.reservedSlots.delete(intent.ramSlot);
        if (!result.ok || !result.daemon) return out.fail(intent, 'E_STATE', result.ok ? 'missing daemon' : result.reason);
        const rec = { ...result.daemon, slot: intent.ramSlot };
        this.addOwned(op, rec);
        return out.ok(intent, { daemon: toRamDaemon(this, this.daemons.get(rec.id)!) });
      }
      case 'evolve':
        return completeEvolveIntent(this, op, intent, result, out);
    }
  }

  // ---- the tick ----

  step(inputs: readonly Input[]): StepResult {
    this.tick++;
    const out = this.carry;
    this.carry = new Out();
    handleCommands(this, inputs, out);
    moveAll(this);
    const wildUses = planWild(this);
    executeQueuedUses(this, [...this.queuedUses, ...wildUses], out);
    this.queuedUses = [];
    resolveDefeats(this, out);
    progressCaptures(this, out);
    if (this.spawnerEnabled) runSpawner(this, out, false);
    upkeep(this, out);
    return { tick: this.tick, events: out.events, replies: out.replies, intents: out.intents };
  }
}
```

- [ ] **Step 6: The evolve system**

Create `apps/sim/src/core/systems/evolve.ts`:

```ts
import { applyEvolution, computeStats, evolutionOptions, getSpecies, statBlockFromArray, statBlockToArray, type EvolutionContext } from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, type Daemon, type HistoryEntry, type Input, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import { INTEREST_RADIUS } from '../view.js';
import type { World } from '../world.js';

/** What requirement checks see for `d` right now. */
export function evolutionContext(world: World, op: Operator, d: Daemon): EvolutionContext {
  let unobserved = true;
  for (const other of world.operators.values()) {
    if (other.id !== op.id && distance(other, op) <= INTEREST_RADIUS) {
      unobserved = false;
      break;
    }
  }
  return { subnet: world.subnet.id, unobserved, originalOperator: d.originalOperatorId === op.id, discovered: world.discovered };
}

/**
 * `evolve` command: the daemon must be in RAM and not running, the form must be one of its options with
 * the level reached and every requirement met. The outcome is rolled here and persisted as an intent;
 * the daemon changes only once the store confirms.
 */
export function evolve(world: World, op: Operator, d: Daemon, formId: string, input: Input, out: Out): void {
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
  const option = evolutionOptions(d, evolutionContext(world, op, d)).find((o) => o.form === formId);
  if (!option) throw new Rejection('E_INVALID', `${d.species} does not evolve into ${formId}`);
  if (d.level < option.level) throw new Rejection('E_STATE', `needs level ${option.level}`);
  if (!option.met) throw new Rejection('E_STATE', option.revealed ? 'requirement not met' : 'requirement unknown');

  const r = applyEvolution(d, formId, world.rng);
  const at = world.now();
  const history: HistoryEntry[] = [{ at, kind: 'evolved', detail: `${d.species} -> ${formId} at level ${d.level}` }];
  for (const c of r.changes) {
    if (c.kind === 'clean') history.push({ at, kind: 'clean', detail: 'all IVs reached 31 on evolution' });
    if (c.kind === 'signature') history.push({ at, kind: 'signature', detail: `T${c.from} -> T${c.to} (+1 ${c.bonusStat})` });
  }
  const hp = d.hp <= 0 ? 0 : Math.max(1, Math.round((r.maxHp * d.hp) / d.stats.hp));
  d.pending = true;
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'evolve',
      operatorId: op.id,
      reqId: input.reqId,
      daemonId: d.id,
      from: d.species,
      to: r.species,
      ivs: statBlockToArray(r.ivs),
      bonus: statBlockToArray(r.bonus),
      clean: r.clean,
      signature: r.signature,
      heldItem: r.heldItem,
      moves: r.moves,
      hp,
      changes: r.changes,
      history,
    },
    out,
  );
}

export function completeEvolveIntent(world: World, op: Operator, intent: Extract<Intent, { kind: 'evolve' }>, result: IntentResult, out: Out): void {
  const d = world.daemons.get(intent.daemonId);
  if (d) d.pending = false;
  if (!result.ok) return out.fail(intent, 'E_STATE', result.reason);
  if (result.discovered) {
    world.discovered.add(intent.to);
    out.emit({ e: 'discovery', form: intent.to, operator: op.id, operatorName: op.name }, { at: null });
  }
  if (!d) return;
  const sp = getSpecies(intent.to);
  d.species = sp.id;
  d.types = sp.types;
  d.ivs = statBlockFromArray(intent.ivs);
  d.bonus = statBlockFromArray(intent.bonus);
  d.clean = intent.clean;
  d.signature = intent.signature;
  d.heldItem = intent.heldItem;
  d.moves = [...intent.moves];
  d.trait = sp.traits[d.traitSlot];
  d.stats = computeStats({ base: sp.base, ivs: d.ivs, bonus: d.bonus, level: d.level, nature: d.nature });
  d.hp = Math.min(intent.hp, d.stats.hp);
  d.cooldowns = {};
  d.history.push(...intent.history);
  out.emit({ e: 'evolved', daemon: d.id, from: intent.from, to: intent.to, changes: intent.changes }, { to: op.id });
  return out.ok(intent, { species: d.species, changes: intent.changes });
}
```

- [ ] **Step 7: Commands (hold, unhold, evolve, Bit Flipper, starter record)**

Replace `apps/sim/src/core/systems/commands.ts`:

```ts
import {
  DISK_SLOTS,
  MAX_IV,
  RUNNING_MAX,
  STARTING_INVENTORY,
  SWAP_COOLDOWN_MS,
  computeStats,
  emptyMoveTypeUses,
  getSpecies,
  isHoldable,
  movesAtLevel,
  rollSpawn,
  statBlockToArray,
  xpForLevel,
} from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { distance, type Point } from '../grid.js';
import { Rejection, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { startCapture, submitCapture } from './capture.js';
import { evolve } from './evolve.js';
import { restoreDaemon } from './upkeep.js';

export const LEASH_TILES = 8;
export const HOST_RADIUS = 2;
export const OUT_OF_COMBAT_MS = 4096;
export const RESTORE_CHANNEL_MS = 2048;
export const STARTER_LEVEL = 5;

type Cmd<N extends Command['cmd']> = Extract<Command, { cmd: N }>;

export function handleCommands(world: World, inputs: readonly Input[], out: Out): void {
  for (const input of inputs) {
    try {
      handle(world, input, out);
    } catch (err) {
      if (err instanceof Rejection) out.fail(input, err.code, err.message);
      else throw err;
    }
  }
}

function ownedDaemon(world: World, op: Operator, id: string): Daemon {
  const d = world.daemons.get(id);
  if (!d || d.ownerId !== op.id) throw new Rejection('E_STATE', `no daemon ${id} in RAM`);
  return d;
}

function runningDaemon(world: World, op: Operator, id: string): Daemon {
  const d = ownedDaemon(world, op, id);
  if (!d.active) throw new Rejection('E_STATE', `daemon ${id} is not running`);
  return d;
}

function requireAtHost(world: World, op: Operator): void {
  if (distance(op, world.subnet.host) > HOST_RADIUS) throw new Rejection('E_RANGE', 'must be at the host node');
}

function requireSwapReady(world: World, op: Operator): void {
  if (world.tick < op.swapReadyTick) throw new Rejection('E_COOLDOWN', 'swap is cooling down');
}

function pathTo(world: World, from: Point, to: Point): Point[] {
  const path = world.grid.findPath(from, to);
  if (!path) throw new Rejection('E_STATE', 'destination unreachable');
  return path;
}

function handle(world: World, input: Input, out: Out): void {
  const op = world.operators.get(input.operatorId);
  if (!op) throw new Rejection('E_STATE', 'operator is not in the world');
  const c = input.command;
  if (!op.starterClaimed && !['claimStarter', 'moveTo', 'stop'].includes(c.cmd)) {
    throw new Rejection('E_STATE', 'claim a starter first');
  }
  switch (c.cmd) {
    case 'moveTo':
      return moveTo(world, op, c, input, out);
    case 'stop':
      if (c.actor === 'self') op.path = [];
      else runningDaemon(world, op, c.actor).path = [];
      return out.ok(input);
    case 'run': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.active) throw new Rejection('E_STATE', 'already running');
      if (d.crashed) throw new Rejection('E_STATE', 'daemon has crashed; restore it first');
      if (d.pending) throw new Rejection('E_STATE', 'daemon is being stored');
      if (op.running.length >= RUNNING_MAX) throw new Rejection('E_STATE', `at most ${RUNNING_MAX} daemons can run`);
      requireSwapReady(world, op);
      world.activate(d, op);
      op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
      return out.ok(input);
    }
    case 'recall': {
      const d = runningDaemon(world, op, c.args.daemonId);
      requireSwapReady(world, op);
      world.deactivate(d);
      op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
      return out.ok(input);
    }
    case 'swap':
      return swap(world, op, c, input, out);
    case 'capture':
      return out.ok(input, { captureId: startCapture(world, op, c.args, out) });
    case 'submitCapture':
      return out.ok(input, { status: submitCapture(world, op, c.args, out) });
    case 'useItem': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if ((op.inventory[c.args.item] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${c.args.item} left`);
      if (world.tick - d.lastCombatTick < world.ticks(OUT_OF_COMBAT_MS)) throw new Rejection('E_STATE', 'daemon is in combat');
      if (c.args.item === 'bitflipper') return bitFlip(world, op, d, c.args.stat, input, out);
      op.inventory.restore = (op.inventory.restore ?? 0) - 1;
      restoreDaemon(d);
      out.emit({ e: 'restored', daemons: [d.id] }, { to: op.id });
      return out.ok(input);
    }
    case 'hold': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (!isHoldable(c.args.itemId)) throw new Rejection('E_INVALID', `${c.args.itemId} cannot be held`);
      if ((op.inventory[c.args.itemId] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${c.args.itemId} left`);
      if (d.heldItem) op.inventory[d.heldItem] = (op.inventory[d.heldItem] ?? 0) + 1;
      op.inventory[c.args.itemId] = (op.inventory[c.args.itemId] ?? 0) - 1;
      d.heldItem = c.args.itemId;
      return out.ok(input);
    }
    case 'unhold': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (!d.heldItem) throw new Rejection('E_STATE', 'nothing held');
      op.inventory[d.heldItem] = (op.inventory[d.heldItem] ?? 0) + 1;
      d.heldItem = null;
      return out.ok(input);
    }
    case 'evolve':
      return evolve(world, op, ownedDaemon(world, op, c.args.daemonId), c.args.formId, input, out);
    case 'restoreAll':
      requireAtHost(world, op);
      op.path = [];
      op.restoreUntil = world.tick + world.ticks(RESTORE_CHANNEL_MS);
      return out.ok(input, { untilTick: op.restoreUntil });
    case 'claimStarter':
      return claimStarter(world, op, c, input, out);
    case 'store':
      return store(world, op, c, input, out);
    case 'load':
      return load(world, op, c, input, out);
    case 'use': {
      const d = runningDaemon(world, op, c.actor);
      if (!d.moves.includes(c.args.move)) throw new Rejection('E_INVALID', `daemon does not know ${c.args.move}`);
      world.queuedUses.push({ daemonId: d.id, move: c.args.move, aim: c.args, input });
      return;
    }
  }
}

/** Bit Flipper: +1 to one IV (cap 31); the daemon is patched for life and never rolls clean. */
function bitFlip(world: World, op: Operator, d: Daemon, stat: Cmd<'useItem'>['args']['stat'], input: Input, out: Out): void {
  if (!stat) throw new Rejection('E_INVALID', 'bitflipper needs a stat');
  if (d.ivs[stat] >= MAX_IV) throw new Rejection('E_STATE', `${stat} IV is already ${MAX_IV}`);
  if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
  op.inventory.bitflipper = (op.inventory.bitflipper ?? 0) - 1;
  d.ivs[stat]++;
  d.patched = true;
  const sp = getSpecies(d.species);
  const oldMax = d.stats.hp;
  d.stats = computeStats({ base: sp.base, ivs: d.ivs, bonus: d.bonus, level: d.level, nature: d.nature });
  d.hp = Math.min(d.stats.hp, d.hp + (d.stats.hp - oldMax));
  d.history.push({ at: world.now(), kind: 'patched', detail: `${stat} +1 (bitflipper)` });
  return out.ok(input, { ivs: statBlockToArray(d.ivs), patched: true });
}

function moveTo(world: World, op: Operator, c: Cmd<'moveTo'>, input: Input, out: Out): void {
  const dest = { x: c.args.x, y: c.args.y };
  if (c.actor === 'self') {
    op.path = pathTo(world, op, dest);
    op.restoreUntil = null;
    return out.ok(input);
  }
  const d = runningDaemon(world, op, c.actor);
  if ((d.statuses.stalled ?? 0) > world.tick) throw new Rejection('E_STATE', 'daemon is stalled');
  if (distance(dest, op) > LEASH_TILES) throw new Rejection('E_RANGE', `daemons stay within ${LEASH_TILES} tiles of their operator`);
  d.path = pathTo(world, d, dest);
  return out.ok(input);
}

function swap(world: World, op: Operator, c: Cmd<'swap'>, input: Input, out: Out): void {
  const outgoing = runningDaemon(world, op, c.args.outId);
  const incoming = ownedDaemon(world, op, c.args.inId);
  if (incoming.active) throw new Rejection('E_STATE', 'incoming daemon is already running');
  if (incoming.crashed) throw new Rejection('E_STATE', 'incoming daemon has crashed');
  if (incoming.pending) throw new Rejection('E_STATE', 'incoming daemon is being stored');
  requireSwapReady(world, op);
  world.deactivate(outgoing);
  world.activate(incoming, op);
  op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
  out.emit({ e: 'swap', out: outgoing.id, in: incoming.id }, { to: op.id });
  return out.ok(input);
}

function claimStarter(world: World, op: Operator, c: Cmd<'claimStarter'>, input: Input, out: Out): void {
  if (op.starterClaimed || op.pendingClaim) throw new Rejection('E_STATE', 'starter already claimed');
  let species;
  try {
    species = getSpecies(c.args.species);
  } catch {
    throw new Rejection('E_INVALID', 'unknown species');
  }
  if (!species.starter) throw new Rejection('E_INVALID', `${species.name} is not a starter`);
  const roll = rollSpawn(world.rng, { clean: 0, signatureStep: 0 });
  op.pendingClaim = true;
  const daemon = {
    id: world.newId('d'),
    species: species.id,
    level: STARTER_LEVEL,
    xp: xpForLevel(STARTER_LEVEL),
    nature: roll.nature,
    traitSlot: roll.traitSlot,
    ivs: statBlockToArray(roll.ivs),
    bonus: statBlockToArray(roll.bonus),
    clean: false,
    signature: 0,
    hp: computeStats({ base: species.base, ivs: roll.ivs, bonus: roll.bonus, level: STARTER_LEVEL, nature: roll.nature }).hp,
    energy: 128,
    moves: movesAtLevel(species, STARTER_LEVEL),
    crashed: false,
    slot: 0,
    heldItem: null,
    patched: false,
    moveTypeUses: emptyMoveTypeUses(),
    crashes: 0,
    arenaWins: 0,
    history: [{ at: world.now(), kind: 'captured' as const, detail: `starter on ${world.subnet.id}` }],
    originalOperatorId: op.id,
  };
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'claimStarter',
      operatorId: op.id,
      reqId: input.reqId,
      name: c.args.operatorName,
      daemon,
      inventory: { ...STARTING_INVENTORY } as Record<string, number>,
      log: { originalOperatorId: op.id, capturedAtTick: world.tick, subnet: world.subnet.id, tool: 'starter', seedId: world.seedId, spawnIndex: null },
    },
    out,
  );
}

function store(world: World, op: Operator, c: Cmd<'store'>, input: Input, out: Out): void {
  requireAtHost(world, op);
  const d = ownedDaemon(world, op, c.args.daemonId);
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'already being stored');
  let slot = -1;
  for (let s = 0; s < DISK_SLOTS; s++) {
    if (!op.diskSlots.has(s)) {
      slot = s;
      break;
    }
  }
  if (slot < 0) throw new Rejection('E_STATE', 'Disk is full');
  d.pending = true;
  op.diskSlots.add(slot);
  world.trackIntent({ id: world.newId('i'), kind: 'store', operatorId: op.id, reqId: input.reqId, daemonId: d.id, diskSlot: slot }, out);
}

function load(world: World, op: Operator, c: Cmd<'load'>, input: Input, out: Out): void {
  requireAtHost(world, op);
  if (world.daemons.has(c.args.daemonId)) throw new Rejection('E_STATE', 'daemon is already in RAM');
  const slot = world.freeRamSlot(op);
  if (slot === null) throw new Rejection('E_STATE', 'RAM is full');
  op.reservedSlots.add(slot);
  world.trackIntent({ id: world.newId('i'), kind: 'load', operatorId: op.id, reqId: input.reqId, daemonId: c.args.daemonId, ramSlot: slot }, out);
}
```

In `apps/sim/src/core/systems/capture.ts`, add `emptyMoveTypeUses,` to the `@daemonet/rules` import (after `checkAnswer,`) and extend the captured record inside `commitCapture` after `slot,`:

```ts
      heldItem: null,
      patched: false,
      moveTypeUses: emptyMoveTypeUses(),
      crashes: 0,
      arenaWins: 0,
      history: [{ at: world.now(), kind: 'captured', detail: `${cap.tool} on ${world.subnet.id}` }],
      originalOperatorId: op.id,
```

- [ ] **Step 8: View**

Replace `apps/sim/src/core/view.ts`:

```ts
import { evolutionOptions, statBlockToArray, type StatusId } from '@daemonet/rules';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import type { Daemon, Operator } from './model.js';
import { evolutionContext } from './systems/evolve.js';
import type { World } from './world.js';

export const INTEREST_RADIUS = 32;

const activeStatuses = (world: World, d: Daemon): StatusId[] =>
  (Object.entries(d.statuses) as Array<[StatusId, number]>).filter(([, until]) => until > world.tick).map(([s]) => s);

export function toDaemonEntity(world: World, d: Daemon): Entity {
  return {
    kind: 'daemon',
    id: d.id,
    species: d.species,
    types: [...d.types],
    level: d.level,
    x: d.x,
    y: d.y,
    hp: d.hp,
    maxHp: d.stats.hp,
    owner: d.ownerId,
    taggedBy: d.wild?.tagOwner ?? null,
    clean: d.clean,
    signature: d.signature,
    statuses: activeStatuses(world, d),
    hardened: (d.wild?.hardenedUntil ?? 0) > world.tick,
  };
}

export function toOperatorEntity(op: Operator): Entity {
  return { kind: 'operator', id: op.id, name: op.name, x: op.x, y: op.y };
}

export function toRamDaemon(world: World, d: Daemon): RamDaemon {
  const op = world.operators.get(d.ownerId!)!;
  return {
    id: d.id,
    species: d.species,
    level: d.level,
    xp: d.xp,
    nature: d.nature,
    traitSlot: d.traitSlot,
    ivs: statBlockToArray(d.ivs),
    bonus: statBlockToArray(d.bonus),
    clean: d.clean,
    signature: d.signature,
    hp: d.hp,
    maxHp: d.stats.hp,
    energy: d.energy,
    moves: [...d.moves],
    crashed: d.crashed,
    slot: d.slot,
    cooldowns: Object.fromEntries(Object.entries(d.cooldowns).filter(([, t]) => t > world.tick)),
    heldItem: d.heldItem,
    patched: d.patched,
    moveTypeUses: [...d.moveTypeUses],
    crashes: d.crashes,
    evolutions: evolutionOptions(d, evolutionContext(world, op, d)).map((o) => ({
      form: o.form,
      name: o.name,
      level: o.level,
      hidden: o.hidden,
      revealed: o.revealed,
      met: o.met,
      requirement: o.requirement ? [...o.requirement] : null,
    })),
  };
}

export function toSelf(world: World, op: Operator): OperatorSelf {
  const cap = op.captureId ? world.captures.get(op.captureId) : undefined;
  return {
    id: op.id,
    name: op.name,
    starterClaimed: op.starterClaimed,
    x: op.x,
    y: op.y,
    bits: op.bits,
    ram: op.ram.map((id) => toRamDaemon(world, world.daemons.get(id)!)).sort((a, b) => a.slot - b.slot),
    running: [...op.running],
    inventory: { ...op.inventory },
    swapReadyTick: op.swapReadyTick,
    capture: cap ? { captureId: cap.id, targetId: cap.targetId, deadlineTick: cap.deadlineTick } : null,
  };
}

/** Every operator and active daemon within `radius` of (x, y). */
export function entitiesNear(world: World, x: number, y: number, radius = INTEREST_RADIUS): Entity[] {
  const at = { x, y };
  const out: Entity[] = [];
  for (const op of world.operators.values()) if (distance(op, at) <= radius) out.push(toOperatorEntity(op));
  for (const d of world.daemons.values()) if (d.active && distance(d, at) <= radius) out.push(toDaemonEntity(world, d));
  return out;
}
```

- [ ] **Step 9: Stores**

Replace `apps/sim/src/runtime/store.ts`:

```ts
import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';

export interface IntentContext {
  seedId: string;
  /** For `store`: the daemon's current state, written along with the move to Disk. */
  storedDaemon?: OwnedDaemonRecord;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord>;
  /** Idempotent by intent.id. Domain failures (name taken, not on Disk) resolve with ok: false. */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  /** Form ids with a Discovery row (loaded once at boot into World.discovered). */
  listDiscoveries(): Promise<string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface MemDaemon extends OwnedDaemonRecord {
  operatorId: string;
  location: 'RAM' | 'DISK';
}

interface MemOperator {
  id: string;
  sub: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  x: number;
  y: number;
  inventory: Record<string, number>;
}

/** In-memory Store with the same semantics as PrismaStore. Used by tests and local development. */
export class MemoryStore implements Store {
  readonly operators = new Map<string, MemOperator>();
  readonly daemons = new Map<string, MemDaemon>();
  readonly applied = new Set<string>();
  readonly seeds: Array<{ id: string; seed: string; subnet: string }> = [];
  readonly discoveries = new Map<string, { operatorId: string; discoveredAt: string }>();
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, _subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, bits: 0, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: op.bits,
      inventory: { ...op.inventory },
      ram: mine.filter((d) => d.location === 'RAM').sort((a, b) => a.slot - b.slot).map(({ operatorId: _o, location: _l, ...rec }) => ({ ...rec })),
      diskSlots: mine.filter((d) => d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated store failure');
    }
    if (this.applied.has(intent.id)) {
      if (intent.kind === 'load') {
        const d = this.daemons.get(intent.daemonId)!;
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      return { ok: true };
    }
    const op = this.operators.get(intent.operatorId);
    if (!op) throw new Error(`unknown operator ${intent.operatorId}`);
    switch (intent.kind) {
      case 'claimStarter': {
        if ([...this.operators.values()].some((o) => o.name === intent.name && o.id !== op.id)) return { ok: false, reason: 'name taken' };
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: 'RAM' });
        break;
      }
      case 'capture':
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: intent.location });
        break;
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id) return { ok: false, reason: 'daemon not found' };
        Object.assign(d, ctx.storedDaemon ?? {}, { location: 'DISK', slot: intent.diskSlot });
        break;
      }
      case 'load': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'DISK') return { ok: false, reason: 'not on Disk' };
        d.location = 'RAM';
        d.slot = intent.ramSlot;
        this.applied.add(intent.id);
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      case 'evolve': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM' || d.species !== intent.from) return { ok: false, reason: 'daemon not found' };
        Object.assign(d, {
          species: intent.to, ivs: [...intent.ivs], bonus: [...intent.bonus], clean: intent.clean, signature: intent.signature,
          heldItem: intent.heldItem, moves: [...intent.moves], hp: intent.hp, history: [...d.history, ...intent.history],
        });
        let discovered = false;
        if (!this.discoveries.has(intent.to)) {
          this.discoveries.set(intent.to, { operatorId: op.id, discoveredAt: new Date().toISOString() });
          discovered = true;
        }
        this.applied.add(intent.id);
        return { ok: true, discovered };
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      Object.assign(op, { x: rec.x, y: rec.y, bits: rec.bits, inventory: { ...rec.inventory } });
      for (const d of rec.ram) {
        const row = this.daemons.get(d.id);
        if (row && row.operatorId === op.id) Object.assign(row, { ...d, location: 'RAM' as const });
      }
    }
  }

  async listDiscoveries(): Promise<string[]> {
    return [...this.discoveries.keys()];
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
```

Replace `apps/sim/src/runtime/prisma-store.ts`:

```ts
import { createPrisma, type Daemon as DaemonRow, type Prisma, type PrismaClient } from '@daemonet/db';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type IntentContext, type Store } from './store.js';

function toRecord(row: DaemonRow): OwnedDaemonRecord {
  return {
    id: row.id,
    species: row.species,
    level: row.level,
    xp: row.xp,
    nature: row.nature,
    traitSlot: row.traitSlot === 1 ? 1 : 0,
    ivs: row.ivs,
    bonus: row.bonus,
    clean: row.clean,
    signature: row.signature,
    hp: row.hp,
    energy: row.energy,
    moves: row.moves,
    crashed: row.crashed,
    slot: row.slot,
    heldItem: row.heldItem,
    patched: row.patched,
    moveTypeUses: row.moveTypeUses.length === 16 ? row.moveTypeUses : Array.from({ length: 16 }, (_, i) => row.moveTypeUses[i] ?? 0),
    crashes: row.crashes,
    arenaWins: row.arenaWins,
    history: Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : [],
    originalOperatorId: row.originalOperatorId,
  };
}

/** Prisma's Json input type has no room for plain interfaces; history entries are plain data. */
const json = (h: readonly HistoryEntry[]): Prisma.InputJsonValue => h as unknown as Prisma.InputJsonValue;

/** Everything a checkpoint (or store) writes back; identity and capture-log columns never change. */
function stateFields(d: OwnedDaemonRecord) {
  return {
    level: d.level, xp: d.xp, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed,
    ivs: d.ivs, patched: d.patched, heldItem: d.heldItem, moveTypeUses: d.moveTypeUses, crashes: d.crashes, history: json(d.history),
  };
}

function createData(d: OwnedDaemonRecord, operatorId: string) {
  const { originalOperatorId: _o, history, ...rest } = d;
  return { ...rest, history: json(history), operatorId };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export class PrismaStore implements Store {
  constructor(readonly prisma: PrismaClient) {}

  static connect(databaseUrl: string): PrismaStore {
    return new PrismaStore(createPrisma(databaseUrl));
  }

  async createSeed(subnet: string) {
    for (;;) {
      const row = { id: randomHex(4), seed: randomHex(16), subnet };
      try {
        await this.prisma.subnetSeed.create({ data: row });
        return { id: row.id, seed: row.seed };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    const op = await this.prisma.operator.upsert({
      where: { sub },
      update: {},
      create: { sub, subnet, x: spawn.x, y: spawn.y },
      include: { daemons: { orderBy: { slot: 'asc' } } },
    });
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: Number(op.bits),
      inventory: (op.inventory ?? {}) as Record<string, number>,
      ram: op.daemons.filter((d) => d.location === 'RAM').map(toRecord),
      diskSlots: op.daemons.filter((d) => d.location === 'DISK').map((d) => d.slot),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const done = await tx.appliedAction.findUnique({ where: { key: intent.id } });
        if (done) {
          if (intent.kind !== 'load') return { ok: true } as const;
          const row = await tx.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
          return { ok: true, daemon: toRecord(row) } as const;
        }
        await tx.appliedAction.create({ data: { key: intent.id, kind: intent.kind } });
        const now = new Date();
        switch (intent.kind) {
          case 'claimStarter': {
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: { name: intent.name, starterClaimed: true, inventory: intent.inventory },
            });
            await tx.daemon.create({
              data: {
                ...createData(intent.daemon, intent.operatorId),
                location: 'RAM',
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'capture': {
            await tx.daemon.create({
              data: {
                ...createData(intent.daemon, intent.operatorId),
                location: intent.location,
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'store': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'RAM' },
              data: { ...(ctx.storedDaemon ? stateFields(ctx.storedDaemon) : {}), location: 'DISK', slot: intent.diskSlot },
            });
            if (res.count !== 1) throw new DomainFailure('daemon not found');
            return { ok: true } as const;
          }
          case 'load': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'DISK' },
              data: { location: 'RAM', slot: intent.ramSlot },
            });
            if (res.count !== 1) throw new DomainFailure('not on Disk');
            const row = await tx.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
            return { ok: true, daemon: toRecord(row) } as const;
          }
          case 'evolve': {
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM' || row.species !== intent.from) throw new DomainFailure('daemon not found');
            const history = [...(Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : []), ...intent.history];
            await tx.daemon.update({
              where: { id: intent.daemonId },
              data: {
                species: intent.to, ivs: intent.ivs, bonus: intent.bonus, clean: intent.clean, signature: intent.signature,
                heldItem: intent.heldItem, moves: intent.moves, hp: intent.hp, history: json(history),
              },
            });
            const first = await tx.discovery.createMany({ data: [{ formId: intent.to, operatorId: intent.operatorId }], skipDuplicates: true });
            return { ok: true, discovered: first.count === 1 } as const;
          }
        }
      });
    } catch (err) {
      if (err instanceof DomainFailure) return { ok: false, reason: err.message };
      if (intent.kind === 'claimStarter' && isUniqueViolation(err)) return { ok: false, reason: 'name taken' };
      throw err;
    }
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const rec of records) {
        await tx.operator.update({
          where: { id: rec.id },
          data: { x: rec.x, y: rec.y, bits: BigInt(rec.bits), inventory: rec.inventory, lastSeenAt: now },
        });
        for (const d of rec.ram) {
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id }, data: stateFields(d) });
        }
      }
    });
  }

  async listDiscoveries(): Promise<string[]> {
    const rows = await this.prisma.discovery.findMany({ select: { formId: true } });
    return rows.map((r) => r.formId);
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Thrown inside a transaction to roll it back with a domain (non-retryable) reason. */
class DomainFailure extends Error {}
```

In `apps/sim/src/runtime/main.ts` the world now boots with the known discoveries:

```ts
const world = new World({ subnet, seed: seed.seed, seedId: seed.id, discovered: await store.listDiscoveries() });
```

- [ ] **Step 10: Test helpers**

In `apps/sim/test/helpers.ts`:

1. Import `emptyMoveTypeUses` from `@daemonet/rules` (add it to the existing import list).
2. Replace `makeWorld` with
   ```ts
   export const FIXED_CLOCK = '2026-09-30T00:00:00.000Z';

   export function makeWorld(seed = 'test', discovered: string[] = []): World {
     return new World({ subnet: TEST_SUBNET, seed, seedId: 'seed0001', spawner: false, discovered, clock: () => FIXED_CLOCK });
   }
   ```
3. Extend the record returned by `ownedRecord` after `slot,`:
   ```ts
       heldItem: null,
       patched: false,
       moveTypeUses: emptyMoveTypeUses(),
       crashes: 0,
       arenaWins: 0,
       history: [],
       originalOperatorId: 'alice',
   ```

- [ ] **Step 11: Sim tests for evolve, held items and the Bit Flipper**

Create `apps/sim/test/evolve.test.ts`:

```ts
import { statBlock, statBlockToArray } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { toRamDaemon, type Intent } from '../src/core/index.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

/** An operator with an Echolet at 16 in slot 0 (evolves into Tracerat, or Broadcaw while holding a Jumbo Frame). */
function setup(discovered: string[] = []) {
  const world = makeWorld('evo', discovered);
  world.addOperator(operatorRecord('alice', { ram: [ownedRecord('echolet', 16, 0, 'alice-d0')], inventory: { jumboframe: 1, bitflipper: 2, restore: 1 } }));
  return world;
}

/** Runs the evolve command and completes its intent through a MemoryStore the world was seeded into. */
async function evolveThrough(world: ReturnType<typeof setup>, store: MemoryStore, formId: string, daemonId = 'alice-d0') {
  const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId, formId } }));
  expect(r.replies).toEqual([]);
  const intent = r.intents[0] as Extract<Intent, { kind: 'evolve' }>;
  expect(intent.kind).toBe('evolve');
  const result = await store.applyIntent(intent, { seedId: 'seed0001' });
  world.completeIntent(intent.id, result);
  return { intent, result, after: step(world) };
}

async function seededStore(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', { x: 5, y: 5 });
  store.operators.get(rec.id)!.id = 'alice';
  store.operators.set('alice', store.operators.get(rec.id)!);
  store.operators.delete(rec.id);
  for (const d of world.checkpoint('alice').ram) store.daemons.set(d.id, { ...d, operatorId: 'alice', location: 'RAM' });
  return store;
}

describe('evolve command', () => {
  it('lists options on the RAM view with met / requirement, hiding undiscovered requirements', () => {
    const world = setup();
    const d = world.daemons.get('alice-d0')!;
    const ram = toRamDaemon(world, d);
    expect(ram.evolutions).toEqual([
      { form: 'tracerat', name: 'Tracerat', level: 16, hidden: false, revealed: true, met: true, requirement: [] },
      { form: 'broadcaw', name: 'Broadcaw', level: 16, hidden: false, revealed: true, met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] },
    ]);
    d.species = 'broadcaw';
    d.level = 32;
    d.ivs = { ...statBlock(10), speed: 31 };
    const hidden = toRamDaemon(world, d).evolutions.find((o) => o.form === 'anycastrel')!;
    expect(hidden).toMatchObject({ hidden: true, revealed: false, requirement: null, met: true });
    world.discovered.add('anycastrel');
    expect(toRamDaemon(world, d).evolutions.find((o) => o.form === 'anycastrel')!.requirement).toEqual([{ kind: 'dominantIV', stat: 'speed' }]);
  });

  it('rejects running, under-levelled, unmet and unknown forms', () => {
    const world = setup();
    const cmd = (formId: string) => input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId } });
    expect(step(world, cmd('broadcaw')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'requirement not met' });
    expect(step(world, cmd('pidzero')).replies[0]).toMatchObject({ code: 'E_INVALID' });
    world.daemons.get('alice-d0')!.level = 15;
    expect(step(world, cmd('tracerat')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'needs level 16' });
    world.daemons.get('alice-d0')!.level = 16;
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(step(world, cmd('tracerat')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'recall the daemon first' });
  });

  it('evolves through the store: species, stats, moves, HP fraction, history, events, first discovery', async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    d.hp = Math.floor(d.stats.hp / 2);
    const { intent, result, after } = await evolveThrough(world, store, 'tracerat');
    expect(result).toEqual({ ok: true, discovered: true });
    expect(d.species).toBe('tracerat');
    expect(d.types).toEqual(['packet', 'signal']);
    expect(d.pending).toBe(false);
    expect(d.moves).toEqual(['ping', 'traceroute', 'sigstop', 'synflood']);
    expect(d.hp).toBe(intent.hp);
    expect(Math.abs(d.hp / d.stats.hp - 0.5)).toBeLessThan(0.05);
    expect(d.history.at(-1)).toEqual({ at: FIXED_CLOCK, kind: 'evolved', detail: 'echolet -> tracerat at level 16' });
    expect(store.daemons.get('alice-d0')).toMatchObject({ species: 'tracerat', ivs: intent.ivs, history: d.history });
    const events = after.events.map((e) => e.event);
    expect(events).toContainEqual({ e: 'evolved', daemon: 'alice-d0', from: 'echolet', to: 'tracerat', changes: intent.changes });
    expect(events).toContainEqual({ e: 'discovery', form: 'tracerat', operator: 'alice', operatorName: 'alice' });
    expect(after.events.find((e) => e.event.e === 'discovery')).toMatchObject({ to: null, at: null });
    expect(after.replies[0]).toMatchObject({ reqId: intent.reqId, ok: true, result: { species: 'tracerat' } });
    expect(world.discovered.has('tracerat')).toBe(true);
    // the second evolution into the same form is not a discovery
    world.addOperator(operatorRecord('bob', { ram: [ownedRecord('echolet', 16, 0, 'bob-d0')] }));
    store.operators.set('bob', { id: 'bob', sub: 'bob', name: 'bob', starterClaimed: true, bits: 0, x: 5, y: 5, inventory: {} });
    store.daemons.set('bob-d0', { ...world.checkpoint('bob').ram[0]!, operatorId: 'bob', location: 'RAM' });
    const r = step(world, input('bob', { cmd: 'evolve', actor: self, args: { daemonId: 'bob-d0', formId: 'tracerat' } }));
    const intent2 = r.intents[0]!;
    expect(await store.applyIntent(intent2, { seedId: 'seed0001' })).toEqual({ ok: true, discovered: false });
  });

  it('consumes the held evolution item and records clean / signature entries', async () => {
    const world = setup();
    const store = await seededStore(world);
    expect(step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } })).replies[0]).toMatchObject({ ok: true });
    const d = world.daemons.get('alice-d0')!;
    expect(d.heldItem).toBe('jumboframe');
    expect(world.operators.get('alice')!.inventory.jumboframe).toBe(0);
    d.ivs = { ...statBlock(31), hp: 30 };
    store.daemons.get('alice-d0')!.ivs = statBlockToArray(d.ivs);
    // force the IV roll to hit: run until the seeded rng grows hp
    let done = false;
    for (let i = 0; i < 8 && !done; i++) {
      const w = setup();
      const s = await seededStore(w);
      const dd = w.daemons.get('alice-d0')!;
      step(w, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } }));
      dd.ivs = { ...statBlock(31), hp: 30 };
      for (let k = 0; k < i; k++) w.rng.float();
      const { intent } = await evolveThrough(w, s, 'broadcaw');
      expect(intent.heldItem).toBeNull();
      expect(intent.changes).toContainEqual({ kind: 'consumed', item: 'jumboframe' });
      expect(dd.species).toBe('broadcaw');
      if (intent.clean) {
        expect(dd.history.map((h) => h.kind)).toEqual(['evolved', 'clean']);
        done = true;
      }
    }
    expect(done).toBe(true);
  });

  it('fails cleanly when the store rejects and locks the daemon while pending', async () => {
    const world = setup();
    const store = new MemoryStore(); // knows no operator
    const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId: 'tracerat' } }));
    const d = world.daemons.get('alice-d0')!;
    expect(d.pending).toBe(true);
    expect(step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    await expect(store.applyIntent(r.intents[0]!, { seedId: 'seed0001' })).rejects.toThrow();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(d.pending).toBe(false);
    expect(d.species).toBe('echolet');
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'persist failed' });
  });
});

describe('held items and the Bit Flipper', () => {
  it('hold swaps the slot with the inventory; unhold returns it; non-holdables are refused', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    op.inventory.amplifier = 1;
    const hold = (itemId: string) => step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId } })).replies[0];
    expect(hold('restore')).toMatchObject({ code: 'E_INVALID' });
    expect(hold('heatsink')).toMatchObject({ code: 'E_STATE' });
    expect(hold('amplifier')).toMatchObject({ ok: true });
    expect(hold('jumboframe')).toMatchObject({ ok: true });
    expect(op.inventory).toMatchObject({ amplifier: 1, jumboframe: 0 });
    expect(world.daemons.get('alice-d0')!.heldItem).toBe('jumboframe');
    expect(step(world, input('alice', { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: true });
    expect(op.inventory.jumboframe).toBe(1);
    expect(step(world, input('alice', { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    expect(world.checkpoint('alice').ram[0]!.heldItem).toBeNull();
  });

  it('bitflipper raises one IV, marks patched and writes history; capped at 31', () => {
    const world = setup();
    const d = world.daemons.get('alice-d0')!;
    const use = (stat: 'attack' | 'hp') => step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'bitflipper', daemonId: 'alice-d0', stat } })).replies[0];
    expect(use('attack')).toMatchObject({ ok: true, result: { patched: true } });
    expect(d.ivs.attack).toBe(21);
    expect(d.patched).toBe(true);
    expect(d.history).toEqual([{ at: FIXED_CLOCK, kind: 'patched', detail: 'attack +1 (bitflipper)' }]);
    d.ivs.hp = 31;
    expect(use('hp')).toMatchObject({ code: 'E_STATE' });
    expect(world.operators.get('alice')!.inventory.bitflipper).toBe(1);
    expect(step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'bitflipper', daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
  });

  it('a patched daemon never becomes clean on evolution', async () => {
    for (let i = 0; i < 4; i++) {
      const world = setup();
      const store = await seededStore(world);
      const d = world.daemons.get('alice-d0')!;
      d.ivs = { ...statBlock(31), hp: 30 };
      d.patched = true;
      for (let k = 0; k < i; k++) world.rng.float();
      const { intent } = await evolveThrough(world, store, 'tracerat');
      expect(intent.clean).toBe(false);
    }
  });
});
```

- [ ] **Step 12: Store contract tests**

In `apps/sim/test/store.test.ts`, add two cases at the end of the `contract` describe (after the checkpoint test):

```ts
    it('checkpoints IVs, patched, held item, counters and history', async () => {
      const a = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      const d = ownedRecord('echolet', 16, 0, 'abcd1234-d7');
      await store.applyIntent(claim(a.id, 'finn', d), { seedId: 'abcd1234' });
      const rec = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      const uses = rec.ram[0]!.moveTypeUses.map((_, i) => i);
      const history = [{ at: '2026-09-30T00:00:00.000Z', kind: 'patched' as const, detail: 'attack +1 (bitflipper)' }];
      await store.checkpoint([{ ...rec, ram: [{ ...rec.ram[0]!, ivs: [21, 20, 20, 20, 20, 20, 20, 20], patched: true, heldItem: 'jumboframe', moveTypeUses: uses, crashes: 2, history }] }]);
      const after = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      expect(after.ram[0]).toMatchObject({ ivs: [21, 20, 20, 20, 20, 20, 20, 20], patched: true, heldItem: 'jumboframe', moveTypeUses: uses, crashes: 2, history, originalOperatorId: a.id });
    });

    it('applies evolve intents idempotently and records the first discovery of each form', async () => {
      const a = await store.loadOrCreateOperator('sub-g', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-h', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'gail', ownedRecord('echolet', 16, 0, 'abcd1234-d8')), { seedId: 'abcd1234' });
      await store.applyIntent(claim(b.id, 'hugo', ownedRecord('echolet', 16, 0, 'abcd1234-d9')), { seedId: 'abcd1234' });
      const history = [{ at: '2026-09-30T00:00:00.000Z', kind: 'evolved' as const, detail: 'echolet -> tracerat at level 16' }];
      const evolve = (id: string, operatorId: string, daemonId: string): Intent => ({
        id, kind: 'evolve', operatorId, reqId: 'r', daemonId, from: 'echolet', to: 'tracerat', ivs: [21, 20, 20, 21, 20, 20, 20, 20], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
        clean: false, signature: 0, heldItem: null, moves: ['ping', 'traceroute', 'sigstop', 'synflood'], hp: 40, changes: [{ kind: 'iv', stat: 'hp', from: 20, to: 21 }], history,
      });
      expect(await store.listDiscoveries()).toEqual([]);
      expect(await store.applyIntent(evolve('i-evo-1', a.id, 'abcd1234-d8'), { seedId: 'abcd1234' })).toEqual({ ok: true, discovered: true });
      expect(await store.applyIntent(evolve('i-evo-1', a.id, 'abcd1234-d8'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(evolve('i-evo-2', b.id, 'abcd1234-d9'), { seedId: 'abcd1234' })).toEqual({ ok: true, discovered: false });
      expect(await store.applyIntent(evolve('i-evo-3', b.id, 'abcd1234-d9'), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.listDiscoveries()).toEqual(['tracerat']);
      const after = await store.loadOrCreateOperator('sub-g', 'lo', SPAWN);
      expect(after.ram[0]).toMatchObject({ species: 'tracerat', ivs: [21, 20, 20, 21, 20, 20, 20, 20], hp: 40, moves: ['ping', 'traceroute', 'sigstop', 'synflood'], history });
    });
```

and add `"Discovery"` to the PrismaStore reset:

```ts
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
```

- [ ] **Step 13: SDK end-to-end test**

In `apps/sim/test/integration.test.ts`, the harness world boots with the store's discoveries:

```ts
  const world = new World({ subnet: TEST_SUBNET, seed: seedId, seedId, spawner: false, discovered: await store.listDiscoveries() });
```

and add this case before `'another operator cannot capture a daemon tagged by someone else'`:

```ts
  it('evolves a daemon through the SDK: options on the RAM view, evolved + discovery events, survives a restart', async () => {
    const store = new MemoryStore();
    const h = await boot(store, 'aaaa0005');
    const alice = await bot(h.url, 'alice');
    const bob = await bot(h.url, 'bob');
    await alice.operator.claimStarter('pingling', 'alice');
    await bob.operator.claimStarter('nullpup', 'bob');
    await until(alice, () => alice.self.ram.length === 1 && bob.self.ram.length === 1);
    const d = h.world.daemons.get(alice.self.ram[0]!.id)!;
    d.level = 8;
    await until(alice, () => alice.self.ram[0]!.evolutions.some((o) => o.form === 'echolet' && o.met));
    const discovery = new Promise((resolve) => bob.on('discovery', resolve));
    const evolved = new Promise((resolve) => alice.on('evolved', resolve));
    await expect(alice.operator.evolve(d.id, 'echolet')).resolves.toMatchObject({ species: 'echolet' });
    await expect(evolved).resolves.toMatchObject({ daemon: d.id, from: 'pingling', to: 'echolet' });
    await expect(discovery).resolves.toMatchObject({ form: 'echolet', operatorName: 'alice' });
    await until(alice, () => alice.self.ram[0]!.species === 'echolet');
    expect(alice.self.ram[0]!.evolutions.map((o) => o.form)).toEqual(['tracerat', 'broadcaw']);

    await h.stop();
    running.splice(running.indexOf(h), 1);
    const h2 = await boot(store, 'bbbb0006');
    expect(h2.world.discovered.has('echolet')).toBe(true);
    const back = await bot(h2.url, 'alice');
    expect(back.self.ram[0]).toMatchObject({ species: 'echolet', level: 8 });
  });
```

- [ ] **Step 14: Verify**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 261 tests (26 files). Without `DATABASE_URL` the PrismaStore contract is skipped; run it at least once against a migrated database.

- [ ] **Step 15: Commit**

```bash
git add packages/db packages/shared packages/sdk apps/sim
git commit -m "feat(sim): evolve intent with discoveries, hold/unhold, Bit Flipper, daemon history and counters"
```

---

### Task 3: Trait, held-item and status effects in combat

**Files:**
- Modify: `apps/sim/src/core/systems/combat.ts`, `apps/sim/src/core/systems/upkeep.ts`, `apps/sim/src/core/systems/movement.ts`, `apps/sim/src/core/systems/progress.ts`
- Tests: create `apps/sim/test/traits.test.ts`; modify `apps/sim/test/combat.test.ts`, `apps/sim/test/evolve.test.ts`

**Interfaces:**
- `combat.ts` exports `energyCost(d, move)`, `cooldownMs(d, move, tick)`, `scaleDamage(amount, attacker, target, move, tick)` and the constants `FILLER_COOLDOWN_MS = 512`, `HEAVY_COOLDOWN_MS = 4096`, `LOW_HP_FRACTION = 0.25`, `DARKMODE_RANGE = 6`, `SONAR_BONUS_RANGE = 2`, `DECAY_ENERGY = 4`, `ECHO_CHANCE = 0.25`, `AMPLIFIER = 1.125`, `HEATSINK = 0.875`, `FIREWALL = 0.875`, `EXPOSED_MULT = 1.25`.
- `upkeep.ts` exports `LEAK_PER_SECOND = 2`; `movement.ts` exports `VOIDSTEP_RADIUS = 8` and `hostileNear(world, d, radius)`.
- Effects (spec §3.5 / §3.6), all keyed off `Daemon.trait` / `Daemon.heldItem` / `Daemon.engagement`:

  | where | effect |
  |---|---|
  | `energyCost` | synburst: filler (base cooldown ≤ 512 ms) costs 0 below 25% HP · lazyeval: heavy (≥ 4096 ms) costs ⌊75%⌋ |
  | `cooldownMs` | haste + throttled as before · heatsink ×0.875 · overclock ×0.875 below 25% HP |
  | `selectVictims` | sonar: +2 range on single-target moves |
  | `executeMove` | lowlatency: `engagement.freeMove` skips the cooldown check once · `moveTypeUses[type]++` · retransmit: an area move with no victim refunds its cost · echo: filler that dealt damage to a still-standing target has a 25% chance of a second hit at ⌊half⌋ |
  | `scaleDamage` | amplifier ×1.125 · firewall ×0.875 · exposed ×1.25 · darkmode ×0.75 when `move.range ≥ 6` · salted ×0.75 when `engagement.lastHitMove === move.id`; floor, min 1 |
  | `applyHit` | bitshield: first hit of the engagement → 0 · nullsafe: one lethal hit leaves 1 HP · decay: target −4 energy · absorb: target +10% of damage as energy · `lastHitMove` · a fresh engagement when a wild daemon is first tagged (its bitshield counts as spent on the tagging hit) · onewayfn: no statuses · entropy: status duration ×1.5 |
  | `upkeep` | leaking: −2 energy/s · battery: regen ×1.5 · tag expiry resets the wild's engagement |
  | `moveAll` | voidstep: ×1.5 speed when `!hostileNear(world, d, 8)` |
  | `resolveDefeats` | `crashes++` on an owned crash |

- [ ] **Step 1: Write the failing tests**

Create `apps/sim/test/traits.test.ts`:

```ts
import { TICK_HZ, getMove } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import type { Daemon } from '../src/core/index.js';
import { cooldownMs, energyCost, scaleDamage } from '../src/core/systems/combat.js';
import { LEAK_PER_SECOND } from '../src/core/systems/upkeep.js';
import { idle, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

/** Alice with a level-20 Pingling running, a level-20 wild Bitrot two tiles away (survives a ping); both traits overridable. */
function duel(myTrait: string, wildTrait = 'lowlatency') {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice', { ram: [ownedRecord('pingling', 20, 0, 'alice-d0')] }));
  step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
  const mine = world.daemons.get('alice-d0')!;
  mine.trait = myTrait;
  const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
  wild.trait = wildTrait;
  const use = (move: string, aim: { targetId?: string; x?: number; y?: number } = { targetId: wild.id }) =>
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, ...aim } }));
  /** Hits landed on the wild daemon this step (it fights back, so events also carry its own hits). */
  const hits = (r: ReturnType<typeof step>) =>
    r.events.map((e) => e.event as { e: string; amount: number; target: string }).filter((e) => e.e === 'hit' && e.target === wild.id);
  return { world, mine, wild, use, hits };
}

const ping = getMove('ping');
const traceroute = getMove('traceroute');
const synflood = getMove('synflood');

describe('trait effects', () => {
  it('sonar: +2 range on single-target moves', () => {
    const { mine, wild, use } = duel('sonar');
    wild.statuses.stalled = 10_000; // keep it from closing the distance
    wild.x = 9.5; // 4 tiles: ping range 2 (+2)
    expect(use('ping').replies[0]).toMatchObject({ ok: true });
    wild.x = 10.5;
    mine.cooldowns = {};
    expect(use('ping').replies[0]).toMatchObject({ code: 'E_RANGE' });
  });

  it('lowlatency: the first move after activation ignores the cooldown, then cooldowns apply', () => {
    const { mine, use } = duel('lowlatency');
    mine.cooldowns.ping = 10_000;
    expect(use('ping').replies[0]).toMatchObject({ ok: true });
    expect(use('ping').replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
  });

  it('synburst and lazyeval change energy costs; retransmit refunds an empty area move', () => {
    const { world, mine, use } = duel('synburst');
    mine.hp = Math.floor(mine.stats.hp * 0.2);
    expect(energyCost(mine, ping)).toBe(0);
    expect(energyCost(mine, traceroute)).toBe(traceroute.energyCost);
    mine.trait = 'lazyeval';
    expect(energyCost(mine, synflood)).toBe(Math.floor(synflood.energyCost * 0.75));
    mine.trait = 'retransmit';
    mine.energy = 128;
    expect(use('broadcast', { x: 5.5, y: 10.5 }).replies[0]).toMatchObject({ ok: true });
    expect(mine.energy).toBe(128);
    mine.trait = 'echo';
    world.daemons.get('alice-d0')!.cooldowns = {};
    use('broadcast', { x: 5.5, y: 10.5 });
    expect(mine.energy).toBeCloseTo(128 - getMove('broadcast').energyCost, 0); // plus one tick of regen
  });

  it('overclock and heatsink shorten cooldowns', () => {
    const { mine } = duel('overclock');
    const base = cooldownMs(mine, ping, 0);
    mine.hp = 1;
    expect(cooldownMs(mine, ping, 0)).toBe(Math.floor(base * 0.875));
    mine.hp = mine.stats.hp;
    mine.heldItem = 'heatsink';
    expect(cooldownMs(mine, ping, 0)).toBe(Math.floor(base * 0.875));
  });

  it('damage multipliers: amplifier, firewall, exposed, darkmode, salted', () => {
    const { mine, wild } = duel('echo');
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(100);
    mine.heldItem = 'amplifier';
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(112);
    mine.heldItem = null;
    wild.heldItem = 'firewall';
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(87);
    wild.heldItem = null;
    wild.statuses.exposed = 100;
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(125);
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(100);
    wild.trait = 'darkmode';
    expect(scaleDamage(100, mine, wild, traceroute, 200)).toBe(75);
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(100);
    wild.trait = 'salted';
    wild.engagement.lastHitMove = 'ping';
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(75);
    expect(scaleDamage(100, mine, wild, traceroute, 200)).toBe(100);
    expect(scaleDamage(0, mine, wild, ping, 200)).toBe(0);
  });

  it('bitshield blocks the first hit of an engagement; nullsafe survives one lethal hit at 1 HP', () => {
    const a = duel('echo', 'bitshield');
    expect(a.hits(a.use('ping'))[0]!.amount).toBe(0);
    expect(a.wild.hp).toBe(a.wild.stats.hp);
    a.mine.cooldowns = {};
    expect(a.hits(a.use('ping'))[0]!.amount).toBeGreaterThan(0);

    const b = duel('echo', 'nullsafe');
    b.wild.hp = 1;
    b.wild.wild!.aggro = null;
    b.use('ping');
    expect(b.wild.hp).toBe(1);
    expect(b.world.daemons.has(b.wild.id)).toBe(true);
    b.mine.cooldowns = {};
    b.use('ping');
    expect(b.world.daemons.has(b.wild.id)).toBe(false);
  });

  it('decay drains 4 energy per hit; absorb regains 10% of damage taken', () => {
    const a = duel('decay');
    a.wild.energy = 100;
    a.use('ping');
    expect(a.wild.energy).toBeCloseTo(96, 0); // plus one tick of regen

    const b = duel('echo', 'absorb');
    b.wild.energy = 50;
    const dealt = b.hits(b.use('ping')).reduce((s, h) => s + h.amount, 0);
    expect(b.wild.energy).toBeCloseTo(50 + dealt * 0.1, 0);
  });

  it('echo hits again at half power about a quarter of the time', () => {
    let doubles = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const { world, use, hits } = duel('echo');
      for (let k = 0; k < i; k++) world.rng.float();
      const h = hits(use('ping'));
      if (h.length === 2) {
        doubles++;
        expect(h[1]!.amount).toBe(Math.max(1, Math.floor(h[0]!.amount / 2)));
      } else expect(h.length).toBe(1);
    }
    expect(doubles / N).toBeGreaterThan(0.15);
    expect(doubles / N).toBeLessThan(0.35);
  });

  it('onewayfn is immune to statuses; entropy makes inflicted statuses last +50%', () => {
    const immune = duel('echo', 'onewayfn');
    for (let i = 0; i < 12; i++) {
      immune.mine.cooldowns = {};
      immune.mine.energy = 128;
      immune.use('broadcast', { targetId: immune.wild.id });
    }
    expect(immune.wild.statuses.leaking).toBeUndefined();

    const e = duel('entropy');
    let status: { untilTick: number } | undefined;
    for (let i = 0; i < 12 && !status; i++) {
      e.mine.cooldowns = {};
      e.mine.energy = 128;
      status = e.use('broadcast', { targetId: e.wild.id }).events.find((ev) => ev.event.e === 'status')?.event as { untilTick: number } | undefined;
      if (status) expect(status.untilTick - e.world.tick).toBe(e.world.ticks(getMove('broadcast').status!.durationMs * 1.5));
    }
    expect(status).toBeDefined();
  });

  it('voidstep moves 50% faster with no hostile within 8 tiles', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 5.5, y: 20.5, ram: [ownedRecord('pingling', 20, 0, 'alice-d0')] }));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const d = world.daemons.get('alice-d0')!;
    const run = (trait: string, wildAt: number | null) => {
      d.trait = trait;
      d.x = 5.5;
      d.y = 20.5;
      const w = wildAt === null ? null : placeWild(world, 'bitrot', 5, 5.5, wildAt);
      step(world, input('alice', { cmd: 'moveTo', actor: 'alice-d0', args: { x: 12.5, y: 20.5 } }));
      const moved = d.x - 5.5;
      if (w) world.removeDaemon(w.id);
      d.path = [];
      return moved;
    };
    const plain = run('echo', null);
    expect(run('voidstep', null)).toBeCloseTo(plain * 1.5, 5);
    expect(run('voidstep', 26.5)).toBeCloseTo(plain, 5);
  });
});

describe('statuses', () => {
  it('leaking drains 2 energy per second; battery raises regen by 50%', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    const d = world.daemons.get('alice-d0')!;
    d.energy = 64;
    const regen = (1 + d.stats.energy / 64) / TICK_HZ;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(64 + regen, 6);
    d.statuses.leaking = world.tick + 100;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(64 + 2 * regen - LEAK_PER_SECOND / TICK_HZ, 6);
    delete d.statuses.leaking;
    d.heldItem = 'battery';
    const before = d.energy;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(before + regen * 1.5, 6);
  });

  it('exposed shows up as an active status on the entity view', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const d: Daemon = world.daemons.get('alice-d0')!;
    d.statuses.exposed = world.tick + 8;
    const r = step(world);
    void r;
    expect(d.statuses.exposed).toBeDefined();
  });
});
```

Append to `apps/sim/test/evolve.test.ts` (and add `typeIndex` to its `@daemonet/rules` import):

```ts
describe('lifetime counters', () => {
  it('counts move uses per type and crashes', () => {
    const world = setup();
    world.addOperator(operatorRecord('bob'));
    step(world, input('bob', { cmd: 'run', actor: self, args: { daemonId: 'bob-d0' } }));
    const wild = world.spawnWild('bitrot', 5, { x: 7.5, y: 5.5 }, -1, { ...world.daemons.get('bob-d0')!, ivs: statBlock(10), clean: false, signature: 0 });
    step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } }));
    const mine = world.daemons.get('bob-d0')!;
    expect(mine.moveTypeUses[typeIndex('packet')]).toBe(1);
    mine.hp = 0;
    step(world);
    expect(mine.crashes).toBe(1);
    expect(world.checkpoint('bob').ram[0]).toMatchObject({ crashes: 1, moveTypeUses: mine.moveTypeUses });
  });
});
```

In `apps/sim/test/combat.test.ts` (`area moves hit every eligible wild daemon in the circle`) the wild daemons now have traits, and a Sonar-ranged wild answers back in the same tick; count only Alice's hits:

```ts
    const hits = r.events.filter((e) => e.event.e === 'hit' && (e.event as { source: string }).source === 'alice-d0').map((e) => (e.event as { target: string }).target);
```

Run: `pnpm exec vitest run apps/sim/test/traits.test.ts` — expected: fails (`energyCost` not exported, no effects).

- [ ] **Step 2: Combat**

Replace `apps/sim/src/core/systems/combat.ts`:

```ts
import { TAG_WINDOW_MS, damage, effectiveCooldownMs, getMove, typeIndex, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { Rejection, freshEngagement, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Trait thresholds (SP3a spec §3.5). */
export const FILLER_COOLDOWN_MS = 512;
export const HEAVY_COOLDOWN_MS = 4096;
export const LOW_HP_FRACTION = 0.25;
export const DARKMODE_RANGE = 6;
export const SONAR_BONUS_RANGE = 2;
export const DECAY_ENERGY = 4;
export const ECHO_CHANCE = 0.25;
/** Held-item multipliers (spec §3.6). */
export const AMPLIFIER = 1.125;
export const HEATSINK = 0.875;
export const FIREWALL = 0.875;
export const EXPOSED_MULT = 1.25;

export interface Aim {
  targetId?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
}

export interface QueuedUse {
  daemonId: string;
  move: string;
  aim: Aim;
  /** Player uses carry their input so the reply can be sent; wild uses have none. */
  input?: Input;
}

type Victim = { kind: 'daemon'; d: Daemon } | { kind: 'operator'; op: Operator };

const pos = (v: Victim): Point => (v.kind === 'daemon' ? v.d : v.op);
const vid = (v: Victim): string => (v.kind === 'daemon' ? v.d.id : v.op.id);

/** Who `attacker` may hit. Owned daemons hit wild daemons not tagged by someone else; wild daemons hit the side they are fighting. */
function candidates(world: World, attacker: Daemon): Victim[] {
  if (attacker.ownerId) {
    const out: Victim[] = [];
    for (const d of world.daemons.values()) {
      if (d.wild && d.active && d.hp > 0 && (d.wild.tagOwner === null || d.wild.tagOwner === attacker.ownerId)) out.push({ kind: 'daemon', d });
    }
    return out;
  }
  const aggro = attacker.wild?.aggro;
  if (!aggro) return [];
  const opId = world.daemons.get(aggro)?.ownerId ?? (world.operators.has(aggro) ? aggro : null);
  const op = opId ? world.operators.get(opId) : undefined;
  if (!op) return [];
  const out: Victim[] = op.running.map((id) => ({ kind: 'daemon' as const, d: world.daemons.get(id)! }));
  out.push({ kind: 'operator', op });
  return out;
}

function aimPoint(world: World, aim: Aim, pool: Victim[]): Point | null {
  if (aim.targetId !== undefined) {
    const v = pool.find((x) => vid(x) === aim.targetId);
    if (v) return pos(v);
    return world.locate(aim.targetId);
  }
  if (aim.x !== undefined && aim.y !== undefined) return { x: aim.x, y: aim.y };
  return null;
}

function selectVictims(world: World, attacker: Daemon, move: MoveDef, aim: Aim): Victim[] {
  const pool = candidates(world, attacker);
  const shape = move.shape;
  if (shape.kind === 'single') {
    if (aim.targetId === undefined) throw new Rejection('E_INVALID', 'single-target moves need targetId');
    const v = pool.find((x) => vid(x) === aim.targetId);
    if (!v) throw new Rejection('E_STATE', 'not a valid target');
    const range = move.range + (attacker.trait === 'sonar' ? SONAR_BONUS_RANGE : 0);
    if (distance(attacker, pos(v)) > range) throw new Rejection('E_RANGE', 'target out of range');
    return [v];
  }
  const at = aimPoint(world, aim, pool);
  if (!at) throw new Rejection('E_INVALID', 'area moves need targetId or x/y');
  if (shape.kind === 'circle') {
    if (distance(attacker, at) > move.range) throw new Rejection('E_RANGE', 'area out of range');
    return pool.filter((v) => distance(at, pos(v)) <= shape.radius);
  }
  const dirX = at.x - attacker.x;
  const dirY = at.y - attacker.y;
  const dirLen = Math.hypot(dirX, dirY) || 1;
  const half = (shape.angleDeg / 2) * (Math.PI / 180);
  return pool.filter((v) => {
    const p = pos(v);
    const dx = p.x - attacker.x;
    const dy = p.y - attacker.y;
    const len = Math.hypot(dx, dy);
    if (len > shape.length) return false;
    if (len === 0) return true;
    const cos = (dx * dirX + dy * dirY) / (len * dirLen);
    return Math.acos(Math.max(-1, Math.min(1, cos))) <= half;
  });
}

const lowHp = (d: Daemon): boolean => d.hp < d.stats.hp * LOW_HP_FRACTION;
const isFiller = (m: MoveDef): boolean => m.cooldownMs <= FILLER_COOLDOWN_MS;
const isHeavy = (m: MoveDef): boolean => m.cooldownMs >= HEAVY_COOLDOWN_MS;

/** Energy a move costs `d` (synburst / lazyeval). */
export function energyCost(d: Daemon, move: MoveDef): number {
  if (d.trait === 'synburst' && isFiller(move) && lowHp(d)) return 0;
  if (d.trait === 'lazyeval' && isHeavy(move)) return Math.floor(move.energyCost * 0.75);
  return move.energyCost;
}

/** Cooldown in ms for `d` using `move` now (haste, throttled, heatsink, overclock). */
export function cooldownMs(d: Daemon, move: MoveDef, tick: number): number {
  let ms = effectiveCooldownMs(move.cooldownMs, d.stats.haste, (d.statuses.throttled ?? 0) > tick);
  if (d.heldItem === 'heatsink') ms = Math.floor(ms * HEATSINK);
  if (d.trait === 'overclock' && lowHp(d)) ms = Math.floor(ms * 0.875);
  return ms;
}

/** Applies every multiplier on top of the base damage roll; a non-zero hit stays >= 1. */
export function scaleDamage(amount: number, attacker: Daemon, target: Daemon, move: MoveDef, tick: number): number {
  if (amount <= 0) return 0;
  let mult = 1;
  if (attacker.heldItem === 'amplifier') mult *= AMPLIFIER;
  if (target.heldItem === 'firewall') mult *= FIREWALL;
  if ((target.statuses.exposed ?? 0) > tick) mult *= EXPOSED_MULT;
  if (target.trait === 'darkmode' && move.range >= DARKMODE_RANGE) mult *= 0.75;
  if (target.trait === 'salted' && target.engagement.lastHitMove === move.id) mult *= 0.75;
  return Math.max(1, Math.floor(amount * mult));
}

/** One landed hit on `target` (bitshield, nullsafe, decay, absorb, tag bookkeeping, status). Returns damage dealt. */
function applyHit(world: World, attacker: Daemon, target: Daemon, move: MoveDef, amount: number, multiplier: number, out: Out): number {
  const tick = world.tick;
  const engagement = target.engagement;
  if (target.trait === 'bitshield' && !engagement.blocked) {
    engagement.blocked = true;
    amount = 0;
  }
  if (amount >= target.hp && target.trait === 'nullsafe' && !engagement.survived) {
    engagement.survived = true;
    amount = Math.max(0, target.hp - 1);
  }
  target.hp = Math.max(0, target.hp - amount);
  target.lastCombatTick = tick;
  engagement.lastHitMove = move.id;
  if (attacker.trait === 'decay') target.energy = Math.max(0, target.energy - DECAY_ENERGY);
  if (target.trait === 'absorb') target.energy = Math.min(target.stats.energy > 0 ? 128 : 128, target.energy + amount * 0.1);
  out.emit({ e: 'hit', source: attacker.id, target: target.id, move: move.id, amount, multiplier }, { at: attacker });
  if (target.wild && attacker.ownerId) {
    if (target.wild.tagOwner === null) {
      out.emit({ e: 'battleStart', wild: target.id, operator: attacker.ownerId }, { at: target });
      target.engagement = freshEngagement();
      target.engagement.lastHitMove = move.id;
      if (target.trait === 'bitshield') target.engagement.blocked = true;
    }
    target.wild.tagOwner = attacker.ownerId;
    target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
    target.wild.damagedBy.add(attacker.id);
    target.wild.aggro ??= attacker.id;
  }
  if (move.status && multiplier > 0 && target.trait !== 'onewayfn' && world.rng.chance(move.status.chance)) {
    const durationMs = attacker.trait === 'entropy' ? move.status.durationMs * 1.5 : move.status.durationMs;
    const untilTick = tick + world.ticks(durationMs);
    target.statuses[move.status.id] = untilTick;
    out.emit({ e: 'status', target: target.id, status: move.status.id, untilTick }, { at: target });
  }
  return amount;
}

/** Validates and applies one move. Throws Rejection on E_COOLDOWN / E_ENERGY / E_RANGE / E_STATE / E_INVALID. */
export function executeMove(world: World, attacker: Daemon, moveId: string, aim: Aim, out: Out): void {
  if (!attacker.active || attacker.hp <= 0) throw new Rejection('E_STATE', 'daemon is not running');
  const move = getMove(moveId);
  const tick = world.tick;
  const free = attacker.trait === 'lowlatency' && attacker.engagement.freeMove;
  if (!free && (attacker.cooldowns[move.id] ?? 0) > tick) throw new Rejection('E_COOLDOWN', `${move.id} is cooling down`);
  const cost = energyCost(attacker, move);
  if (attacker.energy < cost) throw new Rejection('E_ENERGY', 'not enough energy');
  const victims = selectVictims(world, attacker, move, aim);

  attacker.engagement.freeMove = false;
  attacker.energy -= cost;
  attacker.cooldowns[move.id] = tick + world.ticks(cooldownMs(attacker, move, tick));
  attacker.lastCombatTick = tick;
  attacker.moveTypeUses[typeIndex(move.type)]!++;
  if (victims.length === 0 && attacker.trait === 'retransmit') attacker.energy += cost;

  for (const v of victims) {
    if (v.kind === 'operator') {
      v.op.hitTick = tick;
      out.emit({ e: 'hit', source: attacker.id, target: v.op.id, move: move.id, amount: 0, multiplier: 1 }, { at: attacker });
      continue;
    }
    const target = v.d;
    const r = damage(
      { level: attacker.level, attacker: attacker.stats, attackerTypes: attacker.types, defender: target.stats, defenderTypes: target.types, move },
      world.rng,
    );
    const amount = scaleDamage(r.amount, attacker, target, move, tick);
    applyHit(world, attacker, target, move, amount, r.multiplier, out);
    if (attacker.trait === 'echo' && isFiller(move) && amount > 0 && target.hp > 0 && world.rng.chance(ECHO_CHANCE)) {
      applyHit(world, attacker, target, move, Math.max(1, Math.floor(amount / 2)), r.multiplier, out);
    }
  }
}

/** Player uses first (arrival order), then wild uses. Player uses get a reply. */
export function executeQueuedUses(world: World, uses: readonly QueuedUse[], out: Out): void {
  for (const use of uses) {
    const d = world.daemons.get(use.daemonId);
    try {
      if (!d) throw new Rejection('E_STATE', 'daemon is gone');
      executeMove(world, d, use.move, use.aim, out);
      if (use.input) out.ok(use.input);
    } catch (err) {
      if (!(err instanceof Rejection)) throw err;
      if (use.input) out.fail(use.input, err.code, err.message);
    }
  }
}
```

- [ ] **Step 3: Upkeep, movement, progress**

Replace `apps/sim/src/core/systems/upkeep.ts`:

```ts
import { ENERGY_MAX, TICK_HZ, regenEnergy, type StatusId } from '@daemonet/rules';
import { freshEngagement, type Daemon } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export const SP1_SNIFF_REFILL = 8;
/** leaking: energy lost per second. */
export const LEAK_PER_SECOND = 2;
/** battery: energy regen multiplier (regenEnergy's tick count scales linearly). */
const BATTERY_REGEN = 1.5;

export function restoreDaemon(d: Daemon): void {
  d.hp = d.stats.hp;
  d.energy = ENERGY_MAX;
  d.crashed = false;
  d.statuses = {};
}

/** Energy regen, status expiry, wild tag expiry (wild resets to full HP), restoreAll channels. */
export function upkeep(world: World, out: Out): void {
  const tick = world.tick;
  const captured = new Set([...world.captures.values()].map((c) => c.targetId));
  for (const d of world.daemons.values()) {
    if (d.crashed) continue;
    d.energy = regenEnergy(d.energy, d.stats.energy, d.heldItem === 'battery' ? BATTERY_REGEN : 1);
    if ((d.statuses.leaking ?? 0) > tick) d.energy = Math.max(0, d.energy - LEAK_PER_SECOND / TICK_HZ);
    for (const [status, until] of Object.entries(d.statuses) as Array<[StatusId, number]>) {
      if (until <= tick) delete d.statuses[status];
    }
    const w = d.wild;
    if (w && w.tagOwner !== null && tick > w.tagUntil && !captured.has(d.id)) {
      w.tagOwner = null;
      w.aggro = null;
      w.damagedBy.clear();
      d.hp = d.stats.hp;
      d.engagement = freshEngagement();
    }
  }

  for (const op of world.operators.values()) {
    if (op.restoreUntil === null) continue;
    if (op.path.length > 0 || op.hitTick === tick) {
      op.restoreUntil = null;
      continue;
    }
    if (tick < op.restoreUntil) continue;
    op.restoreUntil = null;
    for (const id of op.ram) restoreDaemon(world.daemons.get(id)!);
    // Temporary SP1-only rule (SP1 spec 3.4): no shop yet, so restoring tops sniff back up to 8.
    op.inventory.sniff = Math.max(op.inventory.sniff ?? 0, SP1_SNIFF_REFILL);
    out.emit({ e: 'restored', daemons: [...op.ram] }, { to: op.id });
  }
}
```

Replace `apps/sim/src/core/systems/movement.ts`:

```ts
import { TICK_HZ } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import type { Daemon } from '../model.js';
import type { World } from '../world.js';
import { LEASH_TILES } from './commands.js';

export const OPERATOR_SPEED = 4;
export const FOLLOW_TILES = 3;
/** voidstep: +50% speed with no hostile within this many tiles. */
export const VOIDSTEP_RADIUS = 8;
const LEASH_REPATH_TICKS = 4;

export function daemonSpeed(speedStat: number): number {
  return 2 + speedStat / 32;
}

/** Moves `mover` along its path by speed/16 tiles. */
export function advance(mover: Point & { path: Point[] }, tilesPerSecond: number): void {
  let budget = tilesPerSecond / TICK_HZ;
  while (budget > 0 && mover.path.length > 0) {
    const wp = mover.path[0]!;
    const dx = wp.x - mover.x;
    const dy = wp.y - mover.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      mover.x = wp.x;
      mover.y = wp.y;
      mover.path.shift();
      budget -= dist;
    } else {
      mover.x += (dx / dist) * budget;
      mover.y += (dy / dist) * budget;
      budget = 0;
    }
  }
}

/** Any active daemon of the other side (or an operator, for wild daemons) within `radius`. */
export function hostileNear(world: World, d: Daemon, radius: number): boolean {
  for (const other of world.daemons.values()) {
    if (!other.active || other.hp <= 0 || other === d) continue;
    if ((other.ownerId === null) === (d.ownerId === null)) continue;
    if (distance(d, other) <= radius) return true;
  }
  if (d.ownerId === null) for (const op of world.operators.values()) if (distance(d, op) <= radius) return true;
  return false;
}

export function moveAll(world: World): void {
  for (const op of world.operators.values()) advance(op, OPERATOR_SPEED);
  for (const d of world.daemons.values()) {
    if (!d.active || d.hp <= 0) continue;
    if ((d.statuses.stalled ?? 0) > world.tick) continue;
    if (d.ownerId) {
      const op = world.operators.get(d.ownerId)!;
      const dist = distance(d, op);
      if (dist > LEASH_TILES && (d.path.length === 0 || world.tick % LEASH_REPATH_TICKS === 0)) {
        d.path = world.grid.findPath(d, op) ?? [];
      } else if (d.path.length === 0 && dist > FOLLOW_TILES) {
        d.path = world.grid.findPath(d, op) ?? [];
      }
    }
    const boost = d.trait === 'voidstep' && !hostileNear(world, d, VOIDSTEP_RADIUS) ? 1.5 : 1;
    advance(d, daemonSpeed(d.stats.speed) * boost);
  }
}
```

In `apps/sim/src/core/systems/progress.ts` (`resolveDefeats`, owned branch) count the crash:

```ts
    d.crashed = true;
    d.crashes++;
    world.deactivate(d);
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 274 tests (27 files).

- [ ] **Step 5: Commit**

```bash
git add apps/sim
git commit -m "feat(sim): trait, held-item and status effects; move-type and crash counters"
```

---

### Task 4: Client SDK declarations and final verification

**Files:**
- Modify: `apps/frontend/src/sdk-types.ts`

- [ ] **Step 1: Monaco declarations**

In `apps/frontend/src/sdk-types.ts` (the `SDK_TYPES` string):

1. Replace the `RamDaemon` interface with
   ```ts
     export interface EvolutionOption { form: string; name: string; level: number; hidden: boolean; revealed: boolean; met: boolean; requirement: unknown[] | null }
     export interface RamDaemon {
       id: string; species: string; level: number; xp: number; ivs: number[]; bonus: number[]; clean: boolean; signature: number;
       hp: number; maxHp: number; energy: number; moves: string[]; crashed: boolean; slot: number; cooldowns: Record<string, number>;
       heldItem: string | null; patched: boolean; moveTypeUses: number[]; crashes: number; evolutions: EvolutionOption[];
     }
   ```
2. After the `claimStarter … load` line of `OperatorApi` add
   ```ts
       evolve(daemonId: string, formId: string): Promise<unknown>; hold(daemonId: string, itemId: string): Promise<unknown>; unhold(daemonId: string): Promise<unknown>;
       useBitFlipper(daemonId: string, stat: 'hp' | 'attack' | 'defense' | 'focus' | 'resolve' | 'speed' | 'haste' | 'energy'): Promise<unknown>;
   ```
3. After the `on(name: 'tick', …)` overload add
   ```ts
       on(name: 'evolved', handler: (ev: { daemon: string; from: string; to: string; changes: unknown[] }) => void): () => void;
       on(name: 'discovery', handler: (ev: { form: string; operator: string; operatorName: string | null }) => void): () => void;
   ```

- [ ] **Step 2: Full verification**

```bash
pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=postgresql://... pnpm exec vitest run
```

Expected: 27 files, 274 tests, lint and type-check clean. Then boot the stack locally (sim with `AUTH_DEV_BYPASS=1`, api, `vite preview`) as in SP2 plan 3 and, from the browser console script, run `game.operator.evolve(game.self.ram[0].id, 'echolet')` on a level-8 starter (bump the level from the sim REPL or a dev-only tweak): the RAM card's `evolutions` entry flips to `met: true`, the command resolves with `{ species: 'echolet' }`, and a second browser session receives the `discovery` event. (The evolve UI itself is SP3a plan 4.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/sdk-types.ts
git commit -m "feat(frontend): SDK declarations for evolve, hold, unhold and the Bit Flipper"
```

---

## Self-review

- **Spec coverage:** §3.5 all 16 traits (Task 3 table, one test each in `traits.test.ts`); §3.6 four held items + `hold`/`unhold` + consumed evolution items + Bit Flipper `patched` (Tasks 2–3); §4.1 `evolutionOptions` / `applyEvolution` order and probabilities (Task 1, statistical tests); §4.2 counters, `evolve` command guards, intent, events (Task 2); §4.3 `Discovery` rows, cached ids refreshed on each first discovery (Task 2); §7 persistence fields, `Discovery` table, idempotent `evolve` intent, wider checkpoint (Task 2); §8 commands/events/`RamDaemon`/SDK (Task 2, Task 4). `arenaWins` is stored and read but never incremented (SP6). The Codex API and client UI are plan 4.
- **Type consistency:** `Requirement` flows unchanged from `bestiary.ts` → `SpeciesDef.requirement` → `EvolutionOption.requirement` → `RamDaemon.evolutions[].requirement` (typed `unknown[]` on the wire). `HistoryEntry` is the one shape in `model.ts`, `store.ts`, `prisma-store.ts` (cast to `Prisma.InputJsonValue` only at the Prisma boundary).
- **Placeholders:** none; every step carries its code.
