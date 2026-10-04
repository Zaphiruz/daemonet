import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTicket, TicketError } from '../src/api.ts';
import { createConnection, MAX_UNAUTHORIZED_RETRIES, RETRY_MAX_MS, RETRY_MIN_MS, type ConnectionDeps } from '../src/game/connection.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createLog } from '../src/game/log.ts';

type Handler = (v: unknown) => void;
type Outcome = { kind: 'ready' } | { kind: 'hang' } | { kind: 'fail'; kick?: string; message: string };

/** Stands in for GameClient: start() mints a token like the SDK does, then settles as the test says. */
class FakeClient {
  readonly handlers = new Map<string, Set<Handler>>();
  token: string | null = null;
  closed = false;
  constructor(
    readonly opts: ConnectOptions,
    private readonly outcome: Outcome,
  ) {}
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
    this.token = await this.opts.auth.getToken();
    if (this.outcome.kind === 'ready') return;
    // like the SDK while its socket is still connecting: settles only if the test closes it... or never
    if (this.outcome.kind === 'hang') return new Promise<void>(() => {});
    if (this.outcome.kick) this.emit('kick', this.outcome.kick);
    throw new Error(this.outcome.message);
  }
  close(): void {
    this.closed = true;
  }
}

function setup(outcomes: Outcome[], ticket: () => Promise<string> = (() => {
  let n = 0;
  return async () => `ticket:t${++n}`;
})()) {
  const clients: FakeClient[] = [];
  const log = createLog(1000);
  const capture = createCaptureStore();
  const stopSandbox = vi.fn();
  const invalidateCodex = vi.fn();
  const fetchTicketMock = vi.fn(ticket);
  const deps: ConnectionDeps = {
    fetchTicket: fetchTicketMock,
    createClient: (opts) => {
      const c = new FakeClient(opts, outcomes.shift() ?? { kind: 'ready' });
      clients.push(c);
      return c as unknown as GameClient;
    },
    url: () => 'ws://test/ws',
    log,
    capture,
    stopSandbox,
    invalidateCodex,
  };
  const conn = createConnection(deps);
  return { conn, clients, log, capture, stopSandbox, invalidateCodex, fetchTicket: fetchTicketMock, texts: () => log.get().map((e) => `${e.kind}:${e.text}`) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connection store', () => {
  it('connects with a freshly minted ticket and never wires a reauth source', async () => {
    const t = setup([{ kind: 'ready' }]);
    const p = t.conn.open('spectator');
    expect(t.conn.get().status).toBe('connecting');
    await p;
    expect(t.conn.get()).toMatchObject({ status: 'online', role: 'spectator', kickReason: null });
    expect(t.conn.get().client).toBe(t.clients[0]);
    expect(t.clients[0]!.token).toBe('ticket:t1');
    expect(t.clients[0]!.opts).toMatchObject({ url: 'ws://test/ws', role: 'spectator' });
    expect(t.clients[0]!.opts.auth.onRefresh).toBeUndefined();
    expect(t.texts()).toContain('system:connected as spectator');
  });

  it('retries a failed first connection with backoff, minting a new ticket each time', async () => {
    const t = setup([
      { kind: 'fail', message: 'connection closed: 1006 ' },
      { kind: 'fail', kick: 'server shutting down', message: 'server shutting down' },
      { kind: 'ready' },
    ]);
    let settled = false;
    const p = t.conn.open('controller').then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.clients).toHaveLength(1);
    expect(t.clients[0]!.closed).toBe(true);
    expect(t.conn.get().status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS - 1);
    expect(t.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * RETRY_MIN_MS);
    await p;
    expect(settled).toBe(true);
    expect(t.clients.map((c) => c.token)).toEqual(['ticket:t1', 'ticket:t2', 'ticket:t3']);
    expect(t.conn.get().status).toBe('online');
    expect(t.texts().some((x) => x.includes('retrying in'))).toBe(true);
  });

  it('caps the backoff', async () => {
    const t = setup(Array.from({ length: 20 }, () => ({ kind: 'fail', message: 'down' }) as Outcome));
    void t.conn.open('controller');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
    const n = t.clients.length;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(t.clients.length).toBe(n + 1);
    t.conn.close();
  });

  it('stops on a terminal kick before the snapshot and rejects open()', async () => {
    const t = setup([{ kind: 'fail', kick: 'takeover', message: 'takeover' }]);
    await expect(t.conn.open('controller')).rejects.toThrow('takeover');
    expect(t.conn.get()).toMatchObject({ status: 'kicked', kickReason: 'takeover', client: null });
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(t.clients).toHaveLength(1);
  });

  it('stops when the ticket endpoint says the session is gone', async () => {
    const t = setup([], async () => {
      throw new TicketError(401);
    });
    await expect(t.conn.open('controller')).rejects.toThrow();
    expect(t.conn.get().status).toBe('failed');
    expect(t.conn.get().kickReason).toMatch(/sign in/);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(t.clients).toHaveLength(1);
  });

  it('retries when minting a ticket fails transiently', async () => {
    let n = 0;
    const t = setup([], async () => {
      if (++n === 1) throw new TicketError(503);
      return `ticket:t${n}`;
    });
    const p = t.conn.open('controller');
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    await p;
    expect(t.conn.get().status).toBe('online');
    expect(t.clients[1]!.token).toBe('ticket:t2');
  });

  it('close() during the backoff cancels the retries', async () => {
    const t = setup([{ kind: 'fail', message: 'down' }]);
    const p = t.conn.open('controller');
    await vi.advanceTimersByTimeAsync(0);
    t.conn.close();
    await p;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(t.clients).toHaveLength(1);
    expect(t.conn.get().status).toBe('idle');
    expect(t.stopSandbox).toHaveBeenCalled();
  });

  it('tracks the online client: ticks, transient drops, reconnects and terminal kicks', async () => {
    const t = setup([{ kind: 'ready' }]);
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('tick', 1);
    c.emit('tick', 2);
    expect(t.conn.get().version).toBe(2);
    c.emit('kick', 'idle');
    c.emit('disconnect', { code: 4000, reason: 'idle' });
    expect(t.conn.get().status).toBe('reconnecting');
    c.emit('reconnect');
    expect(t.conn.get().status).toBe('online');
    expect(t.stopSandbox).toHaveBeenCalledTimes(1); // only open() stopped a previous script
    c.emit('kick', 'takeover');
    c.emit('disconnect', { code: 4003, reason: 'takeover' });
    expect(t.conn.get()).toMatchObject({ status: 'kicked', kickReason: 'takeover', client: null });
    expect(c.closed).toBe(true);
    expect(t.stopSandbox).toHaveBeenCalledTimes(2);
    expect(t.texts()).toContain('system:kicked: takeover');
  });

  it('refreshes the Codex when a live discovery arrives', async () => {
    const t = setup([{ kind: 'ready' }]);
    await t.conn.open('controller');
    expect(t.invalidateCodex).not.toHaveBeenCalled();
    t.clients[0]!.emit('discovery', { form: 'anycastrel', operatorName: 'ada' });
    expect(t.invalidateCodex).toHaveBeenCalledTimes(1);
    expect(t.texts()).toContain('event:ada discovered anycastrel');
  });

  it('gives up a reconnecting client when the session is gone', async () => {
    let n = 0;
    const t = setup([{ kind: 'ready' }], async () => {
      if (++n > 1) throw new TicketError(401);
      return 'ticket:t1';
    });
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('disconnect', { code: 1006, reason: '' });
    await expect(c.opts.auth.getToken()).rejects.toBeInstanceOf(TicketError);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.closed).toBe(true);
    expect(t.conn.get()).toMatchObject({ status: 'failed', client: null });
  });

  it('a second open() cancels the first one still connecting', async () => {
    const t = setup([{ kind: 'hang' }, { kind: 'ready' }]);
    let firstSettled = false;
    const first = t.conn.open('controller').then(() => (firstSettled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.clients).toHaveLength(1);
    await t.conn.open('controller');
    await first;
    expect(firstSettled).toBe(true);
    expect(t.clients[0]!.closed).toBe(true);
    expect(t.clients[1]!.closed).toBe(false);
    expect(t.conn.get()).toMatchObject({ status: 'online', client: t.clients[1] });
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(t.clients).toHaveLength(2);
  });

  it('close() while connecting leaves no live client', async () => {
    const t = setup([{ kind: 'hang' }]);
    const p = t.conn.open('controller');
    await vi.advanceTimersByTimeAsync(0);
    t.conn.close();
    await p;
    expect(t.clients[0]!.closed).toBe(true);
    expect(t.conn.get()).toMatchObject({ status: 'idle', client: null });
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(t.clients).toHaveLength(1);
  });

  it(`gives up after ${MAX_UNAUTHORIZED_RETRIES} unauthorized kicks in a row`, async () => {
    const t = setup(Array.from({ length: 10 }, () => ({ kind: 'fail', kick: 'unauthorized', message: 'unauthorized' }) as Outcome));
    const p = t.conn.open('controller').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 10);
    expect(await p).toBeInstanceOf(Error);
    expect(t.clients).toHaveLength(MAX_UNAUTHORIZED_RETRIES);
    expect(t.conn.get().status).toBe('failed');
    expect(t.conn.get().kickReason).toMatch(/unauthorized.*sign in/);
  });

  it('ignores events from a replaced client', async () => {
    const t = setup([{ kind: 'ready' }, { kind: 'ready' }]);
    await t.conn.open('controller');
    await t.conn.open('spectator');
    const [old, cur] = t.clients;
    expect(old!.closed).toBe(true);
    old!.emit('kick', 'takeover');
    old!.emit('disconnect', { code: 4003, reason: 'takeover' });
    expect(t.conn.get()).toMatchObject({ status: 'online', role: 'spectator', client: cur });
  });
});

