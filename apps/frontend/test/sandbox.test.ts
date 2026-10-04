// @vitest-environment jsdom
import { createSandboxInit, MAX_SOURCE_BYTES, SANDBOX_ATTRIBUTES, SANDBOX_HTML_PATH } from '@daemonet/sandbox';
import type { OperatorSelf } from '@daemonet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createLog } from '../src/game/log.ts';
import {
  createBrowserSandboxEnv,
  createSandboxRunner,
  LOG_LINES_PER_SECOND,
  START_NOTICE_MS,
  type SandboxClient,
  type SandboxEnv,
  type SandboxFrame,
} from '../src/game/sandbox.ts';

const self: OperatorSelf = {
  id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null, org: null, cluster: null,
};

type Handler = (v: unknown) => void;

/** The parts of GameClient the runner uses, driven by the test. */
class FakeClient {
  operatorId = 'op1';
  role: 'controller' | 'spectator' = 'controller';
  tick = 40;
  subnet = 'lo';
  self: OperatorSelf | undefined = self;
  readonly entities = new Map();
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Set<Handler>>();
  on(name: string, h: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }
  emit(name: string, value?: unknown): void {
    for (const h of this.handlers.get(name) ?? []) h(value);
  }
  listenerCount(): number {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
  sendFrame(raw: string): void {
    this.sent.push(raw);
  }
}

type Post = { message: unknown; origin: string; transfer: unknown[] | undefined };

class FakeFrame implements SandboxFrame {
  removed = false;
  readonly posts: Post[] = [];
  private readonly loads: (() => void)[] = [];
  readonly contentWindow = {
    postMessage: (message: unknown, origin: string, transfer?: unknown[]) => {
      this.posts.push({ message, origin, transfer });
    },
  };
  addEventListener(_type: 'load', l: () => void): void {
    this.loads.push(l);
  }
  remove(): void {
    this.removed = true;
  }
  load(): void {
    for (const l of this.loads) l();
  }
  /** The sandbox's end of the channel, from the init post. */
  port(): MessagePort {
    const init = this.posts.find((p) => (p.message as { type?: string }).type === 'init');
    if (!init) throw new Error('no init posted');
    return init.transfer![0] as MessagePort;
  }
}

function setup() {
  const frames: FakeFrame[] = [];
  const log = createLog(1000);
  let listener: ((ev: { source: unknown; data: unknown }) => void) | null = null;
  const clock = { now: 1_000 };
  const ports: MessagePort[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const online = { value: true };
  const env: SandboxEnv = {
    createFrame: () => {
      const f = new FakeFrame();
      frames.push(f);
      return f;
    },
    createChannel: () => {
      const ch = new MessageChannel();
      ports.push(ch.port1, ch.port2);
      return ch;
    },
    onMessage: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    log,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const t = { at: clock.now + ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    isOnline: () => online.value,
  };
  /** Moves the clock and runs the timers that are due. */
  const advance = (ms: number) => {
    clock.now += ms;
    for (const t of timers.splice(0)) {
      if (t.cancelled) continue;
      if (t.at <= clock.now) t.fn();
      else timers.push(t);
    }
  };
  const runner = createSandboxRunner(env);
  const client = new FakeClient();
  /** Posts a message to the host as if from `source`. */
  const fromFrame = (source: unknown, data: unknown) => listener?.({ source, data });
  const texts = () => log.get().map((e) => `${e.kind}:${e.text}`);
  return {
    runner,
    client,
    asClient: client as unknown as SandboxClient,
    frames,
    log,
    texts,
    fromFrame,
    clock,
    advance,
    online,
    hasListener: () => listener !== null,
    cleanup: () => ports.forEach((p) => p.close()),
  };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
}

/** Collects what the sandbox's end of the channel receives. */
function listen(port: MessagePort) {
  const got: unknown[] = [];
  port.addEventListener('message', (e) => got.push(e.data));
  port.start();
  const frames = () => got.filter((g): g is string => typeof g === 'string').map((g) => JSON.parse(g) as { t: string; d: Record<string, unknown> });
  return { got, frames };
}

const auth = JSON.stringify({ t: 'auth', seq: 1, d: { token: 'sandbox' } });
const cmd = (seq: number, reqId: string) => JSON.stringify({ t: 'cmd', seq, d: { reqId, cmd: 'stop', actor: 'self', args: {} } });

let current: ReturnType<typeof setup> | null = null;
afterEach(() => {
  current?.runner.stop();
  current?.cleanup();
  current = null;
});

describe('sandbox runner', () => {
  it('posts createSandboxInit(source) with the channel port once the frame has loaded, once', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'export default () => {}');
    expect(t.runner.getStatus()).toBe('starting');
    expect(t.frames).toHaveLength(1);
    const f = t.frames[0]!;
    expect(f.posts).toEqual([]);
    f.load();
    f.load();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.message).toEqual(createSandboxInit('export default () => {}'));
    expect(f.posts[0]!.origin).toBe('*');
    expect(f.posts[0]!.transfer).toHaveLength(1);
  });

  it('waits for the host snapshot before building the sandbox', async () => {
    const t = (current = setup());
    t.client.self = undefined;
    await t.runner.start(t.asClient, 'x');
    expect(t.frames).toHaveLength(0);
    t.client.self = self;
    t.client.emit('ready');
    expect(t.frames).toHaveLength(1);
  });

  it('wires the frame port to the client through the bridge: local auth, s:-prefixed commands, relayed frames', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    t.frames[0]!.load();
    const sb = listen(t.frames[0]!.port());
    t.frames[0]!.port().postMessage(auth);
    await until(() => sb.frames().length >= 2);
    expect(sb.frames().map((f) => f.t)).toEqual(['authOk', 'snapshot']);
    expect((sb.frames()[1]!.d.self as OperatorSelf).name).toBe('alice');
    t.frames[0]!.port().postMessage(cmd(2, 'r1'));
    await until(() => t.client.sent.length >= 1);
    expect(JSON.parse(t.client.sent[0]!).d.reqId).toBe('s:r1');
    t.client.emit('frame', JSON.stringify({ t: 'ack', seq: 9, d: { reqId: 's:r1', result: { ok: true } } }));
    t.client.emit('frame', JSON.stringify({ t: 'ack', seq: 10, d: { reqId: 'c1', result: {} } }));
    await until(() => sb.frames().length >= 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(sb.frames().slice(2).map((f) => f.d.reqId)).toEqual(['r1']);
  });

  it('logs a one-shot hint when no started arrives after init, without stopping anything', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    f.load();
    t.advance(START_NOTICE_MS - 1);
    expect(t.texts().some((x) => x.includes('sandbox did not start'))).toBe(false);
    t.advance(1);
    t.advance(60_000);
    expect(t.texts().filter((x) => x === 'system:sandbox did not start — is /sandbox.html served?')).toHaveLength(1);
    expect(f.removed).toBe(false);
    expect(t.runner.getStatus()).toBe('starting');
  });

