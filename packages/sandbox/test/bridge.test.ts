import { DaemonetError, GameClient, PortSocket, staticToken } from '@daemonet/sdk';
import type { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { createBridge, type BridgeOptions } from '../src/bridge.js';

const self: OperatorSelf = {
  id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null, arena: null, org: null, cluster: null,
};
const state = () => ({ operatorId: 'op1', role: 'controller' as const, tick: 40, subnet: 'lo', self, entities: [] });
/** Ports deliver asynchronously; wait (a few macrotasks) until `pred` holds. */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const cmd = (seq: number, reqId: string) => JSON.stringify({ t: 'cmd', seq, d: { reqId, cmd: 'stop', actor: 'self', args: {} } });
const auth = JSON.stringify({ t: 'auth', seq: 1, d: { token: 'sandbox' } });
const delta = (tick: number) => JSON.stringify({ t: 'delta', seq: tick, d: { tick, upserts: [], removes: [], events: [] } });
type Frame = { t: string; seq: number; d: Record<string, unknown> };
const parse = (g: unknown) => JSON.parse(g as string) as Frame;

function setup(extra: Partial<BridgeOptions> = {}) {
  const { port1, port2 } = new MessageChannel();
  const sent: string[] = [];
  const violations: string[] = [];
  const bridge = createBridge({ port: port1, send: (d) => sent.push(d), state, onViolation: (k) => violations.push(k), ...extra });
  const got: unknown[] = [];
  port2.addEventListener('message', (e) => got.push((e as MessageEvent).data));
  port2.start();
  const frames = () => got.filter((g): g is string => typeof g === 'string').map(parse);
  return {
    port2,
    sent,
    got,
    frames,
    violations,
    bridge,
    done: () => {
      bridge.close();
      port2.close();
    },
  };
}

describe('createBridge', () => {
  it('answers auth locally with authOk + snapshot and never forwards it', async () => {
    const { port2, sent, frames, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    expect(frames().map((g) => g.t)).toEqual(['authOk', 'snapshot']);
    expect((frames()[1]!.d.self as OperatorSelf).name).toBe('alice');
    expect(sent).toEqual([]);
    done();
  });

  it('forwards at most 6 commands per tick by default, relays deltas, and drops server auth frames', async () => {
    const { port2, sent, frames, bridge, violations, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    for (let i = 0; i < 10; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await until(() => sent.length >= 6 && frames().length >= 6);
    await settle();
    expect(sent).toHaveLength(6);
    expect(frames().filter((g) => g.t === 'err').map((g) => [g.d.code, g.d.reqId])).toEqual([
      ['E_RATE', 'r6'],
      ['E_RATE', 'r7'],
      ['E_RATE', 'r8'],
      ['E_RATE', 'r9'],
    ]);
    expect(violations).toContain('rate');
    bridge.deliver(JSON.stringify({ t: 'authOk', seq: 9, d: {} }));
    bridge.deliver(delta(41));
    port2.postMessage(cmd(20, 'again'));
    port2.postMessage(JSON.stringify({ t: 'reauth', seq: 21, d: { token: 'x' } }));
    await until(() => sent.length >= 7);
    await settle();
    expect(frames().filter((g) => g.t === 'delta')).toHaveLength(1);
    expect(frames().some((g) => g.t === 'authOk' && g.seq === 9)).toBe(false);
    expect(sent).toHaveLength(7);
    expect(sent.some((s) => s.includes('reauth'))).toBe(false);
    done();
  });

  it('takes the command share from commandsPerTick', async () => {
    const { port2, sent, frames, done } = setup({ commandsPerTick: 8 });
    port2.postMessage(auth);
    for (let i = 0; i < 10; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await until(() => sent.length >= 8 && frames().length >= 4);
    await settle();
    expect(sent).toHaveLength(8);
    expect(frames().filter((g) => g.t === 'err')).toHaveLength(2);
    done();
  });

  it('drives a real GameClient over a PortSocket', async () => {
    const { port1, port2 } = new MessageChannel();
    const sent: string[] = [];
    const bridge = createBridge({ port: port1, send: (d) => sent.push(d), state });
    const client = new GameClient({ url: 'port://x', auth: staticToken('sandbox'), WebSocket: PortSocket.factory(port2), reconnect: false });
    await client.start();
    expect(client.operatorId).toBe('op1');
    expect(client.self.name).toBe('alice');
    const pending = client.operator.stop();
    await until(() => sent.length >= 1);
    const reqId = (JSON.parse(sent[0]!) as { d: { reqId: string } }).d.reqId;
    expect(reqId).toBe('s:c1');
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 5, d: { reqId } }));
    await expect(pending).resolves.toBeUndefined();
    let ticks = 0;
    client.on('tick', () => ticks++);
    bridge.deliver(delta(41));
    await until(() => ticks >= 1);
    expect(ticks).toBe(1);
    expect(client.tick).toBe(41);
    client.close();
    bridge.close();
  });

  it('bridge.close() rejects the in-sandbox pending commands promptly', async () => {
    const { port1, port2 } = new MessageChannel();
    const bridge = createBridge({ port: port1, send: () => {}, state });
    const client = new GameClient({ url: 'port://x', auth: staticToken('sandbox'), WebSocket: PortSocket.factory(port2), reconnect: false });
    await client.start();
    const pending = client.operator.stop();
    const started = Date.now();
    bridge.close(1001, 'host reconnecting');
    const error = await pending.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonetError);
    expect((error as DaemonetError).code).toBe('E_STATE');
    expect(Date.now() - started).toBeLessThan(1000); // not the 10 s command timeout
  });

  it('ignores commands before auth', async () => {
    const { port2, sent, got, done } = setup();
    port2.postMessage(cmd(1, 'early'));
    await settle();
    expect(sent).toEqual([]);
    expect(got).toEqual([]);
    done();
  });

  it('drops oversized, malformed, non-string and shape-invalid frames without forwarding', async () => {
    const { port2, sent, frames, violations, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    port2.postMessage({ t: 'cmd', d: {} }); // not a string
    port2.postMessage('not json');
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'x', cmd: 'rm -rf', actor: 'self', args: {} } })); // unknown command
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 3, d: { cmd: 'stop', actor: 'self', args: {} } })); // no reqId
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 4, d: { reqId: 'big', cmd: 'stop', actor: 'self', args: {}, pad: 'x'.repeat(40000) } })); // oversized
    port2.postMessage(JSON.stringify({ t: 'nope', seq: 5, d: {} }));
    port2.postMessage(cmd(6, 'r'.repeat(63))); // valid alone, but too long once namespaced
    await settle();
    expect(sent).toEqual([]);
    // invalid frames earn an E_INVALID reply at most (never a forward)
    expect(frames().slice(2).every((g) => g.t === 'err')).toBe(true);
    expect(violations).toContain('invalid');
    done();
  });

  it('forwards only the validated command with a namespaced reqId, stripping unknown fields', async () => {
    const { port2, sent, done } = setup();
    port2.postMessage(auth);
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 2, token: 'steal', d: { reqId: 'a', cmd: 'stop', actor: 'self', args: {}, extra: 1 } }));
    await until(() => sent.length >= 1);
    const fwd = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(fwd).toEqual({ t: 'cmd', seq: 2, d: { reqId: 's:a', cmd: 'stop', actor: 'self', args: {} } });
    done();
  });

  it('answers a repeated auth without re-sending state and never forwards pings', async () => {
    const { port2, sent, frames, done } = setup();
    port2.postMessage(auth);
    port2.postMessage(JSON.stringify({ t: 'auth', seq: 2, d: { token: 'other' } }));
    port2.postMessage(JSON.stringify({ t: 'ping', seq: 3, d: {} }));
    await settle();
    expect(frames().map((g) => g.t)).toEqual(['authOk', 'snapshot', 'pong']);
    expect(sent).toEqual([]);
    done();
  });

  it('caps E_RATE replies so a flood cannot spin the bridge', async () => {
    const { port2, sent, frames, done } = setup();
    port2.postMessage(auth);
    for (let i = 0; i < 100; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await settle();
    expect(sent).toHaveLength(6);
    expect(frames().filter((g) => g.t === 'err').length).toBeLessThanOrEqual(8);
    done();
  });
});

