import type { World } from '../world.js';

export const OPERATOR_SPEED = 4;
export const FOLLOW_TILES = 3;

export function daemonSpeed(speedStat: number): number {
  return 2 + speedStat / 32;
}

/** Stub until Task 4. */
export function moveAll(_world: World): void {}
