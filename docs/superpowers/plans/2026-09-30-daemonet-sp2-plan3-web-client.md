# Daemonet SP2 · Plan 3 — Web client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/frontend` — the browser client: Authentik (or dev) login, a canvas world view with manual play (click-to-move, targeting, moves, captures with a typed answer, run/recall/swap, restore, store/load), RAM/Disk/Items/Codex/Log panels, a Monaco editor with autosave and versions that runs the operator's script in the sandbox from plan 2, Control/Spectate modes, a Playwright smoke test, the production image, and an e2e job in CI.

**Architecture:** React 19 + Vite 8 + Tailwind 4. Server data (me, scripts, disk, codex) goes through RTK Query; the live game state is the SDK's `GameClient` held in a tiny external store (`useSyncExternalStore`, bumped every tick) so components read `client.self` / `client.world` directly. The tab authenticates its WebSocket with a single-use ticket from the API on every (re)connect. `game/sandbox.ts` creates the opaque-origin iframe and wires `@daemonet/sandbox`'s bridge to the host client's raw frames (`client.sendFrame` / `on('frame')`). Rendering is a `requestAnimationFrame` loop over pure drawing helpers with sprites from `@daemonet/sprites`. Monaco is bundled locally (the CSP forbids its CDN loader) with Vite-built workers.

**Tech Stack:** react ^19.3, vite ^8.3 (+ @vitejs/plugin-react, @tailwindcss/vite), @reduxjs/toolkit ^2.13 + react-redux ^9.3, monaco-editor ^0.57 + @monaco-editor/react ^4.7, @playwright/test ^1.63, Vitest.

**Prerequisites:** SP2 plans 1–2 merged. Local sim + api with `AUTH_DEV_BYPASS=true` (OPERATIONS.md "Local development").

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp2-web-client-design.md` §5 (host side), §6, §9–§11.

## Global Constraints

- Everything from the earlier plans.
- The tab holds exactly one WebSocket; the sandbox iframe never sees a credential (auth is answered by the bridge; `connect-src 'none'` in the iframe).
- Manual controls and Run are disabled in Spectate mode (`client.role !== 'controller'`).
- Every mutating API call carries `X-Requested-With: daemonet` (RTK `prepareHeaders`; `fetchTicket` sets it too).
- Monaco 0.57 exposes its TypeScript API as `monaco.typescript` (not `monaco.languages.typescript`) and needs `MonacoEnvironment.getWorker` with Vite `?worker` imports — its own `new URL('…?esm')` fallback breaks under Vite.
- `apps/frontend/public/sdk.js` is copied from `packages/sdk/dist/sandbox/sdk.js` by the `sdk` script (git- and lint-ignored).
- Frontend sources import with `.ts`/`.tsx` extensions (bundler resolution); they are type-checked by `apps/frontend/tsconfig.json`, not `tsconfig.tests.json`.
- Playwright tests live in `apps/frontend/e2e` and are excluded from Vitest.

## File map

```
packages/sdk/src/client.ts            +role, subnet, sendFrame(), 'frame' event
apps/frontend/
  package.json, tsconfig.json, vite.config.ts, index.html, playwright.config.ts, Dockerfile
  src/main.tsx, App.tsx, styles.css, api.ts, types.ts, sdk-types.ts
  src/game/log.ts, connection.ts, controls.ts, sandbox.ts
  src/render/camera.ts, draw.ts
  src/components/WorldCanvas.tsx, TopBar.tsx
  src/panels/PlayPanel.tsx (+CapturePanel), RamPanel.tsx (+SpriteImg), DiskPanel.tsx, CodexPanel.tsx (+ItemsPanel), LogPanel.tsx, ScriptPanel.tsx
  test/client.test.ts, e2e/smoke.spec.ts
tsconfig.tests.json, vitest.config.ts, eslint.config.js, .gitignore, package.json (root scripts), .github/workflows/ci.yml, OPERATIONS.md
```

---

### Task 1: SDK hooks for the host page and the frontend package shell

**Files:**
- Modify: `packages/sdk/src/client.ts`
- Create: `apps/frontend/package.json`, `apps/frontend/tsconfig.json`, `apps/frontend/vite.config.ts`, `apps/frontend/index.html`, `apps/frontend/src/styles.css`
- Modify: `tsconfig.tests.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `package.json` (root)

**Interfaces:**
- `GameClient` gains `role: 'controller' | 'spectator'` (from `authOk`), `subnet: string` (from `snapshot`), `sendFrame(raw: string)`, and emits `'frame'` with every raw server frame before handling it.
- Root scripts: `typecheck` also runs `tsc -p apps/frontend/tsconfig.json`; `web` starts the Vite dev server.

- [ ] **Step 1: SDK changes**

In `packages/sdk/src/client.ts`:

1. In the `GameClient` class fields, after `operatorId = '';` add:
   ```ts
   role: 'controller' | 'spectator' = 'controller';
   subnet = '';
   ```
2. In `ClientEvents`, after `scriptError: unknown;` add:
   ```ts
   /** Every raw frame received from the server (used by the sandbox bridge). */
   frame: string;
   ```
3. After `dropConnection()` add:
   ```ts
   /** Sends a raw protocol frame (the sandbox bridge forwards already-validated `cmd` frames this way). */
   sendFrame(raw: string): void {
     this.sendRaw(JSON.parse(raw));
   }
   ```
4. In `handle()`, right after the `ServerMessage.parse` try/catch, add `this.emit('frame', raw);`; in `case 'authOk'` add `this.role = msg.d.role;` after `this.operatorId = …`; in `case 'snapshot'` add `this.subnet = msg.d.subnet;` after `this.tick = msg.d.tick;`.

- [ ] **Step 2: Frontend package shell**

`apps/frontend/package.json`:

```json
{
  "name": "@daemonet/frontend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "sdk": "pnpm --filter @daemonet/sdk build:sandbox && node -e \"require('node:fs').copyFileSync('../../packages/sdk/dist/sandbox/sdk.js','public/sdk.js')\"",
    "dev": "vite",
    "build": "pnpm sdk && tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@daemonet/rules": "workspace:*",
    "@daemonet/sandbox": "workspace:*",
    "@daemonet/sdk": "workspace:*",
    "@daemonet/shared": "workspace:*",
    "@daemonet/sprites": "workspace:*",
    "@monaco-editor/react": "^4.7.0",
    "@reduxjs/toolkit": "^2.13.0",
    "monaco-editor": "^0.57.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-redux": "^9.3.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0",
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.1.1",
    "tailwindcss": "^4.3.3",
    "vite": "^8.3.1"
  }
}
```

`apps/frontend/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": [
      "ES2023",
      "DOM",
      "DOM.Iterable"
    ],
    "types": [
      "vite/client",
      "node"
    ],
    "allowImportingTsExtensions": true
  },
  "include": [
    "src",
    "test",
    "e2e"
  ]
}
```

`apps/frontend/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the API and sim run locally with AUTH_DEV_BYPASS=true (see OPERATIONS.md "Local development").
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001' },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 4000 },
});
```

`apps/frontend/index.html`:

```html
<!doctype html>
<html lang="en" class="h-full">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daemonet</title>
  </head>
  <body class="h-full bg-neutral-950 text-neutral-200">
    <div id="root" class="h-full"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/frontend/src/styles.css`:

```css
@import "tailwindcss";

:root {
  color-scheme: dark;
}

body {
  font-family: ui-sans-serif, system-ui, sans-serif;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

canvas {
  image-rendering: pixelated;
}
```

- [ ] **Step 3: Root wiring**

Replace `tsconfig.tests.json` with:

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
  ],
  "exclude": [
    "apps/frontend/**"
  ]
}
```

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/frontend/e2e/**'],
    testTimeout: 30_000,
    // Several suites share the one PostgreSQL in DATABASE_URL and truncate it; keep files sequential.
    fileParallelism: false,
  },
});
```

Replace `eslint.config.js` with:

```js
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'apps/frontend/public/sdk.js'] },
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]);
```

Append `apps/frontend/public/sdk.js` to `.gitignore`. In the root `package.json` `scripts` set:

```json
"typecheck": "pnpm generate && tsc -b && tsc -p tsconfig.tests.json && tsc -p examples/starter-bot/tsconfig.json && tsc -p apps/frontend/tsconfig.json",
"web": "pnpm --filter @daemonet/frontend dev"
```

- [ ] **Step 4: Install and check**

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Expected: PASS (the frontend has no sources yet; its `tsc -p` is empty).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(frontend): package shell; sdk exposes role, subnet and raw frames"
```

---

### Task 2: Client state — API, connection, log, controls, sandbox runner, camera

**Files:**
- Create: `apps/frontend/src/api.ts`, `apps/frontend/src/types.ts`, `apps/frontend/src/game/log.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/game/controls.ts`, `apps/frontend/src/game/sandbox.ts`, `apps/frontend/src/render/camera.ts`
- Test: `apps/frontend/test/client.test.ts`

**Interfaces:**
- `api` (RTK Query) with hooks `useMeQuery`, `useCodexQuery`, `useDiskQuery`, `useScriptQuery`, `useVersionsQuery`, `useLazyVersionQuery`, `useSaveScriptMutation`, `useLogoutMutation`; `fetchTicket()` for the connection manager.
- `log` store: `createLog(limit)`, `log.push(kind, text)`, `useLog()`, kinds `event | script | error | reject | system`.
- connection: `open(role)`, `close()`, `useConnection()` → `{ status, role, client, version, kickReason }`, `useGame()` → `GameClient | null`.
- controls: `useControls()` / `setControls()` → `{ actor: 'self' | daemonId; targetId; tool; zoom }`, `parseAnswer(text)`.
- sandbox: `start(client, source)`, `stop()`, `useSandboxStatus()` → `stopped | starting | running | finished | errored`.
- camera: `TILE = 16`, `worldToScreen`, `screenToWorld`, `visibleTiles`, `scale`.

- [ ] **Step 1: Write the failing tests**

`apps/frontend/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../src/game/controls.ts';
import { createLog } from '../src/game/log.ts';
import { screenToWorld, visibleTiles, worldToScreen, type Camera } from '../src/render/camera.ts';

describe('camera', () => {
  const cam: Camera = { cx: 10, cy: 10, zoom: 2, width: 640, height: 480 };

  it('round-trips world and screen coordinates', () => {
    const s = worldToScreen(cam, 12.5, 9);
    expect(s).toEqual({ sx: 320 + 2.5 * 32, sy: 240 - 32 });
    const w = screenToWorld(cam, s.sx, s.sy);
    expect(w.x).toBeCloseTo(12.5);
    expect(w.y).toBeCloseTo(9);
  });

  it('clamps the visible tile range to the map', () => {
    expect(visibleTiles({ ...cam, cx: 1, cy: 1 }, 128, 128)).toEqual({ x0: 0, y0: 0, x1: 11, y1: 9 });
    expect(visibleTiles({ ...cam, cx: 127, cy: 127 }, 128, 128).x1).toBe(127);
  });
});

