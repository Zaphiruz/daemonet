import { TICK_HZ } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import type { Daemon } from '../model.js';
import type { World } from '../world.js';
import { LEASH_TILES } from './commands.js';

export const OPERATOR_SPEED = 4;
export const FOLLOW_TILES = 3;
/** voidstep: +50% speed with no hostile within this many tiles. */
export const VOIDSTEP_RADIUS = 8;
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

/** Any active daemon of the other side (or an operator, for wild daemons) within `radius`. */
export function hostileNear(world: World, d: Daemon, radius: number): boolean {
  for (const other of world.daemons.values()) {
    if (!other.active || other.hp <= 0 || other === d) continue;
    // in a match the opponent's daemons are the other side
    if (world.arena ? other.ownerId === d.ownerId : (other.ownerId === null) === (d.ownerId === null)) continue;
    if (distance(d, other) <= radius) return true;
  }
  if (d.ownerId === null) for (const op of world.operators.values()) if (distance(d, op) <= radius) return true;
  return false;
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
    const boost = d.trait === 'voidstep' && !hostileNear(world, d, VOIDSTEP_RADIUS) ? 1.5 : 1;
    advance(d, daemonSpeed(d.stats.speed) * boost);
  }
}
