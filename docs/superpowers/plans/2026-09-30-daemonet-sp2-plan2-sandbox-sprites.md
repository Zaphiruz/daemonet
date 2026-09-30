# Daemonet SP2 · Plan 2 — Sandbox bridge and procedural sprites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the web client needs that is not UI: a `MessagePort`-backed socket in the SDK, the SDK bundled as one browser module, the `@daemonet/sandbox` package (the host-side bridge that relays protocol frames and the `srcdoc` builder for an opaque-origin iframe), and `@daemonet/sprites` (deterministic 16×16 pixel art per species) — each verified in Node and the sandbox additionally in a real browser.

**Architecture:** The sandboxed script runs the unmodified `@daemonet/sdk` with `PortSocket` in place of `WebSocket`. The host page owns the only real socket and a `Bridge` that answers the sandbox's `auth` from host state, forwards at most 8 `cmd` frames per tick, relays deltas, and drops everything else. The iframe is `sandbox="allow-scripts"` with a `srcdoc` whose CSP is `default-src 'none'; script-src 'unsafe-inline' data:; connect-src 'none'`, an import map resolving `@daemonet/sdk` to a `data:` module, and the user's script imported as a `data:` module. Sprites are pure functions returning RGBA buffers.

**Tech Stack:** Vite 8 (library build of the SDK), `MessageChannel`/`MessagePort` (Node and browsers), Vitest.

