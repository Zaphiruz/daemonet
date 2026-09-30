# Daemonet SP1 — Core Sim, Protocol, Headless SDK

**Status:** approved in brainstorming, 2026-09-27
**Parent design:** `2026-09-27-daemonet-design.md` (referred to as "the game
design"; section numbers like §6.4 point there). Where this document is
silent, the game design applies.

## 1. Goal

A deployed, playable vertical slice driven entirely by headless bots:
an operator logs in through Authentik (device flow), claims a starter, walks a
subnet, fights wild daemons in real time, captures them with signature rolls,
and finds everything persisted after a server restart. Two or more operators
share the subnet and see each other.

No web client, no REST API, no social/economy/arena features in SP1.

## 2. Scope

**In**

- pnpm monorepo scaffold, TypeScript strict, vitest, ESLint, CI on
  GitHub-hosted runners.
- `packages/rules`, `packages/shared`, `packages/db`, `packages/sdk`,
  `apps/sim`, and a minimal `apps/frontend` that is only a Caddy container
  (placeholder page + `/ws` proxy) so the production routing shape exists from
  day one.
- One subnet, one host node, wild spawns, combat, capture, tagging, clean
  images and signatures, restore, swaps, XP and levels.
- Persistence: operators, daemons (RAM/Disk), inventory, capture log, subnet
  seeds, idempotency.
- Auth: Authentik device flow for bots (`daemonet-bot` public client); JWKS
  verification in the sim; `daemonet-users` gate.
- S1 and shared-infra preparation (game design §4.4) and a first production
  deploy to S1.
- An example bot in `examples/starter-bot`.

**Out (later sub-projects)**

Web client and OIDC browser login (SP2), `apps/api` (SP2), traits' effects,
held items, evolution, Bit Flippers, Patches, extra subnets (SP3), clusters,
Incidents, orgs, chat (SP4), Exchange (SP5), Arena (SP6).

## 3. Content for SP1

All content lives as typed data in `packages/rules/src/content/`.

### 3.1 Types

All 16 type names are defined now so IDs never change:
Kernel, Packet, Crypto, Cache, Thread, Signal, Socket, Buffer, Shell, Root,
Null, Glitch, Proxy, Cloud, Stack, Heap.

SP1 content uses four. Chart entries (attacker → defender) for those four:

| Attacker ↓ / Defender → | Packet | Crypto | Glitch | Null |
|---|---|---|---|---|
| Packet | ×½ | ×½ | ×2 | ×1 |
| Crypto | ×2 | ×½ | ×½ | ×1 |
| Glitch | ×½ | ×2 | ×½ | ×0 |
| Null | ×1 | ×1 | ×1 | ×1 |

Every matchup not listed is ×1 until SP3 authors the full chart. Same-type
bonus ×1.5.

### 3.2 Species (8)

Two per type, no evolutions yet. The first of each type is a starter.

| Species | Type | Starter |
|---|---|---|
| Pingling | Packet | yes |
| Floodhound | Packet | |
| Hashling | Crypto | yes |
| Cipherbat | Crypto | |
| Glitchmite | Glitch | yes |
| Bitrot | Glitch | |
| Nullpup | Null | yes |
| Voidlet | Null | |

Each species has 8 base stats in 1–256, 2 trait IDs (rolled and stored; no
effects in SP1), a behaviour profile (`timid` flees at low HP, `territorial`
aggros within 6 tiles, `wanderer` ignores until hit), a `baseYield` for XP,
and a level-up learnset.
Base-stat totals (bestiary budget): starters 285, other base forms 300.

### 3.3 Moves (16)

Each move is `physical` or `special`. Four per type: one cheap filler (256–512 ms cooldown, low cost), one ranged
single-target, one area move (cone or circle), and one heavy move
(4096–8192 ms, high energy). One Crypto move applies *throttled* (+50% own
cooldowns for 4096 ms); one Glitch move applies *stalled* (cannot move for
2048 ms). Both statuses halve capture-challenge size (§5.4).

### 3.4 Items (5)

`sniff`, `tap`, `mirror`, `dump` capture tools and `restore` (fully restores
one daemon out of combat). New operators receive 8 `sniff` and 2 `restore`.
SP1 has no shop or bits income, so as a **temporary SP1-only rule**
`restoreAll` at the host also tops `sniff` back up to 8. SP3 removes this when
the NPC shop and Tickets arrive.

Tool range, deadline and noise are as in game design §6.4.

### 3.6 Capture-challenge families

SP1 implements the four families for its content types — **Packet**
(fragment reassembly → checksum), **Crypto** (repeating-XOR key recovery →
plaintext), **Glitch** (Hamming(7,4) correction → bytes) and **Null** (pointer
chase → sum) — exactly as specified in game design §6.4, including chained
challenges (not needed by SP1 species, but the chaining mechanism is built and
tested with a synthetic dual-type fixture). The other 12 families are SP3.

### 3.5 Subnet

`lo` — 128 × 128 tiles authored as typed data (`packages/rules/src/content/subnets.ts`):
wall rectangles (the outer border is always blocked), one host node (restore
and store/load point), a spawn point for new operators, and 4 spawn regions each with a species weight table and a level
range (2–6, 5–10, 9–16, 14–24). Each region keeps up to 16 wild daemons alive,
respawning one every 4096 ms when below cap.

## 4. `packages/rules`

Pure, deterministic functions; no I/O, no clocks, no global RNG. Every random
function takes an `Rng` (seedable, `xoshiro128**`) as an argument.

- `stats.ts` — stat and HP formulas (game design §7), nature modifiers.
- `damage.ts` — `damage(attacker, defender, move, rng)`: base
  `floor(((2·level/5 + 2) · power · atk/def) / 50) + 2`, × type multiplier ×
  same-type bonus × random factor 0.875–1.0. Attack/Defense for physical
  moves, Focus/Resolve for special moves.
- `cooldowns.ts` — effective cooldown `= base · 256 / (256 + haste)` rounded
  down to ms; *throttled* multiplies by 1.5.
- `energy.ts` — regen per tick `= 1 + energyStat / 64` energy points / second,
  applied per tick, cap 128.
- `capture/` — `challengeSize(target, tool)` per game design §6.4, and one
  module per family exporting `generate(size, noise, rng) → { params,
  payload, answer }` and `check(expected, submitted) → boolean`, plus a zod
  schema for that family's answer. `chain(families, …)` composes dual-type
  challenges. **Reference solvers live only under `test/`** — never exported
  from `rules`, so they cannot leak into the SDK bundle.
- `spawn.ts` — `rollSpawn(species, level, rng, odds = DEFAULT_ODDS)` (odds
  injectable for tests only): clean with p = 2⁻¹²; if clean
  all IVs = 31 and roll signature: tier = number of consecutive successes of a
  p = ¼ trial, capped at 15 (so P(tier ≥ k | clean) = 4⁻ᵏ); each tier adds +1
  to a uniformly random stat's bonus. If not clean, IVs uniform 0–31, reroll
  if all 31. Nature uniform of 16, trait slot uniform of 2.
- `xp.ts` — XP to reach level n = `8·n³`; XP yield from defeating/capturing
  `= floor(baseYield · level / 8)`, shared equally among the operator's
  running daemons that dealt damage.
- `typechart.ts`, `content/*` — data plus lookup helpers that throw on unknown
  IDs.

## 5. `apps/sim`

### 5.1 Structure

- `core/` — the deterministic world: `World` state + `step(world, commands, rng)`.
  No sockets, DB or clock inside `core`; time is the tick number
  (1 tick = 62.5 ms).
- `net/` — WebSocket server (`ws` library), auth, sessions, rate limiting,
  interest management, delta encoding.
- `persist/` — Prisma writes, checkpoints, the durable-event pipeline.
- `main.ts` — fixed-timestep loop (drift-corrected with `performance.now()`),
  wiring, health endpoint `/ws/ready` (does `SELECT 1`).

### 5.2 Tick order

1. Drain queued commands (arrival order, ≤ 8 per operator per tick).
2. Operator and daemon movement (collision). Operators move at a fixed
   4 tiles/second; daemons at `2 + speed / 32` tiles/second.
3. Wild AI (behaviour profiles, aggro, flee). During a capture, `territorial`
   targets attack the capturing operator and `timid` targets flee; a hit on an
   operator does no damage but causes packet loss. When a wild daemon's tag
   expires it returns to full HP.
4. Move execution: cooldown/energy/range checks, hits, statuses.
5. Crash resolution, tag expiry, XP awards.
6. Capture progress: packet-loss checks, deadline expiry, verification of
   submitted answers (from step 1).
7. Spawner.
8. Energy regen and status expiry.
9. Emit events and per-connection deltas.

### 5.3 Entities

- **Operator:** position, facing, RAM (8 daemon IDs), running (≤ 2), swap
  cooldown (4096 ms), active capture.
- **Running daemon:** follows its operator within a 3-tile leash unless its
  script moves it (leash max 8 tiles); HP, energy, cooldowns, statuses.
- **Wild daemon:** spawn region, behaviour, tag `{ ownerOperatorId, expiresAtTick }`,
  hardened-until tick, spawn index (for audit).

### 5.4 Capture flow

`capture(targetId, tool)` → validate tool in inventory, target wild, not
tagged by another operator (it becomes tagged by this operator), within range,
no capture already active for this operator → consume the tool → generate the
challenge from the subnet RNG (the expected answer stays server-side) → emit
`captureStart { captureId, family, params, payload, deadlineTick }` to the
operator only. The target keeps fighting during the capture.

`submitCapture(captureId, answer)` — one submission per capture. The answer
is validated against the family's zod schema (malformed → `err E_INVALID`,
capture still open), then checked. Outcomes, emitted as `captureResult`:

