import { ARENA_LEVEL, SANDBOX, getSpecies, movesAtLevel, msToTicks } from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, arenaCopy, arenaRecord, concede, concedeBoth, toSelf, type ArenaState } from '../src/core/index.js';
import { idle, input, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);

/** A match world with alice and bob 2 tiles apart, each with two level-20 copies. */
function duel(phase: ArenaState['phase'] = 'live') {
  const world = new World({ subnet: SANDBOX, seed: 'duel', seedId: 'dddd0001', spawner: false });
  world.arena = { id: 'm1', mode: 'unranked', a: 'alice', b: 'bob', phase, liveAtTick: COUNTDOWN, endsAtTick: COUNTDOWN + msToTicks(240_000), ratings: { alice: 1500, bob: 1540 }, dealt: new Set(), result: null };
  world.addOperator(operatorRecord('alice', { subnet: 'sandbox', x: 8.5, y: 24.5 }));
  world.addOperator(operatorRecord('bob', { subnet: 'sandbox', x: 10.5, y: 24.5 }));
  return world;
}
const run = (world: World, who: string, n = 0) => step(world, input(who, { cmd: 'run', actor: self, args: { daemonId: `${who}-d${n}` } }));

describe('arena copies', () => {
  it('rebuilds ranked copies at level 64 without signature bonus; unranked copies only heal; originals stay as they are', () => {
    const original = { ...ownedRecord('pingling', 20, 0), bonus: [3, 3, 3, 3, 3, 3, 3, 3], signature: 3, hp: 5, energy: 10, heldItem: 'amplifier' };
    const before = structuredClone(original);
    const ranked = arenaCopy(original, 'ranked');
    expect(ranked).toMatchObject({ id: original.id, level: ARENA_LEVEL, bonus: [0, 0, 0, 0, 0, 0, 0, 0], energy: 128, crashed: false, heldItem: 'amplifier', ivs: original.ivs });
    expect(ranked.moves).toEqual(movesAtLevel(getSpecies('pingling'), ARENA_LEVEL));
    expect(ranked.hp).toBeGreaterThan(before.hp * 4);
    const casual = arenaCopy(original, 'unranked');
    expect(casual).toMatchObject({ level: 20, bonus: before.bonus, moves: before.moves, energy: 128 });
    expect(casual.hp).toBeGreaterThan(5);
    expect(original).toEqual(before);

    const rec = operatorRecord('alice', { ram: [ownedRecord('pingling', 20, 0, 'a0'), { ...ownedRecord('pingling', 20, 1, 'a1'), crashed: true, hp: 0 }, ownedRecord('glitchmite', 9, 2, 'a2')], tickets: [{ id: 't', day: 'd', subnet: 'lo', index: 0, kind: 'clear', params: { kind: 'clear', type: 'packet', count: 1 }, target: 1, reward: 1, progress: 0, pending: false, completing: false }] });
    const entered = arenaRecord(rec, 'ranked', 'sandbox', { x: 8.5, y: 24.5 });
    expect(entered).toMatchObject({ subnet: 'sandbox', x: 8.5, y: 24.5, tickets: [] });
    expect(entered.ram.map((d) => [d.id, d.level])).toEqual([['a0', 64], ['a2', 64]]);
    expect(rec.ram[0]!.level).toBe(20);
  });
});

describe('arena match rules', () => {
  it('only lets the operator move during the countdown, then goes live', () => {
    const world = duel('countdown');
    expect(run(world, 'alice').replies[0]).toMatchObject({ ok: false, message: 'the match has not started' });
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 24.5 } })).replies[0]).toMatchObject({ ok: true });
    idle(world, COUNTDOWN);
    expect(world.arena!.phase).toBe('live');
    expect(run(world, 'alice').replies[0]).toMatchObject({ ok: true });
  });

  it('targets only the opponent’s running daemons and refuses everything outside the whitelist', () => {
    const world = duel();
    run(world, 'alice');
    run(world, 'bob');
    const move = world.daemons.get('alice-d0')!.moves[0]!;
    const use = (targetId: string) => step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, targetId } })).replies[0];
    expect(use('bob')).toMatchObject({ ok: false, message: 'not a valid target' });
    expect(use('bob-d1')).toMatchObject({ ok: false, message: 'not a valid target' }); // in RAM, not running
    expect(use('alice-d0')).toMatchObject({ ok: false });
    world.daemons.get('alice-d0')!.cooldowns = {};
    const before = world.daemons.get('bob-d0')!.hp;
    world.daemons.get('bob-d0')!.trait = 'echo';
    expect(use('bob-d0')).toMatchObject({ ok: true });
    expect(world.daemons.get('bob-d0')!.hp).toBeLessThan(before);
    expect([...world.arena!.dealt]).toEqual(['alice-d0']);
    const refused: Command[] = [
      { cmd: 'capture', actor: self, args: { targetId: 'bob-d0', tool: 'sniff' } },
      { cmd: 'useItem', actor: self, args: { item: 'restore', daemonId: 'alice-d0' } },
      { cmd: 'restoreAll', actor: self, args: {} },
      { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } },
      { cmd: 'travel', actor: self, args: { gatewayId: 'x' } },
    ];
    for (const command of refused) {
      expect(step(world, input('alice', command)).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'not available in an arena match' });
    }
    // the opponent's team is visible for the HUD, running or not
    expect(toSelf(world, world.operators.get('alice')!).arena).toMatchObject({
      id: 'm1', phase: 'live', opponent: { id: 'bob', name: 'bob', rating: 1540, team: [{ id: 'bob-d0', running: true, crashed: false }, { id: 'bob-d1', running: false }] }, result: null,
    });
  });

  it('ends when one side has no copies left; the loser stays where it stands', () => {
    const world = duel();
    run(world, 'alice');
    run(world, 'bob');
    const bob = world.operators.get('bob')!;
    world.daemons.get('bob-d1')!.crashed = true;
    world.daemons.get('bob-d0')!.hp = 0;
    step(world);
    expect(world.arena).toMatchObject({ phase: 'over', result: { winner: 'alice', reason: 'wipeout' } });
    expect([bob.x, bob.y]).toEqual([10.5, 24.5]);
    expect(world.operators.get('alice')!.running).toEqual([]);
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 24.5 } })).replies[0]).toMatchObject({ ok: false, message: 'the match is over' });
  });

  it('times out to the higher total HP fraction; equal fractions draw', () => {
    const world = duel();
    world.daemons.get('bob-d0')!.hp -= 1;
    world.tick = world.arena!.endsAtTick - 1;
    step(world);
    expect(world.arena!.result).toMatchObject({ winner: 'alice', reason: 'timeout' });

    const even = duel();
    even.tick = even.arena!.endsAtTick - 1;
    step(even);
    expect(even.arena!.result).toMatchObject({ winner: null, reason: 'timeout' });

    const quit = duel('countdown');
    concede(quit, 'alice', 'forfeit');
    expect(quit.arena).toMatchObject({ phase: 'over', result: { winner: 'bob', reason: 'forfeit' } });
    concede(quit, 'bob', 'forfeit'); // already over
    expect(quit.arena!.result!.winner).toBe('bob');
  });

  it('ignores a concession by an operator that is not in the match; both sides gone is a draw', () => {
    const world = duel();
    concede(world, 'mallory', 'forfeit');
    expect(world.arena).toMatchObject({ phase: 'live', result: null });

    concedeBoth(world);
    expect(world.arena).toMatchObject({ phase: 'over', result: { winner: null, reason: 'disconnect' } });
    concede(world, 'alice', 'forfeit'); // already over
    expect(world.arena!.result!.winner).toBeNull();
  });
});
