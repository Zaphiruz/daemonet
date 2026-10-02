# Daemonet SP6 · Plan 1 — Arena worlds and matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two connected operators can fight each other: queue (ranked or unranked) or challenge directly, get moved into a private `sandbox` world with copies of their RAM daemons, fight under PvP rules until a wipe-out, a forfeit, a disconnect or the four-minute clock, and come home exactly as they left. Ratings, rewards and `arenaWins` follow in plan 2; the Arena tab in plan 3.

**Architecture:** A match is an ordinary `World` built from a new `SANDBOX` subnet definition with `world.arena` set. That one field switches the core's rules: owned daemons target the other operator's running daemons, a command whitelist applies, defeats no longer teleport, and a new `stepArena` system moves the match through `countdown → live → over`. Everything around a match — the queue, challenges, building the world, handing operators over and back, disconnect forfeits — is a runtime service (`ArenaService`) beside `ChatService` and `ClusterService`, driven once per game tick. Operators enter a match with an **arena record** (copies of their non-crashed RAM daemons; level 64 with the signature bonus zeroed when ranked) while the service keeps their **home record**; checkpoints write the home record, so nothing a copy does can reach the database. `Game` gains a generic `transfer` (leave the current world, enter another, snapshot), steps match worlds after the persistent ones, and routes `arena*` commands to the service outside the tick.

**Tech Stack:** as before. No new dependencies, no schema change.

**Prerequisites:** SP5 merged (plans 1–4).

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp6-arena-design.md` §3, §4, §5, §7 (SDK), §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- A match risks nothing: no XP, no item use, no capture, no intents from a match world; the home record is what is checkpointed and what the operator returns with (plus bits / Disk slots / name / org pushed by the api meanwhile).
- Numbers (all in `packages/rules/src/content/arena.ts`): countdown 3 s, match 4 min, return 3 s after the result, disconnect forfeit 8 s, 16 concurrent matches, challenge TTL 60 s, queue window ± 64 widening by 64 every 8 s, 4 ranked matches per pair per UTC day, 2 non-crashed daemons to enter, ranked level 64.

## Notes on the spec

- §4 lists `chat` and `arenaForfeit` among the commands allowed in a match; both are handled by the runtime before a command reaches a world, so the core whitelist is `moveTo, stop, run, recall, swap, use`. A refused command answers `E_STATE 'not available in an arena match'`; `arenaForfeit` outside a match answers `'not in an arena match'`.
- Copies are made of the **non-crashed** RAM daemons only (an operator may enter with as few as two); "all copies crashed" is the wipe-out.
- All matches share the chat channel `subnet:sandbox` (the channel is derived from the subnet id). That is accepted: it works as an arena lounge.
- The pair-per-day cap is counted in memory here; plan 2 makes it authoritative from `ArenaMatch` rows.
- The first operator handed over gets its snapshot before the second one arrives; the opponent's name and team reach it with the next delta (`self.arena`).

## File map

```
packages/rules/src/content/arena.ts         SANDBOX, arena constants, ArenaMode
packages/rules/src/content/subnets.ts       getSubnet('sandbox')
packages/shared/src/protocol.ts             arena commands, events, arenaChallenge message, self.arena
apps/sim/src/core/model.ts                  ArenaState
apps/sim/src/core/systems/arena.ts          arenaCopy, arenaRecord, stepArena, concede, hpFraction, arenaSelf, ARENA_COMMANDS
apps/sim/src/core/{world,view,index}.ts     world.arena, stepArena in the tick, self.arena
apps/sim/src/core/systems/{commands,combat,progress,movement}.ts   PvP rules
apps/sim/src/runtime/arena.ts               ArenaService
apps/sim/src/runtime/game.ts                transfer, match-world stepping, arena command routing, home-record checkpoints
packages/sdk/src/client.ts                  ArenaApi, enemies in a match, arenaChallenge event
apps/sim/test/arena.test.ts, apps/sim/test/arena-service.test.ts, packages/rules/test/arena.test.ts
```

---

### Task 1: The sandbox, the protocol and the match rules

**Files:**
- Create: `packages/rules/src/content/arena.ts`, `packages/rules/test/arena.test.ts`, `apps/sim/src/core/systems/arena.ts`, `apps/sim/test/arena.test.ts`
- Modify: `packages/rules/src/index.ts`, `packages/rules/src/content/subnets.ts`, `packages/shared/src/protocol.ts`, `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/index.ts`, `apps/sim/src/core/systems/{commands,combat,progress,movement}.ts`, `packages/sandbox/test/sandbox.test.ts`

**Interfaces:**
- Rules: `SANDBOX` (with `arenaSpawns`), `ARENA_SUBNET`, `ARENA_LEVEL`, `ARENA_COUNTDOWN_MS`, `ARENA_MATCH_MS`, `ARENA_RETURN_MS`, `ARENA_DISCONNECT_MS`, `ARENA_MAX_MATCHES`, `ARENA_CHALLENGE_TTL_MS`, `ARENA_QUEUE_WINDOW`, `ARENA_QUEUE_WIDEN_MS`, `ARENA_PAIR_DAILY_CAP`, `ARENA_MIN_DAEMONS`, `ARENA_START_RATING`, `type ArenaMode`.
- Protocol: commands `arenaQueue { mode }`, `arenaLeave`, `arenaChallenge { operatorId, mode }`, `arenaAccept { challengeId }`, `arenaForfeit`; events `arenaQueued { mode | null, reason? }`, `arenaMatch { id, mode, opponent, startsAtTick, endsAtTick }`, `arenaResult { id, mode, outcome, reason, ratingBefore, ratingAfter, reward, counted }`; server message `arenaChallenge { challengeId, from, name, mode, expiresAt }`; `OperatorSelf.arena`.
- Core: `ArenaState`; `World.arena: ArenaState | null`; `arenaCopy(record, mode)`, `arenaRecord(record, mode, subnet, at)`, `stepArena(world)`, `concede(world, loserId, 'forfeit' | 'disconnect')`, `hpFraction(world, op)`, `arenaSelf(world, op)`, `ARENA_COMMANDS`.

- [ ] **Step 1: Rules — failing test, then the definition**

Create `packages/rules/test/arena.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HOSTED_SUBNET_IDS, SANDBOX, SUBNETS, getSubnet } from '../src/index.js';

