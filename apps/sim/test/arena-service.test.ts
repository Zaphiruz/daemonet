import { MemoryBus } from '@daemonet/bus';
import { ARENA_DAILY_WINS, ARENA_LEVEL, ARENA_MAX_MATCHES, ARENA_WIN_BITS, INCIDENT_MAX_OPERATORS, SANDBOX, getSubnet, msToTicks, seasonIdOf } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type OperatorRecord } from '../src/core/index.js';
import { Out } from '../src/core/out.js';
import { ArenaService } from '../src/runtime/arena.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, RELOAD_KICK, type Conn, type Logger } from '../src/runtime/game.js';
import { gracefulShutdown } from '../src/runtime/shutdown.js';
import { MemoryStore, definitiveStoreError, type ArenaResultInput, type ArenaSettlement, type ArenaSideResult } from '../src/runtime/store.js';
import { TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);
const RETURN = msToTicks(3000);
const GONE = msToTicks(8000);

/** ArenaService over one real home world, with the runtime's part (sessions, snapshots, crediting) faked. */
function harness(names: string[], ratings: Record<string, number> = {}) {
  const home = makeWorld('home');
  /** Results are settled by a real MemoryStore that knows the operators and their RAM daemons. */
  const store = new MemoryStore();
  const recorded: ArenaResultInput[] = [];
  const credited: Array<{ id: string; r: ArenaSideResult }> = [];
  let storeDown = false;
  /** While set, results wait for the store (`hold` / `release`). */
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const where = new Map<string, World>();
  const events: Array<{ to: string; event: GameEvent }> = [];
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  const offline = new Set<string>();
  /** Operators whose next hand-over into a match fails (their session vanished). */
  const failTransfer = new Set<string>();
  let now = Date.parse('2026-10-02T12:00:00Z');
  let n = 0;
  for (const name of names) {
    const rec = operatorRecord(name);
    home.addOperator(rec);
    where.set(name, home);
    store.operators.set(name, { id: name, sub: name, name, starterClaimed: true, subnet: 'test', bits: 0, diskCapacity: 256, x: 0, y: 0, inventory: {} });
    for (const d of rec.ram) store.daemons.set(d.id, { ...d, operatorId: name, location: 'RAM' });
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
    record: async (input) => {
      recorded.push(input);
      if (gate) await gate.promise;
      return storeDown ? null : store.recordArenaResult(input);
    },
    rated: (id, rating) => (ratings[id] = rating),
    // the runtime's part: wherever the operator is now (the real one checks the ledger seq against the session's load)
    credit: (id, r) => {
      credited.push({ id, r });
      const world = where.get(id);
      const op = world?.operators.get(id);
      if (!world || !op) return;
      if (r.reward > 0) {
        op.bits += r.reward;
        events.push({ to: id, event: { e: 'bits', delta: r.reward, reason: 'arena', balance: op.bits } });
      }
      for (const d of r.arenaWins) if (world.daemons.get(d)?.ownerId === id) world.daemons.get(d)!.arenaWins++;
    },
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
  /** Lets the (asynchronous) store settle and the service announce. */
  const settled = () => new Promise<void>((r) => setImmediate(r));
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
    store,
    recorded,
    credited,
    ratings,
    settled,
    failStore: () => (storeDown = true),
    hold: () => {
      let open!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      gate = { promise, open };
    },
    release: () => {
      gate?.open();
      gate = null;
    },
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

  it('pairs the unranked queue in order, runs the match and brings both home as they were', async () => {
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
    expect(h.of('arenaResult')).toEqual([]); // announced once the store has settled it
    await h.settled();
    expect(h.recorded[0]).toMatchObject({ mode: 'unranked', aId: 'alice', bId: 'bob', winnerId: 'alice', reason: 'forfeit', live: true });
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

  it('a controller gone for 8 s forfeits; an operator that leaves is sent home at once', async () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', h.challenge('alice', 'bob'));
    h.offline.add('alice');
    h.tick(GONE - 1);
    await h.settled();
    expect(h.of('arenaResult')).toEqual([]);
    h.tick();
    await h.settled();
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });

    h.arena.accept('dave', h.challenge('carol', 'dave'));
    h.arena.drop('carol');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.arena.inMatch('carol')).toBe(false);
    expect(h.arena.inMatch('dave')).toBe(true);
    await h.settled();
    expect(h.of('arenaResult', 'dave')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    // carol left during the countdown: recorded, never counted
    expect(h.recorded.at(-1)).toMatchObject({ aId: 'carol', bId: 'dave', winnerId: 'dave', reason: 'disconnect', live: false });
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

  it('both controllers gone is a draw; both leaving sends both home and closes the match', async () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', h.challenge('alice', 'bob'));
    h.offline.add('alice');
    h.offline.add('bob');
    h.tick(GONE);
    await h.settled();
    expect(h.of('arenaResult').map((e) => (e as Extract<GameEvent, { e: 'arenaResult' }>).outcome)).toEqual(['draw', 'draw']);

    h.arena.accept('dave', h.challenge('carol', 'dave'));
    h.arena.drop('carol');
    h.arena.drop('dave');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.where.get('dave')).toBe(h.home);
    h.tick(RETURN + 1);
    await h.settled();
    expect(h.arena.worlds()).toEqual([]);
    expect(h.of('arenaResult', 'dave')).toHaveLength(1);
    expect(h.recorded).toHaveLength(2); // one result per match
  });

  it('a forfeit and the clock on the same tick: whichever lands first decides, once', async () => {
    const forfeitFirst = harness(['alice', 'bob']);
    forfeitFirst.arena.accept('bob', forfeitFirst.challenge('alice', 'bob'));
    const w1 = forfeitFirst.arena.worlds()[0]!;
    w1.daemons.get('bob-d0')!.hp -= 1; // alice would win on time
    w1.arena!.phase = 'live';
    w1.tick = w1.arena!.endsAtTick - 1;
    expect(forfeitFirst.arena.forfeit('bob')).toEqual({ ok: true });
    forfeitFirst.tick();
    await forfeitFirst.settled();
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
    await clockFirst.settled();
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
    // both are told (the challenger has no reply of its own to learn it from)
    for (const name of ['alice', 'bob']) expect(h.of('arenaQueued', name)).toEqual([{ e: 'arenaQueued', mode: null, reason: 'the match could not start' }]);

    // from the queue: both drop out of it and are told why
    const q = harness(['alice', 'bob']);
    q.arena.queueUp('alice', 'unranked');
    q.arena.queueUp('bob', 'unranked');
    q.failTransfer.add('bob');
    q.tick(16);
    expect(q.arena.worlds()).toEqual([]);
    for (const name of ['alice', 'bob']) {
      expect(q.arena.queued(name)).toBeNull();
      expect(q.of('arenaQueued', name).at(-1)).toEqual({ e: 'arenaQueued', mode: null, reason: 'the match could not start' });
    }
  });

  it('counts a challenge against the limit before saying whether the target is online or in a match', () => {
    const h = harness(['alice', 'bob']);
    for (let i = 0; i < 8; i++) expect(h.arena.challenge('alice', 'nobody', 'unranked')).toMatchObject({ message: 'that operator is not online' });
    expect(h.arena.challenge('alice', 'nobody', 'unranked')).toMatchObject({ code: 'E_RATE' });
    expect(h.arena.challenge('alice', 'bob', 'unranked')).toMatchObject({ code: 'E_RATE' });
    expect(h.sent).toEqual([]);
  });

  it('forgets earlier days’ ranked pair counts in the matchmaking sweep', () => {
    const h = harness(['alice', 'bob']);
    h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
    h.arena.forfeit('alice');
    h.tick(RETURN + 2);
    const counts = (h.arena as unknown as { pairCounts: Map<string, number> }).pairCounts;
    expect(counts.size).toBe(1);
    h.tick(16);
    expect(counts.size).toBe(1); // same day: kept
    h.advance(24 * 3600_000);
    h.tick(16);
    expect(counts.size).toBe(0);
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

  it('shutdown right after a decided forfeit still records the match', async () => {
    const h = harness(['alice', 'bob']);
    h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
    h.tick(COUNTDOWN);
    expect(h.arena.forfeit('bob')).toEqual({ ok: true });
    h.arena.endAll(); // before the next tick could report it
    await h.settled();
    expect(h.arena.worlds()).toEqual([]);
    expect([...h.home.operators.keys()].sort()).toEqual(['alice', 'bob']);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ mode: 'ranked', winnerId: 'alice', reason: 'forfeit', live: true });
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

  it('settles ranked results: ratings, the win reward and arenaWins reach the store and the operators', async () => {
    const h = harness(['alice', 'bob']);
    const play = async (winner: string, loser: string) => {
      h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
      const [world] = h.arena.worlds();
      world!.arena!.dealt.add(`${winner}-d0`).add(`${loser}-d1`);
      h.tick(COUNTDOWN);
      h.arena.forfeit(loser);
      h.tick();
      await h.settled();
      return { winner: h.of('arenaResult', winner).at(-1)!, loser: h.of('arenaResult', loser).at(-1)!, world: world! };
    };
    const first = await play('alice', 'bob');
    expect(h.recorded[0]).toMatchObject({ mode: 'ranked', winnerId: 'alice', live: true, dealt: { alice: ['alice-d0'], bob: ['bob-d1'] } });
    expect(first.winner).toMatchObject({ outcome: 'win', counted: true, ratingBefore: 1500, reward: ARENA_WIN_BITS });
    expect(first.loser).toMatchObject({ outcome: 'loss', counted: true, reward: 0 });
    expect((first.winner as { ratingAfter: number }).ratingAfter).toBeGreaterThan(1600);
    expect((first.loser as { ratingAfter: number }).ratingAfter).toBeLessThan(1400);
    expect(h.of('bits', 'alice')).toEqual([{ e: 'bits', delta: ARENA_WIN_BITS, reason: 'arena', balance: ARENA_WIN_BITS }]);
    // still in the match world: the reward lands on the operator there, the counter on the home record; both travel home
    expect(first.world.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect(h.credited.find((c) => c.id === 'alice')!.r).toMatchObject({ reward: ARENA_WIN_BITS, arenaWins: [] });
    expect(h.arena.homeRecord('alice')!.ram.map((d) => d.arenaWins)).toEqual([1, 0]);
    expect(first.world.daemons.get('alice-d0')!.arenaWins).toBe(0); // the copy is not the daemon
    h.tick(RETURN + 1);
    expect(h.home.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect([h.home.daemons.get('alice-d0')!.arenaWins, h.home.daemons.get('alice-d1')!.arenaWins, h.home.daemons.get('bob-d1')!.arenaWins]).toEqual([1, 0, 0]);
    expect(h.store.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect(h.store.daemons.get('alice-d0')!.arenaWins).toBe(1);
    expect(h.store.ledger).toMatchObject([{ operatorId: 'alice', delta: ARENA_WIN_BITS, reason: 'arena' }]);
    // the next match starts from the new ratings
    const settlement = h.store.arenaMatches.get(h.recorded[0]!.matchId)!.settlement;
    expect(h.ratings).toEqual({ alice: settlement.a.after, bob: settlement.b.after });
    const second = await play('bob', 'alice');
    expect(second.world.arena!.ratings).toEqual({ alice: settlement.a.after, bob: settlement.b.after });
    expect(second.winner).toMatchObject({ outcome: 'win', counted: true, reward: ARENA_WIN_BITS });
    h.tick(RETURN + 1);
    expect(h.home.daemons.get('bob-d0')!.arenaWins).toBe(1);

    // the store stays unreachable: the match still ends and everyone goes home, nothing is counted or credited
    h.failStore();
    const ratings = { ...h.ratings };
    const third = await play('alice', 'bob');
    expect(third.winner).toMatchObject({ outcome: 'win', counted: false, reward: 0, ratingBefore: ratings.alice, ratingAfter: ratings.alice });
    h.tick(RETURN + 1);
    expect(h.home.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect(h.home.daemons.get('alice-d0')!.arenaWins).toBe(1);
    expect(h.ratings).toEqual(ratings);
  });

  it('a result the store settles after the return is credited to the home daemons by the runtime', async () => {
    const h = harness(['alice', 'bob']);
    h.hold();
    h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
    h.arena.worlds()[0]!.arena!.dealt.add('alice-d0');
    h.tick(COUNTDOWN);
    h.arena.forfeit('bob');
    h.tick(RETURN + 2);
    expect(h.where.get('alice')).toBe(h.home);
    h.release();
    await h.settled();
    expect(h.credited.find((c) => c.id === 'alice')!.r).toMatchObject({ reward: ARENA_WIN_BITS, arenaWins: ['alice-d0'] });
    expect(h.home.daemons.get('alice-d0')!.arenaWins).toBe(1);
    expect(h.home.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect(h.of('arenaResult', 'alice')).toHaveLength(1);
  });

  it('a result that lands while the winner is already in its next match goes to the home record, not the copies', async () => {
    const h = harness(['alice', 'bob']);
    h.hold();
    h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
    h.arena.worlds()[0]!.arena!.dealt.add('alice-d0');
    h.tick(COUNTDOWN);
    h.arena.forfeit('bob');
    h.tick(RETURN + 2);
    expect(h.where.get('alice')).toBe(h.home);
    // the next match starts before the store has answered for the first
    h.arena.accept('bob', h.challenge('alice', 'bob', 'unranked'));
    const next = h.arena.worlds()[0]!;
    expect(h.where.get('alice')).toBe(next);
    h.release();
    await h.settled();
    expect(h.credited.find((c) => c.id === 'alice')!.r).toMatchObject({ reward: ARENA_WIN_BITS, arenaWins: [] });
    expect(h.arena.homeRecord('alice')!.ram.map((d) => d.arenaWins)).toEqual([1, 0]);
    expect(next.daemons.get('alice-d0')!.arenaWins).toBe(0); // a copy
    expect(next.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    h.arena.forfeit('alice');
    h.tick(RETURN + 2);
    await h.settled();
    expect(h.where.get('alice')).toBe(h.home);
    expect([h.home.daemons.get('alice-d0')!.arenaWins, h.home.daemons.get('alice-d1')!.arenaWins]).toEqual([1, 0]);
    expect(h.home.operators.get('alice')!.bits).toBe(ARENA_WIN_BITS);
    expect(h.store.daemons.get('alice-d0')!.arenaWins).toBe(1);
  });

  it('only a definitive store error stops the retries at once', () => {
    const prisma = (name: string, code?: string) => Object.assign(new Error('x'), { name, code });
    expect(definitiveStoreError(new RangeError('bad'))).toBe(true);
    expect(definitiveStoreError(prisma('PrismaClientValidationError'))).toBe(true);
    expect(definitiveStoreError(prisma('PrismaClientKnownRequestError', 'P2003'))).toBe(true);
    for (const code of ['P1001', 'P1017', 'P2024', 'P2028', 'P2034']) expect(definitiveStoreError(prisma('PrismaClientKnownRequestError', code))).toBe(false);
    expect(definitiveStoreError(prisma('PrismaClientInitializationError'))).toBe(false);
    // database errors wrapped by the driver adapter (P2010 raw query, P2039 other): transient by cause kind or SQLSTATE
    const wrapped = (code: string, cause: object) => Object.assign(prisma('PrismaClientKnownRequestError', code), { meta: { driverAdapterError: { name: 'DriverAdapterError', cause } } });
    // the exact shape of an induced deadlock on recordArenaResult's lockOperator (store.test.ts reproduces it)
    expect(definitiveStoreError(wrapped('P2010', { originalCode: '40P01', originalMessage: 'deadlock detected', kind: 'TransactionWriteConflict' }))).toBe(false);
    for (const kind of ['TransactionWriteConflict', 'ConnectionClosed', 'DatabaseNotReachable', 'SocketTimeout', 'TooManyConnections', 'TlsConnectionError', 'TransactionAlreadyClosed']) {
      expect(definitiveStoreError(wrapped('P2010', { kind }))).toBe(false);
    }
    for (const originalCode of ['40001', '40P01', '08006', '57P01', '57014', '53300', '55P03']) {
      expect(definitiveStoreError(wrapped('P2010', { kind: 'postgres', originalCode }))).toBe(false);
      expect(definitiveStoreError(wrapped('P2039', { kind: 'postgres', originalCode }))).toBe(false);
    }
    expect(definitiveStoreError(wrapped('P2010', { kind: 'postgres', code: '40001' }))).toBe(false);
    for (const originalCode of ['23505', '22P02', '42P01', '55000']) expect(definitiveStoreError(wrapped('P2010', { kind: 'postgres', originalCode }))).toBe(true);
    expect(definitiveStoreError(wrapped('P2010', { kind: 'UniqueConstraintViolation', originalCode: '23505' }))).toBe(true);
    expect(definitiveStoreError(prisma('PrismaClientKnownRequestError', 'P2010'))).toBe(true); // no cause: nothing says transient
    expect(definitiveStoreError(new Error('connection reset'))).toBe(false);
  });

  it('a match that ends in its countdown is recorded as not live (never counted)', async () => {
    const h = harness(['alice', 'bob']);
    h.arena.accept('bob', h.challenge('alice', 'bob', 'ranked'));
    h.tick(COUNTDOWN - 2);
    h.arena.forfeit('bob');
    h.tick();
    await h.settled();
    expect(h.recorded[0]).toMatchObject({ mode: 'ranked', winnerId: 'alice', reason: 'forfeit', live: false });
    expect(h.of('arenaResult', 'alice')[0]).toMatchObject({ outcome: 'win', counted: false, reward: 0, ratingBefore: 1500, ratingAfter: 1500 });
    expect(h.store.ledger).toEqual([]);
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
  async function setup<S extends MemoryStore = MemoryStore>(
    opts: { leaveAfterTicks?: number; checkpointEveryTicks?: number; worlds?: World[]; store?: S; retryDelaysMs?: number[]; unknownRetryLimit?: number; log?: Logger } = {},
  ) {
    const { worlds, store: given, ...rest } = opts;
    const store = (given ?? new MemoryStore()) as S;
    const bus = new MemoryBus();
    const world = worlds?.[0] ?? new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: worlds ?? [world], store, verify: createDevVerifier('daemonet-users'), bus, ...rest });
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
      const w = game.worldOf(id)!;
      const op = w.operators.get(id)!;
      op.starterClaimed = true;
      op.name = name;
      w.addOwned(op, { ...ownedRecord('pingling', 20, 0, `${name}-d0`), originalOperatorId: id });
      w.addOwned(op, { ...ownedRecord('glitchmite', 20, 1, `${name}-d1`), originalOperatorId: id });
      // the store holds the same daemons (as if loaded)
      for (const d of w.checkpoint(id).ram) store.daemons.set(d.id, { ...d, operatorId: id, location: 'RAM' });
      const cmd = (command: object, via = conn) => game.message(via, JSON.stringify({ t: 'cmd', seq: ++seq, d: { reqId: `q${seq}`, ...command } }));
      return { conn, id, cmd, name };
    };
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) game.tick();
    };
    const duel = async (a: Awaited<ReturnType<typeof join>>, b: Awaited<ReturnType<typeof join>>, mode: 'ranked' | 'unranked' = 'unranked') => {
      await a.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: b.id, mode } });
      await b.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: b.conn.of('arenaChallenge').at(-1)!.d.challengeId } });
      return game.worldOf(a.id)!;
    };
    /** `winner` beats `loser` in a ranked match (its first daemon dealt damage; the loser forfeits once it is live). */
    const rankedWin = async (winner: Awaited<ReturnType<typeof join>>, loser: Awaited<ReturnType<typeof join>>) => {
      const arena = await duel(winner, loser, 'ranked');
      arena.arena!.dealt.add(`${winner.name}-d0`);
      ticks(COUNTDOWN);
      await loser.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
      ticks(1);
      return arena;
    };
    return { game, world, store, bus, join, connect, ticks, duel, rankedWin };
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
    await game.flush();
    ticks(1);
    expect(a.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit', counted: false });
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
    expect(checkpoints.at(-1)).toMatchObject([{ id: a.id, subnet: 'test', ram: [{ level: 20 }, { level: 20 }] }]); // …with its real daemons
    ticks(1);
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect', counted: false });
    // it ended in the countdown: recorded, never counted
    expect([...store.arenaMatches.values()]).toMatchObject([{ input: { mode: 'ranked', winnerId: b.id, live: false }, settlement: { counted: false } }]);
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
    await game.flush();
    ticks(1);
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

  it('an operator coming home to a kernelspace that filled up during its match lands at backbone’s spawn', async () => {
    const backbone = new World({ subnet: getSubnet('backbone'), seed: 'b', seedId: 'bbbb0001', spawner: false });
    const ks = new World({ subnet: getSubnet('kernelspace'), seed: 'k', seedId: 'kkkk0002', spawner: false });
    const { game, store, join, ticks, duel } = await setup({ worlds: [backbone, ks] });
    expect(game.startIncident()).toBe(true);
    ticks(1);
    for (const name of ['alice', 'bob']) {
      store.operators.set(name, { id: name, sub: `dev-${name}`, name, starterClaimed: true, subnet: 'kernelspace', bits: 0, diskCapacity: 256, x: ks.subnet.spawn.x, y: ks.subnet.spawn.y, inventory: {} });
    }
    const a = await join('alice');
    const b = await join('bob');
    expect(game.worldOf(a.id)).toBe(ks);
    await duel(a, b);
    expect(ks.operators.size).toBe(0);
    // while they fight, kernelspace fills to the cap
    for (let i = 0; i < INCIDENT_MAX_OPERATORS; i++) ks.addOperator(operatorRecord(`k${i}`, { subnet: 'kernelspace', x: ks.subnet.spawn.x, y: ks.subnet.spawn.y }));
    await a.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    ticks(RETURN + 2);
    for (const id of [a.id, b.id]) {
      expect(game.worldOf(id)).toBe(backbone);
      expect(backbone.operators.get(id)).toMatchObject({ x: backbone.subnet.spawn.x, y: backbone.subnet.spawn.y });
    }
    expect(ks.operators.size).toBe(INCIDENT_MAX_OPERATORS);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'backbone', self: { arena: null } });
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

  describe('results settle through the store', () => {
    /** Polls (real time) until `cond` holds: for stores that keep failing, where `game.flush()` would wait for the cap. */
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
      expect(cond()).toBe(true);
    };
    const later = () => new Promise<void>((r) => setTimeout(r, 10));
    const arenaRows = (store: MemoryStore) => store.ledger.filter((l) => l.reason === 'arena');

    it('a ranked win is credited once in the match world and comes home; checkpoints and resyncs never add to it', async () => {
      const { game, world, store, join, ticks, duel, rankedWin } = await setup({ checkpointEveryTicks: 8 });
      const a = await join('alice');
      const b = await join('bob');
      const arena = await rankedWin(a, b);
      await game.flush();
      ticks(1);
      expect(a.conn.events('arenaResult')).toEqual([expect.objectContaining({ outcome: 'win', counted: true, ratingBefore: 1500, reward: ARENA_WIN_BITS })]);
      expect(b.conn.events('arenaResult')).toEqual([expect.objectContaining({ outcome: 'loss', counted: true, reward: 0 })]);
      expect(a.conn.events('bits')).toEqual([{ e: 'bits', delta: ARENA_WIN_BITS, reason: 'arena', balance: ARENA_WIN_BITS }]);
      expect(arena.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(store.daemons.get('alice-d0')!.arenaWins).toBe(1);
      // a resync reads the arena row, a sim reason: never applied again
      await (game as unknown as { resyncOperators(ids: string[]): Promise<void> }).resyncOperators([a.id]);
      expect(arena.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);

      ticks(RETURN + 1);
      await game.flush();
      expect(world.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect([world.daemons.get('alice-d0')!.arenaWins, world.daemons.get('alice-d1')!.arenaWins, world.daemons.get('bob-d0')!.arenaWins]).toEqual([1, 0, 0]);
      // checkpoints never write arenaWins (nor bits): the store keeps its own count
      world.daemons.get('alice-d0')!.arenaWins = 9;
      ticks(8);
      await game.flush();
      expect(store.daemons.get('alice-d0')!.arenaWins).toBe(1);
      expect(store.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(arenaRows(store)).toHaveLength(1);
      expect(a.conn.events('bits')).toHaveLength(1);

      // the rating cache: the next match starts from the settled ratings
      const season = seasonIdOf(new Date());
      const next = await duel(a, b, 'ranked');
      expect(next.arena!.ratings).toEqual({ [a.id]: store.arenaRatings.get(`${a.id}:${season}`)!.rating, [b.id]: store.arenaRatings.get(`${b.id}:${season}`)!.rating });
      expect(next.arena!.ratings[a.id]).toBeGreaterThan(1600);
      await game.shutdown();
    });

    it('a reply lost after the commit is retried and credited once', async () => {
      const store = new ArenaStore();
      store.loseNextReply = true;
      const { game, world, join, ticks, rankedWin } = await setup({ store, retryDelaysMs: [1, 1, 1] });
      const a = await join('alice');
      const b = await join('bob');
      await rankedWin(a, b);
      await game.flush();
      ticks(RETURN + 1);
      expect(store.calls).toBe(2);
      expect(arenaRows(store)).toHaveLength(1);
      expect(a.conn.events('bits')).toEqual([expect.objectContaining({ delta: ARENA_WIN_BITS, reason: 'arena' })]);
      expect(a.conn.events('arenaResult')).toHaveLength(1);
      expect(world.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(world.daemons.get('alice-d0')!.arenaWins).toBe(1);
      await game.shutdown();
    });

    it('settled after the winner came home and travelled on: credited in the world it is in now', async () => {
      const store = new ArenaStore();
      const home = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
      const other = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
      const { game, join, ticks, rankedWin } = await setup({ store, worlds: [home, other], retryDelaysMs: [1], unknownRetryLimit: 100_000 });
      const a = await join('alice');
      const b = await join('bob');
      store.down = true;
      await rankedWin(a, b);
      ticks(RETURN + 1);
      expect(game.worldOf(a.id)).toBe(home);
      const op = home.operators.get(a.id)!;
      op.x = TEST_SUBNET.gateways[0]!.at.x;
      op.y = TEST_SUBNET.gateways[0]!.at.y;
      await a.cmd({ cmd: 'travel', actor: 'self', args: { gatewayId: 'test-testb' } });
      ticks(1);
      await until(() => game.worldOf(a.id) === other);
      expect(store.arenaMatches.size).toBe(0); // still unknown
      expect(a.conn.events('arenaResult')).toEqual([]);
      store.down = false;
      await game.flush();
      ticks(1);
      expect(other.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(other.daemons.get('alice-d0')!.arenaWins).toBe(1);
      expect(a.conn.events('bits')).toEqual([expect.objectContaining({ delta: ARENA_WIN_BITS, reason: 'arena', balance: ARENA_WIN_BITS })]);
      expect(a.conn.events('arenaResult')).toEqual([expect.objectContaining({ outcome: 'win', counted: true })]);
      await game.shutdown();
      expect(store.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
    });

    it('settled while the winner is gone: its reconnect waits for the result and loads it, never credited twice', async () => {
      const store = new ArenaStore();
      const { game, join, ticks, rankedWin } = await setup({ store, leaveAfterTicks: 4 });
      const a = await join('alice');
      const b = await join('bob');
      store.hold();
      await rankedWin(a, b);
      game.disconnect(a.conn);
      ticks(6);
      expect(game.worldOf(a.id)).toBeUndefined(); // left: the session is gone
      const again = new FakeConn();
      game.connect(again);
      const authing = game.message(again, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
      await later();
      expect(again.of('authOk')).toEqual([]); // mid-load: waits for the pending result
      store.release();
      await authing;
      await game.flush();
      ticks(1);
      const w = game.worldOf(a.id)!;
      expect(w.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS); // loaded, not credited on top
      expect(w.daemons.get('alice-d0')!.arenaWins).toBe(1);
      expect(again.events('bits')).toEqual([]);
      expect(store.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(b.conn.events('arenaResult')).toEqual([expect.objectContaining({ outcome: 'loss', counted: true })]);
      await game.shutdown();
    });

    it('a win without a reward (daily cap) whose reply was lost: the reconnect waits for the retry, arenaWins counted once', async () => {
      const store = new ArenaStore();
      store.loseNextReply = true;
      const { game, join, ticks, rankedWin } = await setup({ store, leaveAfterTicks: 4, retryDelaysMs: [50] });
      const a = await join('alice');
      const b = await join('bob');
      const endedAt = new Date().toISOString();
      for (let i = 0; i < ARENA_DAILY_WINS; i++) {
        const side = { before: 1500, after: 1500, reward: 0, arenaWins: [] };
        store.arenaMatches.set(`m${i}`, {
          input: { matchId: `m${i}`, mode: 'ranked', aId: a.id, bId: `x${i}`, winnerId: a.id, reason: 'forfeit', durationMs: 0, endedAt, dealt: {} },
          settlement: { counted: true, a: { ...side, reward: ARENA_WIN_BITS }, b: side },
        });
      }
      await rankedWin(a, b);
      // the first attempt commits and loses its reply; while the retry waits, the write chain is free
      game.disconnect(a.conn);
      ticks(6);
      expect(game.worldOf(a.id)).toBeUndefined();
      const again = new FakeConn();
      game.connect(again);
      const authing = game.message(again, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
      await later();
      expect(again.of('authOk')).toEqual([]);
      await authing;
      await game.flush();
      ticks(1);
      expect(store.calls).toBe(2);
      expect(store.daemons.get('alice-d0')!.arenaWins).toBe(1);
      expect(game.worldOf(a.id)!.daemons.get('alice-d0')!.arenaWins).toBe(1);
      expect(game.worldOf(a.id)!.operators.get(a.id)!.bits).toBe(0);
      expect(b.conn.events('arenaResult')).toEqual([expect.objectContaining({ outcome: 'loss', counted: true })]);
      await game.shutdown();
    });

    it('the exactly-once rule: a payout the loaded state holds is skipped; one without a session is parked for a load that predates it', async () => {
      const store = new MemoryStore();
      store.operators.set('zed', { id: 'zed', sub: 'dev-zed', name: 'zed', starterClaimed: true, subnet: 'test', bits: 5, diskCapacity: 256, x: 5.5, y: 5.5, inventory: {} });
      store.daemons.set('zed-p0', { ...ownedRecord('pingling', 20, 2, 'zed-p0'), operatorId: 'zed', location: 'RAM' });
      const { game, world, connect } = await setup({ store });
      const credit = (id: string, r: ArenaSideResult) => (game as unknown as { creditArena(id: string, r: ArenaSideResult): void }).creditArena(id, r);
      const paid = (ledgerSeq: number): ArenaSideResult => ({ before: 1500, after: 1600, reward: ARENA_WIN_BITS, arenaWins: ['zed-p0'], ledgerSeq });
      // no session: parked; the session created next loaded nothing above seq 0, so it takes it, once
      credit('zed', paid(7));
      await connect('zed');
      expect(world.operators.get('zed')!.bits).toBe(5 + ARENA_WIN_BITS);
      expect(world.daemons.get('zed-p0')!.arenaWins).toBe(1);
      // a session whose load already holds the row (seq at or below its watermark) is left alone
      credit('zed', paid(0));
      expect(world.operators.get('zed')!.bits).toBe(5 + ARENA_WIN_BITS);
      expect(world.daemons.get('zed-p0')!.arenaWins).toBe(1);
      await game.shutdown();
    });

    it('a lost reply followed by an outage past the cap: both operators reload from the store, which holds the committed result', async () => {
      const store = new ArenaStore();
      store.loseNextReply = true;
      store.downAfterLoss = true;
      const { game, join, connect, ticks, rankedWin } = await setup({ store, retryDelaysMs: [1, 1], unknownRetryLimit: 3 });
      const a = await join('alice');
      const b = await join('bob');
      await rankedWin(a, b);
      await game.flush();
      expect(store.calls).toBe(3);
      // memory never saw the committed result: both are kicked and must reload
      for (const o of [a, b]) expect(o.conn.of('kick').at(-1)!.d.reason).toBe(RELOAD_KICK);
      expect(a.conn.events('bits')).toEqual([]);
      ticks(1);
      await game.flush();
      expect(game.worldOf(a.id)).toBeUndefined();
      expect(game.worldOf(b.id)).toBeUndefined();
      store.down = false;
      const settled = [...store.arenaMatches.values()][0]!.settlement;
      expect(settled.counted).toBe(true);
      const again = await connect('alice');
      const bob = await connect('bob');
      await game.flush();
      expect(again.of('authOk')).toHaveLength(1);
      expect(bob.of('authOk')).toHaveLength(1);
      const w = game.worldOf(a.id)!;
      expect(w.subnet.id).toBe('test');
      expect(w.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(w.daemons.get('alice-d0')!.arenaWins).toBe(1);
      const sessions = (game as unknown as { sessions: Map<string, { arenaRating: number | null }> }).sessions;
      expect(sessions.get(a.id)!.arenaRating).toBe(settled.a.after);
      expect(sessions.get(b.id)!.arenaRating).toBe(settled.b.after);
      await game.shutdown();
    });

    it('a definitive store error stops at once and, with no earlier unknown attempt, reloads nobody', async () => {
      const store = new ArenaStore();
      store.failWith = Object.assign(new Error('foreign key'), { name: 'PrismaClientKnownRequestError', code: 'P2003' });
      const { game, join, ticks, rankedWin } = await setup({ store, retryDelaysMs: [1, 1] });
      const a = await join('alice');
      const b = await join('bob');
      await rankedWin(a, b);
      await game.flush();
      ticks(1);
      expect(store.calls).toBe(1);
      expect(a.conn.of('kick')).toEqual([]);
      expect(a.conn.events('arenaResult')).toEqual([expect.objectContaining({ counted: false, reward: 0 })]);
      await game.shutdown();
    });

    it('a ranked challenge refreshes both ratings, and only when the command succeeded', async () => {
      const store = new MemoryStore();
      const season = seasonIdOf(new Date());
      const rate = (id: string, rating: number) => store.arenaRatings.set(`${id}:${season}`, { rating, rd: 80, vol: 0.06, wins: 0, losses: 0, draws: 0 });
      for (const name of ['ann', 'ben']) {
        store.operators.set(name, { id: name, sub: `dev-${name}`, name, starterClaimed: true, subnet: 'test', bits: 0, diskCapacity: 256, x: 5.5, y: 5.5, inventory: {} });
        rate(name, 1500);
      }
      const reads: string[] = [];
      const read = store.arenaRating.bind(store);
      store.arenaRating = async (id, at) => {
        reads.push(id);
        return read(id, at);
      };
      const { game, join } = await setup({ store });
      const ann = await join('ann');
      const ben = await join('ben');
      await game.flush();
      reads.length = 0;
      await ann.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: 'ann', mode: 'ranked' } }); // refused
      await ann.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
      await ann.cmd({ cmd: 'arenaLeave', actor: 'self', args: {} });
      expect(reads).toEqual([]);
      rate('ann', 1620);
      rate('ben', 1580);
      await ann.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: 'ben', mode: 'ranked' } });
      expect(reads.sort()).toEqual(['ann', 'ben']);
      await game.flush();
      await ben.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: ben.conn.of('arenaChallenge').at(-1)!.d.challengeId } });
      expect(game.worldOf('ann')!.arena!.ratings).toEqual({ ann: 1620, ben: 1580 });
      await game.shutdown();
    });

    it('a winner whose controller is gone but whose session remains is credited in memory', async () => {
      const store = new ArenaStore();
      const { game, world, join, ticks, rankedWin } = await setup({ store, leaveAfterTicks: 1000 });
      const a = await join('alice');
      const b = await join('bob');
      store.hold();
      await rankedWin(a, b);
      game.disconnect(a.conn);
      ticks(RETURN + 1);
      expect(game.worldOf(a.id)).toBe(world);
      store.release();
      await game.flush();
      expect(world.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
      expect(world.daemons.get('alice-d0')!.arenaWins).toBe(1);
      await game.shutdown();
    });

    it('shutdown waits for a pending result before the store closes', async () => {
      const store = new ArenaStore();
      const { game, join, rankedWin } = await setup({ store });
      const a = await join('alice');
      const b = await join('bob');
      store.hold();
      await rankedWin(a, b);
      const closed: string[] = [];
      const done = gracefulShutdown({
        server: { stopAccepting: () => {}, close: async () => {} },
        game,
        store: { close: async () => void closed.push('store') },
        bus: { close: async () => {} },
      });
      await later();
      expect(closed).toEqual([]);
      expect(store.arenaMatches.size).toBe(0);
      store.release();
      await done;
      expect(closed).toEqual(['store']);
      expect(store.arenaMatches.size).toBe(1);
      expect(store.operators.get(a.id)!.bits).toBe(ARENA_WIN_BITS);
    });

    it('a store unreachable past the retry cap: logged loudly, nothing credited or invented, both reload', async () => {
      const store = new ArenaStore();
      store.down = true;
      const errors: string[] = [];
      const log: Logger = { info() {}, warn() {}, error: (_o, msg) => void errors.push(msg ?? '') };
      const { game, world, join, ticks, rankedWin } = await setup({ store, retryDelaysMs: [1, 1], unknownRetryLimit: 4, log });
      const a = await join('alice');
      const b = await join('bob');
      const announced: GameEvent[] = [];
      const emit = world.emitCarry.bind(world);
      const arena = await rankedWin(a, b);
      arena.emitCarry = (event, scope) => (announced.push(event), emit.call(arena, event, scope));
      await game.flush();
      expect(store.calls).toBe(4);
      expect(errors).toContain('arena result still unknown after the retry cap: left to the store');
      // announced uncounted, nothing credited; both reload from the store (an attempt may have committed)
      expect(announced.filter((e) => e.e === 'arenaResult')).toEqual([expect.objectContaining({ outcome: 'win', counted: false, reward: 0 }), expect.objectContaining({ outcome: 'loss', counted: false })]);
      expect(announced.filter((e) => e.e === 'bits')).toEqual([]);
      for (const o of [a, b]) expect(o.conn.of('kick').at(-1)!.d.reason).toBe(RELOAD_KICK);
      ticks(1);
      await game.flush();
      expect(game.worldOf(a.id)).toBeUndefined(); // gone home and left, nothing invented
      expect(store.operators.get(a.id)!.bits).toBe(0);
      expect(store.daemons.get('alice-d0')!.arenaWins).toBe(0);
      await game.shutdown();
    });

    it('the rating cache is loaded with the session, refreshed on queueing, and feeds the matchmaking windows', async () => {
      const store = new MemoryStore();
      const season = seasonIdOf(new Date());
      const rate = (id: string, rating: number) => store.arenaRatings.set(`${id}:${season}`, { rating, rd: 80, vol: 0.06, wins: 0, losses: 0, draws: 0 });
      const names = ['ann', 'ben', 'cat', 'dan', 'eve'];
      for (const name of names) {
        store.operators.set(name, { id: name, sub: `dev-${name}`, name, starterClaimed: true, subnet: 'test', bits: 0, diskCapacity: 256, x: 5.5, y: 5.5, inventory: {} });
      }
      rate('ann', 1400);
      rate('ben', 1700);
      rate('cat', 1460);
      rate('dan', 1900);
      rate('eve', 2400);
      const { game, join, ticks } = await setup({ store });
      const ops = [];
      for (const name of names) ops.push(await join(name));
      await game.flush();
      const [ann, ben, cat, dan, eve] = ops as [(typeof ops)[0], (typeof ops)[0], (typeof ops)[0], (typeof ops)[0], (typeof ops)[0]];
      for (const o of [ann, ben, cat]) await o.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'ranked' } });
      await game.flush();
      ticks(17);
      expect(game.worldOf(ann.id)!.arena).toMatchObject({ mode: 'ranked', ratings: { ann: 1400, cat: 1460 } }); // 60 apart
      expect(game.worldOf(ben.id)!.arena).toBeNull(); // 240 from both
      // dan's rating changed in the store since his session loaded: queueing reads it again
      rate('dan', 2360);
      for (const o of [dan, eve]) await o.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'ranked' } });
      await game.flush();
      ticks(16);
      expect(game.worldOf(dan.id)!.arena).toMatchObject({ ratings: { dan: 2360, eve: 2400 } });
      await game.shutdown();
    });
  });
});

/** MemoryStore whose arena results can be held, fail, or lose their reply after committing. */
class ArenaStore extends MemoryStore {
  calls = 0;
  down = false;
  loseNextReply = false;
  /** The store goes down right after the lost reply. */
  downAfterLoss = false;
  /** Thrown by every attempt while set. */
  failWith: Error | null = null;
  private gate: { promise: Promise<void>; open: () => void } | null = null;
  hold() {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    this.gate = { promise, open };
  }
  release() {
    this.gate?.open();
    this.gate = null;
  }
  override async recordArenaResult(input: ArenaResultInput): Promise<ArenaSettlement> {
    this.calls++;
    if (this.gate) await this.gate.promise;
    if (this.failWith) throw this.failWith;
    if (this.down) throw new Error('store unreachable');
    const settlement = await super.recordArenaResult(input);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      if (this.downAfterLoss) this.down = true;
      throw new Error('connection reset');
    }
    return settlement;
  }
}