- correct → durable `capture` event; `{ ok: true, daemon }` is emitted only
  after the DB commit (§6.3);
- wrong → `{ ok: false, reason: 'wrong_answer' }`;
- deadline passed → `{ ok: false, reason: 'timeout' }`;
- operator hit or out of tool range → `{ ok: false, reason: 'packet_loss' }`.

Any failure → target hardened for 8192 ms (next challenge ×2 size); `timid`
targets flee. `submitCapture` messages may be up to 16 KiB (the 4 KiB limit
applies to all other commands).

### 5.5 Crash and restore

A running daemon at 0 HP crashes: removed from the world, flagged crashed in
RAM, cannot `run` until restored. `restore` item (out of combat = not hit and
not hitting for 4096 ms) or standing within 2 tiles of the host node and
issuing `restoreAll` (free, 2048 ms channel). If all RAM daemons are crashed,
the operator is teleported to the host node.

### 5.6 Commands (SP1)

| Actor | Command | Args |
|---|---|---|
| operator | `moveTo` | `{ x, y }` (server paths with 8-directional A* over the tile grid; paths longer than 256 tiles are refused) |
| operator | `stop` | — |
| operator | `run` | `{ daemonId }` (≤ 2 running) |
| operator | `recall` | `{ daemonId }` |
| operator | `swap` | `{ outId, inId }` (`run`, `recall` and `swap` share the 4096 ms cooldown) |
| operator | `capture` | `{ targetId, tool }` |
| operator | `submitCapture` | `{ captureId, answer }` |
| operator | `useItem` | `{ item: 'restore', daemonId }` |
| operator | `restoreAll` | — |
| operator | `claimStarter` | `{ species, operatorName }` (once) |
| operator | `store` / `load` | `{ daemonId }` (RAM ⇄ Disk, only at host node) |
| daemon | `moveTo` | `{ x, y }` |
| daemon | `use` | `{ move, targetId? , x?, y? }` |