describe('createBridge reqId namespacing', () => {
  it('never delivers host replies to the sandbox and round-trips sandbox ids as s:<id>', async () => {
    const { port2, sent, frames, bridge, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    // the host's own command c3 is acked/errored: the sandbox must not see either
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId: 'c3' } }));
    bridge.deliver(JSON.stringify({ t: 'err', seq: 2, d: { reqId: 'c3', code: 'E_STATE', message: 'host' } }));
    // the sandbox's own c3
    port2.postMessage(cmd(2, 'c3'));
    await until(() => sent.length >= 1);
    expect(parse(sent[0]).d.reqId).toBe('s:c3');
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 3, d: { reqId: 's:c3', result: 1 } }));
    bridge.deliver(JSON.stringify({ t: 'err', seq: 4, d: { reqId: 's:c3', code: 'E_STATE', message: 'sandbox' } }));
    bridge.deliver(JSON.stringify({ t: 'err', seq: 5, d: { code: 'E_STATE', message: 'global' } }));
    bridge.deliver(JSON.stringify({ t: 'kick', seq: 6, d: { reason: 'idle' } }));
    await until(() => frames().length >= 6);
    await settle();
    expect(frames().slice(2).map((g) => [g.t, g.d.reqId, g.d.message ?? g.d.reason])).toEqual([
      ['ack', 'c3', undefined],
      ['err', 'c3', 'sandbox'],
      ['err', undefined, 'global'],
      ['kick', undefined, 'idle'],
    ]);
    expect(frames()[2]!.d.result).toBe(1);
    done();
  });
});