**Prerequisites:** SP2 plan 1 merged. A browser for the manual check in Task 4.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp2-web-client-design.md` §5, §6 (sprites), §9, §10.

## Global Constraints

- Everything from the SP1 plans and SP2 plan 1.
- The sandbox must never hold a credential: the bridge answers `auth` itself, forwards only `cmd`, and the iframe CSP has `connect-src 'none'`.
- `PortSocket` never reconnects; the host owns reconnection and resume.
- Sprites are deterministic per `(speciesId, types, clean, signature)` and left-right symmetric.
- `packages/sdk/dist/sandbox/sdk.js` is a build artefact (git-ignored under `dist/`), produced by `pnpm --filter @daemonet/sdk build:sandbox`.

## File map

```
packages/sdk/src/port-socket.ts, src/index.ts (+PortSocket, PortLike, WebSocketLike, WebSocketCtor), src/client.ts (types exported)
packages/sdk/vite.sandbox.config.ts, package.json (+build:sandbox, vite)
packages/sdk/verify/{host.ts,index.html,vite.config.ts}     manual browser check (Task 4)
packages/sandbox/  package.json, tsconfig.json, src/bridge.ts, src/srcdoc.ts, src/index.ts, test/sandbox.test.ts
packages/sprites/  package.json, tsconfig.json, src/index.ts, test/sprites.test.ts
tsconfig.json (+sprites, sandbox), tsconfig.tests.json (+DOM lib)
```

---

### Task 1: `PortSocket` and the SDK browser bundle

**Files:**
- Create: `packages/sdk/src/port-socket.ts`, `packages/sdk/vite.sandbox.config.ts`
- Modify: `packages/sdk/src/client.ts` (export the socket types), `packages/sdk/src/index.ts`, `packages/sdk/package.json`, `tsconfig.tests.json`

**Interfaces:**
- `interface PortLike { postMessage(data); addEventListener('message', (ev: MessageEvent) => void); start?(); close() }` — satisfied by browser and Node `MessagePort`.
- `class PortSocket implements WebSocketLike` with `static factory(port): WebSocketCtor`; control frame `PortControl = { type: 'close'; code?; reason? }`.
- `WebSocketLike` and `WebSocketCtor` become exported types of `@daemonet/sdk`.
- `pnpm --filter @daemonet/sdk build:sandbox` → `packages/sdk/dist/sandbox/sdk.js`, a single ES module with no imports.

- [ ] **Step 1: Export the socket types**

In `packages/sdk/src/client.ts` change `type WebSocketLike = {` to `export type WebSocketLike = {` and `type WebSocketCtor = …` to `export type WebSocketCtor = new (url: string) => WebSocketLike;`.

- [ ] **Step 2: Implement `PortSocket`**

`packages/sdk/src/port-socket.ts`:

```ts
import type { WebSocketCtor, WebSocketLike } from './client.js';

/** Wire messages the host bridge sends besides raw protocol strings. */
export type PortControl = { type: 'close'; code?: number; reason?: string };

/** The subset of MessagePort used here; identical in browsers and Node (worker_threads). */
export interface PortLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

/**
 * A WebSocket-shaped adapter over a MessagePort. The sandboxed script's GameClient uses it exactly
 * like a socket; the host page relays frames to the real WebSocket. Opens on the next microtask,
 * and closes only when the host says so — the host owns reconnection.
 */
export class PortSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = PortSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(private readonly port: PortLike) {
    port.addEventListener('message', (ev) => {
      const d: unknown = ev.data;
      if (typeof d === 'string') this.onmessage?.({ data: d });
      else if (d && typeof d === 'object' && (d as PortControl).type === 'close') this.finish((d as PortControl).code ?? 1000, (d as PortControl).reason ?? '');
    });
    port.start?.();
    queueMicrotask(() => {
      if (this.readyState === PortSocket.CONNECTING) {
        this.readyState = PortSocket.OPEN;
        this.onopen?.({});
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== PortSocket.OPEN) throw new Error('PortSocket is not open');
    this.port.postMessage(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= PortSocket.CLOSING) return;
    this.readyState = PortSocket.CLOSING;
    this.port.postMessage({ type: 'close', code, reason } satisfies PortControl);
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === PortSocket.CLOSED) return;
    this.readyState = PortSocket.CLOSED;
    this.port.close();
    this.onclose?.({ code, reason });
  }

  /** A constructor for `connect({ WebSocket })` that ignores the URL and uses `port`. */
  static factory(port: PortLike): WebSocketCtor {
    return class extends PortSocket {
      constructor(_url: string) {
        super(port);
      }
    };
  }
}
```

Add to `packages/sdk/src/index.ts` after the `auth.js` export line:

```ts
export { PortSocket, type PortControl, type PortLike } from './port-socket.js';
export type { WebSocketLike, WebSocketCtor } from './client.js';
```

- [ ] **Step 3: Add the bundle build**

`packages/sdk/vite.sandbox.config.ts`:

```ts
import { defineConfig } from 'vite';

/**
 * Builds the SDK as one self-contained ES module for the sandboxed iframe (packages/sandbox
 * embeds it through an import map). Output: dist/sandbox/sdk.js — no external imports.
 */
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'sdk.js' },
    outDir: 'dist/sandbox',
    emptyOutDir: true,
    target: 'es2023',
    minify: false,
    sourcemap: false,
    rollupOptions: { external: [] },
  },
});
```

Replace `packages/sdk/package.json` with:

```json
{
  "name": "@daemonet/sdk",
  "version": "0.0.0",
  "private": true,
  "description": "Daemonet player SDK: connect, mirror the world, and script your operator and daemons.",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node.d.ts",
      "default": "./dist/node.js"
    }
  },
  "files": [
    "dist"
  ],
  "dependencies": {
    "@daemonet/rules": "workspace:*",
    "@daemonet/shared": "workspace:*"
  },
  "scripts": {
    "build:sandbox": "vite build --config vite.sandbox.config.ts"
  },
  "devDependencies": {
    "vite": "^8.3.1"
  }
}
```

Replace `tsconfig.tests.json` with (tests now use `MessageChannel`, whose global type comes from the DOM lib):

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "types": [
      "node"
    ],
    "lib": [
      "ES2023",
      "DOM"
    ]
  },
  "include": [
    "packages/*/test/**/*.ts",
    "apps/*/test/**/*.ts"
  ]
}
```

- [ ] **Step 4: Build and verify the bundle is self-contained**

```bash
pnpm install
pnpm typecheck
pnpm --filter @daemonet/sdk build:sandbox
grep -cE "^import |from '" packages/sdk/dist/sandbox/sdk.js
grep -c PortSocket packages/sdk/dist/sandbox/sdk.js
```