describe('sandbox arena', () => {
  it('is a 48 × 48 subnet that is looked up by id but never hosted as a persistent world', () => {
    expect(getSubnet('sandbox')).toBe(SANDBOX);
    expect(SUBNETS).not.toContain(SANDBOX);
    expect(HOSTED_SUBNET_IDS).not.toContain('sandbox');
    expect([SANDBOX.width, SANDBOX.height, SANDBOX.regions.length, SANDBOX.gateways.length]).toEqual([48, 48, 0, 0]);
  });

  it('is mirrored left to right with spawn points 32 tiles apart on open floor', () => {
    const [a, b] = SANDBOX.arenaSpawns;
    expect(b.x - a.x).toBe(32);
    expect(a.y).toBe(b.y);
    expect(a.x + b.x).toBe(SANDBOX.width + 1);
    const key = (r: { x: number; y: number; w: number; h: number }) => `${r.x},${r.y},${r.w},${r.h}`;
    const walls = new Set(SANDBOX.walls.map(key));
    for (const r of SANDBOX.walls) expect(walls.has(key({ ...r, x: SANDBOX.width - r.x - r.w }))).toBe(true);
    const blocked = (p: { x: number; y: number }) => SANDBOX.walls.some((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    expect(blocked(a) || blocked(b)).toBe(false);
  });
});
```

Create `packages/rules/src/content/arena.ts`:

```ts
import type { SubnetDef } from './subnets.js';

/** Arena (SP6 spec §3–§5). */
export const ARENA_SUBNET = 'sandbox';
/** Ranked copies are rebuilt at this level. */
export const ARENA_LEVEL = 64;
export const ARENA_COUNTDOWN_MS = 3000;
export const ARENA_MATCH_MS = 240_000;
/** Both operators go home this long after the result. */
export const ARENA_RETURN_MS = 3000;
/** A controller gone this long forfeits. */
export const ARENA_DISCONNECT_MS = 8000;
export const ARENA_MAX_MATCHES = 16;
export const ARENA_CHALLENGE_TTL_MS = 60_000;
/** Ranked queue: ± this much rating at first, widening by the same amount every ARENA_QUEUE_WIDEN_MS waited. */
export const ARENA_QUEUE_WINDOW = 64;
export const ARENA_QUEUE_WIDEN_MS = 8000;
/** Only this many ranked matches a day between the same two operators count; later ones are played unranked. */
export const ARENA_PAIR_DAILY_CAP = 4;
/** Non-crashed daemons in RAM needed to enter. */
export const ARENA_MIN_DAEMONS = 2;
export const ARENA_START_RATING = 1500;

export type ArenaMode = 'ranked' | 'unranked';

/** 48 × 48, mirrored left to right: two pillars, a broken centre line, spawn points 32 tiles apart. Nothing spawns, nothing is sold. */
export const SANDBOX: SubnetDef & { arenaSpawns: readonly [{ x: number; y: number }, { x: number; y: number }] } = {
  id: ARENA_SUBNET,
  tier: 0,
  width: 48,
  height: 48,
  walls: [
    { x: 14, y: 10, w: 3, h: 3 },
    { x: 31, y: 10, w: 3, h: 3 },
    { x: 14, y: 35, w: 3, h: 3 },
    { x: 31, y: 35, w: 3, h: 3 },
    { x: 23, y: 6, w: 2, h: 10 },
    { x: 23, y: 32, w: 2, h: 10 },
  ],
  host: { x: 24.5, y: 24.5 },
  spawn: { x: 8.5, y: 24.5 },
  regions: [],
  gateways: [],
  arenaSpawns: [
    { x: 8.5, y: 24.5 },
    { x: 40.5, y: 24.5 },
  ],
};
```

`packages/rules/src/index.ts`: `export * from './content/arena.js';`. `packages/rules/src/content/subnets.ts`: `import { SANDBOX } from './arena.js';` and make `getSubnet` start with `if (id === SANDBOX.id) return SANDBOX;` — the sandbox is deliberately **not** in `SUBNETS`, so it is never hosted as a persistent world, gets no tickets and no gateways. Run `pnpm exec vitest run packages/rules/test/arena.test.ts` — expected: PASS.

- [ ] **Step 2: Protocol**

`packages/shared/src/protocol.ts` — next to `OperatorName`:

```ts
const ArenaModeSchema = z.enum(['ranked', 'unranked']);
const ArenaReason = z.enum(['wipeout', 'timeout', 'forfeit', 'disconnect']);
```

commands (before `chat`):

```ts
  z.object({ cmd: z.literal('arenaQueue'), actor: Self, args: z.object({ mode: ArenaModeSchema }) }),
  z.object({ cmd: z.literal('arenaLeave'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('arenaChallenge'), actor: Self, args: z.object({ operatorId: Id, mode: ArenaModeSchema }) }),
  z.object({ cmd: z.literal('arenaAccept'), actor: Self, args: z.object({ challengeId: Id }) }),
  z.object({ cmd: z.literal('arenaForfeit'), actor: Self, args: z.object({}) }),
```

`OperatorSelf`, after `capture`:

```ts
  /** The arena match this operator is in (SP6), or null. `ram` holds the copies while it lasts. */
  arena: z
    .object({
      id: Id,
      mode: ArenaModeSchema,
      phase: z.enum(['countdown', 'live', 'over']),
      liveAtTick: z.number().int(),
      endsAtTick: z.number().int(),
      opponent: z.object({
        id: Id,
        name: z.string().nullable(),
        tag: z.string().nullable(),
        rating: z.number(),
        team: z.array(z.object({ id: Id, species: Id, level: z.number().int(), hp: z.number(), maxHp: z.number(), crashed: z.boolean(), running: z.boolean() })).max(8),
      }),
      result: z.object({ winner: Id.nullable(), reason: ArenaReason }).nullable(),
    })
    .nullable(),
```

events:

```ts
  /** Arena (SP6): queue state (`mode` null = no longer waiting), a match starting (ticks are the match world's), and its result. */
  z.object({ e: z.literal('arenaQueued'), mode: ArenaModeSchema.nullable(), reason: z.string().optional() }),
  z.object({
    e: z.literal('arenaMatch'),
    id: Id,
    mode: ArenaModeSchema,
    opponent: z.object({ id: Id, name: z.string().nullable(), tag: z.string().nullable(), rating: z.number() }),
    startsAtTick: z.number().int(),
    endsAtTick: z.number().int(),
  }),
  z.object({
    e: z.literal('arenaResult'),
    id: Id,
    mode: ArenaModeSchema,
    outcome: z.enum(['win', 'loss', 'draw']),
    reason: ArenaReason,
    ratingBefore: z.number(),
    ratingAfter: z.number(),
    reward: z.number().int(),
    counted: z.boolean(),
  }),
```

server message:

```ts
  z.object({ t: z.literal('arenaChallenge'), seq: Seq, d: z.object({ challengeId: Id, from: Id, name: z.string().nullable(), mode: ArenaModeSchema, expiresAt: z.string() }) }),
```

`OperatorSelf.arena` is required (nullable): add `arena: null` to the hand-written `self` fixture in `packages/sandbox/test/sandbox.test.ts`.

- [ ] **Step 3: Failing core tests**

Create `apps/sim/test/arena.test.ts`:

```ts
import { ARENA_LEVEL, SANDBOX, getSpecies, movesAtLevel, msToTicks } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { World, arenaCopy, arenaRecord, concede, toSelf, type ArenaState } from '../src/core/index.js';
import { idle, input, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);

/** A match world with alice and bob 2 tiles apart, each with two level-20 copies. */
function duel(phase: ArenaState['phase'] = 'live') {
  const world = new World({ subnet: SANDBOX, seed: 'duel', seedId: 'dddd0001', spawner: false });
  world.arena = { id: 'm1', mode: 'unranked', a: 'alice', b: 'bob', phase, liveAtTick: COUNTDOWN, endsAtTick: COUNTDOWN + msToTicks(240_000), ratings: { alice: 1500, bob: 1540 }, dealt: new Set(), result: null };
  world.addOperator(operatorRecord('alice', { subnet: 'sandbox', x: 8.5, y: 24.5 }));
  world.addOperator(operatorRecord('bob', { subnet: 'sandbox', x: 10.5, y: 24.5 }));
  return world;
}
const run = (world: World, who: string, n = 0) => step(world, input(who, { cmd: 'run', actor: self, args: { daemonId: `${who}-d${n}` } }));

describe('arena copies', () => {
  it('rebuilds ranked copies at level 64 without signature bonus; unranked copies only heal; originals stay as they are', () => {
    const original = { ...ownedRecord('pingling', 20, 0), bonus: [3, 3, 3, 3, 3, 3, 3, 3], signature: 3, hp: 5, energy: 10, heldItem: 'amplifier' };
    const before = structuredClone(original);
    const ranked = arenaCopy(original, 'ranked');
    expect(ranked).toMatchObject({ id: original.id, level: ARENA_LEVEL, bonus: [0, 0, 0, 0, 0, 0, 0, 0], energy: 128, crashed: false, heldItem: 'amplifier', ivs: original.ivs });
    expect(ranked.moves).toEqual(movesAtLevel(getSpecies('pingling'), ARENA_LEVEL));
    expect(ranked.hp).toBeGreaterThan(before.hp * 4);
    const casual = arenaCopy(original, 'unranked');
    expect(casual).toMatchObject({ level: 20, bonus: before.bonus, moves: before.moves, energy: 128 });
    expect(casual.hp).toBeGreaterThan(5);
    expect(original).toEqual(before);

    const rec = operatorRecord('alice', { ram: [ownedRecord('pingling', 20, 0, 'a0'), { ...ownedRecord('pingling', 20, 1, 'a1'), crashed: true, hp: 0 }, ownedRecord('glitchmite', 9, 2, 'a2')], tickets: [{ id: 't', day: 'd', subnet: 'lo', index: 0, kind: 'clear', params: {}, target: 1, reward: 1, progress: 0, pending: false, completing: false }] });
    const entered = arenaRecord(rec, 'ranked', 'sandbox', { x: 8.5, y: 24.5 });
    expect(entered).toMatchObject({ subnet: 'sandbox', x: 8.5, y: 24.5, tickets: [] });
    expect(entered.ram.map((d) => [d.id, d.level])).toEqual([['a0', 64], ['a2', 64]]);
    expect(rec.ram[0]!.level).toBe(20);
  });
});

describe('arena match rules', () => {
  it('only lets the operator move during the countdown, then goes live', () => {
    const world = duel('countdown');
    expect(run(world, 'alice').replies[0]).toMatchObject({ ok: false, message: 'the match has not started' });
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 24.5 } })).replies[0]).toMatchObject({ ok: true });
    idle(world, COUNTDOWN);
    expect(world.arena!.phase).toBe('live');
    expect(run(world, 'alice').replies[0]).toMatchObject({ ok: true });
  });

  it('targets only the opponent’s running daemons and refuses everything outside the whitelist', () => {
    const world = duel();
    run(world, 'alice');
    run(world, 'bob');
    const move = world.daemons.get('alice-d0')!.moves[0]!;
    const use = (targetId: string) => step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, targetId } })).replies[0];
    expect(use('bob')).toMatchObject({ ok: false, message: 'not a valid target' });
    expect(use('bob-d1')).toMatchObject({ ok: false, message: 'not a valid target' }); // in RAM, not running
    expect(use('alice-d0')).toMatchObject({ ok: false });
    world.daemons.get('alice-d0')!.cooldowns = {};
    const before = world.daemons.get('bob-d0')!.hp;
    world.daemons.get('bob-d0')!.trait = 'echo';
    expect(use('bob-d0')).toMatchObject({ ok: true });
    expect(world.daemons.get('bob-d0')!.hp).toBeLessThan(before);
    expect([...world.arena!.dealt]).toEqual(['alice-d0']);
    for (const command of [
      { cmd: 'capture', actor: self, args: { targetId: 'bob-d0', tool: 'sniff' } },
      { cmd: 'useItem', actor: self, args: { item: 'restore', daemonId: 'alice-d0' } },
      { cmd: 'restoreAll', actor: self, args: {} },
      { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } },
      { cmd: 'travel', actor: self, args: { gatewayId: 'x' } },
    ] as const) {
      expect(step(world, input('alice', command)).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'not available in an arena match' });
    }
    // the opponent's team is visible for the HUD, running or not
    expect(toSelf(world, world.operators.get('alice')!).arena).toMatchObject({
      id: 'm1', phase: 'live', opponent: { id: 'bob', name: 'bob', rating: 1540, team: [{ id: 'bob-d0', running: true, crashed: false }, { id: 'bob-d1', running: false }] }, result: null,
    });
  });

  it('ends when one side has no copies left; the loser stays where it stands', () => {
    const world = duel();
    run(world, 'alice');
    run(world, 'bob');
    const bob = world.operators.get('bob')!;
    world.daemons.get('bob-d1')!.crashed = true;
    world.daemons.get('bob-d0')!.hp = 0;
    step(world);
    expect(world.arena).toMatchObject({ phase: 'over', result: { winner: 'alice', reason: 'wipeout' } });
    expect([bob.x, bob.y]).toEqual([10.5, 24.5]);
    expect(world.operators.get('alice')!.running).toEqual([]);
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 24.5 } })).replies[0]).toMatchObject({ ok: false, message: 'the match is over' });
  });

  it('times out to the higher total HP fraction; equal fractions draw', () => {
    const world = duel();
    world.daemons.get('bob-d0')!.hp -= 1;
    world.tick = world.arena!.endsAtTick - 1;
    step(world);
    expect(world.arena!.result).toMatchObject({ winner: 'alice', reason: 'timeout' });

    const even = duel();
    even.tick = even.arena!.endsAtTick - 1;
    step(even);
    expect(even.arena!.result).toMatchObject({ winner: null, reason: 'timeout' });

    const quit = duel('countdown');
    concede(quit, 'alice', 'forfeit');
    expect(quit.arena).toMatchObject({ phase: 'over', result: { winner: 'bob', reason: 'forfeit' } });
    concede(quit, 'bob', 'forfeit'); // already over
    expect(quit.arena!.result!.winner).toBe('bob');
  });
});
```

- [ ] **Step 4: The core**

`apps/sim/src/core/model.ts` (import `ArenaMode` from rules):

```ts
/** A match world's state (SP6 spec §4–§5). The runtime's ArenaService creates it; the core runs the rules. */
export interface ArenaState {
  id: string;
  mode: ArenaMode;
  a: string;
  b: string;
  phase: 'countdown' | 'live' | 'over';
  liveAtTick: number;
  endsAtTick: number;
  /** Rating of each operator when the match started (shown to the opponent). */
  ratings: Record<string, number>;
  /** Copies that dealt damage (they earn `arenaWins` on a ranked win). */
  dealt: Set<string>;
  result: { winner: string | null; reason: 'wipeout' | 'timeout' | 'forfeit' | 'disconnect'; atTick: number } | null;
}
```

Create `apps/sim/src/core/systems/arena.ts`:

```ts
import { ARENA_LEVEL, ENERGY_MAX, computeStats, getSpecies, movesAtLevel, statBlock, statBlockFromArray, statBlockToArray, xpForLevel, type ArenaMode } from '@daemonet/rules';
import type { OperatorSelf } from '@daemonet/shared';
import type { ArenaState, Operator, OperatorRecord, OwnedDaemonRecord } from '../model.js';
import type { World } from '../world.js';

