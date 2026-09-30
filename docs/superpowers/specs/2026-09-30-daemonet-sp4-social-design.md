# Daemonet — SP4: Social (design)

**Status:** approved for planning · **Date:** 2026-09-30
**Parents:** `2026-09-27-daemonet-design.md` §4.1 (Redis), §4.3, §8, §10 (Clusters, Incidents, Orgs, Chat), `2026-09-30-daemonet-sp3b-economy-subnets-design.md` (bits ledger, subnets, tickets).

## 1. Goal

Other people. SP4 adds the four social systems the design promised: **chat**
(subnet, cluster, org, DMs — readable and writable by scripts), **clusters**
(≤ 4 operators hunting together with shared tagging and XP), **orgs** (guilds
with a tag, ranks, chat and leaderboards — the first vanity bits sinks) and
**Incidents** (scheduled kernel-daemon raid bosses in `kernelspace` with
contribution-scaled payouts and a personal capture attempt each).

## 2. Scope

**In:** a Redis-backed message bus between sim and api; chat with 7-day
history and moderation; clusters (invite nearby or join by code); orgs
(create / invite / ranks / leave / disband, tag, leaderboards, org chat);
operator rename; Incidents (`kernelspace` subnet, schedule + admin trigger,
boss phases with shields / adds / telegraphed AoE, contribution tracking,
bits pool, per-contributor boss copies); client panels for all four; admin
endpoints and a small admin panel (chat moderation, Incident trigger,
economy view from SP3b).

**Out:** Exchange / trading (SP5 — org banks stay out for good), Arena
(SP6), voice, friend lists, cross-org alliances, cluster-wide loot rolls
(drops stay per operator as designed).

## 3. Decisions fixed here

| Question | Decision |
|---|---|
| Incidents | **Scheduled + admin.** A boss spawns in `kernelspace` every 4 h at `00:00, 04:00, … UTC` for a 20-minute window; admins can start one immediately. One shared instance per Incident, up to 16 operators inside; contribution-scaled payouts from a fixed pool plus one personal boss copy to capture per contributor. |
| Chat history | **Postgres, 7 days.** `ChatMessage` rows, pruned nightly; 1 message / 2 s per operator (bots included, same limit); admins can mute (minutes) and delete. |
| Clusters | **Invite nearby *or* join by code.** An invite needs both operators in the same subnet within 32 tiles and expires in 60 s; every cluster also has a 6-character code anyone can join with from anywhere. Members in another subnet are `away` (no XP share, no shared tag) until they return. Leader can kick; leadership passes to the oldest member; empty clusters vanish. Not persisted. |
| Org prices | Create **8192**, change tag **4096**, operator rename **2048** bits (ledger reasons `org`, `rename`). ≤ 64 members, ranks owner / officer / member. |
| Where chat lives | Messages enter through the **sim** (`chat` command over the game socket, so bots and browsers share one path and one rate limit) and are persisted by the store before delivery; the API serves history and moderation. The bus carries admin actions (mute, delete) and org membership changes to the sim, and every chat line to the API's future consumers. |
| Redis | `ioredis`, `REDIS_URL` from Vault (`redis://daemonet:<pw>@192.168.40.20:6379/4`), every key / channel prefixed `daemonet:`. A `Bus` interface with a `MemoryBus` for tests; Redis contract tests run when `REDIS_URL` is set. |

## 4. Bus (`packages/bus`, new)

```ts
interface Bus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): () => void;
  close(): Promise<void>;
}
```