Expected: `dist/sandbox/sdk.js` about 210 kB, `0` imports, `PortSocket` present.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): PortSocket and self-contained browser bundle"
```

---

### Task 2: `@daemonet/sandbox` — bridge and srcdoc

**Files:**
- Create: `packages/sandbox/package.json`, `packages/sandbox/tsconfig.json`, `packages/sandbox/src/bridge.ts`, `packages/sandbox/src/srcdoc.ts`, `packages/sandbox/src/index.ts`
- Modify: `tsconfig.json`
- Test: `packages/sandbox/test/sandbox.test.ts`

**Interfaces:**
- `createBridge({ port: PortLike, send(data), state(): HostState }): Bridge { deliver(data); close(code?, reason?) }`, `interface HostState { operatorId; role; tick; subnet; self; entities }`.
- `buildSandboxHtml({ sdkBundle, source }): string`, `SANDBOX_ATTRIBUTES = 'allow-scripts'`, message types `SandboxMessage` (`log | error | started | finished`) and `SandboxInit` (`{ type: 'init' }` with the port transferred).
- Bridge behaviour: `auth` → local `authOk` + `snapshot`; `ping` → `pong`; `cmd` → forwarded, 8 per tick then `E_RATE`; anything else dropped. `deliver` resets the per-tick counter on `delta`, drops server `authOk`/`snapshot`/`pong`, relays the rest.

- [ ] **Step 1: Package shell**

`packages/sandbox/package.json`:

```json
{
  "name": "@daemonet/sandbox",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": {
    "@daemonet/sdk": "workspace:*",
    "@daemonet/shared": "workspace:*"
  }
}
```

`packages/sandbox/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "lib": ["ES2023", "DOM"] },
  "include": ["src"],
  "references": [{ "path": "../sdk" }, { "path": "../shared" }]
}
```

In the root `tsconfig.json` add `{ "path": "packages/sandbox" }` and `{ "path": "packages/sprites" }` to `references` (before `apps/sim`).

- [ ] **Step 2: Write the failing tests**

`packages/sandbox/test/sandbox.test.ts`:

```ts
import { GameClient, PortSocket, staticToken } from '@daemonet/sdk';
import type { OperatorSelf } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../src/bridge.js';
import { buildSandboxHtml } from '../src/srcdoc.js';

const self: OperatorSelf = {
  id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null,
};
const state = () => ({ operatorId: 'op1', role: 'controller' as const, tick: 40, subnet: 'lo', self, entities: [] });
/** Ports deliver asynchronously; wait (a few macrotasks) until `pred` holds. */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
}

