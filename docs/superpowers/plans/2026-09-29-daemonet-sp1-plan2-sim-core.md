# Daemonet SP1 · Plan 2 — Sim Core (deterministic world) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/sim/src/core` — a deterministic, I/O-free `World` that steps the `lo` subnet at 16 Hz: pathfinding, operator commands, running daemons, wild AI, real-time combat, capture challenges, spawning, XP, and durable *intents* that the runtime (Plan 3) persists before their effects are announced.

**Architecture:** `World.step(inputs)` advances one tick and returns `{ tick, events, replies, intents }`. Systems run in the SP1 spec order (commands → movement → wild AI → move execution → defeats → captures → spawner → upkeep). All randomness comes from the world's seeded `Rng`, all time is the integer tick, and nothing in `core/` touches sockets, the database or the clock — so a seed plus the input log replays exactly. Effects that must survive a crash (claim starter, capture, store, load) are emitted as intents; the runtime calls `world.completeIntent(id, result)` after the DB commit and the result is delivered on the next step.

**Tech Stack:** as Plan 1 (Node 24, pnpm 10.33.2, TypeScript ~6.0.3, Vitest ^4.1.11, fast-check, zod).

**Prerequisite:** Plan 1 complete (`@daemonet/rules`, `@daemonet/shared`, CI green).

**Specs:** SP1 spec §3–§6 and game design §6, §8, §9.

## Global Constraints

