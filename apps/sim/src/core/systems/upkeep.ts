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
