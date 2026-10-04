import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { EVOLUTION_ITEMS, getItem } from '../src/content/items.js';
import { MOVES, STATUS_IDS, TYPE_MOVES, getMove, moveSlot } from '../src/content/moves.js';
import { SPECIES, budgetFor, dominantStat, evolutionsOf, getSpecies, movesAtLevel } from '../src/content/species.js';
import { LO } from '../src/content/subnets.js';
import { ROLE_TRAITS, TRAITS, getTrait } from '../src/content/traits.js';
import { BEATS, IMMUNE, RESISTED_BY, TYPES, singleMultiplier, typeMultiplier } from '../src/types.js';

describe('bestiary data', () => {
  it('has 50 lines, 256 species, 4 starters and 8 capstones', () => {
    expect(BESTIARY).toHaveLength(256);
    expect(new Set(BESTIARY.map((r) => r.line)).size).toBe(50);
    expect(BESTIARY.filter((r) => r.stage === 0)).toHaveLength(50);
    expect(BESTIARY.filter((r) => r.starter).map((r) => r.id).sort()).toEqual(['glitchmite', 'hashling', 'nullpup', 'pingling']);
    expect(BESTIARY.filter((r) => r.capstone)).toHaveLength(8);
    expect(new Set(BESTIARY.map((r) => r.id)).size).toBe(256);
  });

  it('links every evolution to an existing parent at a power-of-2 level with valid requirements', () => {
    const ids = new Set(BESTIARY.map((r) => r.id));
    for (const r of BESTIARY) {
      expect(r.types.length).toBeGreaterThanOrEqual(1);
      expect(r.types.length).toBeLessThanOrEqual(2);
      if (r.stage === 0) {
        expect(r.evolvesFrom).toBeNull();
        expect(r.types).toHaveLength(1);
      } else {
        expect(ids.has(r.evolvesFrom!)).toBe(true);
        expect([8, 16, 32, 64]).toContain(r.evolvesAt);
        expect(r.capstone).toBe(r.evolvesAt === 64);
      }
      for (const q of r.requirement ?? []) {
        if (q.kind === 'heldItem') expect(getItem(q.item).kind).toBe('evolution');
        if (q.kind === 'moveTypeUses') expect(TYPES).toContain(q.type);
        if (q.kind === 'dominantIV') expect(STAT_KEYS).toContain(q.stat);
      }
      if (r.hidden) expect(r.requirement).not.toBeNull();
    }
  });
});

describe('traits and items', () => {
  it('has 16 traits assigned in pairs per role, 4 held items and 16 evolution items', () => {
    expect(TRAITS).toHaveLength(16);
    for (const pair of Object.values(ROLE_TRAITS)) for (const id of pair) expect(() => getTrait(id)).not.toThrow();
    expect(EVOLUTION_ITEMS).toHaveLength(16);
    expect(new Set(EVOLUTION_ITEMS.map((i) => i.type)).size).toBe(16);
    expect(getItem('heatsink')).toMatchObject({ kind: 'held', effect: 'cooldown', multiplier: 0.875 });
  });
});

describe('type chart', () => {
  it('gives every type exactly two strengths, is a strength of exactly two attackers, and two resisters', () => {
    for (const t of TYPES) {
      expect(BEATS[t]).toHaveLength(2);
      expect(TYPES.filter((a) => BEATS[a].includes(t))).toHaveLength(2);
      expect(RESISTED_BY[t]).toHaveLength(2);
      expect(RESISTED_BY[t]).toContain(t);
      for (const d of BEATS[t]) expect(RESISTED_BY[t]).not.toContain(d);
    }
    expect(Object.keys(IMMUNE)).toHaveLength(1);
  });

  it('preserves the SP1 corner', () => {
    expect(singleMultiplier('packet', 'glitch')).toBe(2);
    expect(singleMultiplier('crypto', 'packet')).toBe(2);
    expect(singleMultiplier('glitch', 'crypto')).toBe(2);
    expect(singleMultiplier('glitch', 'null')).toBe(0);
    expect(singleMultiplier('packet', 'crypto')).toBe(0.5);
    expect(singleMultiplier('null', 'glitch')).toBe(1);
    expect(typeMultiplier('packet', ['glitch', 'crypto'])).toBe(1);
  });
});

