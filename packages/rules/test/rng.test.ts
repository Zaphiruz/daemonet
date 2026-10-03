import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('daemonet');
    const b = createRng('daemonet');
    const seqA = Array.from({ length: 16 }, () => a.nextU32());
    const seqB = Array.from({ length: 16 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('differs for different seeds', () => {
    const a = createRng('daemonet');
    const b = createRng('daemonet2');
    expect(a.nextU32()).not.toEqual(b.nextU32());
  });

  it('accepts numeric seeds, including 0', () => {
    const r = createRng(0);
    const values = new Set(Array.from({ length: 8 }, () => r.nextU32()));
    expect(values.size).toBe(8);
  });

  it('float is in [0, 1)', () => {
    const r = createRng(1);
    for (let i = 0; i < 10_000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('int is inclusive and roughly uniform', () => {
    const r = createRng(2);
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 80_000; i++) counts[r.int(0, 7)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it('int rejects bad ranges', () => {
    const r = createRng(3);
    expect(() => r.int(5, 4)).toThrow(RangeError);
    expect(() => r.int(0.5, 4)).toThrow(RangeError);
  });

  it('pick throws on empty and shuffle permutes', () => {
    const r = createRng(4);
    expect(() => r.pick([])).toThrow(RangeError);
    const arr = Array.from({ length: 32 }, (_, i) => i);
    const shuffled = r.shuffle([...arr]);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(arr);
    expect(shuffled).not.toEqual(arr);
  });
});
