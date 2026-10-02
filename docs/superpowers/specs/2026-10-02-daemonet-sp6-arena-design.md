# Daemonet — SP6: Arena (design)

**Status:** approved for planning · **Date:** 2026-10-02
**Parents:** `2026-09-27-daemonet-design.md` §10 (Arena, Economy), `2026-09-30-daemonet-sp3a-daemon-depth-design.md` (`arenaWins` requirements), `2026-09-30-daemonet-sp4-social-design.md` (runtime services, bus).

## 1. Goal

Script against script. SP6 adds instanced PvP: two connected operators bring
their 8 daemons into a `sandbox` arena, run 2 at a time, and fight until one
side has nothing left or four minutes pass. Ranked matches feed a Glicko-2
ladder with monthly seasons, small capped bits rewards and the `arenaWins`
counter that some evolutions require; unranked challenges are for practice.

## 2. Scope

**In:** the `sandbox` subnet definition, arena match worlds inside the sim,
PvP targeting, level-64 normalisation for ranked, queue matchmaking and
direct challenges, the match lifecycle (countdown, win conditions, forfeit,
timeout), Glicko-2 ratings, seasons with band payouts and soft reset, per-win
bits (capped), `arenaWins`, API (ladder, history, season), SDK and client.

**Out:** spectating other operators' matches, tournaments / brackets, team
(2v2) modes, async "ghost script" PvP, wagers, bans / draft.

## 3. Decisions fixed here

| Question | Decision |
|---|---|
| Rewards | **32 bits per ranked win for the first 16 wins of each UTC day** (max 512 / day; ledger `arena`), plus a **season-end payout by rating band**: < 1400 → 1024, 1400–1599 → 2048, 1600–1799 → 4096, 1800–1999 → 8192, ≥ 2000 → 16384 bits (ledger `arena:season`), for operators with at least 8 ranked matches that season. |
| Hosting | **Same sim process.** Each match is a short-lived `World` built from the `sandbox` definition; at most 16 concurrent matches; operators are handed over like a travel (fresh snapshot) and returned to where they were. |
| Seasons | Calendar months (UTC). Ratings are Glicko-2 (start 1500 / RD 350 / σ 0.06, τ 0.5), updated after every match. At rollover: payouts, then a soft reset (`rating → 1500 + (rating − 1500) / 2`, `RD → max(RD, 200)`). |
| Win-trading | Only the first 4 ranked matches per day between the same two operators count for rating, rewards and `arenaWins`; later ones are played as unranked. |
| What a match risks | Nothing. Daemons fight as **copies**: no XP, no permanent crashes, no item use, no capture; HP / energy / cooldown state is discarded afterwards. |

## 4. Arena worlds

- `SANDBOX: SubnetDef` — 48 × 48, a few symmetric wall blocks, no regions,
  no host services, two spawn points (`arenaSpawns`) 32 tiles apart.
- A match world has `pvp = { a, b }`: `candidates()` for an owned daemon are
  the **other operator's running daemons** (no wild daemons exist); operators
  cannot be hit. The leash and follow rules still apply.
- Allowed commands in a match: `moveTo`, `stop`, `run`, `recall`, `swap`,
  `use`, `chat`, `arenaForfeit`. Everything else → `E_STATE 'not in an arena match'`.
- Ranked normalisation: each of the 8 copies is rebuilt at **level 64** (stats
  from base + IVs + nature at 64, moves at 64) with **signature bonus points
  zeroed**; held items and traits apply. Unranked uses the daemons as they
  are. Copies start at full HP and energy; originals are untouched.

## 5. Match lifecycle (runtime `ArenaService`)

- `arenaQueue { mode: 'ranked' | 'unranked' }`, `arenaLeave`,
  `arenaChallenge { operatorId, mode }`, `arenaAccept { challengeId }`
  (expires after 60 s), `arenaForfeit`. Requirements to enter: a claimed
  starter, at least 2 non-crashed daemons in RAM, nothing running, no capture
  open, not travelling, not already in a match.