- Everything from Plan 1's Global Constraints still applies (Node 24, pnpm 10.33.2, TypeScript ~6.0.3, ESM/NodeNext, LF, private repo).
- `apps/sim/src/core/**` is pure: no `Date`, `performance`, `Math.random`, timers, sockets, filesystem or DB. Time = `world.tick` (16 Hz); randomness = `world.rng`.
- Map iteration order is insertion order; never iterate a `Set`/`Map` built from unordered sources when the result affects the RNG or events.
- Owned daemons only ever hit wild daemons (no open-world PvP). Wild daemons hit only the side they are fighting (the running daemons and operator of their aggro target's owner).
- Effects persisted through intents: `claimStarter`, `capture`, `store`, `load`. XP, levels, HP, energy, inventory and position are persisted by the 32 s checkpoint (Plan 3).
- Tests import reference solvers from `packages/rules/test/solvers.ts`; nothing under `src/` may.
- Base-2 constants: RAM 8 / running 2, Disk 256, swap 4096 ms, tag 8192 ms, hardened 8192 ms, leash 8 tiles, follow 3 tiles, aggro 6 tiles, interest radius 32 tiles, path cap 256 tiles, respawn 4096 ms, region cap 16, restore channel 2048 ms, host radius 2 tiles, starter level 5.

## File map

```
packages/rules/src/content/subnets.ts     Rect, RegionDef, SubnetDef, LO, getSubnet
packages/rules/test/subnets.test.ts
eslint.config.js                          + argsIgnorePattern '^_'
apps/sim/package.json, apps/sim/tsconfig.json, tsconfig.json (+ apps/sim reference)
apps/sim/src/core/
  index.ts        public exports of the core
  grid.ts         Grid (walls, A*), Point, distance
  model.ts        Daemon, Operator, Capture, Intent, Input, Reply, ScopedEvent, StepResult, Rejection, records
  out.ts          Out: collects events/replies/intents
  world.ts        World: state, operators, daemons, intents, step()
  view.ts         Entity / RamDaemon / OperatorSelf views, entitiesNear
  systems/commands.ts   command handling
  systems/movement.ts   paths, following, leash
  systems/combat.ts     move execution (player and wild)
  systems/ai.ts         wild behaviour
  systems/progress.ts   defeats, crashes, XP and levels
  systems/capture.ts    capture start/submit/progress/commit
  systems/spawner.ts    region spawning
  systems/upkeep.ts     energy, statuses, tag expiry, restoreAll
apps/sim/test/helpers.ts + grid, view, commands, combat, capture, world tests
```

---

### Task 1: The `lo` subnet

**Files:**
- Create: `packages/rules/src/content/subnets.ts`, `packages/rules/test/subnets.test.ts`
- Modify: `packages/rules/src/index.ts`, `eslint.config.js`

**Interfaces:**
- Produces (from `@daemonet/rules`): `interface Rect { x; y; w; h }`, `interface RegionDef { name; rect; levels: readonly [number, number]; species: Record<string, number>; cap; respawnMs }`, `interface SubnetDef { id; width; height; walls; host; spawn; regions }`, `LO`, `SUBNETS`, `getSubnet(id)`.

The subnet is typed TypeScript data (wall rectangles + regions) rather than a JSON tile file; the outer border is always blocked.

- [ ] **Step 1: Write the failing test**

`packages/rules/test/subnets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/content/species.js';
import { LO, getSubnet } from '../src/content/subnets.js';

const inside = (r: { x: number; y: number; w: number; h: number }, w: number, h: number) =>
  r.x >= 1 && r.y >= 1 && r.x + r.w <= w - 1 && r.y + r.h <= h - 1;

describe('subnets', () => {
  it('lo is 128 x 128 with four regions of rising level', () => {
    expect(getSubnet('lo')).toBe(LO);
    expect(LO.width).toBe(128);
    expect(LO.regions.map((r) => r.levels)).toEqual([[2, 6], [5, 10], [9, 16], [14, 24]]);
    expect(() => getSubnet('dmz')).toThrow(RangeError);
  });

  it('keeps walls and regions inside the border and references real species', () => {
    for (const wall of LO.walls) expect(inside(wall, LO.width, LO.height)).toBe(true);
    for (const region of LO.regions) {
      expect(inside(region.rect, LO.width, LO.height)).toBe(true);
      expect(region.cap).toBe(16);
      for (const id of Object.keys(region.species)) expect(() => getSpecies(id)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/subnets.test.ts`
Expected: FAIL — cannot resolve `../src/content/subnets.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/content/subnets.ts`:

```ts
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

/** SP1's only subnet: 128 x 128, one host, four spawn regions of rising level. */
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
    { name: 'lobby', rect: { x: 24, y: 8, w: 32, h: 36 }, levels: [2, 6], species: { pingling: 3, hashling: 3, glitchmite: 2, nullpup: 2 }, cap: 16, respawnMs: 4096 },
    { name: 'uplink', rect: { x: 72, y: 8, w: 48, h: 40 }, levels: [5, 10], species: { floodhound: 3, cipherbat: 3, pingling: 1, hashling: 1 }, cap: 16, respawnMs: 4096 },
    { name: 'cache', rect: { x: 8, y: 64, w: 48, h: 56 }, levels: [9, 16], species: { bitrot: 3, voidlet: 3, glitchmite: 1, nullpup: 1 }, cap: 16, respawnMs: 4096 },
    { name: 'core', rect: { x: 72, y: 64, w: 48, h: 56 }, levels: [14, 24], species: { floodhound: 2, cipherbat: 2, bitrot: 2, voidlet: 2 }, cap: 16, respawnMs: 4096 },
  ],
};

export const SUBNETS: readonly SubnetDef[] = [LO];

export function getSubnet(id: string): SubnetDef {
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}
```

In `packages/rules/src/index.ts`, add after the `items.js` export:

```ts
export * from './content/subnets.js';
```

- [ ] **Step 4: Allow `_`-prefixed unused parameters (used by Task 3's stubs)**

Replace `eslint.config.js` with:

```js
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(rules): lo subnet"
```

---

### Task 2: Grid and A* pathfinding

**Files:**
- Create: `apps/sim/package.json`, `apps/sim/tsconfig.json`, `apps/sim/src/core/grid.ts`
- Modify: `tsconfig.json` (add the `apps/sim` reference)
- Test: `apps/sim/test/grid.test.ts`, `apps/sim/test/helpers.ts` (partial — full file in Task 3)

**Interfaces:**
- Produces: `interface Point { x; y }`, `distance(a, b)`, `MAX_PATH_TILES = 256`, `class Grid { width; height; constructor(def: SubnetDef); isWalkableTile(tx, ty); isWalkablePoint(p); findPath(from, to): Point[] | null; randomWalkableIn(rect, rng, tries = 64): Point | null }`.
- `findPath` is 8-directional with no corner cutting; waypoints are tile centres except the last, which is `to` exactly; `[]` when already at `to`; `null` when blocked, unreachable (8192 expansions) or longer than 256 tiles.

- [ ] **Step 0: Create the sim package**

`apps/sim/package.json`:

```json
{
  "name": "@daemonet/sim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { "./core": { "types": "./dist/core/index.d.ts", "default": "./dist/core/index.js" } },
  "dependencies": {
    "@daemonet/rules": "workspace:*",
    "@daemonet/shared": "workspace:*"
  }
}
```

`apps/sim/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../../packages/rules" }, { "path": "../../packages/shared" }]
}
```

Replace the root `tsconfig.json` with:

```json
{
  "files": [],
  "references": [{ "path": "packages/rules" }, { "path": "packages/shared" }, { "path": "apps/sim" }]
}
```

Then run `pnpm install`.

- [ ] **Step 1: Write the test subnet helper and the failing tests**

`apps/sim/test/helpers.ts` (temporary content; Task 3 replaces it):

```ts
import type { SubnetDef } from '@daemonet/rules';

/** 32 x 32 open test subnet: one wall segment, host at (4.5, 4.5), no spawn regions. */
export const TEST_SUBNET: SubnetDef = {
  id: 'test',
  width: 32,
  height: 32,
  walls: [{ x: 16, y: 1, w: 1, h: 20 }],
  host: { x: 4.5, y: 4.5 },
  spawn: { x: 5.5, y: 4.5 },
  regions: [],
};
```

`apps/sim/test/grid.test.ts`:

```ts
import { LO, createRng } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { Grid, MAX_PATH_TILES } from '../src/core/grid.js';
import { TEST_SUBNET } from './helpers.js';

describe('Grid', () => {
  const grid = new Grid(TEST_SUBNET);

  it('blocks the border and walls', () => {
    expect(grid.isWalkableTile(0, 5)).toBe(false);
    expect(grid.isWalkableTile(31, 5)).toBe(false);
    expect(grid.isWalkableTile(16, 10)).toBe(false);
    expect(grid.isWalkableTile(16, 25)).toBe(true);
    expect(grid.isWalkablePoint({ x: 5.5, y: 5.5 })).toBe(true);
  });

  it('paths around the wall and ends exactly at the destination', () => {
    const path = grid.findPath({ x: 10.5, y: 10.5 }, { x: 22.25, y: 10.75 })!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 22.25, y: 10.75 });
    for (const p of path) expect(grid.isWalkablePoint(p)).toBe(true);
    // Must go below the wall (which ends at y = 20).
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThan(20);
  });

  it('returns [] when already there and a single waypoint within the same tile', () => {
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 5.5, y: 5.5 })).toEqual([]);
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 5.9, y: 5.1 })).toEqual([{ x: 5.9, y: 5.1 }]);
  });

  it('returns null for blocked destinations', () => {
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 16.5, y: 5.5 })).toBeNull();
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: -3, y: 5.5 })).toBeNull();
  });

  it('never cuts corners diagonally', () => {
    const path = grid.findPath({ x: 15.5, y: 21.5 }, { x: 17.5, y: 21.5 })!;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const tx = Math.floor(a.x);
      const ty = Math.floor(a.y);
      const nx = Math.floor(b.x);
      const ny = Math.floor(b.y);
      if (tx !== nx && ty !== ny) {
        expect(grid.isWalkableTile(nx, ty) && grid.isWalkableTile(tx, ny)).toBe(true);
      }
    }
  });

  it('finds paths across lo within the tile cap', () => {
    const lo = new Grid(LO);
    const path = lo.findPath(LO.spawn, { x: 100.5, y: 100.5 })!;
    expect(path).not.toBeNull();
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_TILES);
    expect(lo.isWalkablePoint(LO.host)).toBe(true);
  });

  it('randomWalkableIn stays inside the rect', () => {
    const lo = new Grid(LO);
    const rng = createRng(5);
    for (const region of LO.regions) {
      for (let i = 0; i < 50; i++) {
        const p = lo.randomWalkableIn(region.rect, rng)!;
        expect(p.x).toBeGreaterThanOrEqual(region.rect.x);
        expect(p.x).toBeLessThan(region.rect.x + region.rect.w);
        expect(lo.isWalkablePoint(p)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/grid.test.ts`
Expected: FAIL — cannot resolve `../src/core/grid.js`.

- [ ] **Step 3: Implement**

`apps/sim/src/core/grid.ts`:

```ts
import type { Rect, Rng, SubnetDef } from '@daemonet/rules';

export interface Point {
  x: number;
  y: number;
}

export const MAX_PATH_TILES = 256;
const MAX_EXPANSIONS = 8192;
const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Min-heap of node indices keyed by f-score. */
class Heap {
  private items: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(node: number): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.f[items[parent]!]! <= this.f[items[i]!]!) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.f[items[l]!]! < this.f[items[m]!]!) m = l;
        if (r < items.length && this.f[items[r]!]! < this.f[items[m]!]!) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

export class Grid {
  readonly width: number;
  readonly height: number;
  private readonly blocked: Uint8Array;

  constructor(def: SubnetDef) {
    this.width = def.width;
    this.height = def.height;
    this.blocked = new Uint8Array(def.width * def.height);
    for (let x = 0; x < def.width; x++) {
      this.block(x, 0);
      this.block(x, def.height - 1);
    }
    for (let y = 0; y < def.height; y++) {
      this.block(0, y);
      this.block(def.width - 1, y);
    }
    for (const r of def.walls) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.block(x, y);
    }
  }

  private block(x: number, y: number): void {
    this.blocked[y * this.width + x] = 1;
  }

  isWalkableTile(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height && this.blocked[ty * this.width + tx] === 0;
  }

  isWalkablePoint(p: Point): boolean {
    return this.isWalkableTile(Math.floor(p.x), Math.floor(p.y));
  }

  /**
   * 8-directional A* without corner cutting. Returns waypoints (tile centres, the last one replaced by `to`),
   * excluding the start; [] when already at `to`; null when unreachable or longer than MAX_PATH_TILES.
   */
  findPath(from: Point, to: Point): Point[] | null {
    if (!this.isWalkablePoint(to) || !this.isWalkablePoint(from)) return null;
    const w = this.width;
    const start = Math.floor(from.y) * w + Math.floor(from.x);
    const goal = Math.floor(to.y) * w + Math.floor(to.x);
    if (start === goal) return from.x === to.x && from.y === to.y ? [] : [{ x: to.x, y: to.y }];

    const size = w * this.height;
    const g = new Float64Array(size).fill(Infinity);
    const f = new Float64Array(size).fill(Infinity);
    const came = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const gx = goal % w;
    const gy = Math.floor(goal / w);
    const h = (n: number): number => {
      const dx = Math.abs((n % w) - gx);
      const dy = Math.abs(Math.floor(n / w) - gy);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };
    const open = new Heap(f);
    g[start] = 0;
    f[start] = h(start);
    open.push(start);
    let expansions = 0;

    while (open.size > 0 && expansions < MAX_EXPANSIONS) {
      const cur = open.pop();
      if (closed[cur]) continue;
      if (cur === goal) break;
      closed[cur] = 1;
      expansions++;
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkableTile(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!this.isWalkableTile(cx + dx, cy) || !this.isWalkableTile(cx, cy + dy))) continue;
        const next = ny * w + nx;
        if (closed[next]) continue;
        const cost = g[cur]! + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
        if (cost < g[next]!) {
          g[next] = cost;
          f[next] = cost + h(next);
          came[next] = cur;
          open.push(next);
        }
      }
    }
    if (came[goal] === -1) return null;

    const tiles: number[] = [];
    for (let n = goal; n !== start; n = came[n]!) tiles.push(n);
    if (tiles.length > MAX_PATH_TILES) return null;
    tiles.reverse();
    const path = tiles.map((n) => ({ x: (n % w) + 0.5, y: Math.floor(n / w) + 0.5 }));
    path[path.length - 1] = { x: to.x, y: to.y };
    return path;
  }

  /** Centre of a random walkable tile inside `rect`, or null after `tries` misses. */
  randomWalkableIn(rect: Rect, rng: Rng, tries = 64): Point | null {
    for (let i = 0; i < tries; i++) {
      const x = rng.int(rect.x, rect.x + rect.w - 1);
      const y = rng.int(rect.y, rect.y + rect.h - 1);
      if (this.isWalkableTile(x, y)) return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): sim package and grid with A* pathfinding"
```

---

### Task 3: World model, views and system stubs

**Files:**
- Create: `apps/sim/src/core/model.ts`, `apps/sim/src/core/out.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/index.ts`
- Create (stubs, replaced by Tasks 4–7): `apps/sim/src/core/systems/{commands,movement,upkeep,combat,ai,progress,capture,spawner}.ts`
- Test: `apps/sim/test/helpers.ts` (full), `apps/sim/test/view.test.ts`

**Interfaces:**
- Produces (from `apps/sim/src/core/index.ts`):
  - records: `OwnedDaemonRecord { id; species; level; xp; nature; traitSlot; ivs: number[]; bonus: number[]; clean; signature; hp; energy; moves; crashed; slot }`, `OperatorRecord { id; name; starterClaimed; x; y; bits; inventory; ram: OwnedDaemonRecord[]; diskSlots: number[] }`
  - state: `Daemon`, `WildState`, `Operator`, `Capture`, `CaptureLog`
  - `Intent` = `claimStarter | capture | store | load` (each has `id`, `operatorId`; see model.ts), `IntentResult = { ok: true; daemon? } | { ok: false; reason }`
  - `Input { operatorId; reqId; command: Command }`, `Reply`, `ScopedEvent { event; to: string | null; at: Point | null }`, `StepResult { tick; events; replies; intents }`, `class Rejection(code, message)`
  - `class Out { emit(event, { to } | { at }); ok(req, result?); fail(req, code, message); intent(i) }`
  - `class World` — `constructor({ subnet, seed, seedId, spawner?, odds? })`, `tick`, `rng`, `grid`, `operators`, `daemons`, `captures`, `regionCounts`, `nextSpawnTick`, `queuedUses`, `newId(prefix)`, `ticks(ms)`, `addOperator(rec)`, `removeOperator(id)`, `checkpoint(id): OperatorRecord`, `addOwned(op, rec)`, `toRecord(d)`, `spawnWild(species, level, pos, region, roll)`, `removeDaemon(id)`, `activate(d, op)`, `deactivate(d)`, `freeRamSlot(op)`, `locate(id)`, `trackIntent(intent, out)`, `completeIntent(id, result)`, `step(inputs): StepResult`
  - views: `INTEREST_RADIUS = 32`, `toDaemonEntity`, `toOperatorEntity`, `toRamDaemon`, `toSelf`, `entitiesNear(world, x, y, radius?)`
  - constants re-exported: `HOST_RADIUS`, `LEASH_TILES`, `RESTORE_CHANNEL_MS`, `STARTER_LEVEL`, `OPERATOR_SPEED`, `daemonSpeed`
- Generated ids are `<seedId first 8 chars>-<prefix><counter>`: `w` wild, `d` owned, `c` capture, `i` intent.

- [ ] **Step 1: Write the full test helpers and the failing tests**

Replace `apps/sim/test/helpers.ts` with:

```ts
import { computeStats, getSpecies, movesAtLevel, rollSpawn, statBlock, statBlockToArray, xpForLevel, createRng, type SubnetDef, type SpawnRoll } from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { World, type Input, type OperatorRecord, type OwnedDaemonRecord, type StepResult } from '../src/core/index.js';

/** 32 x 32 open test subnet: one wall segment, host at (4.5, 4.5), no spawn regions. */
export const TEST_SUBNET: SubnetDef = {
  id: 'test',
  width: 32,
  height: 32,
  walls: [{ x: 16, y: 1, w: 1, h: 20 }],
  host: { x: 4.5, y: 4.5 },
  spawn: { x: 5.5, y: 4.5 },
  regions: [],
};

export function makeWorld(seed = 'test'): World {
  return new World({ subnet: TEST_SUBNET, seed, seedId: 'seed0001', spawner: false });
}

export function ownedRecord(species: string, level: number, slot: number, id = `own-${species}-${slot}`): OwnedDaemonRecord {
  const sp = getSpecies(species);
  const ivs = statBlock(20);
  const hp = computeStats({ base: sp.base, ivs, bonus: statBlock(0), level, nature: 0 }).hp;
  return {
    id,
    species,
    level,
    xp: xpForLevel(level),
    nature: 0,
    traitSlot: 0,
    ivs: statBlockToArray(ivs),
    bonus: statBlockToArray(statBlock(0)),
    clean: false,
    signature: 0,
    hp,
    energy: 128,
    moves: movesAtLevel(sp, level),
    crashed: false,
    slot,
  };
}

export function operatorRecord(id: string, overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    id,
    name: id,
    starterClaimed: true,
    x: 5.5,
    y: 5.5,
    bits: 0,
    inventory: { sniff: 8, tap: 2, mirror: 2, dump: 2, restore: 2 },
    ram: [ownedRecord('pingling', 20, 0, `${id}-d0`), ownedRecord('glitchmite', 20, 1, `${id}-d1`)],
    diskSlots: [],
    ...overrides,
  };
}

/** A plain (non-clean) roll with fixed IVs for predictable wild daemons. */
export function plainRoll(): SpawnRoll {
  return { ...rollSpawn(createRng(1), { clean: 0, signatureStep: 0 }), ivs: statBlock(10), nature: 0 };
}

export function placeWild(world: World, species: string, level: number, x: number, y: number, roll: SpawnRoll = plainRoll()) {
  return world.spawnWild(species, level, { x, y }, -1, roll);
}

let req = 0;
export function input(operatorId: string, command: Command): Input {
  return { operatorId, reqId: `r${++req}`, command };
}

/** Step once with the given commands. */
export function step(world: World, ...inputs: Input[]): StepResult {
  return world.step(inputs);
}

/** Step `n` times with no input, collecting all results. */
export function idle(world: World, n: number): StepResult[] {
  return Array.from({ length: n }, () => world.step([]));
}

export const self = 'self' as const;
```

`apps/sim/test/view.test.ts`:

```ts
import { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { entitiesNear, toDaemonEntity, toSelf } from '../src/core/index.js';
import { makeWorld, operatorRecord, placeWild } from './helpers.js';

describe('World basics', () => {
  it('adds operators with their RAM daemons and round-trips a checkpoint', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    expect(world.operators.get('alice')!.ram).toEqual(['alice-d0', 'alice-d1']);
    const cp = world.checkpoint('alice');
    world.removeOperator('alice');
    expect(world.daemons.size).toBe(0);
    world.addOperator(cp);
    expect(world.checkpoint('alice')).toEqual(cp);
  });

  it('moves operators saved on an unwalkable tile to the subnet spawn point', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 16.5, y: 5.5 }));
    const op = world.operators.get('alice')!;
    expect({ x: op.x, y: op.y }).toEqual(world.subnet.spawn);
  });

  it('spawns wild daemons at full HP with generated ids', () => {
    const world = makeWorld();
    const wild = placeWild(world, 'voidlet', 7, 8.5, 8.5);
    expect(wild.id).toBe('seed0001-w1');
    expect(wild.hp).toBe(wild.stats.hp);
    expect(toDaemonEntity(world, wild)).toMatchObject({ kind: 'daemon', species: 'voidlet', owner: null, taggedBy: null, hardened: false });
    world.removeDaemon(wild.id);
    expect(world.daemons.has(wild.id)).toBe(false);
  });

  it('produces a schema-valid self view and nearby entities', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    placeWild(world, 'bitrot', 5, 9.5, 9.5);
    placeWild(world, 'bitrot', 5, 29.5, 29.5);
    const self = toSelf(world, world.operators.get('alice')!);
    expect(OperatorSelf.safeParse(self).success).toBe(true);
    expect(self.ram.map((d) => d.slot)).toEqual([0, 1]);
    const near = entitiesNear(world, 5.5, 5.5, 10);
    expect(near.map((e) => e.kind).sort()).toEqual(['daemon', 'operator']);
  });

  it('advances the tick and rejects unknown intents', () => {
    const world = makeWorld();
    expect(world.step([]).tick).toBe(1);
    expect(world.step([]).tick).toBe(2);
    expect(() => world.completeIntent('nope', { ok: true })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/view.test.ts`
Expected: FAIL — cannot resolve `../src/core/index.js`.

- [ ] **Step 3: Create the model, output collector and views**

`apps/sim/src/core/model.ts`:

```ts
import type { Behaviour, StatBlock, StatusId, ToolId, TypeId, Challenge } from '@daemonet/rules';
import type { Command, ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';

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
  /** Owned daemon locked by a pending store intent. */
  pending: boolean;
  wild: WildState | null;
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
  | { id: string; kind: 'load'; operatorId: string; reqId: string; daemonId: string; ramSlot: number };

export type IntentResult = { ok: true; daemon?: OwnedDaemonRecord } | { ok: false; reason: string };

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

`apps/sim/src/core/out.ts`:

```ts
import type { ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';
import type { Intent, Reply, ScopedEvent } from './model.js';

/** Collects everything a step (or an intent completion) produces. */
export class Out {
  readonly events: ScopedEvent[] = [];
  readonly replies: Reply[] = [];
  readonly intents: Intent[] = [];

  /** Private to `to`, or public near `at` (null = everyone). */
  emit(event: GameEvent, scope: { to: string } | { at: Point | null }): void {
    this.events.push('to' in scope ? { event, to: scope.to, at: null } : { event, to: null, at: scope.at ? { x: scope.at.x, y: scope.at.y } : null });
  }

  ok(req: { operatorId: string; reqId: string }, result?: unknown): void {
    this.replies.push(result === undefined ? { operatorId: req.operatorId, reqId: req.reqId, ok: true } : { operatorId: req.operatorId, reqId: req.reqId, ok: true, result });
  }

  fail(req: { operatorId: string; reqId: string }, code: ErrorCode, message: string): void {
    this.replies.push({ operatorId: req.operatorId, reqId: req.reqId, ok: false, code, message });
  }

  intent(intent: Intent): void {
    this.intents.push(intent);
  }
}
```

`apps/sim/src/core/view.ts`:

```ts
import { statBlockToArray, type StatusId } from '@daemonet/rules';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import type { Daemon, Operator } from './model.js';
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

- [ ] **Step 4: Create the system stubs**

These have the final signatures; Tasks 4–7 replace them.

`apps/sim/src/core/systems/commands.ts`:

```ts
import type { Input } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export const LEASH_TILES = 8;
export const HOST_RADIUS = 2;
export const OUT_OF_COMBAT_MS = 4096;
export const RESTORE_CHANNEL_MS = 2048;
export const STARTER_LEVEL = 5;

/** Stub until Task 4: rejects every command. */
export function handleCommands(_world: World, inputs: readonly Input[], out: Out): void {
  for (const input of inputs) out.fail(input, 'E_STATE', 'commands are not implemented yet');
}
```

`apps/sim/src/core/systems/movement.ts`:

```ts
import type { World } from '../world.js';

export const OPERATOR_SPEED = 4;
export const FOLLOW_TILES = 3;

export function daemonSpeed(speedStat: number): number {
  return 2 + speedStat / 32;
}

/** Stub until Task 4. */
export function moveAll(_world: World): void {}
```

`apps/sim/src/core/systems/upkeep.ts`:

```ts
import { ENERGY_MAX } from '@daemonet/rules';
import type { Daemon } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export function restoreDaemon(d: Daemon): void {
  d.hp = d.stats.hp;
  d.energy = ENERGY_MAX;
  d.crashed = false;
  d.statuses = {};
}

/** Stub until Task 4. */
export function upkeep(_world: World, _out: Out): void {}
```

`apps/sim/src/core/systems/combat.ts`:

```ts
import type { Input } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

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

/** Stub until Task 5. */
export function executeQueuedUses(_world: World, _uses: readonly QueuedUse[], _out: Out): void {}
```

`apps/sim/src/core/systems/ai.ts`:

```ts
import type { World } from '../world.js';
import type { QueuedUse } from './combat.js';

export const FLEE_MS = 4096;

/** Stub until Task 5. */
export function planWild(_world: World): QueuedUse[] {
  return [];
}
```

`apps/sim/src/core/systems/progress.ts`:

```ts
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Stubs until Task 5. */
export function awardXp(_world: World, _daemonIds: readonly string[], _total: number, _out: Out): void {}

export function resolveDefeats(_world: World, _out: Out): void {}
```

`apps/sim/src/core/systems/capture.ts`:

```ts
import type { ToolId } from '@daemonet/rules';
import { Rejection, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Stubs until Task 6. */
export function startCapture(_world: World, _op: Operator, _args: { targetId: string; tool: ToolId }, _out: Out): string {
  throw new Rejection('E_STATE', 'capture is not implemented yet');
}

export function submitCapture(_world: World, _op: Operator, _args: { captureId: string; answer?: unknown }, _out: Out): 'correct' | 'wrong' {
  throw new Rejection('E_STATE', 'capture is not implemented yet');
}

export function completeCaptureIntent(_world: World, _op: Operator, _intent: Extract<Intent, { kind: 'capture' }>, _result: IntentResult, _out: Out): void {}

export function progressCaptures(_world: World, _out: Out): void {}
```

`apps/sim/src/core/systems/spawner.ts`:

```ts
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Stub until Task 7. */
export function runSpawner(_world: World, _out: Out, _initial: boolean): void {}
```

- [ ] **Step 5: Create the World and the core index**

`apps/sim/src/core/world.ts`:

```ts
import {
  DEFAULT_ODDS,
  RAM_SLOTS,
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
import type { Capture, Daemon, Input, Intent, IntentResult, Operator, OperatorRecord, OwnedDaemonRecord, StepResult } from './model.js';
import { Out } from './out.js';
import { planWild } from './systems/ai.js';
import { executeQueuedUses, type QueuedUse } from './systems/combat.js';
import { handleCommands } from './systems/commands.js';
import { completeCaptureIntent, progressCaptures } from './systems/capture.js';
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

  private makeDaemon(species: string, level: number, fields: Omit<Daemon, 'species' | 'types' | 'level' | 'stats'>): Daemon {
    const sp = getSpecies(species);
    const stats = computeStats({ base: sp.base, ivs: fields.ivs, bonus: fields.bonus, level, nature: fields.nature });
    return { ...fields, species, types: sp.types, level, stats };
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

`apps/sim/src/core/index.ts`:

```ts
export { World, type WorldOptions } from './world.js';
export { Grid, MAX_PATH_TILES, distance, type Point } from './grid.js';
export * from './model.js';
export { INTEREST_RADIUS, entitiesNear, toDaemonEntity, toOperatorEntity, toRamDaemon, toSelf } from './view.js';
export { HOST_RADIUS, LEASH_TILES, RESTORE_CHANNEL_MS, STARTER_LEVEL } from './systems/commands.js';
export { OPERATOR_SPEED, daemonSpeed } from './systems/movement.js';
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 10 test files, 86 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(sim): world model, views and system stubs"
```

---

### Task 4: Commands, movement and upkeep

**Files:**
- Modify (replace stubs): `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/core/systems/movement.ts`, `apps/sim/src/core/systems/upkeep.ts`
- Test: `apps/sim/test/commands.test.ts`

**Interfaces:**
- Consumes: Task 3 World API; `startCapture`/`submitCapture` (still stubs), `restoreDaemon`.
- Produces: `handleCommands(world, inputs, out)`; `advance(mover, tilesPerSecond)`, `moveAll(world)`, `OPERATOR_SPEED = 4`, `FOLLOW_TILES = 3`, `daemonSpeed(speed) = 2 + speed/32`; `upkeep(world, out)`, `restoreDaemon(d)`, `SP1_SNIFF_REFILL = 8`.
- Rules implemented:
  - Before a starter is claimed only `claimStarter`, `moveTo`, `stop` are allowed (`E_STATE`).
  - `run`, `recall` and `swap` share the 4096 ms swap cooldown (`E_COOLDOWN`), so recall+run cannot bypass it; at most 2 running.
  - Daemon `moveTo` must stay within 8 tiles of the operator (`E_RANGE`); stalled daemons cannot be moved.
  - `useItem restore` needs 4096 ms out of combat. `restoreAll` needs the host within 2 tiles, channels 2048 ms, and is cancelled by moving or being hit; it restores all RAM and (SP1 only) tops `sniff` up to 8.
  - `claimStarter`, `store`, `load` emit intents; their reply is sent after `completeIntent`.
  - `use` is validated for ownership and known move, then queued for the combat phase.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/commands.test.ts`:

```ts
import { SWAP_COOLDOWN_MS, msToTicks } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { toSelf } from '../src/core/index.js';
import { idle, input, makeWorld, operatorRecord, self, step } from './helpers.js';

describe('claimStarter', () => {
  it('requires a starter before most commands, then goes through an intent', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { starterClaimed: false, name: null, ram: [], inventory: {} }));

    const blocked = step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    expect(blocked.replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });

    const notStarter = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'voidlet', operatorName: 'alice' } }));
    expect(notStarter.replies[0]).toMatchObject({ ok: false, code: 'E_INVALID' });

    const r = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'alice' } }));
    expect(r.replies).toEqual([]);
    expect(r.intents).toHaveLength(1);
    const intent = r.intents[0]!;
    expect(intent).toMatchObject({ kind: 'claimStarter', name: 'alice', inventory: { sniff: 8, restore: 2 } });
    if (intent.kind !== 'claimStarter') throw new Error('unreachable');
    expect(intent.daemon).toMatchObject({ species: 'pingling', level: 5, clean: false, signature: 0 });
    expect(intent.daemon.hp).toBeGreaterThan(0);

    const again = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'alice' } }));
    expect(again.replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });

    world.completeIntent(intent.id, { ok: true });
    const after = step(world);
    expect(after.replies[0]).toMatchObject({ ok: true, result: { daemonId: intent.daemon.id } });
    const me = toSelf(world, world.operators.get('alice')!);
    expect(me.starterClaimed).toBe(true);
    expect(me.ram.map((d) => d.species)).toEqual(['pingling']);
  });

  it('reports a failed claim (e.g. name taken) and allows retrying', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('bob', { starterClaimed: false, name: null, ram: [] }));
    const r = step(world, input('bob', { cmd: 'claimStarter', actor: self, args: { species: 'nullpup', operatorName: 'taken' } }));
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'name taken' });
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'name taken' });
    const retry = step(world, input('bob', { cmd: 'claimStarter', actor: self, args: { species: 'nullpup', operatorName: 'bob' } }));
    expect(retry.intents).toHaveLength(1);
  });
});

describe('movement commands', () => {
  it('moves the operator along a path at 4 tiles/s', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 5.5 } }));
    idle(world, 15);
    const op = world.operators.get('alice')!;
    expect(op.x).toBeCloseTo(9.5, 5);
    expect(op.path).toEqual([]);
  });

  it('rejects unreachable destinations and daemon moves beyond the leash', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 16.5, y: 5.5 } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const r = step(world, input('alice', { cmd: 'moveTo', actor: 'alice-d0', args: { x: 15.5, y: 20.5 } }));
    expect(r.replies[0]).toMatchObject({ ok: false, code: 'E_RANGE' });
  });

  it('running daemons follow their operator', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 12.5, y: 5.5 } }));
    idle(world, 64);
    const d = world.daemons.get('alice-d0')!;
    expect(Math.hypot(d.x - 12.5, d.y - 5.5)).toBeLessThanOrEqual(3);
  });
});

describe('run, recall and swap', () => {
  it('shares one 4096 ms cooldown and allows at most 2 running', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    const run0 = step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(run0.replies[0]).toMatchObject({ ok: true });
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
    idle(world, msToTicks(SWAP_COOLDOWN_MS));
    const sw = step(world, input('alice', { cmd: 'swap', actor: self, args: { outId: 'alice-d0', inId: 'alice-d1' } }));
    expect(sw.replies[0]).toMatchObject({ ok: true });
    expect(sw.events.map((e) => e.event)).toContainEqual({ e: 'swap', out: 'alice-d0', in: 'alice-d1' });
    expect(world.operators.get('alice')!.running).toEqual(['alice-d1']);
  });
});

describe('restoreAll', () => {
  it('channels for 2048 ms at the host, restores RAM and tops sniff up to 8', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5, inventory: { sniff: 1 } }));
    const d = world.daemons.get('alice-d0')!;
    d.hp = 1;
    d.crashed = true;
    const r = step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const results = idle(world, 33);
    const restored = results.flatMap((x) => x.events).find((e) => e.event.e === 'restored');
    expect(restored?.to).toBe('alice');
    expect(d.hp).toBe(d.stats.hp);
    expect(d.crashed).toBe(false);
    expect(world.operators.get('alice')!.inventory.sniff).toBe(8);
  });

  it('is cancelled by moving and rejected away from the host', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5 }));
    step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 5.5, y: 5.5 } }));
    expect(world.operators.get('alice')!.restoreUntil).toBeNull();
    world.operators.get('alice')!.x = 20.5;
    world.operators.get('alice')!.y = 25.5;
    expect(step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });
});

describe('store and load', () => {
  it('store moves a RAM daemon to Disk after commit', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5 }));
    const r = step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } }));
    expect(r.intents[0]).toMatchObject({ kind: 'store', daemonId: 'alice-d1', diskSlot: 0 });
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    world.completeIntent(r.intents[0]!.id, { ok: true });
    expect(step(world).replies[0]).toMatchObject({ ok: true });
    expect(world.operators.get('alice')!.ram).toEqual(['alice-d0']);
    expect([...world.operators.get('alice')!.diskSlots]).toEqual([0]);
  });

  it('load reserves a RAM slot and inserts the daemon the runtime supplies', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5, diskSlots: [0] }));
    const r = step(world, input('alice', { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } }));
    const intent = r.intents[0]!;
    expect(intent).toMatchObject({ kind: 'load', daemonId: 'disk-1', ramSlot: 2 });
    const rec = world.checkpoint('alice').ram[0]!;
    world.completeIntent(intent.id, { ok: true, daemon: { ...rec, id: 'disk-1', slot: 99 } });
    const done = step(world);
    expect(done.replies[0]).toMatchObject({ ok: true });
    expect(world.daemons.get('disk-1')!.slot).toBe(2);
  });

  it('both require being at the host', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 20.5, y: 25.5 }));
    expect(step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/commands.test.ts`
Expected: FAIL — replies are `E_STATE "commands are not implemented yet"`.

- [ ] **Step 3: Implement**

`apps/sim/src/core/systems/commands.ts`:

```ts
import { DISK_SLOTS, RUNNING_MAX, STARTING_INVENTORY, SWAP_COOLDOWN_MS, computeStats, getSpecies, movesAtLevel, rollSpawn, statBlockToArray, xpForLevel } from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { distance, type Point } from '../grid.js';
import { Rejection, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { startCapture, submitCapture } from './capture.js';
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
      if ((op.inventory.restore ?? 0) <= 0) throw new Rejection('E_STATE', 'no restore left');
      if (world.tick - d.lastCombatTick < world.ticks(OUT_OF_COMBAT_MS)) throw new Rejection('E_STATE', 'daemon is in combat');
      op.inventory.restore = (op.inventory.restore ?? 0) - 1;
      restoreDaemon(d);
      out.emit({ e: 'restored', daemons: [d.id] }, { to: op.id });
      return out.ok(input);
    }
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

`apps/sim/src/core/systems/movement.ts`:

```ts
import { TICK_HZ } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import type { World } from '../world.js';
import { LEASH_TILES } from './commands.js';

export const OPERATOR_SPEED = 4;
export const FOLLOW_TILES = 3;
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
    advance(d, daemonSpeed(d.stats.speed));
  }
}
```

`apps/sim/src/core/systems/upkeep.ts`:

```ts
import { ENERGY_MAX, regenEnergy, type StatusId } from '@daemonet/rules';
import type { Daemon } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export const SP1_SNIFF_REFILL = 8;

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
    d.energy = regenEnergy(d.energy, d.stats.energy);
    for (const [status, until] of Object.entries(d.statuses) as Array<[StatusId, number]>) {
      if (until <= tick) delete d.statuses[status];
    }
    const w = d.wild;
    if (w && w.tagOwner !== null && tick > w.tagUntil && !captured.has(d.id)) {
      w.tagOwner = null;
      w.aggro = null;
      w.damagedBy.clear();
      d.hp = d.stats.hp;
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

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 11 test files, 97 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): operator commands, movement and upkeep"
```

---

### Task 5: Combat, wild AI, defeats and XP

**Files:**
- Modify (replace stubs): `apps/sim/src/core/systems/combat.ts`, `apps/sim/src/core/systems/ai.ts`, `apps/sim/src/core/systems/progress.ts`
- Test: `apps/sim/test/combat.test.ts`

**Interfaces:**
- Produces: `executeMove(world, attacker, moveId, aim, out)` (throws `Rejection`), `executeQueuedUses(world, uses, out)`, `interface Aim`, `interface QueuedUse`; `planWild(world): QueuedUse[]`, `AGGRO_RADIUS = 6`, `DEAGGRO_RADIUS = 16`, `FLEE_MS = 4096`; `awardXp(world, daemonIds, total, out)`, `resolveDefeats(world, out)`.
- Rules implemented:
  - Checks in order: cooldown (`E_COOLDOWN`), energy (`E_ENERGY`), target/area (`E_INVALID`/`E_STATE`/`E_RANGE`). Cooldown = `effectiveCooldownMs(base, haste, throttled)` in ticks.
  - Owned daemons hit wild daemons not tagged by another operator. Hitting tags the wild daemon for 8192 ms (first tag emits `battleStart`), records the attacker for XP and sets the wild daemon's aggro.
  - Wild daemons hit their aggro side: running daemons and the operator. A hit on an operator does no damage but sets `hitTick` (packet loss / restore cancel).
  - Wild behaviour: `territorial` aggros within 6 tiles and attacks an operator who starts capturing it; `timid` flees when tagged below half HP or while being captured; `wanderer` fights back only when hit. Idle wild daemons wander inside their region.
  - A wild daemon at 0 HP is defeated (XP to the tag owner's non-crashed daemons that damaged it). A running owned daemon at 0 HP crashes; if all RAM daemons are crashed the operator returns to the subnet spawn point.
  - Level-ups recompute stats, add the max-HP gain to current HP, relearn moves and emit `levelUp` to the owner.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/combat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { idle, input, makeWorld, operatorRecord, placeWild, self, step } from './helpers.js';

function arena() {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice'));
  step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
  return world;
}

describe('player moves', () => {
  it('hits, tags the wild daemon and starts a battle', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const kinds = r.events.map((e) => e.event.e);
    expect(kinds).toContain('battleStart');
    expect(kinds).toContain('hit');
    expect(wild.hp).toBeLessThan(wild.stats.hp);
    expect(wild.wild!.tagOwner).toBe('alice');
  });

  it('rejects out-of-range, cooling-down and unaffordable moves', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 14.5, 5.5);
    const use = (move: string) => input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, targetId: wild.id } });
    expect(step(world, use('ping')).replies[0]).toMatchObject({ code: 'E_RANGE' });
    wild.x = 7.5;
    expect(step(world, use('ping')).replies[0]).toMatchObject({ ok: true });
    expect(step(world, use('ping')).replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
    world.daemons.get('alice-d0')!.energy = 0;
    expect(step(world, use('traceroute')).replies[0]).toMatchObject({ code: 'E_ENERGY' });
  });

  it('rejects moves the daemon does not know and targets tagged by someone else', () => {
    const world = arena();
    world.addOperator(operatorRecord('bob'));
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    wild.wild!.tagOwner = 'bob';
    wild.wild!.tagUntil = 10_000;
    expect(step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'hash', targetId: wild.id } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } })).replies[0]).toMatchObject({ code: 'E_STATE' });
  });

  it('area moves hit every eligible wild daemon in the circle', () => {
    const world = arena();
    const a = placeWild(world, 'bitrot', 5, 8.5, 5.5);
    const b = placeWild(world, 'voidlet', 5, 9.5, 6.5);
    const far = placeWild(world, 'voidlet', 5, 12.5, 12.5);
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'broadcast', x: 9, y: 6 } }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const hits = r.events.filter((e) => e.event.e === 'hit').map((e) => (e.event as { target: string }).target);
    expect(hits.sort()).toEqual([a.id, b.id].sort());
    expect(far.hp).toBe(far.stats.hp);
  });
});

describe('wild daemons fight back and defeats resolve', () => {
  it('a tagged wild daemon retaliates against the running daemon', () => {
    const world = arena();
    const wild = placeWild(world, 'floodhound', 10, 7.5, 5.5);
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    const results = idle(world, 32);
    const hitsOnMe = results.flatMap((r) => r.events).filter((e) => e.event.e === 'hit' && (e.event as { source: string }).source === wild.id);
    expect(hitsOnMe.length).toBeGreaterThan(0);
  });

  it('defeating a wild daemon awards XP to the daemons that damaged it', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    const mine = world.daemons.get('alice-d0')!;
    const xpBefore = mine.xp;
    wild.hp = 1;
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'crash', daemon: wild.id });
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(mine.xp).toBeGreaterThan(xpBefore);
  });

  it('an owned daemon at 0 HP crashes; all crashed teleports the operator home', () => {
    const world = arena();
    const op = world.operators.get('alice')!;
    op.x = 20.5;
    op.y = 25.5;
    world.daemons.get('alice-d1')!.crashed = true; // not running, already crashed
    world.daemons.get('alice-d0')!.hp = 0; // running: crashes this tick
    const r = step(world);
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'crash', daemon: 'alice-d0' });
    expect(world.daemons.get('alice-d0')!.crashed).toBe(true);
    expect(op.running).toEqual([]);
    expect({ x: op.x, y: op.y }).toEqual(world.subnet.spawn);
  });

  it('a wild tag expires 8192 ms after the last hit and the daemon heals', () => {
    const world = arena();
    const wild = placeWild(world, 'voidlet', 5, 7.5, 5.5);
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    world.operators.get('alice')!.swapReadyTick = 0;
    expect(step(world, input('alice', { cmd: 'recall', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: true });
    idle(world, 140);
    expect(wild.wild!.tagOwner).toBeNull();
    expect(wild.hp).toBe(wild.stats.hp);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/combat.test.ts`
Expected: FAIL — `use` gets no reply and no `hit` events (combat is a stub).

- [ ] **Step 3: Implement**

`apps/sim/src/core/systems/combat.ts`:

```ts
import { TAG_WINDOW_MS, damage, effectiveCooldownMs, getMove, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { Rejection, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

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
    if (distance(attacker, pos(v)) > move.range) throw new Rejection('E_RANGE', 'target out of range');
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

/** Validates and applies one move. Throws Rejection on E_COOLDOWN / E_ENERGY / E_RANGE / E_STATE / E_INVALID. */
export function executeMove(world: World, attacker: Daemon, moveId: string, aim: Aim, out: Out): void {
  if (!attacker.active || attacker.hp <= 0) throw new Rejection('E_STATE', 'daemon is not running');
  const move = getMove(moveId);
  const tick = world.tick;
  if ((attacker.cooldowns[move.id] ?? 0) > tick) throw new Rejection('E_COOLDOWN', `${move.id} is cooling down`);
  if (attacker.energy < move.energyCost) throw new Rejection('E_ENERGY', 'not enough energy');
  const victims = selectVictims(world, attacker, move, aim);

  attacker.energy -= move.energyCost;
  const throttled = (attacker.statuses.throttled ?? 0) > tick;
  attacker.cooldowns[move.id] = tick + world.ticks(effectiveCooldownMs(move.cooldownMs, attacker.stats.haste, throttled));
  attacker.lastCombatTick = tick;

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
    target.hp = Math.max(0, target.hp - r.amount);
    target.lastCombatTick = tick;
    out.emit({ e: 'hit', source: attacker.id, target: target.id, move: move.id, amount: r.amount, multiplier: r.multiplier }, { at: attacker });
    if (target.wild && attacker.ownerId) {
      if (target.wild.tagOwner === null) out.emit({ e: 'battleStart', wild: target.id, operator: attacker.ownerId }, { at: target });
      target.wild.tagOwner = attacker.ownerId;
      target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
      target.wild.damagedBy.add(attacker.id);
      target.wild.aggro ??= attacker.id;
    }
    if (move.status && r.multiplier > 0 && world.rng.chance(move.status.chance)) {
      const untilTick = tick + world.ticks(move.status.durationMs);
      target.statuses[move.status.id] = untilTick;
      out.emit({ e: 'status', target: target.id, status: move.status.id, untilTick }, { at: target });
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

`apps/sim/src/core/systems/ai.ts`:

```ts
import { getMove, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import type { Daemon } from '../model.js';
import type { World } from '../world.js';
import type { QueuedUse } from './combat.js';

export const AGGRO_RADIUS = 6;
export const DEAGGRO_RADIUS = 16;
export const FLEE_MS = 4096;
const FLEE_DISTANCE = 8;
const WANDER_CHANCE = 1 / 64;
const REPATH_TICKS = 8;

function reach(move: MoveDef): number {
  return move.shape.kind === 'cone' ? move.shape.length : move.range;
}

function nearestHostile(world: World, d: Daemon): { id: string; at: Point } | null {
  let best: { id: string; at: Point; dist: number } | null = null;
  for (const op of world.operators.values()) {
    const candidates: Array<{ id: string; at: Point }> = [{ id: op.id, at: op }];
    for (const id of op.running) candidates.push({ id, at: world.daemons.get(id)! });
    for (const c of candidates) {
      const dist = distance(d, c.at);
      if (dist <= AGGRO_RADIUS && (!best || dist < best.dist)) best = { ...c, dist };
    }
  }
  return best;
}

function fleePath(world: World, d: Daemon, threat: Point): Point[] {
  const dx = d.x - threat.x;
  const dy = d.y - threat.y;
  const len = Math.hypot(dx, dy) || 1;
  const dest = { x: d.x + (dx / len) * FLEE_DISTANCE, y: d.y + (dy / len) * FLEE_DISTANCE };
  return world.grid.findPath(d, dest) ?? [];
}

/** Decide movement for every wild daemon and return the moves they will use this tick. */
export function planWild(world: World): QueuedUse[] {
  const uses: QueuedUse[] = [];
  const tick = world.tick;
  const capturing = new Map<string, string>();
  for (const cap of world.captures.values()) if (cap.state === 'open') capturing.set(cap.targetId, cap.operatorId);

  for (const d of world.daemons.values()) {
    const w = d.wild;
    if (!w || !d.active || d.hp <= 0) continue;
    const stalled = (d.statuses.stalled ?? 0) > tick;

    const capturer = capturing.get(d.id);
    if (capturer) {
      if (w.behaviour === 'timid') w.fleeUntil = Math.max(w.fleeUntil, tick + 1);
      if (w.behaviour === 'territorial') w.aggro = capturer;
    }
    if (!w.aggro && w.behaviour === 'territorial') w.aggro = nearestHostile(world, d)?.id ?? null;

    const target = w.aggro ? world.locate(w.aggro) : null;
    if (w.aggro && (!target || distance(d, target) > DEAGGRO_RADIUS)) w.aggro = null;

    const fleeing = tick < w.fleeUntil || (w.behaviour === 'timid' && w.tagOwner !== null && d.hp < d.stats.hp / 2);
    if (fleeing) {
      const threat = target ?? (capturer ? world.operators.get(capturer) : undefined);
      if (!stalled && threat && d.path.length === 0) d.path = fleePath(world, d, threat);
      continue;
    }

    if (w.aggro && target) {
      const dist = distance(d, target);
      const usable = d.moves
        .map(getMove)
        .filter((m) => (d.cooldowns[m.id] ?? 0) <= tick && d.energy >= m.energyCost && dist <= reach(m))
        .sort((a, b) => b.power - a.power);
      const best = usable[0];
      if (best) {
        d.path = [];
        uses.push({ daemonId: d.id, move: best.id, aim: { targetId: w.aggro } });
      } else if (!stalled && (d.path.length === 0 || tick % REPATH_TICKS === 0)) {
        d.path = world.grid.findPath(d, target) ?? [];
      }
      continue;
    }

    if (!stalled && d.path.length === 0 && world.rng.chance(WANDER_CHANCE)) {
      const region = world.subnet.regions[w.region];
      const dest = region ? world.grid.randomWalkableIn(region.rect, world.rng) : null;
      if (dest) d.path = world.grid.findPath(d, dest) ?? [];
    }
  }
  return uses;
}
```

`apps/sim/src/core/systems/progress.ts`:

```ts
import { computeStats, getSpecies, levelForXp, movesAtLevel, splitXp, xpYield } from '@daemonet/rules';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Split `total` XP across owned daemons; level them up (stats, HP delta, moves). */
export function awardXp(world: World, daemonIds: readonly string[], total: number, out: Out): void {
  const shares = splitXp(total, daemonIds.length);
  daemonIds.forEach((id, i) => {
    const d = world.daemons.get(id);
    if (!d || !d.ownerId) return;
    d.xp += shares[i]!;
    const level = levelForXp(d.xp);
    if (level <= d.level) return;
    const sp = getSpecies(d.species);
    const oldMax = d.stats.hp;
    d.level = level;
    d.stats = computeStats({ base: sp.base, ivs: d.ivs, bonus: d.bonus, level, nature: d.nature });
    d.hp = Math.min(d.stats.hp, d.hp + (d.stats.hp - oldMax));
    d.moves = movesAtLevel(sp, level);
    out.emit({ e: 'levelUp', daemon: d.id, level }, { to: d.ownerId });
  });
}

/** Crash owned daemons at 0 HP; defeat wild daemons at 0 HP (XP to the tag owner's damaging daemons). */
export function resolveDefeats(world: World, out: Out): void {
  for (const d of [...world.daemons.values()]) {
    if (!d.active || d.hp > 0) continue;
    out.emit({ e: 'crash', daemon: d.id }, { at: d });
    if (d.wild) {
      const owner = d.wild.tagOwner ? world.operators.get(d.wild.tagOwner) : undefined;
      if (owner) {
        const recipients = [...d.wild.damagedBy].filter((id) => owner.ram.includes(id) && !world.daemons.get(id)!.crashed);
        awardXp(world, recipients, xpYield(getSpecies(d.species).baseYield, d.level), out);
      }
      world.removeDaemon(d.id);
      continue;
    }
    d.crashed = true;
    world.deactivate(d);
    const op = world.operators.get(d.ownerId!)!;
    if (op.ram.every((id) => world.daemons.get(id)!.crashed)) {
      op.x = world.subnet.spawn.x;
      op.y = world.subnet.spawn.y;
      op.path = [];
      op.restoreUntil = null;
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 12 test files, 105 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): combat, wild AI, defeats and XP"
```

---

### Task 6: Capture

**Files:**
- Modify (replace stub): `apps/sim/src/core/systems/capture.ts`
- Test: `apps/sim/test/capture.test.ts`

**Interfaces:**
- Produces: `startCapture(world, op, { targetId, tool }, out): string`, `submitCapture(world, op, { captureId, answer }, out): 'correct' | 'wrong'`, `failCapture(world, cap, reason, out)`, `completeCaptureIntent(world, op, intent, result, out)`, `progressCaptures(world, out)`.
- Rules implemented (SP1 spec §5.4):
  - Start: one active capture per operator; tool in inventory; target wild, active, not tagged by another operator, within tool range; RAM or Disk has space. Consumes the tool, tags the target, sizes the challenge with `challengeSize`, generates it from the world RNG and sends `captureStart` to the operator only.
  - Submit: malformed → `E_INVALID` and the capture stays open; wrong → `captureResult { ok: false, reason: 'wrong_answer' }`; correct → XP to the damaging daemons, the wild daemon leaves the world, a `capture` intent is emitted (RAM slot reserved, or the first free Disk slot).
  - Each tick: target gone or operator hit or out of range → `packet_loss`; past the deadline → `timeout`. Every failure hardens the target for 8192 ms (next challenge ×2) and makes `timid` targets flee.
  - Intent completion: success adds the daemon to RAM (`captureResult` with the `RamDaemon`) or confirms Disk; failure refunds the tool and reports `persist_failed`.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/capture.test.ts`:

```ts
import { challengeSize, getTool, type PublicChallenge } from '@daemonet/rules';
import type { GameEvent } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import type { StepResult, World } from '../src/core/index.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { idle, input, makeWorld, operatorRecord, placeWild, self, step } from './helpers.js';

type CaptureStart = Extract<GameEvent, { e: 'captureStart' }>;
type CaptureResult = Extract<GameEvent, { e: 'captureResult' }>;

const find = <E extends GameEvent['e']>(results: StepResult[], e: E) =>
  results.flatMap((r) => r.events).map((x) => x.event).find((ev): ev is Extract<GameEvent, { e: E }> => ev.e === e);

function setup(): { world: World; wildId: string } {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice'));
  const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
  return { world, wildId: wild.id };
}

function start(world: World, wildId: string, tool: 'sniff' | 'mirror' | 'dump' = 'mirror'): CaptureStart {
  const r = step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool } }));
  expect(r.replies[0]).toMatchObject({ ok: true });
  return find([r], 'captureStart')!;
}

const submit = (world: World, captureId: string, answer: unknown) =>
  step(world, input('alice', { cmd: 'submitCapture', actor: self, args: { captureId, answer } }));

describe('capture', () => {
  it('a correct answer commits via an intent, then lands in RAM', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    expect(world.operators.get('alice')!.inventory.mirror).toBe(1);
    const r = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    expect(r.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(world.daemons.has(wildId)).toBe(false);
    const intent = r.intents.find((i) => i.kind === 'capture')!;
    expect(intent).toMatchObject({ kind: 'capture', location: 'RAM', tool: 'mirror', log: { originalOperatorId: 'alice', subnet: 'test' } });
    world.completeIntent(intent.id, { ok: true });
    const done = find([step(world)], 'captureResult')!;
    expect(done).toMatchObject({ ok: true, daemon: { species: 'bitrot', slot: 2 } });
    expect(world.operators.get('alice')!.ram).toHaveLength(3);
  });

  it('a wrong answer fails, hardens the target and doubles the next challenge size', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    // Bitrot is Glitch-type, so the answer shape is { hex }; this one is well-formed but wrong.
    const r = submit(world, ev.captureId, { hex: '00' });
    expect(r.replies[0]).toMatchObject({ ok: true, result: { status: 'wrong' } });
    expect(find([r], 'captureResult')).toMatchObject({ ok: false, reason: 'wrong_answer' });
    const wild = world.daemons.get(wildId)!;
    expect(wild.wild!.hardenedUntil).toBeGreaterThan(world.tick);
    const base = { stage: 0, hpFraction: 1, clean: false, signature: 0, statused: false };
    expect(challengeSize({ ...base, hardened: true }, getTool('mirror'))).toBe(2 * challengeSize({ ...base, hardened: false }, getTool('mirror')));
  });

  it('a malformed answer is E_INVALID and leaves the capture open', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    expect(submit(world, ev.captureId, { nope: 1 }).replies[0]).toMatchObject({ ok: false, code: 'E_INVALID' });
    expect(world.captures.get(ev.captureId)?.state).toBe('open');
    const second = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    expect(second.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(submit(world, ev.captureId, { checksum: '00000000' }).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
  });

  it('times out after the tool deadline', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId, 'sniff');
    const results = idle(world, 40);
    expect(find(results, 'captureResult')).toMatchObject({ captureId: ev.captureId, ok: false, reason: 'timeout' });
  });

  it('fails with packet loss when the operator leaves tool range', () => {
    const { world, wildId } = setup();
    start(world, wildId, 'sniff');
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 5.5, y: 12.5 } }));
    const results = idle(world, 16);
    expect(find(results, 'captureResult')).toMatchObject({ ok: false, reason: 'packet_loss' });
  });

  it('fails with packet loss when the operator is hit', () => {
    const { world, wildId } = setup();
    start(world, wildId);
    const wild = world.daemons.get(wildId)!;
    wild.wild!.aggro = 'alice';
    const results = idle(world, 32);
    const res = find(results, 'captureResult') as CaptureResult | undefined;
    expect(res).toMatchObject({ ok: false, reason: 'packet_loss' });
  });

  it('refuses targets tagged by another operator and out-of-range targets', () => {
    const { world, wildId } = setup();
    world.addOperator(operatorRecord('bob'));
    const wild = world.daemons.get(wildId)!;
    wild.wild!.tagOwner = 'bob';
    wild.wild!.tagUntil = 10_000;
    expect(step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool: 'mirror' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    wild.wild!.tagOwner = null;
    wild.x = 20.5;
    wild.y = 28.5;
    expect(step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool: 'mirror' } })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });

  it('goes to Disk when RAM is full, and a persist failure refunds the tool', () => {
    const { world, wildId } = setup();
    const op = world.operators.get('alice')!;
    for (let s = 2; s < 8; s++) op.reservedSlots.add(s);
    const ev = start(world, wildId);
    const r = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    const intent = r.intents.find((i) => i.kind === 'capture')!;
    expect(intent).toMatchObject({ location: 'DISK' });
    world.completeIntent(intent.id, { ok: false, reason: 'db down' });
    expect(find([step(world)], 'captureResult')).toMatchObject({ ok: false, reason: 'persist_failed' });
    expect(op.inventory.mirror).toBe(2);
    expect(op.diskSlots.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/capture.test.ts`
Expected: FAIL — `capture` replies `E_STATE "capture is not implemented yet"`.

- [ ] **Step 3: Implement**

`apps/sim/src/core/systems/capture.ts`:

```ts
import {
  DISK_SLOTS,
  HARDENED_MS,
  RAM_SLOTS,
  TAG_WINDOW_MS,
  challengeSize,
  checkAnswer,
  generateChallenge,
  getSpecies,
  getTool,
  publicChallenge,
  statBlockToArray,
  xpYield,
  type ToolId,
} from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, type Capture, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import { toRamDaemon } from '../view.js';
import type { World } from '../world.js';
import { FLEE_MS } from './ai.js';
import { awardXp } from './progress.js';

export function startCapture(world: World, op: Operator, args: { targetId: string; tool: ToolId }, out: Out): string {
  if (op.captureId) throw new Rejection('E_STATE', 'a capture is already active');
  const tool = getTool(args.tool);
  if ((op.inventory[tool.id] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${tool.id} left`);
  const target = world.daemons.get(args.targetId);
  if (!target || !target.wild || !target.active || target.hp <= 0) throw new Rejection('E_STATE', 'not a wild daemon');
  if (target.wild.tagOwner !== null && target.wild.tagOwner !== op.id) throw new Rejection('E_STATE', 'tagged by another operator');
  if (distance(op, target) > tool.range) throw new Rejection('E_RANGE', 'target out of tool range');
  if (op.ram.length + op.reservedSlots.size >= RAM_SLOTS && op.diskSlots.size >= DISK_SLOTS) {
    throw new Rejection('E_STATE', 'RAM and Disk are full');
  }

  op.inventory[tool.id] = (op.inventory[tool.id] ?? 0) - 1;
  const tick = world.tick;
  target.wild.tagOwner = op.id;
  target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
  const size = challengeSize(
    {
      stage: getSpecies(target.species).stage,
      hpFraction: target.hp / target.stats.hp,
      clean: target.clean,
      signature: target.signature,
      hardened: target.wild.hardenedUntil > tick,
      statused: Object.values(target.statuses).some((until) => (until ?? 0) > tick),
    },
    tool,
  );
  const challenge = generateChallenge(target.types, size, tool.noise, world.rng);
  const capture: Capture = {
    id: world.newId('c'),
    operatorId: op.id,
    targetId: target.id,
    tool: tool.id,
    challenge,
    deadlineTick: tick + world.ticks(tool.deadlineMs),
    state: 'open',
  };
  world.captures.set(capture.id, capture);
  op.captureId = capture.id;
  out.emit(
    { e: 'captureStart', captureId: capture.id, targetId: target.id, challenge: publicChallenge(challenge), deadlineTick: capture.deadlineTick },
    { to: op.id },
  );
  return capture.id;
}

export function submitCapture(world: World, op: Operator, args: { captureId: string; answer?: unknown }, out: Out): 'correct' | 'wrong' {
  const cap = world.captures.get(args.captureId);
  if (!cap || cap.operatorId !== op.id || cap.state !== 'open') throw new Rejection('E_STATE', 'no open capture with that id');
  const result = checkAnswer(cap.challenge, args.answer);
  if (result === 'invalid') throw new Rejection('E_INVALID', 'answer does not match the expected shape');
  if (result === 'wrong') {
    failCapture(world, cap, 'wrong_answer', out);
    return 'wrong';
  }
  commitCapture(world, op, cap, out);
  return 'correct';
}

export function failCapture(world: World, cap: Capture, reason: 'wrong_answer' | 'timeout' | 'packet_loss', out: Out): void {
  world.captures.delete(cap.id);
  const op = world.operators.get(cap.operatorId);
  if (op) op.captureId = null;
  const target = world.daemons.get(cap.targetId);
  if (target?.wild && target.active) {
    target.wild.hardenedUntil = world.tick + world.ticks(HARDENED_MS);
    if (target.wild.behaviour === 'timid') target.wild.fleeUntil = world.tick + world.ticks(FLEE_MS);
  }
  out.emit({ e: 'captureResult', captureId: cap.id, ok: false, reason }, { to: cap.operatorId });
}

function commitCapture(world: World, op: Operator, cap: Capture, out: Out): void {
  const target = world.daemons.get(cap.targetId)!;
  const wild = target.wild!;
  const sp = getSpecies(target.species);
  const recipients = [...wild.damagedBy].filter((id) => op.ram.includes(id) && !world.daemons.get(id)!.crashed);
  awardXp(world, recipients, xpYield(sp.baseYield, target.level), out);

  let location: 'RAM' | 'DISK' = 'RAM';
  let slot = world.freeRamSlot(op);
  if (slot === null) {
    location = 'DISK';
    slot = 0;
    while (op.diskSlots.has(slot)) slot++;
    op.diskSlots.add(slot);
  } else {
    op.reservedSlots.add(slot);
  }

  const intent: Intent = {
    id: world.newId('i'),
    kind: 'capture',
    operatorId: op.id,
    captureId: cap.id,
    location,
    tool: cap.tool,
    daemon: {
      id: world.newId('d'),
      species: target.species,
      level: target.level,
      xp: target.xp,
      nature: target.nature,
      traitSlot: target.traitSlot,
      ivs: statBlockToArray(target.ivs),
      bonus: statBlockToArray(target.bonus),
      clean: target.clean,
      signature: target.signature,
      hp: Math.max(1, Math.floor(target.hp)),
      energy: Math.floor(target.energy),
      moves: [...target.moves],
      crashed: false,
      slot,
    },
    log: {
      originalOperatorId: op.id,
      capturedAtTick: world.tick,
      subnet: world.subnet.id,
      tool: cap.tool,
      seedId: world.seedId,
      spawnIndex: wild.spawnIndex,
    },
  };
  cap.state = 'committing';
  world.removeDaemon(target.id);
  world.trackIntent(intent, out);
}

export function completeCaptureIntent(world: World, op: Operator, intent: Extract<Intent, { kind: 'capture' }>, result: IntentResult, out: Out): void {
  world.captures.delete(intent.captureId);
  op.captureId = null;
  if (intent.location === 'RAM') op.reservedSlots.delete(intent.daemon.slot);
  if (!result.ok) {
    if (intent.location === 'DISK') op.diskSlots.delete(intent.daemon.slot);
    op.inventory[intent.tool] = (op.inventory[intent.tool] ?? 0) + 1;
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: false, reason: 'persist_failed' }, { to: op.id });
    return;
  }
  if (intent.location === 'RAM') {
    const d = world.addOwned(op, intent.daemon);
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: true, daemon: toRamDaemon(world, d) }, { to: op.id });
  } else {
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: true }, { to: op.id });
  }
}