describe('log', () => {
  it('keeps the newest entries within the limit and notifies subscribers', () => {
    const l = createLog(3);
    let notified = 0;
    l.subscribe(() => notified++);
    for (let i = 1; i <= 5; i++) l.push('event', `e${i}`);
    expect(l.get().map((e) => e.text)).toEqual(['e3', 'e4', 'e5']);
    expect(notified).toBe(5);
    l.clear();
    expect(l.get()).toEqual([]);
  });
});

describe('parseAnswer', () => {
  it('accepts JSON objects only', () => {
    expect(parseAnswer('{"checksum":"0a1b2c3d"}')).toEqual({ ok: true, value: { checksum: '0a1b2c3d' } });
    expect(parseAnswer('[1]').ok).toBe(false);
    expect(parseAnswer('42').ok).toBe(false);
    expect(parseAnswer('{oops').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/frontend`
Expected: FAIL — cannot resolve `../src/game/controls.ts`.

- [ ] **Step 3: Implement**

`apps/frontend/src/types.ts`:

```ts
import type { ItemDef, MoveDef, Nature, SpeciesDef, TraitDef, TypeId } from '@daemonet/rules';

export type { ItemDef, MoveDef, SpeciesDef, TraitDef, TypeId };
export type NatureDef = Nature;
```

`apps/frontend/src/api.ts`:

```ts
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { ItemDef, MoveDef, NatureDef, SpeciesDef, TraitDef, TypeId } from './types.ts';

export interface Me {
  operatorId: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  isAdmin: boolean;
}
export interface ScriptDoc {
  source: string;
  version: number;
  updatedAt: string | null;
}
export interface ScriptVersion {
  version: number;
  createdAt: string;
  bytes: number;
}
export interface DiskDaemon {
  id: string;
  species: string;
  level: number;
  clean: boolean;
  signature: number;
  slot: number;
  hp: number;
  moves: string[];
  ivs: number[];
  log: { originalOperatorId: string; capturedAt: string; subnet: string; tool: string; spawnIndex: number | null };
}
export interface Codex {
  types: TypeId[];
  chart: Record<TypeId, Record<TypeId, number>>;
  species: SpeciesDef[];
  moves: MoveDef[];
  items: ItemDef[];
  natures: NatureDef[];
  traits: TraitDef[];
}

/** All mutations carry the CSRF header the API requires. */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api',
    credentials: 'same-origin',
    prepareHeaders: (headers) => {
      headers.set('x-requested-with', 'daemonet');
      return headers;
    },
  }),
  tagTypes: ['Me', 'Script', 'Disk'],
  endpoints: (b) => ({
    me: b.query<Me, void>({ query: () => '/me', providesTags: ['Me'] }),
    codex: b.query<Codex, void>({ query: () => '/codex' }),
    disk: b.query<DiskDaemon[], void>({ query: () => '/disk', providesTags: ['Disk'] }),
    script: b.query<ScriptDoc, void>({ query: () => '/scripts/main', providesTags: ['Script'] }),
    versions: b.query<ScriptVersion[], void>({ query: () => '/scripts/main/versions', providesTags: ['Script'] }),
    version: b.query<{ version: number; source: string }, number>({ query: (v) => `/scripts/main/versions/${v}` }),
    saveScript: b.mutation<{ version: number; updatedAt: string }, { source: string }>({
      query: (body) => ({ url: '/scripts/main', method: 'PUT', body }),
      invalidatesTags: ['Script'],
    }),
    ticket: b.mutation<{ ticket: string }, void>({ query: () => ({ url: '/ws/ticket', method: 'POST' }) }),
    logout: b.mutation<{ ok: boolean; endSessionUrl: string | null }, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }) }),
  }),
});

export const { useMeQuery, useCodexQuery, useDiskQuery, useScriptQuery, useVersionsQuery, useLazyVersionQuery, useSaveScriptMutation, useLogoutMutation } = api;

/** Used outside React (the connection manager) to mint a fresh websocket ticket. */
export async function fetchTicket(): Promise<string> {
  const res = await fetch('/api/ws/ticket', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'daemonet' } });
  if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
  return ((await res.json()) as { ticket: string }).ticket;
}
```

`apps/frontend/src/game/log.ts`:

```ts
import { useSyncExternalStore } from 'react';

export type LogKind = 'event' | 'script' | 'error' | 'reject' | 'system';

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  text: string;
}

export const LOG_LIMIT = 512;

/** A tiny append-only log store shared by the connection, the sandbox and the UI. */
export function createLog(limit = LOG_LIMIT) {
  let entries: LogEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    push(kind: LogKind, text: string, at = Date.now()) {
      entries = [...entries, { id: nextId++, at, kind, text }];
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      notify();
    },
    clear() {
      entries = [];
      notify();
    },
    get: () => entries,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Log = ReturnType<typeof createLog>;
export const log = createLog();

export function useLog(): LogEntry[] {
  return useSyncExternalStore(log.subscribe, log.get, log.get);
}
```

`apps/frontend/src/game/connection.ts`:

```ts
import { connect, type GameClient, type TokenSource } from '@daemonet/sdk';
import { useSyncExternalStore } from 'react';
import { fetchTicket } from '../api.ts';
import { log } from './log.ts';

export type Role = 'controller' | 'spectator';
export type Status = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'kicked';

export interface ConnectionState {
  status: Status;
  role: Role;
  client: GameClient | null;
  /** Bumped on every tick so subscribers re-render. */
  version: number;
  kickReason: string | null;
}

let state: ConnectionState = { status: 'idle', role: 'controller', client: null, version: 0, kickReason: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<ConnectionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

/** Every (re)connect mints a fresh single-use ticket; the SDK calls getToken on each attempt. */
const ticketSource: TokenSource = { getToken: () => fetchTicket() };

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export async function open(role: Role): Promise<void> {
  if (state.client) state.client.close();
  set({ status: 'connecting', role, client: null, kickReason: null });
  try {
    const client = await connect({ url: wsUrl(), auth: ticketSource, role });
    client.on('tick', () => set({ version: state.version + 1 }));
    client.on('disconnect', () => {
      if (state.status !== 'kicked') set({ status: 'reconnecting' });
    });
    client.on('reconnect', () => set({ status: 'online' }));
    client.on('kick', (reason) => {
      set({ status: 'kicked', kickReason: reason });
      log.push('system', `kicked: ${reason}`);
    });
    client.on('error', (e) => log.push('reject', e.message));
    client.on('scriptError', (e) => log.push('error', String((e as Error)?.message ?? e)));
    client.on('levelUp', (e) => log.push('event', `${e.daemon} reached level ${e.level}`));
    client.on('captureResult', (e) => log.push('event', e.ok ? `captured ${e.daemon?.species ?? 'to Disk'}` : `capture failed: ${e.reason}`));
    client.on('signatureSpawn', (e) => log.push('event', `${e.clean ? 'clean' : ''}${e.signature ? ` T${e.signature}` : ''} ${e.species} spawned somewhere in the subnet`));
    client.on('crash', (e) => log.push('event', `${e.daemon} crashed`));
    set({ status: 'online', client, role });
    log.push('system', `connected as ${role}`);
  } catch (err) {
    set({ status: 'idle' });
    log.push('error', `connect failed: ${(err as Error).message}`);
    throw err;
  }
}

export function close(): void {
  state.client?.close();
  set({ status: 'idle', client: null });
}

export function useConnection(): ConnectionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** The live client, re-rendering on every tick. Components read `client.self` / `client.world` directly. */
export function useGame(): GameClient | null {
  return useConnection().client;
}
```

`apps/frontend/src/game/controls.ts`:

```ts
import type { ToolId } from '@daemonet/rules';
import { useSyncExternalStore } from 'react';

/** Manual-play selection: which actor a map click moves, which daemon is targeted, which tool captures. */
export interface Controls {
  actor: 'self' | string;
  targetId: string | null;
  tool: ToolId;
  zoom: 1 | 2 | 3 | 4;
}

let controls: Controls = { actor: 'self', targetId: null, tool: 'sniff', zoom: 2 };
const listeners = new Set<() => void>();

export function setControls(patch: Partial<Controls>): void {
  controls = { ...controls, ...patch };
  listeners.forEach((l) => l());
}

export function getControls(): Controls {
  return controls;
}

export function useControls(): Controls {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => controls,
    () => controls,
  );
}

/** Parses a typed capture answer: must be a JSON object. */
export function parseAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'the answer must be a JSON object, e.g. {"checksum":"0a1b2c3d"}' };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}
```

`apps/frontend/src/game/sandbox.ts`:

```ts
import { buildSandboxHtml, createBridge, SANDBOX_ATTRIBUTES, type Bridge, type SandboxMessage } from '@daemonet/sandbox';
import type { GameClient } from '@daemonet/sdk';
import { useSyncExternalStore } from 'react';
import { log } from './log.ts';

export type SandboxStatus = 'stopped' | 'starting' | 'running' | 'finished' | 'errored';

let status: SandboxStatus = 'stopped';
let iframe: HTMLIFrameElement | null = null;
let bridge: Bridge | null = null;
let unsubscribeFrames: (() => void) | null = null;
let sdkBundle: string | null = null;
const listeners = new Set<() => void>();
const set = (s: SandboxStatus) => {
  status = s;
  listeners.forEach((l) => l());
};

async function loadSdk(): Promise<string> {
  if (sdkBundle) return sdkBundle;
  const res = await fetch('/sdk.js');
  if (!res.ok) throw new Error(`could not load /sdk.js (${res.status})`);
  sdkBundle = await res.text();
  return sdkBundle;
}

function onSandboxMessage(ev: MessageEvent): void {
  if (!iframe || ev.source !== iframe.contentWindow) return;
  const m = ev.data as SandboxMessage;
  switch (m?.type) {
    case 'log':
      log.push('script', m.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      return;
    case 'error':
      log.push('error', m.message);
      set('errored');
      return;
    case 'started':
      set('running');
      return;
    case 'finished':
      set('finished');
      return;
  }
}

/** Runs `source` in an opaque-origin iframe wired to `client` through the bridge. */
export async function start(client: GameClient, source: string): Promise<void> {
  stop();
  set('starting');
  const sdk = await loadSdk();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX_ATTRIBUTES);
  frame.style.display = 'none';
  frame.srcdoc = buildSandboxHtml({ sdkBundle: sdk, source });
  const channel = new MessageChannel();
  bridge = createBridge({
    port: channel.port1,
    send: (raw) => client.sendFrame(raw),
    state: () => ({
      operatorId: client.operatorId,
      role: client.role,
      tick: client.tick,
      subnet: client.subnet,
      self: client.self,
      entities: [...client.entities.values()],
    }),
  });
  unsubscribeFrames = client.on('frame', (raw) => bridge?.deliver(raw));
  window.addEventListener('message', onSandboxMessage);
  frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: 'init' }, '*', [channel.port2]));
  iframe = frame;
  document.body.append(frame);
  log.push('system', 'script started');
}

