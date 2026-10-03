import { describe, expect, it } from 'vitest';
import { PortSocket, connect, type TokenSource } from '../src/index.js';

const auth: TokenSource = { getToken: async () => 'dev:x' };
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pair(): { a: MessagePort; b: MessagePort } {
  const ch = new MessageChannel();
  return { a: ch.port1, b: ch.port2 };
}

describe('PortSocket', () => {
  it('opens on a microtask, relays strings both ways', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    expect(sock.readyState).toBe(PortSocket.CONNECTING);
    const opened = new Promise<void>((r) => (sock.onopen = () => r()));
    await opened;
    expect(sock.readyState).toBe(PortSocket.OPEN);

    const hostGot = new Promise<unknown>((r) => b.addEventListener('message', (ev) => r(ev.data)));
    b.start();
    sock.send('hello');
    expect(await hostGot).toBe('hello');

    const got = new Promise<unknown>((r) => (sock.onmessage = (ev) => r(ev.data)));
    b.postMessage('world');
    expect(await got).toBe('world');
    sock.close();
    b.close();
  });

  it('send throws before open and after close', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    expect(() => sock.send('x')).toThrow();
    await tick();
    sock.close();
    expect(() => sock.send('x')).toThrow();
    b.close();
  });

  it('close() posts a control frame to the host and fires onclose once', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    const frame = new Promise<unknown>((r) => b.addEventListener('message', (ev) => r(ev.data)));
    b.start();
    await tick();
    const closes: Array<{ code: number; reason: string }> = [];
    sock.onclose = (ev) => closes.push(ev);
    sock.close(4000, 'bye');
    sock.close(4001, 'again');
    expect(await frame).toEqual({ type: 'close', code: 4000, reason: 'bye' });
    expect(closes).toEqual([{ code: 4000, reason: 'bye' }]);
    expect(sock.readyState).toBe(PortSocket.CLOSED);
    b.close();
  });

  it('a host close frame closes the socket with its code and reason', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    await tick();
    const closed = new Promise<{ code: number; reason: string }>((r) => (sock.onclose = r));
    b.postMessage({ type: 'close', code: 4401, reason: 'idle' });
    expect(await closed).toEqual({ code: 4401, reason: 'idle' });
    expect(sock.readyState).toBe(PortSocket.CLOSED);
    b.close();
  });

  it('close frames with ill-typed fields fall back to 1000 and an empty reason', async () => {
    const cases: Array<[unknown, { code: number; reason: string }]> = [
      [{ type: 'close', code: '4401', reason: 42 }, { code: 1000, reason: '' }],
      [{ type: 'close', code: 4401.5, reason: ['x'] }, { code: 1000, reason: '' }],
      [{ type: 'close', code: 99999, reason: 'r'.repeat(500) }, { code: 1000, reason: 'r'.repeat(123) }],
      [{ type: 'close', code: Number.NaN, reason: null }, { code: 1000, reason: '' }],
    ];
    for (const [frame, expected] of cases) {
      const { a, b } = pair();
      const sock = new PortSocket(a);
      await tick();
      const closed = new Promise<{ code: number; reason: string }>((r) => (sock.onclose = r));
      b.postMessage(frame);
      const ev = await closed;
      expect(ev).toEqual(expected);
      expect(typeof ev.reason).toBe('string');
      b.close();
    }
  });

  it('close frame without code defaults to 1000', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    const closed = new Promise<{ code: number; reason: string }>((r) => (sock.onclose = r));
    b.postMessage({ type: 'close' });
    expect(await closed).toEqual({ code: 1000, reason: '' });
    b.close();
  });

  it('ignores unknown frames', async () => {
    const { a, b } = pair();
    const sock = new PortSocket(a);
    await tick();
    b.postMessage({ type: 'nope' });
    b.postMessage(42);
    await sleep(20);
    expect(sock.readyState).toBe(PortSocket.OPEN);
    sock.close();
    b.close();
  });

  it('factory ignores the url and binds the port', async () => {
    const { a, b } = pair();
    const Ctor = PortSocket.factory(a);
    const sock = new Ctor('ws://ignored');
    expect(sock).toBeInstanceOf(PortSocket);
    await tick();
    expect(sock.readyState).toBe(PortSocket.OPEN);
    sock.close();
    b.close();
  });
});

describe('GameClient over PortSocket', () => {
  const self = {
    id: 'op1', name: 'x', starterClaimed: true, x: 0, y: 0, bits: 0, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null,
  };

  it('connect() resolves once the host relays the snapshot', async () => {
    const { a, b } = pair();
    b.start();
    b.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data) as { t: string };
      if (m.t === 'auth') {
        b.postMessage(JSON.stringify({ t: 'authOk', seq: 1, d: { operatorId: 'op1', role: 'controller', resumeToken: 'r', tick: 1 } }));
        b.postMessage(JSON.stringify({ t: 'snapshot', seq: 2, d: { tick: 1, subnet: 's1', self, entities: [] } }));
      }
    });
    const client = await connect({ url: 'ws://ignored', auth, WebSocket: PortSocket.factory(a) });
    expect(client.tick).toBe(1);
    client.close();
    b.close();
  });

  it('connect() rejects, without retrying, when the host closes the port before the snapshot', async () => {
    const { a, b } = pair();
    b.start();
    const frames: unknown[] = [];
    b.addEventListener('message', (ev) => frames.push(ev.data));
    const p = connect({ url: 'ws://ignored', auth, WebSocket: PortSocket.factory(a) });
    const assertion = expect(p).rejects.toMatchObject({ code: 'E_STATE', message: expect.stringContaining('4503') });
    await sleep(20);
    b.postMessage({ type: 'close', code: 4503, reason: 'unavailable' });
    await assertion;
    // No reconnect attempt: the port is closed and the client must not open another socket.
    await sleep(400);
    expect(frames.filter((f) => typeof f === 'string' && f.includes('"auth"')).length).toBe(1);
    b.close();
  });
});