- Matchmaking (every second): pair the two waiting operators with the
  closest ratings whose windows overlap; a window is ± 64 rating and widens by
  64 for every 8 s waited (unranked: first come, first served).
- States: `countdown` (3 s, operators placed, snapshot sent, no commands
  except movement of the operator) → `live` → `over`. Win conditions,
  checked every tick: an operator with **all 8 copies crashed** loses; at
  **4 minutes** the higher total HP fraction (sum over the 8 copies of
  hp / maxHp) wins, exact ties are draws; a **controller gone for 8 s** or
  `arenaForfeit` loses.
- On `over`: results event to both, 3 s later both operators are returned
  (their original record, a fresh snapshot of their home world). Ranked
  results raise the durable intent `arenaResult`.
- Events: `arenaQueued`, `arenaMatch { id, mode, opponent: { id, name, tag,
  rating }, startsAtTick, endsAtTick }`, `arenaResult { id, outcome: win |
  loss | draw, ratingBefore, ratingAfter, reward, counted }`. Server
  message `arenaChallenge { challengeId, from, name, mode }`.

## 6. Ratings, seasons, rewards

- `packages/rules/src/glicko2.ts` — pure `rate(player, opponent, score)`
  (single-game rating period) and `decayRd` for inactivity; tested against
  the worked example in Glickman's paper.
- `ArenaSeason { id (YYYY-MM), startsAt, endsAt, closedAt? }`,
  `ArenaRating { operatorId, seasonId, rating, rd, vol, wins, losses, draws,
  @@id([operatorId, seasonId]) }`, `ArenaMatch { id, seasonId, mode, aId,
  bId, winnerId?, aBefore, aAfter, bBefore, bAfter, counted, durationMs,
  endedAt }`.
- `arenaResult` intent (one transaction): both ratings, the match row,
  per-win bits when the winner is under 16 rewarded wins today, and
  `arenaWins + 1` on the winner's daemons that **dealt damage** in the match.
- Season close (api timer at month rollover, idempotent per season): band
  payouts with ledger rows and bus `bits` pushes, soft reset rows for the new
  season, `closedAt`.
- API: `GET /api/arena/me` (rating, RD, record, today's rewarded wins, band),
  `GET /api/arena/ladder?season=&cursor=` (top by rating, min 8 matches),
  `GET /api/arena/matches?mine=1`, `GET /api/arena/seasons`.

## 7. SDK and client

- SDK: `client.arena.queue(mode)`, `leave()`, `challenge(operatorId, mode)`,
  `accept(challengeId)`, `forfeit()`; `client.arena.match` (current match or
  null); daemon scripts get `enemies` = the opponent's running daemons while
  in a match (same `DaemonScriptContext`), so a battle script works in both
  worlds.
- Client **Arena** tab: queue buttons with the waiting time, rating / band /
  record, ladder, match history, incoming challenges; in a match a HUD with
  the timer and both sides' eight copies (HP bars, crashed marks).

## 8. Testing

- rules: Glicko-2 against the published example; symmetry; RD shrink / decay.
- sim: PvP targeting (only the opponent's running daemons), command
  whitelist, normalisation (level 64, bonus zeroed, originals untouched),
  queue pairing with widening windows, challenge / accept / expiry, win by
  wipe-out, timeout by HP fraction, draw, forfeit and disconnect, return to
  the home world with state intact, 16-match cap, pair-per-day cap.
- store / api: `arenaResult` idempotency, ratings and rewards, daily cap,
  `arenaWins`, season close payouts and soft reset, ladder and history.
- client: arena HUD unit test; e2e: two browser operators queue unranked,
  the match starts, one forfeits, both return to `lo` with their daemons.

## 9. Plans

1. **SP6 plan 1 — Arena worlds and matches:** `sandbox`, PvP rules,
   normalisation, `ArenaService` (queue, challenge, lifecycle), protocol, SDK.
2. **SP6 plan 2 — Ratings, seasons, rewards:** Glicko-2, tables,
   `arenaResult` intent, season close, API.
3. **SP6 plan 3 — Client:** Arena tab, match HUD, e2e.