export function stop(): void {
  if (!iframe) return;
  window.removeEventListener('message', onSandboxMessage);
  unsubscribeFrames?.();
  bridge?.close();
  iframe.remove();
  iframe = null;
  bridge = null;
  unsubscribeFrames = null;
  set('stopped');
  log.push('system', 'script stopped');
}

export function useSandboxStatus(): SandboxStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
    () => status,
  );
}
```

`apps/frontend/src/render/camera.ts`:

```ts
export const TILE = 16;

export interface Camera {
  /** World position at the centre of the screen. */
  cx: number;
  cy: number;
  zoom: number;
  width: number;
  height: number;
}

export const scale = (cam: Camera): number => TILE * cam.zoom;

export function worldToScreen(cam: Camera, x: number, y: number): { sx: number; sy: number } {
  const s = scale(cam);
  return { sx: (x - cam.cx) * s + cam.width / 2, sy: (y - cam.cy) * s + cam.height / 2 };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  const s = scale(cam);
  return { x: (sx - cam.width / 2) / s + cam.cx, y: (sy - cam.height / 2) / s + cam.cy };
}

/** Inclusive tile range visible on screen, clamped to the map. */
export function visibleTiles(cam: Camera, mapW: number, mapH: number): { x0: number; y0: number; x1: number; y1: number } {
  const tl = screenToWorld(cam, 0, 0);
  const br = screenToWorld(cam, cam.width, cam.height);
  return {
    x0: Math.max(0, Math.floor(tl.x)),
    y0: Math.max(0, Math.floor(tl.y)),
    x1: Math.min(mapW - 1, Math.ceil(br.x)),
    y1: Math.min(mapH - 1, Math.ceil(br.y)),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 4 frontend tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(frontend): api, connection, log, controls, sandbox runner and camera"
```

---

### Task 3: Rendering and the UI

**Files:**
- Create: `apps/frontend/src/render/draw.ts`, `apps/frontend/src/components/WorldCanvas.tsx`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/panels/PlayPanel.tsx`, `apps/frontend/src/panels/RamPanel.tsx`, `apps/frontend/src/panels/DiskPanel.tsx`, `apps/frontend/src/panels/CodexPanel.tsx`, `apps/frontend/src/panels/LogPanel.tsx`, `apps/frontend/src/panels/ScriptPanel.tsx`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/main.tsx`

**Interfaces:**
- `drawWorld({ ctx, cam, client, controls, hover })`, `spriteCanvas(species, types, clean, signature)`, `subnetGeometry(id)`.
- `run(promise, label)` — sends a manual command and logs rejections (exported from `WorldCanvas.tsx`, used by every panel).
- Keyboard on the canvas: `Tab` cycles actor (operator → running daemons), `Esc` clears, `C` captures the target with the selected tool, `R` runs the first idle daemon / recalls the selected one, `1–4` use the selected daemon's move on the target (area moves at the target or hovered tile).
- `SDK_TYPES` (Monaco extra lib) and `STARTER_TEMPLATE` (the same logic as `examples/starter-bot`).

- [ ] **Step 1: Implement the renderer**

`apps/frontend/src/render/draw.ts`:

```ts
import { getSubnet, type SubnetDef } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { signatureColor, spriteFor, SPRITE_SIZE } from '@daemonet/sprites';
import type { Controls } from '../game/controls.ts';
import { scale, visibleTiles, worldToScreen, type Camera } from './camera.ts';

const spriteCache = new Map<string, HTMLCanvasElement>();

/** A cached canvas per (species, types, clean, signature). */
export function spriteCanvas(species: string, types: readonly string[], clean: boolean, signature: number): HTMLCanvasElement {
  const key = `${species}|${types.join('/')}|${clean ? 1 : 0}|${signature}`;
  let c = spriteCache.get(key);
  if (!c) {
    const s = spriteFor(species, { types: types as never, clean, signature });
    c = document.createElement('canvas');
    c.width = c.height = SPRITE_SIZE;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.data), SPRITE_SIZE, SPRITE_SIZE), 0, 0);
    spriteCache.set(key, c);
  }
  return c;
}

const subnetCache = new Map<string, { def: SubnetDef; blocked: Uint8Array }>();
export function subnetGeometry(id: string): { def: SubnetDef; blocked: Uint8Array } {
  let g = subnetCache.get(id);
  if (!g) {
    const def = getSubnet(id);
    const blocked = new Uint8Array(def.width * def.height);
    const block = (x: number, y: number) => (blocked[y * def.width + x] = 1);
    for (let x = 0; x < def.width; x++) {
      block(x, 0);
      block(x, def.height - 1);
    }
    for (let y = 0; y < def.height; y++) {
      block(0, y);
      block(def.width - 1, y);
    }
    for (const r of def.walls) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) block(x, y);
    g = { def, blocked };
    subnetCache.set(id, g);
  }
  return g;
}

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  client: GameClient;
  controls: Controls;
  hover: { x: number; y: number } | null;
}

const COLORS = {
  floor: '#0f1620',
  wall: '#2a3442',
  region: 'rgba(80, 140, 255, 0.05)',
  host: '#ffd166',
  self: '#7dd3fc',
  other: '#a3a3a3',
  hp: '#22c55e',
  hpBack: '#3f1d1d',
  tagMine: '#f59e0b',
  tagOther: '#ef4444',
  hardened: '#f97316',
  select: '#ffffff',
  target: '#f472b6',
  path: 'rgba(125, 211, 252, 0.6)',
  link: '#a78bfa',
};

export function drawWorld({ ctx, cam, client, controls, hover }: DrawInput): void {
  const s = scale(cam);
  const { def, blocked } = subnetGeometry(client.subnet);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, cam.width, cam.height);

  const v = visibleTiles(cam, def.width, def.height);
  ctx.fillStyle = COLORS.region;
  for (const r of def.regions) {
    const p = worldToScreen(cam, r.rect.x, r.rect.y);
    ctx.fillRect(p.sx, p.sy, r.rect.w * s, r.rect.h * s);
  }
  ctx.fillStyle = COLORS.wall;
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (blocked[y * def.width + x]) {
        const p = worldToScreen(cam, x, y);
        ctx.fillRect(p.sx, p.sy, s, s);
      }
    }
  }
  const host = worldToScreen(cam, def.host.x, def.host.y);
  ctx.strokeStyle = COLORS.host;
  ctx.lineWidth = 2;
  ctx.strokeRect(host.sx - s, host.sy - s, 2 * s, 2 * s);
  ctx.fillStyle = COLORS.host;
  ctx.font = `${Math.max(10, s * 0.6)}px ui-monospace`;
  ctx.fillText('host', host.sx - s, host.sy - s - 4);

  const me = client.self;
  const capture = me.capture;
  for (const e of client.entities.values()) {
    const p = worldToScreen(cam, e.x, e.y);
    if (e.kind === 'operator') {
      ctx.fillStyle = e.id === client.operatorId ? COLORS.self : COLORS.other;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, s * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(e.name ?? '?', p.sx + s * 0.4, p.sy - s * 0.4);
      continue;
    }
    const sprite = spriteCanvas(e.species, e.types, e.clean, e.signature);
    const size = s;
    if (e.signature > 0) {
      const [r, g, b] = signatureColor(e.signature);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, size * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.drawImage(sprite, p.sx - size / 2, p.sy - size / 2, size, size);
    if (e.hardened) {
      ctx.strokeStyle = COLORS.hardened;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.sx - size / 2, p.sy - size / 2, size, size);
    }
    // HP bar
    const w = size;
    ctx.fillStyle = COLORS.hpBack;
    ctx.fillRect(p.sx - w / 2, p.sy + size / 2 + 1, w, 3);
    ctx.fillStyle = COLORS.hp;
    ctx.fillRect(p.sx - w / 2, p.sy + size / 2 + 1, (w * e.hp) / Math.max(1, e.maxHp), 3);
    if (e.taggedBy) {
      ctx.fillStyle = e.taggedBy === client.operatorId ? COLORS.tagMine : COLORS.tagOther;
      ctx.fillText('⚑', p.sx + size / 2, p.sy - size / 2);
    }
    if (e.statuses.length) {
      ctx.fillStyle = '#c4b5fd';
      ctx.fillText(e.statuses.map((st) => st[0]!.toUpperCase()).join(''), p.sx - size / 2, p.sy - size / 2 - 2);
    }
    if (e.id === controls.targetId) {
      ctx.strokeStyle = COLORS.target;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, size * 0.65, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (e.id === controls.actor) {
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.sx - size / 2 - 2, p.sy - size / 2 - 2, size + 4, size + 4);
    }
    if (capture && capture.targetId === e.id) {
      const mine = worldToScreen(cam, me.x, me.y);
      ctx.strokeStyle = COLORS.link;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mine.sx, mine.sy);
      ctx.lineTo(p.sx, p.sy);
      ctx.stroke();
      ctx.setLineDash([]);
      const left = Math.max(0, capture.deadlineTick - client.tick);
      ctx.fillStyle = COLORS.link;
      ctx.fillText(`${(left / 16).toFixed(1)}s`, p.sx + size / 2, p.sy + size / 2 + 12);
    }
  }
  if (hover) {
    const p = worldToScreen(cam, Math.floor(hover.x), Math.floor(hover.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.sx, p.sy, s, s);
  }
}
```

- [ ] **Step 2: Implement the components**

`apps/frontend/src/components/WorldCanvas.tsx`:

```tsx
import { getMove } from '@daemonet/rules';
import { useEffect, useRef } from 'react';
import { getControls, setControls, useControls } from '../game/controls.ts';
import { useGame } from '../game/connection.ts';
import { log } from '../game/log.ts';
import { screenToWorld, type Camera } from '../render/camera.ts';
import { drawWorld } from '../render/draw.ts';

/** Sends a manual command and logs any rejection. */
export function run(promise: Promise<unknown>, label: string): void {
  promise.catch((err: Error) => log.push('reject', `${label}: ${err.message}`));
}

