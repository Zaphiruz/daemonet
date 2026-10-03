import { describe, expect, it } from 'vitest';
import { idle, input, makeWorld, operatorRecord, placeWild, self, step } from './helpers.js';

function arena() {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice'));
  step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
  return world;
}

describe('player moves', () => {
  it('hits, tags the wild daemon and starts a battle', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const kinds = r.events.map((e) => e.event.e);
    expect(kinds).toContain('battleStart');
    expect(kinds).toContain('hit');
    expect(wild.hp).toBeLessThan(wild.stats.hp);
    expect(wild.wild!.tagOwner).toBe('alice');
  });

  it('rejects out-of-range, cooling-down and unaffordable moves', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 14.5, 5.5);
    const use = (move: string) => input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, targetId: wild.id } });
    expect(step(world, use('ping')).replies[0]).toMatchObject({ code: 'E_RANGE' });
    wild.x = 7.5;
    expect(step(world, use('ping')).replies[0]).toMatchObject({ ok: true });
    expect(step(world, use('ping')).replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
    world.daemons.get('alice-d0')!.energy = 0;
    expect(step(world, use('traceroute')).replies[0]).toMatchObject({ code: 'E_ENERGY' });
  });

  it('rejects moves the daemon does not know and targets tagged by someone else', () => {
    const world = arena();
    world.addOperator(operatorRecord('bob'));
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    wild.wild!.tagOwner = 'bob';
    wild.wild!.tagUntil = 10_000;
    expect(step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'hash', targetId: wild.id } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } })).replies[0]).toMatchObject({ code: 'E_STATE' });
  });

  it('area moves hit every eligible wild daemon in the circle', () => {
    const world = arena();
    const a = placeWild(world, 'bitrot', 5, 8.5, 5.5);
    const b = placeWild(world, 'voidlet', 5, 9.5, 6.5);
    const far = placeWild(world, 'voidlet', 5, 12.5, 12.5);
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'broadcast', x: 9, y: 6 } }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const hits = r.events.filter((e) => e.event.e === 'hit').map((e) => (e.event as { target: string }).target);
    expect(hits.sort()).toEqual([a.id, b.id].sort());
    expect(far.hp).toBe(far.stats.hp);
  });
});

describe('wild daemons fight back and defeats resolve', () => {
  it('a tagged wild daemon retaliates against the running daemon', () => {
    const world = arena();
    const wild = placeWild(world, 'floodhound', 10, 7.5, 5.5);
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    const results = idle(world, 32);
    const hitsOnMe = results.flatMap((r) => r.events).filter((e) => e.event.e === 'hit' && (e.event as { source: string }).source === wild.id);
    expect(hitsOnMe.length).toBeGreaterThan(0);
  });

  it('defeating a wild daemon awards XP to the daemons that damaged it', () => {
    const world = arena();
    const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
    const mine = world.daemons.get('alice-d0')!;
    const xpBefore = mine.xp;
    wild.hp = 1;
    const r = step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'crash', daemon: wild.id });
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(mine.xp).toBeGreaterThan(xpBefore);
  });

  it('an owned daemon at 0 HP crashes; all crashed teleports the operator home', () => {
    const world = arena();
    const op = world.operators.get('alice')!;
    op.x = 20.5;
    op.y = 25.5;
    world.daemons.get('alice-d1')!.crashed = true; // not running, already crashed
    world.daemons.get('alice-d0')!.hp = 0; // running: crashes this tick
    const r = step(world);
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'crash', daemon: 'alice-d0' });
    expect(world.daemons.get('alice-d0')!.crashed).toBe(true);
    expect(op.running).toEqual([]);
    expect({ x: op.x, y: op.y }).toEqual(world.subnet.spawn);
  });

  it('a wild tag expires 8192 ms after the last hit and the daemon heals', () => {
    const world = arena();
    const wild = placeWild(world, 'voidlet', 5, 7.5, 5.5);
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    world.operators.get('alice')!.swapReadyTick = 0;
    expect(step(world, input('alice', { cmd: 'recall', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: true });
    idle(world, 140);
    expect(wild.wild!.tagOwner).toBeNull();
    expect(wild.hp).toBe(wild.stats.hp);
  });
});
