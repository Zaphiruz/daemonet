# Daemonet SP3b · Plan 2 — Bits, shop, Disk expansion, decompile and crafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bits become real: a ledger records every change, the NPC shop and Disk expansion spend them, decompiling a daemon at a host yields typed fragments, and crafting turns fragments + bits into tools, restores, evolution items, held items and Bit Flippers — with the protocol, SDK, API (shop / recipes / ledger / admin economy view) and a **Host** panel in the client.

**Architecture:** Prices, recipes and yields are content in `packages/rules/src/content/economy.ts`. Every bits-changing action is a durable intent (`buy`, `craft`, `decompile`) applied by the store in one transaction that also writes a `BitsLedger` row; **checkpoints stop writing bits** so a balance can never be rewound past a committed purchase. The sim applies bits and inventory optimistically when it accepts the command (so a checkpoint in flight already matches the ledger) and reverts them if the store refuses. Decompile moves the `Daemon` row into `DaemonArchive` (capture log kept) and deletes it. `Store.grantBits` is the one door for bits created outside the sim (dev seeding now, ticket payouts and admin grants next).

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP3b plan 1 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3b-economy-subnets-design.md` §3, §5, §6, §9. Decisions fixed here: a held item comes back to the inventory when its daemon is decompiled; bits granted outside the sim (dev / admin) are seen by the sim on the operator's next connection.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Bits change only through intents and `grantBits`; every change has a `BitsLedger` row; `checkpoint` never writes `bits`.
- Prices, recipes and the Disk schedule live in `rules`; nothing in the sim or client hard-codes a number.

## File map

```
packages/rules/src/content/economy.ts       SHOP, DISK_*, diskExpansionPrice, fragmentId, decompileYield, RECIPES, recipeFragments
packages/rules/src/content/items.ts         FragmentDef (16 fragments in ITEMS)
packages/db/prisma/schema.prisma            Operator.diskCapacity, BitsLedger, DaemonArchive (+ migration)
packages/shared/src/protocol.ts             buy / craft / decompile commands, bits / decompiled events, OperatorSelf.diskCapacity
packages/sdk/src/client.ts                  operator.buy / craft / decompile
apps/sim/src/core/systems/economy.ts        buy, craft, decompile, completeEconomyIntent
apps/sim/src/core/{model,world,view}.ts     diskCapacity, intents, completion
apps/sim/src/core/systems/{commands,capture}.ts   host commands, Disk capacity from the operator
apps/sim/src/runtime/{store,prisma-store}.ts      intents, ledger, archive, grantBits, ledgerFor, no bits in checkpoints
apps/api/src/routes/economy.ts              /api/shop, /api/recipes, /api/ledger, /api/admin/economy
apps/api/src/auth/dev-bypass.ts             POST /api/dev/bits; Disk capacity from the row
apps/frontend/src/game/economy.ts           craftCheck, fragmentTypes, formatBits
apps/frontend/src/panels/HostPanel.tsx      shop · craft · ledger
apps/frontend/src/panels/RamPanel.tsx       decompile button
tests: rules economy, sim economy + store contract, api, frontend host.test.tsx, e2e
```

---

### Task 1: Economy content

**Files:**
- Create: `packages/rules/src/content/economy.ts`, `packages/rules/test/economy.test.ts`
- Modify: `packages/rules/src/content/items.ts`, `packages/rules/src/index.ts`

**Interfaces:**
- `SHOP: Record<itemId, bits>`, `BUY_MAX_QTY = 64`, `CRAFT_MAX_QTY = 16`, `DISK_BASE = 256`, `DISK_STEP = 32`, `DISK_MAX = 512`, `DISK_EXPANSION_ITEM = 'diskExpansion'`, `diskExpansionPrice(capacity): number | null`.
- `fragmentId(type)`, `FRAGMENT_IDS`, `isFragmentId(id)`, `decompileYield(stage, level)`.
- `RecipeDef { id; output: { item; qty }; bits; fragments: Partial<Record<TypeId | 'any', number>> }`, `RECIPES` (25), `getRecipe(id)`, `recipeFragments(recipe, qty, using?)` → `Record<fragId, count>` (throws RangeError without a type for an `any` slot).
- `ITEMS` gains 16 `FragmentDef { id: 'frag:<type>', kind: 'fragment', name, type }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DISK_MAX, RECIPES, SHOP, decompileYield, diskExpansionPrice, fragmentId, getRecipe, isFragmentId, recipeFragments, recipeOutputItem } from '../src/content/economy.js';
import { ITEMS, getItem } from '../src/content/items.js';
import { TYPES } from '../src/types.js';