describe('createBridge', () => {
  it('answers auth locally with authOk + snapshot and never forwards it', async () => {
    const { port1, port2 } = new MessageChannel();
    const sent: string[] = [];
    createBridge({ port: port1, send: (d) => sent.push(d), state });
    const got: string[] = [];
    port2.addEventListener('message', (e) => got.push((e as MessageEvent).data as string));
    port2.postMessage(JSON.stringify({ t: 'auth', seq: 1, d: { token: 'sandbox' } }));
    await until(() => got.length >= 2);
    expect(got.map((g) => JSON.parse(g).t)).toEqual(['authOk', 'snapshot']);
    expect(JSON.parse(got[1]!).d.self.name).toBe('alice');
    expect(sent).toEqual([]);
    port1.close();
    port2.close();
  });

  it('forwards commands up to 8 per tick, relays deltas, and drops server auth frames', async () => {
    const { port1, port2 } = new MessageChannel();
    const sent: string[] = [];
    const bridge = createBridge({ port: port1, send: (d) => sent.push(d), state });
    const got: string[] = [];
    port2.addEventListener('message', (e) => got.push((e as MessageEvent).data as string));
    port2.postMessage(JSON.stringify({ t: 'auth', seq: 1, d: { token: 'sandbox' } }));
    await until(() => got.length >= 2);
    for (let i = 0; i < 10; i++) port2.postMessage(JSON.stringify({ t: 'cmd', seq: 2 + i, d: { reqId: `r${i}`, cmd: 'stop', actor: 'self', args: {} } }));
    await until(() => sent.length >= 8 && got.length >= 4);
    expect(sent).toHaveLength(8);
    expect(got.filter((g) => JSON.parse(g).t === 'err').map((g) => JSON.parse(g).d.code)).toEqual(['E_RATE', 'E_RATE']);
    bridge.deliver(JSON.stringify({ t: 'authOk', seq: 9, d: {} }));
    bridge.deliver(JSON.stringify({ t: 'delta', seq: 10, d: { tick: 41, upserts: [], removes: [], events: [] } }));
    port2.postMessage(JSON.stringify({ t: 'cmd', seq: 20, d: { reqId: 'again', cmd: 'stop', actor: 'self', args: {} } }));
    port2.postMessage(JSON.stringify({ t: 'reauth', seq: 21, d: { token: 'x' } }));
    await until(() => sent.length >= 9);
    expect(got.filter((g) => JSON.parse(g).t === 'delta')).toHaveLength(1);
    expect(got.some((g) => JSON.parse(g).t === 'authOk' && JSON.parse(g).seq === 9)).toBe(false);
    expect(sent).toHaveLength(9);
    expect(sent.some((s) => s.includes('reauth'))).toBe(false);
    bridge.close();
    port2.close();
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
});

describe('buildSandboxHtml', () => {
  it('embeds the SDK via an import map, the user script as a data: module, and a strict CSP', () => {
    const html = buildSandboxHtml({ sdkBundle: 'export const x = 1;', source: 'export default function main(game) { game.operator.stop(); }' });
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('"@daemonet/sdk":"data:text/javascript;base64,');
    expect(html).toContain(`Content-Security-Policy`);
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain('data:text/javascript;base64,' + btoa('export default function main(game) { game.operator.stop(); }'));
    expect(html).not.toContain('</script></script>');
  });

  it('cannot be broken out of with a closing script tag in the source', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: '</script><script>alert(1)</script>' });
    // the source only appears base64-encoded, so a literal closing tag never reaches the HTML
    expect(html.split('</script>')).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm install
pnpm vitest run packages/sandbox
```

Expected: FAIL — cannot resolve `../src/bridge.js`.

- [ ] **Step 4: Implement**

`packages/sandbox/src/bridge.ts`:

```ts
import type { PortLike } from '@daemonet/sdk';
import { COMMANDS_PER_TICK, type Entity, type OperatorSelf } from '@daemonet/shared';

/** What the host already knows; used to answer the sandbox's `auth` with a synthetic snapshot. */
export interface HostState {
  operatorId: string;
  role: 'controller' | 'spectator';
  tick: number;
  subnet: string;
  self: OperatorSelf;
  entities: Entity[];
}

export interface BridgeOptions {
  /** The host's end of the channel (the other end goes to the sandbox). */
  port: PortLike;
  /** Forwards a frame to the real WebSocket. */
  send(data: string): void;
  state(): HostState;
}

export interface Bridge {
  /** Feed every frame from the real WebSocket here. */
  deliver(data: string): void;
  /** Tell the sandbox the game is over (host closed the real socket for good). */
  close(code?: number, reason?: string): void;
}

type Envelope = { t?: unknown; seq?: unknown; d?: unknown };

/**
 * Relays protocol frames between the sandboxed script and the real WebSocket. The sandbox never
 * sees a credential: its `auth` is answered locally from host state, `ping` locally with `pong`,
 * and only `cmd` frames go to the server — at most 8 per tick, like the server enforces.
 */
export function createBridge(opts: BridgeOptions): Bridge {
  let seq = 0;
  let commandsThisTick = 0;
  let authed = false;
  const reply = (frame: object) => opts.port.postMessage(JSON.stringify({ ...frame, seq: ++seq }));

  opts.port.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    const raw = ev.data;
    let msg: Envelope;
    try {
      msg = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'auth': {
        const s = opts.state();
        authed = true;
        reply({ t: 'authOk', d: { operatorId: s.operatorId, role: s.role, resumeToken: 'sandbox', tick: s.tick } });
        reply({ t: 'snapshot', d: { tick: s.tick, subnet: s.subnet, self: s.self, entities: s.entities } });
        return;
      }
      case 'ping':
        reply({ t: 'pong', d: {} });
        return;
      case 'cmd': {
        if (!authed) return;
        const d = msg.d as { reqId?: string } | undefined;
        if (commandsThisTick >= COMMANDS_PER_TICK) {
          reply({ t: 'err', d: { reqId: d?.reqId, code: 'E_RATE', message: `at most ${COMMANDS_PER_TICK} commands per tick` } });
          return;
        }
        commandsThisTick++;
        opts.send(raw);
        return;
      }
      default:
        // auth-adjacent frames (reauth) and anything unknown never leave the sandbox
        return;
    }
  });
  opts.port.start?.();

  return {
    deliver(data) {
      let msg: Envelope;
      try {
        msg = JSON.parse(data) as Envelope;
      } catch {
        return;
      }
      if (msg.t === 'delta') commandsThisTick = 0;
      // The sandbox has its own snapshot from `auth`; server-side auth/snapshot frames belong to the host.
      if (msg.t === 'authOk' || msg.t === 'snapshot' || msg.t === 'pong') return;
      if (!authed) return;
      opts.port.postMessage(JSON.stringify({ ...msg, seq: ++seq }));
    },
    close(code = 1000, reason = 'host closed') {
      opts.port.postMessage({ type: 'close', code, reason });
      opts.port.close();
    },
  };
}
```

`packages/sandbox/src/srcdoc.ts`:

```ts
/** Messages the sandbox posts to its parent (validate `event.source === iframe.contentWindow`). */
export type SandboxMessage =
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; args: unknown[] }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'started' }
  | { type: 'finished' };