/** Commands a match accepts while live (SP6 spec §4); `chat` and the `arena*` commands never reach the world. */
export const ARENA_COMMANDS: ReadonlySet<string> = new Set(['moveTo', 'stop', 'run', 'recall', 'swap', 'use']);

/**
 * The copy of a daemon that fights in a match: full HP and energy, never crashed. Ranked copies are rebuilt at
 * level 64 with the signature bonus zeroed, so only species, IVs, nature, trait and held item differ.
 */
export function arenaCopy(rec: OwnedDaemonRecord, mode: ArenaMode): OwnedDaemonRecord {
  const sp = getSpecies(rec.species);
  const ranked = mode === 'ranked';
  const level = ranked ? ARENA_LEVEL : rec.level;
  const bonus = ranked ? statBlock(0) : statBlockFromArray(rec.bonus);
  const stats = computeStats({ base: sp.base, ivs: statBlockFromArray(rec.ivs), bonus, level, nature: rec.nature });
  return {
    ...rec,
    level,
    xp: ranked ? xpForLevel(level) : rec.xp,
    bonus: statBlockToArray(bonus),
    moves: ranked ? movesAtLevel(sp, level) : [...rec.moves],
    hp: stats.hp,
    energy: ENERGY_MAX,
    crashed: false,
    ivs: [...rec.ivs],
    moveTypeUses: [...rec.moveTypeUses],
    history: [],
  };
}

/** The record an operator enters a match with: copies of the non-crashed RAM daemons, no tickets, placed at `at`. */
export function arenaRecord(rec: OperatorRecord, mode: ArenaMode, subnet: string, at: { x: number; y: number }): OperatorRecord {
  return {
    ...rec,
    subnet,
    x: at.x,
    y: at.y,
    inventory: { ...rec.inventory },
    ram: rec.ram.filter((d) => !d.crashed).map((d) => arenaCopy(d, mode)),
    diskSlots: [...rec.diskSlots],
    tickets: [],
    acceptedToday: [...rec.acceptedToday],
    research: { ...rec.research },
  };
}

/** Sum over a side's copies of hp / maxHp (crashed copies count 0). */
export function hpFraction(world: World, op: Operator): number {
  let sum = 0;
  for (const id of op.ram) {
    const d = world.daemons.get(id)!;
    if (!d.crashed && d.stats.hp > 0) sum += Math.max(0, d.hp) / d.stats.hp;
  }
  return sum;
}

const wiped = (world: World, op: Operator): boolean => op.ram.every((id) => world.daemons.get(id)!.crashed);

function finish(world: World, arena: ArenaState, winner: string | null, reason: NonNullable<ArenaState['result']>['reason']): void {
  arena.phase = 'over';
  arena.result = { winner, reason, atTick: world.tick };
  for (const op of world.operators.values()) {
    op.path = [];
    for (const id of [...op.running]) world.deactivate(world.daemons.get(id)!);
  }
}

