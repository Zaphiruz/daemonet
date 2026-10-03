import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { createRng } from '../src/rng.js';
import { DEFAULT_ODDS, rollSpawn } from '../src/spawn.js';

const sum = (b: Record<string, number>) => Object.values(b).reduce((a, x) => a + x, 0);

describe('rollSpawn', () => {
  it('uses 1/4096 and 1/4 by default', () => {
    expect(DEFAULT_ODDS).toEqual({ clean: 1 / 4096, signatureStep: 1 / 4 });
  });

  it('never produces a natural all-31 image unless clean', () => {
    const rng = createRng('spawn');
    for (let i = 0; i < 20_000; i++) {
      const roll = rollSpawn(rng, { clean: 0, signatureStep: 0.25 });
      expect(roll.clean).toBe(false);
      expect(roll.signature).toBe(0);
      expect(STAT_KEYS.every((k) => roll.ivs[k] === 31)).toBe(false);
      expect(roll.nature).toBeGreaterThanOrEqual(0);
      expect(roll.nature).toBeLessThanOrEqual(15);
    }
  });

  it('clean images have all IVs 31 and one bonus point per signature tier', () => {
    const rng = createRng('clean');
    for (let i = 0; i < 2_000; i++) {
      const roll = rollSpawn(rng, { clean: 1, signatureStep: 0.5 });
      expect(roll.clean).toBe(true);
      expect(STAT_KEYS.every((k) => roll.ivs[k] === 31)).toBe(true);
      expect(sum(roll.bonus)).toBe(roll.signature);
      expect(roll.signature).toBeLessThanOrEqual(15);
    }
  });

  it('caps the signature at 15', () => {
    const roll = rollSpawn(createRng(1), { clean: 1, signatureStep: 1 });
    expect(roll.signature).toBe(15);
  });

  it('matches P(tier >= k | clean) = 4^-k (2^20 rolls, clean injected at 1/4)', () => {
    const rng = createRng('stats');
    const n = 2 ** 20;
    const atLeast = new Array<number>(6).fill(0);
    let clean = 0;
    for (let i = 0; i < n; i++) {
      const roll = rollSpawn(rng, { clean: 1 / 4, signatureStep: 1 / 4 });
      if (!roll.clean) continue;
      clean++;
      for (let k = 0; k <= Math.min(5, roll.signature); k++) atLeast[k]!++;
    }
    const expectWithin = (observed: number, p: number, trials: number) => {
      const sd = Math.sqrt(trials * p * (1 - p));
      expect(Math.abs(observed - trials * p)).toBeLessThan(5 * sd + 1);
    };
    expectWithin(clean, 1 / 4, n);
    for (let k = 1; k <= 5; k++) expectWithin(atLeast[k]!, 4 ** -k, clean);
  });
});
