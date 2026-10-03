import type { connect, PortLike, PortSocket, staticToken } from '@daemonet/sdk';
import { HEARTBEAT_MS, type SandboxMessage } from './protocol.js';

/** What the worker posts to the iframe: sandbox messages plus heartbeats. */
export type WorkerMessage = SandboxMessage | { type: 'hb' };

/** The SDK surface the runtime needs (the `DaemonetSDK` global in the browser). */
export interface WorkerSdk {
  connect: typeof connect;
  staticToken: typeof staticToken;
  PortSocket: typeof PortSocket;
}

export interface WorkerEnv {
  post(message: WorkerMessage): void;
  onMessage(listener: (data: unknown, ports: readonly unknown[]) => void): void;
  sdk: WorkerSdk;
  /** Imports the player's source as an ES module (a blob: URL in the browser). */
  importModule(source: string): Promise<{ default?: unknown }>;
  /** The console to redirect to the host. */
  console: Record<string, unknown>;
  setInterval(fn: () => void, ms: number): unknown;
  heartbeatMs?: number;
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** A structured-clone- and JSON-safe copy of a log argument. */
function safe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : (JSON.parse(json) as unknown);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unprintable]';
    }
  }
}

const text = (value: unknown, fallback: string): string => {
  try {
    return String(value);
  } catch {
    return fallback;
  }
};

/** An `error` message for anything thrown; message and stack are always strings. */
export function errorMessage(err: unknown): Extract<SandboxMessage, { type: 'error' }> {
  let message: unknown = err;
  let stack: unknown;
  try {
    if (err !== null && typeof err === 'object') {
      const e = err as { message?: unknown; stack?: unknown };
      message = e.message ?? err;
      stack = e.stack;
    }
  } catch {
    message = '[unreadable error]';
  }
  const out: Extract<SandboxMessage, { type: 'error' }> = { type: 'error', message: text(message, '[unprintable error]') };
  if (stack !== undefined && stack !== null) out.stack = text(stack, '');
  return out;
}

/**
 * The worker side of the sandbox: beats every second, waits for one `init` with a port, imports the
 * player's module, connects the SDK over the port (`reconnect: false`, placeholder credential —
 * the bridge answers `auth` itself) and runs `main(game)`. Console output becomes `log` messages
 * (the iframe enforces the budget).
 */
export function runWorker(env: WorkerEnv): void {
  const post = (m: WorkerMessage) => {
    try {
      env.post(m);
    } catch {
      // an unclonable message is dropped
    }
  };
  env.setInterval(() => post({ type: 'hb' }), env.heartbeatMs ?? HEARTBEAT_MS);
  for (const level of LEVELS) {
    env.console[level] = (...args: unknown[]) => post({ type: 'log', level, args: args.slice(0, 10).map(safe) });
  }
  let initialised = false;
  env.onMessage((data, ports) => {
    if (initialised || ports.length !== 1) return;
    const d = data as { type?: unknown; source?: unknown } | null;
    if (d === null || typeof d !== 'object' || d.type !== 'init' || typeof d.source !== 'string') return;
    initialised = true;
    void run(d.source, ports[0] as PortLike);
  });

  async function run(source: string, port: PortLike): Promise<void> {
    try {
      const mod = await env.importModule(source);
      const main = mod.default;
      if (typeof main !== 'function') throw new Error('the script must export default function main(game)');
      const { sdk } = env;
      const game = await sdk.connect({ url: 'port://sandbox', auth: sdk.staticToken('sandbox'), WebSocket: sdk.PortSocket.factory(port), reconnect: false });
      post({ type: 'started' });
      await (main as (g: unknown) => unknown)(game);
      post({ type: 'finished', reason: 'returned' });
    } catch (err) {
      post(errorMessage(err));
    }
  }
}