/** The operator gives up (or its controller has been gone too long): the other side wins. No-op once the match is over. */
export function concede(world: World, loserId: string, reason: 'forfeit' | 'disconnect'): void {
  const arena = world.arena;
  if (!arena || arena.phase === 'over') return;
  finish(world, arena, loserId === arena.a ? arena.b : arena.a, reason);
}

/** Countdown → live → over. Runs after defeats are resolved, so a wipe-out ends the match on the tick it happens. */
export function stepArena(world: World): void {
  const arena = world.arena;
  if (!arena || arena.phase === 'over') return;
  if (arena.phase === 'countdown') {
    if (world.tick >= arena.liveAtTick) arena.phase = 'live';
    return;
  }
  const a = world.operators.get(arena.a);
  const b = world.operators.get(arena.b);
  if (!a || !b) return finish(world, arena, a ? arena.a : b ? arena.b : null, 'disconnect');
  const aOut = wiped(world, a);
  const bOut = wiped(world, b);
  if (aOut || bOut) return finish(world, arena, aOut && bOut ? null : aOut ? b.id : a.id, 'wipeout');
  if (world.tick >= arena.endsAtTick) {
    const fa = hpFraction(world, a);
    const fb = hpFraction(world, b);
    finish(world, arena, fa === fb ? null : fa > fb ? a.id : b.id, 'timeout');
  }
}

/** What an operator's client is told about its match: the phase, the clock and the opponent's eight copies for the HUD. */
export function arenaSelf(world: World, op: Operator): OperatorSelf['arena'] {
  const arena = world.arena;
  if (!arena) return null;
  const other = world.operators.get(op.id === arena.a ? arena.b : arena.a);
  return {
    id: arena.id,
    mode: arena.mode,
    phase: arena.phase,
    liveAtTick: arena.liveAtTick,
    endsAtTick: arena.endsAtTick,
    opponent: {
      id: other?.id ?? (op.id === arena.a ? arena.b : arena.a),
      name: other?.name ?? null,
      tag: other?.org?.tag ?? null,
      rating: arena.ratings[op.id === arena.a ? arena.b : arena.a] ?? 0,
      team: (other?.ram ?? []).map((id) => {
        const d = world.daemons.get(id)!;
        return { id: d.id, species: d.species, level: d.level, hp: d.hp, maxHp: d.stats.hp, crashed: d.crashed, running: d.active };
      }),
    },
    result: arena.result ? { winner: arena.result.winner, reason: arena.result.reason } : null,
  };
}
```

`apps/sim/src/core/world.ts`: a field

```ts
  /** Set on arena match worlds (SP6): PvP targeting, the command whitelist and the win conditions apply. */
  arena: ArenaState | null = null;
```

and `stepArena(this);` in `step()` right after `resolveDefeats(this, out);`.

`apps/sim/src/core/systems/commands.ts` — in `handle`, after the `travelling` check:

```ts
  if (world.arena) {
    if (world.arena.phase === 'over') throw new Rejection('E_STATE', 'the match is over');
    if (!ARENA_COMMANDS.has(c.cmd)) throw new Rejection('E_STATE', 'not available in an arena match');
    const operatorMove = (c.cmd === 'moveTo' || c.cmd === 'stop') && c.actor === 'self';
    if (world.arena.phase === 'countdown' && !operatorMove) throw new Rejection('E_STATE', 'the match has not started');
  }
```

`apps/sim/src/core/systems/combat.ts` — at the top of `candidates`:

```ts
  if (attacker.ownerId && world.arena) {
    // arena match: the other operator's running daemons, and nothing else
    const out: Victim[] = [];
    if (world.arena.phase !== 'live') return out;
    for (const d of world.daemons.values()) if (d.active && d.hp > 0 && d.ownerId !== null && d.ownerId !== attacker.ownerId) out.push({ kind: 'daemon', d });
    return out;
  }
```

and in `applyHit`, after the `hit` event: `if (world.arena && amount > 0) world.arena.dealt.add(attacker.id);`.

`apps/sim/src/core/systems/progress.ts` — in `resolveDefeats`, after `world.deactivate(d);` for an owned daemon:

```ts
    // in a match the wipe-out is a win condition, not a trip back to the spawn point
    if (world.arena) continue;
```

`apps/sim/src/core/systems/movement.ts` — `hostileNear` treats the opponent's daemons as hostile in a match:

```ts
    if (world.arena ? other.ownerId === d.ownerId : (other.ownerId === null) === (d.ownerId === null)) continue;
```

`apps/sim/src/core/view.ts` — `toSelf` returns `arena: arenaSelf(world, op)`. `apps/sim/src/core/index.ts`:

```ts
export { ARENA_COMMANDS, arenaCopy, arenaRecord, concede, hpFraction } from './systems/arena.js';
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm exec vitest run packages/rules packages/sandbox apps/sim` — expected: green (5 new core tests, 2 new rules tests).

```bash
git add packages/rules packages/shared packages/sandbox apps/sim
git commit -m "feat(sim): sandbox arena worlds — PvP targeting, command whitelist, win conditions, copies"
```

---

### Task 2: `ArenaService` and the runtime

**Files:**
- Create: `apps/sim/src/runtime/arena.ts`, `apps/sim/test/arena-service.test.ts`
- Modify: `apps/sim/src/runtime/game.ts`

**Interfaces:**
- `new ArenaService(deps: ArenaDeps)` with `locate`, `connected`, `transfer`, `event`, `send`, `rating`, `now`, `newId`.
- `queueUp(id, mode)`, `leaveQueue(id)`, `challenge(id, targetId, mode)`, `accept(id, challengeId)`, `forfeit(id)` — each returns a result object or `{ code, message }`; `drop(id)`; `tick()`; `worlds()`; `inMatch(id)`; `homeRecord(id)`; `queued(id)`.
- `Game.arena: ArenaService`; private `Game.transfer(operatorId, to, record)`.

- [ ] **Step 1: Failing tests**

Create `apps/sim/test/arena-service.test.ts`:

```ts
import { MemoryBus } from '@daemonet/bus';
import { ARENA_LEVEL, ARENA_MAX_MATCHES, SANDBOX, msToTicks } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type OperatorRecord } from '../src/core/index.js';
import { ArenaService } from '../src/runtime/arena.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);
const RETURN = msToTicks(3000);

/** ArenaService over one real home world, with the runtime's part (sessions, snapshots) faked. */
function harness(names: string[], ratings: Record<string, number> = {}) {
  const home = makeWorld('home');
  const where = new Map<string, World>();
  const events: Array<{ to: string; event: GameEvent }> = [];
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  const offline = new Set<string>();
  let now = Date.parse('2026-10-02T12:00:00Z');
  let n = 0;
  for (const name of names) {
    home.addOperator(operatorRecord(name));
    where.set(name, home);
  }
  const arena = new ArenaService({
    locate: (id) => {
      const world = where.get(id);
      const op = world?.operators.get(id);
      return world === home && op ? { op, world } : undefined;
    },
    connected: (id) => !offline.has(id),
    transfer: (id, to, record: OperatorRecord) => {
      where.get(id)!.removeOperator(id);
      to.addOperator({ ...record, subnet: to.subnet.id });
      where.set(id, to);
    },
    event: (to, event) => events.push({ to, event }),
    send: (to, msg) => sent.push({ to, msg }),
    rating: (id) => ratings[id] ?? 1500,
    now: () => now,
    newId: () => `${(++n).toString(16).padStart(8, '0')}${'0'.repeat(24)}`,
  });
  /** One game tick: match worlds step, then the service. */
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      for (const w of arena.worlds()) w.step([]);
      arena.tick();
    }
  };
  return { home, where, arena, events, sent, offline, tick, advance: (ms: number) => (now += ms), of: (e: GameEvent['e'], to?: string) => events.filter((x) => x.event.e === e && (!to || x.to === to)).map((x) => x.event) };
}

