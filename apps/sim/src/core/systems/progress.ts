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
