import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/content/species.js';
import { OPEN_SUBNET_IDS, getSubnet } from '../src/content/subnets.js';
import { BOARD_SIZE, OPEN_TICKETS_MAX, TICKETS_PER_DAY, dayKey, ticketBoard, ticketKey } from '../src/content/tickets.js';
import { TYPES } from '../src/types.js';

const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-11-11'];

describe('ticket boards', () => {
  it('are deterministic per subnet and day, eight tickets each', () => {
    const a = ticketBoard('lo', '2026-09-30');
    const b = ticketBoard('lo', '2026-09-30');
    expect(a).toEqual(b);
    expect(a).toHaveLength(BOARD_SIZE);
    expect(a.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ticketBoard('lo', '2026-10-01')).not.toEqual(a);
    expect(ticketBoard('lan', '2026-09-30')).not.toEqual(a);
    expect(TICKETS_PER_DAY).toBe(8);
    expect(OPEN_TICKETS_MAX).toBe(2);
    expect(dayKey('2026-09-30T13:45:00.000Z')).toBe('2026-09-30');
    expect(ticketKey('2026-09-30', 'lo', 3)).toBe('2026-09-30:lo:3');
  });

  it('lo opens every board with two clear tickets and never asks to evolve', () => {
    for (const day of DAYS) {
      const board = ticketBoard('lo', day);
      expect(board[0]!.kind).toBe('clear');
      expect(board[1]!.kind).toBe('clear');
      expect(board.some((t) => t.kind === 'evolve')).toBe(false);
    }
  });

  it('every ticket is consistent with its subnet and pays 64-512 bits', () => {
    for (const id of OPEN_SUBNET_IDS) {
      const subnet = getSubnet(id);
      const spawnTypes = new Set(subnet.regions.flatMap((r) => Object.keys(r.species).map((s) => getSpecies(s).types[0])));
      for (const day of DAYS) {
        for (const t of ticketBoard(id, day)) {
          expect(t.reward).toBeGreaterThanOrEqual(64);
          expect(t.reward).toBeLessThanOrEqual(512);
          expect(t.title.length).toBeGreaterThan(8);
          expect(t.params.kind).toBe(t.kind);
          switch (t.params.kind) {
            case 'clear':
              expect(spawnTypes.has(t.params.type)).toBe(true);
              expect(TYPES).toContain(t.params.type);
              expect(t.target).toBe(t.params.count);
              expect([2, 4, 8, 16, 32]).toContain(t.params.count);
              break;
            case 'capture':
              expect(t.params.line).toBeGreaterThanOrEqual(1);
              expect(t.params.minLevel).toBeGreaterThanOrEqual(2);
              expect(t.target).toBe(1);
              expect(t.reward).toBeGreaterThanOrEqual(128);
              break;
            case 'deliver':
              expect(subnet.gateways.map((g) => g.to)).toContain(t.params.to);
              expect(t.target).toBe(1);
              // spec 7: deliver pays 128-256
              expect(t.reward).toBeGreaterThanOrEqual(128);
              expect(t.reward).toBeLessThanOrEqual(256);
              break;
            case 'evolve':
              expect(subnet.tier).toBeGreaterThan(0);
              expect(t.reward).toBe(256);
              expect(t.target).toBe(1);
              break;
          }
        }
      }
    }
  });

  it('uses the spec reward formulas', () => {
    const kinds = new Set<string>();
    for (const id of OPEN_SUBNET_IDS) {
      const tier = getSubnet(id).tier;
      for (const day of DAYS) {
        for (const t of ticketBoard(id, day)) {
          kinds.add(t.kind);
          if (t.params.kind === 'clear') {
            const full = [4, 8, 16, 32][Math.min(3, tier)]!;
            const expected = Math.min(512, Math.max(64, 64 * (1 + tier) * (t.params.count === full ? 1 : 0.5)));
            expect(t.reward).toBe(expected);
            expect([full, full / 2]).toContain(t.params.count);
          }
          if (t.params.kind === 'deliver') {
            expect(t.reward).toBe(Math.min(256, 128 + 64 * Math.max(tier, getSubnet(t.params.to).tier)));
          }
        }
      }
    }
    expect([...kinds].sort()).toEqual(['capture', 'clear', 'deliver', 'evolve']);
  });

  it('boards reveal no requirement data', () => {
    const text = JSON.stringify(ticketBoard('darknet', '2026-09-30'));
    expect(text).not.toMatch(/requirement|hidden/);
  });
});
