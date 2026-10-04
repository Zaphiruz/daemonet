/*
 * Browser verification for the sandbox. Served by verify/serve.mjs with a production-like host CSP;
 * the sandbox document gets SANDBOX_CSP. Prints one line per proof and a final summary line.
 */
import type { OperatorSelf } from '@daemonet/shared';
import { createBridge, createSandboxInit, MAX_SOURCE_BYTES, SANDBOX_ATTRIBUTES, SANDBOX_HTML_PATH, validateSandboxMessage, type SandboxMessage } from '../src/index.js';

const out = document.getElementById('log')!;
const log = (line: string) => {
  out.textContent += line + '\n';
};
const checks: Record<string, boolean> = {};
const check = (name: string, ok: boolean, detail = '') => {
  checks[name] = ok;
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const self: OperatorSelf = { id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null, arena: null, org: null, cluster: null };

interface Run {
  messages: SandboxMessage[];
  /** Resolves with the first `finished` whose reason is in `reasons`. */
  finished(reasons: string[], timeoutMs: number): Promise<SandboxMessage | null>;
  waitFor(pred: (m: SandboxMessage) => boolean, timeoutMs: number): Promise<SandboxMessage | null>;
  stop(): void;
  dispose(): void;
  sentToServer: string[];
}

/** Starts one sandbox run with a fake server that acks every forwarded command and ticks every 500 ms. */
function startRun(label: string, source: string): Run {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX_ATTRIBUTES);
  iframe.src = SANDBOX_HTML_PATH;
  iframe.hidden = true;
  const channel = new MessageChannel();
  const sentToServer: string[] = [];
  let tick = 7;
  const bridge = createBridge({
    port: channel.port1,
    send: (frame) => {
      sentToServer.push(frame);
      const reqId = (JSON.parse(frame) as { d: { reqId: string } }).d.reqId;
      // the host's own command c1 is acked too: the sandbox must never see it
      setTimeout(() => {
        bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId: 'c1' } }));
        bridge.deliver(JSON.stringify({ t: 'ack', seq: 2, d: { reqId } }));
      }, 20);
    },
    state: () => ({ operatorId: 'op1', role: 'controller', tick, subnet: 'lo', self, entities: [] }),
    onViolation: (kind) => log(`[${label}] bridge violation: ${kind}`),
  });
  const ticker = setInterval(() => {
    tick++;
    bridge.deliver(JSON.stringify({ t: 'delta', seq: tick, d: { tick, upserts: [], removes: [], events: [] } }));
  }, 500);
  const messages: SandboxMessage[] = [];
  const waiters = new Set<() => void>();
  const onMessage = (ev: MessageEvent) => {
    if (ev.source !== iframe.contentWindow) return;
    const m = validateSandboxMessage(ev.data);
    if (!m) return;
    messages.push(m);
    if (m.type === 'log') log(`[${label}] ${m.level}: ${m.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
    else if (m.type === 'error') log(`[${label}] error: ${m.message}`);
    else log(`[${label}] ${m.type}${m.type === 'finished' ? ` (${m.reason})` : ''}`);
    if (m.type === 'finished' && m.reason !== 'returned') bridge.close();
    for (const w of waiters) w();
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => iframe.contentWindow!.postMessage(createSandboxInit(source), '*', [channel.port2]), { once: true });
  document.body.append(iframe);

  const waitFor = (pred: (m: SandboxMessage) => boolean, timeoutMs: number) =>
    new Promise<SandboxMessage | null>((resolve) => {
      const test = () => {
        const hit = messages.find(pred);
        if (hit) {
          waiters.delete(test);
          clearTimeout(timer);
          resolve(hit);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(test);
        resolve(null);
      }, timeoutMs);
      waiters.add(test);
      test();
    });
  return {
    messages,
    sentToServer,
    waitFor,
    finished: (reasons, timeoutMs) => waitFor((m) => m.type === 'finished' && reasons.includes(m.reason), timeoutMs),
    stop: () => iframe.contentWindow?.postMessage({ type: 'stop' }, '*'),
    dispose: () => {
      clearInterval(ticker);
      bridge.close();
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

const logged = (run: Run, prefix: string): string | undefined => {
  for (const m of run.messages) {
    if (m.type !== 'log') continue;
    const line = m.args.map(String).join(' ');
    if (line.startsWith(prefix)) return line;
  }
  return undefined;
};

log(`host ready; document.cookie on host = ${JSON.stringify(document.cookie)}`);
const origin = location.origin;

// 1. The capability probe: identity, cookies, storage, network, and a command round trip.
const probe = startRun(
  'probe',
  `export default async function main(game) {
  console.log('started: tick', game.tick, 'me', game.self.name);
  let cookie;
  try { cookie = typeof document === 'undefined' ? 'no document in the worker' : 'readable?! ' + document.cookie; } catch (e) { cookie = e.name; }
  console.log('cookie blocked:', cookie);
  try { indexedDB.open('probe'); console.log('storage allowed?!'); } catch (e) { console.log('storage blocked:', e.name); }
  console.log('origin:', self.origin);
  try { await fetch(${JSON.stringify(origin + '/api/me')}); console.log('fetch allowed?!'); } catch (e) { console.log('fetch blocked:', e.name + ': ' + e.message); }
  try { new WebSocket(${JSON.stringify(origin.replace(/^http/, 'ws') + '/ws')}); console.log('websocket constructed (must not connect)'); } catch (e) { console.log('websocket blocked:', e.name); }
  try { await game.operator.stop(); console.log('stop acked'); } catch (e) { console.log('stop failed:', e.message); }
}`,
);
const done = await probe.finished(['returned', 'crashed', 'unresponsive'], 8000);
check('started', probe.messages.some((m) => m.type === 'started') && /tick 7 me alice/.test(logged(probe, 'started:') ?? ''), logged(probe, 'started:'));
check('cookie blocked', logged(probe, 'cookie blocked:') === 'cookie blocked: no document in the worker', logged(probe, 'cookie blocked:'));
check('storage blocked: SecurityError', logged(probe, 'storage blocked:') === 'storage blocked: SecurityError', logged(probe, 'storage blocked:'));
check('opaque origin', logged(probe, 'origin:') === 'origin: null', logged(probe, 'origin:'));
check('fetch blocked', (logged(probe, 'fetch blocked:') ?? '').startsWith('fetch blocked: TypeError'), logged(probe, 'fetch blocked:'));
check('stop acked', logged(probe, 'stop acked') === 'stop acked' && probe.sentToServer.length === 1 && probe.sentToServer[0]!.includes('"reqId":"s:c1"'), probe.sentToServer[0]);
check('finished', done?.type === 'finished' && done.reason === 'returned', JSON.stringify(done));
probe.stop();
check('stop ends a finished-but-alive script', (await probe.finished(['stopped'], 2000)) !== null);
probe.dispose();

// 2. A runaway script stopped by the host.
const runaway = startRun('runaway', `export default function main(game) { console.log('spinning'); while (true) {} }`);
await runaway.waitFor((m) => m.type === 'log', 8000);
const stopAt = performance.now();
runaway.stop();
const stopped = await runaway.finished(['stopped'], 2000);
check('runaway script stopped', stopped !== null, `finished(stopped) ${Math.round(performance.now() - stopAt)} ms after stop`);
runaway.dispose();

// 3. A runaway script nobody stops: the iframe's watchdog ends it.
const hung = startRun('watchdog', `export default function main(game) { console.log('spinning'); while (true) {} }`);
await hung.waitFor((m) => m.type === 'log', 8000);
const hungAt = performance.now();
const unresponsive = await hung.finished(['unresponsive'], 9000);
check('watchdog stopped unresponsive script', unresponsive !== null, `${Math.round(performance.now() - hungAt)} ms after the loop began`);
hung.dispose();

// 4. Oversized sources never reach the iframe.
let rejected = false;
try {
  createSandboxInit('x'.repeat(MAX_SOURCE_BYTES + 1));
} catch (e) {
  rejected = e instanceof RangeError;
}
check('oversized script rejected', rejected);

// 5. The server saw no request from any sandbox (fetch and WebSocket were blocked by CSP before the network).
const hits = (await (await fetch('/__verify/hits')).json()) as { hits: number };
check('no network from the sandbox', hits.hits === 0, `server saw ${hits.hits} sandbox requests`);

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
log(failed.length === 0 ? `ALL ${Object.keys(checks).length} CHECKS PASSED` : `FAILED: ${failed.join(', ')}`);
document.title = failed.length === 0 ? 'sandbox verify: PASS' : 'sandbox verify: FAIL';
