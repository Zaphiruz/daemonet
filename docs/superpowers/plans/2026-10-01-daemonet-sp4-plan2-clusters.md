# Daemonet SP4 · Plan 2 — Clusters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Up to four operators hunt together: clusters formed by inviting someone nearby or joining with a 6-character code, shared tagging, XP split among the damaging daemons of members who are present, capture rights for any member, per-member ticket credit, a `cluster:<id>` chat channel, and the SDK / client surface.

**Architecture:** Membership lives in a `ClusterService` in the sim runtime (clusters span worlds and are not persisted). It writes a `ClusterView` onto each member's `Operator` (`op.cluster`), which `toSelf` ships as `self.cluster` — so membership changes reach clients through the normal self diff. The core never sees the service: it derives a **party key** (`partyKey(op)` = `cluster:<id>` or the operator id) and every place that compared `tagOwner` to an operator id now compares party keys. The per-viewer entity projection translates a tag held by the viewer's party back to the viewer's own id, so existing scripts (`taggedBy === me.id`) keep working in a cluster. Cluster commands are handled by `Game` immediately (like chat), outside the tick.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP4 plan 1 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp4-social-design.md` §3 (clusters row), §6. Decisions fixed here: `clusterCreate` exists so a solo operator can get a code to share; only the leader invites and kicks; "present" for XP and ticket credit means same world and within 32 tiles of the defeated / captured daemon; joining a cluster while holding a personal tag gives that tag up until it expires.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Clusters are never persisted; a member whose session leaves the game leaves the cluster.
- `tagOwner` is always a party key; nothing in the core compares it to a bare operator id.

## File map

```
apps/sim/src/runtime/clusters.ts           ClusterService (ensure, invite, accept, join, leave, kick, refresh, reattach)
apps/sim/src/runtime/game.ts               cluster commands, chat `clusterOf`, leave / travel hooks
apps/sim/src/core/model.ts                 ClusterView, partyKey, Operator.cluster
apps/sim/src/core/systems/{combat,capture,progress}.ts   party-key tagging, partyPresent / partyRecipients
apps/sim/src/core/view.ts                  taggedBy translated per viewer; self.cluster
packages/shared/src/protocol.ts            cluster commands, clusterInvite message, OperatorSelf.cluster
packages/sdk/src/client.ts                 ClusterApi, clusterInvite event
apps/frontend/src/panels/ClusterPanel.tsx  (shown above the chat channels)
apps/sim/test/clusters.test.ts, e2e
```

---

### Task 1: Party keys in the core

**Files:**
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/systems/combat.ts`, `apps/sim/src/core/systems/capture.ts`, `apps/sim/src/core/systems/progress.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/index.ts`, `packages/shared/src/protocol.ts`, `packages/sandbox/test/sandbox.test.ts`

**Interfaces:**
- `ClusterView { id; code; leaderId; members: [{ id; name; subnet; away }] }`; `partyKey(op)`; `Operator.cluster: ClusterView | null` (initialised `null` in `addOperator`).
- `PARTY_RADIUS = 32`; `partyPresent(world, key, at): Operator[]`; `partyRecipients(world, key, damagedBy, at): string[]`.
- `OperatorSelf.cluster` on the wire (nullable object as above).

- [ ] **Step 1: Model and protocol**

In `apps/sim/src/core/model.ts` add before `OpenTicket`:

```ts
/** A cluster as one member sees it (the runtime's ClusterService writes it onto the operator). */
export interface ClusterView {
  id: string;
  code: string;
  leaderId: string;
  members: Array<{ id: string; name: string | null; subnet: string | null; away: boolean }>;
}

/**
 * Who a tag belongs to (SP4 spec §6): the cluster while the operator is in one, otherwise the operator.
 * Everything that used to compare `tagOwner` with an operator id compares party keys instead.
 */
export function partyKey(op: { id: string; cluster: ClusterView | null }): string {
  return op.cluster ? `cluster:${op.cluster.id}` : op.id;
}
```

and to `Operator` (after `mutedUntil`): `/** Set by the runtime's cluster service; null when solo. Not persisted. */ cluster: ClusterView | null;` — `world.addOperator` sets `cluster: null`.

In `packages/shared/src/protocol.ts`, `OperatorSelf` gains before `ticketsToday`:

```ts
  /** The cluster this operator is in (SP4): join code, leader, members with their subnet; `away` = not in your subnet. */
  cluster: z
    .object({
      id: Id,
      code: z.string(),
      leaderId: Id,
      members: z.array(z.object({ id: Id, name: z.string().nullable(), subnet: z.string().nullable(), away: z.boolean() })),
    })
    .nullable(),
```

(the sandbox test fixture gains `cluster: null,`).

- [ ] **Step 2: Combat and capture**

`apps/sim/src/core/systems/combat.ts` (import `partyKey`): in `candidates`, owned attackers compare against their owner's party key —

```ts
    const owner = world.operators.get(attacker.ownerId);
    const key = owner ? partyKey(owner) : attacker.ownerId;
    const out: Victim[] = [];
    for (const d of world.daemons.values()) {
      if (d.wild && d.active && d.hp > 0 && (d.wild.tagOwner === null || d.wild.tagOwner === key)) out.push({ kind: 'daemon', d });
    }
    return out;