describe('fetchTicket', () => {
  it('POSTs /api/ws/ticket with the CSRF header and returns the ticket', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: 'ticket:abc', expiresAt: 'x' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await expect(fetchTicket()).resolves.toBe('ticket:abc');
    expect(fetchMock).toHaveBeenCalledWith('/api/ws/ticket', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'daemonet' },
      signal: expect.any(AbortSignal),
    });
    // a hung ticket request gives up after 10 s
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
  });

  it('a timed-out ticket request is a plain error (retryable), not a signed-out TicketError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))));
    const err = await fetchTicket().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TicketError);
    expect((err as DOMException).name).toBe('TimeoutError');
  });

  it('throws a TicketError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const err = await fetchTicket().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect((err as TicketError).status).toBe(401);
  });

  it('keeps a capture challenge from the event stream until its result or a disconnect', async () => {
    const t = setup([{ kind: 'ready' }]);
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('captureStart', { captureId: 'c1', targetId: 'w1', challenge: { kind: 'single', families: ['packet'], params: {}, payload: {} }, deadlineTick: 9 });
    expect(t.capture.get()?.captureId).toBe('c1');
    c.emit('captureResult', { captureId: 'c1', ok: false, reason: 'wrong_answer' });
    expect(t.capture.get()).toBeNull();
    c.emit('captureStart', { captureId: 'c2', targetId: 'w1', challenge: { kind: 'single', families: ['packet'], params: {}, payload: {} }, deadlineTick: 9 });
    c.emit('disconnect', {});
    expect(t.capture.get()).toBeNull();
  });
});

describe('evolution events', () => {
  it('logs evolved and discovery events from the store, before any panel mounts', async () => {
    const t = setup([{ kind: 'ready' }]);
    await t.conn.open('controller');
    const c = t.clients[0]!;
    c.emit('evolved', { daemon: 'd1', from: 'echolet', to: 'tracerat', changes: [] });
    c.emit('discovery', { form: 'tracerat', operator: 'o1', operatorName: 'ada' });
    c.emit('discovery', { form: 'broadcaw', operator: 'o2', operatorName: null });
    expect(t.texts()).toContain('event:d1 evolved: echolet -> tracerat');
    expect(t.texts()).toContain('event:ada discovered tracerat');
    expect(t.texts()).toContain('event:someone discovered broadcaw');
  });
});
