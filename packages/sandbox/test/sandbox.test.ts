import { GameClient, PortSocket, staticToken } from '@daemonet/sdk';
import type { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../src/bridge.js';
import { buildSandboxHtml, validateSandboxMessage } from '../src/srcdoc.js';

const self: OperatorSelf = {
  id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null,
};
const state = () => ({ operatorId: 'op1', role: 'controller' as const, tick: 40, subnet: 'lo', self, entities: [] });
/** Ports deliver asynchronously; wait (a few macrotasks) until `pred` holds. */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const cmd = (seq: number, reqId: string) => JSON.stringify({ t: 'cmd', seq, d: { reqId, cmd: 'stop', actor: 'self', args: {} } });
const auth = JSON.stringify({ t: 'auth', seq: 1, d: { token: 'sandbox' } });

function setup() {
  const { port1, port2 } = new MessageChannel();
  const sent: string[] = [];
  const bridge = createBridge({ port: port1, send: (d) => sent.push(d), state });
  const got: string[] = [];
  port2.addEventListener('message', (e) => got.push((e as MessageEvent).data as string));
  port2.start();
  return {
    port2,
    sent,
    got,
    bridge,
    done: () => {
      bridge.close();
      port2.close();
    },
  };
}

describe('createBridge', () => {
  it('answers auth locally with authOk + snapshot and never forwards it', async () => {
    const { port2, sent, got, done } = setup();
    port2.postMessage(auth);
    await until(() => got.length >= 2);
    expect(got.map((g) => JSON.parse(g).t)).toEqual(['authOk', 'snapshot']);
    expect(JSON.parse(got[1]!).d.self.name).toBe('alice');
    expect(sent).toEqual([]);
    done();
  });

  it('forwards commands up to 8 per tick, relays deltas, and drops server auth frames', async () => {
    const { port2, sent, got, bridge, done } = setup();
    port2.postMessage(auth);
    await until(() => got.length >= 2);
    for (let i = 0; i < 10; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await until(() => sent.length >= 8 && got.length >= 4);
    expect(sent).toHaveLength(8);
    expect(got.filter((g) => JSON.parse(g).t === 'err').map((g) => JSON.parse(g).d.code)).toEqual(['E_RATE', 'E_RATE']);
    bridge.deliver(JSON.stringify({ t: 'authOk', seq: 9, d: {} }));
    bridge.deliver(JSON.stringify({ t: 'delta', seq: 10, d: { tick: 41, upserts: [], removes: [], events: [] } }));
    port2.postMessage(cmd(20, 'again'));
    port2.postMessage(JSON.stringify({ t: 'reauth', seq: 21, d: { token: 'x' } }));
    await until(() => sent.length >= 9);
    await settle();
    expect(got.filter((g) => JSON.parse(g).t === 'delta')).toHaveLength(1);
    expect(got.some((g) => JSON.parse(g).t === 'authOk' && JSON.parse(g).seq === 9)).toBe(false);
    expect(sent).toHaveLength(9);
    expect(sent.some((s) => s.includes('reauth'))).toBe(false);
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
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 5, d: { reqId } }));
    await expect(pending).resolves.toBeUndefined();
    let ticks = 0;
    client.on('tick', () => ticks++);
    bridge.deliver(JSON.stringify({ t: 'delta', seq: 6, d: { tick: 41, upserts: [], removes: [], events: [] } }));
    await until(() => ticks >= 1);
    expect(ticks).toBe(1);
    expect(client.tick).toBe(41);
    client.close();
    bridge.close();
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
    const { port2, sent, got, done } = setup();
    port2.postMessage(auth);
    await until(() => got.length >= 2);
    port2.postMessage({ t: 'cmd', d: {} }); // not a string
    port2.postMessage('not json');
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'x', cmd: 'rm -rf', actor: 'self', args: {} } })); // unknown command
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 3, d: { cmd: 'stop', actor: 'self', args: {} } })); // no reqId
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 4, d: { reqId: 'big', cmd: 'stop', actor: 'self', args: {}, pad: 'x'.repeat(40000) } })); // oversized
    port2.postMessage(JSON.stringify({ t: 'nope', seq: 5, d: {} }));
    await settle();
    expect(sent).toEqual([]);
    // invalid frames earn an E_INVALID reply at most (never a forward)
    expect(got.slice(2).every((g) => JSON.parse(g).t === 'err')).toBe(true);
    done();
  });

  it('forwards only the validated command, stripping unknown fields', async () => {
    const { port2, sent, done } = setup();
    port2.postMessage(auth);
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 2, token: 'steal', d: { reqId: 'a', cmd: 'stop', actor: 'self', args: {}, extra: 1 } }));
    await until(() => sent.length >= 1);
    const fwd = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(fwd).toEqual({ t: 'cmd', seq: 2, d: { reqId: 'a', cmd: 'stop', actor: 'self', args: {} } });
    done();
  });

  it('answers a repeated auth without re-sending state and never forwards pings', async () => {
    const { port2, sent, got, done } = setup();
    port2.postMessage(auth);
    port2.postMessage(JSON.stringify({ t: 'auth', seq: 2, d: { token: 'other' } }));
    port2.postMessage(JSON.stringify({ t: 'ping', seq: 3, d: {} }));
    await settle();
    expect(got.map((g) => JSON.parse(g).t)).toEqual(['authOk', 'snapshot', 'pong']);
    expect(sent).toEqual([]);
    done();
  });

  it('caps E_RATE replies so a flood cannot spin the bridge', async () => {
    const { port2, sent, got, done } = setup();
    port2.postMessage(auth);
    for (let i = 0; i < 100; i++) port2.postMessage(cmd(2 + i, `r${i}`));
    await settle();
    expect(sent).toHaveLength(8);
    expect(got.filter((g) => JSON.parse(g).t === 'err').length).toBeLessThanOrEqual(8);
    done();
  });
});

