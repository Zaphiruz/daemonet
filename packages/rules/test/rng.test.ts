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

  it('known-answer vectors: if this fails, every stored seed (worlds, spawns, challenges) changed meaning', () => {
    const a = createRng('daemonet');
    expect(Array.from({ length: 8 }, () => a.nextU32())).toEqual([
      3973193252, 4213614336, 747281684, 666441711, 2320745594, 2850780174, 3205132184, 2843199836,
    ]);
    const b = createRng(42);
    expect(Array.from({ length: 8 }, () => b.nextU32())).toEqual([
      660444221, 3652823732, 77672526, 910233633, 2297337756, 3786072677, 3123505064, 1891482476,
    ]);
    const c = createRng(7);
    expect(Array.from({ length: 4 }, () => c.float())).toEqual([
      0.04900959390215576, 0.16556235309690237, 0.9298532083630562, 0.952130623627454,
    ]);
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