describe('createBridge flood budget', () => {
  it('drops raw frames beyond rawFramesPerTick without parsing, and resets on the next delta', async () => {
    const { port2, frames, bridge, violations, done } = setup({ rawFramesPerTick: 10 });
    port2.postMessage(auth); // frame 1
    for (let i = 0; i < 20; i++) port2.postMessage(JSON.stringify({ t: 'ping', seq: 2 + i, d: {} }));
    await settle();
    expect(frames().filter((g) => g.t === 'pong')).toHaveLength(9);
    expect(violations).toEqual(['rate']);
    bridge.deliver(delta(41));
    port2.postMessage(JSON.stringify({ t: 'ping', seq: 30, d: {} }));
    await until(() => frames().filter((g) => g.t === 'pong').length >= 10);
    expect(frames().filter((g) => g.t === 'pong')).toHaveLength(10);
    done();
  });

  it('closes the port with 1008 flood above the hard limit and reports it', async () => {
    const { port2, got, sent, violations, done } = setup({ rawFramesPerTick: 4, floodFramesPerTick: 50 });
    port2.postMessage(auth);
    for (let i = 0; i < 100; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await until(() => violations.includes('flood'));
    await settle();
    expect(violations).toContain('flood');
    expect(got).toContainEqual({ type: 'close', code: 1008, reason: 'flood' });
    expect(sent.length).toBeLessThanOrEqual(3);
    done();
  });

  it('counts non-string frames against the budget too', async () => {
    const { port2, violations, done } = setup({ rawFramesPerTick: 4, floodFramesPerTick: 20 });
    for (let i = 0; i < 30; i++) port2.postMessage({ junk: i });
    await until(() => violations.includes('flood'));
    expect(violations).toContain('flood');
    done();
  });
});

describe('createBridge relay allowlist', () => {
  it('relays only delta/ack/err/kick (and the chat messages, see below) to the sandbox', async () => {
    const { port2, frames, bridge, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    for (const t of ['authOk', 'snapshot', 'pong', 'resumeToken', 'mystery']) bridge.deliver(JSON.stringify({ t, seq: 1, d: {} }));
    bridge.deliver(delta(41));
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId: 's:x' } }));
    bridge.deliver(JSON.stringify({ t: 'err', seq: 1, d: { code: 'E_STATE', message: 'm' } }));
    bridge.deliver(JSON.stringify({ t: 'kick', seq: 1, d: { reason: 'idle' } }));
    await settle();
    expect(frames().slice(2).map((g) => g.t)).toEqual(['delta', 'ack', 'err', 'kick']);
    done();
  });
});

