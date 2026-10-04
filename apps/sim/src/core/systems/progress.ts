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

/**
 * Crash owned daemons at 0 HP; defeat wild daemons at 0 HP: XP to the damaging daemons of the tagging party's present
 * members, and a clear for each present member (per-member ticket credit, SP4 plan 2).
 */
export function resolveDefeats(world: World, out: Out): void {
  for (const d of [...world.daemons.values()]) {
    if (!d.active || d.hp > 0) continue;
    out.emit({ e: 'crash', daemon: d.id }, { at: d });
    if (d.wild) {
      if (d.wild.tagOwner) {
        awardXp(world, partyRecipients(world, d.wild.tagOwner, d.wild.damagedBy, d), xpYield(getSpecies(d.species).baseYield, d.level), out);
        // A clear counts for every member of the tagging party who is present (same world, within PARTY_RADIUS).
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
