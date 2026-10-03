/**
 * Messages between the host page, the sandbox iframe (opaque origin) and the worker inside it.
 * Shared by the host-side helpers and the iframe/worker runtime (bundled into /sandbox/*.js), so
 * it must stay free of DOM and Node APIs beyond TextEncoder.
 */

/** The script size limit (the API's MAX_SCRIPT_BYTES), in UTF-8 bytes. */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Log and error messages a script may send in its lifetime (shared budget). */
export const LOG_BUDGET = 500;
/** The worker beats this often; the iframe kills it after HEARTBEAT_TIMEOUT_MS without a beat. */
export const HEARTBEAT_MS = 1000;
export const HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * Why a script finished: `returned` — `main(game)` returned (the worker keeps running its
 * callbacks); `stopped` — the host sent `stop`; `unresponsive` — no heartbeat for 5 s (e.g. an
 * endless loop); `crashed` — the worker could not start. All but `returned` terminated the worker.
 */
export type FinishReason = 'returned' | 'stopped' | 'unresponsive' | 'crashed';
const REASONS: ReadonlySet<string> = new Set<FinishReason>(['returned', 'stopped', 'unresponsive', 'crashed']);

/** Messages the sandbox posts to its parent (check `event.source === iframe.contentWindow`, then `validateSandboxMessage`). */
export type SandboxMessage =
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; args: unknown[] }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'started' }
  | { type: 'finished'; reason: FinishReason };

/** The parent's first message, posted with the MessagePort transferred. */
export type SandboxInit = { type: 'init'; source: string };
/** Ends the script: the iframe terminates the worker and answers `finished` with reason `stopped`. */
export type SandboxStop = { type: 'stop' };
export type HostToSandbox = SandboxInit | SandboxStop;

type LogLevel = Extract<SandboxMessage, { type: 'log' }>['level'];
const MAX_TEXT = 2000;
const MAX_STACK = 8000;
const MAX_LOG_ARGS = 10;
const LEVELS: ReadonlySet<string> = new Set(['log', 'info', 'warn', 'error', 'debug']);

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function clampValue(value: unknown): unknown {
  if (typeof value === 'string') return clamp(value, MAX_TEXT);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return clamp(String(value), MAX_TEXT);
    return json.length > MAX_TEXT ? clamp(json, MAX_TEXT) : (JSON.parse(json) as unknown);
  } catch {
    return clamp(String(value), MAX_TEXT);
  }
}

/**
 * Everything from the sandbox is hostile: this accepts only the four message shapes the runtime
 * sends and clamps their size, returning `null` for anything else. The iframe runs it on every
 * worker message, and the host must run it again on every iframe message.
 */
export function validateSandboxMessage(data: unknown): SandboxMessage | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'started':
      return { type: 'started' };
    case 'finished':
      return typeof m.reason === 'string' && REASONS.has(m.reason) ? { type: 'finished', reason: m.reason as FinishReason } : null;
    case 'log': {
      if (typeof m.level !== 'string' || !LEVELS.has(m.level) || !Array.isArray(m.args)) return null;
      return { type: 'log', level: m.level as LogLevel, args: m.args.slice(0, MAX_LOG_ARGS).map(clampValue) };
    }
    case 'error': {
      if (typeof m.message !== 'string') return null;
      if (m.stack !== undefined && typeof m.stack !== 'string') return null;
      return m.stack === undefined ? { type: 'error', message: clamp(m.message, MAX_TEXT) } : { type: 'error', message: clamp(m.message, MAX_TEXT), stack: clamp(m.stack, MAX_STACK) };
    }
    default:
      return null;
  }
}

const sourceBytes = (source: string): number => new TextEncoder().encode(source).length;

/** The init message for `source`; throws a RangeError above MAX_SOURCE_BYTES (the iframe would ignore it). */
export function createSandboxInit(source: string): SandboxInit {
  if (sourceBytes(source) > MAX_SOURCE_BYTES) throw new RangeError(`script exceeds ${MAX_SOURCE_BYTES} bytes`);
  return { type: 'init', source };
}

/** Parses a message from the parent (the caller has checked `event.source === parent`). */
export function parseHostMessage<P>(data: unknown, ports: readonly P[]): { type: 'init'; source: string; port: P } | SandboxStop | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (m.type === 'stop') return { type: 'stop' };
  if (m.type !== 'init' || typeof m.source !== 'string' || ports.length !== 1) return null;
  if (sourceBytes(m.source) > MAX_SOURCE_BYTES) return null;
  return { type: 'init', source: m.source, port: ports[0]! };
}