```

and in `applyHit` the tag is written as a party key:

```ts
    const owner = world.operators.get(attacker.ownerId);
    target.wild.tagOwner = owner ? partyKey(owner) : attacker.ownerId;
```

`apps/sim/src/core/systems/capture.ts` (import `partyKey`, and `partyRecipients` from `./progress.js`): `startCapture` refuses when `target.wild.tagOwner !== null && target.wild.tagOwner !== partyKey(op)` and sets `target.wild.tagOwner = partyKey(op)`; `commitCapture` awards XP with

```ts
  awardXp(world, partyRecipients(world, wild.tagOwner ?? partyKey(op), wild.damagedBy, target), xpYield(sp.baseYield, target.level), out);
```

- [ ] **Step 3: XP and tickets across the party**

Replace `apps/sim/src/core/systems/progress.ts`:

```ts
import { computeStats, getSpecies, levelForXp, movesAtLevel, splitXp, xpYield } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { partyKey, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { advanceTickets } from './tickets.js';

/** XP and ticket credit reach party members within this many tiles of the defeated / captured daemon. */
export const PARTY_RADIUS = 32;

/** Operators of the party `key` that are in this world and near `at`. */
export function partyPresent(world: World, key: string, at: Point): Operator[] {
  const out: Operator[] = [];
  for (const op of world.operators.values()) if (partyKey(op) === key && distance(op, at) <= PARTY_RADIUS) out.push(op);
  return out;
}

/** The daemons that damaged the target and belong to a present party member (not crashed). */
export function partyRecipients(world: World, key: string, damagedBy: ReadonlySet<string>, at: Point): string[] {
  const owners = new Set(partyPresent(world, key, at).map((o) => o.id));
  return [...damagedBy].filter((id) => {
    const d = world.daemons.get(id);
    return d !== undefined && d.ownerId !== null && owners.has(d.ownerId) && !d.crashed;
  });
}

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
      if (d.wild.tagOwner) {
        awardXp(world, partyRecipients(world, d.wild.tagOwner, d.wild.damagedBy, d), xpYield(getSpecies(d.species).baseYield, d.level), out);
        for (const member of partyPresent(world, d.wild.tagOwner, d)) advanceTickets(world, member, { kind: 'clear', type: d.types[0]! }, out);
      }
      world.removeDaemon(d.id);
      continue;
    }
    d.crashed = true;
    d.crashes++;
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

Export `PARTY_RADIUS` from `apps/sim/src/core/index.ts`.

- [ ] **Step 4: View**

Replace `apps/sim/src/core/view.ts`:

```ts
import { STAT_KEYS, evolutionOptions, getSpecies, statBlockToArray, ticketBoard, type StatusId } from '@daemonet/rules';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import { partyKey, type Daemon, type Operator } from './model.js';
import { evolutionContext } from './systems/evolve.js';
import type { World } from './world.js';

export const INTEREST_RADIUS = 32;

const activeStatuses = (world: World, d: Daemon): StatusId[] =>
  (Object.entries(d.statuses) as Array<[StatusId, number]>).filter(([, until]) => until > world.tick).map(([s]) => s);

/** Research thresholds (design §7.2): 4 → nature (HP is always exact), 16 → IV buckets, 64 → exact IVs. */
export const SCAN_NATURE = 4;
export const SCAN_BUCKETS = 16;
export const SCAN_IVS = 64;
export const SCAN_HINTS = 256;

function scanFor(viewer: Operator | undefined, d: Daemon): Extract<Entity, { kind: 'daemon' }>['scan'] {
  if (!viewer || !d.wild) return undefined;
  const points = viewer.research[String(getSpecies(d.species).line)] ?? 0;
  if (points < SCAN_NATURE) return undefined;
  const scan: NonNullable<Extract<Entity, { kind: 'daemon' }>['scan']> = { nature: d.nature };
  if (points >= SCAN_BUCKETS) scan.ivBuckets = STAT_KEYS.map((k) => Math.floor(d.ivs[k] / 8));
  if (points >= SCAN_IVS) scan.ivs = statBlockToArray(d.ivs);
  return scan;
}

/** `viewer` adds the scan fields its research unlocks (wild daemons only). */
export function toDaemonEntity(world: World, d: Daemon, viewer?: Operator): Entity {
  const scan = scanFor(viewer, d);
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
    // a tag held by the viewer's party reads as the viewer's own id, so `taggedBy === me.id` keeps working in clusters
    taggedBy: d.wild?.tagOwner ? (viewer && d.wild.tagOwner === partyKey(viewer) ? viewer.id : d.wild.tagOwner) : null,
    clean: d.clean,
    signature: d.signature,
    statuses: activeStatuses(world, d),
    hardened: (d.wild?.hardenedUntil ?? 0) > world.tick,
    ...(scan ? { scan } : {}),
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
    diskCapacity: op.diskCapacity,
    tickets: op.tickets
      .filter((t) => !t.pending)
      .map((t) => ({
        id: t.id,
        day: t.day,
        subnet: t.subnet,
        index: t.index,
        kind: t.kind,
        params: t.params,
        target: t.target,
        reward: t.reward,
        progress: t.progress,
        title: ticketBoard(t.subnet, t.day)[t.index]?.title ?? t.kind,
      })),
    cluster: op.cluster,
    ticketsToday: op.ticketsToday,
    research: { ...op.research },
    ram: op.ram.map((id) => toRamDaemon(world, world.daemons.get(id)!)).sort((a, b) => a.slot - b.slot),
    running: [...op.running],
    inventory: { ...op.inventory },
    swapReadyTick: op.swapReadyTick,
    capture: cap ? { captureId: cap.id, targetId: cap.targetId, deadlineTick: cap.deadlineTick } : null,
  };
}

/** Every operator and active daemon within `radius` of (x, y), projected for `viewer` (scans). */
export function entitiesNear(world: World, x: number, y: number, radius = INTEREST_RADIUS, viewer?: Operator): Entity[] {
  const at = { x, y };
  const out: Entity[] = [];
  for (const op of world.operators.values()) if (distance(op, at) <= radius) out.push(toOperatorEntity(op));
  for (const d of world.daemons.values()) if (d.active && distance(d, at) <= radius) out.push(toDaemonEntity(world, d, viewer));
  return out;
}
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && DATABASE_URL=... pnpm exec vitest run` — expected: everything that passed before still passes (solo operators: `partyKey(op) === op.id`).