## 6. Persistence (`packages/db`)

### 6.1 Schema

- `Operator` — `id` (uuid), `sub` (unique), `name` (unique, 3–16 chars
  `[a-z0-9_-]`), `bits` (bigint, 0), `subnet`, `x`, `y`, `createdAt`,
  `lastSeenAt`.
- `Daemon` — `id` (uuid), `operatorId`, `species`, `level`, `xp`, `nature`,
  `traitSlot`, `ivs` (int[8]), `bonus` (int[8]), `clean`, `signature` (0–15),
  `hp`, `energy`, `moves` (text[4]), `crashed`, `location` (`RAM`|`DISK`),
  `slot` (RAM 0–7 / Disk 0–255, unique per operator+location), capture log:
  `originalOperatorId`, `capturedAt`, `captureSubnet`, `captureTool`,
  `spawnSeedId`, `spawnIndex`.
- `InventoryItem` — `(operatorId, itemId)` unique, `qty` ≥ 0.
- `SubnetSeed` — `id`, `subnet`, `seed` (hex), `startedAt`. Written at sim
  start per subnet; spawn index + seed reproduces any spawn roll.
- `AppliedAction` — `key` unique (idempotency), `createdAt`.

### 6.2 Checkpoints

Every 512 ticks (32 s) and on disconnect: operator position, bits, inventory,
and each RAM daemon's level/XP/moves/HP/energy/crashed, batched in one
transaction. XP, level-ups and item use therefore survive a sim crash up to
the last checkpoint (at most 32 s lost) — never a daemon.

