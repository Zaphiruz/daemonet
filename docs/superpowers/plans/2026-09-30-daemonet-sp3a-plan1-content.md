# Daemonet SP3a · Plan 1 — Content: bestiary, stats, 64 moves, type chart, traits, items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the whole bestiary into `@daemonet/rules` as data: all 50 lines / 256 species with deterministic, budget-exact base stats, 64 moves (4 per type, one status per type), the full 16×16 type chart, 16 traits paired by role, 4 held items + 16 evolution items, and `lo` spawning every base form — with tests that enforce every invariant so hand tuning later cannot break the budgets.

**Architecture:** `content/bestiary.ts` is a literal transcription of the bestiary spec (id, line, stage, types, role, evolution edge, requirement, hidden). `content/species.ts` derives everything else from it: stats via role weights × per-species jitter, learnsets from the type move tables, traits/behaviour from the role, `STAT_OVERRIDES` for hand tuning (SP1's eight species keep their exact numbers). Moves and the chart are generated from small tables (`TYPE_MOVES`, `BEATS`, `RESISTED_BY`, `IMMUNE`) with the SP1 numbers preserved. Nothing in the sim, API or client needs to change for this plan except the shared status enum — the new content flows through the existing code.

**Tech Stack:** as before (TypeScript, Vitest, fast-check unchanged).

**Prerequisites:** SP2 complete.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3a-daemon-depth-design.md` §3 and §6; the bestiary spec.

## Global Constraints

- Everything from the earlier plans.
- Content tables stay deep-frozen (added after SP1 plan 1's final review): wherever this plan replaces `items.ts`, `traits.ts`, `types.ts`, `moves.ts` or `species.ts`, wrap every exported table (`ITEMS`, `STARTING_INVENTORY`, `TRAITS`, `TYPES`, the type chart, `MOVES`, `SPECIES`) and the new `BESTIARY` in `deepFreeze(...)` from `../freeze.js`, as the SP1 code does; `packages/rules/test/freeze.test.ts` must stay green (add `BESTIARY` to it).
- Base-stat totals: 300 / 420 / 500 / 540 by tree depth, capstones 600, starter lines ×0.95 — a test asserts every species sums exactly to its budget.
- Every evolution edge, requirement item/type/stat and hidden flag in `bestiary.ts` must match the bestiary spec (the transcription is verbatim; if the spec changes, change both).
- The SP1 corner of the chart and the SP1 move numbers do not change (existing sim tests rely on them).
- Status ids are a shared enum (`STATUS_IDS` in rules → `StatusSchema` in shared).

## File map

```
packages/rules/src/content/bestiary.ts     256 rows + Requirement/Role types
packages/rules/src/content/items.ts        tools, restore, 4 held, bitflipper, 16 evolution items
packages/rules/src/content/traits.ts       16 traits + ROLE_TRAITS
packages/rules/src/types.ts                BEATS / RESISTED_BY / IMMUNE, singleMultiplier, typeMultiplier
packages/rules/src/content/moves.ts        TYPE_MOVES, TYPE_STATUS, 64 generated MoveDefs, moveSlot
packages/rules/src/content/species.ts      budgets, ROLE_WEIGHTS, STAT_OVERRIDES, baseStatsFor, SPECIES, evolutionsOf, dominantStat
packages/rules/src/content/subnets.ts      lo spawns all 50 bases by band
packages/rules/src/index.ts                + bestiary export
packages/shared/src/protocol.ts            StatusSchema from STATUS_IDS
packages/rules/test/bestiary.test.ts       (replaces content.test.ts)
apps/api/test/app.test.ts                  codex species count 256
```

---

### Task 1: Bestiary data, items and traits

**Files:**
- Create: `packages/rules/src/content/bestiary.ts`
- Modify: `packages/rules/src/content/items.ts`, `packages/rules/src/content/traits.ts`, `packages/rules/src/index.ts`
- Test: `packages/rules/test/bestiary.test.ts`; delete `packages/rules/test/content.test.ts`

**Interfaces:**
- `type Role`, `type Requirement` (discriminated on `kind`: `heldItem | dominantIV | moveTypeUses | subnet | clean | signature | originalOperator | crashes | arenaWins | unobserved`), `interface BestiaryRow { id; name; line; stage; types; role; starter; capstone; evolvesFrom; evolvesAt; requirement; hidden }`, `BESTIARY: readonly BestiaryRow[]` (256).
- Items: `HeldDef` (`amplifier | heatsink | battery | firewall`, `effect`, `multiplier`), `EvolutionItemDef` (16, one per type), `BitFlipperDef`, `EVOLUTION_ITEMS`, `isHoldable(id)`; tools/restore unchanged.
- Traits: same 16 ids as SP1 with the SP3a effect texts; `ROLE_TRAITS: Record<Role, [string, string]>`.

- [ ] **Step 1: Write the failing tests** (delete `packages/rules/test/content.test.ts` first — its species/move/items expectations are superseded by this file, which grows in Tasks 2–4)

`packages/rules/test/bestiary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { EVOLUTION_ITEMS, getItem } from '../src/content/items.js';
import { ROLE_TRAITS, TRAITS, getTrait } from '../src/content/traits.js';
import { TYPES } from '../src/types.js';

describe('bestiary data', () => {
  it('has 50 lines, 256 species, 4 starters and 8 capstones', () => {
    expect(BESTIARY).toHaveLength(256);
    expect(new Set(BESTIARY.map((r) => r.line)).size).toBe(50);
    expect(BESTIARY.filter((r) => r.stage === 0)).toHaveLength(50);
    expect(BESTIARY.filter((r) => r.starter).map((r) => r.id).sort()).toEqual(['glitchmite', 'hashling', 'nullpup', 'pingling']);
    expect(BESTIARY.filter((r) => r.capstone)).toHaveLength(8);
    expect(new Set(BESTIARY.map((r) => r.id)).size).toBe(256);
  });

  it('links every evolution to an existing parent at a power-of-2 level with valid requirements', () => {
    const ids = new Set(BESTIARY.map((r) => r.id));
    for (const r of BESTIARY) {
      expect(r.types.length).toBeGreaterThanOrEqual(1);
      expect(r.types.length).toBeLessThanOrEqual(2);
      if (r.stage === 0) {
        expect(r.evolvesFrom).toBeNull();
        expect(r.types).toHaveLength(1);
      } else {
        expect(ids.has(r.evolvesFrom!)).toBe(true);
        expect([8, 16, 32, 64]).toContain(r.evolvesAt);
        expect(r.capstone).toBe(r.evolvesAt === 64);
      }
      for (const q of r.requirement ?? []) {
        if (q.kind === 'heldItem') expect(getItem(q.item).kind).toBe('evolution');
        if (q.kind === 'moveTypeUses') expect(TYPES).toContain(q.type);
        if (q.kind === 'dominantIV') expect(STAT_KEYS).toContain(q.stat);
      }
      if (r.hidden) expect(r.requirement).not.toBeNull();
    }
  });
});

describe('traits and items', () => {
  it('has 16 traits assigned in pairs per role, 4 held items and 16 evolution items', () => {
    expect(TRAITS).toHaveLength(16);
    for (const pair of Object.values(ROLE_TRAITS)) for (const id of pair) expect(() => getTrait(id)).not.toThrow();
    expect(EVOLUTION_ITEMS).toHaveLength(16);
    expect(new Set(EVOLUTION_ITEMS.map((i) => i.type)).size).toBe(16);
    expect(getItem('heatsink')).toMatchObject({ kind: 'held', effect: 'cooldown', multiplier: 0.875 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/bestiary.test.ts`
Expected: FAIL — cannot resolve `../src/content/bestiary.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/content/bestiary.ts` (transcribed from the bestiary spec §6; species ids are the names lower-cased with punctuation removed):

```ts
import type { StatKey } from '../constants.js';
import type { TypeId } from '../types.js';

export type Role = 'balanced' | 'sweeper' | 'nuker' | 'tank' | 'wall' | 'striker' | 'spammer' | 'support' | 'scout' | 'bruiser' | 'battery';

export type Requirement =
  | { kind: 'heldItem'; item: string }
  | { kind: 'dominantIV'; stat: StatKey }
  | { kind: 'moveTypeUses'; type: TypeId; count: number }
  | { kind: 'subnet'; subnet: string }
  | { kind: 'clean' }
  | { kind: 'signature'; min: number }
  | { kind: 'originalOperator' }
  | { kind: 'crashes'; op: 'min' | 'max'; count: number }
  | { kind: 'arenaWins'; count: number }
  | { kind: 'unobserved' };

export interface BestiaryRow {
  id: string;
  name: string;
  /** Bestiary line 1-50. */
  line: number;
  /** 0 = base form; capstones are 4. */
  stage: number;
  types: readonly TypeId[];
  role: Role;
  starter: boolean;
  capstone: boolean;
  /** Species id this form evolves from, and the level it evolves at. */
  evolvesFrom: string | null;
  evolvesAt: number | null;
  /** All must hold. null = no requirement beyond level. */
  requirement: readonly Requirement[] | null;
  /** Shown as ??? until first discovered. */
  hidden: boolean;
}

/** Transcribed from docs/superpowers/specs/2026-09-29-daemonet-bestiary-design.md (50 lines, 256 species). */
export const BESTIARY: readonly BestiaryRow[] = [
  { id: 'initling', name: 'Initling', line: 1, stage: 0, types: ['kernel'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'bootlet', name: 'Bootlet', line: 1, stage: 1, types: ['kernel'], role: 'balanced', starter: false, capstone: false, evolvesFrom: 'initling', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'inittab', name: 'Inittab', line: 1, stage: 2, types: ['kernel', 'shell'], role: 'support', starter: false, capstone: false, evolvesFrom: 'bootlet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'upstarter', name: 'Upstarter', line: 1, stage: 2, types: ['kernel', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'bootlet', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'sysvern', name: 'Sysvern', line: 1, stage: 3, types: ['kernel', 'shell'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'inittab', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'runlevion', name: 'Runlevion', line: 1, stage: 3, types: ['kernel', 'root'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'inittab', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'setuidbit' }], hidden: false },
  { id: 'systemdra', name: 'Systemdra', line: 1, stage: 3, types: ['kernel', 'signal'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'upstarter', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'launchdrake', name: 'Launchdrake', line: 1, stage: 3, types: ['kernel', 'cloud'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'upstarter', evolvesAt: 32, requirement: [{ kind: 'subnet', subnet: 'cloudnet' }], hidden: true },
  { id: 'pidzero', name: 'Pidzero', line: 1, stage: 4, types: ['kernel'], role: 'balanced', starter: false, capstone: true, evolvesFrom: 'systemdra', evolvesAt: 64, requirement: [{ kind: 'originalOperator' }, { kind: 'crashes', op: 'max', count: 0 }], hidden: true },
  { id: 'syscub', name: 'Syscub', line: 2, stage: 0, types: ['kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'trapbear', name: 'Trapbear', line: 2, stage: 1, types: ['kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'syscub', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'ioctlynx', name: 'Ioctlynx', line: 2, stage: 1, types: ['kernel', 'socket'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'syscub', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
  { id: 'syscallossus', name: 'Syscallossus', line: 2, stage: 2, types: ['kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'trapbear', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'ioctalon', name: 'Ioctalon', line: 2, stage: 2, types: ['kernel', 'socket'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'ioctlynx', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'irqlet', name: 'Irqlet', line: 3, stage: 0, types: ['kernel'], role: 'spammer', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'interruptor', name: 'Interruptor', line: 3, stage: 1, types: ['kernel', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'irqlet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'nomaskara', name: 'Nomaskara', line: 3, stage: 2, types: ['kernel', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'interruptor', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'tickling', name: 'Tickling', line: 4, stage: 0, types: ['kernel'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'jiffox', name: 'Jiffox', line: 4, stage: 1, types: ['kernel'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'tickling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'schedragon', name: 'Schedragon', line: 4, stage: 2, types: ['kernel', 'thread'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'jiffox', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'pingling', name: 'Pingling', line: 5, stage: 0, types: ['packet'], role: 'scout', starter: true, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'echolet', name: 'Echolet', line: 5, stage: 1, types: ['packet'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'pingling', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'tracerat', name: 'Tracerat', line: 5, stage: 2, types: ['packet', 'signal'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'echolet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'broadcaw', name: 'Broadcaw', line: 5, stage: 2, types: ['packet'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'echolet', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
  { id: 'hopmaster', name: 'Hopmaster', line: 5, stage: 3, types: ['packet', 'signal'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'tracerat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'pathfinch', name: 'Pathfinch', line: 5, stage: 3, types: ['packet', 'proxy'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'tracerat', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
  { id: 'multicastor', name: 'Multicastor', line: 5, stage: 3, types: ['packet', 'buffer'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'broadcaw', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'anycastrel', name: 'Anycastrel', line: 5, stage: 3, types: ['packet', 'cloud'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'broadcaw', evolvesAt: 32, requirement: [{ kind: 'dominantIV', stat: 'speed' }], hidden: true },
  { id: 'pingodeth', name: 'Pingodeth', line: 5, stage: 4, types: ['packet', 'glitch'], role: 'sweeper', starter: false, capstone: true, evolvesFrom: 'hopmaster', evolvesAt: 64, requirement: [{ kind: 'moveTypeUses', type: 'packet', count: 4096 }, { kind: 'subnet', subnet: 'backbone' }], hidden: true },
  { id: 'floodhound', name: 'Floodhound', line: 6, stage: 0, types: ['packet'], role: 'striker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'synhound', name: 'Synhound', line: 6, stage: 1, types: ['packet'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'floodhound', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'ackhound', name: 'Ackhound', line: 6, stage: 1, types: ['packet', 'socket'], role: 'balanced', starter: false, capstone: false, evolvesFrom: 'floodhound', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
  { id: 'ddosberman', name: 'DDoSberman', line: 6, stage: 2, types: ['packet', 'buffer'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'synhound', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'ackerberus', name: 'Ackerberus', line: 6, stage: 2, types: ['packet', 'socket'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'ackhound', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'fraglet', name: 'Fraglet', line: 7, stage: 0, types: ['packet'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'reassemblob', name: 'Reassemblob', line: 7, stage: 1, types: ['packet', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'fraglet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'jumbeast', name: 'Jumbeast', line: 7, stage: 2, types: ['packet', 'buffer'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'reassemblob', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'hashling', name: 'Hashling', line: 8, stage: 0, types: ['crypto'], role: 'balanced', starter: true, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'digestoad', name: 'Digestoad', line: 8, stage: 1, types: ['crypto'], role: 'balanced', starter: false, capstone: false, evolvesFrom: 'hashling', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'saltamander', name: 'Saltamander', line: 8, stage: 2, types: ['crypto'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'digestoad', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'pepperpent', name: 'Pepperpent', line: 8, stage: 2, types: ['crypto', 'glitch'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'digestoad', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
  { id: 'bcryptile', name: 'Bcryptile', line: 8, stage: 3, types: ['crypto'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'saltamander', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'argonaut', name: 'Argonaut', line: 8, stage: 3, types: ['crypto', 'heap'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'saltamander', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
  { id: 'shadragon', name: 'Shadragon', line: 8, stage: 3, types: ['crypto', 'glitch'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'pepperpent', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'merklion', name: 'Merklion', line: 8, stage: 3, types: ['crypto', 'root'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'pepperpent', evolvesAt: 32, requirement: [{ kind: 'originalOperator' }, { kind: 'arenaWins', count: 16 }], hidden: true },
  { id: 'collider', name: 'Collider', line: 8, stage: 4, types: ['crypto', 'glitch'], role: 'nuker', starter: false, capstone: true, evolvesFrom: 'shadragon', evolvesAt: 64, requirement: [{ kind: 'clean' }], hidden: true },
  { id: 'cipherbat', name: 'Cipherbat', line: 9, stage: 0, types: ['crypto'], role: 'nuker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'blockbat', name: 'Blockbat', line: 9, stage: 1, types: ['crypto'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'cipherbat', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'streamwing', name: 'Streamwing', line: 9, stage: 1, types: ['crypto', 'packet'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'cipherbat', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
  { id: 'aesferatu', name: 'Aesferatu', line: 9, stage: 2, types: ['crypto', 'null'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'blockbat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'chachawing', name: 'Chachawing', line: 9, stage: 2, types: ['crypto', 'packet'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'streamwing', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'nonceling', name: 'Nonceling', line: 10, stage: 0, types: ['crypto'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'entropix', name: 'Entropix', line: 10, stage: 1, types: ['crypto'], role: 'support', starter: false, capstone: false, evolvesFrom: 'nonceling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'chaosigil', name: 'Chaosigil', line: 10, stage: 2, types: ['crypto', 'glitch'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'entropix', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'hitling', name: 'Hitling', line: 11, stage: 0, types: ['cache'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'warmcat', name: 'Warmcat', line: 11, stage: 1, types: ['cache'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'hitling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'prefetchet', name: 'Prefetchet', line: 11, stage: 1, types: ['cache', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'hitling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'hotpanther', name: 'Hotpanther', line: 11, stage: 2, types: ['cache'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'warmcat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'prophetch', name: 'Prophetch', line: 11, stage: 2, types: ['cache', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'prefetchet', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'missmoth', name: 'Missmoth', line: 12, stage: 0, types: ['cache'], role: 'striker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'pagefaulter', name: 'Pagefaulter', line: 12, stage: 1, types: ['cache', 'kernel'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'missmoth', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'thrashmoth', name: 'Thrashmoth', line: 12, stage: 2, types: ['cache', 'kernel'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'pagefaulter', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'lruk', name: 'Lruk', line: 13, stage: 0, types: ['cache'], role: 'wall', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'evictern', name: 'Evictern', line: 13, stage: 1, types: ['cache'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'lruk', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'tiercrow', name: 'Tiercrow', line: 13, stage: 2, types: ['cache', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'evictern', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'forkling', name: 'Forkling', line: 14, stage: 0, types: ['thread'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'execdra', name: 'Execdra', line: 14, stage: 1, types: ['thread', 'shell'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'forkling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'clonewisp', name: 'Clonewisp', line: 14, stage: 1, types: ['thread', 'glitch'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'forkling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
  { id: 'fibrill', name: 'Fibrill', line: 14, stage: 1, types: ['thread', 'stack'], role: 'support', starter: false, capstone: false, evolvesFrom: 'forkling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'guardpage' }], hidden: false },
  { id: 'goroutern', name: 'Goroutern', line: 14, stage: 1, types: ['thread', 'cloud'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'forkling', evolvesAt: 16, requirement: [{ kind: 'subnet', subnet: 'cloudnet' }], hidden: true },
  { id: 'execalibur', name: 'Execalibur', line: 14, stage: 2, types: ['thread', 'shell'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'execdra', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'clonestorm', name: 'Clonestorm', line: 14, stage: 2, types: ['thread', 'glitch'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'clonewisp', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'corovex', name: 'Corovex', line: 14, stage: 2, types: ['thread', 'stack'], role: 'support', starter: false, capstone: false, evolvesFrom: 'fibrill', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'chanaconda', name: 'Chanaconda', line: 14, stage: 2, types: ['thread', 'cloud'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'goroutern', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'forkbomb', name: 'Forkbomb', line: 14, stage: 3, types: ['thread', 'glitch'], role: 'spammer', starter: false, capstone: true, evolvesFrom: 'clonestorm', evolvesAt: 64, requirement: [{ kind: 'subnet', subnet: 'kernelspace' }, { kind: 'moveTypeUses', type: 'thread', count: 4096 }], hidden: true },
  { id: 'mutexel', name: 'Mutexel', line: 15, stage: 0, types: ['thread'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'lockstoat', name: 'Lockstoat', line: 15, stage: 1, types: ['thread'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'mutexel', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'semaferret', name: 'Semaferret', line: 15, stage: 1, types: ['thread', 'signal'], role: 'support', starter: false, capstone: false, evolvesFrom: 'mutexel', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'deadlockodile', name: 'Deadlockodile', line: 15, stage: 2, types: ['thread', 'null'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'lockstoat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'monitaur', name: 'Monitaur', line: 15, stage: 2, types: ['thread', 'signal'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'semaferret', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'racecon', name: 'Racecon', line: 16, stage: 0, types: ['thread'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'dataracer', name: 'Dataracer', line: 16, stage: 1, types: ['thread'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'racecon', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'toctoucan', name: 'Toctoucan', line: 16, stage: 1, types: ['thread', 'glitch'], role: 'support', starter: false, capstone: false, evolvesFrom: 'racecon', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
  { id: 'hazardash', name: 'Hazardash', line: 16, stage: 2, types: ['thread'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'dataracer', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'timewarbler', name: 'Timewarbler', line: 16, stage: 2, types: ['thread', 'glitch'], role: 'support', starter: false, capstone: false, evolvesFrom: 'toctoucan', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'sigkit', name: 'Sigkit', line: 17, stage: 0, types: ['signal'], role: 'striker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'termcat', name: 'Termcat', line: 17, stage: 1, types: ['signal'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'sigkit', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'sigstop', name: 'Sigstop', line: 17, stage: 1, types: ['signal', 'thread'], role: 'support', starter: false, capstone: false, evolvesFrom: 'sigkit', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'spinlock' }], hidden: false },
  { id: 'sigkillion', name: 'Sigkillion', line: 17, stage: 2, types: ['signal'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'termcat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'pausepanther', name: 'Pausepanther', line: 17, stage: 2, types: ['signal', 'thread'], role: 'support', starter: false, capstone: false, evolvesFrom: 'sigstop', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'hupling', name: 'Hupling', line: 18, stage: 0, types: ['signal'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'reloadog', name: 'Reloadog', line: 18, stage: 1, types: ['signal'], role: 'support', starter: false, capstone: false, evolvesFrom: 'hupling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'respawnd', name: 'Respawnd', line: 18, stage: 2, types: ['signal', 'kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'reloadog', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'trapfly', name: 'Trapfly', line: 19, stage: 0, types: ['signal'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'breakpointer', name: 'Breakpointer', line: 19, stage: 1, types: ['signal', 'stack'], role: 'support', starter: false, capstone: false, evolvesFrom: 'trapfly', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'debugonfly', name: 'Debugonfly', line: 19, stage: 2, types: ['signal', 'stack'], role: 'support', starter: false, capstone: false, evolvesFrom: 'breakpointer', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'portling', name: 'Portling', line: 20, stage: 0, types: ['socket'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'httpard', name: 'Httpard', line: 20, stage: 1, types: ['socket', 'cloud'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'portling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'sshark', name: 'Sshark', line: 20, stage: 1, types: ['socket', 'crypto'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'portling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
  { id: 'dnsnake', name: 'Dnsnake', line: 20, stage: 1, types: ['socket', 'proxy'], role: 'support', starter: false, capstone: false, evolvesFrom: 'portling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
  { id: 'smtpelican', name: 'Smtpelican', line: 20, stage: 1, types: ['socket', 'packet'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'portling', evolvesAt: 16, requirement: [{ kind: 'dominantIV', stat: 'energy' }], hidden: true },
  { id: 'quicheetah', name: 'Quicheetah', line: 20, stage: 2, types: ['socket', 'cloud'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'httpard', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'greatsshark', name: 'Greatsshark', line: 20, stage: 2, types: ['socket', 'crypto'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'sshark', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'resolviper', name: 'Resolviper', line: 20, stage: 2, types: ['socket', 'proxy'], role: 'support', starter: false, capstone: false, evolvesFrom: 'dnsnake', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'spamatross', name: 'Spamatross', line: 20, stage: 2, types: ['socket', 'packet'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'smtpelican', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'bindbug', name: 'Bindbug', line: 21, stage: 0, types: ['socket'], role: 'wall', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'listenbug', name: 'Listenbug', line: 21, stage: 1, types: ['socket'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'bindbug', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'connectick', name: 'Connectick', line: 21, stage: 1, types: ['socket', 'packet'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'bindbug', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
  { id: 'acceptarantula', name: 'Acceptarantula', line: 21, stage: 2, types: ['socket'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'listenbug', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'streamantis', name: 'Streamantis', line: 21, stage: 2, types: ['socket', 'packet'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'connectick', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'shakelet', name: 'Shakelet', line: 22, stage: 0, types: ['socket'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'synackle', name: 'Synackle', line: 22, stage: 1, types: ['socket'], role: 'balanced', starter: false, capstone: false, evolvesFrom: 'shakelet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'tlsamurai', name: 'Tlsamurai', line: 22, stage: 2, types: ['socket', 'crypto'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'synackle', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'spillard', name: 'Spillard', line: 23, stage: 0, types: ['buffer'], role: 'striker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'smashgecko', name: 'Smashgecko', line: 23, stage: 1, types: ['buffer'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'spillard', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'spraygon', name: 'Spraygon', line: 23, stage: 1, types: ['buffer', 'heap'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'spillard', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
  { id: 'smashagator', name: 'Smashagator', line: 23, stage: 2, types: ['buffer', 'stack'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'smashgecko', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'sprayvern', name: 'Sprayvern', line: 23, stage: 2, types: ['buffer', 'heap'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'spraygon', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'ringlet', name: 'Ringlet', line: 24, stage: 0, types: ['buffer'], role: 'battery', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'wrapsnake', name: 'Wrapsnake', line: 24, stage: 1, types: ['buffer'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'ringlet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'ourobyte', name: 'Ourobyte', line: 24, stage: 2, types: ['buffer'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'wrapsnake', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'queuepillar', name: 'Queuepillar', line: 25, stage: 0, types: ['buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'queuepa', name: 'Queuepa', line: 25, stage: 1, types: ['buffer'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'queuepillar', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'brokerpa', name: 'Brokerpa', line: 25, stage: 1, types: ['buffer', 'cloud'], role: 'support', starter: false, capstone: false, evolvesFrom: 'queuepillar', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'regiontoken' }], hidden: false },
  { id: 'priorifly', name: 'Priorifly', line: 25, stage: 2, types: ['buffer'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'queuepa', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'streamoth', name: 'Streamoth', line: 25, stage: 2, types: ['buffer', 'cloud'], role: 'support', starter: false, capstone: false, evolvesFrom: 'brokerpa', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'promptling', name: 'Promptling', line: 26, stage: 0, types: ['shell'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'bashog', name: 'Bashog', line: 26, stage: 1, types: ['shell'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'promptling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'zshrike', name: 'Zshrike', line: 26, stage: 1, types: ['shell', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'promptling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'dotfile' }], hidden: false },
  { id: 'fishell', name: 'Fishell', line: 26, stage: 1, types: ['shell', 'cache'], role: 'support', starter: false, capstone: false, evolvesFrom: 'promptling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'warmcache' }], hidden: false },
  { id: 'pwshrew', name: 'Pwshrew', line: 26, stage: 1, types: ['shell', 'cloud'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'promptling', evolvesAt: 16, requirement: [{ kind: 'dominantIV', stat: 'resolve' }], hidden: true },
  { id: 'bashemoth', name: 'Bashemoth', line: 26, stage: 2, types: ['shell'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'bashog', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'zshraptor', name: 'Zshraptor', line: 26, stage: 2, types: ['shell', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'zshrike', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'leviafish', name: 'Leviafish', line: 26, stage: 2, types: ['shell', 'cache'], role: 'support', starter: false, capstone: false, evolvesFrom: 'fishell', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'objectaur', name: 'Objectaur', line: 26, stage: 2, types: ['shell', 'cloud'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'pwshrew', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'pipeon', name: 'Pipeon', line: 27, stage: 0, types: ['shell'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'teegull', name: 'Teegull', line: 27, stage: 1, types: ['shell'], role: 'support', starter: false, capstone: false, evolvesFrom: 'pipeon', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'fifowl', name: 'Fifowl', line: 27, stage: 1, types: ['shell', 'buffer'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'pipeon', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'ringseal' }], hidden: false },
  { id: 'xargoyle', name: 'Xargoyle', line: 27, stage: 2, types: ['shell'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'teegull', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'streamowl', name: 'Streamowl', line: 27, stage: 2, types: ['shell', 'buffer'], role: 'battery', starter: false, capstone: false, evolvesFrom: 'fifowl', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'globber', name: 'Globber', line: 28, stage: 0, types: ['shell'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'wildcardinal', name: 'Wildcardinal', line: 28, stage: 1, types: ['shell'], role: 'support', starter: false, capstone: false, evolvesFrom: 'globber', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'regexolotl', name: 'Regexolotl', line: 28, stage: 2, types: ['shell', 'glitch'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'wildcardinal', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'sudoling', name: 'Sudoling', line: 29, stage: 0, types: ['root'], role: 'striker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'sudoer', name: 'Sudoer', line: 29, stage: 1, types: ['root'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'sudoling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'suidhawk', name: 'Suidhawk', line: 29, stage: 1, types: ['root', 'shell'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'sudoling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'dotfile' }], hidden: false },
  { id: 'superuserpent', name: 'Superuserpent', line: 29, stage: 2, types: ['root'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'sudoer', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'visudoe', name: 'Visudoe', line: 29, stage: 2, types: ['root', 'shell'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'suidhawk', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'rootkitten', name: 'Rootkitten', line: 30, stage: 0, types: ['root'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'hookat', name: 'Hookat', line: 30, stage: 1, types: ['root'], role: 'support', starter: false, capstone: false, evolvesFrom: 'rootkitten', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'bootkit', name: 'Bootkit', line: 30, stage: 1, types: ['root', 'kernel'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'rootkitten', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'bootsector' }], hidden: false },
  { id: 'rootkitsune', name: 'Rootkitsune', line: 30, stage: 2, types: ['root'], role: 'support', starter: false, capstone: false, evolvesFrom: 'hookat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'firmwarg', name: 'Firmwarg', line: 30, stage: 2, types: ['root', 'kernel'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'bootkit', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'ringminus', name: 'Ringminus', line: 30, stage: 3, types: ['root', 'kernel'], role: 'striker', starter: false, capstone: true, evolvesFrom: 'firmwarg', evolvesAt: 64, requirement: [{ kind: 'subnet', subnet: 'kernelspace' }, { kind: 'dominantIV', stat: 'attack' }], hidden: true },
  { id: 'chmole', name: 'Chmole', line: 31, stage: 0, types: ['root'], role: 'wall', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'umaskunk', name: 'Umaskunk', line: 31, stage: 1, types: ['root'], role: 'support', starter: false, capstone: false, evolvesFrom: 'chmole', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'aclpaca', name: 'Aclpaca', line: 31, stage: 2, types: ['root', 'shell'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'umaskunk', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'nullpup', name: 'Nullpup', line: 32, stage: 0, types: ['null'], role: 'balanced', starter: true, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'nullhound', name: 'Nullhound', line: 32, stage: 1, types: ['null'], role: 'balanced', starter: false, capstone: false, evolvesFrom: 'nullpup', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'undefido', name: 'Undefido', line: 32, stage: 2, types: ['null'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'nullhound', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'nanwolf', name: 'Nanwolf', line: 32, stage: 2, types: ['null', 'glitch'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'nullhound', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
  { id: 'maybemastiff', name: 'Maybemastiff', line: 32, stage: 3, types: ['null'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'undefido', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'tombstag', name: 'Tombstag', line: 32, stage: 3, types: ['null', 'heap'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'undefido', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
  { id: 'infinitwolf', name: 'Infinitwolf', line: 32, stage: 3, types: ['null', 'glitch'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'nanwolf', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'segfang', name: 'Segfang', line: 32, stage: 3, types: ['null', 'kernel'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'nanwolf', evolvesAt: 32, requirement: [{ kind: 'crashes', op: 'min', count: 64 }], hidden: true },
  { id: 'derefiend', name: 'Derefiend', line: 32, stage: 4, types: ['null', 'kernel'], role: 'striker', starter: false, capstone: true, evolvesFrom: 'segfang', evolvesAt: 64, requirement: [{ kind: 'originalOperator' }, { kind: 'subnet', subnet: 'darknet' }], hidden: true },
  { id: 'voidlet', name: 'Voidlet', line: 33, stage: 0, types: ['null'], role: 'wall', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'voidwisp', name: 'Voidwisp', line: 33, stage: 1, types: ['null'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'voidlet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'blackholet', name: 'Blackholet', line: 33, stage: 1, types: ['null', 'cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'voidlet', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'regiontoken' }], hidden: false },
  { id: 'voidmaw', name: 'Voidmaw', line: 33, stage: 2, types: ['null'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'voidwisp', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'horizoneel', name: 'Horizoneel', line: 33, stage: 2, types: ['null', 'cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'blackholet', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'sinkling', name: 'Sinkling', line: 34, stage: 0, types: ['null'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'bitbucketoad', name: 'Bitbucketoad', line: 34, stage: 1, types: ['null'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'sinkling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'nulliathan', name: 'Nulliathan', line: 34, stage: 2, types: ['null', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'bitbucketoad', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'nilwisp', name: 'Nilwisp', line: 35, stage: 0, types: ['null'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'nilshade', name: 'Nilshade', line: 35, stage: 1, types: ['null'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'nilwisp', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'nilphantom', name: 'Nilphantom', line: 35, stage: 2, types: ['null', 'proxy'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'nilshade', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'glitchmite', name: 'Glitchmite', line: 36, stage: 0, types: ['glitch'], role: 'striker', starter: true, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'bitflea', name: 'Bitflea', line: 36, stage: 1, types: ['glitch'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'glitchmite', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'corruptoad', name: 'Corruptoad', line: 36, stage: 2, types: ['glitch'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'bitflea', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'tearwyrm', name: 'Tearwyrm', line: 36, stage: 2, types: ['glitch', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'bitflea', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'corruptitan', name: 'Corruptitan', line: 36, stage: 3, types: ['glitch'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'corruptoad', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'checksumander', name: 'Checksumander', line: 36, stage: 3, types: ['glitch', 'crypto'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'corruptoad', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
  { id: 'flickerwyrm', name: 'Flickerwyrm', line: 36, stage: 3, types: ['glitch', 'signal'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'tearwyrm', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'artifactopus', name: 'Artifactopus', line: 36, stage: 3, types: ['glitch', 'cache'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'tearwyrm', evolvesAt: 32, requirement: [{ kind: 'dominantIV', stat: 'haste' }], hidden: true },
  { id: 'bitrot', name: 'Bitrot', line: 37, stage: 0, types: ['glitch'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'rotgrub', name: 'Rotgrub', line: 37, stage: 1, types: ['glitch'], role: 'support', starter: false, capstone: false, evolvesFrom: 'bitrot', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'sectoroach', name: 'Sectoroach', line: 37, stage: 1, types: ['glitch', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'bitrot', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'ringseal' }], hidden: false },
  { id: 'decaypede', name: 'Decaypede', line: 37, stage: 2, types: ['glitch'], role: 'support', starter: false, capstone: false, evolvesFrom: 'rotgrub', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'fsckroach', name: 'Fsckroach', line: 37, stage: 2, types: ['glitch', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'sectoroach', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'heisenbug', name: 'Heisenbug', line: 38, stage: 0, types: ['glitch'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'quantibug', name: 'Quantibug', line: 38, stage: 1, types: ['glitch'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'heisenbug', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'bohrbug', name: 'Bohrbug', line: 38, stage: 1, types: ['glitch', 'stack'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'heisenbug', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'guardpage' }], hidden: false },
  { id: 'superposibug', name: 'Superposibug', line: 38, stage: 2, types: ['glitch'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'quantibug', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'mandelbug', name: 'Mandelbug', line: 38, stage: 2, types: ['glitch', 'stack'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'bohrbug', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'schrodibug', name: 'Schrodibug', line: 38, stage: 3, types: ['glitch', 'null'], role: 'sweeper', starter: false, capstone: true, evolvesFrom: 'superposibug', evolvesAt: 64, requirement: [{ kind: 'unobserved' }, { kind: 'signature', min: 1 }], hidden: true },
  { id: 'maskling', name: 'Maskling', line: 39, stage: 0, types: ['proxy'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'forwarden', name: 'Forwarden', line: 39, stage: 1, types: ['proxy'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'maskling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'reverseal', name: 'Reverseal', line: 39, stage: 1, types: ['proxy', 'socket'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'maskling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
  { id: 'glasswing', name: 'Glasswing', line: 39, stage: 1, types: ['proxy', 'null'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'maskling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'voidshard' }], hidden: false },
  { id: 'torchid', name: 'Torchid', line: 39, stage: 1, types: ['proxy', 'crypto'], role: 'support', starter: false, capstone: false, evolvesFrom: 'maskling', evolvesAt: 16, requirement: [{ kind: 'subnet', subnet: 'darknet' }], hidden: true },
  { id: 'gatewarden', name: 'Gatewarden', line: 39, stage: 2, types: ['proxy'], role: 'wall', starter: false, capstone: false, evolvesFrom: 'forwarden', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'loadbalrus', name: 'Loadbalrus', line: 39, stage: 2, types: ['proxy', 'socket'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'reverseal', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'phantomwing', name: 'Phantomwing', line: 39, stage: 2, types: ['proxy', 'null'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'glasswing', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'garlicvine', name: 'Garlicvine', line: 39, stage: 2, types: ['proxy', 'crypto'], role: 'support', starter: false, capstone: false, evolvesFrom: 'torchid', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'relayven', name: 'Relayven', line: 40, stage: 0, types: ['proxy'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'hopraven', name: 'Hopraven', line: 40, stage: 1, types: ['proxy'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'relayven', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'tunnelhawk', name: 'Tunnelhawk', line: 40, stage: 1, types: ['proxy', 'crypto'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'relayven', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
  { id: 'natrook', name: 'Natrook', line: 40, stage: 2, types: ['proxy'], role: 'support', starter: false, capstone: false, evolvesFrom: 'hopraven', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'wireguardian', name: 'Wireguardian', line: 40, stage: 2, types: ['proxy', 'crypto'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'tunnelhawk', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'tunnelope', name: 'Tunnelope', line: 41, stage: 0, types: ['proxy'], role: 'scout', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'encapsulope', name: 'Encapsulope', line: 41, stage: 1, types: ['proxy'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'tunnelope', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'vxlantler', name: 'Vxlantler', line: 41, stage: 2, types: ['proxy', 'packet'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'encapsulope', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'cirrusync', name: 'Cirrusync', line: 42, stage: 0, types: ['cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'cumulink', name: 'Cumulink', line: 42, stage: 1, types: ['cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'cirrusync', evolvesAt: 8, requirement: null, hidden: false },
  { id: 'stratoswarm', name: 'Stratoswarm', line: 42, stage: 2, types: ['cloud', 'thread'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'cumulink', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'edgewisp', name: 'Edgewisp', line: 42, stage: 2, types: ['cloud', 'proxy'], role: 'scout', starter: false, capstone: false, evolvesFrom: 'cumulink', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
  { id: 'orchestrix', name: 'Orchestrix', line: 42, stage: 3, types: ['cloud', 'thread'], role: 'support', starter: false, capstone: false, evolvesFrom: 'stratoswarm', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'shardhive', name: 'Shardhive', line: 42, stage: 3, types: ['cloud', 'heap'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'stratoswarm', evolvesAt: 32, requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
  { id: 'cdnimbus', name: 'Cdnimbus', line: 42, stage: 3, types: ['cloud', 'proxy'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'edgewisp', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'edgelord', name: 'Edgelord', line: 42, stage: 3, types: ['cloud', 'proxy'], role: 'sweeper', starter: false, capstone: false, evolvesFrom: 'edgewisp', evolvesAt: 32, requirement: [{ kind: 'arenaWins', count: 16 }], hidden: true },
  { id: 'lambkin', name: 'Lambkin', line: 43, stage: 0, types: ['cloud'], role: 'spammer', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'functram', name: 'Functram', line: 43, stage: 1, types: ['cloud'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'lambkin', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'triggoat', name: 'Triggoat', line: 43, stage: 1, types: ['cloud', 'signal'], role: 'support', starter: false, capstone: false, evolvesFrom: 'lambkin', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'ephemeram', name: 'Ephemeram', line: 43, stage: 2, types: ['cloud'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'functram', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'cronghorn', name: 'Cronghorn', line: 43, stage: 2, types: ['cloud', 'signal'], role: 'support', starter: false, capstone: false, evolvesFrom: 'triggoat', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'nimbyte', name: 'Nimbyte', line: 44, stage: 0, types: ['cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'stratobyte', name: 'Stratobyte', line: 44, stage: 1, types: ['cloud'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'nimbyte', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'stormbyte', name: 'Stormbyte', line: 44, stage: 2, types: ['cloud', 'signal'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'stratobyte', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'framelet', name: 'Framelet', line: 45, stage: 0, types: ['stack'], role: 'balanced', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'calleel', name: 'Calleel', line: 45, stage: 1, types: ['stack'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'framelet', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'tracebeetle', name: 'Tracebeetle', line: 45, stage: 1, types: ['stack', 'signal'], role: 'support', starter: false, capstone: false, evolvesFrom: 'framelet', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
  { id: 'returnado', name: 'Returnado', line: 45, stage: 2, types: ['stack'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'calleel', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'coredrake', name: 'Coredrake', line: 45, stage: 2, types: ['stack', 'signal'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'tracebeetle', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'recursel', name: 'Recursel', line: 46, stage: 0, types: ['stack'], role: 'spammer', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'tailcaller', name: 'Tailcaller', line: 46, stage: 1, types: ['stack'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'recursel', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'fractalisk', name: 'Fractalisk', line: 46, stage: 2, types: ['stack', 'glitch'], role: 'nuker', starter: false, capstone: false, evolvesFrom: 'tailcaller', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'stackrab', name: 'Stackrab', line: 47, stage: 0, types: ['stack'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'popcrab', name: 'Popcrab', line: 47, stage: 1, types: ['stack'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'stackrab', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'hermistack', name: 'Hermistack', line: 47, stage: 2, types: ['stack', 'buffer'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'popcrab', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'stackoverlord', name: 'Stackoverlord', line: 47, stage: 3, types: ['stack', 'buffer'], role: 'bruiser', starter: false, capstone: true, evolvesFrom: 'hermistack', evolvesAt: 64, requirement: [{ kind: 'moveTypeUses', type: 'stack', count: 4096 }, { kind: 'heldItem', item: 'guardpage' }], hidden: true },
  { id: 'mallocub', name: 'Mallocub', line: 48, stage: 0, types: ['heap'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'brkbear', name: 'Brkbear', line: 48, stage: 1, types: ['heap'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'mallocub', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'slabear', name: 'Slabear', line: 48, stage: 1, types: ['heap', 'kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'mallocub', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'bootsector' }], hidden: false },
  { id: 'mmapmammoth', name: 'Mmapmammoth', line: 48, stage: 2, types: ['heap'], role: 'bruiser', starter: false, capstone: false, evolvesFrom: 'brkbear', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'slabgrizzly', name: 'Slabgrizzly', line: 48, stage: 2, types: ['heap', 'kernel'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'slabear', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'leakling', name: 'Leakling', line: 49, stage: 0, types: ['heap'], role: 'tank', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'leakslug', name: 'Leakslug', line: 49, stage: 1, types: ['heap'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'leakling', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'danglerfish', name: 'Danglerfish', line: 49, stage: 1, types: ['heap', 'null'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'leakling', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'voidshard' }], hidden: false },
  { id: 'bloatwhale', name: 'Bloatwhale', line: 49, stage: 2, types: ['heap'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'leakslug', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'wildangler', name: 'Wildangler', line: 49, stage: 2, types: ['heap', 'null'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'danglerfish', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'garbadger', name: 'Garbadger', line: 50, stage: 0, types: ['heap'], role: 'support', starter: false, capstone: false, evolvesFrom: null, evolvesAt: null, requirement: null, hidden: false },
  { id: 'sweepbadger', name: 'Sweepbadger', line: 50, stage: 1, types: ['heap'], role: 'support', starter: false, capstone: false, evolvesFrom: 'garbadger', evolvesAt: 16, requirement: null, hidden: false },
  { id: 'genbadger', name: 'Genbadger', line: 50, stage: 1, types: ['heap', 'thread'], role: 'spammer', starter: false, capstone: false, evolvesFrom: 'garbadger', evolvesAt: 16, requirement: [{ kind: 'heldItem', item: 'spinlock' }], hidden: false },
  { id: 'compactaur', name: 'Compactaur', line: 50, stage: 2, types: ['heap'], role: 'tank', starter: false, capstone: false, evolvesFrom: 'sweepbadger', evolvesAt: 32, requirement: null, hidden: false },
  { id: 'haltverine', name: 'Haltverine', line: 50, stage: 2, types: ['heap', 'thread'], role: 'striker', starter: false, capstone: false, evolvesFrom: 'genbadger', evolvesAt: 32, requirement: null, hidden: false },
];
```

`packages/rules/src/content/items.ts`:

```ts
import type { TypeId } from '../types.js';

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

export type HeldEffect = 'damageDealt' | 'cooldown' | 'energyRegen' | 'damageTaken';

/** Worn in the single held-item slot; effect is a multiplier on the named quantity. */
export interface HeldDef {
  id: 'amplifier' | 'heatsink' | 'battery' | 'firewall';
  kind: 'held';
  name: string;
  effect: HeldEffect;
  multiplier: number;
}

/** Held and consumed by a branch that requires it (bestiary §3). */
export interface EvolutionItemDef {
  id: string;
  kind: 'evolution';
  name: string;
  type: TypeId;
}

/** Raises one IV by 1 (cap 31) and marks the daemon patched forever. */
export interface BitFlipperDef {
  id: 'bitflipper';
  kind: 'bitflipper';
  name: string;
}

export type ItemDef = ToolDef | RestoreDef | HeldDef | EvolutionItemDef | BitFlipperDef;
export type ItemId = ItemDef['id'];

export const EVOLUTION_ITEMS: readonly EvolutionItemDef[] = (
  [
    ['bootsector', 'Boot Sector', 'kernel'],
    ['jumboframe', 'Jumbo Frame', 'packet'],
    ['cipherkey', 'Cipher Key', 'crypto'],
    ['warmcache', 'Warm Cache', 'cache'],
    ['spinlock', 'Spinlock', 'thread'],
    ['sigmask', 'Sigmask', 'signal'],
    ['keepalive', 'Keepalive', 'socket'],
    ['ringseal', 'Ring Seal', 'buffer'],
    ['dotfile', 'Dotfile', 'shell'],
    ['setuidbit', 'Setuid Bit', 'root'],
    ['voidshard', 'Void Shard', 'null'],
    ['cosmicray', 'Cosmic Ray', 'glitch'],
    ['onionlayer', 'Onion Layer', 'proxy'],
    ['regiontoken', 'Region Token', 'cloud'],
    ['guardpage', 'Guard Page', 'stack'],
    ['arenachunk', 'Arena Chunk', 'heap'],
  ] as const
).map(([id, name, type]) => ({ id, kind: 'evolution' as const, name, type }));

export const ITEMS: readonly ItemDef[] = [
  { id: 'sniff', kind: 'tool', name: 'sniff', range: 4, deadlineMs: 2048, noise: 2, sizeMultiplier: 1 },
  { id: 'tap', kind: 'tool', name: 'tap', range: 6, deadlineMs: 4096, noise: 1, sizeMultiplier: 1 },
  { id: 'mirror', kind: 'tool', name: 'mirror', range: 8, deadlineMs: 4096, noise: 0, sizeMultiplier: 1 },
  { id: 'dump', kind: 'tool', name: 'dump', range: 8, deadlineMs: 8192, noise: 0, sizeMultiplier: 0.5 },
  { id: 'restore', kind: 'restore', name: 'restore' },
  { id: 'amplifier', kind: 'held', name: 'Amplifier', effect: 'damageDealt', multiplier: 1.125 },
  { id: 'heatsink', kind: 'held', name: 'Heatsink', effect: 'cooldown', multiplier: 0.875 },
  { id: 'battery', kind: 'held', name: 'Battery', effect: 'energyRegen', multiplier: 1.5 },
  { id: 'firewall', kind: 'held', name: 'Firewall', effect: 'damageTaken', multiplier: 0.875 },
  { id: 'bitflipper', kind: 'bitflipper', name: 'Bit Flipper' },
  ...EVOLUTION_ITEMS,
];

export const STARTING_INVENTORY: Readonly<Partial<Record<ItemId, number>>> = { sniff: 8, restore: 2 };

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): ItemDef {
  const item = BY_ID.get(id as ItemId);
  if (!item) throw new RangeError(`unknown item ${id}`);
  return item;
}

export function isToolId(id: string): id is ToolId {
  return BY_ID.get(id as ItemId)?.kind === 'tool';
}

export function getTool(id: ToolId): ToolDef {
  const item = getItem(id);
  if (item.kind !== 'tool') throw new RangeError(`${id} is not a tool`);
  return item;
}

/** Items that can sit in the held slot. */
export function isHoldable(id: string): boolean {
  const kind = BY_ID.get(id as ItemId)?.kind;
  return kind === 'held' || kind === 'evolution';
}
```

`packages/rules/src/content/traits.ts`:

```ts
import type { Role } from './bestiary.js';

export interface TraitDef {
  id: string;
  name: string;
  description: string;
}

/** Effects are implemented in the sim (SP3a spec §3.5). */
export const TRAITS: readonly TraitDef[] = [
  { id: 'echo', name: 'Echo', description: 'Filler moves (cooldown ≤ 512 ms) have a 25% chance to hit again at half power.' },
  { id: 'lowlatency', name: 'Low Latency', description: 'The first move after becoming active or being tagged ignores its cooldown.' },
  { id: 'synburst', name: 'SYN Burst', description: 'Filler moves cost no energy below 25% HP.' },
  { id: 'retransmit', name: 'Retransmit', description: 'An area move that hits nothing refunds its energy.' },
  { id: 'salted', name: 'Salted', description: 'Takes 25% less damage from the same move as the previous hit.' },
  { id: 'onewayfn', name: 'One-Way', description: 'Immune to status effects.' },
  { id: 'darkmode', name: 'Dark Mode', description: 'Moves with range 6 or more deal 25% less to it.' },
  { id: 'sonar', name: 'Sonar', description: '+2 range on single-target moves.' },
  { id: 'overclock', name: 'Overclock', description: 'Cooldowns −12.5% below 25% HP.' },
  { id: 'bitshield', name: 'Bitshield', description: 'The first hit in each engagement is blocked.' },
  { id: 'entropy', name: 'Entropy', description: 'Statuses it inflicts last 50% longer.' },
  { id: 'decay', name: 'Decay', description: 'Targets it hits lose 4 energy.' },
  { id: 'nullsafe', name: 'Null Safe', description: 'Survives one lethal hit per engagement at 1 HP.' },
  { id: 'lazyeval', name: 'Lazy Eval', description: 'Heavy moves (cooldown ≥ 4096 ms) cost 25% less energy.' },
  { id: 'voidstep', name: 'Void Step', description: '+50% movement speed with no hostile within 8 tiles.' },
  { id: 'absorb', name: 'Absorb', description: 'Regains energy equal to 10% of damage taken.' },
];

/** The two traits every species of a role can roll (slot 0 / slot 1). */
export const ROLE_TRAITS: Record<Role, readonly [string, string]> = {
  balanced: ['lowlatency', 'nullsafe'],
  sweeper: ['sonar', 'voidstep'],
  nuker: ['lazyeval', 'entropy'],
  tank: ['bitshield', 'absorb'],
  wall: ['salted', 'darkmode'],
  striker: ['echo', 'overclock'],
  spammer: ['synburst', 'decay'],
  support: ['entropy', 'retransmit'],
  scout: ['voidstep', 'lowlatency'],
  bruiser: ['overclock', 'nullsafe'],
  battery: ['absorb', 'synburst'],
};

const BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

export function getTrait(id: string): TraitDef {
  const t = BY_ID.get(id);
  if (!t) throw new RangeError(`unknown trait ${id}`);
  return t;
}
```

In `packages/rules/src/index.ts` add `export * from './content/bestiary.js';` before the `moves.js` export.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (rules: 62 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): bestiary data (256 species), held/evolution items, role traits"
```

---

### Task 2: The 16×16 type chart

**Files:**
- Modify: `packages/rules/src/types.ts`
- Test: `packages/rules/test/bestiary.test.ts` (add the `type chart` block)

**Interfaces:**
- `BEATS`, `RESISTED_BY`, `IMMUNE`, `singleMultiplier(attack, defender)`, `typeMultiplier(attack, defenders)` (unchanged signature).
- Properties: every type has exactly two ×2 targets, is the ×2 target of exactly two attackers, is resisted (×½) by itself and one other type that is not one of its own targets; one immunity (glitch → null); the SP1 corner is unchanged.

- [ ] **Step 1: Add the failing tests**

Append to `packages/rules/test/bestiary.test.ts` (and add `BEATS, IMMUNE, RESISTED_BY, TYPES, singleMultiplier, typeMultiplier` to the `../src/types.js` import):

```ts
describe('type chart', () => {
  it('gives every type exactly two strengths, is a strength of exactly two attackers, and two resisters', () => {
    for (const t of TYPES) {
      expect(BEATS[t]).toHaveLength(2);
      expect(TYPES.filter((a) => BEATS[a].includes(t))).toHaveLength(2);
      expect(RESISTED_BY[t]).toHaveLength(2);
      expect(RESISTED_BY[t]).toContain(t);
      for (const d of BEATS[t]) expect(RESISTED_BY[t]).not.toContain(d);
    }
    expect(Object.keys(IMMUNE)).toHaveLength(1);
  });

  it('preserves the SP1 corner', () => {
    expect(singleMultiplier('packet', 'glitch')).toBe(2);
    expect(singleMultiplier('crypto', 'packet')).toBe(2);
    expect(singleMultiplier('glitch', 'crypto')).toBe(2);
    expect(singleMultiplier('glitch', 'null')).toBe(0);
    expect(singleMultiplier('packet', 'crypto')).toBe(0.5);
    expect(singleMultiplier('null', 'glitch')).toBe(1);
    expect(typeMultiplier('packet', ['glitch', 'crypto'])).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/bestiary.test.ts`
Expected: FAIL — `BEATS` is not exported.

- [ ] **Step 3: Implement**

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

/**
 * Attacker -> the two types it hits for x2. Every type is a strength of exactly two attackers,
 * so no type is left without weaknesses. The SP1 corner (packet/crypto/glitch) is preserved.
 */
export const BEATS: Record<TypeId, readonly [TypeId, TypeId]> = {
  kernel: ['signal', 'thread'],
  packet: ['glitch', 'socket'],
  crypto: ['packet', 'root'],
  cache: ['thread', 'heap'],
  thread: ['socket', 'cloud'],
  signal: ['kernel', 'shell'],
  socket: ['proxy', 'cloud'],
  buffer: ['stack', 'heap'],
  shell: ['root', 'cache'],
  root: ['shell', 'null'],
  null: ['buffer', 'proxy'],
  glitch: ['crypto', 'cache'],
  proxy: ['signal', 'packet'],
  cloud: ['buffer', 'stack'],
  stack: ['null', 'kernel'],
  heap: ['glitch', 'crypto'],
};

/** Attacker -> the two defenders that resist it (x0.5): itself, and the first type that beats it without being one of its own strengths. */
export const RESISTED_BY: Record<TypeId, readonly [TypeId, TypeId]> = {
  kernel: ['kernel', 'stack'],
  packet: ['packet', 'crypto'],
  crypto: ['crypto', 'glitch'],
  cache: ['cache', 'shell'],
  thread: ['thread', 'kernel'],
  signal: ['signal', 'proxy'],
  socket: ['socket', 'packet'],
  buffer: ['buffer', 'null'],
  shell: ['shell', 'signal'],
  root: ['root', 'crypto'],
  null: ['null', 'root'],
  glitch: ['glitch', 'packet'],
  proxy: ['proxy', 'socket'],
  cloud: ['cloud', 'thread'],
  stack: ['stack', 'buffer'],
  heap: ['heap', 'cache'],
};

/** Attacker -> defender it cannot damage at all. */
export const IMMUNE: Partial<Record<TypeId, TypeId>> = {
  glitch: 'null',
};

export function isTypeId(value: string): value is TypeId {
  return (TYPES as readonly string[]).includes(value);
}

export function singleMultiplier(attack: TypeId, defender: TypeId): number {
  if (IMMUNE[attack] === defender) return 0;
  if (BEATS[attack].includes(defender)) return 2;
  if (RESISTED_BY[attack].includes(defender)) return 0.5;
  return 1;
}

/** Multipliers stack across a dual-typed defender. */
export function typeMultiplier(attack: TypeId, defender: readonly TypeId[]): number {
  return defender.reduce((m, d) => m * singleMultiplier(attack, d), 1);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): full 16x16 type chart"
```

---

### Task 3: 64 moves and the shared status enum

**Files:**
- Modify: `packages/rules/src/content/moves.ts`, `packages/shared/src/protocol.ts`
- Test: `packages/rules/test/bestiary.test.ts` (add the `moves` block)

**Interfaces:**
- `type StatusId = 'throttled' | 'stalled' | 'leaking' | 'exposed'`, `STATUS_IDS`, `type MoveSlot`, `TYPE_STATUS`, `TYPE_MOVES: Record<TypeId, [filler, ranged, area, heavy]>`, `MOVES` (64), `getMove`, `moveSlot(id)`.
- Shared: `StatusSchema = z.enum(STATUS_IDS)`.

- [ ] **Step 1: Add the failing tests**

Append to `packages/rules/test/bestiary.test.ts` (import `MOVES, STATUS_IDS, TYPE_MOVES, getMove, moveSlot` from `../src/content/moves.js`):

```ts
describe('moves', () => {
  it('has 64 moves, 4 per type, with one status per type and power-of-2 cooldowns', () => {
    expect(MOVES).toHaveLength(64);
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(64);
    for (const t of TYPES) {
      const own = MOVES.filter((m) => m.type === t);
      expect(own).toHaveLength(4);
      expect(own.filter((m) => m.status)).toHaveLength(1);
      expect(TYPE_MOVES[t].map(moveSlot)).toEqual(['filler', 'ranged', 'area', 'heavy']);
    }
    for (const m of MOVES) {
      expect([256, 512, 1024, 2048, 4096, 8192]).toContain(m.cooldownMs);
      if (m.status) expect(STATUS_IDS).toContain(m.status.id);
    }
    expect(getMove('encrypt').status?.id).toBe('throttled');
    expect(getMove('static').status?.id).toBe('stalled');
    expect(getMove('broadcast').status?.id).toBe('leaking');
    expect(getMove('panic').status?.id).toBe('exposed');
    expect(getMove('bruteforce')).toMatchObject({ power: 100, energyCost: 56, cooldownMs: 8192 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/bestiary.test.ts`
Expected: FAIL — `STATUS_IDS` / `TYPE_MOVES` are not exported.

- [ ] **Step 3: Implement**

`packages/rules/src/content/moves.ts`:

```ts
import { TYPES, type TypeId } from '../types.js';

export type Shape =
  | { kind: 'single' }
  | { kind: 'cone'; length: number; angleDeg: number }
  | { kind: 'circle'; radius: number };

/** throttled: +50% own cooldowns · stalled: cannot move · leaking: -2 energy/s · exposed: +25% damage taken */
export type StatusId = 'throttled' | 'stalled' | 'leaking' | 'exposed';
export const STATUS_IDS: readonly StatusId[] = ['throttled', 'stalled', 'leaking', 'exposed'];

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

export type MoveSlot = 'filler' | 'ranged' | 'area' | 'heavy';

const single = { kind: 'single' } as const;
const circle = { kind: 'circle', radius: 2 } as const;
const cone = { kind: 'cone', length: 4, angleDeg: 60 } as const;

/** Which status each type's area move inflicts (game design SP3a §3.3). */
export const TYPE_STATUS: Record<TypeId, StatusId> = {
  crypto: 'throttled', cache: 'throttled', proxy: 'throttled', cloud: 'throttled',
  glitch: 'stalled', thread: 'stalled', buffer: 'stalled', null: 'stalled',
  heap: 'leaking', packet: 'leaking', socket: 'leaking', stack: 'leaking',
  kernel: 'exposed', signal: 'exposed', shell: 'exposed', root: 'exposed',
};

/** Four move ids per type in slot order filler / ranged / area / heavy. */
export const TYPE_MOVES: Record<TypeId, readonly [string, string, string, string]> = {
  kernel: ['syscall', 'interrupt', 'panic', 'kexec'],
  packet: ['ping', 'traceroute', 'broadcast', 'synflood'],
  crypto: ['hash', 'encrypt', 'keyspray', 'bruteforce'],
  cache: ['hit', 'prefetch', 'flush', 'thrash'],
  thread: ['spin', 'fork', 'deadlock', 'join'],
  signal: ['kill', 'sighup', 'sigstop', 'sigkill'],
  socket: ['bind', 'connect', 'listen', 'handshake'],
  buffer: ['fill', 'overflow', 'wrap', 'smash'],
  shell: ['pipe', 'grep', 'glob', 'exec'],
  root: ['chmod', 'sudo', 'chown', 'rootkit'],
  null: ['nullref', 'voidbolt', 'blackhole', 'dereference'],
  glitch: ['bitflip', 'corrupt', 'static', 'cosmicray'],
  proxy: ['relay', 'tunnel', 'mask', 'onion'],
  cloud: ['burst', 'scale', 'storm', 'failover'],
  stack: ['push', 'pop', 'unwind', 'recurse'],
  heap: ['alloc', 'free', 'leak', 'compact'],
};

const NAMES: Record<string, string> = {
  syscall: 'Syscall', interrupt: 'Interrupt', panic: 'Kernel Panic', kexec: 'Kexec',
  ping: 'Ping', traceroute: 'Traceroute', broadcast: 'Broadcast', synflood: 'SYN Flood',
  hash: 'Hash', encrypt: 'Encrypt', keyspray: 'Key Spray', bruteforce: 'Brute Force',
  hit: 'Cache Hit', prefetch: 'Prefetch', flush: 'Flush', thrash: 'Thrash',
  spin: 'Spin', fork: 'Fork', deadlock: 'Deadlock', join: 'Join',
  kill: 'Kill', sighup: 'SIGHUP', sigstop: 'SIGSTOP', sigkill: 'SIGKILL',
  bind: 'Bind', connect: 'Connect', listen: 'Listen', handshake: 'Handshake',
  fill: 'Fill', overflow: 'Overflow', wrap: 'Wrap', smash: 'Stack Smash',
  pipe: 'Pipe', grep: 'Grep', glob: 'Glob', exec: 'Exec',
  chmod: 'Chmod', sudo: 'Sudo', chown: 'Chown', rootkit: 'Rootkit',
  nullref: 'Null Ref', voidbolt: 'Void Bolt', blackhole: 'Black Hole', dereference: 'Dereference',
  bitflip: 'Bit Flip', corrupt: 'Corrupt', static: 'Static', cosmicray: 'Cosmic Ray',
  relay: 'Relay', tunnel: 'Tunnel', mask: 'Mask', onion: 'Onion Route',
  burst: 'Burst', scale: 'Autoscale', storm: 'Storm', failover: 'Failover',
  push: 'Push', pop: 'Pop', unwind: 'Unwind', recurse: 'Recurse',
  alloc: 'Alloc', free: 'Free', leak: 'Leak', compact: 'Compact',
};

/** SP1's hand-tuned numbers stay as they were; other types follow the same four-slot pattern. */
const SLOT_DEFAULTS: Record<MoveSlot, Omit<MoveDef, 'id' | 'name' | 'type'>> = {
  filler: { category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  ranged: { category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  area: { category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: circle },
  heavy: { category: 'physical', power: 90, energyCost: 48, cooldownMs: 4096, range: 2, shape: single },
};
const SP1_TUNING: Record<string, Partial<MoveDef>> = {
  keyspray: { range: 4, shape: cone },
  bruteforce: { category: 'special', power: 100, energyCost: 56, cooldownMs: 8192, range: 6 },
  bitflip: { power: 22 },
  cosmicray: { power: 95, range: 3 },
  nullref: { cooldownMs: 512 },
  blackhole: { energyCost: 24 },
  dereference: { power: 100, energyCost: 56, cooldownMs: 8192 },
  // cones for a few more types, so not every area move is a circle
  chown: { range: 4, shape: cone },
  unwind: { range: 4, shape: cone },
  storm: { range: 4, shape: cone },
  deadlock: { range: 4, shape: cone },
};
const STATUS_DURATION: Record<StatusId, number> = { throttled: 4096, stalled: 2048, leaking: 4096, exposed: 4096 };

export const MOVES: readonly MoveDef[] = TYPES.flatMap((type) =>
  (['filler', 'ranged', 'area', 'heavy'] as const).map((slot, i) => {
    const id = TYPE_MOVES[type][i]!;
    const status: MoveDef['status'] | undefined =
      slot === 'area' || (type === 'crypto' && id === 'encrypt')
        ? { id: TYPE_STATUS[type], chance: 0.5, durationMs: STATUS_DURATION[TYPE_STATUS[type]] }
        : undefined;
    // SP1's Crypto status lives on `encrypt` (ranged), not on the area move — keep that.
    const move: MoveDef = { id, name: NAMES[id] ?? id, type, ...SLOT_DEFAULTS[slot], ...(status ? { status } : {}), ...SP1_TUNING[id] };
    if (type === 'crypto' && slot === 'area') delete (move as { status?: unknown }).status;
    return move;
  }),
);

const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function getMove(id: string): MoveDef {
  const m = BY_ID.get(id);
  if (!m) throw new RangeError(`unknown move ${id}`);
  return m;
}

export function moveSlot(id: string): MoveSlot {
  const m = getMove(id);
  return (['filler', 'ranged', 'area', 'heavy'] as const)[TYPE_MOVES[m.type].indexOf(id)]!;
}
```

In `packages/shared/src/protocol.ts` change the rules import to `import { STATUS_IDS, TYPES } from '@daemonet/rules';` and the status enum to:

```ts
export const StatusSchema = z.enum(STATUS_IDS as [string, ...string[]]);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (rules: 65 tests; the sim's existing combat tests still pass because the SP1 move numbers are unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): 64 moves, four statuses; shared status enum"
```

---

### Task 4: Generated species, learnsets and `lo` spawn tables

**Files:**
- Modify: `packages/rules/src/content/species.ts`, `packages/rules/src/content/subnets.ts`, `apps/api/test/app.test.ts`
- Test: `packages/rules/test/bestiary.test.ts` (final file)

**Interfaces:**
- `SpeciesDef` gains `role`, `capstone`, `evolvesFrom`, `evolvesAt`; `stage` is the tree depth.
- `STAGE_BUDGETS`, `CAPSTONE_BUDGET`, `ROLE_WEIGHTS`, `STAT_OVERRIDES`, `budgetFor(row)`, `baseStatsFor(row)`, `SPECIES` (256), `getSpecies`, `evolutionsOf(id)`, `movesAtLevel`, `dominantStat(ivs)`.
- `LO.regions[i].species` covers all 50 base forms (starters in the lobby only).

- [ ] **Step 1: Replace the test file with its final form**

`packages/rules/test/bestiary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { EVOLUTION_ITEMS, getItem } from '../src/content/items.js';
import { MOVES, STATUS_IDS, TYPE_MOVES, getMove, moveSlot } from '../src/content/moves.js';
import { SPECIES, budgetFor, dominantStat, evolutionsOf, getSpecies, movesAtLevel } from '../src/content/species.js';
import { LO } from '../src/content/subnets.js';
import { ROLE_TRAITS, TRAITS, getTrait } from '../src/content/traits.js';
import { BEATS, IMMUNE, RESISTED_BY, TYPES, singleMultiplier, typeMultiplier } from '../src/types.js';

describe('bestiary data', () => {
  it('has 50 lines, 256 species, 4 starters and 8 capstones', () => {
    expect(BESTIARY).toHaveLength(256);
    expect(new Set(BESTIARY.map((r) => r.line)).size).toBe(50);
    expect(BESTIARY.filter((r) => r.stage === 0)).toHaveLength(50);
    expect(BESTIARY.filter((r) => r.starter).map((r) => r.id).sort()).toEqual(['glitchmite', 'hashling', 'nullpup', 'pingling']);
    expect(BESTIARY.filter((r) => r.capstone)).toHaveLength(8);
    expect(new Set(BESTIARY.map((r) => r.id)).size).toBe(256);
  });

  it('links every evolution to an existing parent at a power-of-2 level with valid requirements', () => {
    const ids = new Set(BESTIARY.map((r) => r.id));
    for (const r of BESTIARY) {
      expect(r.types.length).toBeGreaterThanOrEqual(1);
      expect(r.types.length).toBeLessThanOrEqual(2);
      if (r.stage === 0) {
        expect(r.evolvesFrom).toBeNull();
        expect(r.types).toHaveLength(1);
      } else {
        expect(ids.has(r.evolvesFrom!)).toBe(true);
        expect([8, 16, 32, 64]).toContain(r.evolvesAt);
        expect(r.capstone).toBe(r.evolvesAt === 64);
      }
      for (const q of r.requirement ?? []) {
        if (q.kind === 'heldItem') expect(getItem(q.item).kind).toBe('evolution');
        if (q.kind === 'moveTypeUses') expect(TYPES).toContain(q.type);
        if (q.kind === 'dominantIV') expect(STAT_KEYS).toContain(q.stat);
      }
      if (r.hidden) expect(r.requirement).not.toBeNull();
    }
  });
});

describe('generated species', () => {
  it('sum exactly to their budget, within 1-256 per stat', () => {
    for (const s of SPECIES) {
      const total = STAT_KEYS.reduce((a, k) => a + s.base[k], 0);
      expect(total, s.id).toBe(budgetFor(BESTIARY.find((r) => r.id === s.id)!));
      for (const k of STAT_KEYS) {
        expect(s.base[k]).toBeGreaterThanOrEqual(1);
        expect(s.base[k]).toBeLessThanOrEqual(256);
      }
    }
    expect(budgetFor(BESTIARY.find((r) => r.id === 'pingling')!)).toBe(285);
    expect(budgetFor(BESTIARY.find((r) => r.id === 'hopmaster')!)).toBe(513);
    expect(budgetFor(BESTIARY.find((r) => r.id === 'pidzero')!)).toBe(600);
  });

  it('keeps the SP1 hand-authored stats and follows role identities', () => {
    expect(getSpecies('pingling').base).toEqual({ hp: 34, attack: 36, defense: 28, focus: 34, resolve: 28, speed: 50, haste: 42, energy: 33 });
    const wall = getSpecies('sysvern').base;
    expect(wall.resolve).toBeGreaterThan(wall.attack);
    const sweeper = getSpecies('hopmaster').base;
    expect(sweeper.speed).toBeGreaterThan(sweeper.defense);
    expect(getSpecies('dataracer').base).not.toEqual(getSpecies('hazardash').base);
    expect(evolutionsOf('forkling')).toHaveLength(4);
    expect(evolutionsOf('pidzero')).toHaveLength(0);
  });

  it('learns its primary type moves and the secondary type area move', () => {
    const multicastor = getSpecies('multicastor'); // packet/buffer
    expect(multicastor.learnset.map((e) => e.move)).toEqual(['ping', 'traceroute', 'wrap', 'synflood']);
    expect(movesAtLevel(getSpecies('pingling'), 20)).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    for (const s of SPECIES) {
      for (const e of s.learnset) expect(() => getMove(e.move)).not.toThrow();
      for (const t of s.traits) expect(() => getTrait(t)).not.toThrow();
      expect(s.baseYield).toBe(32 + 8 * s.stage);
    }
  });

  it('dominantStat returns the strict maximum or null on ties', () => {
    expect(dominantStat({ hp: 1, attack: 9, defense: 2, focus: 3, resolve: 4, speed: 5, haste: 6, energy: 7 })).toBe('attack');
    expect(dominantStat({ hp: 9, attack: 9, defense: 2, focus: 3, resolve: 4, speed: 5, haste: 6, energy: 7 })).toBeNull();
  });
});

describe('moves', () => {
  it('has 64 moves, 4 per type, with one status per type and power-of-2 cooldowns', () => {
    expect(MOVES).toHaveLength(64);
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(64);
    for (const t of TYPES) {
      const own = MOVES.filter((m) => m.type === t);
      expect(own).toHaveLength(4);
      expect(own.filter((m) => m.status)).toHaveLength(1);
      expect(TYPE_MOVES[t].map(moveSlot)).toEqual(['filler', 'ranged', 'area', 'heavy']);
    }
    for (const m of MOVES) {
      expect([256, 512, 1024, 2048, 4096, 8192]).toContain(m.cooldownMs);
      if (m.status) expect(STATUS_IDS).toContain(m.status.id);
    }
    expect(getMove('encrypt').status?.id).toBe('throttled');
    expect(getMove('static').status?.id).toBe('stalled');
    expect(getMove('broadcast').status?.id).toBe('leaking');
    expect(getMove('panic').status?.id).toBe('exposed');
    expect(getMove('bruteforce')).toMatchObject({ power: 100, energyCost: 56, cooldownMs: 8192 });
  });
});

describe('type chart', () => {
  it('gives every type exactly two strengths, is a strength of exactly two attackers, and two resisters', () => {
    for (const t of TYPES) {
      expect(BEATS[t]).toHaveLength(2);
      expect(TYPES.filter((a) => BEATS[a].includes(t))).toHaveLength(2);
      expect(RESISTED_BY[t]).toHaveLength(2);
      expect(RESISTED_BY[t]).toContain(t);
      for (const d of BEATS[t]) expect(RESISTED_BY[t]).not.toContain(d);
    }
    expect(Object.keys(IMMUNE)).toHaveLength(1);
  });

  it('preserves the SP1 corner', () => {
    expect(singleMultiplier('packet', 'glitch')).toBe(2);
    expect(singleMultiplier('crypto', 'packet')).toBe(2);
    expect(singleMultiplier('glitch', 'crypto')).toBe(2);
    expect(singleMultiplier('glitch', 'null')).toBe(0);
    expect(singleMultiplier('packet', 'crypto')).toBe(0.5);
    expect(singleMultiplier('null', 'glitch')).toBe(1);
    expect(typeMultiplier('packet', ['glitch', 'crypto'])).toBe(1);
  });
});

describe('traits and items', () => {
  it('has 16 traits assigned in pairs per role, 4 held items and 16 evolution items', () => {
    expect(TRAITS).toHaveLength(16);
    for (const pair of Object.values(ROLE_TRAITS)) for (const id of pair) expect(() => getTrait(id)).not.toThrow();
    expect(EVOLUTION_ITEMS).toHaveLength(16);
    expect(new Set(EVOLUTION_ITEMS.map((i) => i.type)).size).toBe(16);
    expect(getItem('heatsink')).toMatchObject({ kind: 'held', effect: 'cooldown', multiplier: 0.875 });
  });
});

describe('lo spawns every base form', () => {
  it('covers all 50 bases across the four regions, starters in the lobby only', () => {
    const covered = new Set(LO.regions.flatMap((r) => Object.keys(r.species)));
    expect(covered.size).toBe(50);
    expect(Object.keys(LO.regions[0]!.species)).toEqual(expect.arrayContaining(['pingling', 'hashling', 'glitchmite', 'nullpup']));
    expect(LO.regions[3]!.species).not.toHaveProperty('pingling');
  });
});
```

In `apps/api/test/app.test.ts` change `expect(codex.species).toHaveLength(8);` to `expect(codex.species).toHaveLength(256);`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/bestiary.test.ts`
Expected: FAIL — `budgetFor` / `evolutionsOf` are not exported.

- [ ] **Step 3: Implement**

`packages/rules/src/content/species.ts`:

```ts
import { MAX_MOVES, STAT_KEYS, statBlock, type StatBlock, type StatKey } from '../constants.js';
import { createRng } from '../rng.js';
import type { TypeId } from '../types.js';
import { BESTIARY, type BestiaryRow, type Role } from './bestiary.js';
import { TYPE_MOVES } from './moves.js';
import { ROLE_TRAITS } from './traits.js';

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
  /** 0 = base form, 1-3 = evolutions, 4 = capstone (depth in the tree). */
  stage: number;
  types: readonly TypeId[];
  role: Role;
  base: StatBlock;
  traits: readonly [string, string];
  behaviour: Behaviour;
  baseYield: number;
  learnset: readonly LearnsetEntry[];
  starter: boolean;
  capstone: boolean;
  evolvesFrom: string | null;
  evolvesAt: number | null;
}

/** Base-stat totals by tree depth; capstones are 600; starter lines run 5% under at every stage. */
export const STAGE_BUDGETS = [300, 420, 500, 540] as const;
export const CAPSTONE_BUDGET = 600;

export const ROLE_WEIGHTS: Record<Role, readonly number[]> = {
  balanced: [1, 1, 1, 1, 1, 1, 1, 1],
  sweeper: [0.8, 1.4, 0.7, 0.8, 0.7, 1.5, 1.2, 0.9],
  nuker: [0.8, 0.7, 0.7, 1.5, 0.9, 1, 1.1, 1.3],
  tank: [1.5, 0.9, 1.4, 0.6, 1.2, 0.6, 0.7, 1.1],
  wall: [1.2, 0.6, 1, 0.8, 1.6, 0.6, 0.8, 1.4],
  striker: [0.9, 1.4, 0.8, 0.7, 0.7, 1, 1.4, 1.1],
  spammer: [0.9, 0.9, 0.8, 0.9, 0.8, 1, 1.6, 1.1],
  support: [1.1, 0.7, 1, 1.1, 1.2, 1, 1, 0.9],
  scout: [0.8, 0.9, 0.7, 0.8, 0.7, 1.7, 1.3, 1.1],
  bruiser: [1.3, 1.4, 1.1, 0.6, 0.8, 0.8, 0.9, 1.1],
  battery: [1, 0.7, 1, 0.9, 1, 0.8, 1, 1.6],
};

const ROLE_BEHAVIOUR: Record<Role, Behaviour> = {
  balanced: 'wanderer', sweeper: 'timid', nuker: 'wanderer', tank: 'territorial', wall: 'territorial', striker: 'territorial',
  spammer: 'timid', support: 'wanderer', scout: 'timid', bruiser: 'territorial', battery: 'wanderer',
};

const STARTER_LINES = new Set(BESTIARY.filter((r) => r.starter).map((r) => r.line));

export function budgetFor(row: BestiaryRow): number {
  const base = row.capstone ? CAPSTONE_BUDGET : STAGE_BUDGETS[Math.min(row.stage, 3)]!;
  return Math.round(STARTER_LINES.has(row.line) ? base * 0.95 : base);
}

/**
 * Hand tuning. A partial block replaces those stats and the largest remaining stat absorbs the
 * difference so the budget still holds; `total` overrides the budget itself.
 */
export const STAT_OVERRIDES: Readonly<Record<string, Partial<StatBlock> & { total?: number }>> = {
  // SP1's eight hand-authored base forms keep their exact stats.
  pingling: { hp: 34, attack: 36, defense: 28, focus: 34, resolve: 28, speed: 50, haste: 42, energy: 33 },
  floodhound: { hp: 36, attack: 48, defense: 30, focus: 30, resolve: 28, speed: 42, haste: 50, energy: 36 },
  hashling: { hp: 36, attack: 34, defense: 36, focus: 38, resolve: 38, speed: 34, haste: 34, energy: 35 },
  cipherbat: { hp: 32, attack: 26, defense: 30, focus: 52, resolve: 40, speed: 42, haste: 40, energy: 38 },
  glitchmite: { hp: 32, attack: 46, defense: 28, focus: 34, resolve: 26, speed: 40, haste: 46, energy: 33 },
  bitrot: { hp: 40, attack: 30, defense: 36, focus: 38, resolve: 40, speed: 30, haste: 40, energy: 46 },
  nullpup: { hp: 40, attack: 36, defense: 36, focus: 32, resolve: 36, speed: 34, haste: 34, energy: 37 },
  voidlet: { hp: 42, attack: 26, defense: 44, focus: 30, resolve: 54, speed: 28, haste: 32, energy: 44 },
};

/** Deterministic stats: role weights with ±6% per-stat jitter seeded by the id, summing exactly to the budget. */
export function baseStatsFor(row: BestiaryRow): StatBlock {
  const override = STAT_OVERRIDES[row.id];
  const total = override?.total ?? budgetFor(row);
  const rng = createRng(`stats:${row.id}`);
  const weights = ROLE_WEIGHTS[row.role].map((w) => w * (0.94 + rng.float() * 0.12));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = statBlock(0);
  STAT_KEYS.forEach((k, i) => (out[k] = Math.min(256, Math.max(1, Math.round((total * weights[i]!) / sum)))));
  if (override) for (const k of STAT_KEYS) if (override[k] !== undefined) out[k] = override[k]!;
  // fix rounding (and override) drift on the largest non-overridden stat
  const free = STAT_KEYS.filter((k) => override?.[k] === undefined);
  const drift = total - STAT_KEYS.reduce((a, k) => a + out[k], 0);
  if (drift !== 0 && free.length > 0) {
    const target = free.reduce((best, k) => (out[k] > out[best] ? k : best), free[0]!);
    out[target] = Math.min(256, Math.max(1, out[target] + drift));
  }
  return out;
}

function learnsetFor(row: BestiaryRow): LearnsetEntry[] {
  const primary = TYPE_MOVES[row.types[0]!];
  const area = TYPE_MOVES[row.types[1] ?? row.types[0]!][2];
  return [
    { level: 1, move: primary[0] },
    { level: 1, move: primary[1] },
    { level: 8, move: area },
    { level: 16, move: primary[3] },
  ];
}

export const SPECIES: readonly SpeciesDef[] = BESTIARY.map((row) => ({
  id: row.id,
  name: row.name,
  line: row.line,
  stage: row.stage,
  types: row.types,
  role: row.role,
  base: baseStatsFor(row),
  traits: ROLE_TRAITS[row.role],
  behaviour: ROLE_BEHAVIOUR[row.role],
  baseYield: 32 + 8 * row.stage,
  learnset: learnsetFor(row),
  starter: row.starter,
  capstone: row.capstone,
  evolvesFrom: row.evolvesFrom,
  evolvesAt: row.evolvesAt,
}));

const BY_ID = new Map(SPECIES.map((sp) => [sp.id, sp]));

export function getSpecies(id: string): SpeciesDef {
  const sp = BY_ID.get(id);
  if (!sp) throw new RangeError(`unknown species ${id}`);
  return sp;
}

/** Forms this species can evolve into (in bestiary order). */
export function evolutionsOf(id: string): SpeciesDef[] {
  return SPECIES.filter((s) => s.evolvesFrom === id);
}

/** The (up to) 4 most recently learned moves at `level`, in learn order. */
export function movesAtLevel(species: SpeciesDef, level: number): string[] {
  const known = species.learnset.filter((e) => e.level <= level).map((e) => e.move);
  return known.slice(-MAX_MOVES);
}

export function dominantStat(ivs: StatBlock): StatKey | null {
  let best: StatKey | null = null;
  let tie = false;
  for (const k of STAT_KEYS) {
    if (best === null || ivs[k] > ivs[best]) {
      best = k;
      tie = false;
    } else if (ivs[k] === ivs[best]) tie = true;
  }
  return tie ? null : best;
}
```

`packages/rules/src/content/subnets.ts`:

```ts
import { BESTIARY } from './bestiary.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionDef {
  name: string;
  rect: Rect;
  /** Inclusive level range for spawns. */
  levels: readonly [number, number];
  /** species id -> relative spawn weight. */
  species: Readonly<Record<string, number>>;
  /** Max wild daemons alive in this region. */
  cap: number;
  /** One respawn per interval while below cap. */
  respawnMs: number;
}

export interface SubnetDef {
  id: string;
  width: number;
  height: number;
  /** Blocked rectangles (tile units). The outer border is always blocked. */
  walls: readonly Rect[];
  /** Host node: restore point, store/load point. */
  host: { x: number; y: number };
  /** Where new operators appear. */
  spawn: { x: number; y: number };
  regions: readonly RegionDef[];
}

/**
 * `lo` spawns every base form (SP3a): the 50 bases are split into four level bands by bestiary
 * line order within each type so each band has 12-13 species; starters are always in the lobby.
 */
function loWeights(band: number): Record<string, number> {
  const bases = BESTIARY.filter((r) => r.stage === 0);
  const out: Record<string, number> = {};
  bases.forEach((r, i) => {
    if (r.starter) {
      if (band === 0) out[r.id] = 3;
      return;
    }
    if (i % 4 === band) out[r.id] = 2;
  });
  return out;
}

/** 128 x 128, one host, four spawn regions of rising level. */
export const LO: SubnetDef = {
  id: 'lo',
  width: 128,
  height: 128,
  walls: [
    { x: 1, y: 56, w: 51, h: 2 },
    { x: 76, y: 56, w: 51, h: 2 },
    { x: 64, y: 1, w: 2, h: 28 },
    { x: 64, y: 44, w: 2, h: 41 },
    { x: 64, y: 100, w: 2, h: 27 },
  ],
  host: { x: 16.5, y: 16.5 },
  spawn: { x: 18.5, y: 16.5 },
  regions: [
    { name: 'lobby', rect: { x: 24, y: 8, w: 32, h: 36 }, levels: [2, 6], species: loWeights(0), cap: 16, respawnMs: 4096 },
    { name: 'uplink', rect: { x: 72, y: 8, w: 48, h: 40 }, levels: [5, 10], species: loWeights(1), cap: 16, respawnMs: 4096 },
    { name: 'cache', rect: { x: 8, y: 64, w: 48, h: 56 }, levels: [9, 16], species: loWeights(2), cap: 16, respawnMs: 4096 },
    { name: 'core', rect: { x: 72, y: 64, w: 48, h: 56 }, levels: [14, 24], species: loWeights(3), cap: 16, respawnMs: 4096 },
  ],
};

export const SUBNETS: readonly SubnetDef[] = [LO];

export function getSubnet(id: string): SubnetDef {
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}
```

- [ ] **Step 4: Run to verify pass, then push**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 24 files, 181 tests. The sim integration tests still capture a Nullpup (its stats are pinned by `STAT_OVERRIDES`).

```bash
git add -A
git commit -m "feat(rules): generated species stats, learnsets and lo spawn tables for all 50 lines"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: CI green. In production the next deploy makes all 50 base forms spawn in `lo`; existing operators' daemons are unaffected (their species ids and stats are unchanged).

**Tuning later:** edit `STAT_OVERRIDES` (a partial block per species; the largest free stat absorbs the difference so the budget holds, or set `total`) and re-run `pnpm test`.
