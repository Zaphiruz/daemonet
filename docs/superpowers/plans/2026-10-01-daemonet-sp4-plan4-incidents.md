# Daemonet SP4 · Plan 4 — Incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled raid bosses: every four hours (and whenever an admin says so) a kernel daemon — a capstone at level 64 with eight times its HP — appears in `kernelspace` for twenty minutes. Anyone can hit it; it shields at 75 / 50 / 25 % until its adds are cleared and throws telegraphed blasts; when it falls, an 8192-bit pool is split by damage and every contributor gets a personal copy of the boss that only they can capture.

**Architecture:** Schedule, constants and the payout maths are pure content in `rules` (`content/incidents.ts`). The fight is a small state machine in the sim core (`systems/incident.ts`), stepped only in the kernelspace world right after moves resolve: `idle → open → fighting → cleared | expired`. Three flags on `WildState` do the heavy lifting — `open` (anyone may hit, nobody owns the tag, immune to capture: the boss and its adds), `boss`, and `personal` (a copy only one operator may touch, with a despawn tick). Payouts are sim-raised `incidentReward` intents (ledger reason `incident`), credited in memory only on commit. `Game` keeps Incident gateways closed unless the destination has a running Incident with room, forwards `incident` events to every world, records the Incident row through the store, and starts one on the bus message `admin { kind: 'incident:start' }`. Operators left in kernelspace after the window (plus the copies' four minutes) are sent back to backbone with a forced `travel` intent.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP4 plans 1–3 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp4-social-design.md` §3 (Incidents row), §8. Decisions fixed here: the boss gives no XP and holds no tag; adds are level-40 base forms of the boss's line and also `open`; the telegraph targets a random operator within 48 tiles of the boss every 16 s once the fight has started; contribution is damage dealt to the boss only; the 16-operator cap is enforced by closing the gateway; eviction lands at backbone's spawn point; an admin-started Incident does not move the schedule.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Incident rewards are paid exactly once per contributor (idempotent intents, ledger rows with `ref` = incident id).
- A personal copy is a fresh spawn roll (`rollSpawn(world.rng, world.odds)`): it can be clean or carry a signature like any encounter, and only its owner can hit or capture it.

## File map

```
packages/rules/src/content/incidents.ts     schedule, constants, bossSpecies, lineBase, incidentPayouts
packages/rules/src/content/subnets.ts       KERNELSPACE, GatewayDef.incidentOnly, SubnetDef.arena, HOSTED_SUBNET_IDS
packages/rules/src/content/tickets.ts       deliveries never target Incident gateways
packages/db/prisma/schema.prisma            Incident (+ migration 20260930000007)
packages/shared/src/protocol.ts             incident / telegraph / incidentReward events, DaemonEntity.boss / shielded
apps/sim/src/core/systems/incident.ts       stepIncident, noteBossHit
apps/sim/src/core/{model,world,view}.ts     WildState flags, IncidentState, world fields, completion
apps/sim/src/core/systems/{combat,capture,upkeep,commands}.ts   open / personal targets, shield, despawn, closed gateways
apps/sim/src/runtime/{game,store,prisma-store,config}.ts        gating, fan-out, records, admin start, default SUBNETS
apps/api/src/routes/incidents.ts            /api/incidents, /api/incidents/:id, /api/admin/incidents/start
apps/frontend/src/game/incident.ts, TopBar banner, map boss ring + telegraph circles, admin view
```

---

### Task 1: Content — schedule, payouts, kernelspace

**Files:**
- Create: `packages/rules/src/content/incidents.ts`, `packages/rules/test/incidents.test.ts`
- Modify: `packages/rules/src/content/subnets.ts`, `packages/rules/src/content/tickets.ts`, `packages/rules/src/index.ts`, `packages/rules/test/subnets.test.ts`, `apps/sim/src/runtime/config.ts`, `scripts/provision-secrets.sh`

**Interfaces:**
- `INCIDENT_SUBNET = 'kernelspace'`, `INCIDENT_PERIOD_MS` (4 h), `INCIDENT_WINDOW_MS` (20 min), `INCIDENT_MAX_OPERATORS = 16`, `BOSS_LEVEL = 64`, `BOSS_HP_MULTIPLIER = 8`, `BOSS_PHASES = [0.75, 0.5, 0.25]`, `ADDS_PER_PHASE = 4`, `ADD_LEVEL = 40`, `TELEGRAPH_EVERY_MS = 16000`, `TELEGRAPH_DELAY_MS = 2000`, `TELEGRAPH_RADIUS = 6`, `TELEGRAPH_DAMAGE = 0.25`, `INCIDENT_POOL = 8192`, `INCIDENT_MIN_SHARE = 0.01`, `INCIDENT_MIN_REWARD = 64`, `COPY_LEVEL = 48`, `COPY_TTL_MS` (4 min).
- `nextIncidentStart(nowMs)`, `incidentNumber(startMs)`, `KERNEL_DAEMONS`, `bossSpecies(n)`, `lineBase(speciesId)`, `incidentPayouts(damage: Map<operatorId, number>, pool?) → [{ operatorId, damage, share, reward }]`.
- `GatewayDef.incidentOnly?`, `SubnetDef.arena?: { x, y, radius }`, `KERNELSPACE`, `OPEN_SUBNET_IDS` (subnets with spawn regions), `HOSTED_SUBNET_IDS` (all seven).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { INCIDENT_PERIOD_MS, KERNEL_DAEMONS, bossSpecies, incidentNumber, incidentPayouts, lineBase, nextIncidentStart } from '../src/content/incidents.js';
import { getSpecies } from '../src/content/species.js';
import { HOSTED_SUBNET_IDS, OPEN_SUBNET_IDS, getGateway, getSubnet } from '../src/content/subnets.js';
import { ticketBoard } from '../src/content/tickets.js';

describe('incident schedule', () => {
  it('starts on every multiple of four hours UTC', () => {
    const t = Date.parse('2026-10-01T05:30:00Z');
    expect(new Date(nextIncidentStart(t)).toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(nextIncidentStart(Date.parse('2026-10-01T08:00:00Z'))).toBe(Date.parse('2026-10-01T08:00:00Z'));
    expect(incidentNumber(nextIncidentStart(t) + INCIDENT_PERIOD_MS) - incidentNumber(nextIncidentStart(t))).toBe(1);
  });

  it('rotates capstones as the kernel daemon; adds are the base form of its line', () => {
    expect(KERNEL_DAEMONS.length).toBeGreaterThanOrEqual(4);
    for (const id of KERNEL_DAEMONS) expect(getSpecies(id).capstone).toBe(true);
    expect(bossSpecies(0)).toBe(KERNEL_DAEMONS[0]);
    expect(bossSpecies(KERNEL_DAEMONS.length + 1)).toBe(KERNEL_DAEMONS[1]);
    expect(lineBase('pidzero')).toBe('initling');
    expect(getSpecies(lineBase('pingodeth')).stage).toBe(0);
  });
});

describe('incidentPayouts', () => {
  it('splits the pool by damage, drops contributors under 1% and guarantees 64 bits to the rest', () => {
    const p = incidentPayouts(new Map([['a', 6000], ['b', 3000], ['c', 950], ['d', 50]]));
    expect(p.map((x) => x.operatorId)).toEqual(['a', 'b', 'c']);
    expect(p[0]).toMatchObject({ share: 0.6, reward: 4915 });
    expect(p[1]!.reward).toBe(2457);
    expect(p[2]!.reward).toBe(778);
    expect(incidentPayouts(new Map([['a', 9900], ['b', 100]]))[1]).toMatchObject({ operatorId: 'b', reward: 81 });
    expect(incidentPayouts(new Map([['a', 9950], ['b', 105]]), 1000)[1]!.reward).toBe(64);
    expect(incidentPayouts(new Map())).toEqual([]);
  });
});

describe('kernelspace', () => {
  it('is hosted but not an open subnet: no spawns, reachable only through the Incident gateway from backbone', () => {
    expect(OPEN_SUBNET_IDS).not.toContain('kernelspace');
    expect(HOSTED_SUBNET_IDS).toEqual([...OPEN_SUBNET_IDS, 'kernelspace']);
    const ks = getSubnet('kernelspace');
    expect(ks.regions).toEqual([]);
    expect(ks.arena).toBeDefined();
    expect(getGateway('backbone', 'backbone-kernelspace')).toMatchObject({ to: 'kernelspace', incidentOnly: true, requires: { level: 32 } });
    expect(getGateway('kernelspace', 'kernelspace-backbone')).toMatchObject({ to: 'backbone' });
  });

  it('ticket boards never deliver to kernelspace', () => {
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
      for (const t of ticketBoard('backbone', day)) if (t.params.kind === 'deliver') expect(t.params.to).not.toBe('kernelspace');
    }
  });
});
```

In `packages/rules/test/subnets.test.ts` the backbone gateway list gains `['kernelspace', 32]` as its last entry.

- [ ] **Step 2: Content**

Create `packages/rules/src/content/incidents.ts`:

```ts
import { BESTIARY } from './bestiary.js';

/** Incidents (SP4 spec §8): a kernel-daemon boss in `kernelspace` every four hours, twenty minutes to clear it. */
export const INCIDENT_SUBNET = 'kernelspace';
export const INCIDENT_PERIOD_MS = 4 * 3_600_000;
export const INCIDENT_WINDOW_MS = 20 * 60_000;
export const INCIDENT_MAX_OPERATORS = 16;

export const BOSS_LEVEL = 64;
export const BOSS_HP_MULTIPLIER = 8;
/** HP fractions at which the boss shields and calls adds. */
export const BOSS_PHASES: readonly number[] = [0.75, 0.5, 0.25];
export const ADDS_PER_PHASE = 4;
export const ADD_LEVEL = 40;

export const TELEGRAPH_EVERY_MS = 16_000;
export const TELEGRAPH_DELAY_MS = 2_000;
export const TELEGRAPH_RADIUS = 6;
/** Fraction of max HP a telegraphed blast takes from every running daemon in the circle. */
export const TELEGRAPH_DAMAGE = 0.25;

export const INCIDENT_POOL = 8192;
export const INCIDENT_MIN_SHARE = 0.01;
export const INCIDENT_MIN_REWARD = 64;
export const COPY_LEVEL = 48;
export const COPY_TTL_MS = 4 * 60_000;

/** Start (ms) of the first scheduled Incident at or after `nowMs`: every multiple of four hours UTC. */
export function nextIncidentStart(nowMs: number): number {
  return Math.ceil(nowMs / INCIDENT_PERIOD_MS) * INCIDENT_PERIOD_MS;
}

/** Sequence number of the Incident that starts at `startMs`. */
export function incidentNumber(startMs: number): number {
  return Math.floor(startMs / INCIDENT_PERIOD_MS);
}

/** Capstone species take turns as the kernel daemon. */
export const KERNEL_DAEMONS: readonly string[] = BESTIARY.filter((r) => r.capstone).map((r) => r.id);

export function bossSpecies(n: number): string {
  return KERNEL_DAEMONS[((n % KERNEL_DAEMONS.length) + KERNEL_DAEMONS.length) % KERNEL_DAEMONS.length]!;
}

/** The base form of a species' line (what the boss calls as adds). */
export function lineBase(speciesId: string): string {
  const line = BESTIARY.find((r) => r.id === speciesId)?.line;
  return BESTIARY.find((r) => r.line === line && r.stage === 0)!.id;
}

export interface IncidentPayout {
  operatorId: string;
  damage: number;
  share: number;
  reward: number;
}

/**
 * Splits the pool by damage share. Operators under 1% get nothing; everyone else gets at least 64 bits.
 * Rewards are floored, so the total never exceeds pool + 64 × contributors.
 */
export function incidentPayouts(damage: ReadonlyMap<string, number>, pool = INCIDENT_POOL): IncidentPayout[] {
  const total = [...damage.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return [...damage.entries()]
    .map(([operatorId, d]) => ({ operatorId, damage: d, share: d / total }))
    .filter((p) => p.share >= INCIDENT_MIN_SHARE)
    .map((p) => ({ ...p, reward: Math.max(INCIDENT_MIN_REWARD, Math.floor(pool * p.share)) }))
    .sort((a, b) => b.damage - a.damage);
}
```

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
  /** Only usable while an Incident is open in the destination (SP4). */
  incidentOnly?: boolean;
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
  /** Boss arena centre (kernelspace only). */
  arena?: { x: number; y: number; radius: number };
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
  { ...gate('backbone-kernelspace', { x: 122.5, y: 64.5 }, 'kernelspace', { x: 66.5, y: 112.5 }, 32), incidentOnly: true },
]);
export const DARKNET = subnet('darknet', 4, ['null', 'glitch', 'proxy', 'crypto'], [2, 3], 32, [gate('darknet-backbone', CORNER_NW, 'backbone', ARRIVE_NE, 0)]);
export const CLOUDNET = subnet('cloudnet', 4, ['cloud', 'cache', 'heap', 'stack'], [2, 3], 40, [gate('cloudnet-backbone', CORNER_NW, 'backbone', ARRIVE_SE, 0)]);

/** Incidents (SP4 spec §8): an open floor with the boss arena in the north and the host in the south; nothing spawns on its own. */
export const KERNELSPACE: SubnetDef = {
  id: 'kernelspace',
  tier: 5,
  width: 128,
  height: 128,
  walls: [],
  host: { x: 64.5, y: 112.5 },
  spawn: { x: 66.5, y: 112.5 },
  regions: [],
  gateways: [gate('kernelspace-backbone', { x: 64.5, y: 122.5 }, 'backbone', { x: 120.5, y: 64.5 }, 0)],
  arena: { x: 64.5, y: 40.5, radius: 24 },
};

export const SUBNETS: readonly SubnetDef[] = [LO, LAN, DMZ, BACKBONE, DARKNET, CLOUDNET, KERNELSPACE];
/** Open-world subnets (tickets, spawns). */
export const OPEN_SUBNET_IDS: readonly string[] = SUBNETS.filter((s) => s.regions.length > 0).map((s) => s.id);
/** What one sim process hosts by default: the open subnets plus kernelspace (the sandbox comes with SP6). */
export const HOSTED_SUBNET_IDS: readonly string[] = SUBNETS.map((s) => s.id);

export function getSubnet(id: string): SubnetDef {
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}

export function getGateway(subnetId: string, gatewayId: string): GatewayDef | undefined {
  return getSubnet(subnetId).gateways.find((g) => g.id === gatewayId);
}
```

In `packages/rules/src/content/tickets.ts` deliveries skip Incident gateways:

```ts
      const to = rng.pick(getSubnet(subnetId).gateways.filter((g) => !g.incidentOnly).map((g) => g.to));
```

Export the new module from `packages/rules/src/index.ts`. The sim's default `SUBNETS` becomes `HOSTED_SUBNET_IDS.join(',')` (`apps/sim/src/runtime/config.ts`), and `scripts/provision-secrets.sh` seeds `"SUBNETS": "lo,lan,dmz,backbone,darknet,cloudnet,kernelspace"`.

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules apps/sim/test/layout.test.ts` — expected: green (kernelspace walks too).

```bash
git add packages/rules apps/sim/src/runtime/config.ts scripts/provision-secrets.sh
git commit -m "feat(rules): Incident schedule and payouts, kernelspace subnet"
```

---

### Task 2: The fight in the sim

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000007_sp4_incidents/migration.sql`
- Modify: `packages/shared/src/protocol.ts`
- Create: `apps/sim/src/core/systems/incident.ts`, `apps/sim/test/incident.test.ts`
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/index.ts`, `apps/sim/src/core/systems/combat.ts`, `apps/sim/src/core/systems/capture.ts`, `apps/sim/src/core/systems/upkeep.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/runtime/game.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`

**Interfaces:**
- Events: `incident { phase: open | fighting | shield | unshield | cleared | expired, id, n, species, endsAt, bossId, participants? }` (server-wide), `telegraph { x, y, radius, atTick }`, `incidentReward { incidentId, reward, share }`; `DaemonEntity.boss?`, `shielded?`.
- `WildState.boss?`, `open?`, `personal?: operatorId`, `despawnAtTick?`; `IncidentState { id, n, species, phase, bossId, openedAtMs, endsAtMs, shield, nextPhase, adds, damage, nextTelegraphTick, telegraph }`.
- World: `incident`, `nextIncidentAt`, `incidentRequested`, `incidentCount`, `incidentClosedAtMs`, `closedGateways: Set<string>`, `nowMs()`; intent `incidentReward { incidentId, n, species, reward, damage, share }` (sim-raised).
- `stepIncident(world, out)` (called in `World.step` after `executeQueuedUses`, before `resolveDefeats`), `noteBossHit(world, operatorId, amount, out)`.
- Store: `recordIncident(row: IncidentRow)` (upsert), `applyIntent('incidentReward')`.
- Game: `startIncident(): boolean`; `gateIncidentGateways()` each tick; `incident` events forwarded to the other worlds and recorded.

- [ ] **Step 1: Schema, migration, protocol**

Schema (before `enum OrgRank`):

```prisma
enum IncidentOutcome {
  OPEN
  CLEARED
  EXPIRED
}

/// Incidents (SP4 spec §8): one row per boss window; participants are filled when it is cleared.
model Incident {
  id           String          @id
  n            Int
  species      String
  openedAt     DateTime        @default(now())
  endsAt       DateTime
  closedAt     DateTime?
  outcome      IncidentOutcome @default(OPEN)
  /// [{ operatorId, name, damage, share, reward }]
  participants Json            @default("[]")

  @@index([openedAt])
}
```

Migration:

```sql
-- CreateEnum
CREATE TYPE "IncidentOutcome" AS ENUM ('OPEN', 'CLEARED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "species" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "outcome" "IncidentOutcome" NOT NULL DEFAULT 'OPEN',
    "participants" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_openedAt_idx" ON "Incident"("openedAt");
```

Protocol events (end of the `GameEvent` union):

```ts
  /** Incident lifecycle, sent to everyone on the server (SP4 spec §8). */
  z.object({
    e: z.literal('incident'),
    phase: z.enum(['open', 'fighting', 'shield', 'unshield', 'cleared', 'expired']),
    id: Id,
    n: z.number().int(),
    species: z.string(),
    endsAt: z.string(),
    bossId: Id.nullable(),
    participants: z.array(z.object({ operatorId: Id, name: z.string().nullable(), damage: z.number().int(), share: z.number(), reward: z.number().int() })).optional(),
  }),
  /** A blast lands on this circle at `atTick`: move your daemons (and yourself) out. */
  z.object({ e: z.literal('telegraph'), x: Coord, y: Coord, radius: z.number(), atTick: z.number().int() }),
  z.object({ e: z.literal('incidentReward'), incidentId: Id, reward: z.number().int(), share: z.number() }),
```

and on `DaemonEntity`, before `scan`:

```ts
  /** Incident boss (kernel daemon); `shielded` while its adds are alive. */
  boss: z.boolean().optional(),
  shielded: z.boolean().optional(),
```

- [ ] **Step 2: Failing tests**

```ts
import { MemoryBus } from '@daemonet/bus';
import { BOSS_HP_MULTIPLIER, COPY_TTL_MS, INCIDENT_WINDOW_MS, KERNEL_DAEMONS, getSubnet, lineBase } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, type Daemon, type StepResult } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { input, operatorRecord, ownedRecord, self } from './helpers.js';

const KS = getSubnet('kernelspace');
const ARENA = KS.arena!;

/**
 * A kernelspace world on a hand-cranked clock: created one minute before a scheduled Incident, stepped onto the
 * four-hour mark (the Incident opens), and only then entered by the operators — anyone in kernelspace with no
 * Incident running is sent back to backbone.
 */
function setup(operators = ['alice', 'bob']) {
  let now = Date.parse('2026-10-01T03:59:00.000Z');
  const world = new World({ subnet: KS, seed: 'inc', seedId: 'seed0009', spawner: false, clock: () => new Date(now).toISOString() });
  const idle = world.step([]);
  now += 60_000;
  const opened = world.step([]);
  for (const id of operators) {
    world.addOperator(operatorRecord(id, { subnet: 'kernelspace', x: ARENA.x, y: ARENA.y + 3, ram: [ownedRecord('pingling', 64, 0, `${id}-d0`)] }));
    world.step([input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } })]);
  }
  const events = (r: StepResult) => r.events.map((e) => e.event);
  const incidentEvents = (r: StepResult) => events(r).filter((e): e is Extract<GameEvent, { e: 'incident' }> => e.e === 'incident');
  const hitBoss = (who: string, boss: Daemon) => {
    const d = world.daemons.get(`${who}-d0`)!;
    d.cooldowns = {};
    d.energy = 128;
    d.x = boss.x + 1;
    d.y = boss.y;
    return world.step([input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: boss.id } })]);
  };
  return { world, idle, opened, advance: (ms: number) => (now += ms), events, incidentEvents, hitBoss };
}