### 6.3 Durable events

`claimStarter`, `capture`, `store` and `load` are emitted by the core as
*intents* and go through a queue that writes each in its own transaction with
an `AppliedAction` idempotency key. The sim applies the effect to world state and emits the event
**only after commit**. Three retries with backoff (128/512/2048 ms); then the
action fails with `E_STATE` and, for captures, the consumed tool is refunded in
the same compensating transaction. Full RAM → captured image goes to the first
free Disk slot; full Disk → capture refused before the tool is consumed.

## 7. Protocol (`packages/shared`)

As the game design §8, with SP1 specifics:

- Envelope `{ t, seq, d }`; `t` values: `auth`, `authOk`, `snapshot`, `delta`,
  `cmd`, `ack`, `err`, `ping`, `pong`, `resume`, `kick`.
- `auth.d = { token }` (bot access token) — cookie path arrives in SP2.
- `snapshot.d` — tick, subnet static ID, own operator, RAM, inventory, all
  entities in radius 32 tiles.
- `delta.d` — tick, `upserts` (changed fields only), `removes`, `events`.
- Resume buffer: 64 ticks per connection.
- zod schemas are the single source of truth; TypeScript types are inferred.

## 8. Auth in the sim

- Verify bot access tokens with `jose` against Authentik's JWKS (cached,
  refreshed on unknown `kid`): `iss` = Authentik issuer for `daemonet-bot`,
  `aud` includes the `daemonet-bot` client ID, `exp` in the future.
- Require `daemonet-users` in the `groups` claim. If Authentik's access token
  does not carry `groups`, call the userinfo endpoint once per connection and
  cache for the token's lifetime. Which one applies is confirmed during
  provisioning (§10) and recorded in `OPERATIONS.md`.
- Tokens are re-verified when the SDK sends a refreshed token and on every
  reconnect; failure → `err E_AUTH` then close.
- `AUTH_DEV_BYPASS` (non-production only; entrypoint refuses it from Vault
  and refuses it when `NODE_ENV=production`) accepts `dev:<name>` tokens for
  tests and local play.

## 9. `packages/sdk` (headless)

```ts
import { deviceLogin, connect } from '@daemonet/sdk';

const auth = await deviceLogin({ cacheFile: '.daemonet-token.json' });
const game = await connect({ url: 'wss://daemonet.wispy-nook.casa/ws', auth });

game.operator.script(({ me, world }) => {
  const target = world.wild.nearest(d => d.signature > 0 || d.clean);
  if (target && target.hpPct < 0.25) me.capture(target, 'sniff');
});

game.on('captureStart', async ({ captureId, family, params, payload }) => {
  const solve = solvers[family];            // the player's own solvers
  if (solve) await game.operator.submitCapture(captureId, solve(params, payload));
});

game.daemons.script(({ self, enemies }) => {
  const foe = enemies.nearest();
  if (foe) self.use(self.bestMoveAgainst(foe), foe);
});
```

- `deviceLogin` — OAuth device authorization grant against Authentik; prints
  the verification URL and user code; caches the refresh token (file mode 600)
  and refreshes before expiry; pushes the new access token to the open socket.
- `connect` — handshake, snapshot mirror, delta application, reconnect with
  exponential backoff (256 ms → 8192 ms) and resume.
- Scripts run once per tick after the delta is applied. Command helpers return
  promises resolving on `ack`, rejecting with a typed `DaemonetError` on `err`.
  A local budget prevents a script from exceeding 8 commands per tick.
- Read-only world view: `world.wild`, `world.operators`, `world.map`
  (collision queries), `me.ram`, `me.inventory`.
- The SDK exports challenge **types** (params/payload/answer shapes per
  family) but **no solvers**. `examples/starter-bot` includes a Packet solver
  only.