describe('createBridge chat (SP4)', () => {
  const chatLine = JSON.stringify({ t: 'chat', seq: 1, d: { id: 'm1', channel: 'subnet:lo', from: 'op2', name: 'bob', tag: null, text: 'hi', at: '2026-09-30T00:00:00.000Z' } });
  const chatCmd = (reqId: string) => JSON.stringify({ t: 'cmd', seq: 2, d: { reqId, cmd: 'chat', actor: 'self', args: { channel: 'subnet:lo', text: 'hello' } } });

  it('relays chat, chatDeleted and muted to the script (credential-free), re-sequenced, but still never a snapshot', async () => {
    const { port2, frames, bridge, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    bridge.deliver(chatLine);
    bridge.deliver(JSON.stringify({ t: 'chatDeleted', seq: 9, d: { id: 'm1', channel: 'subnet:lo' } }));
    bridge.deliver(JSON.stringify({ t: 'muted', seq: 9, d: { until: null } }));
    bridge.deliver(JSON.stringify({ t: 'snapshot', seq: 9, d: {} }));
    await settle();
    const got = frames().slice(2);
    expect(got.map((g) => g.t)).toEqual(['chat', 'chatDeleted', 'muted']);
    expect(got.map((g) => g.seq)).toEqual([3, 4, 5]);
    expect(got[0]!.d.text).toBe('hi');
    done();
  });

  it('does not relay chat before the script authenticated', async () => {
    const { port2, frames, bridge, done } = setup();
    bridge.deliver(chatLine);
    await settle();
    expect(frames()).toEqual([]);
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    expect(frames().map((g) => g.t)).toEqual(['authOk', 'snapshot']);
    done();
  });

  it('sends a script chat command as an s:-prefixed cmd frame counted in the per-tick command budget', async () => {
    const { port2, sent, frames, bridge, done } = setup({ commandsPerTick: 2 });
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    port2.postMessage(chatCmd('a'));
    port2.postMessage(chatCmd('b'));
    port2.postMessage(chatCmd('c'));
    await until(() => frames().some((g) => g.t === 'err'));
    expect(sent.map((s) => (JSON.parse(s) as { d: { reqId: string; cmd: string } }).d.reqId)).toEqual(['s:a', 's:b']);
    expect(frames().find((g) => g.t === 'err')!.d).toMatchObject({ code: 'E_RATE', reqId: 'c' });
    bridge.deliver(delta(50));
    port2.postMessage(chatCmd('d'));
    await until(() => sent.length >= 3);
    expect(sent.length).toBe(3);
    done();
  });
});

describe('createBridge Incident events (SP4 plan 4)', () => {
  it('lets scripts react to Incidents: incident, telegraph and incidentReward ride inside delta frames (no new frame type is relayed)', async () => {
    const { port2, frames, bridge, done } = setup();
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    const events = [
      { e: 'incident', phase: 'shield', id: 'i1', n: 3, species: 'pidzero', endsAt: '2026-10-04T04:20:00.000Z', bossId: 'b1' },
      { e: 'telegraph', x: 10, y: 12, radius: 6, atTick: 400 },
      { e: 'incidentReward', incidentId: 'i1', reward: 512, share: 0.25 },
    ];
    bridge.deliver(JSON.stringify({ t: 'delta', seq: 5, d: { tick: 5, upserts: [], removes: [], events } }));
    // a would-be dedicated frame is not on the allowlist: scripts get the events from delta only
    for (const t of ['incident', 'telegraph', 'incidentReward']) bridge.deliver(JSON.stringify({ t, seq: 6, d: {} }));
    await settle();
    const got = frames().slice(2);
    expect(got.map((g) => g.t)).toEqual(['delta']);
    expect(got[0]!.d.events).toEqual(events);
    done();
  });
});

describe('createBridge clusters (SP4 plan 2)', () => {
  const clusterCmd = (reqId: string, cmd: string, args: object) => JSON.stringify({ t: 'cmd', seq: 2, d: { reqId, cmd, actor: 'self', args } });

  it('relays clusterInvite (credential-free) once authenticated, re-sequenced', async () => {
    const { port2, frames, bridge, done } = setup();
    const invite = JSON.stringify({ t: 'clusterInvite', seq: 7, d: { clusterId: 'c1', from: 'op2', name: 'bob', expiresAt: '2026-10-04T00:01:00.000Z' } });
    bridge.deliver(invite);
    await settle();
    expect(frames()).toEqual([]);
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    bridge.deliver(invite);
    await settle();
    const got = frames().slice(2);
    expect(got.map((g) => [g.t, g.seq])).toEqual([['clusterInvite', 3]]);
    expect(got[0]!.d).toMatchObject({ clusterId: 'c1', from: 'op2' });
    done();
  });

  it('sends script cluster commands as s:-prefixed cmd frames counted in the per-tick command budget', async () => {
    const { port2, sent, frames, done } = setup({ commandsPerTick: 2 });
    port2.postMessage(auth);
    await until(() => frames().length >= 2);
    port2.postMessage(clusterCmd('a', 'clusterJoin', { code: 'ABC234' }));
    port2.postMessage(clusterCmd('b', 'clusterAccept', { clusterId: 'c1' }));
    port2.postMessage(clusterCmd('c', 'clusterJoin', { code: 'ABC235' }));
    await until(() => frames().some((g) => g.t === 'err'));
    expect(sent.map((s) => (JSON.parse(s) as { d: { reqId: string; cmd: string } }).d)).toMatchObject([
      { reqId: 's:a', cmd: 'clusterJoin' },
      { reqId: 's:b', cmd: 'clusterAccept' },
    ]);
    expect(frames().find((g) => g.t === 'err')!.d).toMatchObject({ code: 'E_RATE', reqId: 'c' });
    done();
  });
});
