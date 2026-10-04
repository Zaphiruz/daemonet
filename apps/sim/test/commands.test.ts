import { SWAP_COOLDOWN_MS, msToTicks } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { DISK_SLOT_TAKEN, toSelf } from '../src/core/index.js';
import { idle, input, makeWorld, operatorRecord, self, step } from './helpers.js';

describe('claimStarter', () => {
  it('requires a starter before most commands, then goes through an intent', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { starterClaimed: false, name: null, ram: [], inventory: {} }));

    const blocked = step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    expect(blocked.replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });

    const notStarter = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'voidlet', operatorName: 'alice' } }));
    expect(notStarter.replies[0]).toMatchObject({ ok: false, code: 'E_INVALID' });

    const r = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'alice' } }));
    expect(r.replies).toEqual([]);
    expect(r.intents).toHaveLength(1);
    const intent = r.intents[0]!;
    expect(intent).toMatchObject({ kind: 'claimStarter', name: 'alice', inventory: { sniff: 8, restore: 2 } });
    if (intent.kind !== 'claimStarter') throw new Error('unreachable');
    expect(intent.daemon).toMatchObject({ species: 'pingling', level: 5, clean: false, signature: 0 });
    expect(intent.daemon.hp).toBeGreaterThan(0);

    const again = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'alice' } }));
    expect(again.replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });

    world.completeIntent(intent.id, { ok: true });
    const after = step(world);
    expect(after.replies[0]).toMatchObject({ ok: true, result: { daemonId: intent.daemon.id } });
    const me = toSelf(world, world.operators.get('alice')!);
    expect(me.starterClaimed).toBe(true);
    expect(me.ram.map((d) => d.species)).toEqual(['pingling']);
  });

  it('is idempotent when the operator reconnected after the DB committed the claim', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { starterClaimed: false, name: null, ram: [], inventory: {} }));
    const r = step(world, input('alice', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'alice' } }));
    const intent = r.intents[0]!;
    if (intent.kind !== 'claimStarter') throw new Error('unreachable');
    world.removeOperator('alice');
    world.addOperator(operatorRecord('alice', { starterClaimed: true, ram: [intent.daemon], inventory: intent.inventory }));
    world.completeIntent(intent.id, { ok: true });
    const after = step(world);
    expect(after.replies[0]).toMatchObject({ ok: true, result: { daemonId: intent.daemon.id } });
    const op = world.operators.get('alice')!;
    expect(op.ram).toEqual([intent.daemon.id]);
    expect(new Set(op.ram).size).toBe(op.ram.length);
  });

  it('reports a failed claim (e.g. name taken) and allows retrying', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('bob', { starterClaimed: false, name: null, ram: [] }));
    const r = step(world, input('bob', { cmd: 'claimStarter', actor: self, args: { species: 'nullpup', operatorName: 'taken' } }));
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'name taken' });
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'name taken' });
    const retry = step(world, input('bob', { cmd: 'claimStarter', actor: self, args: { species: 'nullpup', operatorName: 'bob' } }));
    expect(retry.intents).toHaveLength(1);
  });
});

describe('movement commands', () => {
  it('moves the operator along a path at 4 tiles/s', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 9.5, y: 5.5 } }));
    idle(world, 15);
    const op = world.operators.get('alice')!;
    expect(op.x).toBeCloseTo(9.5, 5);
    expect(op.path).toEqual([]);
  });

  it('rejects unreachable destinations and daemon moves beyond the leash', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 16.5, y: 5.5 } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const r = step(world, input('alice', { cmd: 'moveTo', actor: 'alice-d0', args: { x: 15.5, y: 20.5 } }));
    expect(r.replies[0]).toMatchObject({ ok: false, code: 'E_RANGE' });
  });

  it('running daemons follow their operator', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 12.5, y: 5.5 } }));
    idle(world, 64);
    const d = world.daemons.get('alice-d0')!;
    expect(Math.hypot(d.x - 12.5, d.y - 5.5)).toBeLessThanOrEqual(3);
  });
});

describe('run, recall and swap', () => {
  it('shares one 4096 ms cooldown and allows at most 2 running', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    const run0 = step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(run0.replies[0]).toMatchObject({ ok: true });
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
    idle(world, msToTicks(SWAP_COOLDOWN_MS));
    const sw = step(world, input('alice', { cmd: 'swap', actor: self, args: { outId: 'alice-d0', inId: 'alice-d1' } }));
    expect(sw.replies[0]).toMatchObject({ ok: true });
    expect(sw.events.map((e) => e.event)).toContainEqual({ e: 'swap', out: 'alice-d0', in: 'alice-d1' });
    expect(world.operators.get('alice')!.running).toEqual(['alice-d1']);
  });
});

