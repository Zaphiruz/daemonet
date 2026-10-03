import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STAT_KEYS, msToTicks, statBlock, statBlockFromArray, statBlockToArray } from '../src/constants.js';
import { NATURES, getNature, natureModifier } from '../src/natures.js';
import { computeStats } from '../src/stats.js';
import { TYPES, isTypeId, typeMultiplier } from '../src/types.js';

describe('constants', () => {
  it('msToTicks rounds up at 16 Hz', () => {
    expect(msToTicks(62.5)).toBe(1);
    expect(msToTicks(100)).toBe(2);
    expect(msToTicks(4096)).toBe(66);
  });

  it('stat blocks round-trip through arrays in STAT_KEYS order', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(statBlockToArray(statBlockFromArray(arr))).toEqual(arr);
    expect(statBlockFromArray(arr).haste).toBe(7);
    expect(() => statBlockFromArray([1, 2])).toThrow(RangeError);
  });
});

describe('types', () => {
  it('has 16 types', () => {
    expect(TYPES).toHaveLength(16);
    expect(isTypeId('glitch')).toBe(true);
    expect(isTypeId('fire')).toBe(false);
  });

  it('applies the SP1 chart and defaults to x1', () => {
    expect(typeMultiplier('packet', ['glitch'])).toBe(2);
    expect(typeMultiplier('crypto', ['packet'])).toBe(2);
    expect(typeMultiplier('glitch', ['crypto'])).toBe(2);
    expect(typeMultiplier('glitch', ['null'])).toBe(0);
    expect(typeMultiplier('null', ['glitch'])).toBe(1);
    expect(typeMultiplier('kernel', ['heap'])).toBe(1);
  });

  it('multiplies across dual types', () => {
    expect(typeMultiplier('packet', ['glitch', 'crypto'])).toBe(1);
    expect(typeMultiplier('glitch', ['crypto', 'null'])).toBe(0);
  });
});

describe('natures', () => {
  it('has 16 natures, never touching HP', () => {
    expect(NATURES).toHaveLength(16);
    for (const n of NATURES) {
      expect(n.up).not.toBe('hp');
      expect(n.down).not.toBe('hp');
    }
    expect(() => getNature(16)).toThrow(RangeError);
  });

  it('modifies +10% / -10%', () => {
    const aggressive = getNature(4);
    expect(natureModifier(aggressive, 'attack')).toBe(1.1);
    expect(natureModifier(aggressive, 'defense')).toBe(0.9);
    expect(natureModifier(aggressive, 'speed')).toBe(1);
  });
});

describe('computeStats', () => {
  const base = statBlock(64);

  it('matches the formula at the level cap', () => {
    const stats = computeStats({ base, ivs: statBlock(31), bonus: statBlock(0), level: 64, nature: 0 });
    expect(stats.attack).toBe(164);
    expect(stats.hp).toBe(233);
  });

  it('matches the formula at level 1', () => {
    const stats = computeStats({ base: statBlock(37), ivs: statBlock(0), bonus: statBlock(0), level: 1, nature: 0 });
    expect(stats.attack).toBe(6);
    expect(stats.hp).toBe(12);
  });

  it('applies nature and bonus points', () => {
    const stats = computeStats({ base, ivs: statBlock(31), bonus: { ...statBlock(0), attack: 1 }, level: 64, nature: 4 });
    expect(stats.attack).toBe(Math.floor(165 * 1.1));
    expect(stats.defense).toBe(Math.floor(164 * 0.9));
  });

  it('is monotonic in level and IV', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 63 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 256 }), (level, iv, b) => {
        const input = { base: statBlock(b), ivs: statBlock(iv), bonus: statBlock(0), level, nature: 0 };
        const now = computeStats(input);
        const higherLevel = computeStats({ ...input, level: level + 1 });
        const higherIv = computeStats({ ...input, ivs: statBlock(iv + 1) });
        for (const k of STAT_KEYS) {
          expect(higherLevel[k]).toBeGreaterThanOrEqual(now[k]);
          expect(higherIv[k]).toBeGreaterThanOrEqual(now[k]);
        }
      }),
    );
  });
});
