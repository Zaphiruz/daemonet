import { MemoryBus, type Bus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { ChatService, type ChatHost } from '../src/runtime/chat.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B } from './helpers.js';

/** A chat host over a hand-built roster (no worlds), with a controllable clock. */
function harness(opts: { bus?: Bus } = {}) {
  const roster = new Map<string, { name: string; subnet: string; org?: { id: string; tag: string }; cluster?: { id: string; members: string[] } }>();
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  const logs: Array<{ obj: object; msg?: string }> = [];
  let now = Date.parse(FIXED_CLOCK);
  const host: ChatHost = {
    operator: (id) => {
      const r = roster.get(id);
      return r ? { op: { id, name: r.name } as never, subnet: r.subnet } : undefined;
    },
    operatorIds: () => roster.keys(),
    send: (to, msg) => sent.push({ to, msg }),
    clusterOf: (id) => roster.get(id)?.cluster,
    orgOf: (id) => roster.get(id)?.org,
    now: () => now,
  };
  const store = new MemoryStore();
  const bus = opts.bus ?? new MemoryBus();
  const chat = new ChatService(host, store, bus, { warn: (obj, msg) => logs.push({ obj, msg }) });
  return {
    roster, sent, store, bus, chat, logs,
    tick: (ms: number) => (now += ms),
    lines: (to: string) => sent.filter((s) => s.to === to && s.msg.t === 'chat').map((s) => (s.msg as Extract<ServerMessage, { t: 'chat' }>).d),
  };
}

describe('ChatService', () => {
  it('delivers subnet chat to everyone in that subnet, stores it, publishes it, and acks', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lo' });
    h.roster.set('c', { name: 'carol', subnet: 'lan' });
    expect(await h.chat.post('a', 'subnet:lo', '  hello   there ')).toBeNull();
    expect(h.lines('a')).toMatchObject([{ channel: 'subnet:lo', from: 'a', name: 'alice', tag: null, text: 'hello there' }]);
    expect(h.lines('b')).toHaveLength(1);
    expect(h.lines('c')).toHaveLength(0);
    expect(h.store.chat).toMatchObject([{ channel: 'subnet:lo', operatorId: 'a', toId: null, text: 'hello there' }]);
    expect((h.bus as MemoryBus).log).toMatchObject([{ channel: 'chat', message: { channel: 'subnet:lo', text: 'hello there' } }]);
  });

  it('guards: empty, wrong subnet, unknown channel, rate limit, DMs to blockers, cluster and org membership', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo', org: { id: 'o1', tag: 'ROOT' } });
    h.roster.set('b', { name: 'bob', subnet: 'lan', org: { id: 'o1', tag: 'ROOT' }, cluster: { id: 'c1', members: ['b', 'd'] } });
    h.roster.set('d', { name: 'dan', subnet: 'lan', cluster: { id: 'c1', members: ['b', 'd'] } });
    expect(await h.chat.post('a', 'subnet:lo', '\u0007')).toMatchObject({ code: 'E_INVALID' });
    expect(await h.chat.post('a', 'subnet:lan', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'nope', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'cluster:c1', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'org:o1', 'org hi')).toBeNull();
    expect(h.lines('b').map((l) => l.text)).toEqual(['org hi']);
    expect(h.lines('b')[0]!.tag).toBe('ROOT');
    expect(h.lines('d')).toHaveLength(0);
    expect(await h.chat.post('a', 'org:o1', 'too fast')).toMatchObject({ code: 'E_RATE' });
    h.tick(2000);
    expect(await h.chat.post('b', 'cluster:c1', 'cluster hi')).toBeNull();
    expect(h.lines('d').map((l) => l.text)).toEqual(['cluster hi']);
    h.store.blocks.add('d:a');
    h.tick(2000);
    expect(await h.chat.post('a', 'dm:d', 'psst')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'dm:b', 'psst')).toBeNull();
    // spec §5: each side files the DM under the other party's id
    expect(h.lines('b').at(-1)).toMatchObject({ channel: 'dm:a', from: 'a', text: 'psst' });
    expect(h.lines('a').at(-1)).toMatchObject({ channel: 'dm:b', text: 'psst' });
    expect(h.store.chat.at(-1)).toMatchObject({ channel: 'dm:b', toId: 'b' });
    h.tick(2000);
    expect(await h.chat.post('a', 'dm:a', 'me')).toMatchObject({ code: 'E_STATE' });
  });

  it('filters: masks, blocks with a recorded hit, auto-mutes after three blocks, and honours admin mutes / deletes / terms from the bus', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    expect(await h.chat.post('a', 'subnet:lo', 'what the fuck')).toBeNull();
    expect(h.lines('a')[0]!.text).toBe('what the ***');
    for (let i = 0; i < 3; i++) {
      h.tick(2000);
      expect(await h.chat.post('a', 'subnet:lo', 'kys')).toMatchObject({ code: 'E_INVALID', message: 'message blocked by the chat filter' });
    }
    expect(h.store.filterHits).toHaveLength(3);
    expect(h.chat.isMuted('a')).toBe(true);
    expect(h.store.mutes.get('a')).toMatch(/^2026-09-30T00:10/);
    expect(h.sent.filter((s) => s.msg.t === 'muted')).toHaveLength(1);
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'hello?')).toMatchObject({ code: 'E_STATE' });
    h.tick(11 * 60_000);
    expect(h.chat.isMuted('a')).toBe(false);
    expect(await h.chat.post('a', 'subnet:lo', 'hello?')).toBeNull();
    // admin actions arrive on the bus
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: new Date(Date.parse(FIXED_CLOCK) + 3_600_000 * 24).toISOString() });
    expect(h.chat.isMuted('a')).toBe(true);
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: null });
    expect(h.chat.isMuted('a')).toBe(false);
    await h.bus.publish('admin', { kind: 'delete', id: 'm1', channel: 'subnet:lo' });
    expect(h.sent.at(-1)!.msg).toMatchObject({ t: 'chatDeleted', d: { id: 'm1' } });
    await h.bus.publish('admin', { kind: 'filter', terms: [{ pattern: 'banana', kind: 'WORD', action: 'BLOCK' }] });
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'BANANA time')).toMatchObject({ code: 'E_INVALID' });
    h.chat.close();
  });

  it('loads mutes from the record and reports a store outage instead of delivering', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.chat.loadMute('a', new Date(Date.parse(FIXED_CLOCK) + 60_000).toISOString());
    expect(h.chat.isMuted('a')).toBe(true);
    h.chat.loadMute('a', null);
    h.store.appendChat = async () => {
      throw new Error('db down');
    };
    expect(await h.chat.post('a', 'subnet:lo', 'hi')).toMatchObject({ code: 'E_STATE', message: 'chat is unavailable right now' });
    expect(h.lines('a')).toHaveLength(0);
  });

  it('announces its own auto-mute on the bus once, and the echo changes nothing', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    for (let i = 0; i < 3; i++) {
      h.tick(2000);
      await h.chat.post('a', 'subnet:lo', 'free bits here');
    }
    await new Promise((r) => setTimeout(r, 0));
    expect((h.bus as MemoryBus).log.filter((l) => l.channel === 'admin')).toMatchObject([{ message: { kind: 'mute', operatorId: 'a', reason: 'filter' } }]);
    expect(h.sent.filter((s) => s.msg.t === 'muted')).toHaveLength(1);
    expect(h.chat.isMuted('a')).toBe(true);
  });

  it('keeps an unconfirmed mute when a stale record is loaded (mute evasion by reconnecting)', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.store.setMute = async () => {
      throw new Error('db down');
    };
    await h.chat.mute('a', new Date(Date.parse(FIXED_CLOCK) + 600_000).toISOString(), 'filter');
    h.chat.loadMute('a', null); // the operator left and reconnected: its record predates the mute
    expect(h.chat.isMuted('a')).toBe(true);
    // an admin decision from the api supersedes it
    await h.bus.publish('admin', { kind: 'unmute', operatorId: 'a' });
    expect(h.chat.isMuted('a')).toBe(false);
    h.chat.loadMute('a', new Date(Date.parse(FIXED_CLOCK) + 60_000).toISOString());
    expect(h.chat.isMuted('a')).toBe(true);
  });

  it('DMs: unknown operators are refused, offline ones are stored for history, and guard lookups are rate limited', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('c', { name: 'carol', subnet: 'lo' });
    const offline = await h.store.loadOrCreateOperator('dev-zed', 'lo', { x: 0, y: 0 });
    expect(await h.chat.post('a', 'dm:ghost', 'hello?')).toMatchObject({ code: 'E_STATE', message: 'unknown operator' });
    expect(await h.chat.post('a', `dm:${offline.id}`, 'see you later')).toBeNull();
    expect(h.store.chat).toMatchObject([{ channel: `dm:${offline.id}`, operatorId: 'a', toId: offline.id, text: 'see you later' }]);
    expect(h.sent.map((s) => s.to)).toEqual(['a', offline.id]);
    expect(h.lines('c')).toHaveLength(0);
    // refused DMs do not use the 2-second slot, but each costs store lookups: at most 4 per 2 seconds
    h.tick(2000);
    for (let i = 0; i < 4; i++) expect(await h.chat.post('a', `dm:ghost${i}`, 'x')).toMatchObject({ message: 'unknown operator' });
    expect(await h.chat.post('a', 'dm:ghost9', 'x')).toMatchObject({ code: 'E_RATE' });
    h.tick(2000);
    expect(await h.chat.post('a', 'dm:c', 'now?')).toBeNull();
  });

  it('DM replies to line.channel reach the other party, filed under the other id on both sides', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lan' });
    expect(await h.chat.post('a', 'dm:b', 'ping')).toBeNull();
    const got = h.lines('b').at(-1)!;
    expect(got.channel).toBe('dm:a');
    expect(await h.chat.post('b', got.channel, 'pong')).toBeNull();
    expect(h.lines('a').map((l) => [l.channel, l.from, l.text])).toEqual([
      ['dm:b', 'a', 'ping'],
      ['dm:b', 'b', 'pong'],
    ]);
    expect(h.lines('b').map((l) => [l.channel, l.from, l.text])).toEqual([
      ['dm:a', 'a', 'ping'],
      ['dm:a', 'b', 'pong'],
    ]);
    expect(h.store.chat.map((c) => [c.channel, c.operatorId, c.toId])).toEqual([
      ['dm:b', 'a', 'b'],
      ['dm:a', 'b', 'a'],
    ]);
  });

  it('an admin mute that arrives while an auto-mute is being written wins in memory and in the store', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const writes: Array<string | null> = [];
    let first = true;
    h.store.setMute = async (id, until) => {
      if (first) {
        first = false;
        await gate;
      }
      writes.push(until);
      h.store.mutes.set(id, until);
    };
    const auto = h.chat.mute('a', new Date(Date.parse(FIXED_CLOCK) + 600_000).toISOString(), 'filter');
    const admin = new Date(Date.parse(FIXED_CLOCK) + 86_400_000).toISOString();
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: admin, reason: 'admin' });
    open();
    await auto;
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toEqual([new Date(Date.parse(FIXED_CLOCK) + 600_000).toISOString(), admin]);
    expect(h.store.mutes.get('a')).toBe(admin);
    expect(h.sent.filter((x) => x.msg.t === 'muted').map((x) => (x.msg as Extract<ServerMessage, { t: 'muted' }>).d.until)).toEqual([admin]);
    expect((h.bus as MemoryBus).log.filter((l) => l.channel === 'admin')).toHaveLength(1);
    h.tick(3_600_000);
    expect(h.chat.isMuted('a')).toBe(true);
  });

  it('drops an unconfirmed mute once it has expired, so the record applies again', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.store.setMute = async () => {
      throw new Error('db down');
    };
    await h.chat.mute('a', new Date(Date.parse(FIXED_CLOCK) + 600_000).toISOString(), 'filter');
    h.tick(11 * 60_000);
    h.chat.loadMute('a', new Date(Date.parse(FIXED_CLOCK) + 3_600_000).toISOString());
    expect(h.chat.isMuted('a')).toBe(true);
  });

  it('re-checks the mute after the guards awaited the store', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lo' });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.store.isBlocked = async () => {
      await gate;
      return false;
    };
    const post = h.chat.post('a', 'dm:b', 'sneaky');
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: new Date(Date.parse(FIXED_CLOCK) + 60_000).toISOString() });
    open();
    expect(await post).toMatchObject({ code: 'E_STATE', message: expect.stringMatching(/^muted until/) });
    expect(h.store.chat).toHaveLength(0);
    expect(h.lines('b')).toHaveLength(0);
  });

  it('allows one line in flight per operator (concurrent commands cannot both pass the 2-second limit)', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lo' });
    const [x, y] = await Promise.all([h.chat.post('a', 'dm:b', 'one'), h.chat.post('a', 'dm:b', 'two')]);
    expect([x, y]).toEqual([null, { code: 'E_RATE', message: 'one message every 2 seconds' }]);
    expect(h.store.chat).toHaveLength(1);
  });

  it('runs the filter before the store and the bus: blocked text is neither stored nor published, masked text only masked', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    await h.chat.post('a', 'subnet:lo', 'join discord.gg/x');
    h.tick(2000);
    await h.chat.post('a', 'subnet:lo', 'oh sh1t');
    expect(h.store.chat.map((c) => c.text)).toEqual(['oh ***']);
    expect((h.bus as MemoryBus).log.map((l) => (l.message as { text: string }).text)).toEqual(['oh ***']);
    expect(h.lines('a').map((l) => l.text)).toEqual(['oh ***']);
  });

  it('validates admin messages from the bus and ignores forged or unknown shapes', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    const forged: unknown[] = [
      null,
      'mute',
      42,
      { kind: 'mute', operatorId: 'a', until: 'tomorrow' },
      { kind: 'mute', operatorId: 7, until: null },
      { kind: 'mute', operatorId: 'a' },
      { kind: 'delete', id: 'm1' },
      { kind: 'delete', id: 'm1', channel: 'x'.repeat(500) },
      { kind: 'filter', terms: 'kys' },
      { kind: 'filter', terms: [{ pattern: 'hello', kind: 'EVAL', action: 'BLOCK' }] },
      { kind: 'mute', operatorId: 'a', until: null, origin: 'elsewhere' },
      { kind: 'incident:start' },
      { kind: { toString: 'mute' } },
    ];
    for (const m of forged) await h.bus.publish('admin', m);
    expect(h.chat.isMuted('a')).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(await h.chat.post('a', 'subnet:lo', 'hello')).toBeNull();
    // only well-known kinds are reported, by kind
    expect(h.logs.map((l) => l.msg)).toEqual(Array(8).fill('dropped a malformed admin message'));
  });

  it('never logs chat text, and a bus outage does not fail a line', async () => {
    const failing: Bus = {
      publish: async () => {
        throw new Error('redis down');
      },
      subscribe: () => () => {},
      close: async () => {},
    };
    const h = harness({ bus: failing });
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    expect(await h.chat.post('a', 'subnet:lo', 'secret plans one')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    h.store.appendChat = async (row) => {
      throw Object.assign(new Error(`insert failed for "${row.text}"`), { code: 'P2010' });
    };
    h.store.recordFilterHit = async (hit) => {
      throw new Error(`insert failed for "${hit.text}"`);
    };
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'secret plans two')).toMatchObject({ message: 'chat is unavailable right now' });
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'secret kys three')).toMatchObject({ code: 'E_INVALID' });
    expect(h.logs.map((l) => l.msg)).toEqual(['bus publish failed', 'chat line not stored', 'filter hit not recorded']);
    expect(JSON.stringify(h.logs)).not.toMatch(/secret|insert failed/);
  });

  it('sends a deletion only to the line’s parties / the subnet’s current occupants, each under their own channel name', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lo' });
    h.roster.set('c', { name: 'carol', subnet: 'lan' });
    await h.chat.post('a', 'dm:b', 'psst');
    const id = h.lines('b')[0]!.id;
    h.sent.length = 0;
    await h.bus.publish('admin', { kind: 'delete', id, channel: 'dm:b' });
    expect(h.sent.map((s) => [s.to, (s.msg as Extract<ServerMessage, { t: 'chatDeleted' }>).d.channel]).sort()).toEqual([
      ['a', 'dm:b'],
      ['b', 'dm:a'],
    ]);
    h.sent.length = 0;
    await h.bus.publish('admin', { kind: 'delete', id: 'old', channel: 'subnet:lo' });
    expect(h.sent.map((s) => s.to).sort()).toEqual(['a', 'b']);
  });
});

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

