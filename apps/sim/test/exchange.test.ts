import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { DISK_SLOT_TAKEN, World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore, type LiveOperatorState } from '../src/runtime/store.js';
import { TEST_SUBNET, TEST_SUBNET_B, ownedRecord } from './helpers.js';

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

function setup() {
  const bus = new MemoryBus();
  const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
  const game = new Game({ worlds: [world], store: new MemoryStore(), verify: createDevVerifier('daemonet-users'), bus });
  const join = async (name: string) => {
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
    return conn;
  };
  return { bus, game, join };
}

describe('Exchange notifications', () => {
  it('forwards bus `exchange` messages to the listed operators that are online, as an event', async () => {
    const { bus, game, join } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    await bus.publish('exchange', { kind: 'fill', operators: [aliceId, 'someone-offline', aliceId], detail: { item: 'frag:packet', price: 20, qty: 3 } });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 3 } }]);
    expect(bob.of('delta').at(-1)!.d.events).toEqual([]);
    await bus.publish('exchange', { nonsense: true });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([]);
    await game.shutdown();
  });

  it('gives each side its own view of a fill: no operator ids, the fee only to the seller, and no bits change', async () => {
    const { bus, game, join } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    await bus.publish('exchange', {
      kind: 'fill',
      operators: [aliceId, bobId],
      detail: { item: 'frag:packet', price: 20, qty: 3, buyerId: aliceId, sellerId: bobId, fee: 3 },
    });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 3, side: 'buy' } }]);
    expect(bob.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 3, side: 'sell', fee: 3 } }]);
    expect(JSON.stringify(alice.of('delta').at(-1)!.d.events)).not.toContain(bobId);
    expect(JSON.stringify(bob.of('delta').at(-1)!.d.events)).not.toContain(aliceId);
    expect(alice.of('delta').at(-1)!.d.events.some((e) => e.e === 'bits')).toBe(false);
    await game.shutdown();
  });

  it('reaches an operator in a world other than the default one', async () => {
    const bus = new MemoryBus();
    const store = new MemoryStore();
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false });
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
    // bob's record is in the second world
    await store.loadOrCreateOperator('dev-bob', TEST_SUBNET_B.id, TEST_SUBNET_B.spawn);
    const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus });
    const bob = new FakeConn();
    game.connect(bob);
    await game.message(bob, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:bob' } }));
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    expect(b.operators.has(bobId)).toBe(true);
    expect(a.operators.has(bobId)).toBe(false);
    await bus.publish('exchange', { kind: 'fill', operators: [bobId], detail: { item: 'frag:packet', price: 20, qty: 1, buyerId: 'someone', sellerId: bobId, fee: 1 } });
    game.tick();
    expect(bob.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 1, side: 'sell', fee: 1 } }]);
    await game.shutdown();
  });

  it('a message naming the same operator as buyer and seller is delivered once, as the buy side, without the fee', async () => {
    // the engine never matches an operator's own orders, so this is defensive: one event, no duplicate, no fee
    const { bus, game, join } = setup();
    const alice = await join('alice');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    await bus.publish('exchange', { kind: 'fill', operators: [aliceId, aliceId], detail: { item: 'frag:packet', price: 20, qty: 3, buyerId: aliceId, sellerId: aliceId, fee: 3 } });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 3, side: 'buy' } }]);
    await game.shutdown();
  });

  it('ignores unknown kinds and malformed messages without delivering them', async () => {
    const { bus, game, join } = setup();
    const alice = await join('alice');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    for (const bad of [
      null,
      'fill',
      { kind: 7, operators: [aliceId] },
      { kind: 'fill', operators: 'x' },
      { kind: 'fill', operators: [aliceId], detail: 'nope' },
      { kind: 'fill', operators: [aliceId], detail: { blob: 'x'.repeat(10_000) } },
      { kind: 'fill', operators: Array.from({ length: 100 }, () => aliceId) },
    ]) {
      await bus.publish('exchange', bad);
      game.tick();
      expect(alice.of('delta').at(-1)!.d.events).toEqual([]);
    }
    await game.shutdown();
  });

  it('tracks Disk slots that changed hands through the Exchange (admin `disk` messages)', async () => {
    const bus = new MemoryBus();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store: new MemoryStore(), verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:carol' } }));
    const id = conn.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 0 });
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 1 });
    expect([...op.diskSlots]).toEqual([0, 1]); // the next capture or store goes to slot 2
    await bus.publish('admin', { kind: 'disk', operatorId: id, remove: 0 });
    await bus.publish('admin', { kind: 'disk', operatorId: 'someone-offline', add: 5 });
    expect([...op.diskSlots]).toEqual([1]);
    await game.shutdown();
  });

  it('ignores malformed `disk` messages and its own echoes', async () => {
    const { bus, game, join } = setup();
    const carol = await join('carol');
    const id = carol.of('authOk')[0]!.d.operatorId;
    const op = game.worldOf(id)!.operators.get(id)!;
    for (const bad of [
      { kind: 'disk', operatorId: id },
      { kind: 'disk', operatorId: id, add: -1 },
      { kind: 'disk', operatorId: id, add: 1.5 },
      { kind: 'disk', operatorId: id, add: '2' },
      { kind: 'disk', operatorId: id, add: 100_000 },
      { kind: 'disk', operatorId: 7, add: 3 },
      { kind: 'disk', operatorId: id, add: 4, origin: 'sim' },
      { kind: 'disk', operatorId: id, add: 4, origin: 'elsewhere' },
    ]) {
      await bus.publish('admin', bad);
    }
    expect([...op.diskSlots]).toEqual([]);
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 4, origin: 'api' });
    expect([...op.diskSlots]).toEqual([4]);
    await game.shutdown();
  });

  it('a lost `disk` push heals at the next resync: Disk occupancy is re-read from the store', async () => {
    const bus = new MemoryBus();
    const store = new MemoryStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:dora' } }));
    const id = conn.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    await game.flush();
    // the bus was down: dora bought a daemon (now on her Disk at slot 3) and sold the one at slot 7 (still marked here)
    store.daemons.set('bought', { ...ownedRecord('pingling', 5, 3, 'bought'), operatorId: id, location: 'DISK', lockedBy: null });
    op.diskSlots.add(7);
    await game.chat.resync();
    expect([...op.diskSlots]).toEqual([3]);
    await game.shutdown();
  });

  it('a `disk` push that lands while a resync read is in flight wins over what the read returned', async () => {
    class GatedLive extends MemoryStore {
      gate: Promise<void> | null = null;
      override async liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>> {
        const state = await super.liveState(after);
        if (this.gate) await this.gate;
        return state;
      }
    }
    const bus = new MemoryBus();
    const store = new GatedLive();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:erin' } }));
    const id = conn.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    await game.flush();
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    const resync = game.chat.resync();
    await new Promise((r) => setTimeout(r, 5));
    // the read saw an empty Disk; a sale committed and its push arrives before the read is applied
    store.daemons.set('bought', { ...ownedRecord('pingling', 5, 0, 'bought'), operatorId: id, location: 'DISK', lockedBy: null });
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 0, origin: 'api' });
    open();
    await resync;
    expect([...op.diskSlots]).toEqual([0]);
    await game.shutdown();
  });

  it('a resync keeps the Disk slots reserved by store intents still waiting for the store', async () => {
    class GatedApply extends MemoryStore {
      gate: Promise<void> | null = null;
      override async applyIntent(...args: Parameters<MemoryStore['applyIntent']>) {
        if (this.gate && args[0].kind === 'store') await this.gate;
        return super.applyIntent(...args);
      }
    }
    const bus = new MemoryBus();
    const store = new GatedApply();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const rec = await store.loadOrCreateOperator('dev-fay', TEST_SUBNET.id, TEST_SUBNET.spawn);
    const daemon = ownedRecord('pingling', 5, 0, 'fay-d0');
    store.daemons.set(daemon.id, { ...daemon, operatorId: rec.id, location: 'RAM', lockedBy: null });
    store.operators.get(rec.id)!.starterClaimed = true;
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:fay' } }));
    await game.flush();
    const op = world.operators.get(rec.id)!;
    op.x = TEST_SUBNET.host.x;
    op.y = TEST_SUBNET.host.y;
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    await game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'st', cmd: 'store', actor: 'self', args: { daemonId: 'fay-d0' } } }));
    game.tick();
    expect([...op.diskSlots]).toEqual([0]);
    await game.chat.resync();
    expect([...op.diskSlots]).toEqual([0]); // the store does not have it yet, the world keeps the reservation
    open();
    await game.flush();
    await game.chat.resync();
    expect([...op.diskSlots]).toEqual([0]);
    await game.shutdown();
  });

  it('a store intent raised and committed while a resync read is in flight keeps its Disk slot', async () => {
    class GatedLive extends MemoryStore {
      gate: Promise<void> | null = null;
      override async liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>> {
        const state = await super.liveState(after);
        if (this.gate) await this.gate;
        return state;
      }
    }
    const bus = new MemoryBus();
    const store = new GatedLive();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const rec = await store.loadOrCreateOperator('dev-hal', TEST_SUBNET.id, TEST_SUBNET.spawn);
    const daemon = ownedRecord('pingling', 5, 0, 'hal-d0');
    store.daemons.set(daemon.id, { ...daemon, operatorId: rec.id, location: 'RAM', lockedBy: null });
    store.operators.get(rec.id)!.starterClaimed = true;
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:hal' } }));
    await game.flush();
    const op = world.operators.get(rec.id)!;
    op.x = TEST_SUBNET.host.x;
    op.y = TEST_SUBNET.host.y;
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    const resync = game.chat.resync();
    await new Promise((r) => setTimeout(r, 5));
    // the read saw an empty Disk; the store intent is raised and commits before the read is applied
    await game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'st', cmd: 'store', actor: 'self', args: { daemonId: 'hal-d0' } } }));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ reqId: 'st' });
    expect(store.daemons.get('hal-d0')).toMatchObject({ location: 'DISK', slot: 0 });
    open();
    await resync;
    expect([...op.diskSlots]).toEqual([0]); // the stale read must not free the slot the store now holds
    await game.chat.resync();
    expect([...op.diskSlots]).toEqual([0]);
    await game.shutdown();
  });

  it('a load frees its Disk slot: with a full Disk, a store right after it takes that slot', async () => {
    const bus = new MemoryBus();
    const store = new MemoryStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const rec = await store.loadOrCreateOperator('dev-ida', TEST_SUBNET.id, TEST_SUBNET.spawn);
    store.operators.get(rec.id)!.starterClaimed = true;
    store.operators.get(rec.id)!.diskCapacity = 2;
    const inRam = ownedRecord('pingling', 5, 0, 'ida-ram');
    store.daemons.set(inRam.id, { ...inRam, operatorId: rec.id, location: 'RAM', lockedBy: null });
    store.daemons.set('ida-disk0', { ...ownedRecord('bitrot', 6, 0, 'ida-disk0'), operatorId: rec.id, location: 'DISK', lockedBy: null });
    store.daemons.set('ida-disk1', { ...ownedRecord('bitrot', 6, 1, 'ida-disk1'), operatorId: rec.id, location: 'DISK', lockedBy: null });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:ida' } }));
    await game.flush();
    const op = world.operators.get(rec.id)!;
    op.x = TEST_SUBNET.host.x;
    op.y = TEST_SUBNET.host.y;
    expect([...op.diskSlots].sort()).toEqual([0, 1]);
    await game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'ld', cmd: 'load', actor: 'self', args: { daemonId: 'ida-disk1' } } }));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ reqId: 'ld' });
    expect([...op.diskSlots]).toEqual([0]);
    await game.message(conn, JSON.stringify({ t: 'cmd', seq: 3, d: { reqId: 'st', cmd: 'store', actor: 'self', args: { daemonId: 'ida-ram' } } }));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ reqId: 'st' });
    expect(store.daemons.get('ida-ram')).toMatchObject({ location: 'DISK', slot: 1 });
    expect([...op.diskSlots].sort()).toEqual([0, 1]);
    await game.shutdown();
  });

  it('a store refused because its Disk slot was taken re-reads Disk occupancy from the store, and the retry succeeds', async () => {
    const bus = new MemoryBus();
    const store = new MemoryStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const rec = await store.loadOrCreateOperator('dev-gus', TEST_SUBNET.id, TEST_SUBNET.spawn);
    const daemon = ownedRecord('pingling', 5, 0, 'gus-d0');
    store.daemons.set(daemon.id, { ...daemon, operatorId: rec.id, location: 'RAM', lockedBy: null });
    store.operators.get(rec.id)!.starterClaimed = true;
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:gus' } }));
    await game.flush();
    const op = world.operators.get(rec.id)!;
    op.x = TEST_SUBNET.host.x;
    op.y = TEST_SUBNET.host.y;
    // a purchase put a daemon in slot 0 and its push was lost; a stale slot 7 (sold) is still marked here
    store.daemons.set('bought', { ...ownedRecord('bitrot', 6, 0, 'bought'), operatorId: rec.id, location: 'DISK', lockedBy: null });
    op.diskSlots.add(7);
    const storeCmd = (reqId: string) => JSON.stringify({ t: 'cmd', seq: 2, d: { reqId, cmd: 'store', actor: 'self', args: { daemonId: 'gus-d0' } } });
    await game.message(conn, storeCmd('st1'));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('err').at(-1)!.d).toMatchObject({ reqId: 'st1', code: 'E_STATE', message: DISK_SLOT_TAKEN });
    expect([...op.diskSlots].sort()).toEqual([0]);
    await game.message(conn, storeCmd('st2'));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ reqId: 'st2' });
    expect(store.daemons.get('gus-d0')).toMatchObject({ location: 'DISK', slot: 1 });
    expect([...op.diskSlots].sort()).toEqual([0, 1]);
    await game.shutdown();
  });

  it('gives each side its own view of a listing sale: no counterparty id, the fee only to the seller', async () => {
    const { bus, game, join } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    // exactly what the api's buyListing publishes
    await bus.publish('exchange', {
      kind: 'listingSold',
      operators: [aliceId, bobId],
      detail: { listingId: 'l1', daemonId: 'd1', species: 'pingling', price: 160, fee: 10, buyerId: aliceId, sellerId: bobId },
    });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'listingSold', detail: { listingId: 'l1', daemonId: 'd1', species: 'pingling', price: 160, side: 'buy' } }]);
    expect(bob.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'listingSold', detail: { listingId: 'l1', daemonId: 'd1', species: 'pingling', price: 160, side: 'sell', fee: 10 } }]);
    expect(JSON.stringify(alice.of('delta').at(-1)!.d.events)).not.toContain(bobId);
    expect(JSON.stringify(bob.of('delta').at(-1)!.d.events)).not.toContain(aliceId);
    await game.shutdown();
  });
});