/** Message the parent posts to the sandbox, transferring the MessagePort. */
export type SandboxInit = { type: 'init' };

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const dataModule = (source: string): string => `data:text/javascript;base64,${toBase64(source)}`;

const BOOTSTRAP = `
const post = (m) => parent.postMessage(m, '*');
const safe = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); } };
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => post({ type: 'log', level, args: args.map(safe) });
}
addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));
addEventListener('error', (e) => post({ type: 'error', message: String(e.message), stack: e.error?.stack }));
addEventListener('message', async (ev) => {
  if (ev.source !== parent || ev.data?.type !== 'init' || !ev.ports[0]) return;
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
}, { once: true });
`;

/**
 * The HTML for a `sandbox="allow-scripts"` iframe (opaque origin): a CSP that allows only inline
 * and data: module scripts, an import map that resolves `@daemonet/sdk` to the bundled SDK, and a
 * bootstrap that waits for the port, imports the user's script as a data: module and runs it.
 */
export function buildSandboxHtml(opts: { sdkBundle: string; source: string }): string {
  const importMap = JSON.stringify({ imports: { '@daemonet/sdk': dataModule(opts.sdkBundle) } });
  const bootstrap = BOOTSTRAP.replace('USER_MODULE', JSON.stringify(dataModule(opts.source)));
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; connect-src 'none'">`,
    `<script type="importmap">${importMap.replace(/</g, '\\u003c')}</script>`,
    `<script type="module">${bootstrap.replace(/<\/script/gi, '<\\/script')}</script>`,
  ].join('\n');
}

export const SANDBOX_ATTRIBUTES = 'allow-scripts';
```

`packages/sandbox/src/index.ts`:

```ts
export { createBridge, type Bridge, type BridgeOptions, type HostState } from './bridge.js';
export { buildSandboxHtml, SANDBOX_ATTRIBUTES, type SandboxInit, type SandboxMessage } from './srcdoc.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 5 sandbox tests (the third drives a real `GameClient` over a `PortSocket`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sandbox): host bridge and opaque-origin srcdoc builder"
```

---

### Task 3: `@daemonet/sprites`

**Files:**
- Create: `packages/sprites/package.json`, `packages/sprites/tsconfig.json`, `packages/sprites/src/index.ts`
- Test: `packages/sprites/test/sprites.test.ts`

**Interfaces:**
- `SPRITE_SIZE = 16`, `interface Sprite { width; height; data: Uint8ClampedArray }`, `spriteFor(speciesId, { types, clean?, signature? }): Sprite`, `PALETTES: Record<TypeId, [dark, mid, light]>`, `signatureColor(tier): [r, g, b]`.
- Layers, outermost first: signature glow (distance 2, tier hue) → clean rim (distance 1, white) → body (edge = dark, highlight = light, else mid; rows ≥ 8 use the secondary type's palette).

- [ ] **Step 1: Package shell and failing tests**

`packages/sprites/package.json`:

```json
{
  "name": "@daemonet/sprites",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": {
    "@daemonet/rules": "workspace:*"
  }
}
```

`packages/sprites/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../rules" }]
}
```

`packages/sprites/test/sprites.test.ts`:

```ts
import { SPECIES } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { PALETTES, SPRITE_SIZE, signatureColor, spriteFor, type Sprite } from '../src/index.js';

const px = (s: Sprite, x: number, y: number) => Array.from(s.data.slice((y * SPRITE_SIZE + x) * 4, (y * SPRITE_SIZE + x) * 4 + 4));
const opaque = (s: Sprite) => {
  let n = 0;
  for (let i = 3; i < s.data.length; i += 4) if (s.data[i] === 255) n++;
  return n;
};