export function progressCaptures(world: World, out: Out): void {
  for (const cap of [...world.captures.values()]) {
    if (cap.state !== 'open') continue;
    const op = world.operators.get(cap.operatorId);
    const target = world.daemons.get(cap.targetId);
    if (!op) {
      world.captures.delete(cap.id);
      continue;
    }
    if (!target || !target.active || target.hp <= 0 || op.hitTick === world.tick || distance(op, target) > getTool(cap.tool).range) {
      failCapture(world, cap, 'packet_loss', out);
    } else if (world.tick > cap.deadlineTick) {
      failCapture(world, cap, 'timeout', out);
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 13 test files, 113 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): capture challenges in the world"
```

---

### Task 7: Spawner, determinism and the tick budget

**Files:**
- Modify (replace stub): `apps/sim/src/core/systems/spawner.ts`
- Test: `apps/sim/test/world.test.ts`

**Interfaces:**
- Produces: `weightedPick(weights, rng)`, `runSpawner(world, out, initial)`.
- Rules implemented: at construction every region fills to its cap (16); afterwards each region respawns one daemon per 4096 ms while below cap. Species by weight, level uniform in the region's range, position a random walkable tile in the region, individual from `rollSpawn(world.rng, world.odds)`. Clean or signature spawns emit a server-wide `signatureSpawn` (`to: null, at: null`).

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/world.test.ts`:

```ts
import { LO } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, type Input } from '../src/core/index.js';
import { input, operatorRecord, self } from './helpers.js';

function loWorld(seed: string, odds?: { clean: number; signatureStep: number }): World {
  return new World({ subnet: LO, seed, seedId: 'seed0001', ...(odds ? { odds } : {}) });
}

/** A scripted bot: runs its starter, then wanders between two points and attacks what it can reach. */
function botInputs(world: World, opId: string, tick: number): Input[] {
  const op = world.operators.get(opId)!;
  const inputs: Input[] = [];
  if (tick === 1) inputs.push(input(opId, { cmd: 'run', actor: self, args: { daemonId: `${opId}-d0` } }));
  if (op.path.length === 0) {
    const dest = tick % 400 < 200 ? { x: 40.5, y: 20.5 } : { x: 20.5, y: 20.5 };
    inputs.push(input(opId, { cmd: 'moveTo', actor: self, args: dest }));
  }
  const mine = world.daemons.get(`${opId}-d0`);
  if (mine?.active) {
    const near = [...world.daemons.values()].find((d) => d.wild && d.active && Math.hypot(d.x - mine.x, d.y - mine.y) <= 2);
    if (near) inputs.push(input(opId, { cmd: 'use', actor: mine.id, args: { move: 'ping', targetId: near.id } }));
  }
  return inputs;
}

function run(seed: string, ticks: number): string {
  const world = loWorld(seed);
  world.addOperator(operatorRecord('alice', { x: 20.5, y: 20.5 }));
  world.addOperator(operatorRecord('bob', { x: 22.5, y: 20.5 }));
  const log: unknown[] = [];
  for (let t = 1; t <= ticks; t++) {
    const r = world.step([...botInputs(world, 'alice', t), ...botInputs(world, 'bob', t)]);
    log.push(r.events.map((e) => e.event), r.replies.map((x) => (x.ok ? 'ok' : x.code)));
  }
  return JSON.stringify(log);
}

describe('World on lo', () => {
  it('fills all four regions to their cap at start', () => {
    const world = loWorld('fill');
    expect(world.regionCounts).toEqual([16, 16, 16, 16]);
    const wild = [...world.daemons.values()].filter((d) => d.wild);
    expect(wild).toHaveLength(64);
    for (const d of wild) {
      const region = LO.regions[d.wild!.region]!;
      expect(d.level).toBeGreaterThanOrEqual(region.levels[0]);
      expect(d.level).toBeLessThanOrEqual(region.levels[1]);
    }
  });

  it('announces clean and signature spawns server-wide', () => {
    const world = loWorld('shiny', { clean: 1, signatureStep: 0.5 });
    const first = world.step([]);
    const shiny = first.events.filter((e) => e.event.e === 'signatureSpawn');
    expect(shiny).toHaveLength(64);
    expect(shiny.every((e) => e.to === null && e.at === null)).toBe(true);
  });

  it('respawns one daemon per region every 4096 ms while below cap', () => {
    const world = loWorld('respawn');
    const victim = [...world.daemons.values()].find((d) => d.wild?.region === 0)!;
    world.removeDaemon(victim.id);
    expect(world.regionCounts[0]).toBe(15);
    for (let i = 0; i < 70; i++) world.step([]);
    expect(world.regionCounts[0]).toBe(16);
  });

  it('is deterministic: the same seed and inputs give the same event stream', () => {
    expect(run('replay', 600)).toEqual(run('replay', 600));
    expect(run('replay', 200)).not.toEqual(run('other', 200));
  });

  it('entitiesNear returns operators and active daemons within the radius', () => {
    const world = loWorld('near');
    world.addOperator(operatorRecord('alice', { x: 20.5, y: 20.5 }));
    const near = entitiesNear(world, 20.5, 20.5);
    expect(near.some((e) => e.kind === 'operator' && e.id === 'alice')).toBe(true);
    for (const e of near) expect(Math.hypot(e.x - 20.5, e.y - 20.5)).toBeLessThanOrEqual(32);
  });

  it('steps 64 operators with 2 running daemons each within budget', () => {
    const world = loWorld('load');
    for (let i = 0; i < 64; i++) {
      world.addOperator(operatorRecord(`op${i}`, { x: 20.5 + (i % 8) * 4, y: 12.5 + Math.floor(i / 8) * 4 }));
    }
    const durations: number[] = [];
    for (let t = 1; t <= 160; t++) {
      const inputs: Input[] = [];
      for (let i = 0; i < 64; i++) {
        const id = `op${i}`;
        if (t === 1) inputs.push(input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } }));
        if (t === 70) inputs.push(input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d1` } }));
        if (t % 32 === 2) inputs.push(input(id, { cmd: 'moveTo', actor: self, args: { x: 20.5 + ((i * 7 + t) % 36), y: 12.5 + ((i * 5 + t) % 36) } }));
      }
      const t0 = performance.now();
      world.step(inputs);
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)]!;
    expect(p99).toBeLessThan(32);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/world.test.ts`
Expected: FAIL — `regionCounts` is `[0, 0, 0, 0]`.

- [ ] **Step 3: Implement**

`apps/sim/src/core/systems/spawner.ts`:

```ts
import { rollSpawn, type RegionDef, type Rng } from '@daemonet/rules';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export function weightedPick(weights: Readonly<Record<string, number>>, rng: Rng): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.int(1, total);
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function spawnOne(world: World, index: number, region: RegionDef, out: Out): void {
  const species = weightedPick(region.species, world.rng);
  const level = world.rng.int(region.levels[0], region.levels[1]);
  const pos = world.grid.randomWalkableIn(region.rect, world.rng);
  if (!pos) return;
  const roll = rollSpawn(world.rng, world.odds);
  const d = world.spawnWild(species, level, pos, index, roll);
  if (d.clean || d.signature > 0) {
    out.emit({ e: 'signatureSpawn', daemon: d.id, species, signature: d.signature, clean: d.clean }, { at: null });
  }
}

