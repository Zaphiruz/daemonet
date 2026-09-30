# Daemonet — SP3b: Economy and subnets (design)

**Status:** approved for planning · **Date:** 2026-09-30
**Parents:** `2026-09-27-daemonet-design.md` §6.1, §7.2, §7.3, §10 (Economy), `2026-09-29-daemonet-bestiary-design.md` §3–§4, `2026-09-30-daemonet-sp3a-daemon-depth-design.md` (§2 "Out (SP3b)", §6).

## 1. Goal

Give the world somewhere to go and the daemons something to be for. SP3b adds
the other five open-world subnets with gateway travel, the bits economy's
first faucet (Tickets) and sinks (NPC shop, Disk expansion, crafting), Codex
research with scans, and decompile + crafting as the outlet for failed clean
hunts — so that from SP3b on an operator's day has a loop: take tickets at a
host, hunt in the subnet the tickets point at, come back, spend, craft, evolve.

## 2. Scope

**In:** six open-world subnets (`lo` + `lan`, `dmz`, `backbone`, `darknet`,
`cloudnet`) hosted by one sim process, gateways and the `travel` command,
spawn tables that spread evolved forms across subnets; a bits ledger; the NPC
shop; Disk expansion; decompile; crafting recipes; Tickets (board, accept,
progress, payout); Codex research (points per line, scan fields on wild
entities, hidden-requirement hints); the protocol / SDK / API / client for all
of it; an admin economy view.

**Out:** `sandbox` (SP6 Arena) and `kernelspace` (SP4 Incidents) subnets;
Exchange trading of fragments (SP5 — fragments are already fungible items so
nothing changes later); clusters (SP4); breeding.

## 3. Decisions fixed here

| Question | Decision |
|---|---|
| One sim process or one per subnet | **One process, one `World` per subnet** (`Game.worlds`). `SUBNETS` env lists what a process hosts (default: all six). Splitting later means routing sessions by subnet, nothing else. |
| How travel works | **Gateway tiles.** A gateway is a point in a subnet with a destination subnet and arrival point. `travel` must be issued within 2 tiles of a gateway, with nothing running and no capture open. It is an intent (durable `Operator.subnet` + position); on commit the operator moves between worlds and gets a fresh `snapshot`. |
| Gating travel | Each gateway has `requires.level`: the highest level in RAM must reach it (lan 8, dmz 16, backbone 24, darknet 32, cloudnet 40). Content data. |
| Tickets | 8 accepted per operator per UTC day, at most 2 open at once; boards are deterministic per (subnet, day) with 8 tickets; payouts 64 / 128 / 256 / 512 bits by tier; the first board of every day has at least two tool-free `clear` tickets so new operators can earn their first bits. |
| Shop prices | sniff 32, tap 128, mirror 512, dump 2048, restore 64, bitflipper 4096; Disk expansion 8192 doubling (+32 slots each, 8 purchases max → 512 slots). SP1's "restoreAll refills sniff to 8" rule is **removed** (the shop replaces it). |
| Starting bits | 0. Starting inventory stays 8 sniff + 2 restore. |
| Decompile of clean / signature daemons | requires `confirm: true`; the row moves to `DaemonArchive` (capture log preserved, never loadable). |
| Scans | Per-viewer fields on wild daemon entities, computed from the viewer's research on that line. Entities are already diffed per connection, so per-viewer variants cost one extra projection per viewer per tick. |
| Bits bookkeeping | Every bits change is one `BitsLedger` row written in the same transaction as the intent that causes it (reason + delta). The admin economy view is a query over it. |

## 4. Subnets and travel

### 4.1 Content (`packages/rules/src/content/subnets.ts`)

`SubnetDef` gains:

```ts
gateways: readonly GatewayDef[];       // { id, at: Point, to: subnetId, arrive: Point, requires: { level: number } }
tier: number;                          // 0..5, drives ticket payouts and shop availability text
```

Six layouts, all 128×128 with hand-placed walls, one host, one spawn next to
the host, four regions. Topology (gateways are bidirectional pairs):

```
lo ── lan ── dmz ── backbone ── darknet
                        └────── cloudnet
```

Spawn tables spread the bestiary: `spawnTable(types, stages, weightByRole?)`
builds a species → weight map from the bestiary rows whose primary type is in
`types` and whose stage is in `stages`; regions of a subnet use rising stages
and levels.

| subnet | tier | types (primary) | stages | levels (4 regions) | gate level |
|---|---|---|---|---|---|
| lo | 0 | all bases | 0 | 2–6 · 5–10 · 9–16 · 14–24 | — |
| lan | 1 | kernel, packet, socket, thread | 0–1 | 8–14 · 12–18 · 16–22 · 18–24 | 8 |
| dmz | 2 | crypto, root, shell, proxy | 1–2 | 16–22 · 20–26 · 24–30 · 28–34 | 16 |
| backbone | 3 | packet, socket, cloud, buffer | 1–2 | 24–30 · 28–34 · 32–38 · 36–42 | 24 |
| darknet | 4 | null, glitch, proxy, crypto | 2–3 | 32–38 · 36–42 · 40–46 · 44–50 | 32 |
| cloudnet | 4 | cloud, cache, heap, stack | 2–3 | 40–46 · 44–50 · 48–54 · 52–58 | 40 |