describe('ArenaService', () => {
  it('checks who may enter', () => {
    const h = harness(['alice', 'bob']);
    const alice = h.home.operators.get('alice')!;
    step(h.home, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ code: 'E_STATE', message: 'recall running daemons first' });
    h.home.deactivate(h.home.daemons.get('alice-d0')!);
    h.home.daemons.get('alice-d1')!.crashed = true;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'the arena needs 2 daemons in RAM that have not crashed' });
    h.home.daemons.get('alice-d1')!.crashed = false;
    alice.starterClaimed = false;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'claim a starter first' });
    alice.starterClaimed = true;
    expect(h.arena.queueUp('nobody', 'unranked')).toMatchObject({ message: 'not connected' });
    expect(h.arena.forfeit('alice')).toMatchObject({ message: 'not in an arena match' });
    expect(h.arena.queueUp('alice', 'unranked')).toEqual({ queued: 'unranked' });
    expect(h.arena.queued('alice')).toBe('unranked');
    h.arena.leaveQueue('alice');
    expect(h.of('arenaQueued', 'alice')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }, { e: 'arenaQueued', mode: null }]);
  });

  it('pairs the unranked queue in order, runs the match and brings both home as they were', () => {
    const h = harness(['alice', 'bob', 'carol']);
    h.home.daemons.get('alice-d0')!.hp = 7;
    h.home.operators.get('alice')!.x = 9.5;
    for (const name of ['alice', 'bob', 'carol']) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
    expect(h.arena.queued('carol')).toBe('unranked');
    const [world] = h.arena.worlds();
    expect(world!.subnet.id).toBe('sandbox');
    expect([...h.home.operators.keys()]).toEqual(['carol']);
    expect(world!.operators.get('alice')).toMatchObject(SANDBOX.arenaSpawns[0]);
    expect(world!.operators.get('bob')).toMatchObject(SANDBOX.arenaSpawns[1]);
    expect(world!.daemons.get('alice-d0')!.hp).toBeGreaterThan(7); // the copy is healed
    expect(h.of('arenaMatch', 'alice')[0]).toMatchObject({ mode: 'unranked', opponent: { id: 'bob', name: 'bob', rating: 1500 }, startsAtTick: COUNTDOWN });
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'already in an arena match' });
    // what a checkpoint would write while the match runs
    expect(h.arena.homeRecord('alice')).toMatchObject({ subnet: 'test', x: 9.5, ram: [{ id: 'alice-d0', hp: 7, level: 20 }, { id: 'alice-d1' }] });

    h.tick(COUNTDOWN);
    world!.operators.get('alice')!.bits += 50; // a sale on the Exchange lands mid-match
    expect(h.arena.forfeit('bob')).toEqual({ ok: true });
    h.tick();
    expect(h.of('arenaResult', 'alice')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit', counted: false, reward: 0 });
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'loss', reason: 'forfeit' });
    expect(h.arena.inMatch('alice')).toBe(true);
    h.tick(RETURN);
    expect(h.arena.inMatch('alice') || h.arena.inMatch('bob')).toBe(false);
    expect(h.arena.worlds()).toEqual([]);
    const alice = h.home.operators.get('alice')!;
    expect(alice).toMatchObject({ x: 9.5, bits: 50 });
    expect(h.home.daemons.get('alice-d0')).toMatchObject({ hp: 7, level: 20, crashed: false });
    expect(h.home.operators.has('bob')).toBe(true);
  });

  it('pairs ranked operators by rating, widening the window every 8 s', () => {
    const h = harness(['a', 'b', 'c'], { a: 1500, b: 1700, c: 1960 });
    for (const name of ['a', 'b', 'c']) h.arena.queueUp(name, 'ranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(0); // 200 apart, windows 64 + 64
    h.advance(8000);
    h.tick(16);
    expect(h.arena.inMatch('a') && h.arena.inMatch('b')).toBe(true); // 128 + 128
    expect(h.arena.inMatch('c')).toBe(false);
    const [world] = h.arena.worlds();
    expect(world!.daemons.get('a-d0')!.level).toBe(ARENA_LEVEL);
    expect(world!.arena).toMatchObject({ mode: 'ranked', ratings: { a: 1500, b: 1700 } });
  });

  it('challenges: delivered, accepted within 60 s, one at a time', () => {
    const h = harness(['alice', 'bob']);
    expect(h.arena.challenge('alice', 'alice', 'unranked')).toMatchObject({ code: 'E_INVALID' });
    expect(h.arena.challenge('alice', 'nobody', 'unranked')).toMatchObject({ message: 'that operator is not online' });
    const first = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.sent.at(-1)).toMatchObject({ to: 'bob', msg: { t: 'arenaChallenge', d: { challengeId: first.challengeId, from: 'alice', name: 'alice', mode: 'unranked' } } });
    expect(h.arena.accept('alice', first.challengeId)).toMatchObject({ code: 'E_INVALID' }); // not addressed to alice
    h.advance(61_000);
    expect(h.arena.accept('bob', first.challengeId)).toMatchObject({ message: 'that challenge has expired' });
    const second = h.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string };
    const third = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.arena.accept('bob', second.challengeId)).toMatchObject({ code: 'E_INVALID' }); // replaced by the third
    expect(h.arena.accept('bob', third.challengeId)).toMatchObject({ matchId: expect.any(String) });
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
  });

  it('a controller gone for 8 s forfeits; an operator that leaves is sent home at once', () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', (h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string }).challengeId);
    h.offline.add('alice');
    h.tick(msToTicks(8000) - 1);
    expect(h.of('arenaResult')).toEqual([]);
    h.tick();
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });

    h.arena.accept('dave', (h.arena.challenge('carol', 'dave', 'unranked') as { challengeId: string }).challengeId);
    h.arena.drop('carol');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.arena.inMatch('carol')).toBe(false);
    expect(h.arena.inMatch('dave')).toBe(true);
    expect(h.of('arenaResult', 'dave')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    h.tick(RETURN + 1);
    expect(h.where.get('dave')).toBe(h.home);
  });

  it('caps concurrent matches at 16 and ranked matches between the same pair at 4 a day', () => {
    const names = Array.from({ length: 2 * ARENA_MAX_MATCHES + 2 }, (_, i) => `op${i}`);
    const h = harness(names);
    for (const name of names) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(ARENA_MAX_MATCHES);
    expect(h.arena.queued('op32')).toBe('unranked');
    expect(h.arena.accept('op33', (h.arena.challenge('op32', 'op33', 'unranked') as { challengeId: string }).challengeId)).toMatchObject({ message: 'the arena is full; try again shortly' });

    const pair = harness(['alice', 'bob']);
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      pair.arena.accept('bob', (pair.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string }).challengeId);
      modes.push(pair.arena.worlds()[0]!.arena!.mode);
      pair.arena.forfeit('alice');
      pair.tick(RETURN + 2);
    }
    expect(modes).toEqual(['ranked', 'ranked', 'ranked', 'ranked', 'unranked']);
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `arena-conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  events<E extends GameEvent['e']>(e: E) {
    return this.of('delta').flatMap((m) => m.d.events).filter((x): x is Extract<GameEvent, { e: E }> => x.e === e);
  }
}

describe('arena matches in the runtime', () => {
  async function setup(opts: { leaveAfterTicks?: number; checkpointEveryTicks?: number } = {}) {
    const store = new MemoryStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), ...opts });
    let seq = 0;
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      const id = conn.of('authOk')[0]!.d.operatorId;
      const op = world.operators.get(id)!;
      op.starterClaimed = true;
      op.name = name;
      world.addOwned(op, { ...ownedRecord('pingling', 20, 0, `${name}-d0`), originalOperatorId: id });
      world.addOwned(op, { ...ownedRecord('glitchmite', 20, 1, `${name}-d1`), originalOperatorId: id });
      const cmd = (command: object) => game.message(conn, JSON.stringify({ t: 'cmd', seq: ++seq, d: { reqId: `q${seq}`, ...command } }));
      return { conn, id, cmd };
    };
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) game.tick();
    };
    return { game, world, store, join, ticks };
  }

  it('queues two operators into a sandbox world with fresh snapshots, and back', async () => {
    const { game, world, join, ticks } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    await a.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'not in an arena match' });
    await a.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    await b.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    expect(a.conn.of('ack').at(-1)!.d.result).toEqual({ queued: 'unranked' });
    ticks(17);
    expect(a.conn.events('arenaQueued')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }]);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'sandbox', self: { arena: { phase: 'countdown', mode: 'unranked', opponent: { id: b.id } } } });
    // alice entered first; the delta that follows shows bob and his team
    expect(a.conn.of('delta').at(-1)!.d.self!.arena!.opponent).toMatchObject({ name: 'bob', team: [{ id: 'bob-d0', running: false }, { id: 'bob-d1' }] });
    expect(a.conn.events('arenaMatch')[0]).toMatchObject({ opponent: { id: b.id } });
    expect(world.operators.size).toBe(0);
    expect(game.worldOf(a.id)!.subnet.id).toBe('sandbox');

    ticks(COUNTDOWN);
    // a normal command now runs in the match world; one outside the whitelist is refused there
    await a.cmd({ cmd: 'run', actor: 'self', args: { daemonId: 'alice-d0' } });
    await a.cmd({ cmd: 'restoreAll', actor: 'self', args: {} });
    ticks(1);
    expect(a.conn.of('ack').at(-1)!.d.reqId).toBeDefined();
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ message: 'not available in an arena match' });
    expect(a.conn.of('delta').at(-1)!.d.self).toMatchObject({ running: ['alice-d0'], arena: { phase: 'live' } });

    await b.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    ticks(2);
    expect(a.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit' });
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'loss' });
    ticks(RETURN + 1);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'test', self: { arena: null, running: [], ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1' }] } });
    expect(world.operators.size).toBe(2);
    await game.shutdown();
  });

  it('checkpoints the home record during a match and forfeits for an operator that leaves', async () => {
    const { game, world, store, join, ticks } = await setup({ leaveAfterTicks: 24, checkpointEveryTicks: 8 });
    const a = await join('alice');
    const b = await join('bob');
    const checkpoints: OperatorRecord[][] = [];
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(records.map((r) => structuredClone(r)));
      return checkpoint(records);
    };
    await a.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: b.id, mode: 'ranked' } });
    const challenge = b.conn.of('arenaChallenge')[0]!.d;
    expect(challenge).toMatchObject({ from: a.id, name: 'alice', mode: 'ranked' });
    await b.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: challenge.challengeId } });
    expect(a.conn.of('snapshot').at(-1)!.d.self.ram[0]).toMatchObject({ level: ARENA_LEVEL });
    ticks(16);
    await game.flush();
    expect(checkpoints.at(-1)!.find((r) => r.id === a.id)).toMatchObject({ subnet: 'test', ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1', level: 20 }] });

    game.disconnect(a.conn);
    ticks(25);
    await game.flush();
    expect(game.worldOf(a.id)).toBeUndefined(); // gone from the server…
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    expect(checkpoints.at(-1)).toMatchObject([{ id: a.id, subnet: 'test', ram: [{ level: 20 }, { level: 20 }] }]); // …with its real daemons
    ticks(RETURN + 1);
    expect(game.worldOf(b.id)).toBe(world);
    await game.shutdown();
  });
});
```

