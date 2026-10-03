/*
 * The sandbox is a static document plus static scripts, served by the frontend's web server:
 *
 *   /sandbox.html          buildSandboxDocument(), served with the response header
 *                          `Content-Security-Policy: SANDBOX_CSP` (plan 3: Caddy sets it for this path)
 *   /sandbox/bootstrap.js  the iframe main thread (src/entry/bootstrap.ts)
 *   /sandbox/worker.js     the worker runtime (src/entry/worker.ts)
 *   /sandbox/sdk.js        the SDK as a classic script defining `DaemonetSDK`
 *
 * `pnpm --filter @daemonet/sandbox build:static` writes them to packages/sandbox/dist/static/.
 *
 * Host contract (the page that embeds the iframe):
 * - `<iframe sandbox="allow-scripts" src="/sandbox.html">` (SANDBOX_ATTRIBUTES; never
 *   `allow-same-origin`): an opaque origin with no cookies, storage or host DOM. Because it is a real
 *   URL it gets its own policy container from the response header and does not inherit the host's
 *   CSP, so the host can keep `script-src 'self'; frame-src 'self'`.
 * - After the iframe's `load`, post `createSandboxInit(source)` with the bridge's other MessagePort
 *   transferred: `iframe.contentWindow.postMessage(init, '*', [port])`. The iframe ignores a
 *   malformed init and sources above MAX_SOURCE_BYTES.
 * - The script runs in a Worker inside the iframe (a blob: worker that importScripts sdk.js and
 *   worker.js), so an endless loop never freezes the iframe or the host: post `{ type: 'stop' }`
 *   to end it, and the iframe kills a worker that misses heartbeats for 5 s. Both answer
 *   `{ type: 'finished', reason }`. Removing the iframe also ends everything.
 * - Accept messages only when `event.source === iframe.contentWindow`, run them through
 *   `validateSandboxMessage`, and render log/error text as text (never as HTML).
 * - On a `finished` other than `returned`, close the bridge. Reconnection: see bridge.ts.
 * - The worker inherits the document's CSP: `connect-src 'none'` blocks fetch/WebSocket there too.
 */

export const SANDBOX_HTML_PATH = '/sandbox.html';
export const SANDBOX_BOOTSTRAP_PATH = '/sandbox/bootstrap.js';
export const SANDBOX_WORKER_PATH = '/sandbox/worker.js';
export const SANDBOX_SDK_PATH = '/sandbox/sdk.js';
/** The files `build:static` writes, relative to the served root. */
export const SANDBOX_STATIC_FILES = [SANDBOX_HTML_PATH, SANDBOX_BOOTSTRAP_PATH, SANDBOX_WORKER_PATH, SANDBOX_SDK_PATH].map((p) => p.slice(1));

/**
 * The response header `/sandbox.html` must be served with. `'self'` is the document's URL origin
 * even though the sandboxed document's own origin is opaque. Chromium logs `webrtc` as an
 * unrecognized directive but applies the rest; it is kept for browsers that support it.
 */
export const SANDBOX_CSP = "default-src 'none'; script-src 'self' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'";

export const SANDBOX_ATTRIBUTES = 'allow-scripts';

/** Real escaping for a double-quoted HTML attribute value. */
export function escapeHtmlAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The static sandbox document: no inline script, no per-run content. The CSP also rides along as
 * a meta tag so a misconfigured server still serves a locked-down page (both policies apply).
 */
export function buildSandboxDocument(): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(SANDBOX_CSP)}">`,
    '<title>Daemonet sandbox</title>',
    `<script src="${escapeHtmlAttribute(SANDBOX_BOOTSTRAP_PATH)}"></script>`,
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n');
}
