import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/content/species.js';
import { LO, SUBNETS, getSubnet } from '../src/content/subnets.js';

const inside = (r: { x: number; y: number; w: number; h: number }, w: number, h: number) =>
  r.x >= 1 && r.y >= 1 && r.x + r.w <= w - 1 && r.y + r.h <= h - 1;

describe('subnets', () => {
  it('lo is 128 x 128 with four regions of rising level', () => {
    expect(getSubnet('lo')).toBe(LO);
    expect(LO.width).toBe(128);
    expect(LO.regions.map((r) => r.levels)).toEqual([[2, 6], [5, 10], [9, 16], [14, 24]]);
    expect(() => getSubnet('dmz')).toThrow(RangeError);
  });

  it('keeps walls and regions inside the border and references real species', () => {
    for (const wall of LO.walls) expect(inside(wall, LO.width, LO.height)).toBe(true);
    for (const region of LO.regions) {
      expect(inside(region.rect, LO.width, LO.height)).toBe(true);
      expect(region.cap).toBe(16);
      for (const id of Object.keys(region.species)) expect(() => getSpecies(id)).not.toThrow();
    }
  });

  it('is deep-frozen', () => {
    expect(Object.isFrozen(LO)).toBe(true);
    expect(Object.isFrozen(LO.regions[0]!.species)).toBe(true);
    expect(Object.isFrozen(SUBNETS)).toBe(true);
  });
});
