import { HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, LOG_BUDGET, parseHostMessage, validateSandboxMessage, type FinishReason, type SandboxMessage } from './protocol.js';

/** The part of a DOM Worker the frame uses. */
export interface FrameWorker {
  postMessage(data: unknown, transfer: unknown[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: { message?: unknown; preventDefault?(): void }) => void) | null;
}

export interface FrameEnv {
  postToParent(message: SandboxMessage): void;
  /** Delivers messages whose `event.source` is the parent window (the entry filters the rest). */
  onParentMessage(listener: (data: unknown, ports: readonly unknown[]) => void): void;
  createWorker(): FrameWorker;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  heartbeatTimeoutMs?: number;
}

/**
 * The sandbox iframe's main thread. It never runs player code: on a valid `init` it starts the
 * worker and hands it the port and source; it forwards only validated worker messages (logs and
 * errors from one shared budget), and it stays responsive to end the worker on `stop` or when
 * heartbeats stop (an endless loop in the script).
 */
export function runFrame(env: FrameEnv): void {
  const timeoutMs = env.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  let worker: FrameWorker | null = null;
  let watchdog: unknown = null;
  let done = false;
  let started = false;
  let returned = false;
  let budget = LOG_BUDGET;
  let lastBeat = 0;

  const finish = (reason: FinishReason) => {
    if (done) return;
    done = true;
    worker?.terminate();
    if (watchdog !== null) env.clearInterval(watchdog);
    env.postToParent({ type: 'finished', reason });
  };

  const fromWorker = (data: unknown) => {
    if (done) return;
    if (data !== null && typeof data === 'object' && (data as { type?: unknown }).type === 'hb') {
      lastBeat = env.now();
      return;
    }
    const m = validateSandboxMessage(data);
    if (!m) return;
    switch (m.type) {
      case 'started':
        if (!started) env.postToParent(m);
        started = true;
        return;
      case 'finished':
        // the worker only reports that main() returned; the frame alone decides the other reasons
        if (!returned) env.postToParent({ type: 'finished', reason: 'returned' });
        returned = true;
        return;
      default:
        if (budget > 0) {
          budget--;
          env.postToParent(m);
        }
    }
  };

  env.onParentMessage((data, ports) => {
    const msg = parseHostMessage(data, ports);
    if (!msg || done) return;
    if (msg.type === 'stop') {
      finish('stopped');
      return;
    }
    if (worker) return;
    const w = env.createWorker();
    worker = w;
    w.onmessage = (ev) => fromWorker(ev.data);
    // Reached only when the runtime is not up (it handles the script's own errors): a load failure.
    w.onerror = (ev) => {
      ev.preventDefault?.();
      if (done) return;
      env.postToParent({ type: 'error', message: `sandbox worker failed: ${String(ev.message ?? 'unknown error')}` });
      finish('crashed');
    };
    lastBeat = env.now();
    watchdog = env.setInterval(() => {
      if (env.now() - lastBeat > timeoutMs) finish('unresponsive');
    }, HEARTBEAT_MS / 2);
    w.postMessage({ type: 'init', source: msg.source }, [msg.port]);
  });
}