Channels (all under `daemonet:`): `chat` (every accepted chat line, for the
API's consumers and future multi-process fan-out), `admin` (`{ kind:
'mute' | 'unmute' | 'delete' | 'incident:start', … }`), `org` (`{ kind:
'membership', operatorId, org: { id, name, tag, rank } | null }`).
`MemoryBus` (in-process), `RedisBus` (two connections: publisher and
subscriber). The sim and the api each hold one bus; local development without
Redis uses `MemoryBus` (`REDIS_URL` unset ⇒ memory, with a startup warning).

## 5. Chat

- Channels: `subnet:<id>` (everyone in that world), `cluster:<id>`,
  `org:<id>`, `dm:<operatorId>` (sent to one operator; both sides see it under
  the other's id).
- Command `chat { channel, text }` (text 1–512 chars, trimmed, control
  characters stripped). Guards: the operator may post to the channel (in the
  world / in the cluster / in the org / DM target exists and has not blocked
  them — blocking is SP4-lite: a `ChatBlock` row, API-managed), not muted,
  ≥ 2 s since their last message (`E_RATE`). Accepted lines become a
  `chat` intent? No — chat is not gameplay-critical: the sim writes the row
  through `store.appendChat` (fire-and-forget with one retry), then emits the
  event `chat { id, channel, from, name, tag, text, at }` to every session
  the channel reaches, and publishes on the bus.
- `ChatMessage { id, channel, operatorId, text, at, deletedAt? }`, index
  `(channel, at)`; nightly prune of rows older than 7 days (API cron).
- API: `GET /api/chat/:channel?before=<iso>&limit=64` (membership checked;
  `subnet:*` open to all), `POST /api/admin/chat/mute { operatorId, minutes }`
  (`Operator.mutedUntil`, bus `admin`), `DELETE /api/admin/chat/:id`
  (soft delete + bus `admin` so connected clients drop it).
- SDK: `client.chat.send(channel, text)`, `client.on('chat', …)`,
  `client.chat.channels` (subnet + cluster + org + open DMs). Rate limit
  enforced client-side too (queue, ≤ 1 / 2 s) so scripts do not eat `E_RATE`.
- Client: **Chat** panel with a channel tabs row, message list with names and
  org tags, input with the 2-second cooldown shown; admin sees mute / delete
  buttons.

### 5.1 Filter

- `packages/rules/src/content/chatfilter.ts` ships a default term list
  (plain words and a few patterns); admins extend it at runtime through
  `ChatFilterTerm { id, pattern, kind: WORD | REGEX, action: BLOCK | MASK,
  addedBy, at }` (API `GET/POST/DELETE /api/admin/chat/filter`, bus `admin {
  kind: 'filter' }` so the sim reloads its compiled list).
- Applied by the sim to every chat line **before** it is stored, and by the
  API to operator names, org names and tags. `BLOCK` terms reject the message
  (`E_INVALID`, "message blocked by the chat filter") and record a
  `ChatFilterHit { operatorId, channel, text, term, at }` for review; `MASK`
  terms are replaced by `***` and the line goes through. Matching is
  case-insensitive, ignores repeated characters and common leet substitutions
  (`normalizeForFilter`, pure, tested). Three `BLOCK` hits within 10 minutes
  auto-mute for 10 minutes (bus `admin { kind: 'mute' }`, reason `filter`).

### 5.2 Reporting

- Players report a message or an operator from the client (`report` button on
  a chat line / an operator entity): `POST /api/reports { targetId,
  messageId?, reason: SPAM | HARASSMENT | CHEATING | NAME | OTHER, note ≤ 256
  }`. ≤ 8 reports per operator per day; duplicates of the same
  `(reporter, message)` are ignored. `Report { id, reporterId, targetId,
  messageId?, reason, note, status: OPEN | ACTIONED | DISMISSED, resolvedBy?,
  resolvedAt?, at }`.
- Admin queue: `GET /api/admin/reports?status=OPEN` (with the reported
  message and the target's recent lines and filter hits), `POST
  /api/admin/reports/:id/resolve { action: DISMISS | DELETE | MUTE, minutes?
  }`. The reporter sees only "report received" — never the outcome, and
  never a link outside the game (repo rule).
- Client: report dialog on chat lines and on the target card; admin panel
  section listing open reports with one-click actions.

## 6. Clusters

- `Cluster { id, code, leaderId, members: Map<operatorId, { joinedAt }> }` in
  the `Game` (cross-world); `OperatorSelf.cluster: { id, code, leaderId,
  members: [{ id, name, subnet, away }] } | null`.
- Commands: `clusterInvite { operatorId }` (same world, ≤ 32 tiles; creates a
  cluster of one if the inviter has none), `clusterAccept { clusterId }`,
  `clusterJoin { code }`, `clusterLeave`, `clusterKick { operatorId }`
  (leader). Events: `clusterInvite { clusterId, from, name, expiresTick }`,
  `clusterUpdate` (full cluster object, private to members), `clusterLeft`.
- Shared tagging: `WildState.tagOwner` becomes a **party key** — the
  operator id, or `cluster:<id>` while the tagging operator is in a cluster.
  `candidates`, `startCapture` and `failCapture` compare against the
  operator's current party key; a capture attempt needs the key to match.
- XP split: on defeat, recipients are the damaging daemons of every cluster
  member **present** (same world, ≤ 32 tiles of the defeated daemon); the
  total is split evenly among daemons as today. Capture XP likewise.
- Whoever completes a capture gets the image (unchanged). Ticket progress
  (`clear`) counts for every present member (each member's own tickets).
- Disconnect: a member's session leaving the game removes them from the
  cluster (the 8-second leave window still applies).

## 7. Orgs

- `Org { id, name @unique (3–24, letters digits space _ -), tag @unique
  (4 chars, upper-case letters / digits), ownerId, createdAt, bits? no }`,
  `OrgMember { orgId, operatorId @unique, rank: OWNER | OFFICER | MEMBER,
  joinedAt }`, `OrgInvite { orgId, operatorId, byId, at }` (unique per pair).
- API (all under `/api/orgs`): create (charges 8192 through a ledger row in
  the same transaction, `E 402 insufficient_bits`), get, list (search by
  name / tag), invite (officer+), accept / decline, leave, kick (officer+ for
  members; owner for officers), promote / demote (owner), transfer ownership,
  change tag (owner, 4096 bits), disband (owner, must be the last member).
  `GET /api/orgs/:id/leaderboard` → members with captures (Daemon +
  DaemonArchive rows), highest signature, evolutions, tickets done; sorted by
  a chosen column. `POST /api/me/rename { name }` (2048 bits, name rules as
  the starter claim, unique).
- Membership changes publish `org` on the bus; the sim keeps
  `op.org` (`{ id, name, tag, rank }`) up to date and shows the tag on
  operator entities (`Entity.operator.tag`). `OperatorSelf.org`.
- Client: **Org** panel (create form with the price, member list with ranks
  and actions by rank, invites inbox, leaderboard table, tag change); the top
  bar shows `[TAG] name`.

## 8. Incidents

- `kernelspace` subnet: 128 × 128, tier 5, no spawn regions, one host in the
  south, the boss arena (a 48 × 48 open square) in the north, gateway
  `backbone-kernelspace` (`requires: { level: 32 }`) that `travel` refuses
  unless an Incident is `open` or `fighting`; `kernelspace-backbone` back.
  Operators still inside when the window closes are moved to backbone's host
  (a forced `travel` intent).
- Schedule: `incidentSchedule(now)` → next start at the next multiple of 4 h
  UTC; window 20 minutes; the sim's `IncidentSystem` (only in the
  kernelspace world) drives the state machine `idle → open (boss spawned,
  announced) → fighting (first hit) → cleared | expired → idle`. Admin
  `POST /api/admin/incidents/start` publishes `admin { kind: 'incident:start'
  }` → the sim opens one now (if idle).
- The boss (**kernel daemon**) is the capstone of a bestiary line, rotating
  by Incident number (`CAPSTONES[n % 5]`), level 64, HP × 8, no flee, no tag
  expiry, immune to capture. Phases at 75 % / 50 % / 25 %: a **shield**
  (immune) until the **adds** it spawns (4 wild base forms of its line,
  level 40, tagged to the fight) are cleared; every 16 s a **telegraphed AoE**
  (event `telegraph { x, y, radius, atTick }` 2 s ahead, then 25 % max HP to
  every operator's running daemons in the circle and a `hit` on operators).
  All of it surfaces as events so scripts can react.
- Contribution: damage dealt by an operator's daemons / total damage. On
  `cleared`: pool **8192 bits** split by contribution (minimum 64 for anyone
  ≥ 1 %; ledger reason `incident`), and for every such operator a **personal
  boss copy** — a wild daemon of the boss species at level 48 spawned beside
  them, `tagOwner` = that operator (nobody else can hit or capture it), fresh
  `rollSpawn` (clean / signature odds as any spawn), despawning after 4
  minutes or when the operator leaves the subnet. Capturing it is the normal
  capture flow.
- `Incident { id, n, species, scheduledAt, openedAt, closedAt, outcome:
  OPEN | CLEARED | EXPIRED, participants: Json [{ operatorId, damage, share,
  reward }] }`. Events server-wide (every world, `at: null`): `incident {
  phase: 'open' | 'fighting' | 'cleared' | 'expired', id, species, endsAt }`.
- API: `GET /api/incidents` (last 16 + next scheduled), `GET
  /api/incidents/:id`. Client: a banner in the top bar while one is open
  (countdown, species), a boss HP bar and telegraph circles on the map in
  kernelspace, an **Incidents** tab in the Codex-style panel with history.

## 9. Persistence summary

New tables `ChatMessage`, `ChatBlock`, `ChatFilterTerm`, `ChatFilterHit`,
`Report`, `Org`, `OrgMember`, `OrgInvite`, `Incident`; `Operator.mutedUntil`, `Operator.orgId?` (denormalised for the
sim's load). Intents: none new for chat (store call), `travel` reused for
Incident eviction, `incidentReward` (bits pool payout per operator; idempotent
by `(incidentId, operatorId)`). Ledger reasons `org`, `rename`, `incident`.

## 10. Testing

- bus: MemoryBus semantics; RedisBus contract when `REDIS_URL` is set.
- sim: chat guards / rate limit / delivery scope / mute; filter
  normalisation and block / mask / auto-mute; cluster invite,
  code join, away, kick, leadership hand-over, party-key tagging, XP split,
  capture rights; Incident state machine with a fake clock, phases, adds,
  telegraph damage, contribution maths, payouts and boss copies, eviction.
- api: chat history + moderation; filter terms CRUD; reports (limits,
  duplicates, queue, resolve actions); org lifecycle with prices and ledger rows;
  leaderboard; incidents listing; admin guards.
- client: chat panel and org panel unit tests; e2e: two browser contexts
  chat in `subnet:lo`, form a cluster by code, create an org and see the tag.

## 11. Plans

1. **SP4 plan 1 — Bus and chat:** `packages/bus`, `REDIS_URL`, `chat`
   command + store + events, filter (default list, admin terms, auto-mute),
   reports (API, admin queue), API history / moderation, SDK, chat panel and
   admin section.
2. **SP4 plan 2 — Clusters:** cluster state in `Game`, commands and events,
   party-key tagging, XP split, capture rights, client panel.
3. **SP4 plan 3 — Orgs and rename:** tables, API with prices, bus
   membership updates, org chat channel, tags on entities, org panel.
4. **SP4 plan 4 — Incidents:** `kernelspace`, schedule, boss AI and phases,
   contribution and payouts, boss copies, eviction, admin trigger, client.
