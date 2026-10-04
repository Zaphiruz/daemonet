import { SUBNETS, createRng, getSubnet } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { Grid } from '../src/core/index.js';

/** Every hosted subnet is playable: host, spawn, gateways and regions are walkable and reachable from the host. */
describe('subnet layouts', () => {
  for (const s of SUBNETS) {
    it(`${s.id}: host, spawn, gateways and regions are walkable and connected`, () => {
      const grid = new Grid(s);
      expect(grid.isWalkablePoint(s.host)).toBe(true);
      expect(grid.isWalkablePoint(s.spawn)).toBe(true);
      expect(grid.findPath(s.host, s.spawn)).not.toBeNull();
      for (const g of s.gateways) {
        expect(grid.isWalkablePoint(g.at)).toBe(true);
        expect(grid.findPath(s.host, g.at)).not.toBeNull();
        // The far side: the arrival point is walkable and connected to that subnet's host.
        const dest = getSubnet(g.to);
        const destGrid = new Grid(dest);
        expect(destGrid.isWalkablePoint(g.arrive)).toBe(true);
        expect(destGrid.findPath(dest.host, g.arrive)).not.toBeNull();
      }
      const rng = createRng(`layout:${s.id}`);
      for (const r of s.regions) {
        const p = grid.randomWalkableIn(r.rect, rng);
        expect(p).not.toBeNull();
        expect(grid.findPath(s.host, p!)).not.toBeNull();
      }
    });
  }
});