```bash
git add packages/shared packages/sandbox apps/sim
git commit -m "feat(sim): party keys for tagging, XP and capture rights"
```

---

### Task 2: ClusterService, commands, SDK

**Files:**
- Create: `apps/sim/src/runtime/clusters.ts`, `apps/sim/test/clusters.test.ts`
- Modify: `apps/sim/src/runtime/game.ts`, `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`

**Interfaces:**
- Commands (self): `clusterCreate {}`, `clusterInvite { operatorId }`, `clusterAccept { clusterId }`, `clusterJoin { code }`, `clusterLeave {}`, `clusterKick { operatorId }`; server message `clusterInvite { clusterId, from, name, expiresAt }`.
- `ClusterService(host: ClusterHost)`: `ensure(id)` → `{ clusterId, code }`, `invite(from, target)`, `accept(id, clusterId)`, `join(id, code)`, `leave(id)`, `kick(leader, target)`, `of(id)` → `{ id, members[] }`, `refresh(clusterId)`, `reattach(id)`; errors are `{ code: 'E_STATE' | 'E_RANGE' | 'E_INVALID', message }`. `CLUSTER_MAX = 4`, `INVITE_TTL_MS = 60000`.
- `Game`: `game.clusters`; the chat host's `clusterOf` is `this.clusters.of`; `leave(session)` calls `clusters.leave`; `moveOperator` calls `clusters.reattach` after the hand-off.
- SDK: `client.cluster.create / invite / accept / join / leave / kick`, event `clusterInvite`, `client.self.cluster`.

- [ ] **Step 1: Protocol**

Commands (before `chat`):

```ts
  z.object({ cmd: z.literal('clusterCreate'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('clusterInvite'), actor: Self, args: z.object({ operatorId: Id }) }),
  z.object({ cmd: z.literal('clusterAccept'), actor: Self, args: z.object({ clusterId: Id }) }),
  z.object({ cmd: z.literal('clusterJoin'), actor: Self, args: z.object({ code: z.string().regex(/^[A-Za-z0-9]{6}$/) }) }),
  z.object({ cmd: z.literal('clusterLeave'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('clusterKick'), actor: Self, args: z.object({ operatorId: Id }) }),
```

Server message (after `muted`):

```ts
  z.object({ t: z.literal('clusterInvite'), seq: Seq, d: z.object({ clusterId: Id, from: Id, name: z.string().nullable(), expiresAt: z.string() }) }),
```

- [ ] **Step 2: Failing tests**