Wild evolved forms spawn as their species directly (a wild `bootlet` is just a
level-20 Bootlet); capstones (stage 4) never spawn wild. Each region caps at 16
with a 4096 ms respawn, as `lo` does.

### 4.2 Sim

- `Game` holds `worlds: Map<string, World>` and ticks them all; a session is
  bound to the world of `Operator.subnet` (unknown or unhosted subnet → `lo`).
- `travel { gatewayId }` (self): operator within 2 tiles of the gateway, no
  running daemon, no open capture, no pending intents, highest RAM level ≥
  `requires.level`. Intent `travel { to, x, y }`; on commit the runtime removes
  the operator from the source world (checkpointing it), adds it to the target
  world at the arrival point, and sends the session a new `snapshot` (the SDK
  treats any snapshot as a full reset, as it already does on resume).
- Wild daemons and captures are per world; ids stay unique because every
  world has its own seed prefix (`SubnetSeed` row per subnet per boot).

### 4.3 Protocol / SDK / client

- `OperatorSelf.subnet`, `Entity`/snapshot unchanged; `travel` command; event
  `travelled { from, to }` (private). The SDK exposes `client.subnet`,
  `client.world.gateways` (from the static subnet content) and
  `operator.travel(gatewayId)`; the sandbox bundle carries the subnet content.
- Client: gateways drawn on the map (with the destination name and gate
  level), a **travel** button in the Play panel when near one, the subnet name
  in the top bar.

## 5. Bits, shop, Disk expansion