export function WorldCanvas() {
  const client = useGame();
  const controls = useControls();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !client) return;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const loop = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      if (client.self && client.subnet) {
        const c = getControls();
        const cam: Camera = { cx: client.self.x, cy: client.self.y, zoom: c.zoom, width: rect.width, height: rect.height };
        drawWorld({ ctx, cam, client, controls: c, hover: hover.current });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [client]);

  const camera = (): Camera | null => {
    const canvas = canvasRef.current;
    if (!canvas || !client?.self) return null;
    const rect = canvas.getBoundingClientRect();
    return { cx: client.self.x, cy: client.self.y, zoom: controls.zoom, width: rect.width, height: rect.height };
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const cam = camera();
    if (!cam || !client) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const w = screenToWorld(cam, ev.clientX - rect.left, ev.clientY - rect.top);
    // click on a daemon selects it as the target; otherwise move the selected actor
    let hit: string | null = null;
    for (const e of client.entities.values()) if (e.kind === 'daemon' && Math.hypot(e.x - w.x, e.y - w.y) < 0.6) hit = e.id;
    if (hit) {
      const e = client.entities.get(hit)!;
      if (e.kind === 'daemon' && e.owner === client.operatorId) setControls({ actor: hit });
      else setControls({ targetId: hit });
      return;
    }
    if (client.role !== 'controller') return;
    const actor = controls.actor;
    const dest = { x: Math.floor(w.x) + 0.5, y: Math.floor(w.y) + 0.5 };
    if (actor === 'self') run(client.operator.moveTo(dest.x, dest.y), 'moveTo');
    else run(client.daemons.get(actor).moveTo(dest.x, dest.y), 'moveTo');
  };

  const onKey = (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!client || client.role !== 'controller') return;
    const c = getControls();
    const running = client.self.running;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const order = ['self', ...running];
      const i = order.indexOf(c.actor);
      setControls({ actor: order[(i + 1) % order.length] ?? 'self' });
      return;
    }
    if (ev.key === 'Escape') return setControls({ targetId: null, actor: 'self' });
    if (ev.key === 'c' && c.targetId) return run(client.operator.capture(c.targetId, c.tool), 'capture');
    if (ev.key === 'r') {
      const first = client.self.ram.find((d) => !d.crashed && !running.includes(d.id));
      if (c.actor !== 'self') return run(client.operator.recall(c.actor), 'recall');
      if (first) return run(client.operator.run(first.id), 'run');
      return;
    }
    if (/^[1-4]$/.test(ev.key) && c.actor !== 'self') {
      const d = client.daemons.get(c.actor);
      const move = d.ram?.moves[Number(ev.key) - 1];
      if (!move) return;
      const target = c.targetId ? client.entities.get(c.targetId) : undefined;
      const shape = getMove(move).shape.kind;
      if (shape === 'single') {
        if (target) run(d.use(move, { id: target.id, x: target.x, y: target.y }), move);
      } else if (target) run(d.use(move, { x: target.x, y: target.y }), move);
      else if (hover.current) run(d.use(move, { x: hover.current.x, y: hover.current.y }), move);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      data-testid="world"
      className="h-full w-full bg-neutral-950 outline-none"
      onClick={onClick}
      onKeyDown={onKey}
      onMouseMove={(ev) => {
        const cam = camera();
        if (!cam) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        hover.current = screenToWorld(cam, ev.clientX - rect.left, ev.clientY - rect.top);
      }}
      onMouseLeave={() => (hover.current = null)}
    />
  );
}
```

`apps/frontend/src/components/TopBar.tsx`:

```tsx
import { useLogoutMutation, type Me } from '../api.ts';
import { close, open, useConnection } from '../game/connection.ts';
import { setControls, useControls } from '../game/controls.ts';

export function TopBar({ me }: { me: Me }) {
  const conn = useConnection();
  const controls = useControls();
  const [logout] = useLogoutMutation();
  const client = conn.client;
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-3 py-1.5 text-sm">
      <span className="font-semibold tracking-wide text-sky-300">daemonet</span>
      <span className="mono text-neutral-300" data-testid="operator-name">
        {client?.self?.name ?? me.name ?? 'unnamed operator'}
      </span>
      <span className="mono text-neutral-500">
        tick <span data-testid="tick">{client?.tick ?? 0}</span> · bits {client?.self?.bits ?? me.bits}
      </span>
      <span className={`mono ${conn.status === 'online' ? 'text-emerald-400' : 'text-amber-400'}`} data-testid="status">
        {conn.status}
        {conn.kickReason ? ` (${conn.kickReason})` : ''}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <label className="text-neutral-400">
          zoom
          <select className="ml-1 rounded bg-neutral-800 px-1" value={controls.zoom} onChange={(e) => setControls({ zoom: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            {[1, 2, 3, 4].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={() => void open('controller')} disabled={conn.role === 'controller' && conn.status === 'online'}>
          control
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={() => void open('spectator')} disabled={conn.role === 'spectator' && conn.status === 'online'}>
          spectate
        </button>
        <button
          className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
          onClick={async () => {
            close();
            const r = await logout().unwrap();
            location.href = r.endSessionUrl ?? '/';
          }}
        >
          logout
        </button>
      </span>
    </header>
  );
}
```

- [ ] **Step 3: Implement the panels**

`apps/frontend/src/panels/PlayPanel.tsx`:

```tsx
import { getMove, getSpecies, type ToolId } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useState } from 'react';
import { run } from '../components/WorldCanvas.tsx';
import { parseAnswer, setControls, useControls } from '../game/controls.ts';

const TOOLS: ToolId[] = ['sniff', 'tap', 'mirror', 'dump'];

export function PlayPanel({ client }: { client: GameClient }) {
  const controls = useControls();
  const me = client.self;
  const manual = client.role === 'controller';
  const target = controls.targetId ? client.entities.get(controls.targetId) : undefined;
  const starters = ['pingling', 'hashling', 'glitchmite', 'nullpup'];
  const [starter, setStarter] = useState(starters[0]!);
  const [name, setName] = useState('');

  if (!me.starterClaimed) {
    return (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-neutral-300">Claim a starter to enter the network.</p>
        <input className="w-full rounded bg-neutral-800 px-2 py-1" placeholder="operator name (a-z 0-9 _ -)" value={name} onChange={(e) => setName(e.target.value)} data-testid="name-input" />
        <select className="w-full rounded bg-neutral-800 px-2 py-1" value={starter} onChange={(e) => setStarter(e.target.value)} data-testid="starter-select">
          {starters.map((s) => (
            <option key={s} value={s}>
              {getSpecies(s).name}
            </option>
          ))}
        </select>
        <button className="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600 disabled:opacity-50" disabled={!manual} onClick={() => run(client.operator.claimStarter(starter, name), 'claimStarter')} data-testid="claim">
          claim
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-sm">
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">running</h3>
        {me.running.length === 0 && <p className="text-neutral-500">nothing running — press R or use the RAM tab</p>}
        {me.running.map((id) => {
          const d = me.ram.find((r) => r.id === id)!;
          const handle = client.daemons.get(id);
          return (
            <div key={id} className={`mb-2 rounded border p-2 ${controls.actor === id ? 'border-sky-500' : 'border-neutral-800'}`}>
              <div className="flex items-center justify-between">
                <button className="font-medium" onClick={() => setControls({ actor: id })}>
                  {getSpecies(d.species).name} <span className="text-neutral-500">L{d.level}</span>
                </button>
                <span className="mono text-neutral-400">
                  {Math.round(d.hp)}/{d.maxHp} hp · {Math.floor(d.energy)} en
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {d.moves.map((m, i) => {
                  const def = getMove(m);
                  const ready = (d.cooldowns[m] ?? 0) <= client.tick && d.energy >= def.energyCost;
                  return (
                    <button
                      key={m}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-left hover:bg-neutral-700 disabled:opacity-40"
                      disabled={!manual || !ready || (!target && def.shape.kind === 'single')}
                      title={`${def.type} ${def.category} · power ${def.power} · ${def.energyCost} energy · ${def.cooldownMs} ms · range ${def.range}`}
                      onClick={() => target && run(handle.use(m, def.shape.kind === 'single' ? { id: target.id, x: target.x, y: target.y } : { x: target.x, y: target.y }), m)}
                    >
                      <span className="text-neutral-500">{i + 1}</span> {def.name}
                    </button>
                  );
                })}
              </div>
              <button className="mt-1 text-xs text-neutral-400 hover:text-neutral-200" disabled={!manual} onClick={() => run(client.operator.recall(id), 'recall')}>
                recall
              </button>
            </div>
          );
        })}
      </section>

      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">target</h3>
        {target?.kind === 'daemon' ? (
          <div className="rounded border border-neutral-800 p-2">
            <div>
              {getSpecies(target.species).name} <span className="text-neutral-500">L{target.level}</span>{' '}
              {target.clean && <span className="text-white">clean</span>} {target.signature > 0 && <span className="text-fuchsia-300">T{target.signature}</span>}
            </div>
            <div className="mono text-neutral-400">
              {Math.round(target.hp)}/{target.maxHp} hp · {target.taggedBy ? (target.taggedBy === client.operatorId ? 'tagged by you' : 'tagged by another operator') : 'untagged'}
              {target.hardened ? ' · hardened' : ''}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <select className="rounded bg-neutral-800 px-1" value={controls.tool} onChange={(e) => setControls({ tool: e.target.value as ToolId })} data-testid="tool-select">
                {TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {t} ×{me.inventory[t] ?? 0}
                  </option>
                ))}
              </select>
              <button
                className="rounded bg-violet-700 px-2 py-0.5 hover:bg-violet-600 disabled:opacity-40"
                disabled={!manual || !!me.capture || (me.inventory[controls.tool] ?? 0) === 0}
                onClick={() => run(client.operator.capture(target.id, controls.tool), 'capture')}
                data-testid="capture"
              >
                capture (C)
              </button>
            </div>
          </div>
        ) : (
          <p className="text-neutral-500">click a wild daemon on the map</p>
        )}
      </section>

      {me.capture && <CapturePanel client={client} />}

      <section className="flex flex-wrap gap-2">
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual} onClick={() => run(client.operator.restoreAll(), 'restoreAll')}>
          restore all (at host)
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual} onClick={() => run(client.operator.stop(), 'stop')}>
          stop
        </button>
      </section>
    </div>
  );
}

export function CapturePanel({ client }: { client: GameClient }) {
  const [challenge, setChallenge] = useState<{ captureId: string; kind: string; families: string[]; params: unknown; payload: unknown } | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => client.on('captureStart', (ev) => setChallenge({ captureId: ev.captureId, ...ev.challenge })), [client]);
  const cap = client.self.capture;
  if (!cap) return null;
  const left = Math.max(0, cap.deadlineTick - client.tick) / 16;
  const submit = () => {
    const parsed = parseAnswer(answer);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    run(client.operator.submitCapture(cap.captureId, parsed.value), 'submitCapture');
  };
  return (
    <section className="rounded border border-violet-700 p-2" data-testid="capture-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-violet-300">capture in progress</h3>
        <span className="mono text-violet-200">{left.toFixed(1)}s</span>
      </div>
      {challenge && challenge.captureId === cap.captureId ? (
        <>
          <div className="mono mt-1 text-xs text-neutral-400">
            {challenge.kind} · {challenge.families.join(' → ')}
          </div>
          <details className="mt-1" open>
            <summary className="cursor-pointer text-xs text-neutral-400">params</summary>
            <pre className="mono max-h-32 overflow-auto rounded bg-neutral-900 p-1 text-xs">{JSON.stringify(challenge.params, null, 1)}</pre>
          </details>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-neutral-400">payload</summary>
            <pre className="mono max-h-48 overflow-auto rounded bg-neutral-900 p-1 text-xs">{JSON.stringify(challenge.payload, null, 1)}</pre>
          </details>
          <button className="mt-1 text-xs text-neutral-400 hover:text-neutral-200" onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ params: challenge.params, payload: challenge.payload }))}>
            copy challenge
          </button>
        </>
      ) : (
        <p className="text-xs text-neutral-500">waiting for the challenge…</p>
      )}
      <textarea className="mono mt-2 h-20 w-full rounded bg-neutral-900 p-1 text-xs" placeholder='{"checksum":"…"}' value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="answer" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button className="mt-1 rounded bg-violet-700 px-2 py-0.5 hover:bg-violet-600" onClick={submit} data-testid="submit-answer">
        submit answer
      </button>
    </section>
  );
}
```

`apps/frontend/src/panels/RamPanel.tsx`:

```tsx
import { STAT_KEYS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useDiskQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { setControls } from '../game/controls.ts';
import { spriteCanvas } from '../render/draw.ts';
import { useEffect, useRef } from 'react';

export function SpriteImg({ species, types, clean, signature, size = 32 }: { species: string; types: readonly string[]; clean: boolean; signature: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(spriteCanvas(species, types, clean, signature), 0, 0, size, size);
  }, [species, types, clean, signature, size]);
  return <canvas ref={ref} width={size} height={size} className="shrink-0" />;
}