```ts
import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, partyKey } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { ClusterService } from '../src/runtime/clusters.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

/** Two operators in one world, each running a level-20 Pingling, wired to a ClusterService. */
function party() {
  const world = makeWorld('party');
  for (const id of ['alice', 'bob', 'carol']) {
    world.addOperator(operatorRecord(id, { ram: [ownedRecord('pingling', 20, 0, `${id}-d0`)] }));
    step(world, input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } }));
  }
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  let now = 1_000_000;
  const clusters = new ClusterService({
    operator: (id) => {
      const op = world.operators.get(id);
      return op ? { op, subnet: world.subnet.id } : undefined;
    },
    send: (to, msg) => sent.push({ to, msg }),
    now: () => now,
    random: () => 0.5,
  });
  return { world, clusters, sent, tick: (ms: number) => (now += ms) };
}

describe('ClusterService', () => {
  it('invites nearby operators, accepts within 60 s, joins by code, caps at four, and maintains views', () => {
    const { world, clusters, sent, tick } = party();
    const alice = world.operators.get('alice')!;
    const bob = world.operators.get('bob')!;
    expect(clusters.invite('alice', 'alice')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.invite('alice', 'nobody')).toMatchObject({ code: 'E_STATE' });
    bob.x += 40;
    expect(clusters.invite('alice', 'bob')).toMatchObject({ code: 'E_RANGE' });
    bob.x -= 40;
    const inv = clusters.invite('alice', 'bob') as { clusterId: string };
    expect(sent.at(-1)).toMatchObject({ to: 'bob', msg: { t: 'clusterInvite', d: { clusterId: inv.clusterId, from: 'alice', name: 'alice' } } });
    expect(alice.cluster).toMatchObject({ leaderId: 'alice', members: [{ id: 'alice', away: false }] });
    expect(alice.cluster!.code).toMatch(/^[A-Z2-9]{6}$/);
    tick(61_000);
    expect(clusters.accept('bob', inv.clusterId)).toMatchObject({ code: 'E_STATE', message: 'that invite has expired' });
    clusters.invite('alice', 'bob');
    expect(clusters.accept('bob', inv.clusterId)).toEqual({ clusterId: inv.clusterId });
    expect(bob.cluster!.members.map((m) => m.id)).toEqual(['alice', 'bob']);
    expect(partyKey(alice)).toBe(partyKey(bob));
    expect(partyKey(alice)).toBe(`cluster:${inv.clusterId}`);
    expect(clusters.invite('bob', 'carol')).toMatchObject({ code: 'E_STATE', message: 'only the cluster leader invites' });
    expect(clusters.join('carol', 'zzzzzz')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.join('carol', alice.cluster!.code.toLowerCase())).toEqual({ clusterId: inv.clusterId });
    expect(clusters.join('carol', alice.cluster!.code)).toMatchObject({ code: 'E_STATE', message: 'leave your cluster first' });
    world.addOperator(operatorRecord('dave'));
    world.addOperator(operatorRecord('erin'));
    expect(clusters.join('dave', alice.cluster!.code)).toEqual({ clusterId: inv.clusterId });
    expect(clusters.join('erin', alice.cluster!.code)).toMatchObject({ code: 'E_STATE', message: 'that cluster is full' });
    expect(clusters.of('dave')).toEqual({ id: inv.clusterId, members: ['alice', 'bob', 'carol', 'dave'] });
  });

  it('kicks, hands leadership to the oldest member, and dissolves when empty', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    clusters.join('carol', world.operators.get('alice')!.cluster!.code);
    expect(clusters.kick('bob', 'carol')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.kick('alice', 'carol')).toEqual({ ok: true });
    expect(world.operators.get('carol')!.cluster).toBeNull();
    expect(clusters.leave('alice')).toEqual({ ok: true });
    expect(world.operators.get('alice')!.cluster).toBeNull();
    expect(world.operators.get('bob')!.cluster).toMatchObject({ leaderId: 'bob', members: [{ id: 'bob' }] });
    expect(clusters.leave('bob')).toEqual({ ok: true });
    expect(clusters.of('bob')).toBeUndefined();
    expect(clusters.leave('bob')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.ensure('bob')).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) });
  });
});

describe('party tagging, XP and capture rights', () => {
  it('cluster members share a tag; outsiders are locked out; taggedBy reads as "mine" for every member', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const hit = (who: string) => step(world, input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: wild.id } })).replies[0];
    expect(hit('alice')).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(`cluster:${clusterId}`);
    expect(hit('bob')).toMatchObject({ ok: true });
    expect(hit('carol')).toMatchObject({ code: 'E_STATE' });
    const seenBy = (id: string) => (entitiesNear(world, 7.5, 5.5, 8, world.operators.get(id)!).find((e) => e.id === wild.id) as { taggedBy: string }).taggedBy;
    expect(seenBy('alice')).toBe('alice');
    expect(seenBy('bob')).toBe('bob');
    expect(seenBy('carol')).toBe(`cluster:${clusterId}`);
    expect(step(world, input('carol', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    const cap = step(world, input('bob', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } }));
    expect(cap.replies[0]).toMatchObject({ ok: true });
  });

  it('splits XP among the damaging daemons of present members and credits clear tickets to each', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    for (const id of ['alice', 'bob']) {
      world.operators.get(id)!.tickets.push({ id: `t-${id}`, day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    }
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    const xp = [a.xp, b.xp];
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    wild.hp = 1;
    const r = step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(a.xp - xp[0]!).toBeGreaterThan(0);
    expect(a.xp - xp[0]!).toBe(b.xp - xp[1]!);
    const progress = r.events.filter((e) => e.event.e === 'ticketProgress').map((e) => e.to);
    expect(progress.sort()).toEqual(['alice', 'bob']);
    // a member more than 32 tiles from the defeated daemon gets nothing
    const far = placeWild(world, 'bitrot', 20, 2.5, 2.5);
    far.trait = 'echo';
    Object.assign(world.operators.get('alice')!, { x: 29.5, y: 29.5, path: [] });
    Object.assign(world.operators.get('bob')!, { x: 3.5, y: 3.5, path: [] });
    Object.assign(b, { x: 3.5, y: 2.5, path: [], cooldowns: {} });
    const before = a.xp;
    far.hp = 1;
    far.wild!.damagedBy.add('alice-d0');
    step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: far.id } }));
    expect(world.daemons.has(far.id)).toBe(false);
    expect(a.xp).toBe(before);
    expect(world.operators.get('alice')!.tickets[0]!.progress).toBe(1);
    expect(world.operators.get('bob')!.tickets[0]!.progress).toBe(2);
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

describe('clusters through the Game', () => {
  it('commands ack immediately, self.cluster arrives in the next delta, cluster chat reaches members across subnets, away flags follow travel, leaving the game leaves the cluster', async () => {
    const store = new MemoryStore();
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false });
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
    const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), leaveAfterTicks: 2 });
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      return conn;
    };
    let n = 0;
    const cmd = (conn: FakeConn, c: Record<string, unknown>) => game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: `k${++n}`, actor: 'self', ...c } }));
    const alice = await join('alice');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join('bob');
    await cmd(alice, { cmd: 'clusterCreate', args: {} });
    const created = alice.of('ack').at(-1)!.d.result as { clusterId: string; code: string };
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    await cmd(bob, { cmd: 'clusterJoin', args: { code: created.code } });
    expect(bob.of('ack').at(-1)!.d.result).toEqual({ clusterId: created.clusterId });
    game.tick();
    const selfOf = (c: FakeConn) => c.of('delta').at(-1)!.d.self!;
    expect(selfOf(alice).cluster).toMatchObject({ id: created.clusterId, leaderId: selfOf(alice).id, members: [{ away: false }, { subnet: 'testb', away: true }] });
    expect(selfOf(bob).cluster!.members.map((m) => m.away)).toEqual([true, false]);
    await cmd(alice, { cmd: 'chat', args: { channel: `cluster:${created.clusterId}`, text: 'over here' } });
    await game.flush();
    expect(bob.of('chat').map((m) => m.d.text)).toEqual(['over here']);
    await cmd(bob, { cmd: 'clusterKick', args: { operatorId: selfOf(alice).id } });
    expect(bob.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE' });
    game.disconnect(bob);
    game.tick();
    game.tick();
    game.tick();
    expect(selfOf(alice).cluster!.members).toHaveLength(1);
    await game.shutdown();
  });
});
```