- [ ] **Step 2: The service**

Create `apps/sim/src/runtime/arena.ts`:

```ts
import {
  ARENA_CHALLENGE_TTL_MS,
  ARENA_COUNTDOWN_MS,
  ARENA_DISCONNECT_MS,
  ARENA_MATCH_MS,
  ARENA_MAX_MATCHES,
  ARENA_MIN_DAEMONS,
  ARENA_PAIR_DAILY_CAP,
  ARENA_QUEUE_WIDEN_MS,
  ARENA_QUEUE_WINDOW,
  ARENA_RETURN_MS,
  SANDBOX,
  msToTicks,
  type ArenaMode,
} from '@daemonet/rules';
import type { ErrorCode, GameEvent, ServerMessage } from '@daemonet/shared';
import { World, arenaRecord, concede, type Operator, type OperatorRecord } from '../core/index.js';

export interface ArenaError {
  code: ErrorCode;
  message: string;
}
const fail = (message: string, code: ErrorCode = 'E_STATE'): ArenaError => ({ code, message });
const isError = (r: object): r is ArenaError => 'code' in r && 'message' in r;

/** What the service needs from the runtime (`Game`); tests pass fakes. */
export interface ArenaDeps {
  /** A connected operator that is in a persistent world (not in a match), with that world. */
  locate(id: string): { op: Operator; world: World } | undefined;
  /** True while a controller connection is attached to the operator's session. */
  connected(id: string): boolean;
  /** Hands the operator from the world it is in to `to`, entering with `record`, and sends fresh snapshots. */
  transfer(id: string, to: World, record: OperatorRecord): void;
  /** Queues an event for the operator in whatever world it is in. */
  event(id: string, event: GameEvent): void;
  send(id: string, msg: ServerMessage): void;
  rating(id: string): number;
  now(): number;
  /** 32 hex characters. */
  newId(): string;
}

interface Side {
  id: string;
  home: World;
  /** The operator as it left its home world: what checkpoints write and what it returns with. */
  record: OperatorRecord;
  goneTicks: number;
  returned: boolean;
}

interface Match {
  id: string;
  mode: ArenaMode;
  world: World;
  sides: [Side, Side];
  reported: boolean;
  returnAtTick: number;
}

interface Waiting {
  id: string;
  mode: ArenaMode;
  since: number;
}

interface Challenge {
  id: string;
  from: string;
  to: string;
  mode: ArenaMode;
  expiresAt: number;
}

const MATCHMAKING_EVERY_TICKS = 16;

/**
 * Arena matches (SP6 spec §5): the queue, direct challenges and the life of each match world. Runs outside the
 * worlds' ticks; the match rules themselves (targets, win conditions) live in the core.
 */
export class ArenaService {
  private readonly matches = new Map<string, Match>();
  private readonly byOperator = new Map<string, Match>();
  private queue: Waiting[] = [];
  private readonly challenges = new Map<string, Challenge>();
  /** `<a>|<b>:<utc day>` → ranked matches started today between the two. */
  private readonly pairCounts = new Map<string, number>();
  private ticks = 0;

  constructor(private readonly deps: ArenaDeps) {}

  /** Match worlds to step this tick. */
  worlds(): World[] {
    return [...this.matches.values()].map((m) => m.world);
  }

  inMatch(id: string): boolean {
    return this.byOperator.has(id);
  }

  /** The record to checkpoint for an operator that is in a match (its home-world state), if any. */
  homeRecord(id: string): OperatorRecord | undefined {
    return this.byOperator.get(id)?.sides.find((s) => s.id === id && !s.returned)?.record;
  }

  queued(id: string): ArenaMode | null {
    return this.queue.find((w) => w.id === id)?.mode ?? null;
  }

  // ---- entering ----

  private eligible(id: string): ArenaError | { op: Operator; world: World } {
    if (this.byOperator.has(id)) return fail('already in an arena match');
    const loc = this.deps.locate(id);
    if (!loc) return fail('not connected');
    const { op, world } = loc;
    if (!op.starterClaimed) return fail('claim a starter first');
    const ready = op.ram.filter((d) => !world.daemons.get(d)!.crashed).length;
    if (ready < ARENA_MIN_DAEMONS) return fail(`the arena needs ${ARENA_MIN_DAEMONS} daemons in RAM that have not crashed`);
    if (op.running.length > 0) return fail('recall running daemons first');
    if (op.captureId) return fail('a capture is in progress');
    if (op.travelling || world.hasPendingFor(id)) return fail('wait for pending actions');
    return loc;
  }

  queueUp(id: string, mode: ArenaMode): ArenaError | { queued: ArenaMode } {
    const ok = this.eligible(id);
    if (isError(ok)) return ok;
    this.queue = this.queue.filter((w) => w.id !== id);
    this.queue.push({ id, mode, since: this.deps.now() });
    this.deps.event(id, { e: 'arenaQueued', mode });
    return { queued: mode };
  }

  leaveQueue(id: string): { ok: true } {
    if (this.queue.some((w) => w.id === id)) {
      this.queue = this.queue.filter((w) => w.id !== id);
      this.deps.event(id, { e: 'arenaQueued', mode: null });
    }
    return { ok: true };
  }

  challenge(id: string, targetId: string, mode: ArenaMode): ArenaError | { challengeId: string } {
    if (id === targetId) return fail('you cannot challenge yourself', 'E_INVALID');
    const ok = this.eligible(id);
    if (isError(ok)) return ok;
    if (this.byOperator.has(targetId)) return fail('that operator is in a match');
    if (!this.deps.locate(targetId)) return fail('that operator is not online');
    for (const c of this.challenges.values()) if (c.from === id) this.challenges.delete(c.id);
    const c: Challenge = { id: this.deps.newId(), from: id, to: targetId, mode, expiresAt: this.deps.now() + ARENA_CHALLENGE_TTL_MS };
    this.challenges.set(c.id, c);
    this.deps.send(targetId, { t: 'arenaChallenge', seq: 0, d: { challengeId: c.id, from: id, name: ok.op.name, mode, expiresAt: new Date(c.expiresAt).toISOString() } });
    return { challengeId: c.id };
  }

  accept(id: string, challengeId: string): ArenaError | { matchId: string } {
    const c = this.challenges.get(challengeId);
    if (!c || c.to !== id) return fail('no such challenge', 'E_INVALID');
    if (c.expiresAt <= this.deps.now()) {
      this.challenges.delete(c.id);
      return fail('that challenge has expired');
    }
    const me = this.eligible(id);
    if (isError(me)) return me;
    if (isError(this.eligible(c.from))) {
      this.challenges.delete(c.id);
      return fail('the challenger is no longer available');
    }
    if (this.matches.size >= ARENA_MAX_MATCHES) return fail('the arena is full; try again shortly');
    this.challenges.delete(c.id);
    return { matchId: this.start(c.from, id, c.mode).id };
  }

  forfeit(id: string): ArenaError | { ok: true } {
    const match = this.byOperator.get(id);
    if (!match || match.world.arena!.phase === 'over') return fail('not in an arena match');
    concede(match.world, id, 'forfeit');
    return { ok: true };
  }

  /** The operator is leaving the server: out of the queue, challenges dropped, and out of its match (which it loses). */
  drop(id: string): void {
    this.queue = this.queue.filter((w) => w.id !== id);
    for (const c of [...this.challenges.values()]) if (c.from === id || c.to === id) this.challenges.delete(c.id);
    const match = this.byOperator.get(id);
    if (!match) return;
    concede(match.world, id, 'disconnect');
    if (!match.reported) this.report(match);
    this.sendHome(match, match.sides.find((s) => s.id === id)!);
  }

  // ---- matches ----

  private pairKey(a: string, b: string): string {
    return `${[a, b].sort().join('|')}:${new Date(this.deps.now()).toISOString().slice(0, 10)}`;
  }

  private start(aId: string, bId: string, wanted: ArenaMode): Match {
    // win-trading guard: past the daily cap a ranked pairing is played as unranked
    const key = this.pairKey(aId, bId);
    const played = this.pairCounts.get(key) ?? 0;
    const mode: ArenaMode = wanted === 'ranked' && played >= ARENA_PAIR_DAILY_CAP ? 'unranked' : wanted;
    if (mode === 'ranked') this.pairCounts.set(key, played + 1);

    const id = this.deps.newId();
    const liveAtTick = msToTicks(ARENA_COUNTDOWN_MS);
    const endsAtTick = liveAtTick + msToTicks(ARENA_MATCH_MS);
    const ratings = { [aId]: this.deps.rating(aId), [bId]: this.deps.rating(bId) };
    const world = new World({ subnet: SANDBOX, seed: id, seedId: id.slice(0, 8), spawner: false });
    world.arena = { id, mode, a: aId, b: bId, phase: 'countdown', liveAtTick, endsAtTick, ratings, dealt: new Set(), result: null };

    this.queue = this.queue.filter((w) => w.id !== aId && w.id !== bId);
    const sides = [aId, bId].map((opId, i): Side => {
      const home = this.deps.locate(opId)!.world;
      for (const form of home.discovered) world.discovered.add(form);
      const record = home.checkpoint(opId);
      this.deps.transfer(opId, world, arenaRecord(record, mode, SANDBOX.id, SANDBOX.arenaSpawns[i as 0 | 1]));
      return { id: opId, home, record, goneTicks: 0, returned: false };
    }) as [Side, Side];
    const match: Match = { id, mode, world, sides, reported: false, returnAtTick: 0 };
    this.matches.set(id, match);
    for (const [me, other] of [
      [aId, bId],
      [bId, aId],
    ] as const) {
      this.byOperator.set(me, match);
      const opp = world.operators.get(other)!;
      this.deps.event(me, { e: 'arenaMatch', id, mode, opponent: { id: other, name: opp.name, tag: opp.org?.tag ?? null, rating: ratings[other]! }, startsAtTick: liveAtTick, endsAtTick });
    }
    return match;
  }

  /** Tells both operators how it ended and schedules the way home. Ratings and rewards arrive with SP6 plan 2. */
  private report(match: Match): void {
    const arena = match.world.arena!;
    const result = arena.result!;
    match.reported = true;
    match.returnAtTick = match.world.tick + msToTicks(ARENA_RETURN_MS);
    for (const side of match.sides) {
      if (side.returned) continue;
      const rating = arena.ratings[side.id]!;
      const outcome = result.winner === null ? 'draw' : result.winner === side.id ? 'win' : 'loss';
      this.deps.event(side.id, { e: 'arenaResult', id: match.id, mode: match.mode, outcome, reason: result.reason, ratingBefore: rating, ratingAfter: rating, reward: 0, counted: false });
    }
  }

  private sendHome(match: Match, side: Side): void {
    if (side.returned) return;
    side.returned = true;
    this.byOperator.delete(side.id);
    // bits, Disk slots, name and org can change during a match (api pushes); everything else is as it was
    const live = match.world.operators.get(side.id);
    const record: OperatorRecord = live ? { ...side.record, bits: live.bits, diskSlots: [...live.diskSlots], name: live.name, org: live.org ? { ...live.org } : null } : side.record;
    this.deps.transfer(side.id, side.home, record);
  }

  /** Once per game tick, after the worlds have stepped. */
  tick(): void {
    this.ticks++;
    const goneLimit = msToTicks(ARENA_DISCONNECT_MS);
    for (const match of [...this.matches.values()]) {
      const arena = match.world.arena!;
      if (arena.phase !== 'over') {
        for (const side of match.sides) {
          side.goneTicks = this.deps.connected(side.id) ? 0 : side.goneTicks + 1;
          if (side.goneTicks >= goneLimit) concede(match.world, side.id, 'disconnect');
        }
      }
      if (arena.phase === 'over' && !match.reported) this.report(match);
      if (match.reported && match.world.tick >= match.returnAtTick) {
        for (const side of match.sides) this.sendHome(match, side);
        this.matches.delete(match.id);
      }
    }
    if (this.ticks % MATCHMAKING_EVERY_TICKS === 0) {
      const now = this.deps.now();
      for (const c of [...this.challenges.values()]) if (c.expiresAt <= now) this.challenges.delete(c.id);
      this.matchmake(now);
    }
  }

  /** Unranked: first come, first served. Ranked: the closest pair whose rating windows overlap, again and again. */
  private matchmake(now: number): void {
    for (const w of [...this.queue]) {
      const ok = this.eligible(w.id);
      if (isError(ok)) {
        this.queue = this.queue.filter((x) => x !== w);
        this.deps.event(w.id, { e: 'arenaQueued', mode: null, reason: ok.message });
      }
    }
    for (;;) {
      if (this.matches.size >= ARENA_MAX_MATCHES) return;
      const casual = this.queue.filter((w) => w.mode === 'unranked');
      if (casual.length >= 2) {
        this.start(casual[0]!.id, casual[1]!.id, 'unranked');
        continue;
      }
      const ranked = this.queue.filter((w) => w.mode === 'ranked').map((w) => ({ w, rating: this.deps.rating(w.id), window: ARENA_QUEUE_WINDOW * (1 + Math.floor((now - w.since) / ARENA_QUEUE_WIDEN_MS)) }));
      let best: { a: string; b: string; gap: number } | null = null;
      for (let i = 0; i < ranked.length; i++) {
        for (let j = i + 1; j < ranked.length; j++) {
          const gap = Math.abs(ranked[i]!.rating - ranked[j]!.rating);
          if (gap <= ranked[i]!.window + ranked[j]!.window && (!best || gap < best.gap)) best = { a: ranked[i]!.w.id, b: ranked[j]!.w.id, gap };
        }
      }
      if (!best) return;
      this.start(best.a, best.b, 'ranked');
    }
  }
}
```

