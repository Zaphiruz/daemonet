import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, describeApiError } from '../src/api.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { chatStore, createChatStore, me } from '../src/game/chat.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createLog } from '../src/game/log.ts';

type Handler = (v: unknown) => void;

class FakeClient {
  readonly handlers = new Map<string, Set<Handler>>();
  closed = false;
  subnet = 'lo';
  operatorId = 'me';
  self = { ram: [] };
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
  close(): void {
    this.closed = true;
  }
}

function setup() {
  const clients: FakeClient[] = [];
  const chat = createChatStore();
  const log = createLog(100);
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
    chat,
  };
  return { conn: createConnection(deps), clients, chat, log };
}

describe('chat events in the connection (captured before any panel mounts)', () => {
  it('stores chat lines, deletions and the mute state, files DMs under the other side, and logs mutes', async () => {
    const { conn, clients, chat, log } = setup();
    await conn.open('controller');
    const c = clients[0]!;
    c.emit('chat', { id: 'm1', channel: 'subnet:lo', from: 'bob', name: 'bob', tag: null, text: 'hello', at: '2026-09-30T00:00:01.000Z' });
    c.emit('chat', { id: 'm2', channel: 'dm:me', from: 'bob', name: 'bob', tag: null, text: 'psst', at: '2026-09-30T00:00:02.000Z' });
    expect(chat.get().lines.get('subnet:lo')!.map((l) => l.text)).toEqual(['hello']);
    expect(chat.get().lines.get('dm:bob')!.map((l) => l.text)).toEqual(['psst']);
    c.emit('chatDeleted', { id: 'm1', channel: 'subnet:lo' });
    expect(chat.get().lines.get('subnet:lo')).toEqual([]);
    c.emit('muted', { until: '2099-01-01T00:00:00.000Z' });
    expect(chat.get().mutedUntil).toBe('2099-01-01T00:00:00.000Z');
    expect(log.get().some((e) => e.text.includes('you are muted until'))).toBe(true);
    c.emit('muted', { until: null });
    expect(chat.get().mutedUntil).toBeNull();
    expect(log.get().some((e) => e.text.includes('mute was lifted'))).toBe(true);
    expect(me).toBe('me');
  });

  it('ignores chat from a replaced client and forgets chat when the connection closes or is kicked', async () => {
    const { conn, clients, chat } = setup();
    await conn.open('controller');
    const old = clients[0]!;
    await conn.open('spectator');
    old.emit('chat', { id: 'z', channel: 'subnet:lo', from: 'bob', name: 'bob', tag: null, text: 'stale', at: '2026-09-30T00:00:01.000Z' });
    expect(chat.get().lines.size).toBe(0);
    const c = clients[1]!;
    c.emit('chat', { id: 'a', channel: 'subnet:lo', from: 'bob', name: 'bob', tag: null, text: 'live', at: '2026-09-30T00:00:01.000Z' });
    expect(chat.get().lines.get('subnet:lo')!.length).toBe(1);
    c.emit('kick', 'banned');
    expect(chat.get().lines.size).toBe(0);
    await conn.open('controller');
    clients[2]!.emit('muted', { until: '2099-01-01T00:00:00.000Z' });
    conn.close();
    expect(chat.get().mutedUntil).toBeNull();
  });
});

describe('RTK reset on logout also drops chat', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('clears the chat store when logout succeeds and keeps it when it fails', async () => {
    let logoutOk = true;
    const NodeRequest = Request;
    vi.stubGlobal('Request', class extends NodeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      return new Response(JSON.stringify(url.includes('/auth/logout') ? { ok: true, endSessionUrl: null } : []), { status: url.includes('/auth/logout') && !logoutOk ? 500 : 200, headers: { 'content-type': 'application/json' } });
    }));
    const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (d) => d().concat(api.middleware) });
    chatStore.push({ id: 'k', channel: 'subnet:lo', from: 'bob', name: 'bob', tag: null, text: 'x', at: '2026-09-30T00:00:01.000Z' });
    logoutOk = false;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(chatStore.get().lines.size).toBe(1);
    logoutOk = true;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(chatStore.get().lines.size).toBe(0);
  });
});

describe('describeApiError', () => {
  it('maps every API error code, and transport failures, to a readable message', () => {
    const e = (status: number | string, error: string, message = 'm') => ({ status, data: { error, message } });
    expect(describeApiError(e(400, 'validation_error', 'already resolved'))).toBe('already resolved');
    expect(describeApiError(e(400, 'bad_request', 'bad body'))).toBe('bad body');
    expect(describeApiError(e(404, 'not_found', 'no such report'))).toBe('no such report');
    expect(describeApiError(e(401, 'unauthorized'))).toContain('sign in again');
    expect(describeApiError(e(403, 'forbidden'))).toContain('admin');
    expect(describeApiError(e(413, 'payload_too_large'))).toContain('too large');
    expect(describeApiError(e(429, 'rate_limited'))).toContain('too many requests');
    expect(describeApiError(e(500, 'internal_error'))).toContain('server error');
    expect(describeApiError({ status: 'FETCH_ERROR', error: 'x' })).toContain('network');
    expect(describeApiError({ status: 'TIMEOUT', error: 'x' })).toContain('network');
    expect(describeApiError({ status: 'PARSING_ERROR', originalStatus: 502, data: '<html>', error: 'x' })).toContain('server error');
    expect(describeApiError(new Error('boom'))).toBe('request failed');
    expect(describeApiError(undefined)).toBe('request failed');
  });
});