- [ ] **Step 3: The service**

```ts
import type { ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, type ClusterView, type Operator } from '../core/index.js';

export const CLUSTER_MAX = 4;
export const INVITE_TTL_MS = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** What the cluster service needs from the game. */
export interface ClusterHost {
  /** A connected operator with the subnet of its current world. */
  operator(id: string): { op: Operator; subnet: string } | undefined;
  send(operatorId: string, msg: Extract<ServerMessage, { t: 'clusterInvite' }>): void;
  now(): number;
  random(): number;
}

interface Cluster {
  id: string;
  code: string;
  leaderId: string;
  /** operator id -> joined at (ms); insertion order = seniority. */
  members: Map<string, number>;
}

export type ClusterError = { code: 'E_STATE' | 'E_RANGE' | 'E_INVALID'; message: string };
const err = (code: ClusterError['code'], message: string): ClusterError => ({ code, message });

/**
 * Clusters (SP4 spec §6): up to 4 operators, formed by inviting someone nearby or by joining with a code.
 * Not persisted. The service owns membership and writes each member's `op.cluster` view; the core derives
 * the party key (shared tagging, XP, capture rights) from it.
 */
export class ClusterService {
  private readonly clusters = new Map<string, Cluster>();
  private readonly byMember = new Map<string, string>();
  private readonly byCode = new Map<string, string>();
  /** `${clusterId}:${operatorId}` -> expires at (ms) */
  private readonly invites = new Map<string, number>();
  private counter = 0;

  constructor(private readonly host: ClusterHost) {}

  of(operatorId: string): { id: string; members: string[] } | undefined {
    const c = this.clusters.get(this.byMember.get(operatorId) ?? '');
    return c ? { id: c.id, members: [...c.members.keys()] } : undefined;
  }

  private create(leaderId: string): Cluster {
    let code = '';
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(this.host.random() * CODE_ALPHABET.length)]).join('');
    } while (this.byCode.has(code));
    const c: Cluster = { id: `c${(++this.counter).toString(36)}${Math.floor(this.host.now() / 1000).toString(36)}`, code, leaderId, members: new Map([[leaderId, this.host.now()]]) };
    this.clusters.set(c.id, c);
    this.byCode.set(code, c.id);
    this.byMember.set(leaderId, c.id);
    return c;
  }

  /** Recomputes every member's view (call after membership or subnet changes). */
  refresh(clusterId: string): void {
    const c = this.clusters.get(clusterId);
    if (!c) return;
    const info = [...c.members.keys()].map((id) => ({ id, at: this.host.operator(id) }));
    for (const me of info) {
      if (!me.at) continue;
      const view: ClusterView = {
        id: c.id,
        code: c.code,
        leaderId: c.leaderId,
        members: info.map((m) => ({ id: m.id, name: m.at?.op.name ?? null, subnet: m.at?.subnet ?? null, away: !m.at || m.at.subnet !== me.at!.subnet })),
      };
      me.at.op.cluster = view;
    }
  }

  /** After an operator (re)enters a world (login, travel): restore its view and everyone's `away` flags. */
  reattach(operatorId: string): void {
    const id = this.byMember.get(operatorId);
    if (id) this.refresh(id);
  }

  /** Create a cluster of one (to get a code) if the operator has none. */
  ensure(operatorId: string): ClusterError | { clusterId: string; code: string } {
    if (!this.host.operator(operatorId)) return err('E_STATE', 'not connected');
    const c = this.clusters.get(this.byMember.get(operatorId) ?? '') ?? this.create(operatorId);
    this.refresh(c.id);
    return { clusterId: c.id, code: c.code };
  }

  invite(from: string, targetId: string): ClusterError | { clusterId: string } {
    const a = this.host.operator(from);
    const b = this.host.operator(targetId);
    if (!a) return err('E_STATE', 'not connected');
    if (targetId === from) return err('E_INVALID', 'cannot invite yourself');
    if (!b) return err('E_STATE', 'that operator is not online');
    if (a.subnet !== b.subnet || distance(a.op, b.op) > INTEREST_RADIUS) return err('E_RANGE', 'invite operators within 32 tiles in your subnet (or share your cluster code)');
    if (this.byMember.has(targetId)) return err('E_STATE', 'that operator is already in a cluster');
    const c = this.clusters.get(this.byMember.get(from) ?? '') ?? this.create(from);
    if (c.leaderId !== from) return err('E_STATE', 'only the cluster leader invites');
    if (c.members.size >= CLUSTER_MAX) return err('E_STATE', `a cluster holds at most ${CLUSTER_MAX} operators`);
    const expiresAt = this.host.now() + INVITE_TTL_MS;
    this.invites.set(`${c.id}:${targetId}`, expiresAt);
    this.refresh(c.id);
    this.host.send(targetId, { t: 'clusterInvite', seq: 0, d: { clusterId: c.id, from, name: a.op.name, expiresAt: new Date(expiresAt).toISOString() } });
    return { clusterId: c.id };
  }

  private add(c: Cluster, operatorId: string): ClusterError | { clusterId: string } {
    if (this.byMember.has(operatorId)) return err('E_STATE', 'leave your cluster first');
    if (c.members.size >= CLUSTER_MAX) return err('E_STATE', 'that cluster is full');
    c.members.set(operatorId, this.host.now());
    this.byMember.set(operatorId, c.id);
    this.refresh(c.id);
    return { clusterId: c.id };
  }

  accept(operatorId: string, clusterId: string): ClusterError | { clusterId: string } {
    const key = `${clusterId}:${operatorId}`;
    const expiresAt = this.invites.get(key);
    this.invites.delete(key);
    const c = this.clusters.get(clusterId);
    if (!c || expiresAt === undefined || expiresAt < this.host.now()) return err('E_STATE', 'that invite has expired');
    return this.add(c, operatorId);
  }

  join(operatorId: string, code: string): ClusterError | { clusterId: string } {
    if (!this.host.operator(operatorId)) return err('E_STATE', 'not connected');
    const c = this.clusters.get(this.byCode.get(code.toUpperCase()) ?? '');
    if (!c) return err('E_INVALID', 'no cluster with that code');
    return this.add(c, operatorId);
  }

  /** Leaves (or is removed on disconnect). The oldest remaining member leads; an empty cluster vanishes. */
  leave(operatorId: string): ClusterError | { ok: true } {
    const c = this.clusters.get(this.byMember.get(operatorId) ?? '');
    if (!c) return err('E_STATE', 'not in a cluster');
    c.members.delete(operatorId);
    this.byMember.delete(operatorId);
    const gone = this.host.operator(operatorId);
    if (gone) gone.op.cluster = null;
    if (c.members.size === 0) {
      this.clusters.delete(c.id);
      this.byCode.delete(c.code);
      for (const k of [...this.invites.keys()]) if (k.startsWith(`${c.id}:`)) this.invites.delete(k);
      return { ok: true };
    }
    if (c.leaderId === operatorId) c.leaderId = c.members.keys().next().value!;
    this.refresh(c.id);
    return { ok: true };
  }

  kick(leaderId: string, targetId: string): ClusterError | { ok: true } {
    const c = this.clusters.get(this.byMember.get(leaderId) ?? '');
    if (!c) return err('E_STATE', 'not in a cluster');
    if (c.leaderId !== leaderId) return err('E_STATE', 'only the cluster leader kicks');
    if (targetId === leaderId || !c.members.has(targetId)) return err('E_INVALID', 'not a member of your cluster');
    return this.leave(targetId);
  }
}
```