describe('spriteFor', () => {
  it('is deterministic and 16x16 RGBA', () => {
    const a = spriteFor('pingling', { types: ['packet'] });
    const b = spriteFor('pingling', { types: ['packet'] });
    expect(a.data).toEqual(b.data);
    expect(a.data.length).toBe(16 * 16 * 4);
    expect(spriteFor('hashling', { types: ['crypto'] }).data).not.toEqual(a.data);
  });

  it('is left-right symmetric with a non-trivial body', () => {
    for (const sp of SPECIES) {
      const s = spriteFor(sp.id, { types: sp.types });
      for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) expect(px(s, x, y)).toEqual(px(s, 15 - x, y));
      expect(opaque(s)).toBeGreaterThan(20);
      expect(opaque(s)).toBeLessThan(200);
    }
  });

  it('uses only the primary palette (and the secondary on the lower half) for body pixels', () => {
    const s = spriteFor('pingling', { types: ['packet', 'glitch'] });
    const allowed = new Set([...PALETTES.packet, ...PALETTES.glitch].map((c) => c.join(',')));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const [r, g, b, a] = px(s, x, y);
      if (a === 255) expect(allowed.has(`${r},${g},${b}`)).toBe(true);
    }
  });

  it('adds a white rim for clean images and a coloured glow for signatures', () => {
    const plain = spriteFor('nullpup', { types: ['null'] });
    const clean = spriteFor('nullpup', { types: ['null'], clean: true });
    const shiny = spriteFor('nullpup', { types: ['null'], clean: true, signature: 3 });
    expect(opaque(clean)).toBeGreaterThan(opaque(plain));
    expect(opaque(shiny)).toBeGreaterThan(opaque(clean));
    const white = (s: Sprite) => Array.from({ length: 256 }, (_, i) => px(s, i % 16, Math.floor(i / 16))).filter((p) => p.join(',') === '255,255,255,255').length;
    expect(white(clean)).toBeGreaterThan(0);
    expect(white(plain)).toBe(0);
    const glow = signatureColor(3).join(',');
    const glowPixels = Array.from({ length: 256 }, (_, i) => px(shiny, i % 16, Math.floor(i / 16))).filter((p) => p.slice(0, 3).join(',') === glow).length;
    expect(glowPixels).toBeGreaterThan(0);
  });

  it('spaces signature hues around the wheel', () => {
    const hues = new Set(Array.from({ length: 15 }, (_, i) => signatureColor(i + 1).join(',')));
    expect(hues.size).toBe(15);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm install
pnpm vitest run packages/sprites
```

Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Implement**

`packages/sprites/src/index.ts`:

```ts
import { TYPES, type TypeId } from '@daemonet/rules';

export const SPRITE_SIZE = 16;

export interface Sprite {
  width: number;
  height: number;
  /** RGBA, row-major, SPRITE_SIZE * SPRITE_SIZE * 4 bytes. */
  data: Uint8ClampedArray;
}

export interface SpriteOptions {
  types: readonly TypeId[];
  clean?: boolean;
  signature?: number;
}

type Rgb = readonly [number, number, number];
/** [dark, mid, light] per type. */
export const PALETTES: Record<TypeId, readonly [Rgb, Rgb, Rgb]> = {
  kernel: [[40, 44, 52], [110, 118, 129], [200, 205, 212]],
  packet: [[26, 84, 122], [54, 160, 220], [170, 220, 250]],
  crypto: [[92, 40, 120], [156, 92, 200], [220, 190, 245]],
  cache: [[128, 84, 20], [232, 164, 48], [250, 220, 150]],
  thread: [[20, 100, 90], [48, 190, 170], [170, 240, 225]],
  signal: [[150, 40, 40], [230, 80, 80], [250, 180, 180]],
  socket: [[30, 70, 130], [70, 130, 220], [180, 200, 245]],
  buffer: [[100, 90, 30], [200, 180, 60], [240, 230, 160]],
  shell: [[30, 90, 40], [70, 180, 90], [180, 235, 190]],
  root: [[110, 30, 30], [200, 50, 60], [245, 160, 170]],
  null: [[24, 24, 30], [70, 70, 90], [150, 150, 175]],
  glitch: [[120, 20, 110], [230, 60, 200], [250, 170, 240]],
  proxy: [[60, 60, 100], [130, 130, 190], [210, 210, 240]],
  cloud: [[70, 100, 130], [150, 190, 220], [230, 240, 250]],
  stack: [[110, 70, 20], [200, 130, 50], [245, 205, 150]],
  heap: [[40, 90, 60], [90, 170, 110], [190, 235, 200]],
};

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Hue for signature tier k (1-15): 16 evenly spaced hues, converted to RGB at full saturation. */
export function signatureColor(tier: number): Rgb {
  const h = ((tier * 22.5) % 360) / 60;
  const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
  const i = Math.floor(h) % 6;
  const table: Rgb[] = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]];
  return table[i]!;
}