export function RamPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = Math.hypot(me.x - 16.5, me.y - 16.5) <= 2;
  const disk = useDiskQuery();
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        RAM {me.ram.length}/8 · running {me.running.length}/2 · {atHost ? 'at the host: store/load enabled' : 'store/load only at the host'}
      </p>
      {me.ram
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((d) => {
          const sp = getSpecies(d.species);
          const running = me.running.includes(d.id);
          return (
            <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2" data-testid={`ram-${d.slot}`}>
              <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{sp.name}</span>
                  <span className="text-neutral-500">L{d.level}</span>
                  {d.clean && <span className="text-white">clean</span>}
                  {d.signature > 0 && <span className="text-fuchsia-300">T{d.signature}</span>}
                  {d.crashed && <span className="text-red-400">crashed</span>}
                  {running && <span className="text-emerald-400">running</span>}
                </div>
                <div className="mono text-xs text-neutral-400">
                  {Math.round(d.hp)}/{d.maxHp} hp · {Math.floor(d.energy)} en · xp {d.xp}
                </div>
                <div className="mono text-xs text-neutral-500">
                  IV {STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${d.ivs[i]}`).join(' ')}
                </div>
                <div className="mono text-xs text-neutral-500">moves {d.moves.join(', ')}</div>
                <div className="mt-1 flex gap-2 text-xs">
                  {running ? (
                    <button className="text-neutral-300 hover:text-white" disabled={!manual} onClick={() => run(client.operator.recall(d.id), 'recall')}>
                      recall
                    </button>
                  ) : (
                    <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed} onClick={() => run(client.operator.run(d.id), 'run')} data-testid={`run-${d.slot}`}>
                      run
                    </button>
                  )}
                  <button className="text-neutral-300 hover:text-white" onClick={() => setControls({ actor: d.id })}>
                    select
                  </button>
                  <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed || (me.inventory.restore ?? 0) === 0} onClick={() => run(client.operator.useRestore(d.id), 'restore')}>
                    restore ×{me.inventory.restore ?? 0}
                  </button>
                  <button
                    className="text-neutral-300 hover:text-white disabled:opacity-40"
                    disabled={!manual || running || !atHost}
                    onClick={() => run(client.operator.store(d.id).then(() => disk.refetch()), 'store')}
                  >
                    store
                  </button>
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
```

`apps/frontend/src/panels/DiskPanel.tsx`:

```tsx
import { getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useDiskQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { SpriteImg } from './RamPanel.tsx';

export function DiskPanel({ client }: { client: GameClient }) {
  const disk = useDiskQuery();
  const me = client.self;
  const atHost = Math.hypot(me.x - 16.5, me.y - 16.5) <= 2;
  const manual = client.role === 'controller';
  const rows = disk.data ?? [];
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        Disk {rows.length}/256 · <button className="underline" onClick={() => disk.refetch()}>refresh</button>
      </p>
      {rows.length === 0 && <p className="text-neutral-500">nothing on Disk</p>}
      {rows.map((d) => {
        const sp = getSpecies(d.species);
        return (
          <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
            <div className="flex-1">
              <div>
                <span className="font-medium">{sp.name}</span> <span className="text-neutral-500">L{d.level} · slot {d.slot}</span>
                {d.clean && <span className="ml-1 text-white">clean</span>}
                {d.signature > 0 && <span className="ml-1 text-fuchsia-300">T{d.signature}</span>}
              </div>
              <div className="mono text-xs text-neutral-500">
                captured {new Date(d.log.capturedAt).toLocaleString()} in {d.log.subnet} with {d.log.tool}
              </div>
              <button
                className="mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40"
                disabled={!manual || !atHost || me.ram.length >= 8}
                onClick={() => run(client.operator.load(d.id).then(() => disk.refetch()), 'load')}
              >
                load into RAM
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

`apps/frontend/src/panels/CodexPanel.tsx`:

```tsx
import { STAT_KEYS } from '@daemonet/rules';
import { useCodexQuery } from '../api.ts';
import { SpriteImg } from './RamPanel.tsx';

export function ItemsPanel({ inventory }: { inventory: Record<string, number> }) {
  const entries = Object.entries(inventory).filter(([, n]) => n > 0);
  return (
    <div className="p-3 text-sm">
      {entries.length === 0 && <p className="text-neutral-500">no items</p>}
      <ul className="space-y-1">
        {entries.map(([id, n]) => (
          <li key={id} className="mono flex justify-between rounded border border-neutral-800 px-2 py-1">
            <span>{id}</span>
            <span className="text-neutral-400">×{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CodexPanel() {
  const codex = useCodexQuery();
  if (!codex.data) return <p className="p-3 text-sm text-neutral-500">loading codex…</p>;
  const { species, moves, chart } = codex.data;
  return (
    <div className="space-y-4 p-3 text-sm">
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">species</h3>
        {species.map((s) => (
          <div key={s.id} className="mb-1 flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={s.id} types={s.types} clean={false} signature={0} />
            <div>
              <div>
                <span className="font-medium">{s.name}</span> <span className="text-neutral-500">{s.types.join('/')} · {s.behaviour}{s.starter ? ' · starter' : ''}</span>
              </div>
              <div className="mono text-xs text-neutral-500">{STAT_KEYS.map((k) => `${k.slice(0, 3)} ${s.base[k]}`).join(' · ')}</div>
              <div className="mono text-xs text-neutral-500">{s.learnset.map((l) => `L${l.level} ${l.move}`).join(', ')}</div>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">moves</h3>
        <table className="mono w-full text-xs">
          <tbody>
            {moves.map((m) => (
              <tr key={m.id} className="border-b border-neutral-900">
                <td className="py-0.5">{m.name}</td>
                <td className="text-neutral-500">{m.type}</td>
                <td className="text-neutral-500">{m.category}</td>
                <td className="text-right">{m.power}</td>
                <td className="text-right text-neutral-500">{m.energyCost}en</td>
                <td className="text-right text-neutral-500">{m.cooldownMs}ms</td>
                <td className="text-right text-neutral-500">r{m.range}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">type chart (attacker → defender, SP1 types)</h3>
        <table className="mono text-xs">
          <thead>
            <tr>
              <th />
              {['packet', 'crypto', 'glitch', 'null'].map((t) => (
                <th key={t} className="px-1 text-neutral-500">{t.slice(0, 3)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {['packet', 'crypto', 'glitch', 'null'].map((a) => (
              <tr key={a}>
                <td className="pr-1 text-neutral-500">{a}</td>
                {['packet', 'crypto', 'glitch', 'null'].map((d) => (
                  <td key={d} className="px-1 text-center">{(chart as Record<string, Record<string, number>>)[a]?.[d] ?? 1}×</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

`apps/frontend/src/panels/LogPanel.tsx`:

```tsx
import { useState } from 'react';
import { log, useLog, type LogKind } from '../game/log.ts';

const COLORS: Record<LogKind, string> = { event: 'text-neutral-200', script: 'text-sky-300', error: 'text-red-400', reject: 'text-amber-400', system: 'text-neutral-500' };

export function LogPanel() {
  const entries = useLog();
  const [filter, setFilter] = useState<LogKind | 'all'>('all');
  const shown = entries.filter((e) => filter === 'all' || e.kind === filter).slice(-200);
  return (
    <div className="flex h-full flex-col p-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        {(['all', 'event', 'script', 'reject', 'error', 'system'] as const).map((k) => (
          <button key={k} className={`rounded px-1 ${filter === k ? 'bg-neutral-700' : 'bg-neutral-900'}`} onClick={() => setFilter(k)}>
            {k}
          </button>
        ))}
        <button className="ml-auto text-neutral-500" onClick={() => log.clear()}>
          clear
        </button>
      </div>
      <div className="mono flex-1 overflow-auto" data-testid="log">
        {shown.map((e) => (
          <div key={e.id} className={COLORS[e.kind]}>
            <span className="text-neutral-600">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
```

`apps/frontend/src/sdk-types.ts`:

```ts
/** Condensed SDK declarations for Monaco IntelliSense. Keep in step with packages/sdk/src/client.ts. */
export const SDK_TYPES = `
declare module '@daemonet/sdk' {
  export interface Positioned { x: number; y: number }
  export interface DaemonView extends Positioned {
    id: string; species: string; types: string[]; level: number; hp: number; maxHp: number; hpPct: number;
    owner: string | null; taggedBy: string | null; clean: boolean; signature: number; statuses: string[]; hardened: boolean;
  }
  export interface OperatorEntity extends Positioned { id: string; name: string | null }
  export interface RamDaemon {
    id: string; species: string; level: number; xp: number; ivs: number[]; bonus: number[]; clean: boolean; signature: number;
    hp: number; maxHp: number; energy: number; moves: string[]; crashed: boolean; slot: number; cooldowns: Record<string, number>;
  }
  export interface OperatorSelf extends Positioned {
    id: string; name: string | null; starterClaimed: boolean; bits: number; ram: RamDaemon[]; running: string[];
    inventory: Record<string, number>; swapReadyTick: number; capture: { captureId: string; targetId: string; deadlineTick: number } | null;
  }
  export class Query<T extends Positioned> {
    readonly length: number;
    all(): T[]; filter(pred: (item: T) => boolean): Query<T>; within(radius: number): Query<T>;
    nearest(pred?: (item: T) => boolean): T | undefined; lowestHp(pred?: (item: T) => boolean): T | undefined;
  }
  export class WorldView { readonly daemons: Query<DaemonView>; readonly wild: Query<DaemonView>; readonly operators: Query<OperatorEntity>; get(id: string): unknown }
  export class DaemonHandle {
    readonly id: string; readonly ram: RamDaemon | undefined; readonly entity: DaemonView | undefined; readonly x: number; readonly y: number; readonly hpPct: number; readonly energy: number;
    distanceTo(target: Positioned): number; canUse(moveId: string): boolean; bestMoveAgainst(foe: DaemonView): string | null;
    moveTo(x: number, y: number): Promise<unknown>; stop(): Promise<unknown>; use(moveId: string, aim: { id: string } & Positioned | Positioned): Promise<unknown>;
  }
  export interface OperatorScriptContext { client: GameClient; me: OperatorSelf; world: WorldView; tick: number }
  export interface DaemonScriptContext { client: GameClient; self: DaemonHandle; enemies: Query<DaemonView>; world: WorldView; tick: number }
  export class OperatorApi {
    moveTo(x: number, y: number): Promise<unknown>; stop(): Promise<unknown>; run(daemonId: string): Promise<unknown>; recall(daemonId: string): Promise<unknown>;
    swap(outId: string, inId: string): Promise<unknown>; capture(target: { id: string } | string, tool: 'sniff' | 'tap' | 'mirror' | 'dump'): Promise<unknown>;
    submitCapture(captureId: string, answer: unknown): Promise<unknown>; useRestore(daemonId: string): Promise<unknown>; restoreAll(): Promise<unknown>;
    claimStarter(species: string, operatorName: string): Promise<unknown>; store(daemonId: string): Promise<unknown>; load(daemonId: string): Promise<unknown>;
    script(fn: (ctx: OperatorScriptContext) => void): () => void;
  }
  export class DaemonsApi { get(id: string): DaemonHandle; script(fn: (ctx: DaemonScriptContext) => void): () => void }
  export interface CaptureStartEvent { captureId: string; targetId: string; challenge: { kind: 'single' | 'chain'; families: string[]; params: unknown; payload: unknown }; deadlineTick: number }
  export class GameClient {
    tick: number; operatorId: string; self: OperatorSelf; readonly world: WorldView; readonly operator: OperatorApi; readonly daemons: DaemonsApi;
    on(name: 'captureStart', handler: (ev: CaptureStartEvent) => void): () => void;
    on(name: 'captureResult', handler: (ev: { captureId: string; ok: boolean; reason?: string }) => void): () => void;
    on(name: 'tick', handler: (tick: number) => void): () => void;
    on(name: string, handler: (value: any) => void): () => void;
  }
}
`;

export const STARTER_TEMPLATE = `// Daemonet main script. Runs in a sandbox with the same SDK a headless bot uses.
// export default receives the connected game client.

/** Packet-family solver: keep fragments whose crc = (seq + sum of bytes) & 0xff, reassemble, FNV-1a checksum. */
function solvePacket(params, payload) {
  const chunks = new Map();
  for (const f of payload.fragments) {
    const data = f.data.match(/../g).map((h) => parseInt(h, 16));
    if (((f.seq + data.reduce((s, b) => s + b, 0)) & 0xff) === f.crc) chunks.set(f.seq, data);
  }
  let h = 0x811c9dc5;
  for (let seq = 0; seq < params.count; seq++) for (const b of chunks.get(seq)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return { checksum: h.toString(16).padStart(8, '0') };
}

export default function main(game) {
  console.log('online as', game.self.name, 'at tick', game.tick);

  game.on('captureStart', ({ captureId, challenge }) => {
    if (challenge.kind === 'single' && challenge.families[0] === 'packet') {
      game.operator.submitCapture(captureId, solvePacket(challenge.params, challenge.payload));
    }
  });

  const attackable = (d) => d.types.includes('packet') && (d.taggedBy === null || d.taggedBy === game.operatorId);
  let busy = false;

  game.operator.script(({ me, world }) => {
    if (busy) return;
    const ready = me.ram.find((d) => !d.crashed);
    if (ready && me.running.length === 0 && me.swapReadyTick <= game.tick) { game.operator.run(ready.id); return; }
    const target = world.wild.nearest(attackable);
    if (!target || me.capture) return;
    if (Math.hypot(target.x - me.x, target.y - me.y) > 3) { game.operator.moveTo(target.x, target.y); return; }
    if (target.hpPct < 0.35 && (me.inventory.sniff ?? 0) > 0) {
      busy = true;
      game.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
    }
  });

  game.daemons.script(({ self, enemies }) => {
    const foe = enemies.nearest(attackable);
    if (!foe || foe.hpPct < 0.35) return;
    const move = self.bestMoveAgainst(foe);
    if (move) self.use(move, foe);
  });
}
`;
```

`apps/frontend/src/panels/ScriptPanel.tsx`:

```tsx
import Editor, { loader } from '@monaco-editor/react';
import type { GameClient } from '@daemonet/sdk';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useEffect, useRef, useState } from 'react';
import { useLazyVersionQuery, useSaveScriptMutation, useScriptQuery, useVersionsQuery } from '../api.ts';
import { start, stop, useSandboxStatus } from '../game/sandbox.ts';
import { SDK_TYPES, STARTER_TEMPLATE } from '../sdk-types.ts';

// Bundle Monaco locally (the CSP forbids the default CDN loader) and give it Vite-built workers:
// its own `new URL('…?esm', import.meta.url)` fallback ends up inlined as a blob whose relative imports break.
self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()) };
loader.config({ monaco });
monaco.typescript.javascriptDefaults.setCompilerOptions({ allowJs: true, checkJs: true, target: monaco.typescript.ScriptTarget.ES2020, module: monaco.typescript.ModuleKind.ESNext, moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs });
monaco.typescript.javascriptDefaults.addExtraLib(SDK_TYPES, 'file:///node_modules/@daemonet/sdk/index.d.ts');

export const AUTOSAVE_MS = 2000;

export function ScriptPanel({ client }: { client: GameClient | null }) {
  const script = useScriptQuery();
  const versions = useVersionsQuery();
  const [save, saveState] = useSaveScriptMutation();
  const [loadVersion] = useLazyVersionQuery();
  const status = useSandboxStatus();
  const [source, setSource] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (source === null && script.data) setSource(script.data.source);
  }, [script.data, source]);

  const onChange = (value: string | undefined) => {
    setSource(value ?? '');
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      void save({ source: value ?? '' });
    }, AUTOSAVE_MS);
  };

  if (source === null) return <p className="p-3 text-sm text-neutral-500">loading script…</p>;
  const manual = client?.role === 'controller';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 text-xs">
        <button
          className="rounded bg-emerald-700 px-2 py-0.5 hover:bg-emerald-600 disabled:opacity-40"
          disabled={!client || !manual || status === 'starting' || status === 'running'}
          onClick={() => client && void start(client, source)}
          data-testid="run-script"
        >
          run
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={stop} data-testid="stop-script">
          stop
        </button>
        <span className="mono text-neutral-500" data-testid="script-status">
          {status} · v{script.data?.version ?? 0} {saveState.isLoading ? '· saving…' : dirty.current ? '· unsaved' : '· saved'}
        </span>
        <button className="ml-auto text-neutral-400 hover:text-neutral-200" onClick={() => onChange(STARTER_TEMPLATE)}>
          insert starter template
        </button>
        <select
          className="rounded bg-neutral-800 px-1"
          value=""
          onChange={async (e) => {
            const v = Number(e.target.value);
            if (!v) return;
            const r = await loadVersion(v).unwrap();
            onChange(r.source);
          }}
        >
          <option value="">restore version…</option>
          {(versions.data ?? []).map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {new Date(v.createdAt).toLocaleString()} · {v.bytes} B
            </option>
          ))}
        </select>
      </div>
      {pasteWarning && (
        <div className="bg-amber-900/40 px-2 py-1 text-xs text-amber-200">
          Pasted code runs with your operator's full permissions: it can send any game command as you. Only run code you understand.{' '}
          <button className="underline" onClick={() => setPasteWarning(false)}>
            got it
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1" onPaste={() => setPasteWarning(true)} data-testid="editor">
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme="vs-dark"
          value={source}
          onChange={onChange}
          options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, scrollBeyondLastLine: false }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: App shell**

`apps/frontend/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useMeQuery } from './api.ts';
import { TopBar } from './components/TopBar.tsx';
import { WorldCanvas } from './components/WorldCanvas.tsx';
import { open, useConnection } from './game/connection.ts';
import { CodexPanel, ItemsPanel } from './panels/CodexPanel.tsx';
import { DiskPanel } from './panels/DiskPanel.tsx';
import { LogPanel } from './panels/LogPanel.tsx';
import { PlayPanel } from './panels/PlayPanel.tsx';
import { RamPanel } from './panels/RamPanel.tsx';
import { ScriptPanel } from './panels/ScriptPanel.tsx';

const TABS = ['play', 'ram', 'disk', 'items', 'codex', 'script', 'log'] as const;
type Tab = (typeof TABS)[number];

export function Login() {
  const dev = import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const [name, setName] = useState('alice');
  return (
    <main className="grid h-full place-items-center">
      <div className="w-80 space-y-3 rounded border border-neutral-800 p-6">
        <h1 className="text-xl font-semibold text-sky-300">daemonet</h1>
        <p className="text-sm text-neutral-400">Sign in to enter the network.</p>
        <a className="block rounded bg-sky-700 px-3 py-2 text-center hover:bg-sky-600" href="/api/auth/login">
          Sign in with Authentik
        </a>
        {dev && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              location.href = `/api/auth/dev?name=${encodeURIComponent(name)}`;
            }}
          >
            <input className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} data-testid="dev-name" />
            <button className="rounded bg-neutral-700 px-2 text-sm" data-testid="dev-login">
              dev login
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export function App() {
  const me = useMeQuery();
  const conn = useConnection();
  const [tab, setTab] = useState<Tab>('play');
  useEffect(() => {
    if (me.data && conn.status === 'idle' && !conn.client) void open('controller').catch(() => {});
  }, [me.data, conn.status, conn.client]);

  if (me.isLoading) return <p className="p-4 text-neutral-500">loading…</p>;
  if (me.isError || !me.data) return <Login />;
  const client = conn.client;
  return (
    <div className="flex h-full flex-col">
      <TopBar me={me.data} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{client ? <WorldCanvas /> : <p className="p-4 text-neutral-500">{conn.status}…</p>}</div>
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-neutral-800">
          <nav className="flex border-b border-neutral-800 text-xs">
            {TABS.map((t) => (
              <button key={t} className={`flex-1 py-1.5 uppercase tracking-wide ${tab === t ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
                {t}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'play' && (client?.self ? <PlayPanel client={client} /> : <p className="p-3 text-sm text-neutral-500">connecting…</p>)}
            {tab === 'ram' && client?.self && <RamPanel client={client} />}
            {tab === 'disk' && client?.self && <DiskPanel client={client} />}
            {tab === 'items' && client?.self && <ItemsPanel inventory={client.self.inventory} />}
            {tab === 'codex' && <CodexPanel />}
            {tab === 'script' && <ScriptPanel client={client} />}
            {tab === 'log' && <LogPanel />}
          </div>
        </aside>
      </div>
    </div>
  );
}
```

`apps/frontend/src/main.tsx`:

```tsx
import { configureStore } from '@reduxjs/toolkit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { api } from './api.ts';
import { App } from './App.tsx';
import './styles.css';

const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (gdm) => gdm().concat(api.middleware) });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
```

- [ ] **Step 5: Build and check in a browser**

```bash
pnpm lint && pnpm typecheck
pnpm --filter @daemonet/frontend build
```

Expected: the build emits `dist/assets/editor.worker-*.js` and `dist/assets/ts.worker-*.js` alongside the app bundle (about 4.5 MB, Monaco included). Then start the local stack (OPERATIONS.md "Local development"), run `pnpm --filter @daemonet/frontend preview`, open `http://127.0.0.1:4173/` and check:

1. **dev login** → status `online`, the world renders (host box, your operator, wild daemon sprites with HP bars, signature glow rings).
2. Claim a starter → your name appears in the top bar; **RAM** tab shows the daemon; **run** puts it beside you.
3. Click the map → the operator walks there and the view follows; no `moveTo:` rejection in **Log**.
4. Click a wild daemon → **Play** shows it as the target; move buttons `1–4` hit it (HP bar drops); **capture (C)** opens the capture panel with params/payload and a countdown; a wrong typed answer logs `capture failed: wrong_answer`.
5. **Script** tab → *insert starter template* → **run** → **Log** shows `script started`, `online as <name> at tick …`, and within a minute `captured pingling`.
6. **spectate** reconnects as a spectator: manual buttons are disabled; the world keeps updating.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(frontend): world canvas, manual play, panels and sandboxed script editor"
```

---

### Task 4: End-to-end smoke, CI, image and runbook

**Files:**
- Create: `apps/frontend/playwright.config.ts`, `apps/frontend/e2e/smoke.spec.ts`
- Modify: `apps/frontend/Dockerfile`, `.github/workflows/ci.yml`, `OPERATIONS.md`

- [ ] **Step 1: Playwright**

`apps/frontend/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke against a locally running sim (port 3000) and api (port 3001) started with
 * AUTH_DEV_BYPASS=true — see OPERATIONS.md "Local development". The built client is served by
 * `vite preview`, which proxies /api and /ws to them.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: { command: 'pnpm preview', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 60_000 },
});
```

`apps/frontend/e2e/smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const name = `e2e${Date.now().toString(36).slice(-6)}`;

test('dev login, claim a starter, run a daemon, move by clicking, run the starter script in the sandbox', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('dev-name').fill(name);
  await page.getByTestId('dev-login').click();

  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(name, { timeout: 15_000 });

  // the world ticks
  const tick0 = Number(await page.getByTestId('tick').textContent());
  await expect.poll(async () => Number(await page.getByTestId('tick').textContent())).toBeGreaterThan(tick0);

  // run the starter from RAM, then click the map to move; no rejection may appear in the log
  await page.getByTestId('tab-ram').click();
  await page.getByTestId('run-0').click();
  const canvas = page.getByTestId('world');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2 + 96, y: box.height / 2 } });
  await page.waitForTimeout(500);
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).not.toContainText('moveTo:');
  await expect(page.getByTestId('log')).not.toContainText('run:');

  // the sandbox runs the starter template (it logs as soon as it connects through the bridge)
  await page.getByTestId('tab-script').click();
  await expect(page.getByTestId('script-status')).toContainText('stopped', { timeout: 15_000 });
  await page.getByRole('button', { name: 'insert starter template' }).click();
  await page.getByTestId('run-script').click();
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText(`online as ${name}`, { timeout: 20_000 });
  await expect(page.getByTestId('log')).not.toContainText('E_');
});
```

Run (with the local sim + api up and the client built):

```bash
pnpm --filter @daemonet/frontend exec playwright install chromium
pnpm --filter @daemonet/frontend e2e
```

Expected: `1 passed` (about 4 s).

- [ ] **Step 2: Production image**

Replace `apps/frontend/Dockerfile` with:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/sprites/package.json packages/sprites/
COPY apps/sim/package.json apps/sim/
COPY apps/api/package.json apps/api/
COPY apps/frontend/package.json apps/frontend/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY packages/sandbox packages/sandbox
COPY packages/sprites packages/sprites
COPY apps/frontend apps/frontend
# Library builds first (the client imports their dist), then the SDK sandbox bundle, then the client.
RUN pnpm exec tsc -b packages/rules packages/shared packages/sdk packages/sandbox packages/sprites \
 && pnpm --filter @daemonet/frontend build

FROM caddy:2-alpine AS runtime
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/frontend/dist /srv
EXPOSE 80
```

Run: `docker build -f apps/frontend/Dockerfile -t daemonet-frontend:local .`
Expected: builds; `/srv` holds `index.html`, `sdk.js` and the hashed assets. The Caddyfile from SP2 plan 1 already routes `/api/*`, `/ws*`, `/assets/*` and the SPA fallback.

- [ ] **Step 3: CI e2e job**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI
on:
  # Docs-only changes do not run CI, and because Deploy is triggered by a green CI run on main,
  # they do not redeploy production either.
  push:
    branches: [main]
    paths-ignore: ["**.md", "docs/**"]
  pull_request:
    paths-ignore: ["**.md", "docs/**"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: daemonet
          POSTGRES_PASSWORD: daemonet
          POSTGRES_DB: daemonet_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U daemonet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm --filter @daemonet/frontend build

  e2e:
    needs: check
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: daemonet
          POSTGRES_PASSWORD: daemonet
          POSTGRES_DB: daemonet_e2e
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U daemonet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_e2e
      AUTH_DEV_BYPASS: "true"
      LOG_LEVEL: warn
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm build
      - run: pnpm --filter @daemonet/frontend build
      - run: pnpm --filter @daemonet/frontend exec playwright install --with-deps chromium
      - name: Start the sim and the API
        run: |
          PORT=3000 node apps/sim/dist/runtime/main.js > sim.log 2>&1 &
          PORT=3001 SESSION_SECRET=ci-session-secret-ci-session-secret-ci SESSION_COOKIE_SECURE=false FRONTEND_ORIGIN=http://127.0.0.1:4173 node apps/api/dist/server.js > api.log 2>&1 &
          for i in $(seq 1 20); do curl -sf http://127.0.0.1:3000/ws/ready && curl -sf http://127.0.0.1:3001/api/ready && break; sleep 1; done
      - run: pnpm --filter @daemonet/frontend e2e
      - if: failure()
        run: tail -n 50 sim.log api.log
```

- [ ] **Step 4: Runbook**

Replace `OPERATIONS.md` with:

````markdown
# Daemonet — Operations

Runbook for provisioning, deploying and operating the Daemonet sim on the homelab.
Section A is the one-time setup (SP1 plan 4), section B the first deploy and its acceptance
checks, section C day-2 operations. Hosts: S1 `192.168.40.21` (runs the game), S2
`192.168.40.20` (shared PostgreSQL), LC2 `192.168.40.11` (nginx + Cloudflare Tunnel), LC3
`192.168.60.11` (Vault). All commands assume `ssh S1`, `ssh S2`, `ssh LC2`, `ssh LC3` work from
the workstation.

## A. Provision (one-time)

- [ ] **Step 1: S1 is up and baselined**

Power S1 on. Then:

```bash
ssh S1 'hostname; ip -4 addr show enp4s0 | grep inet; docker version --format "{{.Server.Version}}"; \
  id runner; ls -l /usr/local/share/ca-certificates/cloudflare-origin-ca.crt; df -h / | tail -1'
```

Expect `192.168.40.21`, a Docker version, the `runner` user (in the `docker` group), the CA cert and free disk. If anything is missing, S1 was provisioned like S2 on 2026-04-20 (`D:\docs\MikroTik\CLAUDE.md`, "S1"); redo the missing piece the same way.

- [ ] **Step 2: GitHub deploy key and self-hosted runner (S1)**

```bash
ssh S1 'sudo -u runner ssh-keygen -t ed25519 -N "" -f /home/runner/.ssh/daemonet-deploy -C daemonet-deploy && \
  printf "Host github.com-daemonet\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/daemonet-deploy\n  IdentitiesOnly yes\n" | sudo -u runner tee -a /home/runner/.ssh/config >/dev/null && \
  cat /home/runner/.ssh/daemonet-deploy.pub'
```

Add the printed public key as a **read-only deploy key** on `Zaphiruz/daemonet` (Settings → Deploy keys). Store the private key in Vault too (LC3): `ssh S1 'sudo cat /home/runner/.ssh/daemonet-deploy' | ssh LC3 'export VAULT_ADDR=http://127.0.0.1:8200; read -r VAULT_TOKEN ...'` — use the "piping a secret from one host into Vault" recipe in the homelab doc, path `deploy-keys/daemonet`, field `private_key`.

Clone and register the runner (GitHub: Settings → Actions → Runners → New self-hosted runner → Linux x64 gives a fresh token):

```bash
ssh S1 'sudo mkdir -p /opt/daemonet /opt/actions-runner-daemonet && sudo chown runner:runner /opt/daemonet /opt/actions-runner-daemonet && \
  sudo -u runner git clone git@github.com-daemonet:Zaphiruz/daemonet.git /opt/daemonet'
ssh S1 'cd /opt/actions-runner-daemonet && sudo -u runner bash -c "curl -sSL -o r.tgz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz && tar xzf r.tgz && rm r.tgz && \
  ./config.sh --url https://github.com/Zaphiruz/daemonet --token <TOKEN> --name s1-daemonet --labels daemonet --unattended" && sudo ./svc.sh install runner && sudo ./svc.sh start'
```

Verify: the runner shows **Idle** with label `daemonet` on GitHub.

- [ ] **Step 3: PostgreSQL user + database, reachable from S1 (S2)**

```bash
ssh S2 'umask 077; openssl rand -hex 24 > /root/.daemonet-db-pw; PW=$(cat /root/.daemonet-db-pw); \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE USER daemonet WITH PASSWORD '"'"'$PW'"'"';" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE DATABASE daemonet OWNER daemonet TEMPLATE template0;" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -d daemonet -c "GRANT ALL PRIVILEGES ON SCHEMA public TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO daemonet;"'
```

Publish PostgreSQL on S2's LAN address **only**, then restrict it to S1 with a `DOCKER-USER` rule (Docker-published ports bypass host firewalls otherwise):

```bash
ssh S2 'cd /opt/shared-infra && sudo cp docker-compose.yml docker-compose.yml.bak-$(date +%F) && \
  sudo python3 - <<EOF
import re
p="docker-compose.yml"; s=open(p).read()
if "192.168.40.20:5432:5432" not in s:
    s=s.replace("    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data", "    ports: [\"192.168.40.20:5432:5432\"]   # LAN only; DOCKER-USER limits it to S1\n    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data",1)
    open(p,"w").write(s)
EOF
  sudo docker compose up -d postgresql && \
  sudo iptables -C DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP 2>/dev/null || \
  sudo iptables -I DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP && \
  (dpkg -s iptables-persistent >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent) && sudo netfilter-persistent save'
```

Verify (all three lines must hold):

```bash
ssh S1 'docker run --rm postgres:17-alpine pg_isready -h 192.168.40.20 -p 5432 -U daemonet'      # accepting connections
ssh LC2 'timeout 3 bash -c "</dev/tcp/192.168.40.20/5432" && echo REACHABLE || echo blocked'       # blocked
ssh S2 'docker exec shared-infra-postgresql-1 psql -U postgres -c "\l" | grep -c "^ [a-z]"'          # the other apps still list
```

Redis is **not** published: the SP1 sim does not use it. Publish it the same way (with an ACL user) when a later sub-project needs it.

- [ ] **Step 4: Authentik — public client with the device flow**

In `https://authentik.wispy-nook.casa` (admin):

1. **Providers → Create → OAuth2/OpenID Provider**: name `daemonet-bot`, authorization flow `default-provider-authorization-implicit-consent`, **Client type: Public**, redirect URIs: none needed (the device flow has no redirect; if the form insists, add `https://daemonet.wispy-nook.casa/`), signing key: the `authentik Self-signed Certificate`, scopes: `openid`, `profile`, `email`, `offline_access` **and the custom `groups` scope mapping** (Customisation → Property Mappings, the one BookStack uses). Access token validity `minutes=5`, refresh token validity `days=30`. Note the **Client ID**.
2. **Applications → Create**: name `Daemonet`, slug `daemonet-bot`, provider `daemonet-bot`.
3. **Directory → Groups**: create `daemonet-users` and `daemonet-admins`; add yourself to both. **Bind** `daemonet-users` to the application (Applications → Daemonet → Policy/Group/User Bindings → Bind existing group) — this is the access gate.
4. **System → Brands → the default brand → Device code flow**: set `default-provider-authorization-implicit-consent` if empty (the device flow is disabled on the brand until this is set).
5. **Web login (SP2): Providers → Create → OAuth2/OpenID Provider** `daemonet`, **Confidential** client, redirect URI `https://daemonet.wispy-nook.casa/api/auth/callback` (plus `http://localhost:3010/api/auth/callback` for dev), same scopes incl. `groups`, same signing key. **Applications → Create** `Daemonet Web`, slug `daemonet`, provider `daemonet`, bind `daemonet-users`. Note the Client ID and Client Secret.

Verify the device endpoint answers:

```bash
curl -s -X POST https://authentik.wispy-nook.casa/application/o/device/ -d client_id=<CLIENT_ID> -d scope="openid profile groups offline_access"
```

Expect JSON with `device_code`, `user_code`, `verification_uri`.

- [ ] **Step 5: Vault**

From the repo root on the workstation (prompts for the root token and the client ID; nothing is printed):

```bash
bash scripts/provision-secrets.sh
```

Expect `kv written: 15 keys` and `GET secret/data/daemonet with the app token -> HTTP 200`.

- [ ] **Step 6: Token + .env on S1**

```bash
ssh S1 'sudo mv /root/.daemonet-vault-token /opt/daemonet/vault-token && sudo chown runner:runner /opt/daemonet/vault-token && sudo chmod 400 /opt/daemonet/vault-token && \
  cd /opt/daemonet && sudo -u runner bash fetch-secrets.sh && sudo -u runner ls -l .env vault-token'
```

`.env` holds only `VAULT_ADDR` and `VAULT_TOKEN`.

- [ ] **Step 7: nginx (LC2) + Cloudflare Tunnel**

nginx needs a `map` for WebSocket upgrades (none exists on LC2 yet) and a server block:

```bash
ssh LC2 'sudo cp /etc/nginx/sites-enabled/wispy-nook.casa /root/wispy-nook.casa.bak-$(date +%F-%H%M) && \
  printf "map \$http_upgrade \$connection_upgrade {\n    default upgrade;\n    \"\"      close;\n}\n" | sudo tee /etc/nginx/conf.d/websocket-upgrade.conf >/dev/null && \
  sudo tee -a /etc/nginx/sites-enabled/wispy-nook.casa >/dev/null <<EOF

server {
    listen 443 ssl;
    server_name daemonet.wispy-nook.casa;
    ssl_certificate     /etc/nginx/certs/cloudflare-origin.pem;
    ssl_certificate_key /etc/nginx/certs/cloudflare-origin.key;
    location / {
        proxy_pass http://192.168.40.21:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  sudo nginx -t && sudo systemctl reload nginx'
```

Cloudflare dashboard → Zero Trust → Tunnels → the LC2 tunnel → Public Hostname → add `daemonet.wispy-nook.casa` → `https://localhost:443`, **port 443 (not 433)**, TLS → Origin Server Name `daemonet.wispy-nook.casa`.

## B. First deploy and acceptance

- [ ] **Step 8: Deploy**

Push `main` (CI must be green), or trigger manually: `gh workflow run deploy.yml --repo Zaphiruz/daemonet`. Watch: `gh run watch --repo Zaphiruz/daemonet --exit-status`. Then:

```bash
curl -s https://daemonet.wispy-nook.casa/ws/ready          # ok
curl -s -o /dev/null -w "%{http_code}\n" https://daemonet.wispy-nook.casa/   # 200
ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml ps'
```

- [ ] **Step 9: Acceptance — every line must be checked**

1. **Device-flow bot from the PC captures a daemon:**
   `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_ISSUER=https://authentik.wispy-nook.casa/application/o/daemonet-bot/ DAEMONET_CLIENT_ID=<CLIENT_ID> DAEMONET_NAME=<you> pnpm --filter @daemonet/starter-bot start` → approve the printed code in the browser → `claimed pingling` → within a few minutes `captured pingling!`.
2. **Persistence across a restart:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml restart sim'`; rerun the bot; the log line `connected as …` is followed by no `claimed` line (starter already claimed) and the captured daemon is in RAM (`game.self.ram` — the bot prints `captured` only for new ones; check with `psql`: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "select species, location, slot from \"Daemon\""'`).
3. **Tag protection with a second operator:** a second Authentik user in `daemonet-users` runs the bot at the same time; its log shows `capture failed`/no capture of the first bot's tagged target, and no `E_STATE` other than tag conflicts.
4. **Group gate:** remove a user from `daemonet-users`, restart their bot → `E_AUTH: not in daemonet-users`. Add them back.
5. **Real client IPs and no PII:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs --tail 50 sim | grep "operator connected"'` shows your public IP in `ip` and a `sub`, never a name or email.
6. **Web client (SP2):** open `https://daemonet.wispy-nook.casa/` → *Sign in with Authentik* → the world renders with your operator; claim a starter (or see your existing RAM); click the map to move; click a wild daemon, weaken it with move buttons and start a capture — the capture panel shows the challenge and accepts a typed JSON answer; in the Script tab insert the starter template, Run, and watch the Log tab show `online as …` and eventually `captured pingling`; *Spectate* while the headless bot drives shows its moves live. A user outside `daemonet-users` gets 403 at login.
7. **Existing apps unaffected:** open Plantry, Third Eye and Mealie; all load.
8. **Load:** `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` for 5 minutes (requires `AUTH_DEV_BYPASS`, which production refuses — so run this step against a **staging** start instead: `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml run --rm --no-deps -p 192.168.40.21:3011:3000 -e VAULT_PATH=secret/data/daemonet -e AUTH_DEV_BYPASS=true -e NODE_ENV=development sim'` and point the bots at `ws://192.168.40.21:3011/ws` from a VLAN 40 host, or through an SSH tunnel: `ssh -L 3011:192.168.40.21:3011 S1`). The `tick stats` log lines must show `p99` under 32 ms. Afterwards remove the load operators: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "DELETE FROM \"Daemon\" WHERE \"operatorId\" IN (SELECT id FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"'); DELETE FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"';"'`.

- [ ] **Step 10: Record it in the homelab doc**

Add to `D:\docs\MikroTik\CLAUDE.md`: S1 now hosts Daemonet (compose at `/opt/daemonet`, port 3010 LAN-bound, runner `s1-daemonet`, Vault `secret/daemonet`, Authentik slug `daemonet-bot` public client + device flow, DB `daemonet`); shared PostgreSQL is published on `192.168.40.20:5432` restricted to S1 by `DOCKER-USER`; the nginx `websocket-upgrade.conf` map on LC2; the S2 port table gains `3010 Daemonet (on S1)`.

## Local development

Run the whole stack on the workstation with the auth dev bypass (never in production):

```bash
docker run -d --name daemonet-pg -e POSTGRES_USER=daemonet -e POSTGRES_PASSWORD=daemonet -e POSTGRES_DB=daemonet_dev -p 127.0.0.1:5432:5432 postgres:17-alpine
export DATABASE_URL=postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_dev AUTH_DEV_BYPASS=true
pnpm db:migrate && pnpm build
PORT=3000 node apps/sim/dist/runtime/main.js &
PORT=3001 SESSION_SECRET=dev-session-secret-dev-session-secret-dev SESSION_COOKIE_SECURE=false FRONTEND_ORIGIN=http://localhost:5173 node apps/api/dist/server.js &
pnpm web        # Vite dev server on http://localhost:5173, proxying /api -> 3001 and /ws -> 3000
```

Open `http://localhost:5173`, use **dev login** with any name (it becomes sub `dev-<name>`, the same
operator a `dev:<name>` headless bot gets). `pnpm --filter @daemonet/frontend e2e` runs the Playwright
smoke against `vite preview` (port 4173) with the same sim/api running.

## C. Day-2 operations

- **Logs:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs -f sim api'` (pino JSON; the sim logs `tick stats` every 64 s).
- **Restart:** `… restart sim` — connected bots reconnect and resume on their own; the world reloads from the last checkpoint (≤ 32 s of movement lost, never a daemon).
- **Change a secret:** `vault kv patch secret/daemonet KEY=value` on LC3, then `… restart sim`.
- **Rotate the Vault token:** it is periodic (30 d, renewed weekly by LC3's timer); to replace it, rerun `scripts/provision-secrets.sh` (reuses the existing token unless removed from `/opt/vault/app-tokens`), then `fetch-secrets.sh` and restart.
- **Migrations:** run by `deploy.yml` before `up -d`; manual: the "Run migrations" step's command in `.github/workflows/deploy.yml`.
- **Backups:** the `daemonet` database is included in S2's nightly `pg_dumpall` automatically.
- **Disk:** `docker image prune -f` runs after each deploy; check `df -h /` on S1 occasionally.
- **Wipe the world (dev only):** stop the sim, `psql -U daemonet -d daemonet -c 'TRUNCATE "Daemon","Operator","SubnetSeed","AppliedAction" CASCADE'`, start the sim. Operators re-claim starters.
````

- [ ] **Step 5: Full check, commit, push**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "feat(frontend): e2e smoke, CI e2e job, production image, runbook"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: 24 test files, 178 tests; both CI jobs green (`check`, then `e2e`); the deploy rebuilds all three images and `https://daemonet.wispy-nook.casa/` serves the client. Then run OPERATIONS step 9 item 6 (web client acceptance) in production.