- [ ] **Step 4: Game wiring**

Replace `apps/sim/src/runtime/game.ts`:

```ts
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, toSelf, type Input, type Intent, type IntentResult, type World } from '../core/index.js';
import type { Bus } from '@daemonet/bus';
import type { TokenVerifier } from './auth.js';
import { ChatService } from './chat.js';
import { ClusterService, type ClusterError } from './clusters.js';
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
  /** Sim ⇄ api bus (MemoryBus when Redis is not configured). */
  bus: Bus;
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
  readonly chat: ChatService;
  readonly clusters: ClusterService;

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
    const lookup = (id: string) => {
      const s = this.sessions.get(id);
      const op = s?.world.operators.get(id);
      return s && op ? { op, subnet: s.world.subnet.id } : undefined;
    };
    this.clusters = new ClusterService({
      operator: lookup,
      send: (operatorId, msg) => this.sendTo(operatorId, msg),
      now: () => Date.now(),
      random: Math.random,
    });
    this.chat = new ChatService(
      {
        operator: lookup,
        operatorIds: () => this.sessions.keys(),
        send: (operatorId, msg) => this.sendTo(operatorId, msg),
        clusterOf: (id) => this.clusters.of(id),
        now: () => Date.now(),
      },
      this.store,
      opts.bus,
      this.log,
    );
  }

  /** Sends an out-of-tick server message to every connection of an operator. */
  private sendTo(operatorId: string, msg: ServerMessage): void {
    const s = this.sessions.get(operatorId);
    if (!s) return;
    for (const st of s.controller ? [s.controller, ...s.spectators] : [...s.spectators]) this.send(st, msg);
  }

  /** Loads admin filter terms; call once after construction (main.ts). */
  async loadChatTerms(): Promise<void> {
    this.chat.setExtraTerms(await this.store.listFilterTerms());
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
        this.chat.loadMute(rec.id, rec.mutedUntil);
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
    const entities = entitiesNear(world, op.x, op.y, this.radius, op);
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
    if (command.cmd.startsWith('cluster')) {
      // social, not gameplay: handled immediately; the next delta carries the new `self.cluster`
      const id = session.operatorId;
      let r: ClusterError | object;
      switch (command.cmd) {
        case 'clusterCreate':
          r = this.clusters.ensure(id);
          break;
        case 'clusterInvite':
          r = this.clusters.invite(id, command.args.operatorId);
          break;
        case 'clusterAccept':
          r = this.clusters.accept(id, command.args.clusterId);
          break;
        case 'clusterJoin':
          r = this.clusters.join(id, command.args.code);
          break;
        case 'clusterLeave':
          r = this.clusters.leave(id);
          break;
        case 'clusterKick':
          r = this.clusters.kick(id, command.args.operatorId);
          break;
        default:
          r = { code: 'E_INVALID', message: 'unknown cluster command' };
      }
      if ('code' in r && 'message' in r) this.error(st, (r as ClusterError).code, (r as ClusterError).message, reqId);
      else this.send(st, { t: 'ack', seq: 0, d: { reqId, result: r } });
      return;
    }
    if (command.cmd === 'chat') {
      // chat is not gameplay: handled outside the tick, no per-tick budget, its own 2-second limit
      this.track(
        this.chat.post(session.operatorId, command.args.channel, command.args.text).then((err) => {
          if (err) this.error(st, err.code, err.message, reqId);
          else this.send(st, { t: 'ack', seq: 0, d: { reqId } });
        }),
      );
      return;
    }
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
      const near = entitiesNear(world, op.x, op.y, this.radius, op);
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
    this.clusters.leave(session.operatorId);
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
    this.clusters.reattach(intent.operatorId);
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
    this.chat.close();
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

- [ ] **Step 5: SDK**

In `packages/sdk/src/client.ts` add `clusterInvite: Extract<ServerMessage, { t: 'clusterInvite' }>['d'];` to `ClientEvents`, emit it in the frame switch (`case 'clusterInvite': this.emit('clusterInvite', msg.d); return;`), add `readonly cluster = new ClusterApi(this);` to `GameClient`, and the class:

```ts
/** Clusters (SP4): up to 4 operators sharing tags and XP. `client.self.cluster` is the current state. */
export class ClusterApi {
  constructor(private readonly client: GameClient) {}
  /** Creates a cluster of one (if needed) and returns its join code. */
  create() {
    return this.client.command({ cmd: 'clusterCreate', actor: 'self', args: {} });
  }
  /** Invite an operator within 32 tiles in your subnet (you become leader of a new cluster if you have none). */
  invite(operatorId: string) {
    return this.client.command({ cmd: 'clusterInvite', actor: 'self', args: { operatorId } });
  }
  accept(clusterId: string) {
    return this.client.command({ cmd: 'clusterAccept', actor: 'self', args: { clusterId } });
  }
  /** Join by the 6-character code from any subnet. */
  join(code: string) {
    return this.client.command({ cmd: 'clusterJoin', actor: 'self', args: { code } });
  }
  leave() {
    return this.client.command({ cmd: 'clusterLeave', actor: 'self', args: {} });
  }
  kick(operatorId: string) {
    return this.client.command({ cmd: 'clusterKick', actor: 'self', args: { operatorId } });
  }
}
```

- [ ] **Step 6: Verify and commit**

`pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 40 files, 352 tests.