  it('does not log the hint once started arrived', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    f.load();
    t.fromFrame(f.contentWindow, { type: 'started' });
    t.advance(START_NOTICE_MS * 2);
    expect(t.texts().some((x) => x.includes('sandbox did not start'))).toBe(false);
  });

  it('accepts only validated messages from the frame window and renders logs as text', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    t.fromFrame({}, { type: 'started' });
    t.fromFrame(f.contentWindow, { type: 'bogus' });
    t.fromFrame(f.contentWindow, null);
    expect(t.runner.getStatus()).toBe('starting');
    t.fromFrame(f.contentWindow, { type: 'started' });
    expect(t.runner.getStatus()).toBe('running');
    t.fromFrame(f.contentWindow, { type: 'log', level: 'log', args: ['online as', 'alice', 3, { a: 1 }] });
    t.fromFrame(f.contentWindow, { type: 'log', level: 'warn', args: ['<b>careful</b>'] });
    t.fromFrame(f.contentWindow, { type: 'error', message: 'boom' });
    expect(t.texts()).toContain('script:online as alice 3 {"a":1}');
    expect(t.texts()).toContain('script:[warn] <b>careful</b>');
    expect(t.texts()).toContain('error:boom');
    // an error alone does not end the script
    expect(t.runner.getStatus()).toBe('running');
    expect(f.removed).toBe(false);
  });

  it("treats finished 'returned' as still alive and the other reasons as dead", async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    f.load();
    const sb = listen(f.port());
    t.fromFrame(f.contentWindow, { type: 'started' });
    t.fromFrame(f.contentWindow, { type: 'finished', reason: 'returned' });
    expect(t.runner.getStatus()).toBe('running');
    expect(f.removed).toBe(false);
    t.fromFrame(f.contentWindow, { type: 'finished', reason: 'unresponsive' });
    expect(t.runner.getStatus()).toBe('errored');
    expect(f.removed).toBe(true);
    // the bridge closed the sandbox's socket
    await until(() => sb.got.some((g) => (g as { type?: string }).type === 'close'));
    expect(sb.got).toContainEqual({ type: 'close', code: 1000, reason: 'host closed' });
    expect(t.texts().some((x) => x.startsWith('error:script stopped: unresponsive'))).toBe(true);
    expect(t.client.listenerCount()).toBe(0);
    expect(t.hasListener()).toBe(false);
  });

  it.each([
    ['stopped', 'stopped'],
    ['crashed', 'errored'],
  ] as const)("finished '%s' removes the frame (status %s)", async (reason, status) => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    t.fromFrame(f.contentWindow, { type: 'finished', reason });
    expect(t.runner.getStatus()).toBe(status);
    expect(f.removed).toBe(true);
  });

  it('stop() posts {type: stop} to the frame and removes it', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    f.load();
    t.runner.stop();
    expect(f.posts.at(-1)!.message).toEqual({ type: 'stop' });
    expect(f.removed).toBe(true);
    expect(t.runner.getStatus()).toBe('stopped');
    expect(t.texts()).toContain('system:script stopped');
  });

  it('shows the size error instead of posting a source above MAX_SOURCE_BYTES', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x'.repeat(MAX_SOURCE_BYTES + 1));
    expect(t.frames).toHaveLength(0);
    expect(t.runner.getStatus()).toBe('errored');
    expect(t.texts().some((x) => x.startsWith('error:script not started') && x.includes(String(MAX_SOURCE_BYTES)))).toBe(true);
  });

  it('rate-limits the script log display', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    for (let i = 0; i < 100; i++) t.fromFrame(f.contentWindow, { type: 'log', level: 'log', args: [`line ${i}`] });
    expect(t.texts().filter((x) => x.startsWith('script:'))).toHaveLength(LOG_LINES_PER_SECOND);
    t.advance(999);
    expect(t.texts().some((x) => x.includes('suppressed'))).toBe(false);
    // the summary arrives when the window ends, without waiting for another message
    t.advance(1);
    expect(t.texts().at(-1)).toBe(`system:${100 - LOG_LINES_PER_SECOND} script log lines suppressed`);
    t.fromFrame(f.contentWindow, { type: 'log', level: 'log', args: ['later'] });
    expect(t.texts().at(-1)).toBe('script:later');
    expect(t.texts().filter((x) => x.includes('suppressed'))).toHaveLength(1);
  });

  it('rebuilds channel, bridge and frame after a host reconnect and re-posts init once state is back', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const first = t.frames[0]!;
    first.load();
    const sb = listen(first.port());
    t.fromFrame(first.contentWindow, { type: 'started' });
    t.client.emit('disconnect', { code: 1006, reason: '' });
    expect(first.removed).toBe(true);
    expect(t.runner.getStatus()).toBe('starting');
    await until(() => sb.got.some((g) => (g as { type?: string }).type === 'close'));
    expect(t.texts().some((x) => x.includes('restart from main(game)'))).toBe(true);
    // a late message from the old frame is ignored
    t.fromFrame(first.contentWindow, { type: 'started' });
    expect(t.runner.getStatus()).toBe('starting');
    expect(t.frames).toHaveLength(1);
    t.client.emit('reconnect');
    t.client.emit('tick', 41);
    expect(t.frames).toHaveLength(2);
    const second = t.frames[1]!;
    second.load();
    expect(second.posts[0]!.message).toEqual(createSandboxInit('x'));
    expect(second.port()).not.toBe(first.port());
    expect(t.texts().some((x) => x.includes('script restarted'))).toBe(true);
    t.client.emit('tick', 42);
    expect(t.frames).toHaveLength(2);
  });

  it('treats a mid-session snapshot (travel) like a reconnect: new channel, bridge and frame, init re-posted, player told', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const first = t.frames[0]!;
    first.load();
    const sb = listen(first.port());
    t.fromFrame(first.contentWindow, { type: 'started' });
    expect(t.runner.getStatus()).toBe('running');
    t.client.subnet = 'lan';
    t.client.emit('ready');
    expect(first.removed).toBe(true);
    await until(() => sb.got.some((g) => (g as { type?: string }).type === 'close'));
    expect(t.frames).toHaveLength(2);
    const second = t.frames[1]!;
    second.load();
    expect(second.posts[0]!.message).toEqual(createSandboxInit('x'));
    expect(second.port()).not.toBe(first.port());
    expect(t.texts()).toContain('system:script restarted: travelled to lan');
    // the old frame is dead to the host, the new one answers
    t.fromFrame(first.contentWindow, { type: 'log', level: 'log', args: ['ghost'] });
    expect(t.texts().some((x) => x.includes('ghost'))).toBe(false);
    t.fromFrame(second.contentWindow, { type: 'started' });
    expect(t.runner.getStatus()).toBe('running');
    // the new run's local auth hands out the destination world
    const sb2 = listen(second.port());
    second.port().postMessage(auth);
    await until(() => sb2.frames().length >= 2);
    expect((sb2.frames()[1]!.d as { subnet?: string }).subnet).toBe('lan');
  });

  it('does not restart on the first snapshot of a start that was waiting for state', async () => {
    const t = (current = setup());
    t.client.self = undefined;
    await t.runner.start(t.asClient, 'x');
    t.client.self = self;
    t.client.emit('ready');
    expect(t.frames).toHaveLength(1);
    expect(t.texts().some((x) => x.includes('travelled'))).toBe(false);
    t.client.emit('tick', 41);
    expect(t.frames).toHaveLength(1);
  });

  it("stops and removes the frame on the bridge's flood violation", async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    const f = t.frames[0]!;
    f.load();
    const port = f.port();
    for (let i = 0; i < 2100; i++) port.postMessage('x');
    await until(() => f.removed);
    expect(f.removed).toBe(true);
    expect(t.runner.getStatus()).toBe('errored');
    expect(t.texts()).toContain('error:script stopped: flooding');
  });

  it('refuses to start while the host socket is not online', async () => {
    const t = (current = setup());
    t.online.value = false;
    await t.runner.start(t.asClient, 'x');
    expect(t.frames).toHaveLength(0);
    expect(t.runner.getStatus()).toBe('stopped');
    expect(t.texts().some((x) => x.startsWith('error:script not started: not connected'))).toBe(true);
  });

  it('gives the script 6 commands per tick (the host keeps 2 of the server budget)', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'x');
    t.frames[0]!.load();
    const port = t.frames[0]!.port();
    const sb = listen(port);
    port.postMessage(auth);
    await until(() => sb.frames().length >= 2);
    for (let i = 0; i < 8; i++) port.postMessage(cmd(2 + i, `r${i}`));
    await until(() => sb.frames().filter((f) => f.t === 'err').length >= 2);
    expect(t.client.sent).toHaveLength(6);
  });

  it('a new start replaces the running sandbox', async () => {
    const t = (current = setup());
    await t.runner.start(t.asClient, 'a');
    await t.runner.start(t.asClient, 'b');
    expect(t.frames).toHaveLength(2);
    expect(t.frames[0]!.removed).toBe(true);
    expect(t.frames[1]!.removed).toBe(false);
    t.frames[1]!.load();
    expect(t.frames[1]!.posts[0]!.message).toEqual(createSandboxInit('b'));
  });
});

describe('browser sandbox env', () => {
  it('embeds /sandbox.html in an allow-scripts-only iframe, never srcdoc', () => {
    const env = createBrowserSandboxEnv();
    const frame = env.createFrame() as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe(SANDBOX_ATTRIBUTES);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('src')).toBe(SANDBOX_HTML_PATH);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.isConnected).toBe(true);
    frame.remove();
  });
});