describe('economy content', () => {
  it('shop prices are powers of two for real items', () => {
    for (const [id, price] of Object.entries(SHOP)) {
      expect(() => getItem(id)).not.toThrow();
      expect(Math.log2(price) % 1).toBe(0);
    }
    expect(SHOP.sniff).toBe(32);
    expect(SHOP.dump).toBe(2048);
  });

  it('disk expansion doubles from 8192 and stops at 512 slots', () => {
    expect(diskExpansionPrice(256)).toBe(8192);
    expect(diskExpansionPrice(288)).toBe(16384);
    expect(diskExpansionPrice(480)).toBe(8192 * 2 ** 7);
    expect(diskExpansionPrice(DISK_MAX)).toBeNull();
  });

  it('there is one fragment item per type', () => {
    const frags = ITEMS.filter((i) => i.kind === 'fragment');
    expect(frags).toHaveLength(16);
    expect(frags.map((f) => f.id)).toEqual(TYPES.map(fragmentId));
    expect(isFragmentId('frag:packet')).toBe(true);
    expect(isFragmentId('frag:nope')).toBe(false);
    expect(isFragmentId('sniff')).toBe(false);
  });

  it('decompile yields floor(2^stage · (1 + level/16))', () => {
    expect(decompileYield(0, 5)).toBe(1);
    expect(decompileYield(1, 16)).toBe(4);
    expect(decompileYield(2, 32)).toBe(12);
    expect(decompileYield(3, 64)).toBe(40);
  });

  it('recipes produce real items from real fragment types', () => {
    expect(RECIPES.length).toBe(4 + 16 + 4 + 1);
    for (const r of RECIPES) {
      expect(recipeOutputItem(r).id).toBe(r.output.item);
      for (const key of Object.keys(r.fragments)) expect(key === 'any' || (TYPES as readonly string[]).includes(key)).toBe(true);
      expect(r.bits).toBeGreaterThan(0);
    }
    expect(getRecipe('jumboframe').fragments).toEqual({ packet: 16 });
    expect(() => getRecipe('nope')).toThrow(RangeError);
  });

  it('recipeFragments scales by quantity and resolves "any"', () => {
    expect(recipeFragments(getRecipe('tap'), 2)).toEqual({ 'frag:packet': 8, 'frag:socket': 8 });
    expect(recipeFragments(getRecipe('restore'), 3, 'glitch')).toEqual({ 'frag:glitch': 6 });
    expect(() => recipeFragments(getRecipe('restore'), 1)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Content**

Create `packages/rules/src/content/economy.ts`:

```ts
import { TYPES, type TypeId } from '../types.js';
import { EVOLUTION_ITEMS, getItem } from './items.js';

/** NPC shop prices in bits (SP3b spec §5). Higher tools cost exponentially more. */
export const SHOP: Readonly<Record<string, number>> = {
  sniff: 32,
  tap: 128,
  mirror: 512,
  dump: 2048,
  restore: 64,
  bitflipper: 4096,
};

export const BUY_MAX_QTY = 64;
export const CRAFT_MAX_QTY = 16;

/** Disk expansion: +32 slots per purchase from 256 up to 512; the price doubles each time. */
export const DISK_BASE = 256;
export const DISK_STEP = 32;
export const DISK_MAX = 512;
export const DISK_EXPANSION_ITEM = 'diskExpansion';
const DISK_EXPANSION_BASE_PRICE = 8192;

export function diskExpansionPrice(capacity: number): number | null {
  if (capacity >= DISK_MAX) return null;
  const purchases = Math.max(0, Math.round((capacity - DISK_BASE) / DISK_STEP));
  return DISK_EXPANSION_BASE_PRICE * 2 ** purchases;
}

export const fragmentId = (type: TypeId): string => `frag:${type}`;
export const FRAGMENT_IDS: readonly string[] = TYPES.map(fragmentId);

export function isFragmentId(id: string): boolean {
  return id.startsWith('frag:') && (TYPES as readonly string[]).includes(id.slice(5));
}

/** Fragments of each of the daemon's types when it is decompiled (design §7.3). */
export function decompileYield(stage: number, level: number): number {
  return Math.floor(2 ** stage * (1 + level / 16));
}

export interface RecipeDef {
  id: string;
  output: { item: string; qty: number };
  bits: number;
  /** Fragments per craft; `any` = the caller picks one type (`using`). */
  fragments: Readonly<Partial<Record<TypeId | 'any', number>>>;
}

const recipe = (id: string, item: string, bits: number, fragments: RecipeDef['fragments'], qty = 1): RecipeDef => ({ id, output: { item, qty }, bits, fragments });

export const RECIPES: readonly RecipeDef[] = [
  recipe('tap', 'tap', 64, { packet: 4, socket: 4 }),
  recipe('mirror', 'mirror', 256, { packet: 8, proxy: 8 }),
  recipe('dump', 'dump', 1024, { buffer: 16, heap: 16 }),
  recipe('restore', 'restore', 16, { any: 2 }),
  ...EVOLUTION_ITEMS.map((e) => recipe(e.id, e.id, 512, { [e.type]: 16 })),
  recipe('amplifier', 'amplifier', 1024, { root: 12, thread: 12 }),
  recipe('heatsink', 'heatsink', 1024, { cache: 12, kernel: 12 }),
  recipe('battery', 'battery', 1024, { stack: 12, signal: 12 }),
  recipe('firewall', 'firewall', 1024, { shell: 12, crypto: 12 }),
  recipe('bitflipper', 'bitflipper', 2048, { glitch: 8, null: 8, crypto: 8, kernel: 8 }),
];

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): RecipeDef {
  const r = BY_ID.get(id);
  if (!r) throw new RangeError(`unknown recipe ${id}`);
  return r;
}

/**
 * Fragment items a craft consumes: `frag:<type> → count · qty`, with `any` resolved to `using`.
 * Throws RangeError when the recipe needs a choice and none (or an unknown type) was given.
 */
export function recipeFragments(r: RecipeDef, qty: number, using?: TypeId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(r.fragments) as Array<[TypeId | 'any', number]>) {
    const type = key === 'any' ? using : key;
    if (!type || !(TYPES as readonly string[]).includes(type)) throw new RangeError('this recipe needs a fragment type (using)');
    out[fragmentId(type)] = (out[fragmentId(type)] ?? 0) + n * qty;
  }
  return out;
}

/** Sanity used by tests and the API: every recipe output is a real item. */
export function recipeOutputItem(r: RecipeDef) {
  return getItem(r.output.item);
}
```

In `packages/rules/src/content/items.ts`: import `TYPES` (`import { TYPES, type TypeId } from '../types.js';`), add the fragment definition and union member

```ts
/** Decompile output; 16 fungible materials, one per type (`frag:<type>`). */
export interface FragmentDef {
  id: string;
  kind: 'fragment';
  name: string;
  type: TypeId;
}

export type ItemDef = ToolDef | RestoreDef | HeldDef | EvolutionItemDef | BitFlipperDef | FragmentDef;
```

and append to `ITEMS` after `...EVOLUTION_ITEMS,`:

```ts
  ...TYPES.map((type): FragmentDef => ({ id: `frag:${type}`, kind: 'fragment', name: `${type} fragment`, type })),
```

Add `export * from './content/economy.js';` to `packages/rules/src/index.ts` after the subnets export.

- [ ] **Step 3: Verify and commit**

Run: `pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules` — expected: green.

```bash
git add packages/rules
git commit -m "feat(rules): shop prices, Disk expansion schedule, fragments, decompile yield and recipes"
```

---

### Task 2: Ledger, intents and stores

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000003_sp3b_economy/migration.sql`
- Modify: `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/core/systems/capture.ts`
- Create: `apps/sim/src/core/systems/economy.ts`
- Modify: `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`
- Tests: create `apps/sim/test/economy.test.ts`; modify `apps/sim/test/helpers.ts`, `apps/sim/test/store.test.ts`, `packages/sandbox/test/sandbox.test.ts`

**Interfaces:**
- Protocol: `buy { itemId, qty = 1 (≤ 64) }`, `craft { recipeId, qty = 1 (≤ 16), using? }`, `decompile { daemonId, confirm = false }`; events `bits { delta, reason, balance }` and `decompiled { daemon, species, fragments }` (private); `OperatorSelf.diskCapacity`.
- Model: `OperatorRecord.diskCapacity`, `Operator.diskCapacity`, `HistoryEntry.kind` gains `'decompiled'`; intents `buy { itemId, qty, price }`, `craft { recipeId, qty, bits, fragments, output }`, `decompile { daemonId, species, fragments, history }`.
- Sim (`systems/economy.ts`): `buy(world, op, args, input, out)`, `craft(...)`, `decompile(world, op, daemon, confirm, input, out)`, `completeEconomyIntent(world, op, intent, result, out)`. Commands require the host (`requireAtHost`). Every `DISK_SLOTS` check reads `op.diskCapacity`.
- Store: `applyIntent` for the three kinds (domain failures: `not enough bits`, `not enough <frag>`, `daemon not found`), `grantBits(operatorId, delta, reason, ref?)`, `ledgerFor(operatorId, limit = 64): LedgerRow[]` (`LedgerRow { operatorId; delta; reason; ref; at }`); checkpoints no longer write `bits`.

- [ ] **Step 1: Schema and migration**

In `packages/db/prisma/schema.prisma` add to `model Operator` after `bits`:

```prisma
  /// Disk slots owned (256 + 32 per expansion, max 512)
  diskCapacity   Int      @default(256)
```

and before `model Discovery`:

```prisma
/// Every bits change (SP3b spec §5): the balance on Operator is the sum of an operator's deltas.
model BitsLedger {
  id         String   @id @default(uuid())
  operatorId String
  delta      BigInt
  /// ticket | shop | disk | craft | admin
  reason     String
  ref        String?
  at         DateTime @default(now())

  @@index([operatorId, at])
  @@index([at])
}

/// Decompiled daemons keep their capture log here (never loadable again).
model DaemonArchive {
  id                 String   @id
  operatorId         String
  species            String
  level              Int
  xp                 Int
  nature             Int
  traitSlot          Int
  ivs                Int[]
  bonus              Int[]
  clean              Boolean
  signature          Int
  moves              String[]
  heldItem           String?
  patched            Boolean
  moveTypeUses       Int[]
  crashes            Int
  arenaWins          Int
  history            Json
  originalOperatorId String
  capturedAt         DateTime
  captureSubnet      String
  captureTool        String
  spawnSeedId        String
  spawnIndex         Int?
  archivedAt         DateTime @default(now())
  /// decompiled
  reason             String

  @@index([operatorId])
}
```

Create `packages/db/prisma/migrations/20260930000003_sp3b_economy/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "diskCapacity" INTEGER NOT NULL DEFAULT 256;

-- CreateTable
CREATE TABLE "BitsLedger" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "ref" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BitsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaemonArchive" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "xp" INTEGER NOT NULL,
    "nature" INTEGER NOT NULL,
    "traitSlot" INTEGER NOT NULL,
    "ivs" INTEGER[],
    "bonus" INTEGER[],
    "clean" BOOLEAN NOT NULL,
    "signature" INTEGER NOT NULL,
    "moves" TEXT[],
    "heldItem" TEXT,
    "patched" BOOLEAN NOT NULL,
    "moveTypeUses" INTEGER[],
    "crashes" INTEGER NOT NULL,
    "arenaWins" INTEGER NOT NULL,
    "history" JSONB NOT NULL,
    "originalOperatorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "captureSubnet" TEXT NOT NULL,
    "captureTool" TEXT NOT NULL,
    "spawnSeedId" TEXT NOT NULL,
    "spawnIndex" INTEGER,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "DaemonArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BitsLedger_operatorId_at_idx" ON "BitsLedger"("operatorId", "at");

-- CreateIndex
CREATE INDEX "BitsLedger_at_idx" ON "BitsLedger"("at");

-- CreateIndex
CREATE INDEX "DaemonArchive_operatorId_idx" ON "DaemonArchive"("operatorId");
```

Run: `pnpm --filter @daemonet/db exec prisma migrate deploy && pnpm --filter @daemonet/db exec prisma generate`.

- [ ] **Step 2: Protocol and SDK**

In `packages/shared/src/protocol.ts` add after the `travel` command:

```ts
  z.object({ cmd: z.literal('buy'), actor: Self, args: z.object({ itemId: Id, qty: z.number().int().min(1).max(64).default(1) }) }),
  z.object({ cmd: z.literal('craft'), actor: Self, args: z.object({ recipeId: Id, qty: z.number().int().min(1).max(16).default(1), using: TypeIdSchema.optional() }) }),
  z.object({ cmd: z.literal('decompile'), actor: Self, args: z.object({ daemonId: Id, confirm: z.boolean().default(false) }) }),
```

after the `travelled` event:

```ts
  z.object({ e: z.literal('bits'), delta: z.number().int(), reason: z.string(), balance: z.number().int() }),
  z.object({ e: z.literal('decompiled'), daemon: Id, species: z.string(), fragments: z.record(z.string(), z.number().int()) }),
```

and `diskCapacity: z.number().int(),` to `OperatorSelf` right after `bits`.

In `packages/sdk/src/client.ts` import `type TypeId` from `@daemonet/rules` and add to `OperatorApi` before `travel`:

```ts
  /** NPC shop at a host: `itemId` from SHOP or 'diskExpansion'. */
  buy(itemId: string, qty = 1) {
    return this.client.command({ cmd: 'buy', actor: 'self', args: { itemId, qty } });
  }
  /** Craft at a host; `using` picks the fragment type for recipes with an `any` slot. */
  craft(recipeId: string, qty = 1, using?: TypeId) {
    return this.client.command({ cmd: 'craft', actor: 'self', args: using ? { recipeId, qty, using } : { recipeId, qty } });
  }
  /** Destroy a RAM daemon at a host for fragments; clean / signature daemons need `confirm`. */
  decompile(daemonId: string, confirm = false) {
    return this.client.command({ cmd: 'decompile', actor: 'self', args: { daemonId, confirm } });
  }
```

The sandbox bridge test's `OperatorSelf` fixture (`packages/sandbox/test/sandbox.test.ts`) gains `diskCapacity: 256,` after `bits: 0,`; the sim test helper `operatorRecord` gains `diskCapacity: 256,` after `bits: 0,`.

- [ ] **Step 3: Write the failing sim tests**

Create `apps/sim/test/economy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Intent } from '../src/core/index.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const HOST = TEST_SUBNET.host;

function setup(over: Partial<ReturnType<typeof operatorRecord>> = {}) {
  const world = makeWorld('econ');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y, bits: 1000, inventory: { restore: 1 }, ...over }));
  return world;
}

/** Runs one command through a MemoryStore seeded with the world's operator, completing the intent. */
async function through(world: ReturnType<typeof setup>, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null, result: null };
  const intent = r.intents[0]!;
  const result = await store.applyIntent(intent, { seedId: 'seed0001' });
  world.completeIntent(intent.id, result);
  const after = step(world);
  return { reply: after.replies[0]!, intent, result, events: after.events.map((e) => e.event) };
}

