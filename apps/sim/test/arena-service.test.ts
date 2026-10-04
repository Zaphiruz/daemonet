import { MemoryBus } from '@daemonet/bus';
import { ARENA_LEVEL, ARENA_MAX_MATCHES, SANDBOX, msToTicks } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type OperatorRecord } from '../src/core/index.js';
import { Out } from '../src/core/out.js';
import { ArenaService } from '../src/runtime/arena.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);
const RETURN = msToTicks(3000);
const GONE = msToTicks(8000);

/** ArenaService over one real home world, with the runtime's part (sessions, snapshots) faked. */
function harness(names: string[], ratings: Record<string, number> = {}) {
  const home = makeWorld('home');
  const where = new Map<string, World>();
  const events: Array<{ to: string; event: GameEvent }> = [];
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  const offline = new Set<string>();
  /** Operators whose next hand-over into a match fails (their session vanished). */
  const failTransfer = new Set<string>();
  let now = Date.parse('2026-10-02T12:00:00Z');
  let n = 0;
  for (const name of names) {
    home.addOperator(operatorRecord(name));
    where.set(name, home);
  }
  const arena = new ArenaService({
    locate: (id) => {
      const world = where.get(id);
      const op = world?.operators.get(id);
      return world === home && op ? { op, world } : undefined;
    },
    connected: (id) => !offline.has(id),
    busy: (id) => home.hasPendingFor(id),
    transfer: (id, to, record: OperatorRecord) => {
      if (to !== home && failTransfer.has(id)) return false;
      where.get(id)!.removeOperator(id);
      to.addOperator({ ...record, subnet: to.subnet.id });
      where.set(id, to);
      return true;
    },
    event: (to, event) => events.push({ to, event }),
    send: (to, msg) => sent.push({ to, msg }),
    rating: (id) => ratings[id] ?? 1500,
    now: () => now,
    newId: () => `${(++n).toString(16).padStart(8, '0')}${'0'.repeat(24)}`,
  });
  /** One game tick: match worlds step, then the service. */
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      for (const w of arena.worlds()) w.step([]);
      arena.tick();
    }
  };
  const challenge = (from: string, to: string, mode: 'ranked' | 'unranked' = 'unranked') => (arena.challenge(from, to, mode) as { challengeId: string }).challengeId;
  return {
    home,
    where,
    arena,
    events,
    sent,
    offline,
    failTransfer,
    tick,
    challenge,
    advance: (ms: number) => (now += ms),
    of: (e: GameEvent['e'], to?: string) => events.filter((x) => x.event.e === e && (!to || x.to === to)).map((x) => x.event),
  };
}

