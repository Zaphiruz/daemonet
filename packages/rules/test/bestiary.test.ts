import { describe, expect, it } from 'vitest';
import { STAT_KEYS } from '../src/constants.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { EVOLUTION_ITEMS, getItem } from '../src/content/items.js';
import { MOVES, STATUS_IDS, TYPE_MOVES, getMove, moveSlot } from '../src/content/moves.js';
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