- [ ] **Step 3: Wire it into `Game`**

`apps/sim/src/runtime/game.ts` — imports `ARENA_START_RATING` (rules), `OperatorRecord` (core), `ArenaService, type ArenaError`; a field `readonly arena: ArenaService;`; in the constructor, before the bus subscriptions:

```ts
    this.arena = new ArenaService({
      locate: (id) => {
        const s = this.sessions.get(id);
        const op = s?.world.operators.get(id);
        return s && op && this.worlds.get(s.world.subnet.id) === s.world ? { op, world: s.world } : undefined;
      },
      connected: (id) => !!this.sessions.get(id)?.controller,
      transfer: (id, to, record) => this.transfer(id, to, record),
      event: (id, event) => this.sessions.get(id)?.world.emitCarry(event, { to: id }),
      send: (id, msg) => this.sendTo(id, msg),
      rating: () => ARENA_START_RATING,
      now: () => Date.now(),
      newId: () => randomHex(16),
    });
```

(`locate` only finds operators in a **persistent** world, which is how "already in a match" falls out; plan 2 replaces `rating`.) In `command`, before the chat branch:

```ts
    if (command.cmd.startsWith('arena')) {
      // entering and leaving matches is the runtime's business; only fighting goes through the match world's tick
      const id = session.operatorId;
      let r: ArenaError | object;
      switch (command.cmd) {
        case 'arenaQueue':
          r = this.arena.queueUp(id, command.args.mode);
          break;
        case 'arenaLeave':
          r = this.arena.leaveQueue(id);
          break;
        case 'arenaChallenge':
          r = this.arena.challenge(id, command.args.operatorId, command.args.mode);
          break;
        case 'arenaAccept':
          r = this.arena.accept(id, command.args.challengeId);
          break;
        case 'arenaForfeit':
          r = this.arena.forfeit(id);
          break;
        default:
          r = { code: 'E_INVALID', message: 'unknown arena command' };
      }
      if ('code' in r && 'message' in r) this.error(st, (r as ArenaError).code, (r as ArenaError).message, reqId);
      else this.send(st, { t: 'ack', seq: 0, d: { reqId, result: r } });
      return;
    }
```

