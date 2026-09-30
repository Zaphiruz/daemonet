# Daemonet SP3b · Plan 1 — Subnets and travel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six open-world subnets hosted by one sim process, connected by gateway tiles: content for `lan`, `dmz`, `backbone`, `darknet`, `cloudnet` (spawn tables that put evolved forms in the world), a multi-world `Game`, the `travel` command + durable intent with a world hand-off and fresh snapshot, and the SDK / client surface (gateways on the map, a travel button, the subnet in the top bar).

**Architecture:** `SubnetDef` grows `tier` and `gateways`; `spawnTable(types, stages)` derives species weights from the bestiary so every subnet's regions are content, not code. `Game` keeps `worlds: Map<subnet, World>` ticking in lockstep and binds each session to the world of `Operator.subnet` (unhosted → the default world at its spawn). `travel` is validated in the world (distance, nothing running, no capture, nothing pending, gate level), persisted as an intent (`Operator.subnet/x/y`), and on commit the runtime checkpoints the operator out of the source world, adds it to the destination at the arrival point, queues a `travelled` event there and sends a new `snapshot` — which the SDK already treats as a full reset.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP3a plans 1–4 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3b-economy-subnets-design.md` §3 (decisions), §4.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Every hosted subnet is playable: host, spawn, gateways and regions are walkable and reachable (a sim test walks them all).
- Gateways come in pairs: every destination has a gateway back to its source.
- One process hosts all six subnets by default (`SUBNETS` env, comma-separated).

## File map

```
packages/rules/src/content/subnets.ts     GatewayDef, tier, spawnTable, LAN/DMZ/BACKBONE/DARKNET/CLOUDNET, OPEN_SUBNET_IDS, getGateway, GATEWAY_RADIUS
packages/rules/test/subnets.test.ts       gateway pairs, gate levels, spawn tables
packages/shared/src/protocol.ts           travel command, travelled event
apps/sim/src/core/model.ts                OperatorRecord.subnet, Operator.travelling, travel intent
apps/sim/src/core/world.ts                checkpoint.subnet, hasPendingFor, emitCarry, travel completion
apps/sim/src/core/systems/commands.ts     travel command
apps/sim/src/runtime/game.ts              worlds, session.world, per-world step, moveOperator
apps/sim/src/runtime/{store,prisma-store}.ts   subnet in records, travel intent
apps/sim/src/runtime/{config,main}.ts     SUBNETS env, one world + seed per subnet
apps/sim/test/{layout,travel}.test.ts + helpers/store/integration tests
packages/sdk/src/client.ts                world.gateways, operator.travel
apps/frontend/src/render/draw.ts, panels/PlayPanel.tsx, components/TopBar.tsx, panels/{Ram,Disk}Panel.tsx, game/connection.ts, sdk-types.ts
```

---

### Task 1: Subnet content — gateways, spawn tables, five new subnets

**Files:**
- Modify: `packages/rules/src/content/subnets.ts`, `packages/rules/test/subnets.test.ts`

**Interfaces:**
- `GatewayDef { id; at: Point; to: string; arrive: Point; requires: { level: number } }`; `SubnetDef` gains `tier: number`, `gateways: readonly GatewayDef[]`.
- `GATEWAY_RADIUS = 2`; `spawnTable(types: TypeId[], stages: number[]): Record<string, number>` (non-capstone forms whose primary type ∈ `types` and depth ∈ `stages`; the deepest stage weighs 1, others 2); `SUBNETS` (six), `OPEN_SUBNET_IDS`, `getGateway(subnetId, gatewayId)`.
- Topology: `lo ⇄ lan ⇄ dmz ⇄ backbone ⇄ darknet`, `backbone ⇄ cloudnet`; gate levels into lan 8, dmz 16, backbone 24, darknet 32, cloudnet 40; return gateways 0.

- [ ] **Step 1: Write the failing tests**

Replace `packages/rules/test/subnets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/content/species.js';
import { LO, OPEN_SUBNET_IDS, SUBNETS, getGateway, getSubnet, spawnTable, type Rect } from '../src/content/subnets.js';

const inside = (p: { x: number; y: number }, s: { width: number; height: number }) => p.x > 1 && p.y > 1 && p.x < s.width - 1 && p.y < s.height - 1;
const inWall = (p: { x: number; y: number }, walls: readonly Rect[]) => walls.some((w) => p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h);

describe('subnets', () => {
  it('hosts six open subnets with lo first', () => {
    expect(OPEN_SUBNET_IDS).toEqual(['lo', 'lan', 'dmz', 'backbone', 'darknet', 'cloudnet']);
    expect(SUBNETS[0]).toBe(LO);
    expect(() => getSubnet('nope')).toThrow(RangeError);
  });

  it('lo is 128 x 128 with four regions of rising level and walls inside the border', () => {
    expect(getSubnet('lo')).toBe(LO);
    expect(LO.width).toBe(128);
    expect(LO.regions.map((r) => r.levels)).toEqual([[2, 6], [5, 10], [9, 16], [14, 24]]);
    for (const wall of LO.walls) expect(wall.x >= 1 && wall.y >= 1 && wall.x + wall.w <= LO.width - 1 && wall.y + wall.h <= LO.height - 1).toBe(true);
  });

  it('every gateway leads to a hosted subnet that has a way back, with points inside the map and off the walls', () => {
    for (const s of SUBNETS) {
      for (const p of [s.host, s.spawn]) {
        expect(inside(p, s)).toBe(true);
        expect(inWall(p, s.walls)).toBe(false);
      }
      for (const g of s.gateways) {
        const to = getSubnet(g.to);
        expect(inside(g.at, s) && !inWall(g.at, s.walls)).toBe(true);
        expect(inside(g.arrive, to) && !inWall(g.arrive, to.walls)).toBe(true);
        expect(to.gateways.some((back) => back.to === s.id)).toBe(true);
        expect(g.requires.level).toBeGreaterThanOrEqual(0);
      }
      const ids = s.gateways.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(getGateway('lo', 'lo-lan')).toMatchObject({ to: 'lan', requires: { level: 8 } });
    expect(getGateway('lo', 'nope')).toBeUndefined();
  });

  it('gates rise along the chain', () => {
    const chain = ['lo', 'lan', 'dmz', 'backbone'];
    for (let i = 0; i + 1 < chain.length; i++) {
      const g = getSubnet(chain[i]!).gateways.find((x) => x.to === chain[i + 1])!;
      expect(g.requires.level).toBe([8, 16, 24][i]);
    }
    expect(getSubnet('backbone').gateways.map((g) => [g.to, g.requires.level])).toEqual([
      ['dmz', 0],
      ['darknet', 32],
      ['cloudnet', 40],
    ]);
  });

  it('regions sit inside the map, have non-empty spawn tables of existing species and rising levels', () => {
    for (const s of SUBNETS) {
      let last = 0;
      for (const r of s.regions) {
        expect(r.rect.x + r.rect.w).toBeLessThan(s.width);
        expect(r.rect.y + r.rect.h).toBeLessThan(s.height);
        expect(Object.keys(r.species).length).toBeGreaterThan(0);
        for (const id of Object.keys(r.species)) expect(getSpecies(id).capstone).toBe(false);
        expect(r.levels[0]).toBeGreaterThanOrEqual(last);
        last = r.levels[0];
      }
    }
  });

  it('spawnTable picks non-capstone forms by primary type and stage', () => {
    const t = spawnTable(['packet'], [1, 2]);
    expect(t.echolet).toBe(2);
    expect(t.tracerat).toBe(1);
    expect(t.pingling).toBeUndefined();
    for (const id of Object.keys(t)) {
      const sp = getSpecies(id);
      expect(sp.types[0]).toBe('packet');
      expect([1, 2]).toContain(sp.stage);
    }
    expect(Object.keys(spawnTable(['cloud', 'cache', 'heap', 'stack'], [2, 3])).length).toBeGreaterThan(8);
  });
});
```