async function seeded(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  const cp = world.checkpoint('alice');
  store.operators.set('alice', { ...mem, id: 'alice', bits: cp.bits, inventory: { ...cp.inventory }, diskCapacity: cp.diskCapacity });
  for (const d of cp.ram) store.daemons.set(d.id, { ...d, operatorId: 'alice', location: 'RAM' });
  return store;
}

describe('shop', () => {
  it('sells at the host, applies bits and items optimistically, and commits through the ledger', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const { reply, intent, events } = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'tap', qty: 2 } });
    expect(intent).toMatchObject({ kind: 'buy', itemId: 'tap', qty: 2, price: 256 });
    expect(reply).toMatchObject({ ok: true, result: { bits: 744 } });
    expect(op.bits).toBe(744);
    expect(op.inventory.tap).toBe(2);
    expect(events).toContainEqual({ e: 'bits', delta: -256, reason: 'shop', balance: 744 });
    expect(store.ledger).toEqual([{ operatorId: 'alice', delta: -256, reason: 'shop', ref: intent!.id, at: expect.any(String) }]);
    expect(store.operators.get('alice')).toMatchObject({ bits: 744, inventory: { tap: 2 } });
  });

  it('refuses away from the host, unknown items, bad quantities and unaffordable purchases', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const buy = (args: { itemId: string; qty?: number }) => step(world, input('alice', { cmd: 'buy', actor: self, args: { qty: 1, ...args } })).replies[0];
    expect(buy({ itemId: 'jumboframe' })).toMatchObject({ code: 'E_INVALID' });
    expect(buy({ itemId: 'dump' })).toMatchObject({ code: 'E_STATE', message: 'costs 2048 bits, have 1000' });
    expect(buy({ itemId: 'sniff', qty: 65 })).toMatchObject({ code: 'E_INVALID' });
    op.x = HOST.x + 5;
    expect(buy({ itemId: 'sniff' })).toMatchObject({ code: 'E_RANGE' });
  });

  it('reverts an optimistic purchase the store rejects', async () => {
    const world = setup();
    const store = new MemoryStore(); // no such operator: the intent throws, the runtime reports a failure
    const r = step(world, input('alice', { cmd: 'buy', actor: self, args: { itemId: 'sniff', qty: 4 } }));
    const op = world.operators.get('alice')!;
    expect(op.bits).toBe(1000 - 128);
    expect(op.inventory.sniff).toBe(4);
    await expect(store.applyIntent(r.intents[0]!, { seedId: 'seed0001' })).rejects.toThrow();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(op.bits).toBe(1000);
    expect(op.inventory.sniff).toBeUndefined();
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'persist failed' });
  });

  it('Disk expansion adds 32 slots at a doubling price, up to 512', async () => {
    const world = setup({ bits: 2_000_000, diskCapacity: 480 });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const first = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 1 } });
    expect(first.intent).toMatchObject({ price: 8192 * 2 ** 7 });
    expect(op.diskCapacity).toBe(512);
    expect(first.events).toContainEqual({ e: 'bits', delta: -8192 * 2 ** 7, reason: 'disk', balance: 2_000_000 - 8192 * 2 ** 7 });
    expect(store.operators.get('alice')!.diskCapacity).toBe(512);
    const again = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 1 } });
    expect(again.reply).toMatchObject({ code: 'E_STATE' });
    expect(step(world, input('alice', { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 2 } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
  });
});

describe('crafting', () => {
  it('consumes fragments and bits, produces the output, and resolves "any" with using', async () => {
    const world = setup({ inventory: { 'frag:packet': 10, 'frag:socket': 4, 'frag:glitch': 2 } });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const tap = await through(world, store, { cmd: 'craft', actor: self, args: { recipeId: 'tap', qty: 1 } });
    expect(tap.intent).toMatchObject({ kind: 'craft', bits: 64, fragments: { 'frag:packet': 4, 'frag:socket': 4 }, output: { item: 'tap', qty: 1 } });
    expect(op.inventory).toEqual({ 'frag:packet': 6, 'frag:glitch': 2, tap: 1 });
    expect(op.bits).toBe(936);
    expect(store.operators.get('alice')).toMatchObject({ bits: 936, inventory: { 'frag:packet': 6, 'frag:glitch': 2, tap: 1 } });
    const restore = await through(world, store, { cmd: 'craft', actor: self, args: { recipeId: 'restore', qty: 1, using: 'glitch' } });
    expect(restore.reply).toMatchObject({ ok: true });
    expect(op.inventory.restore).toBe(1);
    expect(op.inventory['frag:glitch']).toBeUndefined();
  });

  it('refuses unknown recipes, missing fragments, missing "using" and bad quantities', () => {
    const world = setup({ inventory: { 'frag:packet': 4 } });
    const craft = (args: { recipeId: string; qty?: number; using?: 'glitch' }) => step(world, input('alice', { cmd: 'craft', actor: self, args: { qty: 1, ...args } })).replies[0];
    expect(craft({ recipeId: 'nope' })).toMatchObject({ code: 'E_INVALID' });
    expect(craft({ recipeId: 'tap' })).toMatchObject({ code: 'E_STATE', message: 'need 4 frag:socket, have 0' });
    expect(craft({ recipeId: 'restore' })).toMatchObject({ code: 'E_INVALID' });
    expect(craft({ recipeId: 'restore', qty: 17, using: 'glitch' })).toMatchObject({ code: 'E_INVALID' });
  });
});

