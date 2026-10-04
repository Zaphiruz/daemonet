import { ENERGY_MAX, TICK_HZ, getItem, regenEnergy, type StatusId } from '@daemonet/rules';
import { freshEngagement, type Daemon } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export const SP1_SNIFF_REFILL = 8;
/** leaking: energy lost per second. */
export const LEAK_PER_SECOND = 2;
const batteryItem = getItem('battery');
function heldMultiplier(item: ReturnType<typeof getItem>): number {
  if (item.kind !== 'held') throw new RangeError(`${item.id} is not a held item`);
  return item.multiplier;
}
/** battery: energy regen multiplier, read from the item table (regenEnergy's tick count scales linearly). */
const BATTERY_REGEN = heldMultiplier(batteryItem);

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
    d.energy = regenEnergy(d.energy, d.stats.energy, d.heldItem === 'battery' ? BATTERY_REGEN : 1);
    if ((d.statuses.leaking ?? 0) > tick) d.energy = Math.max(0, d.energy - LEAK_PER_SECOND / TICK_HZ);
    for (const [status, until] of Object.entries(d.statuses) as Array<[StatusId, number]>) {
      if (until <= tick) delete d.statuses[status];
    }
    const w = d.wild;
    if (w && w.tagOwner !== null && tick > w.tagUntil && !captured.has(d.id)) {
      w.tagOwner = null;
      w.aggro = null;
      w.damagedBy.clear();
      d.hp = d.stats.hp;
      d.engagement = freshEngagement();
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
    // A daemon with a pending store / evolve is skipped: completion writes the snapshot taken at command time.
    const restored = op.ram.filter((id) => !world.daemons.get(id)!.pending);
    for (const id of restored) restoreDaemon(world.daemons.get(id)!);
    // Temporary SP1-only rule (SP1 spec 3.4): no shop yet, so restoring tops sniff back up to 8.
    op.inventory.sniff = Math.max(op.inventory.sniff ?? 0, SP1_SNIFF_REFILL);
    out.emit({ e: 'restored', daemons: restored }, { to: op.id });
  }
}