- `Operator.bits` stays the balance; `BitsLedger { id, operatorId, delta, reason, ref, at }` records every change (`reason` ∈ `ticket | shop | craft | disk | admin`).
- Shop: content `SHOP: { itemId → price }` in `rules`; `buy { itemId, qty }` at a host → intent `buy` (bits ≥ price·qty, atomic decrement + inventory increment + ledger row). `qty ≤ 64`.
- Disk expansion: `Operator.diskCapacity Int @default(256)`; `buy { itemId: 'diskExpansion' }` adds 32 up to `DISK_MAX = 512`; price `8192 · 2^purchases`. Every `DISK_SLOTS` check in the sim reads `op.diskCapacity`.
- `OperatorSelf.diskCapacity`; API `/api/shop` (prices + the caller's next Disk price); client **Host** panel tab (shop, craft, decompile, tickets) enabled within 2 tiles of the host.

## 6. Decompile and crafting

- Fragments are inventory items `frag:<type>` (16 ids, in `ITEMS` as `kind: 'fragment'`).
- `decompile { daemonId, confirm? }` at a host: daemon in RAM, not running, not pending; clean or signature ⇒ `confirm` required (`E_STATE 'confirm required'` otherwise). Yield per type `floor(2^stage · (1 + level/16))` (`decompileYield(stage, level)` in `rules`). Intent `decompile`: row moves to `DaemonArchive` (with a final `decompiled` history entry), inventory += fragments. Event `decompiled { daemon, fragments }`.
- Recipes: `RECIPES: RecipeDef[]` `{ id, output: { item, qty }, bits, fragments: Partial<Record<TypeId, number>> }`:
  - tools: `tap` 4 packet + 4 socket + 64 bits; `mirror` 8 packet + 8 proxy + 256; `dump` 16 buffer + 16 heap + 1024
  - `restore` 2 of any one type + 16 bits (`fragments: { any: 2 }` — `any` means the caller picks the type: `craft { recipeId, qty, using?: TypeId }`)
  - each evolution item: 16 fragments of its type + 512 bits
  - held items: `amplifier` 12 root + 12 thread + 1024; `heatsink` 12 cache + 12 kernel + 1024; `battery` 12 stack + 12 signal + 1024; `firewall` 12 shell + 12 crypto + 1024
  - `bitflipper` 8 glitch + 8 null + 8 crypto + 8 kernel + 2048
- `craft { recipeId, qty, using? }` at a host → intent `craft` (fragments and bits atomically, ledger row). `qty ≤ 16`.
- API `/api/recipes` (static). Client: craft list with "have / need" and a button; decompile button on the RAM card (confirm dialog for clean / signature).

## 7. Tickets

- `Ticket` table: `{ id, operatorId, day (YYYY-MM-DD), subnet, index, kind, params Json, reward, progress Int, target Int, status: OPEN | DONE | ABANDONED, acceptedAt, completedAt }`; unique `(operatorId, day, subnet, index)`.
- Board: `ticketBoard(subnetId, day)` in `rules` — 8 tickets from `createRng(\`tickets:${subnet}:${day}\`)`; kinds:
  - `clear { type, count }` — defeat `count` wild daemons of primary type `type` in this subnet (tier-scaled 4 / 8 / 16 / 32)
  - `capture { line, minLevel }` — capture any form of bestiary line `line` at level ≥ `minLevel` in this subnet
  - `deliver { to }` — reach the host of subnet `to` (must be adjacent in the topology)
  - `evolve {}` — evolve any daemon (tier ≥ 1 boards)
  - reward tiers: clear 64 (tier +64 per subnet tier, capped 512), capture 128–512 by line stage reachable, deliver 128–256, evolve 256. Boards of `lo` always place two `clear` tickets at indices 0–1.
- `acceptTicket { day, subnet, index }` at the host of that subnet: `day` must be today (UTC); ≤ 8 accepted today across subnets; ≤ 2 `OPEN`; intent creates the row. `abandonTicket { ticketId }` marks ABANDONED (still counts toward the 8).
- Progress is tracked by the sim on the operator (`op.tickets: OpenTicket[]` loaded with the record): `resolveDefeats` (wild defeated with the operator as tag owner), capture commits, `travelled` (arrival at the destination host on the next `restoreAll`/host proximity check), evolve commits. When `progress ≥ target` the sim raises intent `completeTicket { ticketId }` (row → DONE, bits += reward, ledger). Events `ticketProgress { ticketId, progress, target }`, `ticketDone { ticketId, reward }`. Progress is checkpointed (`Ticket.progress`).
- `OperatorSelf.tickets: [{ id, kind, params, progress, target, reward }]`, `OperatorSelf.ticketsToday: number`. API `/api/tickets/board?subnet=` (today's board, with `accepted` flags) and `/api/tickets` (history). Client: host panel **tickets** tab.

## 8. Research and scans

- `Research { operatorId, line, points }`; +1 per capture commit (in the capture intent's transaction) — of any form of the line, any subnet. `OperatorSelf.research: Record<line, points>` (loaded with the record; updated on capture commit).
- Scan levels (design §7.2): 4 → `hp` exact + `nature`; 16 → `ivBuckets` (8 values 0–3); 64 → `ivs`; 256 → hidden-branch hints. Wild daemon `Entity` gains optional `scan: { nature?, ivBuckets?, ivs? }` computed per viewer (`toDaemonEntity(world, d, viewer)`); the `hp` field is already exact for everyone (SP1) and stays so. Owned daemons and operators are unchanged.
- Codex: `/api/codex` adds `research` (the caller's points per line) and `hints` (`[{ formId, kind }]` for lines at ≥ 256). The client shows research per line in the trees view and the hint text under `???` branches.

## 9. Persistence summary

New tables `BitsLedger`, `Ticket`, `Research`, `DaemonArchive` (the `Daemon`
columns plus `archivedAt` and `reason`; decompile moves the row there and
deletes it from `Daemon`, so the `(operatorId, location, slot)` unique index is
untouched); `Operator.diskCapacity`. Intents: `travel`, `buy`, `craft`,
`decompile`, `acceptTicket`, `abandonTicket`, `completeTicket`, all idempotent
by id; the capture intent also increments `Research`.

## 10. Testing

- rules: subnet validity (every gateway's `to` exists and has a return gateway; arrival points walkable; regions inside bounds), spawn tables non-empty, `decompileYield`, recipe table sanity (every fragment type exists, outputs are items), `ticketBoard` determinism and `lo` tool-free guarantee, scan projection by points.
- sim: multi-world `Game` (two worlds tick, sessions bound by subnet), `travel` guards and the world hand-off (snapshot), shop / Disk expansion / craft / decompile intents (MemoryStore + PrismaStore contracts, ledger rows), ticket accept/progress/complete for each kind, research increments and per-viewer scan fields.
- api: shop, recipes, tickets board / history, codex research + hints, admin economy.
- client: host panel unit tests (shop affordability, craft have/need); e2e: buy a sniff after completing a `clear` ticket seeded via the dev route? — the e2e keeps to: dev-seed 256 bits (dev route `POST /api/dev/bits`), buy a tap, decompile the seeded daemon, craft a restore; travel is covered in the sim integration test.

## 11. Plans

1. **SP3b plan 1 — Subnets and travel:** content for five subnets, gateways, spawn tables, multi-world `Game`, `travel`, SDK + client.
2. **SP3b plan 2 — Bits, shop, Disk expansion, decompile, crafting:** ledger, recipes, intents, API, host panel, admin economy.
3. **SP3b plan 3 — Tickets, research, scans:** board generation, ticket lifecycle, research points, per-viewer scans, Codex hints, client.
