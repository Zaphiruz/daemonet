import { ticketBoard } from '@daemonet/rules';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameClient } from '../src/client.js';
import { connect, type TokenSource } from '../src/index.js';

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  serverSend(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const Ws = FakeWs as unknown as new (url: string) => never;
const auth: TokenSource = { getToken: async () => 'dev:x' };
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const last = () => FakeWs.instances[FakeWs.instances.length - 1]!;

const self = {
  id: 'op1', name: 'x', starterClaimed: true, x: 0, y: 0, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null, arena: null, org: null, cluster: null,
};
function snapshot(ws: FakeWs): void {
  ws.serverSend({ t: 'authOk', seq: 1, d: { operatorId: 'op1', role: 'controller', resumeToken: 'r', tick: 1 } });
  ws.serverSend({ t: 'snapshot', seq: 2, d: { tick: 1, subnet: 's1', self, entities: [] } });
}

describe('connect failure handling', () => {
  it('rejects when the first socket closes before a snapshot', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    const assertion = expect(p).rejects.toThrow();
    await tick();
    last().close(1006, 'gone');
    await assertion;
    await sleep(400);
    expect(FakeWs.instances.length).toBe(1);
  });

  it('rejects on an unavailable kick before a snapshot', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    const assertion = expect(p).rejects.toMatchObject({ code: 'E_STATE', message: expect.stringContaining('unavailable') });
    await tick();
    last().serverSend({ t: 'kick', seq: 0, d: { reason: 'unavailable' } });
    last().close(4003, 'unavailable');
    await assertion;
    await sleep(400);
    expect(FakeWs.instances.length).toBe(1);
  });
});

describe('reconnect policy', () => {
  async function connected() {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    snapshot(last());
    return p;
  }

  it('reconnects after an idle kick but not after a takeover', async () => {
    let client = await connected();
    last().serverSend({ t: 'kick', seq: 0, d: { reason: 'idle' } });
    last().close(4001, 'idle');
    await sleep(400);
    expect(FakeWs.instances.length).toBe(2);
    client.close();

    client = await connected();
    last().serverSend({ t: 'kick', seq: 0, d: { reason: 'takeover' } });
    last().close(4002, 'takeover');
    await sleep(400);
    expect(FakeWs.instances.length).toBe(1);
    client.close();
  });

  it('emits error and retries when the token fails during a reconnect', async () => {
    let fail = false;
    const flaky: TokenSource = {
      getToken: async () => {
        if (fail) throw new Error('refresh failed');
        return 'dev:x';
      },
    };
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth: flaky, WebSocket: Ws });
    await tick();
    snapshot(last());
    const client = await p;
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    fail = true;
    last().close(1006, 'net');
    await sleep(300);
    expect(errors.length).toBe(1);
    fail = false;
    await sleep(700);
    expect(FakeWs.instances.length).toBe(2);
    client.close();
  });
});

describe('host-page hooks', () => {
  it('exposes role and subnet, emits raw frames and sends raw frames', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    snapshot(last());
    const client = await p;
    expect(client.role).toBe('controller');
    expect(client.subnet).toBe('s1');

    const frames: string[] = [];
    client.on('frame', (f) => frames.push(f));
    last().serverSend({ t: 'kick', seq: 9, d: { reason: 'takeover' } });
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0]!).t).toBe('kick');

    const raw = JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: 'r1', kind: 'noop' } });
    client.sendFrame(raw);
    expect(last().sent.some((s) => JSON.parse(s).d?.reqId === 'r1')).toBe(true);
    client.close();
  });
});

