import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

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
