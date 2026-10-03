import { LO, createRng } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { Grid, MAX_PATH_TILES } from '../src/core/grid.js';
import { TEST_SUBNET } from './helpers.js';

describe('Grid', () => {
  const grid = new Grid(TEST_SUBNET);

  it('blocks the border and walls', () => {
    expect(grid.isWalkableTile(0, 5)).toBe(false);
    expect(grid.isWalkableTile(31, 5)).toBe(false);
    expect(grid.isWalkableTile(16, 10)).toBe(false);
    expect(grid.isWalkableTile(16, 25)).toBe(true);
    expect(grid.isWalkablePoint({ x: 5.5, y: 5.5 })).toBe(true);
  });

  it('paths around the wall and ends exactly at the destination', () => {
    const path = grid.findPath({ x: 10.5, y: 10.5 }, { x: 22.25, y: 10.75 })!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 22.25, y: 10.75 });
    for (const p of path) expect(grid.isWalkablePoint(p)).toBe(true);
    // Must go below the wall (which ends at y = 20).
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThan(20);
  });

  it('returns [] when already there and a single waypoint within the same tile', () => {
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 5.5, y: 5.5 })).toEqual([]);
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 5.9, y: 5.1 })).toEqual([{ x: 5.9, y: 5.1 }]);
  });

  it('returns null for blocked destinations', () => {
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: 16.5, y: 5.5 })).toBeNull();
    expect(grid.findPath({ x: 5.5, y: 5.5 }, { x: -3, y: 5.5 })).toBeNull();
  });

  it('never cuts corners diagonally', () => {
    const path = grid.findPath({ x: 15.5, y: 21.5 }, { x: 17.5, y: 21.5 })!;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const tx = Math.floor(a.x);
      const ty = Math.floor(a.y);
      const nx = Math.floor(b.x);
      const ny = Math.floor(b.y);
      if (tx !== nx && ty !== ny) {
        expect(grid.isWalkableTile(nx, ty) && grid.isWalkableTile(tx, ny)).toBe(true);
      }
    }
  });

  it('finds paths across lo within the tile cap', () => {
    const lo = new Grid(LO);
    const path = lo.findPath(LO.spawn, { x: 100.5, y: 100.5 })!;
    expect(path).not.toBeNull();
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_TILES);
    expect(lo.isWalkablePoint(LO.host)).toBe(true);
  });

  it('randomWalkableIn stays inside the rect', () => {
    const lo = new Grid(LO);
    const rng = createRng(5);
    for (const region of LO.regions) {
      for (let i = 0; i < 50; i++) {
        const p = lo.randomWalkableIn(region.rect, rng)!;
        expect(p.x).toBeGreaterThanOrEqual(region.rect.x);
        expect(p.x).toBeLessThan(region.rect.x + region.rect.w);
        expect(lo.isWalkablePoint(p)).toBe(true);
      }
    }
  });
});