describe('buildSandboxHtml', () => {
  it('embeds the SDK via an import map, the user script as a data: module, and a strict CSP', () => {
    const html = buildSandboxHtml({ sdkBundle: 'export const x = 1;', source: 'export default function main(game) { game.operator.stop(); }' });
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('"@daemonet/sdk":"data:text/javascript;base64,');
    expect(html).toContain(`Content-Security-Policy`);
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain(`connect-src 'none'`);
    expect(html).toContain('data:text/javascript;base64,' + btoa('export default function main(game) { game.operator.stop(); }'));
    expect(html).not.toContain('</script></script>');
  });

  it('cannot be broken out of with a closing script tag in the source', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: '</script><script>alert(1)</script>' });
    // the source only appears base64-encoded, so a literal closing tag never reaches the HTML
    expect(html.split('</script>')).toHaveLength(3);
  });

  it('creates the in-sandbox client with reconnect disabled and a placeholder credential', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: 'export default () => {}' });
    expect(html).toContain('reconnect: false');
    expect(html).toContain("staticToken('sandbox')");
  });
});

describe('validateSandboxMessage', () => {
  it('accepts well-formed messages and clamps oversized fields', () => {
    expect(validateSandboxMessage({ type: 'started' })).toEqual({ type: 'started' });
    expect(validateSandboxMessage({ type: 'finished' })).toEqual({ type: 'finished' });
    const log = validateSandboxMessage({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    expect(log).toEqual({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    const err = validateSandboxMessage({ type: 'error', message: 'm'.repeat(10000), stack: 's'.repeat(100000) });
    expect(err?.type === 'error' && err.message.length).toBeLessThanOrEqual(2000);
    expect(err?.type === 'error' && (err.stack?.length ?? 0)).toBeLessThanOrEqual(8000);
    const many = validateSandboxMessage({ type: 'log', level: 'log', args: Array.from({ length: 50 }, (_, i) => i) });
    expect(many?.type === 'log' && many.args.length).toBe(10);
    const big = validateSandboxMessage({ type: 'log', level: 'log', args: ['x'.repeat(50000)] });
    expect(big?.type === 'log' && String(big.args[0]).length).toBeLessThanOrEqual(2100);
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [null, 'x', 1, [], {}, { type: 'init' }, { type: 'log', level: 'fatal', args: [] }, { type: 'log', level: 'log', args: 'x' }, { type: 'error', message: 5 }, { type: 'nope' }];
    for (const b of bad) expect(validateSandboxMessage(b)).toBeNull();
  });
});