```bash
git add packages/shared packages/sdk apps/sim
git commit -m "feat(sim): clusters (invite, join by code, leave, kick) with cluster chat"
```

---

### Task 3: Client

**Files:**
- Create: `apps/frontend/src/panels/ClusterPanel.tsx`
- Modify: `apps/frontend/src/panels/ChatPanel.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: Panel**

```tsx
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useState } from 'react';
import { run } from '../components/WorldCanvas.tsx';

interface Invite {
  clusterId: string;
  from: string;
  name: string | null;
  expiresAt: string;
}

/** Cluster controls (SP4 spec §6): create / join by code, invite nearby operators, members with away flags, leave / kick. */
export function ClusterPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const cluster = me.cluster;
  const [code, setCode] = useState('');
  const [invites, setInvites] = useState<Invite[]>([]);
  useEffect(() => client.on('clusterInvite', (inv) => setInvites((cur) => [...cur.filter((i) => i.clusterId !== inv.clusterId), inv])), [client]);
  const live = invites.filter((i) => Date.parse(i.expiresAt) > Date.now() && !cluster);
  const nearby = client.world.operators.all().filter((o) => o.id !== client.operatorId && !(cluster?.members.some((m) => m.id === o.id) ?? false));
  const leader = cluster?.leaderId === client.operatorId;

  return (
    <div className="space-y-2 border-b border-neutral-800 p-2 text-xs" data-testid="cluster">
      {cluster ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">cluster</span>
            <span className="mono rounded bg-neutral-800 px-1 text-sky-300" data-testid="cluster-code">
              {cluster.code}
            </span>
            <span className="text-neutral-500">{cluster.members.length}/4 · share the code or invite someone nearby</span>
            <button className="ml-auto text-neutral-400 hover:text-white disabled:opacity-40" disabled={!manual} onClick={() => run(client.cluster.leave(), 'clusterLeave')} data-testid="cluster-leave">
              leave
            </button>
          </div>
          <ul className="mono" data-testid="cluster-members">
            {cluster.members.map((m) => (
              <li key={m.id} className={m.away ? 'text-neutral-500' : 'text-neutral-200'}>
                {m.id === cluster.leaderId ? '★ ' : '  '}
                {m.name ?? m.id.slice(0, 8)} <span className="text-neutral-500">{m.subnet ?? 'offline'}{m.away ? ' · away' : ''}</span>
                {leader && m.id !== client.operatorId && (
                  <button className="ml-2 text-neutral-500 hover:text-red-300" onClick={() => run(client.cluster.kick(m.id), 'clusterKick')}>
                    kick
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={!manual} onClick={() => run(client.cluster.create(), 'clusterCreate')} data-testid="cluster-create">
            new cluster
          </button>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length === 6) run(client.cluster.join(code.trim()), 'clusterJoin');
              setCode('');
            }}
          >
            <input className="mono w-20 rounded bg-neutral-900 px-1 uppercase" placeholder="code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} data-testid="cluster-code-input" />
            <button className="rounded bg-neutral-800 px-2 py-0.5 disabled:opacity-40" disabled={!manual || code.trim().length !== 6} data-testid="cluster-join">
              join
            </button>
          </form>
        </div>
      )}
      {live.map((i) => (
        <div key={i.clusterId} className="flex items-center gap-2 rounded border border-sky-800 px-2 py-1">
          <span>{i.name ?? i.from.slice(0, 8)} invites you to a cluster</span>
          <button className="ml-auto rounded bg-sky-800 px-2" onClick={() => run(client.cluster.accept(i.clusterId), 'clusterAccept')}>
            accept
          </button>
        </div>
      ))}
      {(!cluster || leader) && nearby.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-neutral-500">invite nearby:</span>
          {nearby.slice(0, 6).map((o) => (
            <button key={o.id} className="rounded bg-neutral-800 px-1 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual || (cluster?.members.length ?? 0) >= 4} onClick={() => run(client.cluster.invite(o.id), 'clusterInvite')}>
              {o.name ?? o.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

`ChatPanel` renders `<ClusterPanel client={client} />` as its first child (import it); `connection.ts` logs invites:

```ts
    client.on('clusterInvite', (inv) => log.push('event', `${inv.name ?? 'an operator'} invites you to a cluster (chat tab)`));
```

`sdk-types.ts` gains `ClusterView`, `class ClusterApi { create(); invite(operatorId); accept(clusterId); join(code); leave(); kick(operatorId) }` (all `Promise<unknown>`), `readonly cluster: ClusterApi` on `GameClient`, `cluster: ClusterView | null` on `OperatorSelf`, and the `'clusterInvite'` overload of `on`.

- [ ] **Step 2: End-to-end**

In the two-operator chat scenario of `apps/frontend/e2e/smoke.spec.ts`, before the contexts are closed:

```ts
  // clusters: A opens one, B joins by code, both see two members, cluster chat reaches B
  await pa.getByTestId('tab-chat').click();
  await pa.getByTestId('cluster-create').click();
  const code = (await pa.getByTestId('cluster-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await pb.getByTestId('tab-chat').click();
  await pb.getByTestId('cluster-code-input').fill(code);
  await pb.getByTestId('cluster-join').click();
  await expect(pa.getByTestId('cluster-members').locator('li')).toHaveCount(2, { timeout: 10_000 });
  await expect(pb.getByTestId('cluster-members')).toContainText(`${name}ca`);
  await pb.getByTestId('cluster-leave').click();
  await expect(pa.getByTestId('cluster-members').locator('li')).toHaveCount(1, { timeout: 10_000 });
```

- [ ] **Step 3: Verify and commit**

`pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json`, build, start the stack, `playwright test` — 4 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): cluster panel (code, members, invites)"
```

---

## Self-review

- **Spec coverage:** §6 cluster object and `OperatorSelf.cluster`; invite (same subnet, 32 tiles, 60 s), join by code, leave, kick, leadership to the oldest member, vanish when empty, disconnect removes; party-key tagging in `candidates` / `startCapture`; XP split among present members' damaging daemons (defeat and capture); the capturer keeps the image; `clear` tickets credited to every present member; `away` for members in another subnet (they are not in the world, so they are never "present"); `cluster:<id>` chat through the plan-1 host hook. The spec's `clusterUpdate` / `clusterLeft` events are replaced by the `self.cluster` diff, which carries the same information without a second channel.
- **Type consistency:** `ClusterView` is the same shape in the model, the protocol and the client; errors from the service map one-to-one to protocol error codes.
- **Placeholders:** none.
