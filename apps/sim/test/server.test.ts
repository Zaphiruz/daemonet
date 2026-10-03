import type { ServerMessage } from '@daemonet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game } from '../src/runtime/game.js';
import { startLoop } from '../src/runtime/loop.js';
import { clientIp, startServer, type RunningServer } from '../src/runtime/server.js';
import { MemoryStore, type Store } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

const log = { info() {}, warn() {}, error() {} };
let running: RunningServer | null = null;

async function boot(store: Store = new MemoryStore(), maxConnectionsPerIp?: number) {
  const world = new World({ subnet: TEST_SUBNET, seed: 'srv', seedId: 'abcd1234', spawner: false });
  const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId: 'abcd1234' });
  running = await startServer({ game, store, port: 0, host: '127.0.0.1', trustProxyHops: 0, maxConnectionsPerIp, log });
  return running;
}

afterEach(async () => {
  await running?.close();
  running = null;
});

describe('clientIp', () => {
  const req = (xff: string | undefined, addr = '10.0.0.1') =>
    ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: addr } }) as never;

  it('uses the socket address with zero hops', () => {
    expect(clientIp(req('1.1.1.1'), 0)).toBe('10.0.0.1');
  });

  it('walks back the trusted hops', () => {
    expect(clientIp(req('9.9.9.9, 1.1.1.1'), 1)).toBe('1.1.1.1');
    expect(clientIp(req('9.9.9.9, 1.1.1.1'), 2)).toBe('9.9.9.9');
    expect(clientIp(req('1.1.1.1'), 5)).toBe('1.1.1.1');
  });
});

describe('startServer', () => {
  it('reports readiness and 404s elsewhere', async () => {
    const s = await boot();
    expect((await fetch(`http://127.0.0.1:${s.port}/ws/ready`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${s.port}/nope`)).status).toBe(404);
  });

  it('returns 503 when the store is down', async () => {
    const store = new MemoryStore();
    store.ping = () => Promise.reject(new Error('down'));
    const s = await boot(store);
    expect((await fetch(`http://127.0.0.1:${s.port}/ws/ready`)).status).toBe(503);
  });

  it('authenticates over a real websocket and rejects other paths', async () => {
    const s = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
    await expect.poll(() => msgs.length, { timeout: 3000 }).toBeGreaterThan(0);
    ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${s.port}/other`);
    await new Promise<void>((resolve) => {
      bad.on('error', () => resolve());
      bad.on('close', () => resolve());
    });
    expect(bad.readyState).not.toBe(WebSocket.OPEN);
  });

  it('caps sockets per client IP with a 429', async () => {
    const s = await boot(new MemoryStore(), 1);
    const first = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    await new Promise((r) => first.once('open', r));
    const second = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const err = await new Promise<Error>((r) => second.once('error', r));
    expect(err.message).toContain('429');
    first.close();
  });
});

describe('startLoop', () => {
  it('ticks repeatedly and stops', async () => {
    let n = 0;
    const stop = startLoop(() => n++, 5);
    await expect.poll(() => n, { timeout: 2000 }).toBeGreaterThanOrEqual(3);
    stop();
    const at = n;
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(at);
  });
});
