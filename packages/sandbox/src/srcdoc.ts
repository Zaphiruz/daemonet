/*
 * Host contract (the page that embeds the iframe):
 * - iframe: `sandbox="allow-scripts"` only (SANDBOX_ATTRIBUTES), `srcdoc` from buildSandboxHtml; the
 *   host page's own CSP must allow the inline and `data:` scripts this document carries (they live in
 *   the iframe, but a restrictive parent `frame-src`/CSP must permit a srcdoc frame).
 * - post `{ type: 'init' }` with the MessagePort transferred only after the iframe's `load` event.
 * - accept messages only when `event.source === iframe.contentWindow`, run them through
 *   `validateSandboxMessage`, rate-limit them, and render log/error text as text (never as HTML).
 * - run a watchdog: a script in an endless loop blocks the iframe, so the host must be able to
 *   remove the iframe (and close the bridge) on timeout or user request.
 * - reconnection is the host's: rebuild the port, bridge, iframe client with a fresh single-use ticket.
 */

/** Messages the sandbox posts to its parent (validate `event.source === iframe.contentWindow`, then `validateSandboxMessage`). */
export type SandboxMessage =
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; args: unknown[] }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'started' }
  | { type: 'finished' };

/** Message the parent posts to the sandbox, transferring the MessagePort. */
export type SandboxInit = { type: 'init' };

type LogLevel = Extract<SandboxMessage, { type: 'log' }>['level'];
const MAX_TEXT = 2000;
const MAX_STACK = 8000;
const MAX_LOG_ARGS = 10;
const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

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
 * The host must treat everything from the iframe as hostile: this accepts only the four message
 * shapes the bootstrap sends and clamps their size, returning `null` for anything else. The host
 * should additionally rate-limit accepted `log` messages.
 */
export function validateSandboxMessage(data: unknown): SandboxMessage | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'started':
      return { type: 'started' };
    case 'finished':
      return { type: 'finished' };
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

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const dataModule = (source: string): string => `data:text/javascript;base64,${toBase64(source)}`;

/**
 * Runs inside the sandbox. The client gets a placeholder credential (the bridge answers `auth`
 * itself and never forwards it) and `reconnect: false`: the port never reconnects, the host owns
 * reconnection by rebuilding the port and the client with a fresh single-use ticket.
 */
const BOOTSTRAP = `
const post = (m) => parent.postMessage(m, '*');
const safe = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); } };
let budget = 500;
const postBudgeted = (m) => { if (budget-- > 0) post(m); };
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => postBudgeted({ type: 'log', level, args: args.slice(0, 10).map(safe) });
}
addEventListener('unhandledrejection', (e) => postBudgeted({ type: 'error', message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));
addEventListener('error', (e) => postBudgeted({ type: 'error', message: String(e.message), stack: e.error?.stack }));
const onInit = async (ev) => {
  if (ev.source !== parent || ev.data?.type !== 'init' || !ev.ports[0]) return;
  removeEventListener('message', onInit);
  const port = ev.ports[0];
  try {
    const sdk = await import('@daemonet/sdk');
    const mod = await import(USER_MODULE);
    if (typeof mod.default !== 'function') throw new Error('the script must export default function main(game)');
    const game = await sdk.connect({ url: 'port://sandbox', auth: sdk.staticToken('sandbox'), WebSocket: sdk.PortSocket.factory(port), reconnect: false });
    post({ type: 'started' });
    await mod.default(game);
    post({ type: 'finished' });
  } catch (err) {
    post({ type: 'error', message: String(err?.message ?? err), stack: err?.stack });
  }
};
addEventListener('message', onInit);
`;

/**
 * Makes text safe inside an inline `<script>`: in JSON every `<` becomes the escape `\u003c`; in
 * JavaScript source a `</script` (any case) is broken up as `<\/script`, which is the same string
 * at runtime but does not end the element.
 */
export function escapeForScript(text: string, kind: 'json' | 'js'): string {
  return kind === 'json' ? text.replace(/</g, '\\u003c') : text.replace(/<\/script/gi, (m) => `<\\${m.slice(1)}`);
}

/**
 * The HTML for a `sandbox="allow-scripts"` iframe (opaque origin): a CSP that allows only inline
 * and data: module scripts and blocks every network, frame, form and base-URI use, an import map
 * that resolves `@daemonet/sdk` to the bundled SDK, and a bootstrap that waits for the port,
 * imports the user's script as a data: module and runs it.
 */
export function buildSandboxHtml(opts: { sdkBundle: string; source: string }): string {
  const importMap = JSON.stringify({ imports: { '@daemonet/sdk': dataModule(opts.sdkBundle) } });
  const userModule = JSON.stringify(dataModule(opts.source));
  const bootstrap = BOOTSTRAP.replace('USER_MODULE', () => userModule);
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">`,
    `<script type="importmap">${escapeForScript(importMap, 'json')}</script>`,
    `<script type="module">${escapeForScript(bootstrap, 'js')}</script>`,
  ].join('\n');
}

export const SANDBOX_ATTRIBUTES = 'allow-scripts';