function setupGame(store = new MemoryStore(), bus = new MemoryBus()) {
  const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false });
  const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
  const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus, leaveAfterTicks: 4 });
  const join = async (name: string, role?: 'spectator') => {
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...(role ? { role } : {}) } }));
    return conn;
  };
  let n = 0;
  const say = async (conn: FakeConn, channel: string, text: string) => {
    const reqId = `c${++n}`;
    await game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId, cmd: 'chat', actor: 'self', args: { channel, text } } }));
    await game.flush();
    return conn.sent.filter((m) => (m.t === 'ack' || m.t === 'err') && m.d.reqId === reqId).at(-1)!;
  };
  return { a, b, game, store, bus, join, say };
}

describe('chat through the Game', () => {
  it('routes the chat command outside the tick budget and delivers to the sender’s subnet only', async () => {
    const store = new MemoryStore();
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false });
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
    const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus() });
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      return conn;
    };
    const alice = await join('alice');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join('bob');
    const spectator = new FakeConn();
    game.connect(spectator);
    await game.message(spectator, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice', role: 'spectator' } }));
    await game.message(alice, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c1', cmd: 'chat', actor: 'self', args: { channel: 'subnet:test', text: 'anyone here?' } } }));
    await game.flush();
    expect(alice.of('ack').map((m) => m.d.reqId)).toEqual(['c1']);
    expect(alice.of('chat').map((m) => m.d.text)).toEqual(['anyone here?']);
    expect(spectator.of('chat')).toHaveLength(1);
    expect(bob.of('chat')).toHaveLength(0);
    await game.message(bob, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c2', cmd: 'chat', actor: 'self', args: { channel: 'subnet:test', text: 'wrong subnet' } } }));
    await game.flush();
    expect(bob.of('err').at(-1)!.d).toMatchObject({ reqId: 'c2', code: 'E_STATE' });
    await game.shutdown();
  });

  it('does not use the per-tick command budget, and spectators cannot post', async () => {
    const g = setupGame();
    const alice = await g.join('alice');
    const watcher = await g.join('alice', 'spectator');
    for (let i = 0; i < 8; i++) {
      await g.game.message(alice, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: `s${i}`, cmd: 'stop', actor: 'self', args: {} } }));
    }
    expect(await g.say(alice, 'subnet:test', 'still allowed')).toMatchObject({ t: 'ack' });
    expect(await g.say(watcher, 'subnet:test', 'me too')).toMatchObject({ t: 'err', d: { code: 'E_STATE', message: 'spectators cannot send commands' } });
    await g.game.shutdown();
  });

  it('limits chat per operator across connections, and the reply goes to the connection that asked', async () => {
    const g = setupGame();
    const first = await g.join('alice');
    expect(await g.say(first, 'subnet:test', 'one')).toMatchObject({ t: 'ack' });
    const second = await g.join('alice'); // takeover: a fresh connection, same operator
    expect(await g.say(second, 'subnet:test', 'two')).toMatchObject({ t: 'err', d: { code: 'E_RATE' } });
    expect(first.of('err')).toHaveLength(0);
    await g.game.shutdown();
  });

  it('enforces a mute on every connection, across a takeover and across leave and rejoin', async () => {
    const g = setupGame();
    const alice = await g.join('alice');
    const watcher = await g.join('alice', 'spectator');
    const id = alice.of('authOk')[0]!.d.operatorId;
    const until = new Date(Date.now() + 3_600_000).toISOString();
    // the api writes the row, then announces it
    g.store.mutes.set(id, until);
    await g.bus.publish('admin', { kind: 'mute', operatorId: id, until });
    expect(alice.of('muted').map((m) => m.d.until)).toEqual([until]);
    expect(watcher.of('muted')).toHaveLength(1);
    expect(await g.say(alice, 'subnet:test', 'hi')).toMatchObject({ t: 'err', d: { code: 'E_STATE', message: `muted until ${until}` } });
    const again = await g.join('alice');
    expect(await g.say(again, 'subnet:test', 'hi')).toMatchObject({ t: 'err', d: { code: 'E_STATE' } });
    // leave (no controller for leaveAfterTicks), then a fresh session loads the mute from the record
    g.game.disconnect(again);
    for (let i = 0; i < 8; i++) g.game.tick();
    await g.game.flush();
    expect(g.game.worldOf(id)).toBeUndefined();
    g.game.chat.loadMute(id, null); // forget the live value: only the record can mute the next session
    const back = await g.join('alice');
    expect(await g.say(back, 'subnet:test', 'hi')).toMatchObject({ t: 'err', d: { code: 'E_STATE', message: `muted until ${until}` } });
    await g.game.shutdown();
  });

  it('loads admin filter terms from the store', async () => {
    const g = setupGame();
    g.store.filterTerms.push({ pattern: 'pineapple', kind: 'WORD', action: 'MASK' });
    await g.game.loadChatTerms();
    const alice = await g.join('alice');
    expect(await g.say(alice, 'subnet:test', 'I like pineapple')).toMatchObject({ t: 'ack' });
    expect(alice.of('chat').at(-1)!.d.text).toBe('I like ***');
    await g.game.shutdown();
  });

  it('stops listening to the bus on shutdown', async () => {
    const g = setupGame();
    const alice = await g.join('alice');
    const id = alice.of('authOk')[0]!.d.operatorId;
    await g.game.shutdown();
    await g.bus.publish('admin', { kind: 'mute', operatorId: id, until: new Date(Date.now() + 60_000).toISOString() });
    expect(g.game.chat.isMuted(id)).toBe(false);
  });
});