Run: `pnpm exec vitest run packages/rules/test/subnets.test.ts` — expected: fails (`OPEN_SUBNET_IDS` etc. missing).

- [ ] **Step 2: Content**

Replace `packages/rules/src/content/subnets.ts`:

```ts
import type { TypeId } from '../types.js';
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

/** A tile an operator can travel from: `travel { gatewayId }` within GATEWAY_RADIUS of `at` lands at `arrive` in `to`. */
export interface GatewayDef {
  id: string;
  at: { x: number; y: number };
  to: string;
  arrive: { x: number; y: number };
  /** The highest level in RAM must reach this. */
  requires: { level: number };
}

export interface SubnetDef {
  id: string;
  /** 0 (lo) .. 4; drives ticket payouts and shop text (SP3b). */
  tier: number;
  width: number;
  height: number;
  /** Blocked rectangles (tile units). The outer border is always blocked. */
  walls: readonly Rect[];
  /** Host node: restore point, store/load point. */
  host: { x: number; y: number };
  /** Where new operators appear. */
  spawn: { x: number; y: number };
  regions: readonly RegionDef[];
  gateways: readonly GatewayDef[];
}

export const GATEWAY_RADIUS = 2;

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

/**
 * Species → weight for every non-capstone form whose primary type is in `types` and whose tree depth
 * is in `stages` (SP3b spec §4.1). Evolved forms spawn wild as themselves; capstones never do.
 */
export function spawnTable(types: readonly TypeId[], stages: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of BESTIARY) {
    if (r.capstone || !stages.includes(r.stage) || !types.includes(r.types[0]!)) continue;
    out[r.id] = r.stage === Math.max(...stages) ? 1 : 2;
  }
  return out;
}

/** The lo layout: two horizontal bars with a central gap and a vertical bar with two gaps. */
const BARS: readonly Rect[] = [
  { x: 1, y: 56, w: 51, h: 2 },
  { x: 76, y: 56, w: 51, h: 2 },
  { x: 64, y: 1, w: 2, h: 28 },
  { x: 64, y: 44, w: 2, h: 41 },
  { x: 64, y: 100, w: 2, h: 27 },
];

/** Four quadrant regions (the same footprint in every subnet) at the given level bands. */
function quadrants(species: readonly Record<string, number>[], levels: readonly (readonly [number, number])[]): RegionDef[] {
  const rects: Rect[] = [
    { x: 24, y: 8, w: 32, h: 36 },
    { x: 72, y: 8, w: 48, h: 40 },
    { x: 8, y: 64, w: 48, h: 56 },
    { x: 72, y: 64, w: 48, h: 56 },
  ];
  const names = ['lobby', 'uplink', 'cache', 'core'];
  return rects.map((rect, i) => ({ name: names[i]!, rect, levels: levels[i]!, species: species[i]!, cap: 16, respawnMs: 4096 }));
}

const CORNER_SE = { x: 122.5, y: 122.5 };
const CORNER_NE = { x: 122.5, y: 5.5 };
const CORNER_NW = { x: 3.5, y: 3.5 };
const ARRIVE_NW = { x: 5.5, y: 5.5 };
const ARRIVE_SE = { x: 120.5, y: 120.5 };
const ARRIVE_NE = { x: 120.5, y: 7.5 };

const gate = (id: string, at: { x: number; y: number }, to: string, arrive: { x: number; y: number }, level: number): GatewayDef => ({ id, at, to, arrive, requires: { level } });

/** 128 x 128, one host, four spawn regions of rising level. */
export const LO: SubnetDef = {
  id: 'lo',
  tier: 0,
  width: 128,
  height: 128,
  walls: BARS,
  host: { x: 16.5, y: 16.5 },
  spawn: { x: 18.5, y: 16.5 },
  regions: quadrants([loWeights(0), loWeights(1), loWeights(2), loWeights(3)], [
    [2, 6],
    [5, 10],
    [9, 16],
    [14, 24],
  ]),
  gateways: [gate('lo-lan', CORNER_SE, 'lan', ARRIVE_NW, 8)],
};

const bands = (start: number): [number, number][] => [
  [start, start + 6],
  [start + 4, start + 10],
  [start + 8, start + 14],
  [start + 10, start + 16],
];

function subnet(id: string, tier: number, types: readonly TypeId[], stages: readonly number[], start: number, gateways: GatewayDef[]): SubnetDef {
  const lower = stages.slice(0, -1).length ? stages.slice(0, -1) : stages;
  return {
    id,
    tier,
    width: 128,
    height: 128,
    walls: BARS,
    host: { x: 16.5, y: 16.5 },
    spawn: { x: 18.5, y: 16.5 },
    regions: quadrants([spawnTable(types, lower), spawnTable(types, stages), spawnTable(types, stages), spawnTable(types, stages)], bands(start)),
    gateways,
  };
}

export const LAN = subnet('lan', 1, ['kernel', 'packet', 'socket', 'thread'], [0, 1], 8, [
  gate('lan-lo', CORNER_NW, 'lo', ARRIVE_SE, 0),
  gate('lan-dmz', CORNER_SE, 'dmz', ARRIVE_NW, 16),
]);
export const DMZ = subnet('dmz', 2, ['crypto', 'root', 'shell', 'proxy'], [1, 2], 16, [
  gate('dmz-lan', CORNER_NW, 'lan', ARRIVE_SE, 0),
  gate('dmz-backbone', CORNER_SE, 'backbone', ARRIVE_NW, 24),
]);
export const BACKBONE = subnet('backbone', 3, ['packet', 'socket', 'cloud', 'buffer'], [1, 2], 24, [
  gate('backbone-dmz', CORNER_NW, 'dmz', ARRIVE_SE, 0),
  gate('backbone-darknet', CORNER_NE, 'darknet', ARRIVE_NW, 32),
  gate('backbone-cloudnet', CORNER_SE, 'cloudnet', ARRIVE_NW, 40),
]);
export const DARKNET = subnet('darknet', 4, ['null', 'glitch', 'proxy', 'crypto'], [2, 3], 32, [gate('darknet-backbone', CORNER_NW, 'backbone', ARRIVE_NE, 0)]);
export const CLOUDNET = subnet('cloudnet', 4, ['cloud', 'cache', 'heap', 'stack'], [2, 3], 40, [gate('cloudnet-backbone', CORNER_NW, 'backbone', ARRIVE_SE, 0)]);

export const SUBNETS: readonly SubnetDef[] = [LO, LAN, DMZ, BACKBONE, DARKNET, CLOUDNET];
/** The subnets one sim process hosts by default (sandbox and kernelspace come with SP6 / SP4). */
export const OPEN_SUBNET_IDS: readonly string[] = SUBNETS.map((s) => s.id);

export function getSubnet(id: string): SubnetDef {
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}

export function getGateway(subnetId: string, gatewayId: string): GatewayDef | undefined {
  return getSubnet(subnetId).gateways.find((g) => g.id === gatewayId);
}
```

- [ ] **Step 3: Verify**

Run: `pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules` — expected: green (6 subnet tests). The sim will not compile until Task 2 gives its test subnet the new fields, which is fine at this point.

- [ ] **Step 4: Commit**

```bash
git add packages/rules
git commit -m "feat(rules): five more subnets with gateways and bestiary-driven spawn tables"
```

