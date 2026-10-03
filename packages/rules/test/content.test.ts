import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { ITEMS, STARTING_INVENTORY, getItem, getTool, isToolId } from '../src/content/items.js';
import { MOVES, getMove } from '../src/content/moves.js';
import { SPECIES, getSpecies, movesAtLevel } from '../src/content/species.js';
import { TRAITS, getTrait } from '../src/content/traits.js';

const COOLDOWNS = [256, 512, 1024, 2048, 4096, 8192];

describe('moves', () => {
  it('has 16 moves, 4 per SP1 type, with power-of-2 cooldowns', () => {
    expect(MOVES).toHaveLength(16);
    for (const type of ['packet', 'crypto', 'glitch', 'null'] as const) {
      expect(MOVES.filter((m) => m.type === type)).toHaveLength(4);
    }
    for (const m of MOVES) {
      expect(COOLDOWNS).toContain(m.cooldownMs);
      expect(m.energyCost).toBeGreaterThan(0);
      expect(m.energyCost).toBeLessThanOrEqual(128);
    }
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(16);
  });

  it('has exactly one throttled (crypto) and one stalled (glitch) move', () => {
    expect(MOVES.filter((m) => m.status?.id === 'throttled').map((m) => m.type)).toEqual(['crypto']);
    expect(MOVES.filter((m) => m.status?.id === 'stalled').map((m) => m.type)).toEqual(['glitch']);
  });

  it('getMove throws on unknown ids', () => {
    expect(getMove('ping').name).toBe('Ping');
    expect(() => getMove('nope')).toThrow(RangeError);
  });
});

describe('species', () => {
  it('has the 8 SP1 base forms, 4 of them starters', () => {
    expect(SPECIES).toHaveLength(8);
    expect(SPECIES.filter((s) => s.starter).map((s) => s.id).sort()).toEqual(['glitchmite', 'hashling', 'nullpup', 'pingling']);
  });

  it('keeps base-stat totals on budget (starters 285, others 300)', () => {
    for (const s of SPECIES) {
      const total = STAT_KEYS.reduce((sum, k) => sum + s.base[k], 0);
      expect(total).toBe(s.starter ? 285 : 300);
      for (const k of STAT_KEYS) {
        expect(s.base[k]).toBeGreaterThanOrEqual(1);
        expect(s.base[k]).toBeLessThanOrEqual(256);
      }
    }
  });

  it('references only known moves and traits', () => {
    for (const s of SPECIES) {
      for (const e of s.learnset) expect(() => getMove(e.move)).not.toThrow();
      for (const t of s.traits) expect(() => getTrait(t)).not.toThrow();
    }
    expect(TRAITS).toHaveLength(16);
  });

  it('movesAtLevel returns the latest 4 learned moves', () => {
    const pingling = getSpecies('pingling');
    expect(movesAtLevel(pingling, 1)).toEqual(['ping', 'traceroute']);
    expect(movesAtLevel(pingling, 8)).toEqual(['ping', 'traceroute', 'broadcast']);
    expect(movesAtLevel(pingling, 20)).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    expect(() => getSpecies('missingno')).toThrow(RangeError);
  });
});

describe('items', () => {
  it('has four tools and restore', () => {
    expect(ITEMS.map((i) => i.id)).toEqual(['sniff', 'tap', 'mirror', 'dump', 'restore']);
    expect(isToolId('dump')).toBe(true);
    expect(isToolId('restore')).toBe(false);
    expect(isToolId('bogus')).toBe(false);
    expect(getTool('dump').sizeMultiplier).toBe(0.5);
    expect(() => getItem('bogus')).toThrow(RangeError);
    expect(STARTING_INVENTORY).toEqual({ sniff: 8, restore: 2 });
  });
});