/**
 * Deterministic 16x16 pixel-art body for a species: a random 6-wide half (columns 2-7) over rows
 * 2-13, smoothed once (a cell survives with >= 2 live neighbours, is born with 3), mirrored across
 * the centre. Fill = the primary type's mid colour (rows 8+ use the secondary type when present),
 * body edges = dark, a few highlights = light. `clean` draws a 1-px white rim around the body;
 * `signature` >= 1 draws a glow ring one pixel further out in the tier's hue.
 */
export function spriteFor(speciesId: string, opts: SpriteOptions): Sprite {
  const size = SPRITE_SIZE;
  const rand = lcg(fnv1a(speciesId));
  const primary = opts.types[0] ?? 'null';
  const secondary = opts.types[1] ?? primary;

  // half grid: rows 2..13, cols 2..7 (mirrored to 8..13)
  let half: boolean[][] = Array.from({ length: size }, () => Array<boolean>(8).fill(false));
  for (let y = 2; y <= 13; y++) for (let x = 2; x <= 7; x++) half[y]![x] = rand() < 0.48;
  const alive = (g: boolean[][], y: number, x: number) => (g[y]?.[x] ?? false);
  const next: boolean[][] = half.map((row) => [...row]);
  for (let y = 2; y <= 13; y++) {
    for (let x = 2; x <= 7; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && alive(half, y + dy, x + dx)) n++;
      // the mirror column counts as a neighbour of column 7
      if (x === 7 && alive(half, y, 7)) n++;
      next[y]![x] = half[y]![x] ? n >= 2 : n === 3;
    }
  }
  half = next;
  // guarantee a body: the centre pixels are always on
  half[7]![7] = true;
  half[8]![7] = true;

  const body: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (let y = 0; y < size; y++) for (let x = 0; x < 8; x++) body[y]![x] = body[y]![size - 1 - x] = half[y]![x]!;

  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const isBody = (x: number, y: number) => (body[y]?.[x] ?? false);
  const near = (x: number, y: number, d: number) => {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (isBody(x + dx, y + dy)) return true;
    return false;
  };

  // outer glow (distance 2), then rim (distance 1), then body — later layers overwrite
  if ((opts.signature ?? 0) >= 1) {
    const glow = signatureColor(opts.signature!);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isBody(x, y) && !near(x, y, 1) && near(x, y, 2)) put(x, y, glow);
  }
  if (opts.clean) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isBody(x, y) && near(x, y, 1)) put(x, y, [255, 255, 255]);
  }
  // highlights are keyed by the mirrored column so the sprite stays symmetric
  const highlight = (x: number, y: number) => fnv1a(`${speciesId}:${Math.min(x, size - 1 - x)}:${y}`) % 100 < 15;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isBody(x, y)) continue;
      const pal = PALETTES[y >= 8 ? secondary : primary];
      const edge = !isBody(x - 1, y) || !isBody(x + 1, y) || !isBody(x, y - 1) || !isBody(x, y + 1);
      put(x, y, edge ? pal[0] : highlight(x, y) ? pal[2] : pal[1]);
    }
  }
  return { width: size, height: size, data };
}

/** All 16 type ids, for palette previews. */
export const SPRITE_TYPES = TYPES;
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 5 sprite tests; whole suite 23 files, 174 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sprites): deterministic procedural species sprites"
```

---

### Task 4: Manual browser check of the sandbox

**Files:**
- Create: `packages/sdk/verify/host.ts`, `packages/sdk/verify/index.html`, `packages/sdk/verify/vite.config.ts`

This is the one piece Node cannot prove: that a real `sandbox="allow-scripts"` iframe with the generated `srcdoc` loads the SDK through the import map, runs the script, and is isolated. The page below fakes the server side (it acks every command) so no sim is needed.

- [ ] **Step 1: Create the verify page**

`packages/sdk/verify/host.ts`:

```ts
import { buildSandboxHtml, createBridge, SANDBOX_ATTRIBUTES } from '@daemonet/sandbox';
import type { OperatorSelf } from '@daemonet/shared';