---

### Task 2: Multi-world sim and the travel intent

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/runtime/game.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/src/runtime/config.ts`, `apps/sim/src/runtime/main.ts`, `packages/sdk/src/client.ts`
- Tests: create `apps/sim/test/travel.test.ts`, `apps/sim/test/layout.test.ts`; modify `apps/sim/test/helpers.ts`, `apps/sim/test/game.test.ts`, `apps/sim/test/store.test.ts`, `apps/sim/test/integration.test.ts`

**Interfaces:**
- Protocol: command `travel { gatewayId }` (self), event `travelled { from, to }` (private). Ack result `{ subnet }`.
- Model: `OperatorRecord.subnet`, `Operator.travelling`, intent `travel { gatewayId, from, to, x, y }`.
- World: `checkpoint()` includes `subnet`; `hasPendingFor(operatorId)`; `emitCarry(event, scope)`; `completeIntent` handles `travel` (unlock + reply only — the runtime moves the operator).
- Game: `GameOptions.worlds?: World[]` (or `world`), no more `seedId` (each world's own); `game.worlds`, `game.defaultWorld`, `game.world` (= default), `game.worldOf(operatorId)`. Sessions carry `world`; inputs are routed to the sender's world; every world steps each tick; evolve discoveries propagate to all worlds; a committed travel calls `moveOperator`.
- Store: `loadOrCreateOperator` returns `subnet`; `applyIntent('travel')` sets `subnet, x, y`; checkpoints write `subnet`.
- Config: `SUBNETS` (comma list, default all open subnets) replaces `SUBNET`; `main.ts` creates one seed + world per subnet.
- SDK: `client.world.gateways` (static content, nearest first; `[]` for unknown subnet ids), `operator.travel(gatewayId)`.

- [ ] **Step 1: Protocol and SDK**

In `packages/shared/src/protocol.ts` add after the `unhold` command

```ts
  z.object({ cmd: z.literal('travel'), actor: Self, args: z.object({ gatewayId: Id }) }),
```

and after the `discovery` event

```ts
  z.object({ e: z.literal('travelled'), from: z.string(), to: z.string() }),
```

In `packages/sdk/src/client.ts`: import `getSubnet` and `type GatewayDef` from `@daemonet/rules`; add to `WorldView`

```ts
  /** Gateways of the current subnet (static content), nearest first. */
  get gateways(): GatewayDef[] {
    let gateways: readonly GatewayDef[];
    try {
      gateways = getSubnet(this.client.subnet).gateways;
    } catch {
      return [];
    }
    const me = this.origin();
    return [...gateways].sort((a, b) => distance(a.at, me) - distance(b.at, me));
  }
```

and to `OperatorApi`

```ts
  /** Travel through a gateway you are standing on; resolves when the new subnet's snapshot has arrived. */
  travel(gatewayId: string) {
    return this.client.command({ cmd: 'travel', actor: 'self', args: { gatewayId } });
  }
```

- [ ] **Step 2: Test helpers and the failing tests**

In `apps/sim/test/helpers.ts` replace `TEST_SUBNET` with a gateway pair:

```ts
/** 32 x 32 open test subnet: one wall segment, host at (4.5, 4.5), no spawn regions, a gateway to `testb` in the far corner. */
export const TEST_SUBNET: SubnetDef = {
  id: 'test',
  tier: 0,
  width: 32,
  height: 32,
  walls: [{ x: 16, y: 1, w: 1, h: 20 }],
  host: { x: 4.5, y: 4.5 },
  spawn: { x: 5.5, y: 4.5 },
  regions: [],
  gateways: [{ id: 'test-testb', at: { x: 28.5, y: 28.5 }, to: 'testb', arrive: { x: 3.5, y: 3.5 }, requires: { level: 10 } }],
};

/** The other side of the test gateway (same layout, no gate level on the way back). */
export const TEST_SUBNET_B: SubnetDef = {
  ...TEST_SUBNET,
  id: 'testb',
  tier: 1,
  gateways: [{ id: 'testb-test', at: { x: 3.5, y: 3.5 }, to: 'test', arrive: { x: 26.5, y: 28.5 }, requires: { level: 0 } }],
};
```

and add `subnet: 'test',` to the record returned by `operatorRecord` (after `starterClaimed: true,`).

In `apps/sim/test/game.test.ts` and `apps/sim/test/integration.test.ts` drop the `seedId` option from `new Game({...})`; in the integration harness boot two worlds:

```ts
async function boot(store: MemoryStore, seedId: string): Promise<Harness> {
  const discovered = await store.listDiscoveries();
  const world = new World({ subnet: TEST_SUBNET, seed: seedId, seedId, spawner: false, discovered });
  const worldB = new World({ subnet: TEST_SUBNET_B, seed: `${seedId}b`, seedId: `${seedId.slice(0, 7)}b`, spawner: false, discovered });
  const game = new Game({ worlds: [world, worldB], store, verify: createDevVerifier('daemonet-users'), retryDelaysMs: [1, 1, 1] });
```

(import `TEST_SUBNET_B` from the helpers) and add this case before `'another operator cannot capture a daemon tagged by someone else'`:

```ts
  it('travels through a gateway: new subnet snapshot, entities reset, daemons kept, subnet remembered after a restart', async () => {
    const store = new MemoryStore();
    const h = await boot(store, 'aaaa0007');
    const alice = await bot(h.url, 'alice');
    await alice.operator.claimStarter('pingling', 'alice');
    await until(alice, () => alice.self.ram.length === 1);
    placeWild(h.world, 'bitrot', 5, 7.5, 5.5);
    await until(alice, () => alice.world.wild.length === 1);
    const op = h.world.operators.get(alice.operatorId)!;
    const gate = TEST_SUBNET.gateways[0]!;
    op.x = gate.at.x;
    op.y = gate.at.y;
    h.world.daemons.get(op.ram[0]!)!.level = 10;
    await until(alice, () => alice.world.gateways.length === 0 || alice.self.x === gate.at.x);
    const travelled = new Promise((resolve) => alice.on('travelled', resolve));
    await expect(alice.operator.travel(gate.id)).resolves.toMatchObject({ subnet: 'testb' });
    await expect(travelled).resolves.toMatchObject({ from: 'test', to: 'testb' });
    await until(alice, () => alice.subnet === 'testb');
    expect(alice.world.wild.length).toBe(0);
    expect(alice.self.ram).toHaveLength(1);
    expect(alice.self.x).toBe(3.5);

    await h.stop();
    running.splice(running.indexOf(h), 1);
    const h2 = await boot(store, 'bbbb0008');
    const back = await bot(h2.url, 'alice');
    expect(back.subnet).toBe('testb');
  });
```

In `apps/sim/test/store.test.ts` add to the contract (before the evolve case):

```ts
    it('records travel (subnet and position) and reloads it', async () => {
      const a = await store.loadOrCreateOperator('sub-t', 'lo', SPAWN);
      expect(a.subnet).toBe('lo');
      const intent: Intent = { id: 'i-travel', kind: 'travel', operatorId: a.id, reqId: 'r', gatewayId: 'lo-lan', from: 'lo', to: 'lan', x: 5.5, y: 5.5 };
      expect(await store.applyIntent(intent, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.loadOrCreateOperator('sub-t', 'lo', SPAWN)).toMatchObject({ subnet: 'lan', x: 5.5, y: 5.5 });
      const rec = await store.loadOrCreateOperator('sub-t', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, subnet: 'dmz', x: 9, y: 9 }]);
      expect(await store.loadOrCreateOperator('sub-t', 'lo', SPAWN)).toMatchObject({ subnet: 'dmz', x: 9, y: 9 });
    });