describe('serverDay', () => {
  it('follows the server day from the snapshot and deltas, not the local clock', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    const ws = last();
    ws.serverSend({ t: 'authOk', seq: 1, d: { operatorId: 'op1', role: 'controller', resumeToken: 'r', tick: 1 } });
    ws.serverSend({ t: 'snapshot', seq: 2, d: { tick: 1, subnet: 'lo', self: { ...self, ticketsDay: '2031-01-02' }, entities: [] } });
    const client = await p;
    expect(client.serverDay).toBe('2031-01-02');
    expect(client.world.tickets).toEqual(ticketBoard('lo', '2031-01-02'));
    void client.operator.acceptTicket(0).catch(() => {});
    expect(JSON.parse(ws.sent.at(-1)!).d.args).toEqual({ day: '2031-01-02', subnet: 'lo', index: 0 });
    ws.serverSend({ t: 'delta', seq: 3, d: { tick: 2, upserts: [], removes: [], events: [], self: { ...self, ticketsDay: '2031-01-03' } } });
    expect(client.serverDay).toBe('2031-01-03');
    client.close();
  });

  it('sends Exchange vault deposits and withdrawals (qty defaults to 1)', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    const ws = last();
    snapshot(ws);
    const client = await p;
    const sent = () => JSON.parse(ws.sent.at(-1)!).d;
    void client.operator.deposit('frag:packet', 6).catch(() => {});
    expect(sent()).toMatchObject({ cmd: 'deposit', actor: 'self', args: { item: 'frag:packet', qty: 6 } });
    void client.operator.withdraw('tap').catch(() => {});
    expect(sent()).toMatchObject({ cmd: 'withdraw', actor: 'self', args: { item: 'tap', qty: 1 } });
    client.close();
  });

  it('falls back to the local clock before any snapshot', () => {
    const client = new GameClient({ url: 'ws://x', auth, WebSocket: Ws as never });
    expect(client.serverDay).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('chat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function online() {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    const ws = last();
    snapshot(ws);
    const client = await p;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    return { client, ws };
  }
  const chats = (ws: FakeWs) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'cmd' && m.d.cmd === 'chat');
  const reply = (ws: FakeWs, reqId: string, err?: 'E_RATE' | 'E_STATE') =>
    ws.serverSend(err ? { t: 'err', seq: 9, d: { reqId, code: err, message: 'x' } } : { t: 'ack', seq: 9, d: { reqId } });

  it('spaces queued lines 2 s after the previous reply, so network delay can never make the server refuse one', async () => {
    const { client, ws } = await online();
    const a = client.chat.send('subnet:s1', 'one');
    const b = client.chat.dm('op2', 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(chats(ws).map((m) => m.d.args)).toEqual([{ channel: 'subnet:s1', text: 'one' }]);
    // the ack takes 700 ms to come back: the next line waits 2 s from the ack, not from the send
    await vi.advanceTimersByTimeAsync(700);
    reply(ws, chats(ws)[0].d.reqId);
    await expect(a).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1999);
    expect(chats(ws)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(chats(ws).map((m) => m.d.args)).toEqual([
      { channel: 'subnet:s1', text: 'one' },
      { channel: 'dm:op2', text: 'two' },
    ]);
    reply(ws, chats(ws)[1].d.reqId);
    await expect(b).resolves.toBeUndefined();
    client.close();
  });

  it('retries once on E_RATE after the interval, then gives up; other errors are not retried', async () => {
    const { client, ws } = await online();
    const a = client.chat.send('subnet:s1', 'hi');
    await vi.advanceTimersByTimeAsync(0);
    reply(ws, chats(ws)[0].d.reqId, 'E_RATE');
    await vi.advanceTimersByTimeAsync(1999);
    expect(chats(ws)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(chats(ws)).toHaveLength(2);
    reply(ws, chats(ws)[1].d.reqId, 'E_RATE');
    await expect(a).rejects.toMatchObject({ code: 'E_RATE' });
    const b = client.chat.send('subnet:s1', 'again');
    await vi.advanceTimersByTimeAsync(2000);
    expect(chats(ws)).toHaveLength(3);
    reply(ws, chats(ws)[2].d.reqId, 'E_STATE');
    await expect(b).rejects.toMatchObject({ code: 'E_STATE' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(chats(ws)).toHaveLength(3);
    client.close();
  });

  it('does not use the per-tick command budget', async () => {
    const { client, ws } = await online();
    for (let i = 0; i < 8; i++) void client.operator.stop();
    await expect(client.operator.stop()).rejects.toMatchObject({ code: 'E_RATE' });
    void client.chat.send('subnet:s1', 'still fine');
    await vi.advanceTimersByTimeAsync(0);
    expect(chats(ws)).toHaveLength(1);
    client.close();
  });

  it('emits chat, chatDeleted and muted', async () => {
    const { client, ws } = await online();
    const got: unknown[] = [];
    client.on('chat', (d) => got.push(['chat', d.text]));
    client.on('chatDeleted', (d) => got.push(['chatDeleted', d.id]));
    client.on('muted', (d) => got.push(['muted', d.until]));
    ws.serverSend({ t: 'chat', seq: 3, d: { id: 'm1', channel: 'subnet:s1', from: 'op2', name: 'bob', tag: null, text: 'hey', at: '2026-09-30T00:00:00.000Z' } });
    ws.serverSend({ t: 'chatDeleted', seq: 4, d: { id: 'm1', channel: 'subnet:s1' } });
    ws.serverSend({ t: 'muted', seq: 5, d: { until: null } });
    expect(got).toEqual([['chat', 'hey'], ['chatDeleted', 'm1'], ['muted', null]]);
    client.close();
  });
});

describe('clusters', () => {
  it('sends the six cluster commands, resolves with the result, and emits clusterInvite', async () => {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    const ws = last();
    snapshot(ws);
    const client = await p;
    const invites: unknown[] = [];
    client.on('clusterInvite', (d) => invites.push(d));
    const inv = { clusterId: 'c1', from: 'op2', name: 'bob', expiresAt: '2026-10-04T00:01:00.000Z' };
    ws.serverSend({ t: 'clusterInvite', seq: 3, d: inv });
    expect(invites).toEqual([inv]);
    const calls = [client.cluster.create(), client.cluster.invite('op2'), client.cluster.accept('c1'), client.cluster.join('abc234'), client.cluster.leave(), client.cluster.kick('op2')];
    for (const c of calls) c.catch(() => {});
    const sent = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'cmd');
    expect(sent.map((m) => [m.d.cmd, m.d.args])).toEqual([
      ['clusterCreate', {}],
      ['clusterInvite', { operatorId: 'op2' }],
      ['clusterAccept', { clusterId: 'c1' }],
      ['clusterJoin', { code: 'abc234' }],
      ['clusterLeave', {}],
      ['clusterKick', { operatorId: 'op2' }],
    ]);
    ws.serverSend({ t: 'ack', seq: 4, d: { reqId: sent[0].d.reqId, result: { clusterId: 'c1', code: 'ABC234' } } });
    await expect(calls[0]).resolves.toEqual({ clusterId: 'c1', code: 'ABC234' });
    client.close();
  });
});

describe('arena', () => {
  async function online() {
    FakeWs.instances = [];
    const p = connect({ url: 'ws://x', auth, WebSocket: Ws });
    await tick();
    const ws = last();
    snapshot(ws);
    return { client: await p, ws };
  }
  const cmds = (ws: FakeWs) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'cmd');
  const wild = (id: string, x: number, taggedBy: string | null = null) => ({
    kind: 'daemon', id, species: 'sprite', types: ['packet'], level: 5, hp: 10, maxHp: 10, owner: null, taggedBy, clean: true, signature: 0, statuses: [], hardened: false, x, y: 0,
  });
  const owned = (id: string, owner: string, x: number) => ({ ...wild(id, x), owner });

  it('sends the five arena commands and resolves with the result', async () => {
    const { client, ws } = await online();
    const calls = [client.arena.queue('ranked'), client.arena.leave(), client.arena.challenge('op2'), client.arena.challenge('op3', 'ranked'), client.arena.accept('ch1'), client.arena.forfeit()];
    expect(cmds(ws).map((m) => [m.d.cmd, m.d.actor, m.d.args])).toEqual([
      ['arenaQueue', 'self', { mode: 'ranked' }],
      ['arenaLeave', 'self', {}],
      ['arenaChallenge', 'self', { operatorId: 'op2', mode: 'unranked' }],
      ['arenaChallenge', 'self', { operatorId: 'op3', mode: 'ranked' }],
      ['arenaAccept', 'self', { challengeId: 'ch1' }],
      ['arenaForfeit', 'self', {}],
    ]);
    ws.serverSend({ t: 'ack', seq: 4, d: { reqId: cmds(ws)[0].d.reqId, result: { queued: true } } });
    await expect(calls[0]).resolves.toEqual({ queued: true });
    ws.serverSend({ t: 'err', seq: 5, d: { reqId: cmds(ws)[1].d.reqId, code: 'E_STATE', message: 'not queued' } });
    await expect(calls[1]).rejects.toMatchObject({ code: 'E_STATE' });
    client.close();
  });

  it('does not use the per-tick command budget (the sim runs arena commands outside the tick)', async () => {
    const { client, ws } = await online();
    for (let i = 0; i < 8; i++) void client.operator.stop();
    await expect(client.operator.stop()).rejects.toMatchObject({ code: 'E_RATE' });
    void client.arena.queue('unranked');
    void client.arena.forfeit();
    expect(cmds(ws).filter((m) => m.d.cmd.startsWith('arena'))).toHaveLength(2);
    // and they do not eat the budget either
    ws.serverSend({ t: 'delta', seq: 6, d: { tick: 2, upserts: [], removes: [], events: [] } });
    for (let i = 0; i < 6; i++) void client.arena.accept('c');
    void client.operator.stop();
    expect(cmds(ws).filter((m) => m.d.cmd === 'stop')).toHaveLength(9);
    client.close();
  });

  it('emits arenaChallenge and the arena game events', async () => {
    const { client, ws } = await online();
    const got: unknown[] = [];
    client.on('arenaChallenge', (d) => got.push(['challenge', d.challengeId, d.mode]));
    client.on('arenaQueued', (d) => got.push(['queued', d.mode]));
    client.on('arenaMatch', (d) => got.push(['match', d.id]));
    client.on('arenaResult', (d) => got.push(['result', d.outcome]));
    ws.serverSend({ t: 'arenaChallenge', seq: 3, d: { challengeId: 'ch1', from: 'op2', name: 'bob', mode: 'ranked', expiresAt: '2026-10-04T00:01:00.000Z' } });
    ws.serverSend({
      t: 'delta',
      seq: 4,
      d: {
        tick: 2,
        upserts: [],
        removes: [],
        events: [
          { e: 'arenaQueued', mode: 'ranked' },
          { e: 'arenaMatch', id: 'm1', mode: 'ranked', opponent: { id: 'op2', name: 'bob', tag: null, rating: 1000 }, startsAtTick: 10, endsAtTick: 100 },
          { e: 'arenaResult', id: 'm1', mode: 'ranked', outcome: 'win', reason: 'wipeout', ratingBefore: 1000, ratingAfter: 1000, reward: 0, counted: false },
        ],
      },
    });
    expect(got).toEqual([['challenge', 'ch1', 'ranked'], ['queued', 'ranked'], ['match', 'm1'], ['result', 'win']]);
    client.close();
  });

  it('exposes the current match as client.arena.match', async () => {
    const { client, ws } = await online();
    expect(client.arena.match).toBeNull();
    const arena = {
      id: 'm1', mode: 'unranked', phase: 'live', liveAtTick: 5, endsAtTick: 50, result: null,
      opponent: { id: 'op2', name: 'bob', tag: null, rating: 1000, team: [] },
    };
    ws.serverSend({ t: 'delta', seq: 4, d: { tick: 2, upserts: [], removes: [], events: [], self: { ...self, arena } } });
    expect(client.arena.match).toEqual(arena);
    client.close();
  });

  it('daemon scripts see the opponent daemons as enemies in a match, wild ones otherwise', async () => {
    const { client, ws } = await online();
    const seen: string[][] = [];
    client.daemons.script(({ enemies }) => seen.push(enemies.all().map((d) => d.id).sort()));
    const arena = { id: 'm1', mode: 'unranked', phase: 'live', liveAtTick: 5, endsAtTick: 50, result: null, opponent: { id: 'op2', name: 'bob', tag: null, rating: 1000, team: [] } };
    const entities = [wild('w1', 2), wild('w2', 3, 'op2'), owned('mine', 'op1', 1), owned('theirs', 'op2', 4), owned('theirs2', 'op2', 5)];
    // outside a match: untagged wild daemons and my own tags only
    ws.serverSend({ t: 'delta', seq: 4, d: { tick: 2, upserts: entities, removes: [], events: [], self: { ...self, running: ['mine'] } } });
    expect(seen.at(-1)).toEqual(['w1']);
    // in a match: the opponent's daemons, never mine and never wild ones
    ws.serverSend({ t: 'delta', seq: 5, d: { tick: 3, upserts: [], removes: [], events: [], self: { ...self, running: ['mine'], arena } } });
    expect(seen.at(-1)).toEqual(['theirs', 'theirs2']);
    client.close();
  });

  it('a mid-session snapshot (match entry or return) is a full reset: entities, self, tick and command budget', async () => {
    const { client, ws } = await online();
    ws.serverSend({ t: 'delta', seq: 3, d: { tick: 2, upserts: [wild('w1', 2)], removes: [], events: [] } });
    expect(client.entities.has('w1')).toBe(true);
    for (let i = 0; i < 8; i++) void client.operator.stop();
    const arena = { id: 'm1', mode: 'unranked', phase: 'countdown', liveAtTick: 5, endsAtTick: 50, result: null, opponent: { id: 'op2', name: 'bob', tag: null, rating: 1000, team: [] } };
    ws.serverSend({ t: 'snapshot', seq: 4, d: { tick: 0, subnet: 's1', self: { ...self, arena }, entities: [owned('theirs', 'op2', 4)] } });
    expect([...client.entities.keys()]).toEqual(['theirs']);
    expect(client.tick).toBe(0);
    expect(client.arena.match?.id).toBe('m1');
    void client.operator.stop();
    expect(cmds(ws).filter((m) => m.d.cmd === 'stop')).toHaveLength(9);
    client.close();
  });
});
