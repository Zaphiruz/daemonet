export const TICK_HZ = 16;
export const TICK_MS = 1000 / TICK_HZ;
export const LEVEL_CAP = 64;
export const MAX_IV = 31;
export const ENERGY_MAX = 128;

/** Codex research thresholds (SP3b design 7.2): captures of a line unlock what its scans reveal about wild daemons. */
export const SCAN_NATURE = 4;
export const SCAN_BUCKETS = 16;
export const SCAN_IVS = 64;
export const SCAN_HINTS = 256;
/** IV bucket labels (0-3) shown for the `ivBuckets` scan: each bucket spans 8 values. */
export const SCAN_BUCKET_WIDTH = 8;
export const SCAN_BUCKET_LABELS: readonly string[] = Object.freeze(['0-7', '8-15', '16-23', '24-31']);
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
