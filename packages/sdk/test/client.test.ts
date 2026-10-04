import { ticketBoard } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
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
  id: 'op1', name: 'x', starterClaimed: true, x: 0, y: 0, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null,
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

  it('falls back to the local clock before any snapshot', () => {
    const client = new GameClient({ url: 'ws://x', auth, WebSocket: Ws as never });
    expect(client.serverDay).toBe(new Date().toISOString().slice(0, 10));
  });
});
