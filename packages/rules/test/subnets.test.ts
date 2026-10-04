import { describe, expect, it } from 'vitest';
import { BESTIARY } from '../src/content/bestiary.js';
import { getSpecies } from '../src/content/species.js';
import { LO, OPEN_SUBNET_IDS, SUBNETS, SUBNET_IDS, getGateway, getSubnet, spawnTable, type Rect } from '../src/content/subnets.js';
import { EVOLUTION_RULES } from '../src/evolution/rules.js';

const inside = (p: { x: number; y: number }, s: { width: number; height: number }) => p.x > 1 && p.y > 1 && p.x < s.width - 1 && p.y < s.height - 1;
const inWall = (p: { x: number; y: number }, walls: readonly Rect[]) => walls.some((w) => p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h);
const rectInside = (r: Rect, w: number, h: number) => r.x >= 1 && r.y >= 1 && r.x + r.w <= w - 1 && r.y + r.h <= h - 1;

/** Subnets later plans add; evolution requirements may already name them. */
const RESERVED_SUBNET_IDS = ['kernelspace'];

describe('subnets', () => {
  it('hosts six open subnets with lo first', () => {
    expect(OPEN_SUBNET_IDS).toEqual(['lo', 'lan', 'dmz', 'backbone', 'darknet', 'cloudnet']);
    expect(SUBNET_IDS).toBe(OPEN_SUBNET_IDS);
    expect(SUBNETS[0]).toBe(LO);
    expect(() => getSubnet('nope')).toThrow(RangeError);
  });

  it('lo is 128 x 128 with four regions of rising level and walls inside the border', () => {
    expect(getSubnet('lo')).toBe(LO);
    expect(LO.width).toBe(128);
    expect(LO.tier).toBe(0);
    expect(LO.regions.map((r) => r.levels)).toEqual([[2, 6], [5, 10], [9, 16], [14, 24]]);
    for (const wall of LO.walls) expect(rectInside(wall, LO.width, LO.height)).toBe(true);
  });

  it('region level bands match the SP3b spec table (4.1) for every subnet', () => {
    const SPEC: Record<string, Array<[number, number]>> = {
      lo: [[2, 6], [5, 10], [9, 16], [14, 24]],
      lan: [[8, 14], [12, 18], [16, 22], [18, 24]],
      dmz: [[16, 22], [20, 26], [24, 30], [28, 34]],
      backbone: [[24, 30], [28, 34], [32, 38], [36, 42]],
      darknet: [[32, 38], [36, 42], [40, 46], [44, 50]],
      cloudnet: [[40, 46], [44, 50], [48, 54], [52, 58]],
    };
    expect(Object.keys(SPEC)).toEqual([...OPEN_SUBNET_IDS]);
    for (const s of SUBNETS) expect(s.regions.map((r) => r.levels), s.id).toEqual(SPEC[s.id]);
    for (const s of SUBNETS) expect(Object.isFrozen(s.regions[3]!.levels), s.id).toBe(true);
  });

  it('every gateway leads to a hosted subnet that has a way back, with points inside the map and off the walls', () => {
    for (const s of SUBNETS) {
      for (const p of [s.host, s.spawn]) {
        expect(inside(p, s)).toBe(true);
        expect(inWall(p, s.walls)).toBe(false);
      }
      for (const g of s.gateways) {
        const to = getSubnet(g.to);
        expect(inside(g.at, s) && !inWall(g.at, s.walls)).toBe(true);
        expect(inside(g.arrive, to) && !inWall(g.arrive, to.walls)).toBe(true);
        expect(to.gateways.some((back) => back.to === s.id)).toBe(true);
        expect(g.requires.level).toBeGreaterThanOrEqual(0);
      }
      const ids = s.gateways.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(getGateway('lo', 'lo-lan')).toMatchObject({ to: 'lan', requires: { level: 8 } });
    expect(getGateway('lo', 'nope')).toBeUndefined();
  });

  it('gates rise along the chain', () => {
    const chain = ['lo', 'lan', 'dmz', 'backbone'];
    for (let i = 0; i + 1 < chain.length; i++) {
      const g = getSubnet(chain[i]!).gateways.find((x) => x.to === chain[i + 1])!;
      expect(g.requires.level).toBe([8, 16, 24][i]);
    }
    expect(getSubnet('backbone').gateways.map((g) => [g.to, g.requires.level])).toEqual([
      ['dmz', 0],
      ['darknet', 32],
      ['cloudnet', 40],
    ]);
  });

  it('regions sit inside the map, have non-empty spawn tables of existing species and rising levels', () => {
    for (const s of SUBNETS) {
      let last = 0;
      for (const r of s.regions) {
        expect(rectInside(r.rect, s.width, s.height)).toBe(true);
        expect(r.cap).toBe(16);
        expect(Object.keys(r.species).length).toBeGreaterThan(0);
        for (const id of Object.keys(r.species)) expect(getSpecies(id).capstone).toBe(false);
        expect(r.levels[0]).toBeGreaterThanOrEqual(last);
        last = r.levels[0];
      }
    }
  });

  it('spawnTable picks non-capstone forms by primary type and stage', () => {
    const t = spawnTable(['packet'], [1, 2]);
    expect(t.echolet).toBe(2);
    expect(t.tracerat).toBe(1);
    expect(t.pingling).toBeUndefined();
    for (const id of Object.keys(t)) {
      const sp = getSpecies(id);
      expect(sp.types[0]).toBe('packet');
      expect([1, 2]).toContain(sp.stage);
    }
    expect(Object.keys(spawnTable(['cloud', 'cache', 'heap', 'stack'], [2, 3])).length).toBeGreaterThan(8);
  });

  it('spawn tables never include capstones, even when their depth is selected', () => {
    const everyType = [...new Set(BESTIARY.flatMap((r) => r.types))];
    const t = spawnTable(everyType, [0, 1, 2, 3, 4]);
    expect(Object.keys(t).length).toBeGreaterThan(0);
    for (const id of Object.keys(t)) expect(BESTIARY.find((r) => r.id === id)!.capstone).toBe(false);
  });

  it('every subnet requirement in the evolution rules names a hosted or reserved subnet', () => {
    const known = new Set<string>([...SUBNET_IDS, ...RESERVED_SUBNET_IDS]);
    let seen = 0;
    for (const rule of Object.values(EVOLUTION_RULES)) {
      for (const req of rule.requirement ?? []) {
        if (req.kind !== 'subnet') continue;
        seen++;
        expect(known.has(req.subnet)).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
    for (const id of SUBNET_IDS) expect(RESERVED_SUBNET_IDS).not.toContain(id);
  });
});
