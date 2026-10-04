import { deepFreeze } from '../freeze.js';
import { BESTIARY } from './bestiary.js';

/** Incidents (SP4 spec 8): a kernel-daemon boss in `kernelspace` every four hours, twenty minutes to clear it. */
export const INCIDENT_SUBNET = 'kernelspace';
export const INCIDENT_PERIOD_MS = 4 * 3_600_000;
export const INCIDENT_WINDOW_MS = 20 * 60_000;
export const INCIDENT_MAX_OPERATORS = 16;

export const BOSS_LEVEL = 64;
export const BOSS_HP_MULTIPLIER = 8;
/** HP fractions at which the boss shields and calls adds. */
export const BOSS_PHASES: readonly number[] = deepFreeze([0.75, 0.5, 0.25]);
export const ADDS_PER_PHASE = 4;
export const ADD_LEVEL = 40;

export const TELEGRAPH_EVERY_MS = 16_000;
export const TELEGRAPH_DELAY_MS = 2_000;
export const TELEGRAPH_RADIUS = 6;
/** Fraction of max HP a telegraphed blast takes from every running daemon in the circle. */
export const TELEGRAPH_DAMAGE = 0.25;

export const INCIDENT_POOL = 8192;
export const INCIDENT_MIN_SHARE = 0.01;
export const INCIDENT_MIN_REWARD = 64;
export const COPY_LEVEL = 48;
export const COPY_TTL_MS = 4 * 60_000;

/** Start (ms) of the first scheduled Incident at or after `nowMs`: every multiple of four hours UTC. */
export function nextIncidentStart(nowMs: number): number {
  return Math.ceil(nowMs / INCIDENT_PERIOD_MS) * INCIDENT_PERIOD_MS;
}

/** Sequence number of the Incident that starts at `startMs`. */
export function incidentNumber(startMs: number): number {
  return Math.floor(startMs / INCIDENT_PERIOD_MS);
}

/** Capstone species take turns as the kernel daemon (public bestiary fields only: no evolution data). */
export const KERNEL_DAEMONS: readonly string[] = deepFreeze(BESTIARY.filter((r) => r.capstone).map((r) => r.id));

export function bossSpecies(n: number): string {
  return KERNEL_DAEMONS[((n % KERNEL_DAEMONS.length) + KERNEL_DAEMONS.length) % KERNEL_DAEMONS.length]!;
}

/** The base form of a species' line (what the boss calls as adds). */
export function lineBase(speciesId: string): string {
  const row = BESTIARY.find((r) => r.id === speciesId);
  if (!row) throw new RangeError(`unknown species ${speciesId}`);
  return BESTIARY.find((r) => r.line === row.line && r.stage === 0)!.id;
}

export interface IncidentPayout {
  operatorId: string;
  damage: number;
  share: number;
  reward: number;
}

/**
 * Splits the pool by damage share (contributors with damage <= 0 are ignored). Operators under 1% of the total
 * (the total includes them) get nothing; everyone else gets at least 64 bits.
 *
 * Rounding: every reward is `floor(pool * damage / total)`, whole bits, computed from the raw damage rather than
 * the float share. Floors of shares that sum to <= 1 sum to <= pool, so with the default pool the payout never
 * exceeds 8192: the 64-bit minimum cannot bind there because 1% of 8192 is 81. Only a custom pool below 6400 can
 * lift a reward to 64 and then the total may exceed it by at most 64 per contributor. Deterministic: the result
 * is ordered by damage descending, ties by operator id.
 */
export function incidentPayouts(damage: ReadonlyMap<string, number>, pool = INCIDENT_POOL): IncidentPayout[] {
  const entries = [...damage.entries()].filter(([, d]) => Number.isFinite(d) && d > 0);
  const total = entries.reduce((a, [, d]) => a + d, 0);
  if (total <= 0) return [];
  return entries
    .map(([operatorId, d]) => ({ operatorId, damage: d, share: d / total, raw: Math.floor((pool * d) / total) }))
    .filter((p) => p.share >= INCIDENT_MIN_SHARE)
    .map(({ raw, ...p }) => ({ ...p, reward: Math.max(INCIDENT_MIN_REWARD, raw) }))
    .sort((a, b) => b.damage - a.damage || (a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0));
}
