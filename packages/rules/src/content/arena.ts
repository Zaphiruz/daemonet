import { deepFreeze } from '../freeze.js';
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

export type ArenaSubnetDef = SubnetDef & { arenaSpawns: readonly [{ x: number; y: number }, { x: number; y: number }] };

/**
 * 48 × 48, mirrored left to right: two pillars, a broken centre line, spawn points 32 tiles apart. Nothing spawns, nothing
 * is sold. Deliberately not in `SUBNETS`: never hosted as a persistent world, no tickets, no gateways; the runtime creates
 * one world on it per match.
 */
export const SANDBOX: ArenaSubnetDef = deepFreeze<ArenaSubnetDef>({
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
});