describe('generated species', () => {
  it('sum exactly to their budget, within 1-256 per stat', () => {
    for (const s of SPECIES) {
      const total = STAT_KEYS.reduce((a, k) => a + s.base[k], 0);
      expect(total, s.id).toBe(budgetFor(BESTIARY.find((r) => r.id === s.id)!));
      for (const k of STAT_KEYS) {
        expect(s.base[k]).toBeGreaterThanOrEqual(1);
        expect(s.base[k]).toBeLessThanOrEqual(256);
      }
    }
    expect(budgetFor(BESTIARY.find((r) => r.id === 'pingling')!)).toBe(285);
    expect(budgetFor(BESTIARY.find((r) => r.id === 'hopmaster')!)).toBe(513);
    expect(budgetFor(BESTIARY.find((r) => r.id === 'pidzero')!)).toBe(600);
  });

  it('keeps the SP1 hand-authored stats and follows role identities', () => {
    expect(getSpecies('pingling').base).toEqual({ hp: 34, attack: 36, defense: 28, focus: 34, resolve: 28, speed: 50, haste: 42, energy: 33 });
    const wall = getSpecies('sysvern').base;
    expect(wall.resolve).toBeGreaterThan(wall.attack);
    const sweeper = getSpecies('hopmaster').base;
    expect(sweeper.speed).toBeGreaterThan(sweeper.defense);
    expect(getSpecies('dataracer').base).not.toEqual(getSpecies('hazardash').base);
    expect(evolutionsOf('forkling')).toHaveLength(4);
    expect(evolutionsOf('pidzero')).toHaveLength(0);
  });

  it('learns its primary type moves and the secondary type area move', () => {
    const multicastor = getSpecies('multicastor'); // packet/buffer
    expect(multicastor.learnset.map((e) => e.move)).toEqual(['ping', 'traceroute', 'wrap', 'synflood']);
    expect(movesAtLevel(getSpecies('pingling'), 20)).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    for (const s of SPECIES) {
      for (const e of s.learnset) expect(() => getMove(e.move)).not.toThrow();
      for (const t of s.traits) expect(() => getTrait(t)).not.toThrow();
      expect(s.baseYield).toBe(32 + 8 * s.stage);
    }
  });

  it('dominantStat returns the strict maximum or null on ties', () => {
    expect(dominantStat({ hp: 1, attack: 9, defense: 2, focus: 3, resolve: 4, speed: 5, haste: 6, energy: 7 })).toBe('attack');
    expect(dominantStat({ hp: 9, attack: 9, defense: 2, focus: 3, resolve: 4, speed: 5, haste: 6, energy: 7 })).toBeNull();
  });
});

describe('moves', () => {
  it('has 64 moves, 4 per type, with one status per type and power-of-2 cooldowns', () => {
    expect(MOVES).toHaveLength(64);
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(64);
    for (const t of TYPES) {
      const own = MOVES.filter((m) => m.type === t);
      expect(own).toHaveLength(4);
      expect(own.filter((m) => m.status)).toHaveLength(1);
      expect(TYPE_MOVES[t].map(moveSlot)).toEqual(['filler', 'ranged', 'area', 'heavy']);
    }
    for (const m of MOVES) {
      expect([256, 512, 1024, 2048, 4096, 8192]).toContain(m.cooldownMs);
      if (m.status) expect(STATUS_IDS).toContain(m.status.id);
    }
    expect(getMove('encrypt').status?.id).toBe('throttled');
    expect(getMove('static').status?.id).toBe('stalled');
    expect(getMove('broadcast').status?.id).toBe('leaking');
    expect(getMove('panic').status?.id).toBe('exposed');
    expect(getMove('bruteforce')).toMatchObject({ power: 100, energyCost: 56, cooldownMs: 8192 });
  });
});

describe('lo spawns every base form', () => {
  it('covers all 50 bases across the four regions, starters in the lobby only', () => {
    const covered = new Set(LO.regions.flatMap((r) => Object.keys(r.species)));
    expect(covered.size).toBe(50);
    expect(Object.keys(LO.regions[0]!.species)).toEqual(expect.arrayContaining(['pingling', 'hashling', 'glitchmite', 'nullpup']));
    expect(LO.regions[3]!.species).not.toHaveProperty('pingling');
  });
});
