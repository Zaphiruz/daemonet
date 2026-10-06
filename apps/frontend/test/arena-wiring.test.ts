import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createArenaStore } from '../src/game/arena.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { getControls, setControls } from '../src/game/controls.ts';
import { createLog } from '../src/game/log.ts';

type Handler = (v: unknown) => void;
class FakeClient {
  readonly handlers = new Map<string, Set<Handler>>();
  subnet = 'lo';
  operatorId = 'me';
  self = { ram: [{ id: 'a' }] };
  constructor(readonly opts: ConnectOptions) {}
  on(name: string, h: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }
  emit(name: string, value?: unknown): void {
    for (const h of this.handlers.get(name) ?? []) h(value);
  }
  async start(): Promise<void> {
    await this.opts.auth.getToken();
  }
  close(): void {}
}

function setup() {
  const clients: FakeClient[] = [];
  const arena = createArenaStore();
  const log = createLog(100);
  const invalidateArena = vi.fn();
  const deps: ConnectionDeps = {
    fetchTicket: async () => 'ticket:t',
    createClient: (opts) => {
      const c = new FakeClient(opts);
      clients.push(c);
      return c as unknown as GameClient;
    },
    url: () => 'ws://test/ws',
    log,
    capture: createCaptureStore(),
    stopSandbox: vi.fn(),
    invalidateCodex: vi.fn(),
    arena,
    invalidateArena,
  };
  return { conn: createConnection(deps), clients, arena, log, invalidateArena, texts: () => log.get().map((e) => `${e.kind}:${e.text}`) };
}

const result = { id: 'm1', mode: 'ranked', outcome: 'win', reason: 'wipeout', ratingBefore: 1500, ratingAfter: 1532, reward: 16, counted: true };
const challenge = () => ({ challengeId: 'c1', from: 'bob', name: 'bob', mode: 'unranked', expiresAt: new Date(Date.now() + 60_000).toISOString() });

describe('arena events in the connection (captured before any panel mounts)', () => {
  it('feeds the store and the log from the event stream', async () => {
    const t = setup();
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('arenaQueued', { mode: 'ranked' });
    expect(t.arena.get().queued?.mode).toBe('ranked');
    c.emit('arenaQueued', { mode: null, reason: 'recall running daemons first' });
    expect(t.arena.get()).toMatchObject({ queued: null, note: 'recall running daemons first' });
    expect(t.texts()).toContain('event:Arena: left the queue (recall running daemons first)');
    c.emit('arenaQueued', { mode: null }); // a plain leave is silent
    expect(t.log.get().filter((e) => e.text.includes('left the queue'))).toHaveLength(1);
    c.emit('arenaChallenge', challenge());
    expect(t.arena.get().challenges).toHaveLength(1);
    expect(t.texts()).toContain('event:bob challenges you to a unranked match (arena tab)');
    c.emit('arenaMatch', { id: 'm1', mode: 'ranked', opponent: { id: 'bob', name: 'bob', tag: null, rating: 1611.6 }, startsAtTick: 1, endsAtTick: 2 });
    expect(t.arena.get().challenges).toEqual([]);
    expect(t.texts()).toContain('event:Arena: ranked match against bob (1612)');
    expect(t.invalidateArena).not.toHaveBeenCalled();
    c.emit('arenaResult', result);
    expect(t.arena.get().lastResult?.id).toBe('m1');
    expect(t.texts()).toContain('event:Arena: you won by wipe-out · 1500 → 1532 · +16 bits');
    expect(t.invalidateArena).toHaveBeenCalledTimes(1); // standing, ladder and history changed (possibly after the return home)
    c.emit('arenaMatch', { id: 'm2', mode: 'ranked', opponent: { id: 'bob', name: 'bob', tag: null, rating: 1611.6 }, startsAtTick: 1, endsAtTick: 2 });
    c.emit('arenaResult', { ...result, id: 'm0' }); // an older match's late result during m2: not the last result
    expect(t.arena.get().lastResult?.id).toBe('m1');
    c.emit('arenaResult', { ...result, id: 'm2' });
    expect(t.arena.get().lastResult?.id).toBe('m2');
  });

  it('refetches the arena queries and forgets a stale queue after a reconnect', async () => {
    const t = setup();
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('arenaQueued', { mode: 'ranked' });
    c.emit('arenaResult', result);
    t.invalidateArena.mockClear();
    c.emit('reconnect');
    expect(t.invalidateArena).toHaveBeenCalledTimes(1);
    expect(t.arena.get().queued).toBeNull();
    expect(t.arena.get().lastResult?.id).toBe('m1');
  });

  it('forgets challenges and the note after a reconnect, keeping the result', async () => {
    const t = setup();
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('arenaChallenge', challenge());
    c.emit('arenaResult', result);
    c.emit('reconnect');
    expect(t.arena.get().challenges).toEqual([]);
    expect(t.arena.get().lastResult?.id).toBe('m1');
  });

  it('keeps the result across the sandbox snapshot, and clears on a terminal kick, close and a new open', async () => {
    const t = setup();
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('arenaResult', result);
    c.emit('arenaQueued', { mode: 'ranked' });
    // entering the match snapshots the sandbox: the target is dropped, the result stays
    setControls({ targetId: 'w1', actor: 'a' });
    c.subnet = 'sandbox';
    c.emit('ready');
    expect(getControls().targetId).toBeNull();
    expect(t.arena.get().lastResult?.id).toBe('m1');
    c.emit('kick', 'banned');
    expect(t.arena.get()).toMatchObject({ queued: null, lastResult: null });

    await t.conn.open('controller');
    t.clients[1]!.emit('arenaResult', result);
    t.conn.close();
    expect(t.arena.get().lastResult).toBeNull();

    await t.conn.open('controller');
    t.clients[2]!.emit('arenaChallenge', challenge());
    await t.conn.open('controller'); // a new connection starts clean
    expect(t.arena.get().challenges).toEqual([]);
  });

  it('ignores events of a replaced client', async () => {
    const t = setup();
    await t.conn.open('controller');
    const old = t.clients[0]!;
    await t.conn.open('controller');
    old.emit('arenaResult', result);
    expect(t.arena.get().lastResult).toBeNull();
  });
});