```

Create `apps/sim/test/travel.test.ts`:

```ts
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type Intent } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const GATE = TEST_SUBNET.gateways[0]!;

describe('travel command', () => {
  function ready() {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: GATE.at.x, y: GATE.at.y }));
    return world;
  }
  const travel = (world: World, gatewayId = GATE.id) => step(world, input('alice', { cmd: 'travel', actor: self, args: { gatewayId } }));

  it('checks the gateway, the distance, running daemons, the level gate and pending work', () => {
    const world = ready();
    const op = world.operators.get('alice')!;
    expect(travel(world, 'nope').replies[0]).toMatchObject({ code: 'E_INVALID' });
    op.x = GATE.at.x - 3;
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_RANGE' });
    op.x = GATE.at.x;
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'recall running daemons first' });
    world.deactivate(world.daemons.get('alice-d0')!);
    for (const id of op.ram) world.daemons.get(id)!.level = 9;
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'testb needs a level 10 daemon' });
    world.daemons.get('alice-d0')!.level = 10;
    op.captureId = 'c1';
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'a capture is in progress' });
    op.captureId = null;
    const r = travel(world);
    expect(r.replies).toEqual([]);
    expect(r.intents[0]).toMatchObject({ kind: 'travel', operatorId: 'alice', gatewayId: GATE.id, from: 'test', to: 'testb', x: 3.5, y: 3.5 });
    expect(op.travelling).toBe(true);
    // locked while the intent is pending; a second travel is refused as pending work once unlocked
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 10, y: 10 } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'travelling' });
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'db down' });
    expect(op.travelling).toBe(false);
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'db down' });
    const r2 = travel(world);
    expect(world.hasPendingFor('alice')).toBe(true);
    world.completeIntent(r2.intents[0]!.id, { ok: true });
    expect(step(world).replies[0]).toMatchObject({ ok: true, result: { subnet: 'testb' } });
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

function setup(store = new MemoryStore()) {
  const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
  const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false, clock: () => FIXED_CLOCK });
  const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4 });
  return { a, b, game, store };
}

async function join(game: Game, name: string) {
  const conn = new FakeConn();
  game.connect(conn);
  await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
  return conn;
}

let req = 0;
const cmd = (c: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `q${++req}`, ...c } });

describe('multi-world Game', () => {
  it('binds sessions to the operator’s subnet, falling back to the default world for unhosted subnets', async () => {
    const { a, b, game, store } = setup();
    const alice = await join(game, 'alice');
    expect(alice.of('snapshot')[0]!.d.subnet).toBe('test');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join(game, 'bob');
    expect(bob.of('snapshot')[0]!.d.subnet).toBe('testb');
    expect(b.operators.has(rec.id)).toBe(true);
    expect(a.operators.has(rec.id)).toBe(false);
    const rec2 = await store.loadOrCreateOperator('dev-carol', 'test', a.subnet.spawn);
    store.operators.get(rec2.id)!.subnet = 'nowhere';
    const carol = await join(game, 'carol');
    expect(carol.of('snapshot')[0]!.d.subnet).toBe('test');
    expect(carol.of('snapshot')[0]!.d.self).toMatchObject({ x: a.subnet.spawn.x, y: a.subnet.spawn.y });
    // every world ticks
    game.tick();
    expect([a.tick, b.tick]).toEqual([1, 1]);
    expect(alice.of('delta')).toHaveLength(1);
    expect(bob.of('delta')).toHaveLength(1);
  });

  it('hands a travelling operator over to the destination world with a fresh snapshot, and remembers it across a restart', async () => {
    const store = new MemoryStore();
    const { a, b, game } = setup(store);
    const conn = await join(game, 'alice');
    await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice' } }));
    game.tick();
    await game.flush();
    game.tick();
    const op = a.operators.get(conn.of('authOk')[0]!.d.operatorId)!;
    op.x = GATE.at.x;
    op.y = GATE.at.y;
    a.daemons.get(op.ram[0]!)!.level = 10;
    await game.message(conn, cmd({ cmd: 'travel', actor: 'self', args: { gatewayId: GATE.id } }));
    game.tick();
    await game.flush();
    expect(a.operators.has(op.id)).toBe(false);
    expect(b.operators.get(op.id)).toMatchObject({ x: 3.5, y: 3.5 });
    expect(b.operators.get(op.id)!.ram).toEqual(op.ram);
    const snap = conn.of('snapshot').at(-1)!;
    expect(snap.d.subnet).toBe('testb');
    expect(snap.d.self.ram.map((d) => d.id)).toEqual(op.ram);
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { subnet: 'testb' } });
    expect(conn.of('delta').at(-1)!.d.events).toContainEqual({ e: 'travelled', from: 'test', to: 'testb' });
    expect(game.worldOf(op.id)).toBe(b);
    // commands now run in the destination world
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 6, y: 6 } }));
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toEqual({ reqId: `q${req}` });
    expect(b.operators.get(op.id)!.path.length).toBeGreaterThan(0);
    await game.shutdown();

    const again = setup(store);
    const back = await join(again.game, 'alice');
    expect(back.of('snapshot')[0]!.d.subnet).toBe('testb');
    expect(again.b.operators.has(op.id)).toBe(true);
  });
});

describe('store contract: travel', () => {
  it('MemoryStore records the new subnet and position', async () => {
    const store = new MemoryStore();
    const rec = await store.loadOrCreateOperator('sub-t', 'test', { x: 5, y: 5 });
    const intent: Intent = { id: 'i-travel', kind: 'travel', operatorId: rec.id, reqId: 'r', gatewayId: 'g', from: 'test', to: 'testb', x: 3.5, y: 3.5 };
    expect(await store.applyIntent(intent, { seedId: 'aaaa0001' })).toEqual({ ok: true });
    expect(await store.applyIntent(intent, { seedId: 'aaaa0001' })).toEqual({ ok: true });
    expect(await store.loadOrCreateOperator('sub-t', 'test', { x: 5, y: 5 })).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
    void ownedRecord;
  });
});
```

Create `apps/sim/test/layout.test.ts`:

```ts
import { SUBNETS, createRng } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { Grid } from '../src/core/index.js';