describe('Incident lifecycle', () => {
  it('opens on the four-hour mark with a capstone boss at eight times its HP, open to everyone and immune to capture', () => {
    const { world, idle, opened, incidentEvents, hitBoss } = setup();
    expect(incidentEvents(idle)).toEqual([]);
    const inc = world.incident!;
    expect(incidentEvents(opened)).toMatchObject([{ phase: 'open', id: inc.id, species: inc.species, bossId: inc.bossId, endsAt: '2026-10-01T04:20:00.000Z' }]);
    expect(KERNEL_DAEMONS).toContain(inc.species);
    const boss = world.daemons.get(inc.bossId)!;
    expect(boss.level).toBe(64);
    expect(boss.hp).toBe(boss.stats.hp);
    expect(boss.wild).toMatchObject({ boss: true, open: true, tagOwner: null });
    const base = new World({ subnet: KS, seed: 'x', seedId: 'seed000a', spawner: false }).spawnWild(inc.species, 64, { x: 5, y: 5 }, -1, { ...world.daemons.get('alice-d0')!, ivs: boss.ivs, bonus: boss.bonus, nature: boss.nature, traitSlot: boss.traitSlot, clean: false, signature: 0 });
    expect(boss.stats.hp).toBe(base.stats.hp * BOSS_HP_MULTIPLIER);
    expect((entitiesNear(world, boss.x, boss.y, 8).find((e) => e.id === boss.id) as { boss?: boolean; shielded?: boolean })).toMatchObject({ boss: true, shielded: false });

    const first = hitBoss('alice', boss);
    expect(incidentEvents(first)).toMatchObject([{ phase: 'fighting' }]);
    expect(boss.wild!.tagOwner).toBeNull();
    expect(hitBoss('bob', boss).replies[0]).toMatchObject({ ok: true });
    expect([...inc.damage.keys()].sort()).toEqual(['alice', 'bob']);
    expect(world.step([input('alice', { cmd: 'capture', actor: self, args: { targetId: boss.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'immune to capture' });
  });

  it('shields at 75% and calls four adds of the line’s base form; the shield drops when they are cleared', () => {
    const { world, incidentEvents, hitBoss } = setup();
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    boss.hp = Math.floor(boss.stats.hp * 0.75);
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'shield' }]);
    expect(inc.adds).toHaveLength(4);
    for (const id of inc.adds) expect(world.daemons.get(id)).toMatchObject({ species: lineBase(inc.species), level: 40 });
    const hp = boss.hp;
    const blocked = hitBoss('alice', boss);
    expect(boss.hp).toBe(hp);
    expect(blocked.events.map((e) => e.event).find((e) => e.e === 'hit' && e.target === boss.id)).toMatchObject({ amount: 0 });
    for (const id of inc.adds) world.daemons.get(id)!.hp = 0;
    const cleared = world.step([]);
    expect(incidentEvents(cleared)).toMatchObject([{ phase: 'unshield' }]);
    hitBoss('alice', boss);
    expect(boss.hp).toBeLessThan(hp);
    boss.hp = Math.floor(boss.stats.hp * 0.5);
    expect(incidentEvents(world.step([]))).toMatchObject([{ phase: 'shield' }]);
  });

  it('telegraphs a blast two seconds ahead that takes a quarter of max HP from running daemons in the circle', () => {
    const { world, events, hitBoss } = setup(['alice']);
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    boss.statuses.stalled = 1_000_000;
    boss.moves = [];
    hitBoss('alice', boss);
    let warn: Extract<GameEvent, { e: 'telegraph' }> | undefined;
    for (let i = 0; i < 300 && !warn; i++) warn = events(world.step([])).find((e): e is Extract<GameEvent, { e: 'telegraph' }> => e.e === 'telegraph');
    expect(warn).toMatchObject({ radius: 6 });
    expect(warn!.atTick - world.tick).toBe(world.ticks(2000));
    const d = world.daemons.get('alice-d0')!;
    d.x = warn!.x;
    d.y = warn!.y;
    d.path = [];
    d.hp = d.stats.hp;
    const op = world.operators.get('alice')!;
    Object.assign(op, { x: warn!.x, y: warn!.y, path: [] });
    let blast: StepResult | undefined;
    while (world.tick < warn!.atTick) blast = world.step([]);
    expect(events(blast!).find((e) => e.e === 'hit' && e.move === 'telegraph')).toMatchObject({ target: 'alice-d0', amount: Math.ceil(d.stats.hp * 0.25) });
    expect(d.hp).toBe(d.stats.hp - Math.ceil(d.stats.hp * 0.25));
    expect(op.hitTick).toBe(world.tick);
  });

  it('pays the pool by contribution when the boss falls and gives each contributor a personal copy only they can touch', async () => {
    const { world, events, incidentEvents, hitBoss } = setup();
    const store = new MemoryStore();
    for (const id of ['alice', 'bob']) store.operators.set(id, { id, sub: id, name: id, starterClaimed: true, subnet: 'kernelspace', bits: 0, diskCapacity: 256, x: 0, y: 0, inventory: {} });
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    hitBoss('bob', boss);
    inc.damage.set('alice', 7500);
    inc.damage.set('bob', 2500);
    inc.nextPhase = 3;
    boss.hp = 0;
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'cleared', bossId: null, participants: [{ operatorId: 'alice', name: 'alice', share: 0.75, reward: 6144 }, { operatorId: 'bob', reward: 2048 }] }]);
    expect(world.incident).toBeNull();
    expect(world.daemons.has(boss.id)).toBe(false);
    const rewards = r.intents.filter((i) => i.kind === 'incidentReward');
    expect(rewards).toHaveLength(2);
    for (const i of rewards) world.completeIntent(i.id, await store.applyIntent(i, { seedId: 'seed0009' }));
    const after = events(world.step([]));
    expect(after).toContainEqual({ e: 'incidentReward', incidentId: inc.id, reward: 6144, share: 0.75 });
    expect(after).toContainEqual({ e: 'bits', delta: 6144, reason: 'incident', balance: 6144 });
    expect(world.operators.get('bob')!.bits).toBe(2048);
    expect(store.ledger.map((l) => [l.operatorId, l.delta, l.reason])).toEqual([['alice', 6144, 'incident'], ['bob', 2048, 'incident']]);

    const copies = [...world.daemons.values()].filter((d) => d.wild?.personal);
    expect(copies.map((c) => [c.species, c.level, c.wild!.personal]).sort()).toEqual([[inc.species, 48, 'alice'], [inc.species, 48, 'bob']]);
    const mine = copies.find((c) => c.wild!.personal === 'alice')!;
    const use = (who: string) => {
      const d = world.daemons.get(`${who}-d0`)!;
      Object.assign(d, { cooldowns: {}, x: mine.x + 1, y: mine.y });
      return world.step([input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: mine.id } })]).replies[0];
    };
    expect(use('bob')).toMatchObject({ code: 'E_STATE' });
    expect(use('alice')).toMatchObject({ ok: true });
    const bobOp = world.operators.get('bob')!;
    Object.assign(bobOp, { x: mine.x, y: mine.y });
    expect(world.step([input('bob', { cmd: 'capture', actor: self, args: { targetId: mine.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    Object.assign(world.operators.get('alice')!, { x: mine.x, y: mine.y });
    expect(world.step([input('alice', { cmd: 'capture', actor: self, args: { targetId: mine.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ ok: true });
    // the other copy despawns after four minutes
    const other = copies.find((c) => c.wild!.personal === 'bob')!;
    other.wild!.despawnAtTick = world.tick + 1;
    world.step([]);
    world.step([]);
    expect(world.daemons.has(other.id)).toBe(false);
  });

  it('expires after twenty minutes, then sends everyone back to backbone', () => {
    const { world, advance, incidentEvents } = setup(['alice']);
    const inc = world.incident!;
    advance(INCIDENT_WINDOW_MS);
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'expired', id: inc.id }]);
    expect(world.daemons.has(inc.bossId)).toBe(false);
    expect(world.step([]).intents).toEqual([]);
    advance(COPY_TTL_MS + 6_000);
    const evict = world.step([]);
    expect(evict.intents).toMatchObject([{ kind: 'travel', operatorId: 'alice', to: 'backbone', gatewayId: 'evict' }]);
    expect(world.operators.get('alice')!).toMatchObject({ travelling: true, running: [] });
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

describe('Incidents through the Game', () => {
  it('admin start opens one, announces it in every world, opens the backbone gateway and records it; the gateway closes again afterwards', async () => {
    let now = Date.parse('2026-10-01T05:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const backbone = new World({ subnet: getSubnet('backbone'), seed: 'b', seedId: 'bbbb0001', spawner: false, clock });
    const ks = new World({ subnet: KS, seed: 'k', seedId: 'kkkk0002', spawner: false, clock });
    const game = new Game({ worlds: [backbone, ks], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
    game.tick();
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(true);
    await bus.publish('admin', { kind: 'incident:start' });
    game.tick();
    expect(ks.incident).not.toBeNull();
    game.tick();
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(false);
    const seen = conn.of('delta').flatMap((d) => d.d.events).filter((e) => e.e === 'incident');
    expect(seen).toMatchObject([{ phase: 'open', species: ks.incident!.species }]);
    await game.flush();
    expect([...store.incidents.values()]).toMatchObject([{ outcome: 'OPEN', species: ks.incident!.species }]);
    const id = ks.incident!.id;
    now += INCIDENT_WINDOW_MS;
    game.tick();
    game.tick();
    await game.flush();
    expect(store.incidents.get(id)).toMatchObject({ outcome: 'EXPIRED' });
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(true);
    expect(game.startIncident()).toBe(true);
    await game.shutdown();
  });
});
```

- [ ] **Step 3: Model and world**

`apps/sim/src/core/model.ts` — `WildState` gains

```ts
  /** Incident boss. */
  boss?: boolean;
  /** Anyone may hit it and nobody owns its tag (boss and its adds); immune to capture. */
  open?: boolean;
  /** A personal boss copy: only this operator may hit or capture it. */
  personal?: string;
  /** Removed at this tick unless a capture is in progress. */
  despawnAtTick?: number;
```

plus

```ts
/** A running Incident (kernelspace world only). */
export interface IncidentState {
  id: string;
  n: number;
  species: string;
  phase: 'open' | 'fighting';
  bossId: string;
  openedAtMs: number;
  endsAtMs: number;
  /** Boss immune until its adds are cleared. */
  shield: boolean;
  /** Index into BOSS_PHASES of the next threshold. */
  nextPhase: number;
  adds: string[];
  /** operator id -> damage dealt to the boss. */
  damage: Map<string, number>;
  nextTelegraphTick: number;
  telegraph: { x: number; y: number; radius: number; atTick: number } | null;
}
```

and the intent `| { id: string; kind: 'incidentReward'; operatorId: string; incidentId: string; n: number; species: string; reward: number; damage: number; share: number }`.

`apps/sim/src/core/world.ts` — fields

```ts
  /** Incident state (kernelspace world only). */
  incident: IncidentState | null = null;
  /** ms timestamp of the next scheduled Incident. */
  nextIncidentAt: number;
  /** Set by the runtime when an admin starts one. */
  incidentRequested = false;
  incidentCount = 0;
  incidentClosedAtMs = 0;
  /** Gateways the runtime has closed (Incident gateways while none is open, or kernelspace is full). */
  readonly closedGateways = new Set<string>();
```

(`this.nextIncidentAt = nextIncidentStart(this.nowMs());` in the constructor, `nowMs(): number { return Date.parse(this.now()); }`), `removeOperator` drops that operator's personal copies (`for (const d of [...this.daemons.values()]) if (d.wild?.personal === id) this.removeDaemon(d.id);`), `step()` calls `stepIncident(this, out);` right after `executeQueuedUses`, and `completeIntent` gains

```ts
      case 'incidentReward':
        if (!result.ok) return;
        op.bits += intent.reward;
        out.emit({ e: 'incidentReward', incidentId: intent.incidentId, reward: intent.reward, share: intent.share }, { to: op.id });
        out.emit({ e: 'bits', delta: intent.reward, reason: 'incident', balance: op.bits }, { to: op.id });
        return;
```

`view.ts`: `taggedBy` also reads as the viewer's id for their personal copy (`d.wild.personal === viewer.id`), and boss entities carry `boss: true, shielded: world.incident?.shield ?? false`.

- [ ] **Step 4: The Incident system**

```ts
import {
  ADDS_PER_PHASE,
  ADD_LEVEL,
  BOSS_HP_MULTIPLIER,
  BOSS_LEVEL,
  BOSS_PHASES,
  COPY_LEVEL,
  COPY_TTL_MS,
  INCIDENT_SUBNET,
  INCIDENT_WINDOW_MS,
  TELEGRAPH_DAMAGE,
  TELEGRAPH_DELAY_MS,
  TELEGRAPH_EVERY_MS,
  TELEGRAPH_RADIUS,
  bossSpecies,
  getSubnet,
  incidentNumber,
  incidentPayouts,
  lineBase,
  nextIncidentStart,
  rollSpawn,
} from '@daemonet/rules';
import { distance } from '../grid.js';
import type { Daemon, IncidentState } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { failCapture } from './capture.js';

/** Where evicted operators land: the host of the subnet the Incident gateway comes from. */
const EVICT_TO = 'backbone';
const EVICT_GRACE_MS = 5_000;

const publicState = (world: World, inc: IncidentState, phase: 'open' | 'fighting' | 'shield' | 'unshield' | 'cleared' | 'expired') =>
  ({ e: 'incident', phase, id: inc.id, n: inc.n, species: inc.species, endsAt: new Date(inc.endsAtMs).toISOString(), bossId: world.daemons.has(inc.bossId) ? inc.bossId : null }) as const;

function open(world: World, now: number, out: Out): void {
  const arena = world.subnet.arena ?? { x: world.subnet.width / 2, y: world.subnet.height / 2, radius: 16 };
  const scheduled = now >= world.nextIncidentAt;
  const n = incidentNumber(scheduled ? world.nextIncidentAt : now) + world.incidentCount;
  const species = bossSpecies(n);
  const boss = world.spawnWild(species, BOSS_LEVEL, { x: arena.x, y: arena.y }, -1, { ...rollSpawn(world.rng, { clean: 0, signatureStep: 0 }) });
  boss.stats = { ...boss.stats, hp: boss.stats.hp * BOSS_HP_MULTIPLIER };
  boss.hp = boss.stats.hp;
  boss.wild!.behaviour = 'territorial';
  boss.wild!.boss = true;
  boss.wild!.open = true;
  world.incidentCount++;
  world.incidentRequested = false;
  world.nextIncidentAt = nextIncidentStart(now + 1);
  world.incident = {
    id: world.newId('inc'),
    n,
    species,
    phase: 'open',
    bossId: boss.id,
    openedAtMs: now,
    endsAtMs: now + INCIDENT_WINDOW_MS,
    shield: false,
    nextPhase: 0,
    adds: [],
    damage: new Map(),
    nextTelegraphTick: 0,
    telegraph: null,
  };
  out.emit(publicState(world, world.incident, 'open'), { at: null });
}

/** Called by combat for every hit on the boss: contribution, and the first hit starts the fight. */
export function noteBossHit(world: World, operatorId: string, amount: number, out: Out): void {
  const inc = world.incident;
  if (!inc) return;
  inc.damage.set(operatorId, (inc.damage.get(operatorId) ?? 0) + amount);
  if (inc.phase === 'open') {
    inc.phase = 'fighting';
    inc.nextTelegraphTick = world.tick + world.ticks(TELEGRAPH_EVERY_MS);
    out.emit(publicState(world, inc, 'fighting'), { at: null });
  }
}

function spawnAdds(world: World, inc: IncidentState, boss: Daemon): void {
  const species = lineBase(inc.species);
  inc.adds = [];
  for (let i = 0; i < ADDS_PER_PHASE; i++) {
    const angle = (i / ADDS_PER_PHASE) * Math.PI * 2;
    const add = world.spawnWild(species, ADD_LEVEL, { x: boss.x + Math.cos(angle) * 4, y: boss.y + Math.sin(angle) * 4 }, -1, rollSpawn(world.rng, { clean: 0, signatureStep: 0 }));
    add.wild!.behaviour = 'territorial';
    add.wild!.open = true;
    add.wild!.aggro = boss.wild!.aggro;
    inc.adds.push(add.id);
  }
}

function removeAdds(world: World, inc: IncidentState): void {
  for (const id of inc.adds) world.removeDaemon(id);
  inc.adds = [];
}

function clear(world: World, inc: IncidentState, out: Out): void {
  const payouts = incidentPayouts(inc.damage);
  removeAdds(world, inc);
  for (const p of payouts) {
    world.trackIntent({ id: world.newId('i'), kind: 'incidentReward', operatorId: p.operatorId, incidentId: inc.id, n: inc.n, species: inc.species, reward: p.reward, damage: Math.round(p.damage), share: p.share }, out);
    const op = world.operators.get(p.operatorId);
    if (!op) continue;
    // a personal copy: only this operator can hit or capture it; a fresh roll, so it can be clean or carry a signature
    const copy = world.spawnWild(inc.species, COPY_LEVEL, { x: op.x + 1, y: op.y }, -1, rollSpawn(world.rng, world.odds));
    copy.wild!.behaviour = 'wanderer';
    copy.wild!.personal = op.id;
    copy.wild!.tagOwner = `personal:${op.id}`;
    copy.wild!.tagUntil = Number.MAX_SAFE_INTEGER;
    copy.wild!.despawnAtTick = world.tick + world.ticks(COPY_TTL_MS);
    if (copy.clean || copy.signature > 0) out.emit({ e: 'signatureSpawn', daemon: copy.id, species: copy.species, signature: copy.signature, clean: copy.clean }, { to: op.id });
  }
  out.emit(
    {
      ...publicState(world, inc, 'cleared'),
      bossId: null,
      participants: payouts.map((p) => ({ operatorId: p.operatorId, name: world.operators.get(p.operatorId)?.name ?? null, damage: Math.round(p.damage), share: p.share, reward: p.reward })),
    },
    { at: null },
  );
  world.incident = null;
  world.incidentClosedAtMs = world.nowMs();
}

function expire(world: World, inc: IncidentState, out: Out): void {
  removeAdds(world, inc);
  world.removeDaemon(inc.bossId);
  out.emit({ ...publicState(world, inc, 'expired'), bossId: null }, { at: null });
  world.incident = null;
  world.incidentClosedAtMs = world.nowMs();
}

function telegraph(world: World, inc: IncidentState, boss: Daemon, out: Out): void {
  const tick = world.tick;
  if (inc.telegraph) {
    if (tick < inc.telegraph.atTick) return;
    const t = inc.telegraph;
    inc.telegraph = null;
    inc.nextTelegraphTick = tick + world.ticks(TELEGRAPH_EVERY_MS);
    for (const d of world.daemons.values()) {
      if (!d.ownerId || !d.active || d.hp <= 0 || distance(d, t) > t.radius) continue;
      const amount = Math.ceil(d.stats.hp * TELEGRAPH_DAMAGE);
      d.hp = Math.max(0, d.hp - amount);
      d.lastCombatTick = tick;
      out.emit({ e: 'hit', source: boss.id, target: d.id, move: 'telegraph', amount, multiplier: 1 }, { at: d });
    }
    for (const op of world.operators.values()) if (distance(op, t) <= t.radius) op.hitTick = tick;
    return;
  }
  if (tick < inc.nextTelegraphTick) return;
  const targets = [...world.operators.values()].filter((op) => distance(op, boss) <= 48);
  if (targets.length === 0) return;
  const target = world.rng.pick(targets);
  inc.telegraph = { x: target.x, y: target.y, radius: TELEGRAPH_RADIUS, atTick: tick + world.ticks(TELEGRAPH_DELAY_MS) };
  out.emit({ e: 'telegraph', ...inc.telegraph }, { at: null });
}

/** After the window (and the copies' lifetime) nobody stays in kernelspace: a forced travel back to backbone's host. */
function evictIdle(world: World, now: number, out: Out): void {
  if (now < world.incidentClosedAtMs + COPY_TTL_MS + EVICT_GRACE_MS) return;
  const dest = getSubnet(EVICT_TO);
  for (const op of world.operators.values()) {
    if (op.travelling || world.hasPendingFor(op.id)) continue;
    for (const id of [...op.running]) world.deactivate(world.daemons.get(id)!);
    const cap = op.captureId ? world.captures.get(op.captureId) : undefined;
    if (cap) failCapture(world, cap, 'packet_loss', out);
    op.travelling = true;
    op.path = [];
    world.trackIntent({ id: world.newId('i'), kind: 'travel', operatorId: op.id, reqId: `evict-${world.tick}`, gatewayId: 'evict', from: world.subnet.id, to: dest.id, x: dest.spawn.x, y: dest.spawn.y }, out);
  }
}

/** Per tick, kernelspace only: schedule, phases, adds, telegraphs, clear / expire, eviction. */
export function stepIncident(world: World, out: Out): void {
  if (world.subnet.id !== INCIDENT_SUBNET) return;
  const now = world.nowMs();
  const inc = world.incident;
  if (!inc) {
    if (world.incidentRequested || now >= world.nextIncidentAt) open(world, now, out);
    else evictIdle(world, now, out);
    return;
  }
  const boss = world.daemons.get(inc.bossId);
  if (!boss || boss.hp <= 0) return clear(world, inc, out);
  if (now >= inc.endsAtMs) return expire(world, inc, out);
  if (inc.shield && inc.adds.every((id) => (world.daemons.get(id)?.hp ?? 0) <= 0)) {
    inc.shield = false;
    inc.adds = [];
    out.emit(publicState(world, inc, 'unshield'), { at: null });
  }
  const threshold = BOSS_PHASES[inc.nextPhase];
  if (!inc.shield && threshold !== undefined && boss.hp <= boss.stats.hp * threshold) {
    inc.shield = true;
    inc.nextPhase++;
    spawnAdds(world, inc, boss);
    out.emit(publicState(world, inc, 'shield'), { at: null });
  }
  if (inc.phase === 'fighting') telegraph(world, inc, boss, out);
}
```

- [ ] **Step 5: Combat, capture, upkeep, travel**

Replace `apps/sim/src/core/systems/combat.ts`:

```ts
import { TAG_WINDOW_MS, damage, effectiveCooldownMs, getMove, typeIndex, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { Rejection, freshEngagement, partyKey, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { noteBossHit } from './incident.js';

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
    const owner = world.operators.get(attacker.ownerId);
    const key = owner ? partyKey(owner) : attacker.ownerId;
    const out: Victim[] = [];
    for (const d of world.daemons.values()) {
      if (!d.wild || !d.active || d.hp <= 0) continue;
      // Incident targets are open to everyone; a personal boss copy belongs to exactly one operator
      const allowed = d.wild.personal ? d.wild.personal === attacker.ownerId : d.wild.open || d.wild.tagOwner === null || d.wild.tagOwner === key;
      if (allowed) out.push({ kind: 'daemon', d });
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
  if (target.wild?.boss && world.incident?.shield) amount = 0;
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
  if (target.wild?.boss && attacker.ownerId) noteBossHit(world, attacker.ownerId, amount, out);
  if (target.wild && attacker.ownerId && (target.wild.open || target.wild.personal)) {
    target.wild.damagedBy.add(attacker.id);
    target.wild.aggro ??= attacker.id;
  } else if (target.wild && attacker.ownerId) {
    if (target.wild.tagOwner === null) {
      out.emit({ e: 'battleStart', wild: target.id, operator: attacker.ownerId }, { at: target });
      target.engagement = freshEngagement();
      target.engagement.lastHitMove = move.id;
      if (target.trait === 'bitshield') target.engagement.blocked = true;
    }
    const owner = world.operators.get(attacker.ownerId);
    target.wild.tagOwner = owner ? partyKey(owner) : attacker.ownerId;
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
  const expired: string[] = [];
  for (const d of world.daemons.values()) {
    if (d.crashed) continue;
    d.energy = regenEnergy(d.energy, d.stats.energy, d.heldItem === 'battery' ? BATTERY_REGEN : 1);
    if ((d.statuses.leaking ?? 0) > tick) d.energy = Math.max(0, d.energy - LEAK_PER_SECOND / TICK_HZ);
    for (const [status, until] of Object.entries(d.statuses) as Array<[StatusId, number]>) {
      if (until <= tick) delete d.statuses[status];
    }
    const w = d.wild;
    if (w?.despawnAtTick !== undefined && tick >= w.despawnAtTick && !captured.has(d.id)) {
      expired.push(d.id);
      continue;
    }
    if (w && w.tagOwner !== null && tick > w.tagUntil && !captured.has(d.id)) {
      w.tagOwner = null;
      w.aggro = null;
      w.damagedBy.clear();
      d.hp = d.stats.hp;
      d.engagement = freshEngagement();
    }
  }

  for (const id of expired) world.removeDaemon(id);

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

`apps/sim/src/core/systems/capture.ts` (`startCapture`):

```ts
  if (target.wild.open) throw new Rejection('E_STATE', 'immune to capture');
  const personal = target.wild.personal === op.id;
  if (!personal && target.wild.tagOwner !== null && target.wild.tagOwner !== partyKey(op)) throw new Rejection('E_STATE', 'tagged by another operator');
```

and the tag is only rewritten when the target is not a personal copy:

```ts
  if (!personal) {
    target.wild.tagOwner = partyKey(op);
    target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
  }
```

`apps/sim/src/core/systems/commands.ts` (`travel`, after the distance check):

```ts
  if (world.closedGateways.has(gate.id)) throw new Rejection('E_STATE', gate.incidentOnly ? 'no Incident is open (or kernelspace is full)' : 'that gateway is closed');
```

- [ ] **Step 6: Stores and Game**

`apps/sim/src/runtime/store.ts`: `IncidentRow { id; n; species; endsAt; outcome: 'OPEN' | 'CLEARED' | 'EXPIRED'; participants[] }`, `Store.recordIncident(row)`, `MemoryStore.incidents` map, and the intent

```ts
      case 'incidentReward':
        op.bits += intent.reward;
        this.ledger.push({ operatorId: op.id, delta: intent.reward, reason: 'incident', ref: intent.incidentId, at: this.now() });
        break;
```

`apps/sim/src/runtime/prisma-store.ts`: the same intent as a balance increment plus `bitsLedger` row, and

```ts
  async recordIncident(row: IncidentRow): Promise<void> {
    const data = { n: row.n, species: row.species, endsAt: new Date(row.endsAt), outcome: row.outcome, participants: row.participants as unknown as Prisma.InputJsonValue, closedAt: row.outcome === 'OPEN' ? null : new Date() };
    await this.prisma.incident.upsert({ where: { id: row.id }, create: { id: row.id, ...data }, update: data });
  }
```

`apps/sim/src/runtime/game.ts`: import `INCIDENT_MAX_OPERATORS, INCIDENT_SUBNET` and `type GameEvent`; `tick()` calls `this.gateIncidentGateways();` before stepping the worlds; `stepWorld` calls `this.onIncidentEvents(world, result.events)` for the kernelspace world right after `world.step`; `onAdmin` handles `incident:start` first (`this.startIncident(); return;`); and add

```ts
  /** Incident gateways open only while an Incident runs in the destination and it has room (SP4 spec §8). */
  private gateIncidentGateways(): void {
    for (const world of this.worlds.values()) {
      for (const g of world.subnet.gateways) {
        if (!g.incidentOnly) continue;
        const dest = this.worlds.get(g.to);
        const open = dest?.incident != null && dest.operators.size < INCIDENT_MAX_OPERATORS;
        if (open) world.closedGateways.delete(g.id);
        else world.closedGateways.add(g.id);
      }
    }
  }

  /** Incident announcements are server-wide; the record is kept for the api. */
  private onIncidentEvents(world: World, events: readonly { event: GameEvent }[]): void {
    for (const { event } of events) {
      if (event.e !== 'incident') continue;
      for (const other of this.worlds.values()) if (other !== world) other.emitCarry(event, { at: null });
      if (event.phase === 'open' || event.phase === 'cleared' || event.phase === 'expired') {
        const row = { id: event.id, n: event.n, species: event.species, endsAt: event.endsAt, outcome: event.phase === 'open' ? ('OPEN' as const) : event.phase === 'cleared' ? ('CLEARED' as const) : ('EXPIRED' as const), participants: event.participants ?? [] };
        this.track(this.store.recordIncident(row).catch((err: Error) => this.log.warn({ err: err.message }, 'incident record failed')));
      }
    }
  }

  /** Admin trigger (bus `admin { kind: 'incident:start' }` or tests). */
  startIncident(): boolean {
    const world = this.worlds.get(INCIDENT_SUBNET);
    if (!world || world.incident) return false;
    world.incidentRequested = true;
    return true;
  }
```

- [ ] **Step 7: Verify and commit**

`pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green.

```bash
git add packages/db packages/shared apps/sim
git commit -m "feat(sim): Incidents — kernel daemon boss with shields, adds, telegraphs, payouts and personal copies"
```

---

### Task 3: API and client

**Files:**
- Create: `apps/api/src/routes/incidents.ts`, `apps/frontend/src/game/incident.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/app.test.ts`, `apps/frontend/src/api.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/render/draw.ts`, `apps/frontend/src/panels/AdminPanel.tsx`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `GET /api/incidents` → `{ next: { at, species, periodMs, windowMs }, current | null, recent[16] }`; `GET /api/incidents/:id`; `POST /api/admin/incidents/start` (admin) → bus.
- `incidentStore` / `useIncident()` → `{ current: IncidentInfo | null, telegraphs: Telegraph[] }`; `onEvent`, `seed` (from the API on load), `onTelegraph`, `prune(tick)`.
- Top bar `data-testid="incident-banner"`; admin view `admin-incidents` with `incident-start`.

- [ ] **Step 1: API**

Test (before the dev-seeding case; add `"Incident"` to the truncation list):

```ts
  it('lists incidents with the next scheduled one; only admins can start one (over the bus)', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ivy' });
    const b = await app.inject({ method: 'GET', url: '/api/auth/dev?name=jo&admin=true' });
    const user = { [COOKIE_NAME]: a.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const admin = { [COOKIE_NAME]: b.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    await prisma!.incident.createMany({
      data: [
        { id: 'inc-old', n: 1, species: 'pidzero', openedAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 86_400_000 + 1_200_000), closedAt: new Date(), outcome: 'CLEARED', participants: [{ operatorId: 'x', name: 'x', damage: 10, share: 1, reward: 8192 }] },
        { id: 'inc-now', n: 2, species: 'pingodeth', endsAt: new Date(Date.now() + 600_000), outcome: 'OPEN' },
      ],
    });
    const list = (await app.inject({ method: 'GET', url: '/api/incidents', cookies: user })).json();
    expect(list.current).toMatchObject({ id: 'inc-now', species: 'pingodeth' });
    expect(list.recent.map((r: { id: string }) => r.id)).toEqual(['inc-now', 'inc-old']);
    expect(Date.parse(list.next.at) % (4 * 3_600_000)).toBe(0);
    expect(list.next.species).toEqual(expect.any(String));
    expect((await app.inject({ method: 'GET', url: '/api/incidents/inc-old', cookies: user })).json()).toMatchObject({ outcome: 'CLEARED' });
    expect((await app.inject({ method: 'GET', url: '/api/incidents/nope', cookies: user })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/admin/incidents/start', cookies: user, headers: csrf })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/incidents/start', cookies: admin, headers: csrf })).json()).toEqual({ ok: true });
    expect(bus.log.at(-1)).toEqual({ channel: 'admin', message: { kind: 'incident:start' } });
  });
```

Routes:

```ts
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { INCIDENT_PERIOD_MS, INCIDENT_WINDOW_MS, bossSpecies, incidentNumber, nextIncidentStart } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.js';

/** Incident schedule and history (SP4 spec §8); admins can start one now. */
export function registerIncidentRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/api/incidents', auth, async () => {
    const now = Date.now();
    const rows = await prisma.incident.findMany({ orderBy: { openedAt: 'desc' }, take: 16 });
    const current = rows.find((r) => r.outcome === 'OPEN' && r.endsAt.getTime() > now) ?? null;
    const start = nextIncidentStart(now);
    return {
      next: { at: new Date(start).toISOString(), species: bossSpecies(incidentNumber(start)), periodMs: INCIDENT_PERIOD_MS, windowMs: INCIDENT_WINDOW_MS },
      current: current ? { id: current.id, n: current.n, species: current.species, openedAt: current.openedAt, endsAt: current.endsAt } : null,
      recent: rows.map((r) => ({ id: r.id, n: r.n, species: r.species, openedAt: r.openedAt, endsAt: r.endsAt, closedAt: r.closedAt, outcome: r.outcome, participants: r.participants })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/incidents/:id', auth, async (req) => {
    const row = await prisma.incident.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('no such incident');
    return row;
  });

  app.post('/api/admin/incidents/start', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    await bus.publish('admin', { kind: 'incident:start' });
    return { ok: true };
  });
}
```

Register `registerIncidentRoutes(app, o.prisma, o.bus);` in `apps/api/src/app.ts`.

- [ ] **Step 2: Client store, banner, map**

`apps/frontend/src/game/incident.ts`:

```ts
import { useSyncExternalStore } from 'react';

export interface IncidentInfo {
  id: string;
  species: string;
  endsAt: string;
  phase: 'open' | 'fighting' | 'shield' | 'unshield';
  bossId: string | null;
}
export interface Telegraph {
  x: number;
  y: number;
  radius: number;
  atTick: number;
}
export interface IncidentEvent {
  phase: 'open' | 'fighting' | 'shield' | 'unshield' | 'cleared' | 'expired';
  id: string;
  species: string;
  endsAt: string;
  bossId: string | null;
}

/** Live Incident state for the banner and the map (fed by events; seeded from /api/incidents on load). */
export function createIncidentStore() {
  let current: IncidentInfo | null = null;
  let telegraphs: Telegraph[] = [];
  let snapshot: { current: IncidentInfo | null; telegraphs: Telegraph[] } = { current, telegraphs };
  const listeners = new Set<() => void>();
  const notify = () => {
    snapshot = { current, telegraphs };
    listeners.forEach((l) => l());
  };
  return {
    onEvent(e: IncidentEvent) {
      if (e.phase === 'cleared' || e.phase === 'expired') {
        current = null;
        telegraphs = [];
      } else current = { id: e.id, species: e.species, endsAt: e.endsAt, phase: e.phase, bossId: e.bossId };
      notify();
    },
    /** From the API when the page loads mid-Incident (no event will come until the phase changes). */
    seed(info: { id: string; species: string; endsAt: string } | null) {
      if (!info || current) return;
      current = { ...info, phase: 'open', bossId: null };
      notify();
    },
    onTelegraph(t: Telegraph) {
      telegraphs = [...telegraphs, t];
      notify();
    },
    /** Drops blasts that have landed. */
    prune(tick: number) {
      if (!telegraphs.some((t) => t.atTick < tick)) return;
      telegraphs = telegraphs.filter((t) => t.atTick >= tick);
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const incidentStore = createIncidentStore();
export function useIncident() {
  return useSyncExternalStore(incidentStore.subscribe, incidentStore.get, incidentStore.get);
}
```

`api.ts`: `IncidentList` type, `incidents: b.query<IncidentList, void>({ query: () => '/incidents' })`, `startIncident: b.mutation<{ ok: boolean }, void>({ query: () => ({ url: '/admin/incidents/start', method: 'POST' }) })`, hooks `useIncidentsQuery`, `useStartIncidentMutation`.

`connection.ts` (after the `chat` handler):

```ts
    client.on('incident', (e) => {
      incidentStore.onEvent(e);
      const text: Record<string, string> = {
        open: `INCIDENT: a ${e.species} kernel daemon is loose in kernelspace (gateway in backbone)`,
        fighting: `the ${e.species} is under attack`,
        shield: `the ${e.species} raised its shield — clear the adds`,
        unshield: `the ${e.species} is exposed again`,
        cleared: `Incident cleared${e.participants ? `: ${e.participants.map((p) => `${p.name ?? '?'} ${Math.round(p.share * 100)}% → ${p.reward} bits`).join(', ')}` : ''}`,
        expired: `the ${e.species} got away`,
      };
      log.push('event', text[e.phase] ?? e.phase);
    });
    client.on('telegraph', (t) => incidentStore.onTelegraph(t));
    client.on('incidentReward', (e) => log.push('event', `Incident reward: ${e.reward} bits for ${Math.round(e.share * 100)}% of the damage`));
    client.on('tick', (tick) => incidentStore.prune(tick));
```

`TopBar.tsx`: seed the store from `useIncidentsQuery()` (`useEffect(() => incidentStore.seed(incidents.data?.current ?? null), [incidents.data])`) and render, before the right-hand controls,

```tsx
      {incident && (
        <span className="mono rounded bg-red-900 px-2 text-red-100" data-testid="incident-banner">
          INCIDENT · {incident.species} · {incident.phase === 'shield' ? 'shielded' : incident.phase} · {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')} · kernelspace
        </span>
      )}
```

with `const incident = useIncident().current;` and `const left = incident ? Math.max(0, Date.parse(incident.endsAt) - Date.now()) : 0;`.

`render/draw.ts`: colours `boss: '#f43f5e', shield: '#93c5fd', telegraph: 'rgba(244, 63, 94, 0.35)'`; before the entities are drawn, fill a circle of `t.radius` tiles for every `incidentStore.get().telegraphs`; for entities with `e.boss`, a ring of 1.4 tiles (blue while `e.shielded`) and the label `KERNEL DAEMON` / `KERNEL DAEMON · shielded`.

`AdminPanel.tsx`: add `'incidents'` to `VIEWS` and the view

```tsx
function Incidents() {
  const list = useIncidentsQuery();
  const [start, state] = useStartIncidentMutation();
  return (
    <section className="space-y-1 text-xs" data-testid="admin-incidents">
      <button className="rounded bg-red-900 px-2 py-0.5 hover:bg-red-800 disabled:opacity-40" disabled={state.isLoading || !!list.data?.current} onClick={() => void start().then(() => list.refetch())} data-testid="incident-start">
        start an Incident now
      </button>
      {list.data && (
        <p className="text-neutral-500">
          next scheduled: {new Date(list.data.next.at).toLocaleString()} ({list.data.next.species})
        </p>
      )}
      {list.data?.recent.map((r) => (
        <div key={r.id} className="mono flex justify-between border-b border-neutral-900 py-0.5">
          <span className="text-neutral-500">{new Date(r.openedAt).toLocaleString()}</span>
          <span>{r.species}</span>
          <span className={r.outcome === 'CLEARED' ? 'text-emerald-300' : 'text-neutral-400'}>
            {r.outcome.toLowerCase()} · {r.participants.length} operators
          </span>
        </div>
      ))}
    </section>
  );
}
```

`sdk-types.ts`: `DaemonView` gains `boss?: boolean; shielded?: boolean;` and `on` gains the `'incident'`, `'telegraph'` and `'incidentReward'` overloads.

- [ ] **Step 3: End-to-end**

In the two-operator scenario, before the contexts are closed:

```ts
  // Incidents: an admin starts one; every connected operator sees the banner
  const adm = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  expect((await adm.request.get(`/api/auth/dev?name=${name}adm&admin=true`, { maxRedirects: 0 })).status()).toBe(302);
  expect((await adm.request.post('/api/admin/incidents/start', { headers: { 'x-requested-with': 'daemonet' } })).ok()).toBeTruthy();
  await expect(pb.getByTestId('incident-banner')).toContainText('INCIDENT', { timeout: 15_000 });
  await adm.close();
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 43 files, 367 tests. Build, start the stack (sim hosting all seven subnets, Redis on both services), `playwright test` — 4 passed. Manual: as an admin start an Incident, walk a level-32 daemon through `backbone-kernelspace`, hit the boss: banner phases change, the shield ring turns blue when adds appear, red circles mark the blasts two seconds ahead.

```bash
git add apps/api apps/frontend
git commit -m "feat: Incident API, banner, boss and telegraph rendering, admin trigger"
```

---

## Self-review

- **Spec coverage:** §8 kernelspace (host south, arena north, gated gateway from backbone, way back), schedule every four hours with a twenty-minute window, admin start over the bus, state machine, capstone rotation, level 64 at eight times HP, no flee / no tag / immune to capture, shield + four adds at 75 / 50 / 25 %, telegraphed AoE every 16 s with a 2-second warning for 25 % max HP, contribution = damage share, 8192 pool with a 64 minimum above 1 %, personal copies at level 48 with fresh rolls for four minutes, eviction, `Incident` table, server-wide events, API list / detail, banner + boss bar + telegraph circles + history (admin view). The 16-operator cap closes the gateway.
- **Type consistency:** the `incident` event shape is shared by the sim, `Game.onIncidentEvents`, the store row and the client store; `IncidentRow.participants` matches the event's `participants`.
- **Placeholders:** none.
