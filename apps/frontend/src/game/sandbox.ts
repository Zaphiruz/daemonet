import {
  createBridge,
  createSandboxInit,
  SANDBOX_ATTRIBUTES,
  SANDBOX_HTML_PATH,
  validateSandboxMessage,
  type Bridge,
  type BridgeViolation,
  type FinishReason,
  type HostState,
  type SandboxInit,
  type SandboxMessage,
} from '@daemonet/sandbox';
import type { GameClient, PortLike } from '@daemonet/sdk';
import type { OperatorSelf } from '@daemonet/shared';
import { useSyncExternalStore } from 'react';
import { log as appLog, type Log } from './log.ts';

/**
 * `starting` — waiting for the frame / the script's `started`; `running` — the script is alive (also
 * after `main()` returned: its callbacks keep running); `stopped` — ended by the player (or never
 * run); `errored` — ended on its own (crashed, unresponsive, flooding) or could not start.
 * `finished` is kept for the UI's type but the runner never reports it: a finished script is
 * either still alive (`returned`) or dead (`stopped` / `errored`).
 */
export type SandboxStatus = 'stopped' | 'starting' | 'running' | 'finished' | 'errored';

/** Script log lines shown per second; the rest are counted and summarised. */
export const LOG_LINES_PER_SECOND = 20;
/** At most one notice per kind of bridge violation in this window. */
const VIOLATION_NOTICE_MS = 5_000;
/** The script's share of the per-connection command budget (the bridge's default; the host keeps 2 of 8). */
const SCRIPT_COMMANDS_PER_TICK = 6;
/** How long after posting `init` the runner waits for the sandbox's `started` before it logs a hint. */
export const START_NOTICE_MS = 10_000;

/** The window inside the sandbox iframe, as far as the host uses it. */
export interface SandboxWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

/** The sandbox iframe, as far as the runner uses it. */
export interface SandboxFrame {
  readonly contentWindow: SandboxWindow | null;
  addEventListener(type: 'load', listener: () => void): void;
  remove(): void;
}

/** Everything the runner touches outside itself (the browser by default; fakes in tests). */
export interface SandboxEnv {
  /** Creates, configures and attaches a new sandbox iframe. */
  createFrame(): SandboxFrame;
  createChannel(): { port1: PortLike; port2: Transferable };
  /** Subscribes to `message` events on the host window. */
  onMessage(listener: (ev: { source: unknown; data: unknown }) => void): () => void;
  log: Log;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Whether the host's real socket is up: a script only starts on a live connection. */
  isOnline(): boolean;
}

/** The parts of the host's GameClient the runner uses. */
export type SandboxClient = Pick<GameClient, 'on' | 'sendFrame' | 'operatorId' | 'role' | 'tick' | 'subnet' | 'self' | 'entities'>;

let connectionOnline: () => boolean = () => false;
/** The connection store registers how to tell whether the host socket is up (avoids an import cycle). */
export function setConnectionProbe(probe: () => boolean): void {
  connectionOnline = probe;
}