/** Every hosted subnet is playable: host, spawn, gateways and regions are walkable and reachable from the host. */
describe('subnet layouts', () => {
  for (const s of SUBNETS) {
    it(`${s.id}: host, spawn, gateways and regions are walkable and connected`, () => {
      const grid = new Grid(s);
      expect(grid.isWalkablePoint(s.host)).toBe(true);
      expect(grid.isWalkablePoint(s.spawn)).toBe(true);
      for (const g of s.gateways) {
        expect(grid.isWalkablePoint(g.at)).toBe(true);
        expect(grid.findPath(s.host, g.at)).not.toBeNull();
      }
      const rng = createRng(`layout:${s.id}`);
      for (const r of s.regions) {
        const p = grid.randomWalkableIn(r.rect, rng);
        expect(p).not.toBeNull();
        expect(grid.findPath(s.host, p!)).not.toBeNull();
      }
    });
  }
});
```

- [ ] **Step 3: Model and world**

In `apps/sim/src/core/model.ts`:

1. `OperatorRecord` gains, after `starterClaimed`:
   ```ts
     /** Subnet the operator was last in (the runtime picks the world). */
     subnet: string;
   ```
2. `Operator` gains, after `pendingClaim`:
   ```ts
     /** Locked by a pending travel intent. */
     travelling: boolean;
   ```
3. Append to the `Intent` union:
   ```ts
     | { id: string; kind: 'travel'; operatorId: string; reqId: string; gatewayId: string; from: string; to: string; x: number; y: number };
   ```

In `apps/sim/src/core/world.ts`:

1. Import `type ScopedEvent` from `./model.js` with the other types.
2. `addOperator` initialises `travelling: false` (after `pendingClaim: false`); `checkpoint()` returns `subnet: this.subnet.id` (after `starterClaimed`).
3. After `trackIntent` add
   ```ts
     hasPendingFor(operatorId: string): boolean {
       for (const i of this.pending.values()) if (i.operatorId === operatorId) return true;
       return false;
     }

     /** Queue an event for the next step (the runtime uses it when it hands an operator over between worlds). */
     emitCarry(event: ScopedEvent['event'], scope: { to: string } | { at: Point | null }): void {
       this.carry.emit(event, scope);
     }
   ```
4. In `completeIntent`, after the `evolve` case:
   ```ts
         case 'travel':
           op.travelling = false;
           if (!result.ok) return out.fail(intent, 'E_STATE', result.reason);
           return out.ok(intent, { subnet: intent.to });
   ```

- [ ] **Step 4: The travel command**

In `apps/sim/src/core/systems/commands.ts`: import `GATEWAY_RADIUS` from `@daemonet/rules`; after the starter check in `handle` add `if (op.travelling) throw new Rejection('E_STATE', 'travelling');`; add `case 'travel': return travel(world, op, c, input, out);` after the `evolve` case; and add the handler before `bitFlip`:

```ts
/**
 * Travel through a gateway (SP3b spec §4.2): within GATEWAY_RADIUS of it, nothing running, no open capture,
 * nothing pending, and the best daemon in RAM at the gate level. The move itself happens once the store has
 * recorded the new subnet (the runtime hands the operator to the destination world).
 */
function travel(world: World, op: Operator, c: Cmd<'travel'>, input: Input, out: Out): void {
  const gate = world.subnet.gateways.find((g) => g.id === c.args.gatewayId);
  if (!gate) throw new Rejection('E_INVALID', `no gateway ${c.args.gatewayId} in ${world.subnet.id}`);
  if (distance(op, gate.at) > GATEWAY_RADIUS) throw new Rejection('E_RANGE', 'move onto the gateway first');
  if (op.running.length > 0) throw new Rejection('E_STATE', 'recall running daemons first');
  if (op.captureId) throw new Rejection('E_STATE', 'a capture is in progress');
  if (world.hasPendingFor(op.id)) throw new Rejection('E_STATE', 'wait for pending actions');
  const best = Math.max(0, ...op.ram.map((id) => world.daemons.get(id)!.level));
  if (best < gate.requires.level) throw new Rejection('E_STATE', `${gate.to} needs a level ${gate.requires.level} daemon`);
  op.travelling = true;
  op.path = [];
  op.restoreUntil = null;
  world.trackIntent(
    { id: world.newId('i'), kind: 'travel', operatorId: op.id, reqId: input.reqId, gatewayId: gate.id, from: world.subnet.id, to: gate.to, x: gate.arrive.x, y: gate.arrive.y },
    out,
  );
}
```

- [ ] **Step 5: Stores**

`apps/sim/src/runtime/store.ts` (MemoryStore): `MemOperator` gains `subnet: string`; `loadOrCreateOperator(sub, subnet, spawn)` creates with `subnet` and returns `subnet: op.subnet`; `applyIntent` gains

```ts
      case 'travel':
        Object.assign(op, { subnet: intent.to, x: intent.x, y: intent.y });
        break;
```

and `checkpoint` assigns `subnet: rec.subnet` along with `x, y, bits, inventory`.

`apps/sim/src/runtime/prisma-store.ts`: `loadOrCreateOperator` returns `subnet: op.subnet`; `applyIntent` gains

```ts
          case 'travel': {
            await tx.operator.update({ where: { id: intent.operatorId }, data: { subnet: intent.to, x: intent.x, y: intent.y } });
            return { ok: true } as const;
          }
```

and `checkpoint` writes `subnet: rec.subnet` in the operator update.

- [ ] **Step 6: The multi-world Game**

Replace `apps/sim/src/runtime/game.ts`:

```ts
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, toSelf, type Input, type Intent, type IntentResult, type World } from '../core/index.js';
import type { TokenVerifier } from './auth.js';
import { diffEntities } from './interest.js';
import { randomHex, type Store } from './store.js';

