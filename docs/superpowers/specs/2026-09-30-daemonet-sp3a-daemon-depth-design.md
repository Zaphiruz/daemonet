# Daemonet SP3a — Daemon Depth: full bestiary, evolution, traits, held items, all challenge families

**Status:** approved in brainstorming, 2026-09-30
**Parents:** `2026-09-27-daemonet-design.md` §6–§7 (incl. §7.1 evolution), `2026-09-29-daemonet-bestiary-design.md`. SP3b (`…-sp3b-…`) covers Codex research, decompile/crafting, the shop, Tickets, Disk expansion and the seven other subnets.

## 1. Goal

Every one of the 50 lines / 256 species exists and can be captured, levelled and
**evolved** through its tree (choices, requirements, hidden branches, first
discovery), with IV growth, clean conversion and signature upgrades exactly as
the game design says. All 16 capture-challenge families work, so every type is
capturable. Traits have effects, held items exist. The web client and SDK
expose all of it.

## 2. Scope

**In:** bestiary data + generated stats (`packages/rules`), 64 moves (4 per
type), the full 16×16 type chart, 16 traits with effects, 4 held items + 16
evolution items, the 12 remaining challenge families, `evolve` (rules + sim +
protocol + SDK + client), requirement tracking (`moveTypeUses`, `crashes`,
`arenaWins`, `patched`), discovery records and Codex reveal, `lo` spawning all
50 base forms, `Daemon.history`, API/Codex additions, client UI (evolve panel,
Codex trees).

**Out (SP3b):** research, decompile, crafting, shop, Tickets, Disk expansion,
Bit Flippers/Patches as purchasable items, other subnets and travel.
**Out (later):** Arena (`arenaWins` stays 0 until SP6), Incidents.

## 3. Content model

### 3.1 Bestiary data (`packages/rules/src/content/bestiary.ts`)

One row per species (256): `{ id, name, line, stage, types, role, evolvesFrom, evolvesAt, requirement, hidden, capstone }` transcribed from the bestiary spec. Species ids are lowercase names (`pingling`, `ddosberman` — punctuation removed).

### 3.2 Generated base stats

`baseStatsFor(row)` is deterministic:

- **Budget** by stage: 300 / 420 / 500 / 540; capstones 600; starter lines ×0.95 at every stage.
- **Role weights** over `[hp, attack, defense, focus, resolve, speed, haste, energy]`:

| role | weights |
|---|---|
| balanced | 1 1 1 1 1 1 1 1 |
| sweeper | .8 1.4 .7 .8 .7 1.5 1.2 .9 |
| nuker | .8 .7 .7 1.5 .9 1 1.1 1.3 |
| tank | 1.5 .9 1.4 .6 1.2 .6 .7 1.1 |
| wall | 1.2 .6 1 .8 1.6 .6 .8 1.4 |
| striker | .9 1.4 .8 .7 .7 1 1.4 1.1 |
| spammer | .9 .9 .8 .9 .8 1 1.6 1.1 |
| support | 1.1 .7 1 1.1 1.2 1 1 .9 |
| scout | .8 .9 .7 .8 .7 1.7 1.3 1.1 |
| bruiser | 1.3 1.4 1.1 .6 .8 .8 .9 1.1 |
| battery | 1 .7 1 .9 1 .8 1 1.6 |

- Per-species jitter ±6% per stat from an RNG seeded by the species id, then
  each stat = `round(budget · w_i·j_i / Σ)`, clamped 1–256, and the largest stat
  absorbs the rounding so the total equals the budget exactly.
- `STAT_OVERRIDES: Partial<Record<speciesId, Partial<StatBlock>>>` is applied
  last (hand tuning; a test still enforces the budget ±0 unless the override
  sets `total`).
- SP1's eight hand-authored species keep their exact stats via overrides.

### 3.3 Moves (64) and learnsets

Four per type in the SP1 pattern (filler 256–512 ms, ranged single, area
cone/circle, heavy 4096–8192 ms). Each type has one status-bearing move:
`throttled` (Crypto, Cache, Proxy, Cloud), `stalled` (Glitch, Thread, Buffer,
Null), and two new statuses: `leaking` (loses 2 energy/s, 4096 ms — Heap,
Packet, Socket, Stack) and `exposed` (takes +25% damage, 4096 ms — Kernel,
Signal, Shell, Root). All statuses halve capture-challenge size.