In `tick`, after stepping the persistent worlds:

```ts
    for (const world of this.arena.worlds()) this.stepWorld(world, inputsByWorld.get(world) ?? []);
    this.arena.tick();
```

In `leave`, first thing: `this.arena.drop(session.operatorId);` (out of the queue; out of a match — forfeited — and back in the home world, so the normal checkpoint-and-remove that follows sees the real operator). In `checkpointAll`:

```ts
    // an operator in an arena match is checkpointed as it left its home world: the copies never reach the database
    const records = [...this.sessions.values()]
      .filter((s) => s.world.operators.has(s.operatorId))
      .map((s) => this.arena.homeRecord(s.operatorId) ?? s.world.checkpoint(s.operatorId));
```

and the handover itself:

```ts
  /** Arena handover (SP6): the operator leaves the world it is in and enters `to` with `record`; every connection gets a snapshot. */
  private transfer(operatorId: string, to: World, record: OperatorRecord): void {
    const session = this.sessions.get(operatorId);
    if (!session) return;
    session.world.removeOperator(operatorId);
    to.addOperator({ ...record, subnet: to.subnet.id });
    session.world = to;
    // a controller that is away must not resume across worlds
    if (!session.controller) session.savedKnown = null;
    this.clusters.reattach(operatorId);
    for (const st of session.controller ? [session.controller, ...session.spectators] : [...session.spectators]) this.snapshot(st);
  }
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm exec vitest run apps/sim` — expected: green (8 new tests).

```bash
git add apps/sim
git commit -m "feat(sim): ArenaService — queue, challenges, match lifecycle, handover and return"
```

---

### Task 3: SDK

**Files:**
- Modify: `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`

**Interfaces:**
- `client.arena.queue(mode)`, `.leave()`, `.challenge(operatorId, mode?)`, `.accept(challengeId)`, `.forfeit()`, `.match` (`client.self.arena`); `client.on('arenaChallenge', …)`, `client.on('arenaMatch' | 'arenaResult' | 'arenaQueued', …)` (game events are already emitted by name); daemon scripts' `enemies` are the opponent's running daemons during a match.

- [ ] **Step 1: Implementation**

`packages/sdk/src/client.ts` — `ClientEvents` gets

```ts
  /** Arena (SP6): someone challenges you; answer with `client.arena.accept(challengeId)` within 60 s. */
  arenaChallenge: Extract<ServerMessage, { t: 'arenaChallenge' }>['d'];
```

the message switch gets `case 'arenaChallenge': this.emit('arenaChallenge', msg.d); return;`, `GameClient` gets `readonly arena = new ArenaApi(this);`, and

```ts
/** Arena (SP6): instanced PvP. Your RAM daemons fight as copies; nothing is lost. `match` is the current match or null. */
export class ArenaApi {
  constructor(private readonly client: GameClient) {}
  get match(): OperatorSelf['arena'] {
    return this.client.self.arena;
  }
  /** Wait for an opponent. Needs two non-crashed daemons in RAM, nothing running. An `arenaMatch` event announces the match. */
  queue(mode: 'ranked' | 'unranked') {
    return this.client.command({ cmd: 'arenaQueue', actor: 'self', args: { mode } });
  }
  leave() {
    return this.client.command({ cmd: 'arenaLeave', actor: 'self', args: {} });
  }
  challenge(operatorId: string, mode: 'ranked' | 'unranked' = 'unranked') {
    return this.client.command({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId, mode } });
  }
  accept(challengeId: string) {
    return this.client.command({ cmd: 'arenaAccept', actor: 'self', args: { challengeId } });
  }
  forfeit() {
    return this.client.command({ cmd: 'arenaForfeit', actor: 'self', args: {} });
  }
}
```

In `DaemonsApi.script`, the enemy query becomes

```ts
        const enemies = new Query(
          me.arena ? this.client.world.daemons.all().filter((d) => d.owner !== null && d.owner !== me.id) : this.client.world.wild.all().filter((d) => d.taggedBy === null || d.taggedBy === me.id),
          self,
        ).within(ENEMY_RADIUS);
```

so a battle script that loops over `enemies` works unchanged in both worlds. Export `ArenaApi` from `packages/sdk/src/index.ts`.

- [ ] **Step 2: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 52 files, 414 tests. `playwright test` — still 4 passed (no client changes yet).

```bash
git add packages/sdk
git commit -m "feat(sdk): arena API and PvP enemies for daemon scripts"
```

---

## Self-review

- **Spec coverage:** §4 `SANDBOX` (48 × 48, symmetric walls, no regions, spawns 32 apart), `pvp` targeting (opponent's running daemons only, operators cannot be hit), leash / follow unchanged, the command whitelist, ranked normalisation (level 64, moves at 64, bonus zeroed, held items and traits kept), full HP and energy, originals untouched; §5 queue / leave / challenge / accept (60 s) / forfeit, entry requirements, matchmaking every second with widening windows and FIFO unranked, countdown → live → over, wipe-out, timeout by HP fraction with draws, 8 s disconnect, results to both, return after 3 s with the original record and a fresh snapshot, all three events and the `arenaChallenge` message; §3 16 concurrent matches, the pair-per-day rule, "risks nothing"; §7 SDK. The `arenaResult` intent, ratings and rewards are plan 2 (the event already has its final shape, with `counted: false`, `reward: 0` and unchanged ratings for now); the client is plan 3.
- **Type consistency:** `ArenaState.result.reason` ↔ protocol `ArenaReason` ↔ `concede`'s reasons; `ArenaDeps.transfer` ↔ `Game.transfer`; `OperatorSelf['arena']` is produced only by `arenaSelf` and read by `ArenaApi.match`.
- **Placeholders:** none.