/** Transport-independent connection. */
export interface Conn {
  readonly id: string;
  readonly ip: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

export const CLOSE = { auth: 4401, takeover: 4409, rate: 4429, timeout: 4408, unavailable: 4503, left: 4410 } as const;

export interface GameOptions {
  /** One world per hosted subnet; the first is the default (new operators, unknown subnets). */
  worlds?: readonly World[];
  /** Shorthand for a single world. */
  world?: World;
  store: Store;
  verify: TokenVerifier;
  log?: Logger;
  /** Waits between intent persistence attempts (default 128/512/2048 ms). */
  retryDelaysMs?: readonly number[];
  checkpointEveryTicks?: number;
  leaveAfterTicks?: number;
  authTimeoutTicks?: number;
  idleTimeoutTicks?: number;
  maxSpectators?: number;
}

type Role = 'controller' | 'spectator';

interface ConnState {
  conn: Conn;
  seq: number;
  phase: 'new' | 'authing' | 'ready' | 'closed';
  openedTick: number;
  lastSeenTick: number;
  bucket: number;
  sub: string | null;
  operatorId: string | null;
  role: Role | null;
  known: Map<string, Entity>;
  lastSelf: string | null;
}

interface Session {
  operatorId: string;
  sub: string;
  /** The world the operator is in right now (changes on travel). */
  world: World;
  controller: ConnState | null;
  spectators: Set<ConnState>;
  resumeToken: string;
  /** Deltas sent to the controller, for resume. */
  buffer: Array<{ tick: number; msg: Extract<ServerMessage, { t: 'delta' }> }>;
  /** Oldest client tick a resume can continue from (the snapshot tick, or just before the oldest buffered delta). */
  baseTick: number;
  /** What the last controller knew when it went away (resume continues from here). */
  savedKnown: Map<string, Entity> | null;
  savedSelf: string | null;
  commandsThisTick: number;
  violations: number[];
  leaveAtTick: number | null;
}

const BUCKET_MAX = 64;
const BUCKET_REFILL_PER_TICK = 2;
const VIOLATION_WINDOW_TICKS = 1024;
const MAX_VIOLATIONS = 256;
const SLOW_TICK_MS = 50;
const RECOVERED_TICK_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Game {
  /** Hosted worlds by subnet id; all tick in lockstep. */
  readonly worlds: Map<string, World>;
  readonly defaultWorld: World;
  /** The single world (tests, and callers that host one subnet). */
  readonly world: World;
  private readonly store: Store;
  private readonly verify: TokenVerifier;
  private readonly log: Logger;
  private readonly retryDelays: readonly number[];
  private readonly checkpointEvery: number;
  private readonly leaveAfter: number;
  private readonly authTimeout: number;
  private readonly idleTimeout: number;
  private readonly maxSpectators: number;
  private readonly conns = new Map<string, ConnState>();
  private readonly sessions = new Map<string, Session>();
  private readonly leaving = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();
  private inputs: Input[] = [];
  private radius = INTEREST_RADIUS;
  private readonly tickMs: number[] = [];
  /** Game ticks so far (every world advances once per game tick). */
  private ticks = 0;

  constructor(opts: GameOptions) {
    const worlds = opts.worlds ?? (opts.world ? [opts.world] : []);
    if (worlds.length === 0) throw new Error('Game needs at least one world');
    this.worlds = new Map(worlds.map((w) => [w.subnet.id, w]));
    this.defaultWorld = worlds[0]!;
    this.world = this.defaultWorld;
    this.store = opts.store;
    this.verify = opts.verify;
    this.log = opts.log ?? silent;
    this.retryDelays = opts.retryDelaysMs ?? [128, 512, 2048];
    this.checkpointEvery = opts.checkpointEveryTicks ?? 512;
    this.leaveAfter = opts.leaveAfterTicks ?? 128;
    this.authTimeout = opts.authTimeoutTicks ?? 80;
    this.idleTimeout = opts.idleTimeoutTicks ?? 768;
    this.maxSpectators = opts.maxSpectators ?? 4;
  }

  /** The world an operator is in, if connected. */
  worldOf(operatorId: string): World | undefined {
    return this.sessions.get(operatorId)?.world;
  }

  // ---- connections ----

  connect(conn: Conn): void {
    const t = this.ticks;
    this.conns.set(conn.id, {
      conn, seq: 0, phase: 'new', openedTick: t, lastSeenTick: t, bucket: BUCKET_MAX,
      sub: null, operatorId: null, role: null, known: new Map(), lastSelf: null,
    });
  }

  disconnect(conn: Conn): void {
    const st = this.conns.get(conn.id);
    if (!st) return;
    this.detach(st);
  }

  async message(conn: Conn, raw: string): Promise<void> {
    const st = this.conns.get(conn.id);
    if (!st || st.phase === 'closed') return;
    st.lastSeenTick = this.ticks;
    if (--st.bucket < 0) {
      st.bucket = 0;
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_RATE', message: 'too many messages' } });
      this.violation(st);
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_INVALID', message: parsed.message } });
      if (st.phase === 'new') this.kick(st, 'auth required', CLOSE.auth);
      return;
    }
    const msg = parsed.message;
    if (st.phase === 'new') {
      if (msg.t !== 'auth') return this.kick(st, 'auth required', CLOSE.auth);
      st.phase = 'authing';
      return this.authenticate(st, msg.d);
    }
    if (st.phase !== 'ready') return;
    switch (msg.t) {
      case 'auth':
        return this.error(st, 'E_STATE', 'already authenticated');
      case 'ping':
        return this.send(st, { t: 'pong', seq: 0, d: {} });
      case 'reauth':
        return this.reauth(st, msg.d.token);
      case 'cmd':
        return this.command(st, msg.d);
    }
  }

  private async authenticate(st: ConnState, d: Extract<ClientMessage, { t: 'auth' }>['d']): Promise<void> {
    let claims;
    try {
      claims = await this.verify(d.token);
    } catch (err) {
      this.error(st, 'E_AUTH', (err as Error).message);
      return this.kick(st, 'unauthorized', CLOSE.auth);
    }
    try {
      await this.leaving.get(claims.sub);
      const home = this.defaultWorld.subnet;
      const rec = await this.store.loadOrCreateOperator(claims.sub, home.id, home.spawn);
      if (st.phase === 'closed') return;
      let session = this.sessions.get(rec.id);
      if (!session) {
        // An operator whose subnet this process does not host starts over at the default host.
        let world = this.worlds.get(rec.subnet);
        if (!world) {
          world = this.defaultWorld;
          rec.subnet = home.id;
          rec.x = home.spawn.x;
          rec.y = home.spawn.y;
        }
        if (!world.operators.has(rec.id)) world.addOperator(rec);
        session = {
          operatorId: rec.id, sub: claims.sub, world, controller: null, spectators: new Set(), resumeToken: randomHex(16), buffer: [], baseTick: world.tick,
          savedKnown: null, savedSelf: null, commandsThisTick: 0, violations: [], leaveAtTick: null,
        };
        this.sessions.set(rec.id, session);
      }
      st.sub = claims.sub;
      st.operatorId = rec.id;
      if (d.role === 'spectator') {
        if (session.spectators.size >= this.maxSpectators) {
          this.error(st, 'E_STATE', 'too many spectators');
          return this.kick(st, 'too many spectators', CLOSE.rate);
        }
        st.role = 'spectator';
        session.spectators.add(st);
      } else {
        const old = session.controller;
        if (old) {
          session.savedKnown = old.known;
          session.savedSelf = old.lastSelf;
          session.controller = null;
          this.kick(old, 'takeover', CLOSE.takeover);
        }
        st.role = 'controller';
        session.controller = st;
      }
      session.leaveAtTick = null;
      st.phase = 'ready';
      this.send(st, { t: 'authOk', seq: 0, d: { operatorId: rec.id, role: st.role, resumeToken: session.resumeToken, tick: session.world.tick } });
      if (!(st.role === 'controller' && this.tryResume(st, session, d.resumeToken, d.lastTick))) this.snapshot(st);
      this.log.info({ sub: claims.sub, role: st.role, ip: st.conn.ip, subnet: session.world.subnet.id }, 'operator connected');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'auth: store unavailable');
      this.error(st, 'E_STATE', 'service unavailable');
      this.kick(st, 'unavailable', CLOSE.unavailable);
    }
  }

  private tryResume(st: ConnState, session: Session, token: string | undefined, lastTick: number | undefined): boolean {
    if (token !== session.resumeToken || lastTick === undefined || !session.savedKnown) return false;
    if (lastTick < session.baseTick || lastTick > session.world.tick) return false;
    st.known = new Map(session.savedKnown);
    st.lastSelf = session.savedSelf;
    for (const entry of session.buffer) if (entry.tick > lastTick) this.send(st, entry.msg);
    return true;
  }

  private snapshot(st: ConnState): void {
    const session = this.sessions.get(st.operatorId!)!;
    const world = session.world;
    const op = world.operators.get(st.operatorId!)!;
    if (st.role === 'controller') {
      session.buffer = [];
      session.baseTick = world.tick;
    }
    const entities = entitiesNear(world, op.x, op.y, this.radius);
    const self = toSelf(world, op);
    st.known = new Map(entities.map((e) => [e.id, e]));
    st.lastSelf = JSON.stringify(self);
    this.send(st, { t: 'snapshot', seq: 0, d: { tick: world.tick, subnet: world.subnet.id, self, entities } });
  }

  private async reauth(st: ConnState, token: string): Promise<void> {
    try {
      const claims = await this.verify(token);
      if (claims.sub !== st.sub) throw new Error('token belongs to a different account');
    } catch (err) {
      this.error(st, 'E_AUTH', (err as Error).message);
      this.kick(st, 'unauthorized', CLOSE.auth);
    }
  }

