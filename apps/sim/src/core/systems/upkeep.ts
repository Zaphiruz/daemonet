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