describe('restoreAll', () => {
  it('channels for 2048 ms at the host, restores RAM and tops sniff up to 8', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5, inventory: { sniff: 1 } }));
    const d = world.daemons.get('alice-d0')!;
    d.hp = 1;
    d.crashed = true;
    const r = step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    expect(r.replies[0]).toMatchObject({ ok: true });
    const results = idle(world, 33);
    const restored = results.flatMap((x) => x.events).find((e) => e.event.e === 'restored');
    expect(restored?.to).toBe('alice');
    expect(d.hp).toBe(d.stats.hp);
    expect(d.crashed).toBe(false);
    expect(world.operators.get('alice')!.inventory.sniff).toBe(8);
  });

  it('is cancelled by moving and rejected away from the host', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5 }));
    step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 5.5, y: 5.5 } }));
    expect(world.operators.get('alice')!.restoreUntil).toBeNull();
    world.operators.get('alice')!.x = 20.5;
    world.operators.get('alice')!.y = 25.5;
    expect(step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });
});

describe('store and load', () => {
  it('store moves a RAM daemon to Disk after commit', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5 }));
    const r = step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } }));
    expect(r.intents[0]).toMatchObject({ kind: 'store', daemonId: 'alice-d1', diskSlot: 0 });
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    world.completeIntent(r.intents[0]!.id, { ok: true });
    expect(step(world).replies[0]).toMatchObject({ ok: true });
    expect(world.operators.get('alice')!.ram).toEqual(['alice-d0']);
    expect([...world.operators.get('alice')!.diskSlots]).toEqual([0]);
  });

  it('a store refused because its Disk slot was just taken keeps the slot marked, so the retry picks the next one', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5 }));
    const r = step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } }));
    expect(r.intents[0]).toMatchObject({ kind: 'store', diskSlot: 0 });
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: DISK_SLOT_TAKEN });
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: DISK_SLOT_TAKEN });
    expect([...world.operators.get('alice')!.diskSlots]).toEqual([0]);
    const retry = step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } }));
    expect(retry.intents[0]).toMatchObject({ kind: 'store', diskSlot: 1 });
  });

  it('load reserves a RAM slot and inserts the daemon the runtime supplies', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5, diskSlots: [0] }));
    const r = step(world, input('alice', { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } }));
    const intent = r.intents[0]!;
    expect(intent).toMatchObject({ kind: 'load', daemonId: 'disk-1', ramSlot: 2 });
    const rec = world.checkpoint('alice').ram[0]!;
    world.completeIntent(intent.id, { ok: true, daemon: { ...rec, id: 'disk-1', slot: 99 } });
    const done = step(world);
    expect(done.replies[0]).toMatchObject({ ok: true });
    expect(world.daemons.get('disk-1')!.slot).toBe(2);
  });

  it('load is idempotent when the operator reconnected after the DB committed it', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 4.5, y: 5.5, diskSlots: [0] }));
    const r = step(world, input('alice', { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } }));
    const intent = r.intents[0]!;
    const loaded = { ...world.checkpoint('alice').ram[0]!, id: 'disk-1', slot: 2 };
    const before = world.checkpoint('alice');
    world.removeOperator('alice');
    world.addOperator({ ...before, ram: [...before.ram, loaded] });
    world.completeIntent(intent.id, { ok: true, daemon: { ...loaded, slot: 99 } });
    const done = step(world);
    expect(done.replies[0]).toMatchObject({ ok: true });
    const op = world.operators.get('alice')!;
    expect(op.ram).toHaveLength(3);
    expect(new Set(op.ram).size).toBe(3);
    expect(world.daemons.get('disk-1')!.slot).toBe(2);
    expect(op.reservedSlots.size).toBe(0);
  });

  it('both require being at the host', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 20.5, y: 25.5 }));
    expect(step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });

  it('refuses operator names the chat filter would block or mask', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('newbie', { starterClaimed: false, name: null, ram: [] }));
    const claim = (operatorName: string) => step(world, input('newbie', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName } }));
    expect(claim('kys').replies[0]).toMatchObject({ code: 'E_INVALID', message: 'that name is not allowed' });
    expect(claim('shit-lord').replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(claim('newbie').intents[0]).toMatchObject({ kind: 'claimStarter', name: 'newbie' });
  });
});
