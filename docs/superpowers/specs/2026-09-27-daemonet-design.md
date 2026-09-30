# Daemonet — Game Design

**Status:** approved in brainstorming, 2026-09-27
**Scope of this document:** the whole game. Each sub-project listed under
[Build order](#build-order) gets its own spec → plan → implementation cycle.
The first is `2026-09-27-daemonet-sp1-core-sim-design.md`.

## 1. Pitch

Daemonet is a multiplayer, programmable monster-collecting game in the
tradition of Screeps and Adventure Land. The world is a network. Wild
**daemons** — living processes — roam its **subnets**. Players are
**operators** who write code to explore, fight, and **capture** daemons by
tapping their traffic and copying their memory image.

Players script at two layers:

- **Operator script** — strategy: where to go, what to hunt, when to capture,
  when to swap, when to retreat and restore.
- **Daemon scripts** — tactics: one per daemon (or shared by role), deciding
  moves and positioning in real-time combat.

Base 2 is a design theme: counts, caps, cooldowns and odds are powers of two
wherever that is reasonable.

## 2. Core decisions

| Decision | Choice |
|---|---|
| What code controls | Both: operator strategy script + per-daemon battle scripts |
| Time model | Real time everywhere (world and battles); server sim at 16 Hz, actions gated by cooldowns in ms |
| Where player code runs | Client side (browser or the player's own headless Node bot). Server is authoritative and validates every command |
| Offline play | None — code runs only while the player's client runs |
| World | One shared persistent world, split into subnets |
| Multiplayer features | Arena PvP (ranked + unranked), Exchange (trading + market), co-op raids (Incidents), guilds (Orgs). **No open-world PvP** |
| Monster depth | Medium (IVs, natures, traits, held items, evolution); breeding designed-for, not built |
| Stack | TypeScript everywhere, pnpm monorepo |
| Accounts | Authentik OIDC only — no local passwords or sign-up |
| Hosting | S1 (192.168.40.21), shared PostgreSQL + Redis on S2 |

## 3. Glossary (the theme)

| Generic | Daemonet |
|---|---|
| Zone / map | **Subnet**; towns are **hosts** |
| Wild monster | **Daemon** |
| Trainer / player | **Operator** |
| Capture orb | **Capture tool**, 4 tiers: `sniff` → `tap` → `mirror` → `dump` |
| Catch | **Capture** — open a tap on the target and hold the link while its memory copies |
| Catch minigame | **Capture challenge** — a type-specific decoding puzzle the operator's code must solve |
| Party (8) | **RAM** — 8 loaded daemons, 2 **running** |
| Box (256) | **Disk** — stored images |
| Faint | **Crash** (segfault) |
| Healer | **Restore** at a host node |
| Perfect IVs | **Clean image** |
| Shiny / rarity tier | **Signature** 0–15 |
| Provenance | **Capture log** |
| Party of players | **Cluster** (≤ 4) |
| Raid / raid boss | **Incident** / **kernel daemon** |
| Guild | **Org** |
| Market | **Exchange** |
| Currency | **bits** |
| TM / move teacher | **Patch** |
| IV-raising item | **Bit Flipper** |

## 4. Architecture

### 4.1 Runtime

```
Player bot (browser client in a sandboxed iframe, or headless Node + SDK)
   │  wss://daemonet.wispy-nook.casa/ws   (game protocol)
   │  https://daemonet.wispy-nook.casa/api (REST: auth, disk, exchange, orgs…)
   ▼
Cloudflare edge → cloudflared (LC2) → nginx (LC2) → Caddy (S1, frontend container)
   ├── /ws/*  → sim   (authoritative real-time world, 16 Hz)
   ├── /api/* → api   (Fastify 5 + Prisma)
   └── /*     → static client (React/Vite)

sim ⇄ api: Redis pub/sub (locks, notifications) + shared PostgreSQL
PostgreSQL 17 + Redis on S2 shared-infra, reached from S1 over the VLAN 40 LAN
```

- **sim** terminates the game WebSocket itself (no relay hop). It owns the live
  world state in memory; zones/subnets are isolated modules inside one process
  so they can be split into separate processes later.
- **api** owns everything that is not real-time: OIDC login and sessions,
  operator profile, disk management, Exchange, Orgs, Arena matchmaking, chat
  history, admin.
- Sim and API are separate containers with compose CPU/memory limits
  (sim initially `cpus: 1.5`, `mem_limit: 1g`).

### 4.2 Repository (pnpm monorepo, Plantry/Third Eye template)

| Package | Purpose |
|---|---|
| `packages/rules` | Pure game rules and content data: types, stats, damage, cooldowns, capture-challenge generators + expected answers, spawn/IV/signature rolls, XP, evolution. No I/O. |
| `packages/shared` | Protocol message types + zod schemas, error codes, shared constants |
| `packages/db` | Prisma schema, migrations and generated client, shared by `sim` and `api` |
| `packages/sdk` | Player-facing API; runs in browser (sandboxed iframe) and Node |
| `apps/sim` | Real-time simulation + WebSocket server |
| `apps/api` | Fastify 5 + Prisma REST API |
| `apps/frontend` | React/Vite/Tailwind client (Monaco editor, canvas world view, logs), served by Caddy |

### 4.3 Homelab conventions (from `D:\docs\MikroTik\CLAUDE.md`)

- Public hostname `daemonet.wispy-nook.casa`; Cloudflare Tunnel public
  hostname → `https://localhost:443`; nginx server block on LC2 proxying to
  `192.168.40.21:3010` **with WebSocket upgrade headers** and long read timeout.
- PostgreSQL: dedicated user + database `daemonet` on shared-infra, created
  `TEMPLATE template0`.
- Redis: ACL user `daemonet` restricted to key pattern `daemonet:*`, logical
  DB index 4.
- Vault `secret/daemonet`, read-only policy `daemonet`, periodic token
  registered in `/opt/vault/app-tokens`. `.env` holds only `VAULT_ADDR` +
  `VAULT_TOKEN`; `entrypoint.mjs` loads the rest and refuses Vault overrides of
  `NODE_ENV`, `AUTH_DEV_BYPASS`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `TZ`,
  `PATH`. Cloudflare Origin CA mounted + `NODE_EXTRA_CA_CERTS`.
- CI on GitHub-hosted runners; `deploy.yml` on a self-hosted runner on S1,
  gated on green CI for a same-repo push to `main`: checkout CI SHA → build
  (3 tries) → `prisma migrate deploy` → `up -d` → readiness checks → image prune.
- Proxy chain: Caddy `trusted_proxies static 192.168.40.11/32`,
  `TRUST_PROXY_HOPS=3`.
- `OPERATIONS.md` runbook in the repo. New DB is covered by the existing
  nightly `pg_dumpall` chain automatically.
- **Repository:** `Zaphiruz/daemonet`, **private**. Because players cannot see
  it, **no player-facing surface (client, SDK messages, error text, docs
  shipped to players) may link to GitHub issues or the repo.** Any future
  in-game feedback feature files issues server-side and shows players only an
  in-game confirmation, never an issue URL.

### 4.4 S1 / shared-infra prerequisites

- Power S1 back on; verify SSH, Docker, CA cert, `runner` user.
- Publish shared PostgreSQL on `192.168.40.20:5432` only (never `0.0.0.0`),
  `pg_hba` entry for `daemonet` from `192.168.40.21/32` only.
- Publish Redis on `192.168.40.20:6379` only, with the `daemonet` ACL user;
  the default user keeps working for existing apps on the Docker network.
- Docker-published ports bypass `ufw`; host-level restriction on S2 is checked
  and, if needed, enforced with `DOCKER-USER` iptables rules allowing only
  S1 (and loopback/Docker networks).

## 5. Authentication

- **Accounts come only from Authentik.** Players are keyed by the OIDC `sub`.
  First login creates the operator profile (operator name, starter daemon).
- **Web client:** confidential OIDC client, slug `daemonet`, redirect
  `https://daemonet.wispy-nook.casa/api/auth/callback`, sessions in PostgreSQL,
  cookie `daemonet_sid` (7-day sliding), OIDC state cookie `daemonet_oidc`.
  The WebSocket handshake reuses the session cookie.
- **Headless bots:** public OIDC client `daemonet-bot` using the **OAuth
  device authorization flow**. `sdk.login()` prints a verification URL + user
  code; the operator approves in a browser; the SDK caches the refresh token
  locally and refreshes automatically. The sim verifies access tokens against
  Authentik's JWKS (issuer, audience, expiry).
- **Groups:** `daemonet-users` bound to both applications (access gate);
  `daemonet-admins` for admin tools. Membership is re-checked on every token
  refresh and every WebSocket (re)connect.
- **Revocation:** revoke the token/consent in Authentik or remove the user
  from `daemonet-users`.

## 6. Gameplay

### 6.1 World and simulation

- Subnets are continuous 2D maps over a collision tile grid.
- Server sim at **16 Hz**; commands apply at the start of the next tick.
- Operators move freely; daemons that are running follow/act near their
  operator. Battles happen **in the world** — no separate battle screen.

### 6.2 RAM, running daemons, swaps

- RAM holds **8** daemons; **2** run at a time.
- **Swap** is an operator action, 4096 ms cooldown; the incoming daemon enters
  at the operator's position.
- A crashed daemon is returned to RAM and cannot run until restored at a host
  node (or with an item).

### 6.3 Combat

- Each daemon knows up to **4 moves**. A move has type, power, energy cost,
  cooldown (256 / 512 / 1024 / 2048 / 4096 / 8192 ms), range, shape
  (single / cone / circle) and effects.
- **Energy** max 128, regenerates per the Energy stat.
- Damage uses the shared formula in `rules` (stats, type multiplier,
  same-type bonus ×1.5, level).
- Wild daemons wander, aggro and flee per simple species behaviour profiles.

### 6.4 Capture

Capture is a **code challenge**: reconstructing a daemon's memory image from
its sniffed traffic. There is no integrity dice roll — a correct answer
captures.

1. **Weaken** the target. Lower HP means less encrypted traffic, which makes
   the challenge smaller. Status effects (*stalled*, *throttled*) shrink it
   further.
2. The operator starts a **capture** with a tool on a target in range. The
   server sends a `captureStart` event carrying a **challenge**
   `{ captureId, family, params, payload, deadlineTick }`.
3. The operator's script solves it and calls `submitCapture(captureId, answer)`
   before the deadline, while **holding the link**: taking damage or leaving
   tool range is **packet loss** and fails the capture immediately.
4. Correct answer → the image goes to RAM (or Disk if RAM is full). Wrong
   answer, timeout or packet loss → the target becomes **hardened** for
   8192 ms (its next challenge is one size step larger) and `timid` targets
   flee.

**Challenge families (one per type).** Dual-type daemons get a **chained**
challenge: the primary type's answer is the input to the secondary type's
challenge.

| Type | Challenge | Answer |
|---|---|---|
| Kernel | Round-robin schedule a process list with a given quantum | completion order |
| Packet | Reassemble out-of-order, duplicated fragments by sequence number | checksum of payload |
| Crypto | Recover a repeating-XOR key from a known plaintext prefix, decrypt | plaintext |
| Cache | Simulate an LRU cache of size k over an access trace | hit count |
| Thread | Order events by happens-before from lock/unlock/read/write trace | the racing access pair |
| Signal | Apply masks, pending and delivery rules to a signal sequence | handler run order |
| Socket | Run a TCP state machine over a segment trace | final state per connection |
| Buffer | Apply writes/reads to an overwriting ring buffer | final contents |
| Shell | Evaluate a small pipeline (`grep`/`sort`/`uniq`/`cut`/`wc` subset) over lines | output |
| Root | Evaluate mode bits and ACL entries for a list of access requests | allow/deny bitstring |
| Null | Chase pointers through a memory dump until a null pointer | sum of visited values |
| Glitch | Decode Hamming(7,4) blocks with single-bit errors | corrected bytes |
| Proxy | Unwrap nested encapsulation layers (hex / base64 / XOR / length-prefix) | inner payload |
| Cloud | Place keys on a consistent-hashing ring with virtual nodes | node per key |
| Stack | Execute a short stack-machine bytecode | top of stack |
| Heap | Replay alloc/free events | leaked block IDs |

**Challenge sizing.** `size = 16 · 2^stage · (1 + hpFraction)`, rounded to an
integer, doubled for clean images and doubled again for signature ≥ 1,
doubled if hardened, halved if the target has a status effect, minimum 8,
where `stage` is 0 for base forms. Size means
fragments, instructions, accesses, and so on, per family.

**Tools** change the conditions, not the odds:

| Tool | Range (tiles) | Deadline | Noise |
|---|---|---|---|
| sniff | 4 | 2048 ms | decoy data mixed into the payload |
| tap | 6 | 4096 ms | less decoy data |
| mirror | 8 | 4096 ms | none |
| dump | 8 | 8192 ms | none, plus the size is halved |

**Properties.** Challenges are generated from the subnet's seeded RNG by pure
functions in `packages/rules` that also produce the expected answer, so
generation and verification are cheap (linear) and reproducible in tests.
Parameters are random per capture, so lookup tables do not work; sharing
solvers is expected and fine. Payloads are capped at 64 KiB. The SDK's
example bot ships with **only the Packet solver** as a tutorial; every other
solver is the player's to write.

**Tagging:** the first operator (or cluster) to damage a wild daemon owns it
until 8192 ms after their last hit. Others cannot damage or capture it.

### 6.5 Signatures (rarity)

- **Clean image:** a fresh wild spawn is clean (all 8 IVs = 31) with
  probability 1/4096 (2⁻¹²). Non-clean spawns roll IVs uniformly 0–31 and
  reroll a natural all-31 result, so clean images only come from the gated roll.
- **Signature** is a 4-bit tier 0–15, rolled **only for clean fresh spawns**.
  Each tier is 4× rarer: P(signature ≥ k) = 2⁻(12 + 2k) per encounter.
  Raising IVs to 31 with items never triggers a roll.
- Each signature tier grants **+1 bonus IV point to a random stat**, which may
  exceed 31. Rarity is the only way past "clean".
- Visual flair per tier (glow, aura, trail, palette); server-wide announcement
  for high tiers; permanent capture log.
- Signature and clean status are **visible at spawn**; IVs are hidden until
  captured unless the operator's Codex research for that line unlocks
  scanning (§7.2).

| Tier | Odds per encounter |
|---|---|
| clean (T0) | 1 / 4,096 |
| T1 | 1 / 16,384 |
| T3 | 1 / 262,144 |
| T5 | 1 / 4.2M |
| T7 | 1 / 67M |
| T9 | 1 / 1.1B |
| T15 | 1 / 4.4T |

## 7. Daemons (content model)

Content (species, moves, types, natures, traits, items) is **typed data in
`packages/rules`**, versioned with code. The database stores only instances.

- **Stats (8):** HP, Attack, Defense, Focus (special attack), Resolve (special
  defense), Speed (movement), Haste (cooldown reduction), Energy (regen).
- Species base stats in 1–256.
- **Formula:** `stat = floor((2·base + IV + bonus) · level / 64) + 5`;
  HP: `floor((2·base + IV + bonus) · level / 64) + level + 10`.
- **IVs:** 8 × 0–31. **Natures:** 16 (4-bit); ±10% on a stat pair, some neutral.
- **Traits:** 2 possible per species, one rolled at spawn.
- **Held item:** 1 slot.
- **Levels:** 1–64; XP to reach level n = `8·n³`.
- **Evolution:** branching trees at power-of-2 levels — see §7.1 and the
  bestiary spec.
- **Types:** 16, multipliers ×2 / ×½ / ×0.
- **Items:** capture tools (4 tiers), restores, energy potions, Bit Flippers
  (+1 IV to a chosen stat, capped at 31), Patches (teach moves), held items.
- **Launch content:** 50 lines / 256 species (`2026-09-29-daemonet-bestiary-design.md`),
  16 evolution items, moves and other items authored in SP3.
- **Dual types:** base forms are single-typed; evolutions may add a second
  type (max 2); multipliers stack.
- **Capture log:** original operator, timestamp, subnet, tool, signature.
  Survives trades.
### 7.1 Evolution

- **Levels:** 8, 16, 32, and 64 (capstones). Tree shapes: linear, split
  once, split twice, wide (1 of 4), plus 8 secret level-64 capstones.
- **Choice + requirements:** reaching a threshold makes a daemon
  *evolution-ready* (it can stay that way indefinitely). The operator calls
  `evolve(daemonId, formId)`; the server checks that form's requirements
  (vocabulary in the bestiary §2). Held evolution items are consumed.
- **Discovery:** hidden requirements show as `???` in the Codex until the
  first operator meets one — server-wide announcement, name recorded — then
  they become public.
- **Evolution resolves in this order:**
  1. **IV growth:** every IV below 31 gains +1 with probability ½.
  2. **Clean check:** if all 8 IVs are now 31 and the daemon is not
     **patched**, it becomes clean (entering at signature T0 if it had none).
  3. **Signature upgrade:** if clean, 1/256 chance of +1 tier (max 15), which
     also grants +1 bonus IV to a random stat.
  4. **Capture log entry:** new form, level, and any IV/clean/signature change.
- **Patched:** using any Bit Flipper on a daemon marks it patched, forever.
  Patched daemons can never become clean, so items never create rares.
- Evolving keeps nature, trait slot (mapped to the new form's traits), bonus
  points, signature and capture log.

### 7.2 Codex research

Every capture of any form in a line adds 1 research to that line (per
operator). Research unlocks scanning of wild daemons of that line:

| Research | Unlock |
|---|---|
| 1 | Codex entry: types, moves, stat identity |
| 4 | Scan shows exact HP and nature |
| 16 | Scan shows each IV as a bucket of 8 (0–7, 8–15, 16–23, 24–31) |
| 64 | Scan shows exact IVs |
| 256 | One hint per hidden branch requirement in the line (the requirement's kind, e.g. "involves a subnet") |

Scans are part of the entity data the operator receives; the server only
includes the fields the operator has unlocked.

### 7.3 Decompile and crafting

- `decompile(daemonId)` at a host destroys the daemon and yields
  **fragments** of its type(s): `floor(2^stage · (1 + level/16))` of each type
  (dual types yield that amount of each). Durable event, capture log archived.
- Clean or signature daemons require `confirm: true`; locked or listed daemons
  cannot be decompiled.
- **Crafting** at a host turns fragments (+ bits) into capture tools, restores,
  the 16 evolution items and Bit Flippers. Recipes are content data in
  `rules`.
- Fragments are fungible and trade on the Exchange order book.
- There is **no NPC that buys daemons for bits**.

- **Breeding (future):** the IV vector, nature and trait slot are the genome;
  add a pure `inherit(a, b, rng)` in `rules` plus parent IDs.

## 8. Protocol

- `wss://daemonet.wispy-nook.casa/ws`, JSON envelopes `{ t, seq, d }`.
- **Auth is the first message**, never in the URL: session cookie (browser) or
  Authentik access token (bot). Bots re-auth in-band after refresh.
- **Roles:** one **controller** connection per operator, any number of
  **spectators**. A new controller takes over from the old one.
- **Heartbeat** every 16 s (Cloudflare idles sockets at ~100 s).
- **Downstream:** full snapshot on join/resync, then per-tick **deltas of
  entities within the interest radius**, each with an event list (`battleStart`,
  `hit`, `crash`, `captureStart`, `captureResult`, `signatureSpawn`, …).
- **Upstream:** `{ actor, cmd, args, reqId }` where actor is the operator or
  one of its daemons. Every command gets `ack` or `err` with a code:
  `E_COOLDOWN`, `E_RANGE`, `E_ENERGY`, `E_RATE`, `E_STATE`, `E_AUTH`,
  `E_INVALID`. The SDK surfaces these as promise resolution/rejection.
- **Rate limit:** 8 commands per tick per operator + a per-second token
  bucket; excess → `E_RATE`; sustained abuse → disconnect.
- **Messages** validated with zod, 4 KiB max; connection limits per IP and
  per account.
- **Resume:** reconnect with a resume token; replay from the last acked tick if
  within 64 ticks (4 s), otherwise a fresh snapshot.
- **Disconnect:** 8 s without a controller → operator recalled; an active
  battle counts as a flee.

## 9. Persistence

- **Durable events commit before they are announced:** captures (with capture
  log and signature), level-ups, evolution, item use, bits changes. If the
  write fails after retries, the action fails — never granted without
  persistence, never duplicated (idempotency keys).
- **Checkpoints:** operator position, daemon HP/energy every 32 s and on
  disconnect. A crash loses at most 32 s of movement.
- **Locks:** a daemon listed on the Exchange or in a trade is locked; the API
  informs the sim via Redis pub/sub.

## 10. Multiplayer

- **Clusters:** ≤ 4 operators; shared tagging; XP split among nearby members;
  whoever completes a capture gets the image; drops are per-player.
- **Incidents:** scheduled kernel-daemon bosses in specific subnets, announced
  server-wide; phases, shields, adds and telegraphed AoE surfaced as events.
  Contribution tracked per operator. On defeat, each qualifying participant
  gets a capture attempt on **their own copy** — each copy is a fresh
  encounter with its own clean/signature roll.
- **Orgs:** name, 4-char tag, ranks owner/officer/member, ≤ 64 members; org
  chat; leaderboards (captures, highest signature, arena rating).
- **Chat:** subnet, cluster, org, DMs. Scripts may read chat and send at
  ≤ 1 message / 2 s. Admins can mute and delete.
- **Exchange:** order book (buy/sell) for fungible items; fixed-price listings
  for daemon images (capture log visible). Currency bits, **1/16 fee** on
  sales. Direct two-sided trades confirmed by both operators at a host. Full
  REST API for trading bots. Every transfer is one PostgreSQL transaction with
  row locks and idempotency keys.
- **Economy (bits).** Principle: *automation produces materials; bits come
  only from capped sources and circulate between players.*
  - **Faucets (capped per operator):** **Tickets** — a helpdesk board at each
    host posts delivery / capture-with-conditions / clear-a-subnet jobs,
    8 per operator per day, board rotates daily; **Incidents** —
    contribution-scaled payouts; **Arena** — season-end payouts by rating band
    plus a small bonus for up to 16 ranked wins per day; **Signature
    bounties** — server-wide bonus for the first capture of each signature
    tier per season. **Nothing else creates bits:** wild daemons give XP only,
    and no NPC buys items or daemons.
  - **Sinks:** NPC shop (capture tools, restores; higher tools cost
    exponentially more), crafting recipes (fragments + bits), the 1/16
    Exchange fee, Disk expansion (+32 slots, price doubles each purchase),
    vanity (rename, org creation, org tag change).
  - All prices, caps and rewards are content data in `rules`. An admin economy
    view tracks total bits supply and daily bits created vs destroyed.
  - Bits are integers; the UI formats them in binary units
    (8 bits = 1 byte, 1 KiB = 8,192 bits).
- **Arena:** Glicko-2 ranked ladder with monthly seasons, plus unranked
  challenges. Both operators must be connected; instanced arena subnet; bring
  8, run 2; lose when all 8 crash; 4-minute limit, then HP% decides.
  **Ranked normalizes to level 64 and disables signature bonus points.**
- **Out of scope for now:** open-world PvP, async "ghost script" PvP, org
  banks, auction bidding, breeding, ranching.

## 11. Security and anti-cheat

- Server authoritative; all RNG server-side from per-subnet PRNGs seeded from a
  CSPRNG. Seeds are logged so signature rolls are auditable.
- Clients receive only entities within their interest radius; wild IVs and
  other scan fields are sent only when that operator's research unlocks them.
- **Browser scripts run in a sandboxed iframe with an opaque origin**
  (`sandbox="allow-scripts"`): no cookies, no API access. They talk to the
  host page via `postMessage`; the host relays only game commands. Pasting
  code shows a warning. Headless bots are the player's own machine.
- Logs carry only `sub`s and entity IDs — no PII.

## 12. Failure handling

- Tick budget 62.5 ms; ticks > 50 ms are logged and the interest radius is
  reduced to shed load.
- Sim crash → Docker restart → reload from last checkpoint → SDKs reconnect.
- Durable-write failures fail the action (see §9).

## 13. Testing

- `rules`: unit + property tests (fast-check); statistical tests that clean and
  signature rates match 2⁻(12+2k).
- `sim`: deterministic given seed + command log → replay/golden tests; bug
  reports can carry replay files.
- Integration: sim + api + PostgreSQL in CI with scripted headless-SDK bots
  (capture flow, disconnect/resume, rate limits, trade atomicity).
- Load: 64 bots under S1-sized CPU limits, measuring tick time.
- E2E: Playwright for the client with `AUTH_DEV_BYPASS` (test builds only;
  entrypoint refuses it from Vault).

## 14. Build order

Each is its own spec → plan → implementation.

1. **SP1 — Core sim, protocol, headless SDK** (+ S1/shared-infra prep and a
   first deploy). One subnet, wild daemons, combat, capture, signatures,
   persistence, bot login via device flow.
2. **SP2 — Web client + API:** OIDC login, sandboxed script runner, Monaco
   editor, canvas world view, logs, RAM/Disk management.
3. **SP3 — Daemon depth:** full bestiary (50 lines / 256 species), the other
   12 challenge families, traits, held items, evolution, Codex research,
   decompile + crafting, NPC shop, Tickets, Disk expansion, Bit Flippers,
   Patches, more subnets and hosts.
4. **SP4 — Social:** clusters, Incidents, orgs, chat.
5. **SP5 — Exchange:** direct trades, order book, listings, bot REST API.
6. **SP6 — Arena:** matchmaking, Glicko-2 ladder, seasons.