/** The real embedding: `<iframe sandbox="allow-scripts" src="/sandbox.html">` (never srcdoc, never allow-same-origin). */
export function createBrowserSandboxEnv(): SandboxEnv {
  return {
    createFrame() {
      const frame = document.createElement('iframe');
      // the sandbox attribute must be in place before the frame navigates
      frame.setAttribute('sandbox', SANDBOX_ATTRIBUTES);
      frame.setAttribute('src', SANDBOX_HTML_PATH);
      frame.title = 'script sandbox';
      frame.style.display = 'none';
      document.body.append(frame);
      return frame;
    },
    createChannel: () => new MessageChannel(),
    onMessage(listener) {
      const handler = (ev: MessageEvent) => listener(ev);
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
    log: appLog,
    now: () => Date.now(),
    setTimer(fn, ms) {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    isOnline: () => connectionOnline(),
  };
}

const hostState = (client: SandboxClient): HostState => ({
  operatorId: client.operatorId,
  role: client.role,
  tick: client.tick,
  subnet: client.subnet,
  self: client.self,
  entities: [...client.entities.values()],
});

const hasSnapshot = (client: SandboxClient): boolean => (client.self as OperatorSelf | undefined) !== undefined;

const logText = (m: Extract<SandboxMessage, { type: 'log' }>): string => {
  const text = m.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return m.level === 'warn' || m.level === 'error' ? `[${m.level}] ${text}` : text;
};

/** One iframe + channel + bridge: a single run of the script. Rebuilt on every host reconnect. */
interface Run {
  frame: SandboxFrame;
  bridge: Bridge;
  posted: boolean;
  /** Cancels the pending "sandbox did not start" notice. */
  cancelStartNotice: (() => void) | null;
}

/** One `start()` until it ends: survives host reconnects (each restarts the script in a new Run). */
interface Session {
  client: SandboxClient;
  init: SandboxInit;
  unsubscribe: (() => void)[];
  /** Set while there is no host state to answer the script's `auth`; the next snapshot / tick builds the run. */
  awaitingState: boolean;
  /** The host lost its connection during this session (the next run is a restart). */
  lost: boolean;
  windowStart: number;
  shown: number;
  suppressed: number;
  /** Cancels the pending "N lines suppressed" summary. */
  cancelFlush: (() => void) | null;
  lastNotice: Partial<Record<BridgeViolation, number>>;
}

/**
 * Runs a player script in the static `/sandbox.html` iframe (opaque origin, `allow-scripts` only)
 * per the sandbox host contract: the init (source + one MessagePort) is posted on the frame's
 * `load`, only once the host client has its snapshot; the bridge relays between that port and the
 * real socket; only validated messages from the frame's own window are shown, as text and rate
 * limited. A host reconnect tears the run down and starts the script again from `main(game)`.
 */
export function createSandboxRunner(env: SandboxEnv) {
  let status: SandboxStatus = 'stopped';
  let session: Session | null = null;
  let run: Run | null = null;
  const listeners = new Set<() => void>();
  const set = (s: SandboxStatus) => {
    if (s === status) return;
    status = s;
    listeners.forEach((l) => l());
  };

  const flushSuppressed = (s: Session) => {
    s.cancelFlush?.();
    s.cancelFlush = null;
    if (s.suppressed > 0) env.log.push('system', `${s.suppressed} script log lines suppressed`);
    s.suppressed = 0;
  };

  /** Shows script output, at most LOG_LINES_PER_SECOND lines per second. */
  const display = (s: Session, kind: 'script' | 'error', text: string) => {
    const now = env.now();
    if (now - s.windowStart >= 1_000) {
      s.windowStart = now;
      s.shown = 0;
      flushSuppressed(s);
    }
    if (s.shown >= LOG_LINES_PER_SECOND) {
      s.suppressed++;
      // summarise when the window ends, even if the script goes quiet
      s.cancelFlush ??= env.setTimer(() => {
        s.cancelFlush = null;
        if (session === s) flushSuppressed(s);
      }, Math.max(0, s.windowStart + 1_000 - now));
      return;
    }
    s.shown++;
    env.log.push(kind, text);
  };

  const teardownRun = () => {
    if (!run) return;
    const r = run;
    run = null;
    r.cancelStartNotice?.();
    r.cancelStartNotice = null;
    r.bridge.close();
    r.frame.remove();
  };

  const endSession = (next: SandboxStatus) => {
    teardownRun();
    if (session) {
      session.unsubscribe.forEach((u) => u());
      flushSuppressed(session);
    }
    session = null;
    set(next);
  };

  const onViolation = (s: Session, r: Run, kind: BridgeViolation) => {
    if (session !== s || run !== r) return;
    if (kind === 'flood') {
      // the bridge already closed the port with 1008
      env.log.push('error', 'script stopped: flooding');
      endSession('errored');
      return;
    }
    const now = env.now();
    const last = s.lastNotice[kind];
    if (last !== undefined && now - last < VIOLATION_NOTICE_MS) return;
    s.lastNotice[kind] = now;
    env.log.push(
      'system',
      kind === 'rate' ? `script over its command budget (${SCRIPT_COMMANDS_PER_TICK} per tick): extra commands rejected` : 'script sent an invalid message (dropped)',
    );
  };

  const buildRun = (s: Session) => {
    const channel = env.createChannel();
    const r = { posted: false, cancelStartNotice: null } as Run;
    r.bridge = createBridge({
      port: channel.port1,
      send: (raw) => s.client.sendFrame(raw),
      state: () => hostState(s.client),
      commandsPerTick: SCRIPT_COMMANDS_PER_TICK,
      onViolation: (kind) => onViolation(s, r, kind),
    });
    r.frame = env.createFrame();
    r.frame.addEventListener('load', () => {
      // one run per iframe: post the init once, and never into a frame we already dropped
      if (run !== r || r.posted) return;
      r.posted = true;
      r.frame.contentWindow?.postMessage(s.init, '*', [channel.port2]);
      // a missing /sandbox.html (or a blocked frame) never answers: say so once, but kill nothing
      r.cancelStartNotice = env.setTimer(() => {
        r.cancelStartNotice = null;
        if (run === r) env.log.push('system', 'sandbox did not start — is /sandbox.html served?');
      }, START_NOTICE_MS);
    });
    run = r;
  };

  const finished = (reason: FinishReason) => {
    switch (reason) {
      case 'returned':
        // main() returned; the worker and its callbacks are still alive
        env.log.push('system', 'main() returned; the script keeps running its callbacks');
        return;
      case 'stopped':
        env.log.push('system', 'script stopped');
        endSession('stopped');
        return;
      case 'unresponsive':
        env.log.push('error', 'script stopped: unresponsive (no heartbeat for 5 s, e.g. an endless loop)');
        endSession('errored');
        return;
      case 'crashed':
        env.log.push('error', 'script stopped: the sandbox could not start it');
        endSession('errored');
        return;
    }
  };

  const onMessage = (ev: { source: unknown; data: unknown }) => {
    const s = session;
    if (!s || !run || ev.source === null || ev.source !== run.frame.contentWindow) return;
    const m = validateSandboxMessage(ev.data);
    if (!m) return;
    switch (m.type) {
      case 'started':
        run.cancelStartNotice?.();
        run.cancelStartNotice = null;
        set('running');
        return;
      case 'log':
        display(s, 'script', logText(m));
        return;
      case 'error':
        // an error does not end the script (that is what `finished` says)
        display(s, 'error', m.message);
        return;
      case 'finished':
        finished(m.reason);
        return;
    }
  };

  const restore = (s: Session) => {
    if (session !== s || !s.awaitingState || !hasSnapshot(s.client)) return;
    s.awaitingState = false;
    buildRun(s);
    if (s.lost) env.log.push('system', 'connection restored: script restarted from main(game)');
  };

  function stop(): void {
    if (!session) return;
    // Removing the frame (in endSession) is what ends the script: it takes the worker with it, even
    // in an endless loop. The `stop` message only lets the frame end the worker a moment earlier.
    if (run?.posted) {
      try {
        run.frame.contentWindow?.postMessage({ type: 'stop' }, '*');
      } catch {
        // ignored: the removal below ends the worker either way
      }
    }
    env.log.push('system', 'script stopped');
    endSession('stopped');
  }

  /** Runs `source` in a fresh sandbox wired to `client` (replacing any running script); refuses while offline. */
  async function start(client: SandboxClient, source: string): Promise<void> {
    stop();
    if (!env.isOnline()) {
      env.log.push('error', 'script not started: not connected to the game (wait until the status is online)');
      return;
    }
    let init: SandboxInit;
    try {
      init = createSandboxInit(source);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      env.log.push('error', `script not started: ${err.message}`);
      set('errored');
      return;
    }
    const s: Session = {
      client,
      init,
      unsubscribe: [],
      awaitingState: !hasSnapshot(client),
      lost: false,
      windowStart: env.now(),
      shown: 0,
      suppressed: 0,
      cancelFlush: null,
      lastNotice: {},
    };
    session = s;
    s.unsubscribe.push(
      env.onMessage(onMessage),
      client.on('frame', (raw) => {
        if (session === s) run?.bridge.deliver(raw);
      }),
      client.on('disconnect', () => {
        if (session !== s || s.awaitingState) return;
        teardownRun();
        s.awaitingState = true;
        s.lost = true;
        set('starting');
        env.log.push('system', 'connection lost: the script will restart from main(game) when it is back');
      }),
      // after a reconnect the server sends a snapshot (`ready`) or replays deltas (`tick`)
      client.on('ready', () => restore(s)),
      client.on('tick', () => restore(s)),
    );
    set('starting');
    env.log.push('system', 'script starting');
    if (!s.awaitingState) buildRun(s);
  }

  return {
    start,
    stop,
    getStatus: () => status,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type SandboxRunner = ReturnType<typeof createSandboxRunner>;

let runner: SandboxRunner | null = null;
/** The page's runner, created on first use (the browser env needs `document`). */
const page = (): SandboxRunner => (runner ??= createSandboxRunner(createBrowserSandboxEnv()));

/** Runs `source` in the opaque-origin sandbox iframe wired to `client` through the bridge. */
export function start(client: GameClient, source: string): Promise<void> {
  return page().start(client, source);
}

/** Stops the script: removes its frame, which ends the worker (a `stop` message is posted first). */
export function stop(): void {
  runner?.stop();
}

export function useSandboxStatus(): SandboxStatus {
  return useSyncExternalStore(
    (l) => page().subscribe(l),
    () => page().getStatus(),
    () => 'stopped',
  );
}
