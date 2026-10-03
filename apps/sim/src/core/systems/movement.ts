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