Learnset for a species = primary filler L1, primary ranged L1, area L8 (the
**secondary** type's area when dual-typed, else primary), primary heavy L16.
On evolution moves are relearned from the new form's learnset at the current
level. Evolved forms with a new secondary type therefore change their area
move.

### 3.4 Type chart (16×16)

Authored as a full table in `types.ts` (SP1's four-type corner unchanged).
Every type has 2 strengths (×2), 2 weaknesses (×½ against it) and at most one
immunity, arranged so each type appears as a strength of exactly two others.

### 3.5 Traits (16, effects in the sim)

| id | effect |
|---|---|
| echo | filler moves (base cooldown ≤ 512 ms) have a 25% chance to hit again at half power |
| lowlatency | the first move after becoming active or being tagged ignores its cooldown |
| synburst | filler moves cost 0 energy below 25% HP |
| retransmit | an area move that hits nothing refunds its energy |
| salted | damage from the same move id as the previous hit taken is −25% |
| onewayfn | immune to status effects |
| darkmode | moves with range ≥ 6 deal −25% to it |
| sonar | +2 range on single-target moves |
| overclock | cooldowns −12.5% below 25% HP |
| bitshield | the first hit in each tag engagement is blocked |
| entropy | statuses it inflicts last +50% |
| decay | targets it hits lose 4 energy |
| nullsafe | survives one lethal hit per engagement at 1 HP |
| lazyeval | heavy moves (base cooldown ≥ 4096 ms) cost −25% energy |
| voidstep | +50% movement speed with no hostile within 8 tiles |
| absorb | regains energy equal to 10% of damage taken |

Each species has two trait ids assigned by role (deterministic table in the
bestiary data); `traitSlot` picks one; evolution keeps the slot index.

### 3.6 Held items

4 held items (`amplifier` +12.5% damage dealt, `heatsink` −12.5% cooldowns,
`battery` +50% energy regen, `firewall` −12.5% damage taken) and the 16
evolution items (bestiary §3). `Daemon.heldItem: string | null`; commands
`hold(daemonId, itemId)` / `unhold(daemonId)` move items between inventory
and the slot (at any time; consumed evolution items disappear on evolve).
Held items are obtained in SP3b (shop/crafting); SP3a seeds none but the
mechanics and tests exist. `Bit Flipper` use marks `patched` (mechanic only).

## 4. Evolution

### 4.1 Rules (`packages/rules/src/evolution.ts`, pure)

- `evolutionOptions(species, daemon, ctx)` → `[{ form, level, requirement, hidden, met, revealed }]` where `ctx = { subnet, otherOperatorsNearby, discovered: Set<formId>, originalOperator: boolean }`.
- `evolve(daemon, form, rng)` applies, in order: IV growth (each IV < 31 gains +1 with p = ½), clean check (all 31 and not patched → `clean = true`, signature stays), signature upgrade (clean → 1/256 chance of +1 tier ≤ 15, +1 bonus on a random stat), species/stats/moves update (HP keeps its fraction), `traitSlot` kept, returns `{ daemon, changes }` for the history entry.
- Requirement evaluation by kind: `heldItem`, `dominantIV` (strict max), `moveTypeUses` (lifetime counters per type), `subnet`, `clean`/`signature`, `originalOperator`, `crashes ≤/≥`, `arenaWins` (0 until SP6), `unobserved` (no other operator within 32 tiles).

### 4.2 Sim

- `Daemon` gains `moveTypeUses: number[16]`, `crashes`, `arenaWins`, `patched`, `heldItem`, `history`; combat increments `moveTypeUses[type]` per use, crashes on crash.
- `evolve(daemonId, formId)` command: daemon in RAM, not running (or running is fine? — **must not be running**, keeps it simple), level ≥ form level, requirement met → intent `evolve` (durable: new species, ivs, bonus, clean, signature, heldItem, history entry, and a `Discovery` row if this form has no discoverer yet). Effects apply after commit; event `evolved { daemon, from, to, changes }` (private) and, on first discovery, `discovery { form, operator }` (server-wide).
- `RamDaemon` gains `evolutions: [{ form, level, hidden, met, requirement: string | null }]` (`requirement` is `null` while hidden and undiscovered).

### 4.3 Discovery

`Discovery { formId @id, operatorId, discoveredAt }`. The Codex API returns each
form's requirement only when not hidden or already discovered (plus the
discoverer's operator name). The sim caches discovered ids and refreshes on
each discovery intent.

## 5. Challenge families (the remaining 12)

Same framework as SP1; each: `generate(size, noise, rng)`, `check`, answer schema, test-only reference solver.

| Type | params / payload → answer |
|---|---|
| kernel | processes `[{ pid, arrival, burst }]`, `quantum` → `{ order: pid[] }` (round-robin completion order; ties by pid) |
| cache | `capacity`, `trace: key[]` → `{ hits }` (LRU) |
| thread | events `[{ t, thread, op: 'lock'|'unlock'|'read'|'write', obj }]` → `{ race: [i, j] }` (the first pair of accesses to the same obj from different threads with no lock held in common, by index) |
| signal | `masked: number[]`, `signals: [{ t, sig }]`, `unmaskAt: t` → `{ order: sig[] }` (delivery order: unmasked immediately, masked delivered in ascending sig at `unmaskAt`) |
| socket | `segments: [{ conn, flag: 'SYN'|'SYNACK'|'ACK'|'FIN'|'RST' }]` → `{ states: Record<conn, state> }` (a fixed 6-state TCP machine; invalid transitions ignored) |
| buffer | `capacity`, `ops: ('w:<hex byte>' | 'r')[]` → `{ contents: hex }` (overwriting ring: writes drop the oldest when full; reads remove the oldest) |
| shell | `lines: string[]`, `pipeline: string` from `grep <pat> | sort | uniq | cut -d<c> -f<n> | wc -l` (subset) → `{ output: string[] }` |
| root | `mode: 'rwxr-x---'`, `owner`, `group`, `acl: [{ who, perms }]`, `requests: [{ user, groups, op }]` → `{ allowed: '10110' }` |
| proxy | `layers: ('hex'|'base64'|'xor:<byte>'|'lenprefix')[]`, `payload` → `{ inner: string }` |
| cloud | `nodes: string[]`, `vnodes`, `keys: string[]` → `{ placement: Record<key, node> }` (FNV-1a ring) |
| stack | `program: op[]` over `push n | add | sub | mul | dup | swap | drop | jz k | jmp k` → `{ top }` (≤ 4096 steps) |
| heap | `events: [{ op: 'alloc', id, size } | { op: 'free', id }]` → `{ leaked: id[] }` (sorted) |

Noise: kernel/signal/socket add no-op or duplicate events; cache/cloud/heap add
decoy entries the rules say to ignore; shell adds blank lines; stack adds
`nop`. Sizes follow `challengeSize`.

## 6. Spawning (`lo` only, SP3a)

`lo`'s four regions weight all 50 base forms by level band (base forms only):
lobby 2–6 (starters + 12 lowest-BST bases), uplink 5–10, cache 9–16, core
14–24 (the highest-BST bases). SP3b spreads evolved forms across subnets.

## 7. Persistence

`Daemon` gains `heldItem String?`, `patched Boolean @default(false)`,
`moveTypeUses Int[]` (16), `crashes Int @default(0)`, `arenaWins Int @default(0)`,
`history Json @default("[]")` (array of `{ at, kind: 'captured'|'evolved'|'clean'|'signature'|'patched', detail }`).
New table `Discovery`. Intent `evolve` (idempotent). Checkpoint also writes
`moveTypeUses`, `crashes`, `heldItem`.

## 8. Protocol / SDK / client

- Commands: `evolve { daemonId, formId }`, `hold { daemonId, itemId }`, `unhold { daemonId }`.
- Events: `evolved`, `discovery`, `statuses` gains `leaking` / `exposed`.
- `RamDaemon` gains `heldItem`, `patched`, `moveTypeUses`, `crashes`, `evolutions`.
- SDK: `operator.evolve(id, form)`, `operator.hold/unhold`, `ram.evolutions`.
- Client: RAM card shows an **Evolve** section (ready forms, requirements or `???`, button), a Codex **Trees** view (all 50 lines as trees with discovered/undiscovered markers), 64 moves and the 16×16 chart, held-item slot.
- API: `/api/codex` adds `bestiary`, `discoveries`, `traits` effects text, held items.

## 9. Testing

- rules: budget test for all 256 species, learnset validity, 16×16 chart properties, `evolve` order/probabilities (statistical), requirement evaluation per kind, each of the 12 families with reference solvers (property: solver passes, mutation fails, deterministic, < 64 KiB).
- sim: evolve command (not running, level gate, requirement gate, hidden reveal on discovery), trait effects (one test each), held items, statuses, `moveTypeUses` counting.
- api: codex hides undiscovered requirements; discovery listing.
- client: evolve panel unit test; e2e extended with an evolution at level 8 (a test daemon seeded at level 8 via dev route).

## 10. Plans

1. **SP3a plan 1 — Content:** bestiary data, stat generator, 64 moves, chart, traits/items data, spawn tables.
2. **SP3a plan 2 — Twelve challenge families.**
3. **SP3a plan 3 — Evolution and traits in the sim:** rules `evolution.ts`, sim tracking, trait effects, held items, intents, protocol/SDK.
4. **SP3a plan 4 — API and client:** Codex/discovery, evolve UI, trees, e2e.
