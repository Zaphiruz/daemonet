import { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { entitiesNear, toDaemonEntity, toSelf } from '../src/core/index.js';
import { makeWorld, operatorRecord, placeWild } from './helpers.js';

describe('World basics', () => {
  it('adds operators with their RAM daemons and round-trips a checkpoint', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    expect(world.operators.get('alice')!.ram).toEqual(['alice-d0', 'alice-d1']);
    const cp = world.checkpoint('alice');
    world.removeOperator('alice');
    expect(world.daemons.size).toBe(0);
    world.addOperator(cp);
    expect(world.checkpoint('alice')).toEqual(cp);
  });

  it('moves operators saved on an unwalkable tile to the subnet spawn point', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 16.5, y: 5.5 }));
    const op = world.operators.get('alice')!;
    expect({ x: op.x, y: op.y }).toEqual(world.subnet.spawn);
  });

  it('spawns wild daemons at full HP with generated ids', () => {
    const world = makeWorld();
    const wild = placeWild(world, 'voidlet', 7, 8.5, 8.5);
    expect(wild.id).toBe('seed0001-w1');
    expect(wild.hp).toBe(wild.stats.hp);
    expect(toDaemonEntity(world, wild)).toMatchObject({ kind: 'daemon', species: 'voidlet', owner: null, taggedBy: null, hardened: false });
    world.removeDaemon(wild.id);
    expect(world.daemons.has(wild.id)).toBe(false);
  });

  it('produces a schema-valid self view and nearby entities', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    placeWild(world, 'bitrot', 5, 9.5, 9.5);
    placeWild(world, 'bitrot', 5, 29.5, 29.5);
    const self = toSelf(world, world.operators.get('alice')!);
    expect(OperatorSelf.safeParse(self).success).toBe(true);
    expect(self.ram.map((d) => d.slot)).toEqual([0, 1]);
    const near = entitiesNear(world, 5.5, 5.5, 10);
    expect(near.map((e) => e.kind).sort()).toEqual(['daemon', 'operator']);
  });

  it('advances the tick and rejects unknown intents', () => {
    const world = makeWorld();
    expect(world.step([]).tick).toBe(1);
    expect(world.step([]).tick).toBe(2);
    expect(() => world.completeIntent('nope', { ok: true })).toThrow(RangeError);
  });
});
