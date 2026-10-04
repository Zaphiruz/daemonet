import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET, TEST_SUBNET_B } from './helpers.js';

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
});
