# Daemonet SP2 — Web Client and API

**Status:** approved in brainstorming, 2026-09-30
**Parent design:** `2026-09-27-daemonet-design.md`. SP1 (`2026-09-27-daemonet-sp1-core-sim-design.md`) is the base this builds on.

## 1. Goal

A browser client at `https://daemonet.wispy-nook.casa` where an operator logs in
with Authentik, plays the whole SP1 slice by hand (move, fight, capture with a
typed answer, manage RAM/Disk), and writes, runs and saves the same SDK script a
headless bot would run — executed in a sandbox that can never touch the
operator's session. Scripts are stored server-side; sprites are procedural.

## 2. Scope

**In:** `apps/api` (OIDC login, sessions, profile, scripts, Disk listing,
readiness), session-cookie authentication on the sim's WebSocket, the SDK's
`MessagePort` transport, the sandbox bridge, `apps/frontend` (world canvas,
manual controls, capture panel, editor, log, RAM/Disk/inventory/Codex panels,
control/spectate modes), procedural sprites, deploy of `api` + real `frontend`.

**Out:** chat, trading/Exchange, Codex research, mobile layout polish, multi-file
scripts, sharing scripts with other players, admin tools (SP3+).

## 3. Decisions

| Decision | Choice |
|---|---|
| Script storage | Server-side, one `main` script per operator, last 16 versions kept |
| Manual play | Everything is playable by hand, including captures (the answer is typed as JSON) |
| Art | Procedural 16×16 sprites from species data; no asset pipeline |
| Script execution | Sandboxed iframe (opaque origin) running the real `@daemonet/sdk` over a `MessagePort`; the host page owns the socket |
| Script format | One file: `export default function main(game) { … }` — identical to headless usage |
| Modes | *Control* (browser is the controller) / *Spectate* (browser watches while a bot drives) |
| Layout | Desktop-first |

## 4. `apps/api` (Fastify 5 + Prisma, Plantry conventions)

- **Auth:** confidential OIDC client, Authentik slug `daemonet`, redirect
  `https://daemonet.wispy-nook.casa/api/auth/callback`, scopes
  `openid profile email` + `groups`. Access gate: `daemonet-users`;
  `daemonet-admins` recorded on the operator (`isAdmin`) at each login.
  PKCE + state cookie `daemonet_oidc`; session cookie `daemonet_sid`
  (HttpOnly, Secure, SameSite=Lax, 7-day sliding), sessions in the `Session`
  table (`id`, `tokenHash`, `operatorId`, `expiresAt`, `createdAt`,
  `lastSeenAt`). On first login the operator row is created from the `sub`
  exactly as the sim does (shared `loadOrCreateOperator` semantics).
- **Routes** (all JSON, all under `/api`, all except auth/ready require a session):
  - `GET /auth/login` → redirect to Authentik; `GET /auth/callback`; `POST /auth/logout`.
  - `GET /me` → `{ operatorId, name, starterClaimed, isAdmin }`.
  - `GET /scripts/main` → `{ source, version, updatedAt }` (empty source + version 0 when none).
  - `PUT /scripts/main` `{ source }` (≤ 256 KiB) → `{ version, updatedAt }`; keeps the last 16 versions (`ScriptVersion` table: `operatorId`, `version`, `source`, `createdAt`).
  - `GET /scripts/main/versions` → `[{ version, createdAt, bytes }]`; `GET /scripts/main/versions/:v` → `{ source }`.
  - `GET /disk` → daemons on Disk with capture log fields.
  - `GET /codex` → static content (species, moves, types, items) from `@daemonet/rules`, so the client and server agree.
  - `GET /ready` → `SELECT 1`.
- **WebSocket ticket:** `POST /ws/ticket` → `{ ticket }`: a random 32-byte token stored in `WsTicket` (`tokenHash`, `operatorId`, `expiresAt` = 60 s, single use). The client sends `auth { token: "ticket:<value>" }` on the socket; the sim's new `createTicketVerifier(prisma)` consumes it. This keeps cookies off the WebSocket handshake (browsers cannot set headers on `WebSocket`, and the sandbox must never see the cookie).
- Rate limits: 64 req/min per session on `/scripts`, 10/min on `/ws/ticket`.
  `TRUST_PROXY_HOPS=3`. Logs: `sub`/operator ids only.

## 5. Sandbox and bridge

```
host page (has cookie)                          sandboxed iframe (opaque origin)
  WebSocket ──raw protocol strings──▶ MessagePort ──▶ @daemonet/sdk (PortSocket)
             ◀──────────────────────             ◀── user script: main(game)
  renderer / panels (tee the same messages)        console.* → postMessage → log panel
```

