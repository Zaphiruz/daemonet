import { ARENA_LEVEL, ENERGY_MAX, computeStats, getSpecies, movesAtLevel, statBlock, statBlockFromArray, statBlockToArray, xpForLevel, type ArenaMode } from '@daemonet/rules';
import type { ArenaReason, OperatorSelf } from '@daemonet/shared';
import type { ArenaState, Operator, OperatorRecord, OwnedDaemonRecord } from '../model.js';
import type { World } from '../world.js';

/**
 * Commands a match accepts while live (SP6 spec §4); `chat` and the `arena*` commands never reach the world. `use` is a
 * daemon's move (items are never usable in a match: `useItem` / `restoreAll` / `hold` are refused), and nothing here can
 * raise an intent, so a match world never writes to the store.
 */
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

function finish(world: World, arena: ArenaState, winner: string | null, reason: ArenaReason): void {
  arena.phase = 'over';
  arena.result = { winner, reason, atTick: world.tick };
  for (const op of world.operators.values()) {
    op.path = [];
    for (const id of [...op.running]) world.deactivate(world.daemons.get(id)!);
  }
}

/**
 * The operator gives up (or its controller has been gone too long): the other side wins. No-op once the match is over,
 * and for an operator that is not one of the two sides.
 */
export function concede(world: World, loserId: string, reason: Extract<ArenaReason, 'forfeit' | 'disconnect'>): void {
  const arena = world.arena;
  if (!arena || arena.phase === 'over' || (loserId !== arena.a && loserId !== arena.b)) return;
  finish(world, arena, loserId === arena.a ? arena.b : arena.a, reason);
}

/** Both controllers have been gone too long on the same tick: a draw. No-op once the match is over. */
export function concedeBoth(world: World): void {
  const arena = world.arena;
  if (!arena || arena.phase === 'over') return;
  finish(world, arena, null, 'disconnect');
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
  const otherId = op.id === arena.a ? arena.b : arena.a;
  const other = world.operators.get(otherId);
  return {
    id: arena.id,
    mode: arena.mode,
    phase: arena.phase,
    liveAtTick: arena.liveAtTick,
    endsAtTick: arena.endsAtTick,
    opponent: {
      id: otherId,
      name: other?.name ?? null,
      tag: other?.org?.tag ?? null,
      rating: arena.ratings[otherId] ?? 0,
      team: (other?.ram ?? []).map((id) => {
        const d = world.daemons.get(id)!;
        return { id: d.id, species: d.species, level: d.level, hp: d.hp, maxHp: d.stats.hp, crashed: d.crashed, running: d.active };
      }),
    },
    result: arena.result ? { winner: arena.result.winner, reason: arena.result.reason } : null,
  };
}