const log = (line: string) => {
  const el = document.getElementById('log')!;
  el.textContent += line + '\n';
};
const self: OperatorSelf = { id: 'op1', name: 'alice', starterClaimed: true, x: 5, y: 5, bits: 0, ram: [], running: [], inventory: {}, swapReadyTick: 0, capture: null };
const sdkBundle = await (await fetch('/sdk.js')).text();
const source = `
export default async function main(game) {
  let cookie; try { cookie = JSON.stringify(document.cookie); } catch (e) { cookie = 'blocked: ' + e.name; }
  console.log('hello from sandbox, tick', game.tick, 'me', game.self.name, 'cookie?', cookie);
  try { await fetch('/api/me'); console.log('fetch allowed?!'); } catch (e) { console.log('fetch blocked:', String(e.message)); }
  await game.operator.stop();
  console.log('stop acked');
}`;
const iframe = document.createElement('iframe');
iframe.setAttribute('sandbox', SANDBOX_ATTRIBUTES);
iframe.srcdoc = buildSandboxHtml({ sdkBundle, source });
const channel = new MessageChannel();
const bridge = createBridge({
  port: channel.port1,
  send: (frame) => {
    log('host<-sandbox cmd: ' + frame.slice(0, 60));
    const reqId = (JSON.parse(frame) as { d: { reqId: string } }).d.reqId;
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId } }));
  },
  state: () => ({ operatorId: 'op1', role: 'controller', tick: 7, subnet: 'lo', self, entities: [] }),
});
window.addEventListener('message', (ev) => {
  if (ev.source !== iframe.contentWindow) return;
  log('sandbox says: ' + JSON.stringify(ev.data));
});
iframe.addEventListener('load', () => iframe.contentWindow!.postMessage({ type: 'init' }, '*', [channel.port2]));
document.body.append(iframe);
log('host ready; document.cookie on host = ' + JSON.stringify(document.cookie));
```

`packages/sdk/verify/index.html`:

```html
<!doctype html><meta charset="utf-8"><title>sandbox verify</title>
<pre id="log"></pre>
<script type="module" src="/host.js"></script>
```

`packages/sdk/verify/vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: here,
  resolve: { alias: { '@daemonet/sandbox': fileURLToPath(new URL('../../sandbox/src/index.ts', import.meta.url)), '@daemonet/sdk': fileURLToPath(new URL('../src/index.ts', import.meta.url)) } },
  build: { lib: { entry: 'host.ts', formats: ['es'], fileName: () => 'host.js' }, outDir: fileURLToPath(new URL('../dist/verify', import.meta.url)), emptyOutDir: true, target: 'es2023', minify: false, rollupOptions: { external: [] } },
});
```

- [ ] **Step 2: Build and serve it**

```bash
pnpm --filter @daemonet/sdk build:sandbox
pnpm --filter @daemonet/sdk exec vite build --config verify/vite.config.ts
cp packages/sdk/verify/index.html packages/sdk/dist/sandbox/sdk.js packages/sdk/dist/verify/
cd packages/sdk/dist/verify && python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/index.html` in a browser.

- [ ] **Step 3: Verify the page shows, in order**

```
host ready; document.cookie on host = ""
host<-sandbox cmd: {"t":"cmd",…"cmd":"stop"…
sandbox says: {"type":"started"}
sandbox says: {"type":"log","level":"log","args":["hello from sandbox, tick",7,"me","alice","cookie?","blocked: SecurityError"]}
sandbox says: {"type":"log","level":"log","args":["fetch blocked:","Failed to fetch"]}
sandbox says: {"type":"log","level":"log","args":["stop acked"]}
sandbox says: {"type":"finished"}
```

`blocked: SecurityError` proves the opaque origin (no cookie access); `fetch blocked` proves the CSP (`connect-src 'none'`); `stop acked` proves the round trip through the bridge. Stop the server (Ctrl+C).

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "chore(sdk): browser verification page for the sandbox"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: CI green (the verify page is not part of the build or tests; its output lands under `packages/sdk/dist/verify/`, which lint and git ignore).
