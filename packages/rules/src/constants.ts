export const TICK_HZ = 16;
export const TICK_MS = 1000 / TICK_HZ;
export const LEVEL_CAP = 64;
export const MAX_IV = 31;
export const ENERGY_MAX = 128;
export const RAM_SLOTS = 8;
export const RUNNING_MAX = 2;
export const DISK_SLOTS = 256;
export const MAX_MOVES = 4;
export const SIGNATURE_MAX = 15;
export const SWAP_COOLDOWN_MS = 4096;
export const TAG_WINDOW_MS = 8192;
export const HARDENED_MS = 8192;

export const STAT_KEYS = [
  'hp',
  'attack',
  'defense',
  'focus',
  'resolve',
  'speed',
  'haste',
  'energy',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatBlock = Record<StatKey, number>;

/** Milliseconds to whole ticks, rounding up (a 100 ms cooldown lasts 2 ticks). */
export function msToTicks(ms: number): number {
  return Math.ceil(ms / TICK_MS);
}

export function statBlock(fill: number): StatBlock {
  return { hp: fill, attack: fill, defense: fill, focus: fill, resolve: fill, speed: fill, haste: fill, energy: fill };
}

/** The DB stores IVs/bonus as int[8] in STAT_KEYS order. */
export function statBlockFromArray(values: readonly number[]): StatBlock {
  if (values.length !== STAT_KEYS.length) throw new RangeError('expected 8 values');
  const out = statBlock(0);
  STAT_KEYS.forEach((k, i) => (out[k] = values[i]!));
  return out;
}

export function statBlockToArray(block: StatBlock): number[] {
  return STAT_KEYS.map((k) => block[k]);
}