describe('decompile', () => {
  it('destroys a RAM daemon at the host for fragments of each type, archiving it in the store', async () => {
    const world = setup({ ram: [ownedRecord('tracerat', 20, 0, 'alice-d0')] });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const { reply, intent, events } = await through(world, store, { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: false } });
    expect(intent).toMatchObject({ kind: 'decompile', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 } });
    expect(intent).toMatchObject({ history: { at: FIXED_CLOCK, kind: 'decompiled' } });
    expect(reply).toMatchObject({ ok: true, result: { fragments: { 'frag:packet': 9, 'frag:signal': 9 } } });
    expect(events).toContainEqual({ e: 'decompiled', daemon: 'alice-d0', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 } });
    expect(world.daemons.has('alice-d0')).toBe(false);
    expect(op.ram).toEqual([]);
    expect(op.inventory).toMatchObject({ 'frag:packet': 9, 'frag:signal': 9 });
    expect(store.daemons.has('alice-d0')).toBe(false);
    expect(store.archive.get('alice-d0')).toMatchObject({ species: 'tracerat', reason: 'decompiled' });
    expect(store.archive.get('alice-d0')!.history.at(-1)).toMatchObject({ kind: 'decompiled' });
  });

  it('needs confirm for clean or signature daemons, refuses running ones, and returns a held item', async () => {
    const world = setup({ ram: [{ ...ownedRecord('pingling', 5, 0, 'alice-d0'), signature: 2, heldItem: 'jumboframe' }] });
    const store = await seeded(world);
    const attempt = (confirm: boolean) => step(world, input('alice', { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm } })).replies[0];
    expect(attempt(false)).toMatchObject({ code: 'E_STATE', message: 'confirm required' });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(attempt(true)).toMatchObject({ code: 'E_STATE', message: 'recall the daemon first' });
    world.deactivate(world.daemons.get('alice-d0')!);
    const { intent } = await through(world, store, { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: true } });
    expect(intent).toMatchObject({ fragments: { 'frag:packet': 1, jumboframe: 1 } });
    expect(world.operators.get('alice')!.inventory.jumboframe).toBe(1);
  });

  it('keeps the daemon when the store fails', async () => {
    const world = setup({ ram: [ownedRecord('pingling', 5, 0, 'alice-d0')] });
    const r = step(world, input('alice', { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: false } }));
    const d = world.daemons.get('alice-d0')!;
    expect(d.pending).toBe(true);
    world.completeIntent((r.intents[0] as Intent).id, { ok: false, reason: 'db down' });
    expect(d.pending).toBe(false);
    expect(world.daemons.has('alice-d0')).toBe(true);
  });
});
```

In `apps/sim/test/store.test.ts` rename the checkpoint case to `'checkpoints position, inventory and RAM daemon state (never bits)'` and change its expectation to `bits: 0`; add before the evolve case:

```ts
    it('buys, expands Disk, crafts and decompiles through the ledger, refusing what the operator cannot afford', async () => {
      const a = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'ezra', ownedRecord('tracerat', 20, 0, 'abcd1234-e1')), { seedId: 'abcd1234' });
      const buy = (id: string, itemId: string, qty: number, price: number): Intent => ({ id, kind: 'buy', operatorId: a.id, reqId: 'r', itemId, qty, price });
      expect(await store.applyIntent(buy('i-buy-0', 'sniff', 1, 32), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough bits' });
      await store.grantBits(a.id, 10_000, 'admin');
      expect(await store.applyIntent(buy('i-buy-1', 'sniff', 3, 96), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(buy('i-buy-1', 'sniff', 3, 96), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(buy('i-buy-2', 'diskExpansion', 1, 8192), { seedId: 'abcd1234' })).toEqual({ ok: true });
      let rec = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      expect(rec).toMatchObject({ bits: 10_000 - 96 - 8192, diskCapacity: 288, inventory: { sniff: 11, restore: 2 } });
      const craft: Intent = {
        id: 'i-craft-1', kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'restore', qty: 1, bits: 16, fragments: { 'frag:packet': 2 }, output: { item: 'restore', qty: 1 },
      };
      expect(await store.applyIntent(craft, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough frag:packet' });
      const decompile: Intent = {
        id: 'i-dec-1', kind: 'decompile', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-e1', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 },
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      };
      expect(await store.applyIntent(decompile, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(decompile, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent({ ...decompile, id: 'i-dec-2' }, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.applyIntent(craft, { seedId: 'abcd1234' })).toEqual({ ok: true });
      rec = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      expect(rec.ram).toEqual([]);
      expect(rec).toMatchObject({ bits: 10_000 - 96 - 8192 - 16, inventory: { sniff: 11, restore: 3, 'frag:packet': 7, 'frag:signal': 9 } });
      const ledger = await store.ledgerFor(a.id);
      expect(ledger.map((l) => [l.delta, l.reason])).toEqual([
        [10_000, 'admin'],
        [-96, 'shop'],
        [-8192, 'disk'],
        [-16, 'craft'],
      ]);
      // checkpoints never write bits
      await store.checkpoint([{ ...rec, bits: 1 }]);
      expect((await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN)).bits).toBe(10_000 - 96 - 8192 - 16);
    });
```

and add `"DaemonArchive", "BitsLedger"` to the PrismaStore `TRUNCATE` list (after `"Daemon"`).

- [ ] **Step 4: Sim**

Create `apps/sim/src/core/systems/economy.ts`:

```ts
import {
  BUY_MAX_QTY,
  CRAFT_MAX_QTY,
  DISK_EXPANSION_ITEM,
  DISK_MAX,
  DISK_STEP,
  SHOP,
  decompileYield,
  diskExpansionPrice,
  fragmentId,
  getRecipe,
  getSpecies,
  recipeFragments,
  type TypeId,
} from '@daemonet/rules';
import { Rejection, type Daemon, type Input, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/**
 * Shop, crafting and decompile (SP3b spec §5–§6). Bits and inventory are applied optimistically when the
 * command is accepted so checkpoints never lag the durable ledger; a failed intent reverts them.
 */

function addItems(op: Operator, items: Record<string, number>, sign: 1 | -1): void {
  for (const [id, n] of Object.entries(items)) {
    const next = (op.inventory[id] ?? 0) + sign * n;
    if (next <= 0) delete op.inventory[id];
    else op.inventory[id] = next;
  }
}

function requireItems(op: Operator, items: Record<string, number>): void {
  for (const [id, n] of Object.entries(items)) {
    if ((op.inventory[id] ?? 0) < n) throw new Rejection('E_STATE', `need ${n} ${id}, have ${op.inventory[id] ?? 0}`);
  }
}

export function buy(world: World, op: Operator, args: { itemId: string; qty: number }, input: Input, out: Out): void {
  const qty = args.qty;
  if (qty < 1 || qty > BUY_MAX_QTY) throw new Rejection('E_INVALID', `qty must be 1-${BUY_MAX_QTY}`);
  let price: number;
  if (args.itemId === DISK_EXPANSION_ITEM) {
    if (qty !== 1) throw new Rejection('E_INVALID', 'Disk expansions are bought one at a time');
    const p = diskExpansionPrice(op.diskCapacity);
    if (p === null) throw new Rejection('E_STATE', `Disk is already at its maximum of ${DISK_MAX} slots`);
    price = p;
  } else {
    const unit = SHOP[args.itemId];
    if (unit === undefined) throw new Rejection('E_INVALID', `${args.itemId} is not for sale`);
    price = unit * qty;
  }
  if (op.bits < price) throw new Rejection('E_STATE', `costs ${price} bits, have ${op.bits}`);
  op.bits -= price;
  if (args.itemId === DISK_EXPANSION_ITEM) op.diskCapacity += DISK_STEP;
  else addItems(op, { [args.itemId]: qty }, 1);
  world.trackIntent({ id: world.newId('i'), kind: 'buy', operatorId: op.id, reqId: input.reqId, itemId: args.itemId, qty, price }, out);
}

export function craft(world: World, op: Operator, args: { recipeId: string; qty: number; using?: TypeId | undefined }, input: Input, out: Out): void {
  const qty = args.qty;
  if (qty < 1 || qty > CRAFT_MAX_QTY) throw new Rejection('E_INVALID', `qty must be 1-${CRAFT_MAX_QTY}`);
  let recipe;
  try {
    recipe = getRecipe(args.recipeId);
  } catch {
    throw new Rejection('E_INVALID', `unknown recipe ${args.recipeId}`);
  }
  let fragments: Record<string, number>;
  try {
    fragments = recipeFragments(recipe, qty, args.using);
  } catch (err) {
    throw new Rejection('E_INVALID', (err as Error).message);
  }
  const bits = recipe.bits * qty;
  requireItems(op, fragments);
  if (op.bits < bits) throw new Rejection('E_STATE', `costs ${bits} bits, have ${op.bits}`);
  op.bits -= bits;
  addItems(op, fragments, -1);
  const output = { item: recipe.output.item, qty: recipe.output.qty * qty };
  addItems(op, { [output.item]: output.qty }, 1);
  world.trackIntent({ id: world.newId('i'), kind: 'craft', operatorId: op.id, reqId: input.reqId, recipeId: recipe.id, qty, bits, fragments, output }, out);
}

export function decompile(world: World, op: Operator, d: Daemon, confirm: boolean, input: Input, out: Out): void {
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
  if ((d.clean || d.signature > 0) && !confirm) throw new Rejection('E_STATE', 'confirm required');
  const sp = getSpecies(d.species);
  const n = decompileYield(sp.stage, d.level);
  const fragments: Record<string, number> = {};
  for (const t of d.types) fragments[fragmentId(t)] = n;
  if (d.heldItem) fragments[d.heldItem] = 1;
  d.pending = true;
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'decompile',
      operatorId: op.id,
      reqId: input.reqId,
      daemonId: d.id,
      species: d.species,
      fragments,
      history: { at: world.now(), kind: 'decompiled', detail: `at ${world.subnet.id} into ${Object.entries(fragments).map(([k, v]) => `${v} ${k}`).join(', ')}` },
    },
    out,
  );
}

export function completeEconomyIntent(world: World, op: Operator, intent: Extract<Intent, { kind: 'buy' | 'craft' | 'decompile' }>, result: IntentResult, out: Out): void {
  switch (intent.kind) {
    case 'buy': {
      if (!result.ok) {
        op.bits += intent.price;
        if (intent.itemId === DISK_EXPANSION_ITEM) op.diskCapacity -= DISK_STEP;
        else addItems(op, { [intent.itemId]: intent.qty }, -1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      out.emit({ e: 'bits', delta: -intent.price, reason: intent.itemId === DISK_EXPANSION_ITEM ? 'disk' : 'shop', balance: op.bits }, { to: op.id });
      return out.ok(intent, { bits: op.bits, diskCapacity: op.diskCapacity });
    }
    case 'craft': {
      if (!result.ok) {
        op.bits += intent.bits;
        addItems(op, intent.fragments, 1);
        addItems(op, { [intent.output.item]: intent.output.qty }, -1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      out.emit({ e: 'bits', delta: -intent.bits, reason: 'craft', balance: op.bits }, { to: op.id });
      return out.ok(intent, { bits: op.bits, output: intent.output });
    }
    case 'decompile': {
      const d = world.daemons.get(intent.daemonId);
      if (!result.ok) {
        if (d) d.pending = false;
        return out.fail(intent, 'E_STATE', result.reason);
      }
      world.removeDaemon(intent.daemonId);
      addItems(op, intent.fragments, 1);
      out.emit({ e: 'decompiled', daemon: intent.daemonId, species: intent.species, fragments: intent.fragments }, { to: op.id });
      return out.ok(intent, { fragments: intent.fragments });
    }
  }
}
```

In `apps/sim/src/core/model.ts`: `HistoryEntry.kind` gains `'decompiled'`; `OperatorRecord` and `Operator` gain `diskCapacity: number;` after `bits`; append to the `Intent` union:

```ts
  /** Shop purchase (or a Disk expansion when itemId is 'diskExpansion'); `price` is the total in bits. */
  | { id: string; kind: 'buy'; operatorId: string; reqId: string; itemId: string; qty: number; price: number }
  | { id: string; kind: 'craft'; operatorId: string; reqId: string; recipeId: string; qty: number; bits: number; fragments: Record<string, number>; output: { item: string; qty: number } }
  | { id: string; kind: 'decompile'; operatorId: string; reqId: string; daemonId: string; species: string; fragments: Record<string, number>; history: HistoryEntry };
```

In `apps/sim/src/core/world.ts`: `addOperator` copies `diskCapacity: rec.diskCapacity`, `checkpoint()` returns `diskCapacity: op.diskCapacity`; import `completeEconomyIntent` from `./systems/economy.js` and add to `completeIntent`:

```ts
      case 'buy':
      case 'craft':
      case 'decompile':
        return completeEconomyIntent(this, op, intent, result, out);
```

In `apps/sim/src/core/view.ts` `toSelf` returns `diskCapacity: op.diskCapacity` after `bits`.

In `apps/sim/src/core/systems/commands.ts`: drop `DISK_SLOTS` from the rules import, import `{ buy, craft, decompile } from './economy.js'`, replace `for (let s = 0; s < DISK_SLOTS; s++)` in `store` with `op.diskCapacity`, and add after the `travel` case:

```ts
    case 'buy':
      requireAtHost(world, op);
      return buy(world, op, c.args, input, out);
    case 'craft':
      requireAtHost(world, op);
      return craft(world, op, c.args, input, out);
    case 'decompile':
      requireAtHost(world, op);
      return decompile(world, op, ownedDaemon(world, op, c.args.daemonId), c.args.confirm, input, out);
```

In `apps/sim/src/core/systems/capture.ts` drop `DISK_SLOTS` from the import and compare against `op.diskCapacity` in `startCapture`'s "RAM and Disk are full" check.

- [ ] **Step 5: Stores**

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
  /** Credits (or debits) bits outside the sim's intents — admin grants, dev seeding, ticket payouts (SP3b plan 3). */
  grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void>;
  ledgerFor(operatorId: string, limit?: number): Promise<LedgerRow[]>;
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
  subnet: string;
  bits: number;
  diskCapacity: number;
  x: number;
  y: number;
  inventory: Record<string, number>;
}

export interface LedgerRow {
  operatorId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}

/** In-memory Store with the same semantics as PrismaStore. Used by tests and local development. */
export class MemoryStore implements Store {
  readonly operators = new Map<string, MemOperator>();
  readonly daemons = new Map<string, MemDaemon>();
  readonly applied = new Set<string>();
  readonly seeds: Array<{ id: string; seed: string; subnet: string }> = [];
  readonly discoveries = new Map<string, { operatorId: string; discoveredAt: string }>();
  readonly ledger: LedgerRow[] = [];
  readonly archive = new Map<string, MemDaemon & { reason: string; archivedAt: string }>();
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, subnet, bits: 0, diskCapacity: 256, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: op.bits,
      diskCapacity: op.diskCapacity,
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
      case 'travel':
        Object.assign(op, { subnet: intent.to, x: intent.x, y: intent.y });
        break;
      case 'buy': {
        if (op.bits < intent.price) return { ok: false, reason: 'not enough bits' };
        op.bits -= intent.price;
        if (intent.itemId === 'diskExpansion') op.diskCapacity += 32;
        else op.inventory[intent.itemId] = (op.inventory[intent.itemId] ?? 0) + intent.qty;
        this.ledger.push({ operatorId: op.id, delta: -intent.price, reason: intent.itemId === 'diskExpansion' ? 'disk' : 'shop', ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'craft': {
        if (op.bits < intent.bits) return { ok: false, reason: 'not enough bits' };
        for (const [id, n] of Object.entries(intent.fragments)) if ((op.inventory[id] ?? 0) < n) return { ok: false, reason: `not enough ${id}` };
        op.bits -= intent.bits;
        for (const [id, n] of Object.entries(intent.fragments)) {
          const left = (op.inventory[id] ?? 0) - n;
          if (left <= 0) delete op.inventory[id];
          else op.inventory[id] = left;
        }
        op.inventory[intent.output.item] = (op.inventory[intent.output.item] ?? 0) + intent.output.qty;
        this.ledger.push({ operatorId: op.id, delta: -intent.bits, reason: 'craft', ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'decompile': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM') return { ok: false, reason: 'daemon not found' };
        this.daemons.delete(d.id);
        this.archive.set(d.id, { ...d, history: [...d.history, intent.history], reason: 'decompiled', archivedAt: new Date().toISOString() });
        for (const [id, n] of Object.entries(intent.fragments)) op.inventory[id] = (op.inventory[id] ?? 0) + n;
        break;
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      // bits move only through intents (the ledger); checkpoints never write them
      Object.assign(op, { subnet: rec.subnet, x: rec.x, y: rec.y, inventory: { ...rec.inventory } });
      for (const d of rec.ram) {
        const row = this.daemons.get(d.id);
        if (row && row.operatorId === op.id) Object.assign(row, { ...d, location: 'RAM' as const });
      }
    }
  }

  async listDiscoveries(): Promise<string[]> {
    return [...this.discoveries.keys()];
  }

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void> {
    const op = this.operators.get(operatorId);
    if (!op) throw new Error(`unknown operator ${operatorId}`);
    op.bits += delta;
    this.ledger.push({ operatorId, delta, reason, ref: ref ?? null, at: new Date().toISOString() });
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    return this.ledger.filter((l) => l.operatorId === operatorId).slice(-limit);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
```

Replace `apps/sim/src/runtime/prisma-store.ts`:

```ts
import { createPrisma, type Daemon as DaemonRow, type Prisma, type PrismaClient } from '@daemonet/db';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type IntentContext, type LedgerRow, type Store } from './store.js';

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
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: Number(op.bits),
      diskCapacity: op.diskCapacity,
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
          case 'travel': {
            await tx.operator.update({ where: { id: intent.operatorId }, data: { subnet: intent.to, x: intent.x, y: intent.y } });
            return { ok: true } as const;
          }
          case 'buy': {
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            if (op.bits < BigInt(intent.price)) throw new DomainFailure('not enough bits');
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            const disk = intent.itemId === 'diskExpansion';
            if (!disk) inventory[intent.itemId] = (inventory[intent.itemId] ?? 0) + intent.qty;
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: { bits: { decrement: BigInt(intent.price) }, inventory, ...(disk ? { diskCapacity: { increment: 32 } } : {}) },
            });
            await tx.bitsLedger.create({ data: { operatorId: intent.operatorId, delta: BigInt(-intent.price), reason: disk ? 'disk' : 'shop', ref: intent.id } });
            return { ok: true } as const;
          }
          case 'craft': {
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            if (op.bits < BigInt(intent.bits)) throw new DomainFailure('not enough bits');
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            for (const [id, n] of Object.entries(intent.fragments)) {
              if ((inventory[id] ?? 0) < n) throw new DomainFailure(`not enough ${id}`);
              const left = (inventory[id] ?? 0) - n;
              if (left <= 0) delete inventory[id];
              else inventory[id] = left;
            }
            inventory[intent.output.item] = (inventory[intent.output.item] ?? 0) + intent.output.qty;
            await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { decrement: BigInt(intent.bits) }, inventory } });
            await tx.bitsLedger.create({ data: { operatorId: intent.operatorId, delta: BigInt(-intent.bits), reason: 'craft', ref: intent.id } });
            return { ok: true } as const;
          }
          case 'decompile': {
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM') throw new DomainFailure('daemon not found');
            const { location: _l, slot: _s, hp: _h, energy: _e, crashed: _c, ...rest } = row;
            const history = [...(Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : []), intent.history];
            await tx.daemonArchive.create({ data: { ...rest, history: json(history), reason: 'decompiled' } });
            await tx.daemon.delete({ where: { id: intent.daemonId } });
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            for (const [id, n] of Object.entries(intent.fragments)) inventory[id] = (inventory[id] ?? 0) + n;
            await tx.operator.update({ where: { id: intent.operatorId }, data: { inventory } });
            return { ok: true } as const;
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
          // bits move only through intents (the ledger); checkpoints never write them
          data: { subnet: rec.subnet, x: rec.x, y: rec.y, inventory: rec.inventory, lastSeenAt: now },
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

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.operator.update({ where: { id: operatorId }, data: { bits: { increment: BigInt(delta) } } }),
      this.prisma.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason, ref: ref ?? null } }),
    ]);
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    const rows = await this.prisma.bitsLedger.findMany({ where: { operatorId }, orderBy: { at: 'desc' }, take: limit });
    return rows.reverse().map((r) => ({ operatorId: r.operatorId, delta: Number(r.delta), reason: r.reason, ref: r.ref, at: r.at.toISOString() }));
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

- [ ] **Step 6: Verify and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green.

```bash
git add packages/db packages/shared packages/sdk packages/sandbox apps/sim
git commit -m "feat(sim): bits ledger, shop, Disk expansion, decompile and crafting intents"
```

---

### Task 3: API — shop, recipes, ledger, admin economy, dev bits

**Files:**
- Create: `apps/api/src/routes/economy.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/auth/dev-bypass.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- `GET /api/shop` → `{ prices, bits, diskCapacity, diskExpansionPrice }`; `GET /api/recipes` → `RECIPES`; `GET /api/ledger` → the caller's last 64 rows `[{ delta, reason, ref, at }]` newest first; `GET /api/admin/economy` (admin) → `{ supply, operators, days: [{ day, created, destroyed, byReason }] }` for the last `ECONOMY_DAYS = 14` days.
- `POST /api/dev/bits { amount }` (dev bypass only) credits the caller with reason `admin`, ref `dev`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/app.test.ts` add `"DaemonArchive", "BitsLedger"` to the truncation list and this case before the dev-seeding case:

```ts
  it('serves the shop, recipes and the caller’s ledger; the admin economy view sums the ledger', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=fay&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const shop = (await app.inject({ method: 'GET', url: '/api/shop', cookies })).json();
    expect(shop.prices.sniff).toBe(32);
    expect(shop).toMatchObject({ diskCapacity: 256, diskExpansionPrice: 8192, bits: 0 });
    const recipes = (await app.inject({ method: 'GET', url: '/api/recipes', cookies })).json();
    expect(recipes).toHaveLength(25);
    expect(recipes.find((r: { id: string }) => r.id === 'tap')).toMatchObject({ bits: 64, fragments: { packet: 4, socket: 4 }, output: { item: 'tap', qty: 1 } });
    const granted = await app.inject({ method: 'POST', url: '/api/dev/bits', cookies, headers: csrf, payload: { amount: 500 } });
    expect(granted.json()).toEqual({ bits: 500 });
    const ledger = (await app.inject({ method: 'GET', url: '/api/ledger', cookies })).json();
    expect(ledger).toMatchObject([{ delta: 500, reason: 'admin' }]);
    const economy = (await app.inject({ method: 'GET', url: '/api/admin/economy', cookies })).json();
    expect(economy).toMatchObject({ supply: 500, operators: 1 });
    expect(economy.days[0]).toMatchObject({ created: 500, destroyed: 0, byReason: { admin: 500 } });
    const plain = await app.inject({ method: 'GET', url: '/api/auth/dev?name=gus' });
    const plainCookies = { [COOKIE_NAME]: plain.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    expect((await app.inject({ method: 'GET', url: '/api/admin/economy', cookies: plainCookies })).statusCode).toBe(403);
  });
```

- [ ] **Step 2: Routes**

Create `apps/api/src/routes/economy.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { RECIPES, SHOP, diskExpansionPrice } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';

export const ECONOMY_DAYS = 14;

/** Shop, recipes, the caller's ledger, and the admin economy view (SP3b spec §5, design §10 "Economy"). */
export function registerEconomyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/api/shop', auth, async (req) => {
    const op = await prisma.operator.findUniqueOrThrow({ where: { id: req.operator!.id }, select: { bits: true, diskCapacity: true } });
    return { prices: SHOP, bits: Number(op.bits), diskCapacity: op.diskCapacity, diskExpansionPrice: diskExpansionPrice(op.diskCapacity) };
  });

  app.get('/api/recipes', auth, async () => RECIPES);

  app.get('/api/ledger', auth, async (req) => {
    const rows = await prisma.bitsLedger.findMany({ where: { operatorId: req.operator!.id }, orderBy: { at: 'desc' }, take: 64 });
    return rows.map((r) => ({ delta: Number(r.delta), reason: r.reason, ref: r.ref, at: r.at }));
  });

  /** Total supply and, per day for the last ECONOMY_DAYS days, bits created / destroyed and the split by reason. */
  app.get('/api/admin/economy', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const [supply, operators] = await Promise.all([prisma.operator.aggregate({ _sum: { bits: true } }), prisma.operator.count()]);
    const since = new Date(Date.now() - ECONOMY_DAYS * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await prisma.bitsLedger.findMany({ where: { at: { gte: since } }, select: { delta: true, reason: true, at: true } });
    const days = new Map<string, { day: string; created: number; destroyed: number; byReason: Record<string, number> }>();
    for (const r of rows) {
      const day = r.at.toISOString().slice(0, 10);
      let d = days.get(day);
      if (!d) days.set(day, (d = { day, created: 0, destroyed: 0, byReason: {} }));
      const delta = Number(r.delta);
      if (delta >= 0) d.created += delta;
      else d.destroyed -= delta;
      d.byReason[r.reason] = (d.byReason[r.reason] ?? 0) + delta;
    }
    return { supply: Number(supply._sum.bits ?? 0), operators, days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  });
}
```

Register it in `apps/api/src/app.ts` (`import { registerEconomyRoutes } from './routes/economy.js';` and `registerEconomyRoutes(app, o.prisma);` after the misc routes).

Replace `apps/api/src/auth/dev-bypass.ts` (adds `/api/dev/bits` and reads the Disk capacity from the operator row):

```ts
import type { PrismaClient } from '@daemonet/db';
import { LO, computeStats, emptyMoveTypeUses, getSpecies, movesAtLevel, rollSpawn, createRng, statBlockToArray, xpForLevel } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { ensureOperator } from './routes.js';
import type { SessionStore } from './session.js';

const SeedBody = z.object({ species: z.string().min(1).max(32), level: z.number().int().min(1).max(64) });
const BitsBody = z.object({ amount: z.number().int().min(1).max(1_000_000) });

/**
 * Development only (AUTH_DEV_BYPASS=true, refused in production): GET /api/auth/dev?name=alice
 * creates a session for sub `dev-alice` — the same sub the sim's dev verifier uses, so the
 * browser and a `dev:alice` bot share one operator. POST /api/dev/daemon { species, level } puts a
 * daemon of that species on the caller's Disk (tests load it into RAM at the host, e.g. to evolve it).
 */
export function registerDevBypass(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; sessionStore: SessionStore; cookieName: string; cookieSecure: boolean; ttlSeconds: number; frontendOrigin: string; adminGroup: string; requiredGroup: string },
): void {
  app.get<{ Querystring: { name?: string; admin?: string } }>('/api/auth/dev', async (req, reply) => {
    const name = req.query.name ?? '';
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw badRequest('name must match [a-z0-9_-]{1,32}');
    const isAdmin = req.query.admin === 'true';
    const op = await ensureOperator(deps.prisma, `dev-${name}`, isAdmin);
    const token = await deps.sessionStore.create(op.id, isAdmin ? [deps.requiredGroup, deps.adminGroup] : [deps.requiredGroup]);
    reply.setCookie(deps.cookieName, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    return reply.redirect(`${deps.frontendOrigin}/`);
  });

  /** Credits bits to the caller (ledger reason `admin`) so tests can exercise the shop and crafting. */
  app.post('/api/dev/bits', { preHandler: app.requireAuth }, async (req) => {
    const parsed = BitsBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { amount 1-1000000 }');
    const operatorId = req.operator!.id;
    const [op] = await deps.prisma.$transaction([
      deps.prisma.operator.update({ where: { id: operatorId }, data: { bits: { increment: BigInt(parsed.data.amount) } }, select: { bits: true } }),
      deps.prisma.bitsLedger.create({ data: { operatorId, delta: BigInt(parsed.data.amount), reason: 'admin', ref: 'dev' } }),
    ]);
    return { bits: Number(op.bits) };
  });

  app.post('/api/dev/daemon', { preHandler: app.requireAuth }, async (req) => {
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { species, level 1-64 }');
    let species;
    try {
      species = getSpecies(parsed.data.species);
    } catch {
      throw badRequest('unknown species');
    }
    const operatorId = req.operator!.id;
    const { diskCapacity } = await deps.prisma.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { diskCapacity: true } });
    const used = new Set((await deps.prisma.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((d) => d.slot));
    let slot = 0;
    while (used.has(slot) && slot < diskCapacity) slot++;
    if (slot >= diskCapacity) throw badRequest('Disk is full');
    const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roll = rollSpawn(createRng(id), { clean: 0, signatureStep: 0 });
    const level = parsed.data.level;
    const row = await deps.prisma.daemon.create({
      data: {
        id, operatorId, species: species.id, level, xp: xpForLevel(level), nature: roll.nature, traitSlot: roll.traitSlot,
        ivs: statBlockToArray(roll.ivs), bonus: statBlockToArray(roll.bonus), clean: false, signature: 0,
        hp: computeStats({ base: species.base, ivs: roll.ivs, bonus: roll.bonus, level, nature: roll.nature }).hp, energy: 128,
        moves: movesAtLevel(species, level), crashed: false, location: 'DISK', slot, moveTypeUses: emptyMoveTypeUses(),
        history: [{ at: new Date().toISOString(), kind: 'captured', detail: 'dev seed' }],
        originalOperatorId: operatorId, capturedAt: new Date(), captureSubnet: LO.id, captureTool: 'dev', spawnSeedId: 'dev', spawnIndex: null,
      },
    });
    return { id: row.id, species: row.species, level: row.level, slot: row.slot };
  });
}
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green.

```bash
git add apps/api
git commit -m "feat(api): shop, recipes, ledger and admin economy routes; dev bits seeding"
```

---

### Task 4: Client — Host panel, decompile, e2e

**Files:**
- Create: `apps/frontend/src/game/economy.ts`, `apps/frontend/src/panels/HostPanel.tsx`, `apps/frontend/test/host.test.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/panels/RamPanel.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `craftCheck(recipe, qty, inventory, bits, using?) → { ok, bits, needs: [{ item, have, need }], needsType }`, `fragmentTypes(inventory)`, `formatBits(bits)` (8 bits = 1 B, 8192 bits = 1 KiB).
- `HostPanel({ client })` with views `shop` / `craft` / `ledger`; test ids `host-status`, `host-<view>`, `qty`, `buy-<itemId>`, `buy-diskExpansion`, `using`, `recipe-<id>`, `craft-<id>`, `ledger`. RAM card: `decompile-<slot>` (confirms clean / signature via `window.confirm`).
- `api.ts`: `useLedgerQuery` (`/api/ledger`), `LedgerEntry`.

- [ ] **Step 1: Write the failing unit test**

```tsx
// @vitest-environment jsdom
import { getRecipe } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { craftCheck, formatBits, fragmentTypes } from '../src/game/economy.ts';

describe('craftCheck', () => {
  it('reports have / need per fragment and the bits cost', () => {
    const c = craftCheck(getRecipe('tap'), 2, { 'frag:packet': 8, 'frag:socket': 3 }, 200);
    expect(c.bits).toBe(128);
    expect(c.needs).toEqual([
      { item: 'frag:packet', have: 8, need: 8 },
      { item: 'frag:socket', have: 3, need: 8 },
    ]);
    expect(c.ok).toBe(false);
    expect(craftCheck(getRecipe('tap'), 1, { 'frag:packet': 4, 'frag:socket': 4 }, 64).ok).toBe(true);
    expect(craftCheck(getRecipe('tap'), 1, { 'frag:packet': 4, 'frag:socket': 4 }, 63).ok).toBe(false);
  });

  it('needs a type for "any" recipes and resolves it when given', () => {
    const none = craftCheck(getRecipe('restore'), 1, { 'frag:glitch': 2 }, 16);
    expect(none).toMatchObject({ ok: false, needsType: true, needs: [] });
    const chosen = craftCheck(getRecipe('restore'), 1, { 'frag:glitch': 2 }, 16, 'glitch');
    expect(chosen).toMatchObject({ ok: true, needsType: false, needs: [{ item: 'frag:glitch', have: 2, need: 2 }] });
  });
});

describe('inventory helpers', () => {
  it('lists held fragment types and formats bits in binary units', () => {
    expect(fragmentTypes({ 'frag:packet': 2, 'frag:null': 0, sniff: 3 })).toEqual(['packet']);
    expect(formatBits(5)).toBe('5 b');
    expect(formatBits(64)).toBe('8 B');
    expect(formatBits(100)).toBe('12.50 B');
    expect(formatBits(8192)).toBe('1.00 KiB');
    expect(formatBits(8192 * 1024)).toBe('1.00 MiB');
  });
});
```

- [ ] **Step 2: Helpers and panel**

Create `apps/frontend/src/game/economy.ts`:

```ts
import { fragmentId, type RecipeDef, type TypeId } from '@daemonet/rules';

/** `have / need` per fragment for a craft; `ok` when the inventory and bits cover it. */
export interface CraftCheck {
  ok: boolean;
  bits: number;
  needs: Array<{ item: string; have: number; need: number }>;
  /** The recipe has an `any` slot and no type was chosen. */
  needsType: boolean;
}

export function craftCheck(recipe: RecipeDef, qty: number, inventory: Record<string, number>, bits: number, using?: TypeId): CraftCheck {
  const needs: CraftCheck['needs'] = [];
  let needsType = false;
  for (const [key, n] of Object.entries(recipe.fragments) as Array<[TypeId | 'any', number]>) {
    const type = key === 'any' ? using : key;
    if (!type) {
      needsType = true;
      continue;
    }
    const item = fragmentId(type);
    needs.push({ item, have: inventory[item] ?? 0, need: n * qty });
  }
  const cost = recipe.bits * qty;
  const ok = !needsType && bits >= cost && needs.every((x) => x.have >= x.need);
  return { ok, bits: cost, needs, needsType };
}

/** Fragment types the operator holds (for the `using` picker). */
export function fragmentTypes(inventory: Record<string, number>): TypeId[] {
  return Object.entries(inventory)
    .filter(([id, n]) => n > 0 && id.startsWith('frag:'))
    .map(([id]) => id.slice(5) as TypeId);
}

/** Bits shown in binary units: 8 bits = 1 byte, 1 KiB = 8192 bits (design §10). */
export function formatBits(bits: number): string {
  if (bits >= 8192 * 1024) return `${(bits / (8192 * 1024)).toFixed(2)} MiB`;
  if (bits >= 8192) return `${(bits / 8192).toFixed(2)} KiB`;
  if (bits >= 8) return `${(bits / 8).toFixed(bits % 8 === 0 ? 0 : 2)} B`;
  return `${bits} b`;
}
```

Create `apps/frontend/src/panels/HostPanel.tsx`:

```tsx
import { DISK_MAX, DISK_STEP, RECIPES, SHOP, diskExpansionPrice, getItem, type TypeId } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { useLedgerQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { craftCheck, formatBits, fragmentTypes } from '../game/economy.ts';
import { nearHost } from './RamPanel.tsx';

const VIEWS = ['shop', 'craft', 'ledger'] as const;
type View = (typeof VIEWS)[number];

/** Everything that happens at a host node: the NPC shop, Disk expansion, crafting, and the bits ledger. */
export function HostPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = nearHost(client.subnet, me);
  const [view, setView] = useState<View>('shop');
  const [qty, setQty] = useState(1);
  const [using, setUsing] = useState<TypeId | ''>('');
  const ledger = useLedgerQuery(undefined, { skip: view !== 'ledger' });
  const diskPrice = diskExpansionPrice(me.diskCapacity);
  const can = manual && atHost;
  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-neutral-500" data-testid="host-status">
        {atHost ? 'at the host' : 'walk to the host node to trade'} · {me.bits} bits ({formatBits(me.bits)}) · Disk {me.diskCapacity}
      </p>
      <nav className="flex gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`host-${v}`}>
            {v}
          </button>
        ))}
        <label className="ml-auto text-neutral-500">
          qty
          <input className="ml-1 w-12 rounded bg-neutral-800 px-1" type="number" min={1} max={64} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} data-testid="qty" />
        </label>
      </nav>

      {view === 'shop' && (
        <section className="space-y-1" data-testid="shop">
          {Object.entries(SHOP).map(([id, price]) => (
            <div key={id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
              <span>
                {getItem(id).name} <span className="mono text-xs text-neutral-500">×{me.inventory[id] ?? 0}</span>
              </span>
              <button
                className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
                disabled={!can || me.bits < price * qty}
                onClick={() => run(client.operator.buy(id, qty), 'buy')}
                data-testid={`buy-${id}`}
              >
                buy {qty > 1 ? `×${qty} ` : ''}for {price * qty}
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
            <span>
              Disk expansion <span className="mono text-xs text-neutral-500">+{DISK_STEP} slots (max {DISK_MAX})</span>
            </span>
            <button
              className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
              disabled={!can || diskPrice === null || me.bits < diskPrice}
              onClick={() => run(client.operator.buy('diskExpansion', 1), 'buy')}
              data-testid="buy-diskExpansion"
            >
              {diskPrice === null ? 'maxed' : `buy for ${diskPrice}`}
            </button>
          </div>
        </section>
      )}

      {view === 'craft' && (
        <section className="space-y-1" data-testid="craft">
          <label className="text-xs text-neutral-500">
            fragment type for “any” recipes
            <select className="ml-1 rounded bg-neutral-800 px-1" value={using} onChange={(e) => setUsing(e.target.value as TypeId | '')} data-testid="using">
              <option value="">—</option>
              {fragmentTypes(me.inventory).map((t) => (
                <option key={t} value={t}>
                  {t} ×{me.inventory[`frag:${t}`]}
                </option>
              ))}
            </select>
          </label>
          {RECIPES.map((r) => {
            const check = craftCheck(r, qty, me.inventory, me.bits, using || undefined);
            return (
              <div key={r.id} className="rounded border border-neutral-800 px-2 py-1" data-testid={`recipe-${r.id}`}>
                <div className="flex items-center justify-between">
                  <span>
                    {getItem(r.output.item).name}
                    {r.output.qty > 1 ? ` ×${r.output.qty}` : ''} <span className="mono text-xs text-neutral-500">×{me.inventory[r.output.item] ?? 0}</span>
                  </span>
                  <button
                    className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
                    disabled={!can || !check.ok}
                    onClick={() => run(client.operator.craft(r.id, qty, using || undefined), 'craft')}
                    data-testid={`craft-${r.id}`}
                  >
                    craft for {check.bits}
                  </button>
                </div>
                <div className="mono text-xs text-neutral-500">
                  {check.needsType && 'pick a fragment type · '}
                  {check.needs.map((n) => (
                    <span key={n.item} className={n.have >= n.need ? 'text-neutral-400' : 'text-red-400'}>
                      {n.item.slice(5)} {n.have}/{n.need}{' '}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {view === 'ledger' && (
        <section className="mono text-xs" data-testid="ledger">
          {ledger.data?.length === 0 && <p className="text-neutral-500">no bits have moved yet</p>}
          {ledger.data?.map((l, i) => (
            <div key={i} className="flex justify-between border-b border-neutral-900 py-0.5">
              <span className="text-neutral-500">{new Date(l.at).toLocaleString()}</span>
              <span>{l.reason}</span>
              <span className={l.delta >= 0 ? 'text-emerald-300' : 'text-red-300'}>{l.delta >= 0 ? '+' : ''}{l.delta}</span>
            </div>
          ))}
          <button className="mt-1 text-neutral-500 underline" onClick={() => ledger.refetch()}>
            refresh
          </button>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wiring**

In `apps/frontend/src/api.ts` add

```ts
export interface LedgerEntry {
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}
```

the endpoint `ledger: b.query<LedgerEntry[], void>({ query: () => '/ledger' }),` and `useLedgerQuery` to the exported hooks.

In `apps/frontend/src/App.tsx`: import `HostPanel`, add `'host'` to `TABS` after `'disk'`, and render `{tab === 'host' && client?.self && <HostPanel client={client} />}`.

In `apps/frontend/src/panels/RamPanel.tsx` add after the **store** button:

```tsx
                  <button
                    className="text-red-300 hover:text-red-200 disabled:opacity-40"
                    disabled={!manual || running || !atHost}
                    onClick={() => {
                      const rare = d.clean || d.signature > 0;
                      if (rare && !window.confirm(`${sp.name} is ${d.clean ? 'a clean image' : `signature T${d.signature}`}. Decompile it anyway?`)) return;
                      run(client.operator.decompile(d.id, rare), 'decompile');
                    }}
                    data-testid={`decompile-${d.slot}`}
                  >
                    decompile
                  </button>
```

In `apps/frontend/src/game/connection.ts` after the `travelled` handler:

```ts
    client.on('bits', (e) => log.push('event', `${e.delta >= 0 ? '+' : ''}${e.delta} bits (${e.reason}) → ${e.balance}`));
    client.on('decompiled', (e) => log.push('event', `decompiled ${e.species} into ${Object.entries(e.fragments).map(([k, v]) => `${v} ${k}`).join(', ')}`));
```

In `apps/frontend/src/sdk-types.ts`: `OperatorSelf` gains `diskCapacity: number;` after `bits`; `OperatorApi` gains `buy(itemId: string, qty?: number): Promise<unknown>; craft(recipeId: string, qty?: number, using?: string): Promise<unknown>; decompile(daemonId: string, confirm?: boolean): Promise<unknown>;`; `GameClient.on` gains the overloads for `'bits'` (`{ delta, reason, balance }`) and `'decompiled'` (`{ daemon, species, fragments }`).

- [ ] **Step 4: End-to-end**

Append to `apps/frontend/e2e/smoke.spec.ts`:

```ts
test('with dev bits: buy a tap at the host, decompile a seeded daemon into fragments, craft a restore from them', async ({ page }) => {
  const who = `${name}h`;
  // log in and seed through the API before the sim loads the operator: bits granted outside the sim are read on connect
  const headers = { 'x-requested-with': 'daemonet' };
  expect((await page.request.get(`/api/auth/dev?name=${who}`, { maxRedirects: 0 })).status()).toBe(302);
  expect((await page.request.post('/api/dev/bits', { data: { amount: 512 }, headers })).ok()).toBeTruthy();
  expect((await page.request.post('/api/dev/daemon', { data: { species: 'tracerat', level: 20 }, headers })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });

  await page.getByTestId('tab-host').click();
  await expect(page.getByTestId('host-status')).toContainText('at the host');
  await page.getByTestId('buy-tap').click();
  await expect(page.getByTestId('host-status')).toContainText('384 bits', { timeout: 10_000 });

  await page.getByTestId('tab-disk').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await page.getByRole('button', { name: 'load into RAM' }).click();
  await page.getByTestId('tab-ram').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Tracerat', { timeout: 15_000 });
  await page.getByTestId('decompile-1').click();
  await expect(page.getByTestId('ram-1')).toHaveCount(0, { timeout: 15_000 });

  await page.getByTestId('tab-host').click();
  await page.getByTestId('host-craft').click();
  await page.getByTestId('using').selectOption('packet');
  await page.getByTestId('craft-restore').click();
  await expect(page.getByTestId('host-status')).toContainText('368 bits', { timeout: 10_000 });
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText('decompiled tracerat');
  await expect(page.getByTestId('log')).toContainText('-16 bits (craft)');
});
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 33 files, 319 tests. Then build, start the stack (sim, api with `AUTH_DEV_BYPASS=true`, `vite preview`) and `pnpm --filter @daemonet/frontend exec playwright test` — expected: 3 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): host panel (shop, craft, ledger) and decompile"
```

---

## Self-review

- **Spec coverage:** §5 ledger rows for every change, shop prices and `qty ≤ 64`, Disk expansion schedule and cap, `OperatorSelf.diskCapacity`, `/api/shop`, host panel (Tasks 1–4); §6 fragments as items, `decompile` guards and yield, `DaemonArchive`, recipes incl. `any` + `using`, `craft` (`qty ≤ 16`), `/api/recipes`, craft list with have/need, decompile button with confirmation (Tasks 1–4); §9 tables and idempotent intents (Task 2); admin economy view (Task 3). `grantBits` is the hook plan 3's ticket payouts use.
- **Type consistency:** intent field names match between `systems/economy.ts`, both stores and the tests; `LedgerRow` is defined once in `store.ts` and reused by `prisma-store.ts`; test ids in `HostPanel` match the e2e.
- **Placeholders:** none.