/** initial: fill every region to its cap. Otherwise: one respawn per region per interval while below cap. */
export function runSpawner(world: World, out: Out, initial: boolean): void {
  world.subnet.regions.forEach((region, i) => {
    if (initial) {
      while (world.regionCounts[i]! < region.cap) {
        const before = world.regionCounts[i]!;
        spawnOne(world, i, region, out);
        if (world.regionCounts[i] === before) break;
      }
      world.nextSpawnTick[i] = world.tick + world.ticks(region.respawnMs);
      return;
    }
    if (world.tick < world.nextSpawnTick[i]!) return;
    world.nextSpawnTick[i] = world.tick + world.ticks(region.respawnMs);
    if (world.regionCounts[i]! < region.cap) spawnOne(world, i, region, out);
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 14 test files, 119 tests. The load test (64 operators, 128 running daemons, 64 wild) must keep p99 step time under 32 ms; on the development machine it is typically a few milliseconds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): region spawner, replay determinism and tick budget"
```

---

### Task 8: Push and verify CI

**Files:** none.

- [ ] **Step 1: Confirm the core stays pure**

Run: `git grep -nE "new Date|Date\.now|performance\.|Math\.random|setTimeout|setInterval|from 'node:" -- apps/sim/src/core`
Expected: no output.

- [ ] **Step 2: Confirm no solver is reachable from src**

Run: `git grep -n "solvers" -- apps/sim/src packages/rules/src`
Expected: no output.

- [ ] **Step 3: Push and watch CI**

```bash
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: `CI` passes.
