import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { damage, effectiveCooldownMs, energyRegenPerSecond, regenEnergy } from '../src/combat.js';
import { statBlock } from '../src/constants.js';
import { getMove } from '../src/content/moves.js';
import { createRng } from '../src/rng.js';
import { levelForXp, splitXp, xpForLevel, xpYield } from '../src/xp.js';

describe('damage', () => {
  const input = {
    level: 10,
    attacker: statBlock(40),
    attackerTypes: ['packet'] as const,
    defender: statBlock(40),
    defenderTypes: ['glitch'] as const,
    move: getMove('traceroute'),
  };

  it('applies type, same-type bonus and a bounded random factor', () => {
    // base = floor(((2*10/5 + 2) * 40 * 40) / 40 / 50) + 2 = floor(240 / 50) + 2 = 6
    // 6 * 2 (packet vs glitch) * 1.5 (same type) = 18, times random in [0.875, 1)
    const rng = createRng('dmg');
    for (let i = 0; i < 100; i++) {
      const { amount, multiplier } = damage(input, rng);
      expect(multiplier).toBe(2);
      expect(amount).toBeGreaterThanOrEqual(15);
      expect(amount).toBeLessThanOrEqual(18);
    }
  });

  it('deals 0 through an immunity', () => {
    const r = damage({ ...input, move: getMove('corrupt'), attackerTypes: ['glitch'], defenderTypes: ['null'] }, createRng(1));
    expect(r).toEqual({ amount: 0, multiplier: 0 });
  });

  it('always draws exactly one random number', () => {
    const a = createRng(9);
    const b = createRng(9);
    damage({ ...input, defenderTypes: ['null'], move: getMove('corrupt') }, a);
    b.float();
    expect(a.nextU32()).toBe(b.nextU32());
  });

  it('is at least 1 whenever the multiplier is positive', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 400 }), fc.integer(), (level, atk, def, seed) => {
        const r = damage({ ...input, level, attacker: statBlock(atk), defender: statBlock(def) }, createRng(seed));
        expect(r.amount).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

describe('cooldowns and energy', () => {
  it('haste shortens cooldowns and throttled lengthens them', () => {
    expect(effectiveCooldownMs(1024, 0, false)).toBe(1024);
    expect(effectiveCooldownMs(1024, 256, false)).toBe(512);
    expect(effectiveCooldownMs(1024, 0, true)).toBe(1536);
  });

  it('regenerates per tick and caps at 128', () => {
    expect(energyRegenPerSecond(64)).toBe(2);
    expect(regenEnergy(0, 64, 16)).toBeCloseTo(2);
    expect(regenEnergy(127.9, 256, 16)).toBe(128);
  });
});

describe('xp', () => {
  it('uses 8 * n^3', () => {
    expect(xpForLevel(1)).toBe(8);
    expect(xpForLevel(64)).toBe(2_097_152);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(xpForLevel(10))).toBe(10);
    expect(levelForXp(xpForLevel(10) - 1)).toBe(9);
    expect(levelForXp(1e12)).toBe(64);
  });

  it('yields and splits XP', () => {
    expect(xpYield(32, 16)).toBe(64);
    expect(splitXp(7, 2)).toEqual([4, 3]);
    expect(splitXp(7, 0)).toEqual([]);
  });
});
