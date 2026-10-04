import * as sdk from '@daemonet/sdk';
import type { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../src/bridge.js';
import { buildSandboxDocument, SANDBOX_CSP, SANDBOX_HTML_PATH, SANDBOX_STATIC_FILES } from '../src/document.js';
import { runFrame, type FrameWorker } from '../src/frame.js';
import { createSandboxInit, LOG_BUDGET, MAX_SOURCE_BYTES, parseHostMessage, validateSandboxMessage, type SandboxMessage } from '../src/protocol.js';
import { errorMessage, runWorker, type WorkerMessage } from '../src/worker-runtime.js';

const self: OperatorSelf = {
  id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null, arena: null, org: null, cluster: null,
};
const state = () => ({ operatorId: 'op1', role: 'controller' as const, tick: 40, subnet: 'lo', self, entities: [] });
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('sandbox document', () => {
  it('is static, loads only same-origin scripts, and carries the CSP as a meta fallback', () => {
    const html = buildSandboxDocument();
    expect(buildSandboxDocument()).toBe(html);
    expect(SANDBOX_HTML_PATH).toBe('/sandbox.html');
    expect(html).toContain('<script src="/sandbox/bootstrap.js"></script>');
    expect(html.match(/<script/g)).toHaveLength(1); // no inline script, no import map
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`);
    expect(SANDBOX_CSP).toBe("default-src 'none'; script-src 'self' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'");
    expect(SANDBOX_STATIC_FILES).toEqual(['sandbox.html', 'sandbox/bootstrap.js', 'sandbox/worker.js', 'sandbox/sdk.js']);
  });
});

describe('host messages', () => {
  const port = new MessageChannel().port1;
  it('accepts init with a string source within 256 KiB and a port, and stop', () => {
    expect(parseHostMessage({ type: 'init', source: 'x' }, [port])).toEqual({ type: 'init', source: 'x', port });
    expect(parseHostMessage({ type: 'stop' }, [])).toEqual({ type: 'stop' });
  });

  it('rejects malformed init and oversized sources (bytes, not characters)', () => {
    const big = 'é'.repeat(MAX_SOURCE_BYTES / 2 + 1); // fits in characters, not in UTF-8 bytes
    for (const [data, ports] of [
      [{ type: 'init', source: 'x' }, []],
      [{ type: 'init', source: 5 }, [port]],
      [{ type: 'init' }, [port]],
      [{ type: 'init', source: big }, [port]],
      [null, [port]],
      ['init', [port]],
      [{ type: 'other' }, []],
    ] as const) {
      expect(parseHostMessage(data, ports)).toBeNull();
    }
    expect(() => createSandboxInit(big)).toThrow(RangeError);
    expect(createSandboxInit('ok')).toEqual({ type: 'init', source: 'ok' });
  });

  it('validates sandbox messages including finished reasons', () => {
    expect(validateSandboxMessage({ type: 'started' })).toEqual({ type: 'started' });
    for (const reason of ['returned', 'stopped', 'unresponsive', 'crashed']) expect(validateSandboxMessage({ type: 'finished', reason })).toEqual({ type: 'finished', reason });
    expect(validateSandboxMessage({ type: 'finished' })).toBeNull();
    expect(validateSandboxMessage({ type: 'finished', reason: 'bogus' })).toBeNull();
    const log = validateSandboxMessage({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    expect(log).toEqual({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    const err = validateSandboxMessage({ type: 'error', message: 'm'.repeat(10000), stack: 's'.repeat(100000) });
    expect(err?.type === 'error' && err.message.length).toBeLessThanOrEqual(2000);
    expect(err?.type === 'error' && (err.stack?.length ?? 0)).toBeLessThanOrEqual(8000);
    const many = validateSandboxMessage({ type: 'log', level: 'log', args: Array.from({ length: 50 }, (_, i) => i) });
    expect(many?.type === 'log' && many.args.length).toBe(10);
    const bad: unknown[] = [null, 'x', 1, [], {}, { type: 'init' }, { type: 'hb' }, { type: 'log', level: 'fatal', args: [] }, { type: 'log', level: 'log', args: 'x' }, { type: 'error', message: 5 }, { type: 'error', message: 'm', stack: 5 }];
    for (const b of bad) expect(validateSandboxMessage(b)).toBeNull();
  });
});

/** A frame with a fake worker and a manual clock. */
function frame() {
  const toParent: SandboxMessage[] = [];
  let listener: ((data: unknown, ports: readonly unknown[]) => void) | undefined;
  let clock = 0;
  const timers: Array<{ fn: () => void; every: number; next: number; live: boolean }> = [];
  const workers: Array<FrameWorker & { posted: Array<[unknown, unknown[]]>; terminated: boolean; emit(data: unknown): void; fail(message: string): void }> = [];
  runFrame({
    postToParent: (m) => toParent.push(m),
    onParentMessage: (l) => (listener = l),
    createWorker: () => {
      const w = {
        onmessage: null as FrameWorker['onmessage'],
        onerror: null as FrameWorker['onerror'],
        posted: [] as Array<[unknown, unknown[]]>,
        terminated: false,
        postMessage(data: unknown, transfer: unknown[]) {
          this.posted.push([data, transfer]);
        },
        terminate() {
          this.terminated = true;
        },
        emit(data: unknown) {
          this.onmessage?.({ data });
        },
        fail(message: string) {
          this.onerror?.({ message });
        },
      };
      workers.push(w);
      return w;
    },
    now: () => clock,
    setInterval: (fn, every) => {
      const t = { fn, every, next: clock + every, live: true };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock = due.next;
      due.next += due.every;
      due.fn();
    }
    clock = end;
  };
  const port = new MessageChannel().port1;
  return { toParent, workers, advance, port, send: (data: unknown, ports: unknown[] = []) => listener?.(data, ports) };
}

describe('runFrame (iframe main thread)', () => {
  it('starts one worker on a valid init, transferring the port with the source', () => {
    const f = frame();
    f.send({ type: 'init', source: 5 }, [f.port]);
    f.send({ type: 'init', source: 'x' }, []);
    expect(f.workers).toHaveLength(0);
    f.send({ type: 'init', source: 'export default () => {}' }, [f.port]);
    f.send({ type: 'init', source: 'again' }, [f.port]);
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]!.posted).toEqual([[{ type: 'init', source: 'export default () => {}' }, [f.port]]]);
  });

  it('forwards validated worker messages, consumes heartbeats, and shares one budget across logs and errors', () => {
    const f = frame();
    f.send({ type: 'init', source: 's' }, [f.port]);
    const w = f.workers[0]!;
    w.emit({ type: 'started' });
    w.emit({ type: 'hb' });
    w.emit({ type: 'evil', html: '<b>' });
    for (let i = 0; i < LOG_BUDGET; i++) w.emit(i % 2 ? { type: 'log', level: 'log', args: [i] } : { type: 'error', message: String(i) });
    w.emit({ type: 'log', level: 'log', args: ['over budget'] });
    w.emit({ type: 'error', message: 'over budget' });
    w.emit({ type: 'finished', reason: 'stopped' }); // the worker cannot choose the reason
    expect(f.toParent[0]).toEqual({ type: 'started' });
    expect(f.toParent.filter((m) => m.type === 'log' || m.type === 'error')).toHaveLength(LOG_BUDGET);
    expect(f.toParent.at(-1)).toEqual({ type: 'finished', reason: 'returned' });
    expect(w.terminated).toBe(false); // main() returned; its callbacks keep running
  });

  it('terminates the worker on stop and ignores it afterwards', () => {
    const f = frame();
    f.send({ type: 'init', source: 's' }, [f.port]);
    const w = f.workers[0]!;
    f.send({ type: 'stop' });
    expect(w.terminated).toBe(true);
    expect(f.toParent).toEqual([{ type: 'finished', reason: 'stopped' }]);
    w.emit({ type: 'log', level: 'log', args: ['late'] });
    f.send({ type: 'stop' });
    f.send({ type: 'init', source: 's' }, [f.port]);
    expect(f.toParent).toHaveLength(1);
    expect(f.workers).toHaveLength(1);
  });

  it('kills a worker that misses heartbeats for 5 s, and keeps one that beats', () => {
    const f = frame();
    f.send({ type: 'init', source: 's' }, [f.port]);
    const w = f.workers[0]!;
    for (let i = 0; i < 10; i++) {
      f.advance(1000);
      w.emit({ type: 'hb' });
    }
    expect(w.terminated).toBe(false);
    f.advance(4900);
    expect(w.terminated).toBe(false);
    f.advance(700);
    expect(w.terminated).toBe(true);
    expect(f.toParent).toEqual([{ type: 'finished', reason: 'unresponsive' }]);
  });

  it('reports a worker that fails to start as crashed', () => {
    const f = frame();
    f.send({ type: 'init', source: 's' }, [f.port]);
    f.workers[0]!.fail('importScripts failed');
    expect(f.workers[0]!.terminated).toBe(true);
    expect(f.toParent).toEqual([
      { type: 'error', message: 'sandbox worker failed: importScripts failed' },
      { type: 'finished', reason: 'crashed' },
    ]);
  });
});

describe('errorMessage', () => {
  it('coerces message and stack to strings', () => {
    expect(errorMessage(new Error('boom')).message).toBe('boom');
    expect(typeof errorMessage(new Error('boom')).stack).toBe('string');
    expect(errorMessage({ message: 'x', stack: 42 })).toEqual({ type: 'error', message: 'x', stack: '42' });
    expect(errorMessage('plain')).toEqual({ type: 'error', message: 'plain' });
    expect(errorMessage(null)).toEqual({ type: 'error', message: 'null' });
    const hostile = {
      get message(): string {
        throw new Error('nope');
      },
    };
    expect(errorMessage(hostile).type).toBe('error');
  });
});

/** Runs the worker runtime in-process against a real bridge; the user module is imported from a data: URL. */
function workerHarness(source: string) {
  const posted: WorkerMessage[] = [];
  let listener: ((data: unknown, ports: readonly unknown[]) => void) | undefined;
  const intervals: unknown[] = [];
  // the data: module logs through the global console, as the player's module does in the worker
  const realConsole = { ...console };
  const { port1, port2 } = new MessageChannel();
  const sent: string[] = [];
  const bridge = createBridge({ port: port1, send: (d) => sent.push(d), state });
  runWorker({
    post: (m) => posted.push(m),
    onMessage: (l) => (listener = l),
    sdk,
    importModule: (src) => import(`data:text/javascript,${encodeURIComponent(src)}`) as Promise<{ default?: unknown }>,
    console: console as unknown as Record<string, unknown>,
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      intervals.push(h);
      return h;
    },
    heartbeatMs: 10,
  });
  listener?.({ type: 'init', source }, [port2]);
  return {
    posted,
    sent,
    bridge,
    done: () => {
      Object.assign(console, realConsole);
      for (const h of intervals) clearInterval(h as ReturnType<typeof setInterval>);
      bridge.close();
    },
  };
}

describe('runWorker (inside the worker)', () => {
  it('connects the real SDK through the bridge, runs main(game), forwards logs and beats', async () => {
    const h = workerHarness(`export default async function main(game) {
      console.log('hello', game.self.name, game.tick, { deep: true });
      await game.operator.stop();
      console.info('stop acked');
    }`);
    await until(() => h.sent.length >= 1);
    expect(JSON.parse(h.sent[0]!).d.reqId).toBe('s:c1');
    h.bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId: 's:c1' } }));
    await until(() => h.posted.some((m) => m.type === 'finished'));
    const visible = h.posted.filter((m) => m.type !== 'hb');
    expect(visible).toEqual([
      { type: 'started' },
      { type: 'log', level: 'log', args: ['hello', 'alice', 40, { deep: true }] },
      { type: 'log', level: 'info', args: ['stop acked'] },
      { type: 'finished', reason: 'returned' },
    ]);
    expect(h.posted.some((m) => m.type === 'hb')).toBe(true);
    h.done();
  });

  it('reports a script without a default export and a throwing main as errors', async () => {
    const a = workerHarness('export const x = 1;');
    await until(() => a.posted.some((m) => m.type === 'error'));
    expect(a.posted.find((m) => m.type === 'error')).toMatchObject({ message: 'the script must export default function main(game)' });
    a.done();
    const b = workerHarness(`export default function main() { throw { message: 'bad', stack: 7 }; }`);
    await until(() => b.posted.some((m) => m.type === 'error'));
    expect(b.posted.find((m) => m.type === 'error')).toEqual({ type: 'error', message: 'bad', stack: '7' });
    b.done();
  });

  it('ignores a second init and messages without a port', async () => {
    const posted: WorkerMessage[] = [];
    let listener: ((data: unknown, ports: readonly unknown[]) => void) | undefined;
    let imports = 0;
    runWorker({
      post: (m) => posted.push(m),
      onMessage: (l) => (listener = l),
      sdk,
      importModule: async () => {
        imports++;
        return {};
      },
      console: {},
      setInterval: () => 0,
    });
    listener?.({ type: 'init', source: 'x' }, []);
    expect(imports).toBe(0);
    const { port2 } = new MessageChannel();
    listener?.({ type: 'init', source: 'x' }, [port2]);
    listener?.({ type: 'init', source: 'x' }, [port2]);
    await until(() => posted.length > 0);
    expect(imports).toBe(1);
    port2.close();
  });
});