describe('ArenaService', () => {
  it('checks who may enter', () => {
    const h = harness(['alice', 'bob']);
    const alice = h.home.operators.get('alice')!;
    step(h.home, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ code: 'E_STATE', message: 'recall running daemons first' });
    h.home.deactivate(h.home.daemons.get('alice-d0')!);
    h.home.daemons.get('alice-d1')!.crashed = true;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'the arena needs 2 daemons in RAM that have not crashed' });
    h.home.daemons.get('alice-d1')!.crashed = false;
    alice.starterClaimed = false;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'claim a starter first' });
    alice.starterClaimed = true;
    expect(h.arena.queueUp('nobody', 'unranked')).toMatchObject({ message: 'not connected' });
    h.offline.add('alice');
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'not connected' });
    h.offline.delete('alice');
    alice.captureId = 'c1';
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'a capture is in progress' });
    alice.captureId = null;
    alice.travelling = true;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'wait for pending actions' });
    alice.travelling = false;
    h.home.trackIntent({ id: 'i1', kind: 'store', operatorId: 'alice', reqId: 'r1', daemonId: 'alice-d1', diskSlot: 0 }, new Out());
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'wait for pending actions' });
    h.home.completeIntent('i1', { ok: false, reason: 'test' });
    expect(h.arena.forfeit('alice')).toMatchObject({ message: 'not in an arena match' });
    expect(h.arena.queueUp('alice', 'unranked')).toEqual({ queued: 'unranked' });
    expect(h.arena.queued('alice')).toBe('unranked');
    h.arena.leaveQueue('alice');
    expect(h.of('arenaQueued', 'alice')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }, { e: 'arenaQueued', mode: null }]);
  });

  it('pairs the unranked queue in order, runs the match and brings both home as they were', () => {
    const h = harness(['alice', 'bob', 'carol']);
    h.home.daemons.get('alice-d0')!.hp = 7;
    h.home.operators.get('alice')!.x = 9.5;
    for (const name of ['alice', 'bob', 'carol']) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
    expect(h.arena.queued('carol')).toBe('unranked');
    const [world] = h.arena.worlds();
    expect(world!.subnet.id).toBe('sandbox');
    expect([...h.home.operators.keys()]).toEqual(['carol']);
    expect(world!.operators.get('alice')).toMatchObject(SANDBOX.arenaSpawns[0]);
    expect(world!.operators.get('bob')).toMatchObject(SANDBOX.arenaSpawns[1]);
    expect(world!.daemons.get('alice-d0')!.hp).toBeGreaterThan(7); // the copy is healed
    expect(h.of('arenaMatch', 'alice')[0]).toMatchObject({ mode: 'unranked', opponent: { id: 'bob', name: 'bob', rating: 1500 }, startsAtTick: COUNTDOWN });
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'already in an arena match' });
    // what a checkpoint would write while the match runs
    expect(h.arena.homeRecord('alice')).toMatchObject({ subnet: 'test', x: 9.5, ram: [{ id: 'alice-d0', hp: 7, level: 20 }, { id: 'alice-d1' }] });

    h.tick(COUNTDOWN);
    world!.operators.get('alice')!.bits += 50; // a sale on the Exchange lands mid-match
    expect(h.arena.forfeit('bob')).toEqual({ ok: true });
    h.tick();
    expect(h.of('arenaResult', 'alice')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit', counted: false, reward: 0 });
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'loss', reason: 'forfeit' });
    expect(h.arena.inMatch('alice')).toBe(true);
    h.tick(RETURN);
    expect(h.arena.inMatch('alice') || h.arena.inMatch('bob')).toBe(false);
    expect(h.arena.worlds()).toEqual([]);
    const alice = h.home.operators.get('alice')!;
    expect(alice).toMatchObject({ x: 9.5, bits: 50 });
    expect(h.home.daemons.get('alice-d0')).toMatchObject({ hp: 7, level: 20, crashed: false });
    expect(h.home.operators.has('bob')).toBe(true);
  });

  it('pairs ranked operators by rating, widening the window every 8 s', () => {
    const h = harness(['a', 'b', 'c'], { a: 1500, b: 1700, c: 1960 });
    for (const name of ['a', 'b', 'c']) h.arena.queueUp(name, 'ranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(0); // 200 apart, windows 64 + 64
    h.advance(8000);
    h.tick(16);
    expect(h.arena.inMatch('a') && h.arena.inMatch('b')).toBe(true); // 128 + 128
    expect(h.arena.inMatch('c')).toBe(false);
    const [world] = h.arena.worlds();
    expect(world!.daemons.get('a-d0')!.level).toBe(ARENA_LEVEL);
    expect(world!.arena).toMatchObject({ mode: 'ranked', ratings: { a: 1500, b: 1700 } });
  });

  it('queueing again in the same mode keeps the place (and the widened window); switching modes starts over', () => {
    const h = harness(['a', 'b'], { a: 1500, b: 1690 });
    h.arena.queueUp('a', 'ranked');
    h.advance(8000);
    expect(h.arena.queueUp('a', 'ranked')).toEqual({ queued: 'ranked' }); // spam: still waiting since the first
    h.arena.queueUp('b', 'ranked');
    expect(h.of('arenaQueued', 'a')).toHaveLength(1);
    h.tick(16);
    expect(h.arena.inMatch('a')).toBe(true); // 190 apart: a's 128 + b's 64

    const g = harness(['a', 'b'], { a: 1500, b: 1690 });
    g.arena.queueUp('a', 'unranked');
    g.advance(8000);
    g.arena.queueUp('a', 'ranked'); // a new queue, a new clock
    g.arena.queueUp('b', 'ranked');
    g.tick(16);
    expect(g.arena.worlds()).toHaveLength(0);
  });

  it('drops a queued operator that can no longer enter, telling it why', () => {
    const h = harness(['alice', 'bob']);
    h.arena.queueUp('alice', 'unranked');
    step(h.home, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    h.arena.queueUp('bob', 'unranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(0);
    expect(h.arena.queued('alice')).toBeNull();
    expect(h.of('arenaQueued', 'alice').at(-1)).toEqual({ e: 'arenaQueued', mode: null, reason: 'recall running daemons first' });
    expect(h.arena.queued('bob')).toBe('unranked');
  });

  it('challenges: delivered, accepted within 60 s, one at a time', () => {
    const h = harness(['alice', 'bob']);
    expect(h.arena.challenge('alice', 'alice', 'unranked')).toMatchObject({ code: 'E_INVALID' });
    expect(h.arena.challenge('alice', 'nobody', 'unranked')).toMatchObject({ message: 'that operator is not online' });
    h.offline.add('bob');
    expect(h.arena.challenge('alice', 'bob', 'unranked')).toMatchObject({ message: 'that operator is not online' });
    h.offline.delete('bob');
    const first = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.sent.at(-1)).toMatchObject({ to: 'bob', msg: { t: 'arenaChallenge', d: { challengeId: first.challengeId, from: 'alice', name: 'alice', mode: 'unranked' } } });
    expect(h.arena.accept('alice', first.challengeId)).toMatchObject({ code: 'E_INVALID' }); // not addressed to alice
    h.advance(61_000);
    expect(h.arena.accept('bob', first.challengeId)).toMatchObject({ message: 'that challenge has expired' });
    const second = h.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string };
    const third = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.arena.accept('bob', second.challengeId)).toMatchObject({ code: 'E_INVALID' }); // replaced by the third
    expect(h.arena.accept('bob', third.challengeId)).toMatchObject({ matchId: expect.any(String) });
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
    expect(h.arena.challenge('alice', 'bob', 'unranked')).toMatchObject({ message: 'already in an arena match' });
  });

  it('limits challenge spam, forgets expired challenges and drops a challenge whose challenger went into a match', () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    for (let i = 0; i < 8; i++) h.challenge('alice', 'bob');
    expect(h.arena.challenge('alice', 'bob', 'unranked')).toMatchObject({ code: 'E_RATE', message: 'too many challenges; wait a moment' });
    expect(h.sent.filter((s) => s.to === 'bob')).toHaveLength(8);
    h.advance(60_000);
    const late = h.challenge('alice', 'bob');
    h.advance(60_000);
    h.tick(16); // expired challenges are pruned with matchmaking
    expect(h.arena.accept('bob', late)).toMatchObject({ code: 'E_INVALID', message: 'no such challenge' });

    // carol challenges dave, then gets matched with bob from the queue: dave's challenge is gone
    const pending = h.challenge('carol', 'dave');
    h.arena.queueUp('carol', 'unranked');
    h.arena.queueUp('bob', 'unranked');
    h.tick(16);
    expect(h.arena.inMatch('carol')).toBe(true);
    expect(h.arena.accept('dave', pending)).toMatchObject({ message: 'no such challenge' });
  });

  it('a controller gone for 8 s forfeits; an operator that leaves is sent home at once', () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', h.challenge('alice', 'bob'));
    h.offline.add('alice');
    h.tick(GONE - 1);
    expect(h.of('arenaResult')).toEqual([]);
    h.tick();
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });

    h.arena.accept('dave', h.challenge('carol', 'dave'));
    h.arena.drop('carol');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.arena.inMatch('carol')).toBe(false);
    expect(h.arena.inMatch('dave')).toBe(true);
    expect(h.of('arenaResult', 'dave')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    h.tick(RETURN + 1);
    expect(h.where.get('dave')).toBe(h.home);
  });

  it('a controller back within 8 s plays on', () => {
    const h = harness(['alice', 'bob']);
    h.arena.accept('bob', h.challenge('alice', 'bob'));
    h.offline.add('alice');
    h.tick(GONE - 1);
    h.offline.delete('alice');
    h.tick(GONE + 1);
    expect(h.of('arenaResult')).toEqual([]);
    expect(h.arena.worlds()[0]!.arena!.phase).toBe('live');
  });

  it('both controllers gone is a draw; both leaving sends both home and closes the match', () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', h.challenge('alice', 'bob'));
    h.offline.add('alice');
    h.offline.add('bob');
    h.tick(GONE);
    expect(h.of('arenaResult').map((e) => (e as Extract<GameEvent, { e: 'arenaResult' }>).outcome)).toEqual(['draw', 'draw']);

    h.arena.accept('dave', h.challenge('carol', 'dave'));
    h.arena.drop('carol');
    h.arena.drop('dave');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.where.get('dave')).toBe(h.home);
    h.tick(RETURN + 1);
    expect(h.arena.worlds()).toEqual([]);
    expect(h.of('arenaResult', 'dave')).toHaveLength(1);
  });

  it('a forfeit and the clock on the same tick: whichever lands first decides, once', () => {
    const forfeitFirst = harness(['alice', 'bob']);
    forfeitFirst.arena.accept('bob', forfeitFirst.challenge('alice', 'bob'));
    const w1 = forfeitFirst.arena.worlds()[0]!;
    w1.daemons.get('bob-d0')!.hp -= 1; // alice would win on time
    w1.arena!.phase = 'live';
    w1.tick = w1.arena!.endsAtTick - 1;
    expect(forfeitFirst.arena.forfeit('bob')).toEqual({ ok: true });
    forfeitFirst.tick();
    expect(forfeitFirst.of('arenaResult', 'alice')).toEqual([expect.objectContaining({ outcome: 'win', reason: 'forfeit' })]);

    const clockFirst = harness(['alice', 'bob']);
    clockFirst.arena.accept('bob', clockFirst.challenge('alice', 'bob'));
    const w2 = clockFirst.arena.worlds()[0]!;
    w2.daemons.get('bob-d0')!.hp -= 1;
    w2.arena!.phase = 'live';
    w2.tick = w2.arena!.endsAtTick - 1;
    w2.step([]);
    expect(clockFirst.arena.forfeit('alice')).toMatchObject({ message: 'not in an arena match' });
    clockFirst.arena.tick();
    expect(clockFirst.of('arenaResult', 'alice')).toEqual([expect.objectContaining({ outcome: 'win', reason: 'timeout' })]);
    expect(clockFirst.of('arenaResult', 'bob')).toEqual([expect.objectContaining({ outcome: 'loss', reason: 'timeout' })]);
  });

  it('cancels the match when the second hand-over fails: the first operator goes home, nobody wins', () => {
    const h = harness(['alice', 'bob']);
    h.home.operators.get('alice')!.x = 9.5;
    h.failTransfer.add('bob');
    expect(h.arena.accept('bob', h.challenge('alice', 'bob'))).toMatchObject({ code: 'E_STATE', message: 'the match could not start' });
    expect(h.arena.worlds()).toEqual([]);
    expect(h.arena.inMatch('alice') || h.arena.inMatch('bob')).toBe(false);
    expect(h.where.get('alice')).toBe(h.home);
    expect(h.home.operators.get('alice')).toMatchObject({ x: 9.5 });
    h.tick(GONE + RETURN);
    expect(h.of('arenaResult')).toEqual([]);
    expect(h.of('arenaMatch')).toEqual([]);
  });

  it('ending every match (shutdown) sends everyone home without a result', () => {
    const h = harness(['alice', 'bob']);
    h.arena.queueUp('alice', 'unranked');
    h.arena.queueUp('bob', 'unranked');
    h.tick(16);
    h.arena.endAll();
    expect(h.arena.worlds()).toEqual([]);
    expect([...h.home.operators.keys()].sort()).toEqual(['alice', 'bob']);
    expect(h.of('arenaResult')).toEqual([]);
  });

  it('caps concurrent matches at 16 and ranked matches between the same pair at 4 a day', () => {
    const names = Array.from({ length: 2 * ARENA_MAX_MATCHES + 2 }, (_, i) => `op${i}`);
    const h = harness(names);
    for (const name of names) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(ARENA_MAX_MATCHES);
    expect(h.arena.queued('op32')).toBe('unranked');
    expect(h.arena.accept('op33', h.challenge('op32', 'op33'))).toMatchObject({ message: 'the arena is full; try again shortly' });

    const pair = harness(['alice', 'bob']);
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      pair.arena.accept('bob', pair.challenge('alice', 'bob', 'ranked'));
      modes.push(pair.arena.worlds()[0]!.arena!.mode);
      pair.arena.forfeit('alice');
      pair.tick(RETURN + 2);
    }
    expect(modes).toEqual(['ranked', 'ranked', 'ranked', 'ranked', 'unranked']);
    pair.advance(24 * 3600_000); // a new UTC day
    pair.arena.accept('bob', pair.challenge('alice', 'bob', 'ranked'));
    expect(pair.arena.worlds()[0]!.arena!.mode).toBe('ranked');
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `arena-conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  events<E extends GameEvent['e']>(e: E) {
    return this.of('delta').flatMap((m) => m.d.events).filter((x): x is Extract<GameEvent, { e: E }> => x.e === e);
  }
}

describe('arena matches in the runtime', () => {
  async function setup(opts: { leaveAfterTicks?: number; checkpointEveryTicks?: number } = {}) {
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus, ...opts });
    let seq = 0;
    const connect = async (name: string, role?: 'spectator') => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...(role ? { role } : {}) } }));
      return conn;
    };
    const join = async (name: string) => {
      const conn = await connect(name);
      const id = conn.of('authOk')[0]!.d.operatorId;
      const op = world.operators.get(id)!;
      op.starterClaimed = true;
      op.name = name;
      world.addOwned(op, { ...ownedRecord('pingling', 20, 0, `${name}-d0`), originalOperatorId: id });
      world.addOwned(op, { ...ownedRecord('glitchmite', 20, 1, `${name}-d1`), originalOperatorId: id });
      // the store holds the same daemons (as if loaded)
      for (const d of world.checkpoint(id).ram) store.daemons.set(d.id, { ...d, operatorId: id, location: 'RAM' });
      const cmd = (command: object, via = conn) => game.message(via, JSON.stringify({ t: 'cmd', seq: ++seq, d: { reqId: `q${seq}`, ...command } }));
      return { conn, id, cmd };
    };
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) game.tick();
    };
    const duel = async (a: Awaited<ReturnType<typeof join>>, b: Awaited<ReturnType<typeof join>>) => {
      await a.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: b.id, mode: 'unranked' } });
      await b.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: b.conn.of('arenaChallenge').at(-1)!.d.challengeId } });
      return game.worldOf(a.id)!;
    };
    return { game, world, store, bus, join, connect, ticks, duel };
  }

  it('queues two operators into a sandbox world with fresh snapshots, and back', async () => {
    const { game, world, join, ticks } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    await a.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'not in an arena match' });
    await a.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    await b.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    expect(a.conn.of('ack').at(-1)!.d.result).toEqual({ queued: 'unranked' });
    ticks(17);
    expect(a.conn.events('arenaQueued')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }]);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'sandbox', self: { arena: { phase: 'countdown', mode: 'unranked', opponent: { id: b.id } } } });
    // alice entered first; the delta that follows shows bob and his team
    expect(a.conn.of('delta').at(-1)!.d.self!.arena!.opponent).toMatchObject({ name: 'bob', team: [{ id: 'bob-d0', running: false }, { id: 'bob-d1' }] });
    expect(a.conn.events('arenaMatch')[0]).toMatchObject({ opponent: { id: b.id } });
    expect(world.operators.size).toBe(0);
    expect(game.worldOf(a.id)!.subnet.id).toBe('sandbox');

    ticks(COUNTDOWN);
    // a normal command now runs in the match world; one outside the whitelist is refused there
    await a.cmd({ cmd: 'run', actor: 'self', args: { daemonId: 'alice-d0' } });
    await a.cmd({ cmd: 'restoreAll', actor: 'self', args: {} });
    ticks(1);
    expect(a.conn.of('ack').at(-1)!.d.reqId).toBeDefined();
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ message: 'not available in an arena match' });
    expect(a.conn.of('delta').at(-1)!.d.self).toMatchObject({ running: ['alice-d0'], arena: { phase: 'live' } });

    await b.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    ticks(2);
    expect(a.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit' });
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'loss' });
    ticks(RETURN + 1);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'test', self: { arena: null, running: [], ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1' }] } });
    expect(world.operators.size).toBe(2);
    await game.shutdown();
  });

  it('checkpoints the home record during a match and forfeits for an operator that leaves', async () => {
    const { game, world, store, join, ticks } = await setup({ leaveAfterTicks: 24, checkpointEveryTicks: 8 });
    const a = await join('alice');
    const b = await join('bob');
    const checkpoints: OperatorRecord[][] = [];
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(records.map((r) => structuredClone(r)));
      return checkpoint(records);
    };
    await a.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: b.id, mode: 'ranked' } });
    const challenge = b.conn.of('arenaChallenge')[0]!.d;
    expect(challenge).toMatchObject({ from: a.id, name: 'alice', mode: 'ranked' });
    await b.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: challenge.challengeId } });
    expect(a.conn.of('snapshot').at(-1)!.d.self.ram[0]).toMatchObject({ level: ARENA_LEVEL });
    ticks(16);
    await game.flush();
    expect(checkpoints.at(-1)!.find((r) => r.id === a.id)).toMatchObject({ subnet: 'test', ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1', level: 20 }] });

    game.disconnect(a.conn);
    ticks(25);
    await game.flush();
    expect(game.worldOf(a.id)).toBeUndefined(); // gone from the server…
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    expect(checkpoints.at(-1)).toMatchObject([{ id: a.id, subnet: 'test', ram: [{ level: 20 }, { level: 20 }] }]); // …with its real daemons
    ticks(RETURN + 1);
    expect(game.worldOf(b.id)).toBe(world);
    expect(checkpoints.flat().every((r) => r.subnet === 'test')).toBe(true);
    await game.shutdown();
  });

  it('nothing a copy does reaches the store: crashes, move type uses, held items, HP, position', async () => {
    const { game, world, store, join, ticks, duel } = await setup({ checkpointEveryTicks: 4 });
    const a = await join('alice');
    const b = await join('bob');
    world.daemons.get('alice-d0')!.heldItem = 'amplifier';
    store.daemons.get('alice-d0')!.heldItem = 'amplifier';
    const before = structuredClone([...store.daemons.entries()]);
    const opBefore = structuredClone(store.operators.get(a.id));
    const arena = await duel(a, b);
    ticks(COUNTDOWN + 1);
    // the copies take a beating
    for (const id of ['alice-d0', 'alice-d1']) {
      const d = arena.daemons.get(id)!;
      d.hp = 0;
      d.crashed = true;
      d.crashes += 3;
      d.moveTypeUses = d.moveTypeUses.map((n) => n + 7);
      d.heldItem = null;
      d.energy = 0;
    }
    arena.operators.get(a.id)!.inventory.sniff = 0;
    ticks(2); // wipe-out
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'wipeout' });
    ticks(8); // checkpoints while the beaten copies are still in the match world
    await game.flush();
    expect(game.worldOf(a.id)).toBe(arena);
    expect([...store.daemons.entries()]).toEqual(before);
    expect(store.operators.get(a.id)).toEqual(opBefore);
    ticks(RETURN);
    await game.flush();
    expect(game.worldOf(a.id)).toBe(world);
    expect([...store.daemons.entries()]).toEqual(before);
    expect(store.operators.get(a.id)).toEqual(opBefore);
    expect(world.daemons.get('alice-d0')).toMatchObject({ crashed: false, crashes: 0, heldItem: 'amplifier' });
    await game.shutdown();
    expect([...store.daemons.entries()]).toEqual(before);
  });

  it('bits, Disk slots, a rename and an org pushed by the api mid-match land on the operator and come home with it', async () => {
    const { game, world, bus, store, join, ticks, duel } = await setup({ checkpointEveryTicks: 4 });
    const a = await join('alice');
    const b = await join('bob');
    const checkpoints: OperatorRecord[][] = [];
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(records.map((r) => structuredClone(r)));
      return checkpoint(records);
    };
    await game.flush();
    const arena = await duel(a, b);
    const org = { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'MEMBER' } as const;
    await bus.publish('admin', { kind: 'bits', operatorId: a.id, ledgerId: 'l1', seq: 1_000_000, delta: 40, reason: 'admin', balance: 40, origin: 'api' });
    await bus.publish('admin', { kind: 'disk', operatorId: a.id, add: 7, origin: 'api' });
    await bus.publish('admin', { kind: 'rename', operatorId: a.id, name: 'alicia', origin: 'api' });
    await bus.publish('org', { kind: 'membership', operatorId: a.id, org, origin: 'api' });
    ticks(1);
    expect(a.conn.events('bits')).toEqual([expect.objectContaining({ delta: 40, balance: 40 })]);
    ticks(8);
    await game.flush();
    // checkpoints during the match carry the home record with the pushed name, org and Disk
    expect(checkpoints.at(-1)!.find((r) => r.id === a.id)).toMatchObject({ subnet: 'test', name: 'alicia', org, diskSlots: [7], bits: 40 });
    expect(arena.operators.get(a.id)).toMatchObject({ name: 'alicia', bits: 40 });
    await a.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    ticks(RETURN + 2);
    const back = world.operators.get(a.id)!;
    expect(back).toMatchObject({ name: 'alicia', bits: 40, org });
    expect([...back.diskSlots]).toEqual([7]);
    // a push after the return lands at home as usual
    await bus.publish('admin', { kind: 'bits', operatorId: a.id, ledgerId: 'l2', seq: 1_000_001, delta: 2, reason: 'admin', balance: 42, origin: 'api' });
    expect(back.bits).toBe(42);
    await game.shutdown();
  });

  it('a controller that reconnects within 8 s is back in its match; travel and cluster invites are refused there', async () => {
    const { game, join, connect, ticks, duel } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    await duel(a, b);
    ticks(COUNTDOWN + 1);
    await a.cmd({ cmd: 'travel', actor: 'self', args: { gatewayId: 'test-testb' } });
    await a.cmd({ cmd: 'clusterInvite', actor: 'self', args: { operatorId: b.id } });
    ticks(1);
    expect(a.conn.of('err').map((e) => e.d.message)).toEqual(['not available in an arena match', 'not available in an arena match']);

    game.disconnect(a.conn);
    ticks(GONE - 16);
    const again = await connect('alice');
    expect(again.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'sandbox', self: { arena: { phase: 'live' } } });
    ticks(GONE);
    expect(b.conn.events('arenaResult')).toEqual([]);
    expect(game.worldOf(a.id)!.subnet.id).toBe('sandbox');
    await game.shutdown();
  });

  it('the challenge reaches every connection of the target; spectators follow the operator into the match', async () => {
    const { game, join, connect, duel } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    const watcher = await connect('bob', 'spectator');
    const arena = await duel(a, b);
    expect(watcher.of('arenaChallenge')).toHaveLength(1);
    expect(a.conn.of('arenaChallenge')).toEqual([]);
    expect(watcher.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'sandbox' });
    expect(arena.operators.size).toBe(2);
    await game.shutdown();
  });

  it('shutdown ends every match and checkpoints the operators as they left home', async () => {
    const { game, world, store, join, ticks, duel } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    world.operators.get(a.id)!.x = 9.5;
    const checkpoints: OperatorRecord[][] = [];
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(records.map((r) => structuredClone(r)));
      return checkpoint(records);
    };
    await duel(a, b);
    ticks(COUNTDOWN + 1);
    await game.shutdown();
    expect(a.conn.of('kick').at(-1)!.d.reason).toBe('server shutting down');
    expect(b.conn.events('arenaResult')).toEqual([]);
    expect(world.operators.size).toBe(2);
    const last = checkpoints.at(-1)!;
    expect(last.map((r) => [r.id, r.subnet]).sort()).toEqual([a.id, b.id].sort().map((id) => [id, 'test']));
    expect(last.find((r) => r.id === a.id)).toMatchObject({ x: 9.5, ram: [{ level: 20 }, { level: 20 }] });
  });
});
