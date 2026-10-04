import { deepFreeze } from '../freeze.js';
import { GLICKO_START, rate, type Glicko } from '../glicko2.js';
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

// ---- ratings, seasons, rewards (SP6 spec §3, §6) ----

/** Bits for a ranked win, for the first ARENA_DAILY_WINS wins of each UTC day. */
export const ARENA_WIN_BITS = 32;
export const ARENA_DAILY_WINS = 16;
/** Ranked matches in a season needed for the season payout and a ladder place. */
export const ARENA_SEASON_MIN_MATCHES = 8;
export const ARENA_RESET_RD = 200;

/** Season payout by final rating: the band with the highest `min` not above the rating. */
export const ARENA_BANDS: ReadonlyArray<{ readonly min: number; readonly payout: number }> = deepFreeze([
  { min: 0, payout: 1024 },
  { min: 1400, payout: 2048 },
  { min: 1600, payout: 4096 },
  { min: 1800, payout: 8192 },
  { min: 2000, payout: 16384 },
]);

export function arenaBand(rating: number): { readonly min: number; readonly payout: number } {
  let band = ARENA_BANDS[0]!;
  for (const b of ARENA_BANDS) if (rating >= b.min) band = b;
  return band;
}

/** Seasons are UTC calendar months, named `YYYY-MM`. Takes an explicit date: the rules never read a clock. */
export function seasonIdOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function seasonBounds(id: string): { startsAt: Date; endsAt: Date; next: string } {
  const [year, month] = id.split('-').map(Number) as [number, number];
  const startsAt = new Date(Date.UTC(year, month - 1, 1));
  const endsAt = new Date(Date.UTC(year, month, 1));
  return { startsAt, endsAt, next: seasonIdOf(endsAt) };
}

/** What a rating carries into the next season: halfway back to 1500, at least RD 200. */
export function softReset(r: Readonly<Glicko>): Glicko {
  return { rating: ARENA_START_RATING + (r.rating - ARENA_START_RATING) / 2, rd: Math.max(r.rd, ARENA_RESET_RD), vol: r.vol };
}

/**
 * Both ratings after one match; `winner` null = draw. A draw (a concedeBoth, or equal HP at the time limit) is rated as
 * a 0.5 / 0.5 game: against a stronger opponent it still gains.
 */
export function settleMatch(a: Readonly<Glicko>, b: Readonly<Glicko>, winner: 'a' | 'b' | null): { a: Glicko; b: Glicko } {
  const score = winner === null ? 0.5 : winner === 'a' ? 1 : 0;
  return { a: rate(a, b, score), b: rate(b, a, 1 - score) };
}

export function previousSeasonId(id: string): string {
  return seasonIdOf(new Date(seasonBounds(id).startsAt.getTime() - 86_400_000));
}

/** The rating a season starts from: last season's, soft-reset, or the Glicko-2 default (always a fresh copy). */
export function seedRating(previous: Readonly<Glicko> | null | undefined): Glicko {
  return previous ? softReset(previous) : { ...GLICKO_START };
}

/**
 * What one finished match changes. Only ranked matches under the pair-per-day cap count; a counted win pays
 * ARENA_WIN_BITS while the winner is under the daily cap. Everything else leaves ratings alone and pays nothing.
 *
 * Special endings (SP6 spec §6 is silent, decided here): a draw, including a concedeBoth, counts as a 0.5 / 0.5 game
 * and pays nothing; a match that ended while still in its countdown (`live: false`, e.g. a forfeit or disconnect before
 * the fight began) is never counted. `live` defaults to true.
 */
export function settleArena(
  mode: ArenaMode,
  winner: 'a' | 'b' | null,
  ctx: { a: Readonly<Glicko>; b: Readonly<Glicko>; pairCountedToday: number; winnerRewardedToday: number; live?: boolean },
): { counted: boolean; a: Glicko; b: Glicko; reward: number } {
  const counted = mode === 'ranked' && ctx.live !== false && ctx.pairCountedToday < ARENA_PAIR_DAILY_CAP;
  if (!counted) return { counted, a: ctx.a, b: ctx.b, reward: 0 };
  return { counted, ...settleMatch(ctx.a, ctx.b, winner), reward: winner !== null && ctx.winnerRewardedToday < ARENA_DAILY_WINS ? ARENA_WIN_BITS : 0 };
}
