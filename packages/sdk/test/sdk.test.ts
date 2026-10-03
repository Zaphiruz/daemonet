import { describe, expect, it } from 'vitest';
import { Query } from '../src/views.js';

describe('Query', () => {
  const items = [
    { id: 'a', x: 0, y: 0, hp: 10 },
    { id: 'b', x: 3, y: 4, hp: 2 },
    { id: 'c', x: 10, y: 0, hp: 5 },
  ];
  const q = new Query(items, { x: 1, y: 0 });

  it('finds nearest, lowest HP, and filters by radius', () => {
    expect(q.nearest()!.id).toBe('a');
    expect(q.nearest((i) => i.id !== 'a')!.id).toBe('b');
    expect(q.lowestHp()!.id).toBe('b');
    expect(q.within(5).all().map((i) => i.id)).toEqual(['a', 'b']);
    expect(q.filter((i) => i.hp > 100).nearest()).toBeUndefined();
    expect(q.length).toBe(3);
  });
});
