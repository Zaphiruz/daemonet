import { describe, expect, it } from 'vitest';
import { HOSTED_SUBNET_IDS, SANDBOX, SUBNETS, getSubnet } from '../src/index.js';

describe('sandbox arena', () => {
  it('is a 48 × 48 subnet that is looked up by id but never hosted as a persistent world', () => {
    expect(getSubnet('sandbox')).toBe(SANDBOX);
    expect(SUBNETS).not.toContain(SANDBOX);
    expect(HOSTED_SUBNET_IDS).not.toContain('sandbox');
    expect([SANDBOX.width, SANDBOX.height, SANDBOX.regions.length, SANDBOX.gateways.length]).toEqual([48, 48, 0, 0]);
  });

  it('is mirrored left to right with spawn points 32 tiles apart on open floor', () => {
    const [a, b] = SANDBOX.arenaSpawns;
    expect(b.x - a.x).toBe(32);
    expect(a.y).toBe(b.y);
    expect(a.x + b.x).toBe(SANDBOX.width + 1);
    const key = (r: { x: number; y: number; w: number; h: number }) => `${r.x},${r.y},${r.w},${r.h}`;
    const walls = new Set(SANDBOX.walls.map(key));
    for (const r of SANDBOX.walls) expect(walls.has(key({ ...r, x: SANDBOX.width - r.x - r.w }))).toBe(true);
    const blocked = (p: { x: number; y: number }) => SANDBOX.walls.some((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    expect(blocked(a) || blocked(b)).toBe(false);
  });
});