  private command(st: ConnState, d: Extract<ClientMessage, { t: 'cmd' }>['d']): void {
    const { reqId, ...command } = d;
    if (st.role !== 'controller') return this.error(st, 'E_STATE', 'spectators cannot send commands', reqId);
    const session = this.sessions.get(st.operatorId!)!;
    if (session.commandsThisTick >= COMMANDS_PER_TICK) {
      this.error(st, 'E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`, reqId);
      return this.violation(st);
    }
    session.commandsThisTick++;
    this.inputs.push({ operatorId: session.operatorId, reqId, command });
  }

  private violation(st: ConnState): void {
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    const now = this.ticks;
    session.violations = session.violations.filter((t) => now - t < VIOLATION_WINDOW_TICKS);
    session.violations.push(now);
    if (session.violations.length > MAX_VIOLATIONS) this.kick(st, 'rate limit', CLOSE.rate);
  }

  private send(st: ConnState, msg: ServerMessage): void {
    if (st.phase === 'closed') return;
    st.conn.send({ ...msg, seq: ++st.seq } as ServerMessage);
  }

  private error(st: ConnState, code: ErrorCode, message: string, reqId?: string): void {
    this.send(st, { t: 'err', seq: 0, d: reqId === undefined ? { code, message } : { reqId, code, message } });
  }

  private kick(st: ConnState, reason: string, code: number): void {
    if (st.phase === 'closed') return;
    this.send(st, { t: 'kick', seq: 0, d: { reason } });
    st.conn.close(code, reason);
    this.detach(st);
  }

  private detach(st: ConnState): void {
    if (st.phase === 'closed' && !this.conns.has(st.conn.id)) return;
    st.phase = 'closed';
    this.conns.delete(st.conn.id);
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    session.spectators.delete(st);
    if (session.controller === st) {
      session.controller = null;
      session.savedKnown = st.known;
      session.savedSelf = st.lastSelf;
      session.leaveAtTick = this.ticks + this.leaveAfter;
    }
  }

  // ---- the tick ----

  tick(): void {
    const t0 = performance.now();
    this.ticks++;
    for (const st of [...this.conns.values()]) {
      st.bucket = Math.min(BUCKET_MAX, st.bucket + BUCKET_REFILL_PER_TICK);
      if (st.phase !== 'ready' && this.ticks - st.openedTick > this.authTimeout) this.kick(st, 'auth timeout', CLOSE.timeout);
      else if (st.phase === 'ready' && this.ticks - st.lastSeenTick > this.idleTimeout) this.kick(st, 'idle', CLOSE.timeout);
    }

    const inputsByWorld = new Map<World, Input[]>();
    for (const input of this.inputs) {
      const world = this.sessions.get(input.operatorId)?.world;
      if (!world) continue;
      let list = inputsByWorld.get(world);
      if (!list) inputsByWorld.set(world, (list = []));
      list.push(input);
    }
    this.inputs = [];
    for (const s of this.sessions.values()) s.commandsThisTick = 0;

    for (const world of this.worlds.values()) this.stepWorld(world, inputsByWorld.get(world) ?? []);

    if (this.ticks % this.checkpointEvery === 0) this.checkpointAll();
    for (const session of [...this.sessions.values()]) {
      if (!session.controller && session.leaveAtTick !== null && session.leaveAtTick <= this.ticks) this.leave(session);
    }

    const ms = performance.now() - t0;
    this.tickMs.push(ms);
    if (this.tickMs.length > 1024) this.tickMs.shift();
    const recent = this.tickMs.slice(-16);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > SLOW_TICK_MS && this.radius !== INTEREST_RADIUS / 2) {
      this.radius = INTEREST_RADIUS / 2;
      this.log.warn({ avgMs: avg }, 'slow ticks: shrinking interest radius');
    } else if (avg < RECOVERED_TICK_MS) {
      this.radius = INTEREST_RADIUS;
    }
  }

  private stepWorld(world: World, inputs: Input[]): void {
    const result = world.step(inputs);

    for (const r of result.replies) {
      const st = this.sessions.get(r.operatorId)?.controller;
      if (!st) continue;
      if (r.ok) this.send(st, { t: 'ack', seq: 0, d: r.result === undefined ? { reqId: r.reqId } : { reqId: r.reqId, result: r.result } });
      else this.error(st, r.code, r.message, r.reqId);
    }
    for (const intent of result.intents) this.persist(world, intent);

    for (const session of this.sessions.values()) {
      if (session.world !== world) continue;
      const op = world.operators.get(session.operatorId);
      if (!op) continue;
      const events = result.events
        .filter((e) => (e.to === null ? e.at === null || distance(e.at, op) <= this.radius : e.to === op.id))
        .map((e) => e.event);
      const near = entitiesNear(world, op.x, op.y, this.radius);
      const self = toSelf(world, op);
      const selfJson = JSON.stringify(self);
      const targets = session.controller ? [session.controller, ...session.spectators] : [...session.spectators];
      for (const st of targets) {
        const { upserts, removes } = diffEntities(st.known, near);
        const selfChanged = selfJson !== st.lastSelf;
        st.lastSelf = selfJson;
        const msg: Extract<ServerMessage, { t: 'delta' }> = {
          t: 'delta', seq: 0, d: selfChanged ? { tick: result.tick, upserts, removes, events, self } : { tick: result.tick, upserts, removes, events },
        };
        this.send(st, msg);
        if (st === session.controller) {
          session.buffer.push({ tick: result.tick, msg });
          if (session.buffer.length > RESUME_TICKS) session.baseTick = session.buffer.shift()!.tick;
        }
      }
    }
  }

  private leave(session: Session): void {
    const world = session.world;
    const record = world.checkpoint(session.operatorId);
    world.removeOperator(session.operatorId);
    this.sessions.delete(session.operatorId);
    for (const st of [...session.spectators]) this.kick(st, 'operator left', CLOSE.left);
    const done = this.store
      .checkpoint([record])
      .catch((err: Error) => this.log.error({ sub: session.sub, err: err.message }, 'leave checkpoint failed'))
      .finally(() => this.leaving.delete(session.sub));
    this.leaving.set(session.sub, done);
    this.track(done);
    this.log.info({ sub: session.sub }, 'operator left');
  }