- Works in Node 22+; no browser build until SP2 (keep it free of Node-only
  imports outside `deviceLogin`'s token cache).

## 10. Infrastructure and deploy

1. **S1:** power on, verify SSH/Docker/CA cert/`runner`; create the
   **private** repo `Zaphiruz/daemonet` with a read-only deploy key for
   `runner` (SSH alias `github.com-daemonet`, key also stored in Vault at
   `deploy-keys/daemonet`); register runner `s1-daemonet` (label `daemonet`).
   The SDK package metadata and `examples/` README must not link to the repo
   or its issues (game design §4.3).
2. **Shared-infra on S2:** publish PostgreSQL `192.168.40.20:5432` and Redis
   `192.168.40.20:6379`; `pg_hba` host rule for `daemonet` from
   `192.168.40.21/32`; Redis ACL user `daemonet` (`~daemonet:*`, password in
   Vault); `DOCKER-USER` iptables rules on S2 allowing those ports only from
   S1; verify existing apps unaffected. (Redis is provisioned now but SP1 uses
   it only for the readiness check.)
3. **PostgreSQL:** user + DB `daemonet` (`TEMPLATE template0`).
4. **Authentik:** public client `daemonet-bot` with device code flow enabled
   (brand device-code flow configured); groups `daemonet-users` (bound) and
   `daemonet-admins`; scopes `openid profile groups offline_access`.
5. **Vault:** `secret/daemonet` (`DATABASE_URL`, `REDIS_URL`,
   `AUTHENTIK_ISSUER_URL`, `AUTHENTIK_BOT_CLIENT_ID`, `TRUST_PROXY_HOPS`),
   policy, periodic token → `/opt/daemonet/vault-token` on S1.
6. **Compose on S1** (`/opt/daemonet/docker-compose.prod.yml`): `frontend`
   (Caddy, `192.168.40.21:3010`, placeholder page, `/ws*` → `sim:3000`,
   `trusted_proxies static 192.168.40.11/32`) and `sim` (non-root, HEALTHCHECK,
   `cpus: 1.5`, `mem_limit: 1g`).
7. **LC2 nginx** block for `daemonet.wispy-nook.casa` → `192.168.40.21:3010`
   with `proxy_http_version 1.1`, `Upgrade`/`Connection` headers,
   `proxy_read_timeout 3600s`; **Cloudflare Tunnel** public hostname (port
   **443** — not 433).
8. **CI/deploy:** as game design §4.3; readiness = `/ws/ready`.
9. **Docs:** `OPERATIONS.md` in the repo; update `D:\docs\MikroTik\CLAUDE.md`
   (S1 now hosts Daemonet; shared-infra ports published; port 3010).

## 11. Testing and acceptance

**Automated**

- `rules`: unit tests for every formula; fast-check properties (damage ≥ 1,
  stats monotonic in level/IV, challenge size ≥ 8); for each challenge
  family, property tests that the test-only reference solver's answer on any
  generated challenge passes `check`, that a mutated answer fails, and that
  generation is deterministic per seed and stays under 64 KiB; statistical test of
  `rollSpawn` over 2²⁰ seeded rolls with an injected clean probability of ¼ to
  verify the clean → signature chain.
- `sim/core`: golden replays — seed + command log → expected event stream;
  scenarios: capture success, wrong answer, timeout, malformed answer
  (`E_INVALID`, capture stays open), second submission rejected, packet loss
  by range and by damage, hardened ×2 size, tag protection, crash → restore, swap cooldown, full RAM → Disk.
- Integration (CI with PostgreSQL service): sim + two SDK bots using
  `AUTH_DEV_BYPASS`: both see each other; capture persists across a sim
  restart; duplicate `capture` delivery applies once; rate limit returns
  `E_RATE`; resume within 64 ticks replays, beyond it resnapshots.
- Load: 64 bots, sim under `cpus: 1.5`; pass if p99 tick time < 32 ms.

**Acceptance (production)**

1. `examples/starter-bot` logs in via device flow from the PC, claims a
   starter, and captures a wild daemon on `daemonet.wispy-nook.casa`.
2. After `docker compose restart sim`, the capture is still in RAM with its
   capture log.
3. A second operator's bot in the same subnet sees the first and cannot
   damage or capture its tagged target.
4. A user removed from `daemonet-users` is refused on next reconnect.
5. Real client IPs appear in sim logs; no PII in logs; existing S2 apps
   healthy after the shared-infra port changes.
