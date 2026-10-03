/** Deterministic PRNG (xoshiro128**) seeded via FNV-1a + splitmix32. */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextU32(): number;
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. Always consumes exactly one draw. */
  chance(p: number): boolean;
  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle in place; returns the same array. */
  shuffle<T>(items: T[]): T[];
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function createRng(seed: string | number): Rng {
  const sm = splitmix32(typeof seed === 'number' ? seed : fnv1a(seed));
  const s = new Uint32Array([sm(), sm(), sm(), sm()]);
  if ((s[0]! | s[1]! | s[2]! | s[3]!) === 0) s[0] = 1;

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return result;
  };

  const float = (): number => nextU32() / 4294967296;

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`bad int range [${min}, ${max}]`);
    }
    const range = max - min + 1;
    if (range > 4294967296) throw new RangeError('range too large');
    const limit = Math.floor(4294967296 / range) * range;
    for (;;) {
      const r = nextU32();
      if (r < limit) return min + (r % range);
    }
  };

  return {
    nextU32,
    float,
    int,
    chance: (p) => float() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick from empty array');
      return items[int(0, items.length - 1)]!;
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(0, i);
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
      }
      return items;
    },
  };
}