  private checkpointAll(): void {
    const records = [...this.sessions.values()].filter((s) => s.world.operators.has(s.operatorId)).map((s) => s.world.checkpoint(s.operatorId));
    this.track(this.store.checkpoint(records).catch((err: Error) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  /** A committed travel intent: hand the operator from its world to the destination and start it with a fresh snapshot. */
  private moveOperator(from: World, intent: Extract<Intent, { kind: 'travel' }>): void {
    const session = this.sessions.get(intent.operatorId);
    const to = this.worlds.get(intent.to);
    if (!session || session.world !== from || !to || !from.operators.has(intent.operatorId)) return;
    const record = from.checkpoint(intent.operatorId);
    from.removeOperator(intent.operatorId);
    to.addOperator({ ...record, subnet: to.subnet.id, x: intent.x, y: intent.y });
    session.world = to;
    to.emitCarry({ e: 'travelled', from: intent.from, to: intent.to }, { to: intent.operatorId });
    for (const st of session.controller ? [session.controller, ...session.spectators] : [...session.spectators]) this.snapshot(st);
    this.log.info({ sub: session.sub, from: intent.from, to: intent.to }, 'operator travelled');
  }

  private persist(world: World, intent: Intent): void {
    const stored = intent.kind === 'store' ? world.daemons.get(intent.daemonId) : undefined;
    const ctx = { seedId: world.seedId, ...(stored ? { storedDaemon: world.toRecord(stored) } : {}) };
    const run = async () => {
      let result: IntentResult = { ok: false, reason: 'persist failed' };
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        try {
          result = await this.store.applyIntent(intent, ctx);
          break;
        } catch (err) {
          this.log.warn({ intent: intent.id, attempt, err: (err as Error).message }, 'intent persist failed');
          const delay = this.retryDelays[attempt];
          if (delay === undefined) break;
          await sleep(delay);
        }
      }
      world.completeIntent(intent.id, result);
      if (intent.kind === 'evolve' && result.ok && result.discovered) for (const w of this.worlds.values()) w.discovered.add(intent.to);
      if (intent.kind === 'travel' && result.ok) this.moveOperator(world, intent);
    };
    this.track(run());
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => {},
      () => {},
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  /** Resolves when all in-flight persistence has settled. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Checkpoint everyone and wait for persistence. */
  async shutdown(): Promise<void> {
    for (const st of [...this.conns.values()]) this.kick(st, 'server shutting down', 1001);
    this.checkpointAll();
    await this.flush();
  }

  stats(): { p50: number; p99: number; max: number; radius: number } {
    const sorted = [...this.tickMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0, radius: this.radius };
  }
}
```

- [ ] **Step 7: Config and main**

In `apps/sim/src/runtime/config.ts`: import `OPEN_SUBNET_IDS` from `@daemonet/rules`; replace `SUBNET` with

```ts
  /** Comma-separated subnet ids this process hosts (default: every open subnet). */
  SUBNETS: z.string().default(OPEN_SUBNET_IDS.join(',')),
```

`Config.subnet: string` becomes `subnets: string[]`, filled with `e.SUBNETS.split(',').map((s) => s.trim()).filter(Boolean)`.

In `apps/sim/src/runtime/main.ts` build one world per subnet:

```ts
const discovered = await store.listDiscoveries();
const worlds: World[] = [];
for (const id of config.subnets) {
  const subnet = getSubnet(id);
  const seed = await store.createSeed(subnet.id);
  worlds.push(new World({ subnet, seed: seed.seed, seedId: seed.id, discovered }));
}
```

then `const game = new Game({ worlds, store, verify, log });`, the stats timer reads `game.world.tick`, and the start log reports `subnets: worlds.map((w) => \`${w.subnet.id}:${w.seedId}\`)`.

In `scripts/provision-secrets.sh` the seeded Vault document sets the sim's subnet list: replace `"SUBNET": "lo",` with `"SUBNETS": "lo,lan,dmz,backbone,darknet,cloudnet",` (existing deployments: `vault kv patch secret/daemonet SUBNETS=lo,lan,dmz,backbone,darknet,cloudnet` on LC3, then `fetch-secrets.sh` and restart the sim — see OPERATIONS.md "Change a secret").

- [ ] **Step 8: Verify**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 30 files, 298 tests (six layouts walk, the travel guards, the two-world Game, the SDK travel round trip with a restart).

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/sdk apps/sim scripts/provision-secrets.sh
git commit -m "feat(sim): one world per subnet, gateway travel intent with world hand-off"
```

---

### Task 3: Client — gateways on the map, travel button, subnet in the top bar

**Files:**
- Modify: `apps/frontend/src/render/draw.ts`, `apps/frontend/src/panels/PlayPanel.tsx`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/panels/RamPanel.tsx`, `apps/frontend/src/panels/DiskPanel.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`

- [ ] **Step 1: Map and top bar**

In `apps/frontend/src/render/draw.ts` add `gateway: '#38bdf8',` to `COLORS` and, right after the host label is drawn:

```ts
  for (const g of def.gateways) {
    const p = worldToScreen(cam, g.at.x, g.at.y);
    ctx.strokeStyle = COLORS.gateway;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = COLORS.gateway;
    ctx.fillText(`→ ${g.to}${g.requires.level ? ` L${g.requires.level}` : ''}`, p.sx + s + 2, p.sy + 4);
  }
```

In `apps/frontend/src/components/TopBar.tsx` show the subnet before the tick:

```tsx
        <span data-testid="subnet">{client?.subnet ?? '—'}</span> · tick <span data-testid="tick">{client?.tick ?? 0}</span> · bits {client?.self?.bits ?? me.bits}
```

- [ ] **Step 2: Host proximity from content**

`RamPanel` and `DiskPanel` hard-coded `lo`'s host. In `apps/frontend/src/panels/RamPanel.tsx` import `getSubnet` from `@daemonet/rules`, add before `RamPanel`

```ts
/** Within 2 tiles of the subnet's host (unknown subnet ids, as in tests, count as never at the host). */
export function nearHost(subnet: string, me: { x: number; y: number }): boolean {
  try {
    const host = getSubnet(subnet).host;
    return Math.hypot(me.x - host.x, me.y - host.y) <= 2;
  } catch {
    return false;
  }
}
```

and use `const atHost = nearHost(client.subnet, me);` in both panels (`DiskPanel` imports `nearHost` from `./RamPanel.tsx`).

- [ ] **Step 3: Travel button**

In `apps/frontend/src/panels/PlayPanel.tsx` import `GATEWAY_RADIUS` from `@daemonet/rules` and render, after `{me.capture && <CapturePanel client={client} />}`:

```tsx
      {client.world.gateways.filter((g) => Math.hypot(g.at.x - me.x, g.at.y - me.y) <= GATEWAY_RADIUS).map((g) => (
        <section key={g.id} className="rounded border border-sky-700 p-2" data-testid={`gateway-${g.id}`}>
          <div>
            gateway to <span className="font-medium">{g.to}</span>
            {g.requires.level > 0 && <span className="text-neutral-500"> · needs a level {g.requires.level} daemon</span>}
          </div>
          <button
            className="mt-1 rounded bg-sky-700 px-2 py-0.5 hover:bg-sky-600 disabled:opacity-40"
            disabled={!manual || me.running.length > 0 || !!me.capture}
            onClick={() => run(client.operator.travel(g.id), 'travel')}
            data-testid={`travel-${g.id}`}
          >
            travel {me.running.length > 0 ? '(recall first)' : ''}
          </button>
        </section>
      ))}
```

In `apps/frontend/src/game/connection.ts` log arrivals after the `discovery` handler:

```ts
    client.on('travelled', (e) => log.push('event', `travelled ${e.from} -> ${e.to}`));
```

In `apps/frontend/src/sdk-types.ts`: add `subnet: string;` to `GameClient` (after `operatorId`), a `GatewayDef` interface and `readonly gateways: GatewayDef[]` on `WorldView`, `travel(gatewayId: string): Promise<unknown>;` on `OperatorApi`, and the overload `on(name: 'travelled', handler: (ev: { from: string; to: string }) => void): () => void;`:

```ts
  export interface GatewayDef { id: string; at: Positioned; to: string; arrive: Positioned; requires: { level: number } }
  export class WorldView { readonly daemons: Query<DaemonView>; readonly wild: Query<DaemonView>; readonly operators: Query<OperatorEntity>; readonly gateways: GatewayDef[]; get(id: string): unknown }
```

- [ ] **Step 4: Verify**

`pnpm exec tsc -b && pnpm exec eslint . && pnpm -r build`, then boot the stack (sim with the default `SUBNETS`, api, `vite preview`) and in the browser: dev login, claim, zoom out — the `lo` map shows the gateway ring in the far corner labelled `→ lan L8`; the top bar shows `lo`. Walking a level-8 daemon there (dev-seed one with `POST /api/dev/daemon`, load it at the host, walk ≈150 tiles) and pressing **travel** switches the map to `lan`, the log reads `travelled lo -> lan`, and the RAM tab still lists the daemons. The Playwright smoke is unchanged and still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): gateways on the map, travel button, subnet in the top bar"
```

---

## Self-review

- **Spec coverage:** §4.1 content (six subnets, gateways, tiers, spawn tables spreading evolved forms, capstones never wild — Task 1); §4.2 one process / many worlds, session binding, `travel` guards, intent, hand-off with snapshot, per-world seeds (Task 2); §4.3 protocol, SDK `gateways` / `travel`, client map + button + top bar (Tasks 2–3). Deployment: only `scripts/provision-secrets.sh` set `SUBNET`; it now seeds `SUBNETS` with all six (Task 2 step 7), and the compose file / workflows pass the environment through unchanged.
- **Type consistency:** `GatewayDef` is defined once in rules and re-exported through the SDK; `OperatorRecord.subnet` flows store → world → checkpoint → store; `travel` intent fields match between commands, both stores and `moveOperator`.
- **Placeholders:** none.