- The iframe is created with `sandbox="allow-scripts"` and `srcdoc`; it loads
  the SDK bundle and the user's script as a Blob module. It has no cookies, no
  `localStorage` of the host, and no network access to the API (CSP on the
  host page: `connect-src 'self' wss:`; the iframe's own CSP: `default-src 'none'; script-src 'unsafe-inline' blob:`).
- The SDK gains a `PortSocket` (a `WebSocketLike` over `MessagePort`) so
  `connect({ WebSocket: PortSocket.factory(port) })` works unchanged. The host
  relays every string frame both ways and applies its own 8-commands-per-tick
  guard before forwarding (the server enforces it anyway).
- The host tees incoming messages into its own `GameClient` (with a no-op
  socket) for rendering, so there is exactly one WebSocket per tab.
- **Run/Stop:** Run = create the iframe, send the port, send `{ type: 'start', source }`; Stop = terminate the iframe. Script exceptions surface in the log; the world keeps running.
- **Control vs Spectate:** the tab's socket authenticates with `role: controller` or `spectator`. In Spectate, manual controls and Run are disabled.

## 6. `apps/frontend` (React 19, Vite, Tailwind, RTK Query, Monaco)

**Layout** (desktop): left = world canvas (fills), right = tabbed panel
(`Play`, `RAM`, `Disk`, `Items`, `Codex`, `Script`, `Log`), top bar = operator
name, mode toggle, bits, tick, connection state.

**World canvas**
- 16 px tiles, integer-scaled zoom (1×–4×), viewport centred on the operator.
- Draws: walkable/wall tiles, the host node, region tints, operators (name
  labels), daemons (sprite, HP bar, tag marker `⚑` in owner colour, hardened
  outline, status icons, signature glow ring), the operator's path, capture
  link line and deadline arc, selection ring.
- Interaction: left-click a tile → `moveTo` for the selected actor (operator by
  default; a running daemon if selected); click a daemon → select as target;
  keyboard `1–4` use the selected daemon's move on the target; `Tab` cycles
  running daemons; `R` recall/run; `C` opens capture with the selected tool.

**Play tab**: running daemons with move buttons (cooldown/energy shown), swap,
tool picker + Capture button, restore/restoreAll, the **Capture panel** when a
capture is open: challenge `kind`, `families`, pretty-printed `params` and
`payload` (copy button), a JSON answer box, a deadline countdown, Submit.

**RAM / Disk / Items**: 8 RAM slots (stats, IVs, moves, clean/signature),
store/load (enabled only at the host), 256-slot Disk grid from `/api/disk`,
inventory counts.

**Script tab**: Monaco (TypeScript, with `@daemonet/sdk` type definitions
loaded as an extra lib), Run/Stop, autosave 2 s after the last edit (debounced
`PUT`), version list with restore, a "starter template" button that inserts a
commented example (Packet solver + the starter-bot logic).

**Log tab**: server events, script `console.*`, script errors, command
rejections (`E_*`), with filters.

**Codex tab**: species (sprite, types, base stats, learnset), moves, type
chart, items — from `/api/codex`.

**Procedural sprites** (`packages/sprites`, pure): `spriteFor(speciesId, {
signature, clean })` → 16×16 RGBA. Seeded by FNV-1a of the species id: a
7-column half is generated (cellular rule + symmetric mirror), outlined, filled
with the primary type's palette (dual types blend the second palette on the
lower half); `clean` adds a 1-px white rim; `signature` k adds a glow ring
whose hue steps through 16 values. Deterministic and cached per key.

## 7. Sim changes

- `createTicketVerifier(prisma)` (consumes `WsTicket` rows) added to
  `combineVerifiers`; tokens prefixed `ticket:` route to it.
- `spectator` connections count against `maxSpectators` as before.
- `/ws/ready` unchanged.

## 8. Persistence additions (Prisma)

`Session`, `WsTicket`, `Script` (`operatorId` PK, `source`, `version`,
`updatedAt`), `ScriptVersion` (`operatorId`, `version`, `source`, `createdAt`;
PK `(operatorId, version)`; trimmed to the last 16), `Operator.isAdmin`.

## 9. Security

- Sandbox as §5; host page CSP `default-src 'self'; connect-src 'self' wss://daemonet.wispy-nook.casa; frame-src blob: 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:`.
- Pasting into the editor shows a one-time warning banner ("scripts can send any game command as you").
- Scripts are stored as text and never executed server-side.
- CSRF: `SameSite=Lax` cookies + `PUT`/`POST` require the `X-Requested-With: daemonet` header.

## 10. Testing

- **api:** route tests with Fastify inject + PrismaStore-style contract on a real PostgreSQL (session lifecycle, script versions trimmed to 16, ticket single-use and expiry, disk listing, codex shape).
- **sim:** ticket verifier tests (valid, expired, reused).
- **sdk:** `PortSocket` round-trip test with a `MessageChannel`.
- **sprites:** determinism, symmetry, palette membership, glow presence.
- **frontend:** Vitest + React Testing Library for reducers/hooks (state mirror, capture countdown, editor autosave debounce); Playwright smoke: `AUTH_DEV_BYPASS` dev login → world renders → click-to-move → run a script that calls `game.operator.stop()` → log shows it.
- **Acceptance (production):** log in via Authentik; capture a daemon by typing the answer; run the starter template script in the sandbox and see it capture; Spectate while the headless bot drives; sessions survive an API restart; scripts persist across devices.

## 11. Deploy

`api` joins `docker-compose.prod.yml` (Vault secrets `SESSION_SECRET`,
`AUTHENTIK_CLIENT_ID/SECRET`, `AUTHENTIK_ISSUER_URL`, `AUTHENTIK_REDIRECT_URI`,
`FRONTEND_ORIGIN`, `DATABASE_URL`, `TRUST_PROXY_HOPS`); Caddy routes
`/api/*` → `api:3000`, `/ws*` → `sim:3000`, `/*` → built client. The deploy
workflow builds three images and health-checks `/api/ready` and `/ws/ready`.

## 12. Build order (plans)

1. **SP2 plan 1 — API and tickets:** Prisma additions, `apps/api`, sim ticket verifier, compose/Caddy/deploy updates.
2. **SP2 plan 2 — Bridge and sprites:** SDK `PortSocket`, sandbox runner module, `packages/sprites`, canvas renderer module (pure drawing functions).
3. **SP2 plan 3 — Client:** React app, panels, editor, Playwright smoke, production acceptance.
