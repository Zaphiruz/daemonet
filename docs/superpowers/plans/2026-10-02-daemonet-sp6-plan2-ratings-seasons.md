# Daemonet SP6 · Plan 2 — Ratings, seasons, rewards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arena matches mean something: ranked results move Glicko-2 ratings, a ranked win pays 32 bits (first 16 a day) and bumps `arenaWins` on the daemons that dealt damage, months are seasons that end with a band payout and a soft reset, and the api serves standings, ladder, history and seasons.

**Architecture:** The maths is pure and lives in `@daemonet/rules` (`glicko2.ts`, plus season / band / settlement helpers next to the arena constants). The sim's `Store` gets `recordArenaResult`, one idempotent transaction keyed by the match id that both store implementations build on the same `settleArena` helper. `ArenaService.report` now hands the finished match to the store (through `Game`, with the intent retry schedule) and announces the `arenaResult` events when the settlement comes back, mirroring the win bits and `arenaWins` into memory wherever the operator is by then. `Game` keeps a small rating cache for matchmaking. Season close is an idempotent sweep in the api (`closeSeasons`) on a timer, like the Exchange expiry.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP6 plan 1 merged.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp6-arena-design.md` §3, §6, §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Glicko-2: start 1500 / RD 350 / σ 0.06, τ 0.5, rated after every counted match.
- Counted = ranked **and** fewer than 4 counted matches between the two operators that UTC day. Only counted matches change ratings, records, bits or `arenaWins`.
- 32 bits per counted win while the winner has fewer than 16 rewarded wins that UTC day (ledger `arena`, `ref` = match id). Season payout (ledger `arena:season`, `ref` = season id) for ≥ 8 counted matches: < 1400 → 1024, 1400–1599 → 2048, 1600–1799 → 4096, 1800–1999 → 8192, ≥ 2000 → 16384.
- Soft reset: `rating → 1500 + (rating − 1500) / 2`, `RD → max(RD, 200)`.
- Checkpoints never write `bits` or `arenaWins`; both change only inside `recordArenaResult` / `closeSeasons`.

## Deviations from the spec (deliberate)

- The spec's "durable intent `arenaResult`" is the store method `recordArenaResult`. World intents belong to one operator and complete inside the world that raised them; a match result concerns two operators and outlives its world. The guarantees are the same: one transaction, idempotent by id, retried by the runtime.
- `ArenaMatch` also stores `reason`, `aReward` and `bReward`, so a retried call and the history can report them. Unranked matches are recorded too (never counted).
- A rating row for a new season is seeded from last season's row with the soft reset the moment it is first needed (first match or `/api/arena/me`), so the ladder does not depend on the close sweep having run; the sweep creates the rows that are still missing.
- `decayRd` is implemented and tested as the spec asks but nothing applies it yet (the monthly soft reset already widens RD).
- Ladder paging uses a numeric offset as `cursor`.

## File map

```
packages/rules/src/glicko2.ts               rate, rateGames, decayRd
packages/rules/src/content/arena.ts         bands, seasons, softReset, settleMatch, seedRating, settleArena
packages/db/prisma/schema.prisma            ArenaSeason, ArenaRating, ArenaMatch (+ migration 20261002000004)
apps/sim/src/runtime/store.ts               ArenaResultInput, ArenaSettlement, Store.recordArenaResult / arenaRating, MemoryStore
apps/sim/src/runtime/prisma-store.ts        the same on Postgres
apps/sim/src/runtime/arena.ts               report → record → announce, credit
apps/sim/src/runtime/game.ts                rating cache, recordArena with retries
apps/api/src/arena/seasons.ts               closeSeasons
apps/api/src/routes/arena.ts                /api/arena/me, /ladder, /matches, /seasons
apps/api/src/server.ts                      season timer
tests: packages/rules/test/glicko2.test.ts, apps/sim/test/{store,arena-service}.test.ts, apps/api/test/arena.test.ts
```

---

### Task 1: Glicko-2 and the season rules

**Files:**
- Create: `packages/rules/src/glicko2.ts`, `packages/rules/test/glicko2.test.ts`
- Modify: `packages/rules/src/content/arena.ts`, `packages/rules/src/index.ts`

**Interfaces:**
- `Glicko { rating, rd, vol }`, `GLICKO_START`, `GLICKO_TAU`, `rate(player, opponent, score, tau?)`, `rateGames(player, games, tau?)`, `decayRd(player, periods)`.
- `ARENA_WIN_BITS = 32`, `ARENA_DAILY_WINS = 16`, `ARENA_SEASON_MIN_MATCHES = 8`, `ARENA_BANDS`, `arenaBand(rating)`, `seasonIdOf(date)`, `seasonBounds(id) → { startsAt, endsAt, next }`, `previousSeasonId(id)`, `softReset(r)`, `seedRating(previous?)`, `settleMatch(a, b, winner)`, `settleArena(mode, winner, { a, b, pairCountedToday, winnerRewardedToday }) → { counted, a, b, reward }`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ARENA_BANDS, GLICKO_START, arenaBand, decayRd, rate, rateGames, seasonBounds, seasonIdOf, settleMatch, softReset } from '../src/index.js';

describe('Glicko-2', () => {
  it('reproduces the worked example from Glickman’s paper', () => {
    const after = rateGames({ rating: 1500, rd: 200, vol: 0.06 }, [
      { opponent: { rating: 1400, rd: 30 }, score: 1 },
      { opponent: { rating: 1550, rd: 100 }, score: 0 },
      { opponent: { rating: 1700, rd: 300 }, score: 0 },
    ]);
    expect(after.rating).toBeCloseTo(1464.06, 1);
    expect(after.rd).toBeCloseTo(151.52, 1);
    expect(after.vol).toBeCloseTo(0.05999, 4);
  });

  it('is symmetric for equal players and shrinks the deviation with every game', () => {
    const win = rate(GLICKO_START, GLICKO_START, 1);
    const loss = rate(GLICKO_START, GLICKO_START, 0);
    const draw = rate(GLICKO_START, GLICKO_START, 0.5);
    expect(win.rating - 1500).toBeCloseTo(1500 - loss.rating, 6);
    expect(win.rating).toBeGreaterThan(1600);
    expect(draw.rating).toBeCloseTo(1500, 6);
    expect(win.rd).toBeLessThan(350);
    expect(rate(win, loss, 1).rd).toBeLessThan(win.rd);
    // beating a much stronger player moves more than beating a weaker one
    const settled = { rating: 1500, rd: 60, vol: 0.06 };
    expect(rate(settled, { rating: 1900, rd: 60 }, 1).rating - 1500).toBeGreaterThan(rate(settled, { rating: 1100, rd: 60 }, 1).rating - 1500);
  });

  it('grows the deviation while idle, never past 350', () => {
    const p = { rating: 1700, rd: 60, vol: 0.06 };
    const idle = decayRd(p, 30);
    expect(idle.rating).toBe(1700);
    expect(idle.rd).toBeGreaterThan(80);
    expect(decayRd(p, 100_000).rd).toBe(350);
    expect(rateGames(p, [])).toEqual(decayRd(p, 1));
  });
});

describe('arena seasons and rewards', () => {
  it('names seasons by UTC month and bounds them', () => {
    expect(seasonIdOf(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(seasonIdOf(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
    expect(seasonBounds('2026-12')).toEqual({ startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: new Date('2027-01-01T00:00:00Z'), next: '2027-01' });
  });

  it('pays by rating band and soft-resets towards 1500', () => {
    expect(ARENA_BANDS.map((b) => b.payout)).toEqual([1024, 2048, 4096, 8192, 16384]);
    expect([1399.9, 1400, 1599, 1600, 1800, 1999.5, 2000, 2600].map((r) => arenaBand(r).payout)).toEqual([1024, 2048, 2048, 4096, 8192, 8192, 16384, 16384]);
    expect(softReset({ rating: 1900, rd: 80, vol: 0.05 })).toEqual({ rating: 1700, rd: 200, vol: 0.05 });
    expect(softReset({ rating: 1300, rd: 260, vol: 0.06 })).toEqual({ rating: 1400, rd: 260, vol: 0.06 });
  });

  it('settles a match for both sides at once', () => {
    const a = { rating: 1500, rd: 200, vol: 0.06 };
    const b = { rating: 1700, rd: 100, vol: 0.06 };
    const upset = settleMatch(a, b, 'a');
    expect(upset.a.rating).toBeGreaterThan(1500);
    expect(upset.b.rating).toBeLessThan(1700);
    expect(upset.a).toEqual(rate(a, b, 1));
    expect(upset.b).toEqual(rate(b, a, 0));
    const draw = settleMatch(a, b, null);
    expect(draw.a.rating).toBeGreaterThan(1500); // a draw against a stronger player still gains
    expect(draw.b.rating).toBeLessThan(1700);
  });
});
```

- [ ] **Step 2: Implementation**

Create `packages/rules/src/glicko2.ts`:

```ts
/**
 * Glicko-2 (Glickman, "Example of the Glicko-2 system", 2012). Ratings are kept on the familiar scale
 * (1500 / RD 350); the maths runs on the internal scale (μ, φ). The Arena rates after every match, so a
 * rating period is usually a single game.
 */
export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

export const GLICKO_START: Glicko = { rating: 1500, rd: 350, vol: 0.06 };
export const GLICKO_TAU = 0.5;
export const GLICKO_MAX_RD = 350;

const SCALE = 173.7178;
const EPSILON = 0.000001;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** New volatility σ′ (step 5 of the paper; the Illinois variant of regula falsi). */
function volatility(phi: number, v: number, delta: number, vol: number, tau: number): number {
  const a = Math.log(vol * vol);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/** One rating period: `player` after the given games (score 1 win, 0.5 draw, 0 loss). No games = RD decay only. */
export function rateGames(player: Glicko, games: ReadonlyArray<{ opponent: Pick<Glicko, 'rating' | 'rd'>; score: number }>, tau = GLICKO_TAU): Glicko {
  if (games.length === 0) return decayRd(player, 1);
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  let vInv = 0;
  let sum = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - 1500) / SCALE;
    const phiJ = opponent.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    sum += g(phiJ) * (score - e);
  }
  const v = 1 / vInv;
  const vol = volatility(phi, v, v * sum, player.vol, tau);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return { rating: muNew * SCALE + 1500, rd: Math.min(GLICKO_MAX_RD, phiNew * SCALE), vol };
}

/** A single game. */
export function rate(player: Glicko, opponent: Pick<Glicko, 'rating' | 'rd'>, score: number, tau = GLICKO_TAU): Glicko {
  return rateGames(player, [{ opponent, score }], tau);
}

/** `periods` rating periods without a game: the rating stays, the deviation grows with the volatility (capped at 350). */
export function decayRd(player: Glicko, periods: number): Glicko {
  let phi = player.rd / SCALE;
  for (let i = 0; i < periods; i++) phi = Math.sqrt(phi * phi + player.vol * player.vol);
  return { ...player, rd: Math.min(GLICKO_MAX_RD, phi * SCALE) };
}
```

Append to `packages/rules/src/content/arena.ts` (and import `GLICKO_START, rate, type Glicko` from `'../glicko2.js'` at its top):

```ts
// ---- ratings, seasons, rewards (SP6 spec §3, §6) ----

/** Bits for a ranked win, for the first ARENA_DAILY_WINS wins of each UTC day. */
export const ARENA_WIN_BITS = 32;
export const ARENA_DAILY_WINS = 16;
/** Ranked matches in a season needed for the season payout and a ladder place. */
export const ARENA_SEASON_MIN_MATCHES = 8;
export const ARENA_RESET_RD = 200;

/** Season payout by final rating: the band with the highest `min` not above the rating. */
export const ARENA_BANDS: ReadonlyArray<{ min: number; payout: number }> = [
  { min: 0, payout: 1024 },
  { min: 1400, payout: 2048 },
  { min: 1600, payout: 4096 },
  { min: 1800, payout: 8192 },
  { min: 2000, payout: 16384 },
];

export function arenaBand(rating: number): { min: number; payout: number } {
  let band = ARENA_BANDS[0]!;
  for (const b of ARENA_BANDS) if (rating >= b.min) band = b;
  return band;
}

/** Seasons are UTC calendar months, named `YYYY-MM`. */
export function seasonIdOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function seasonBounds(id: string): { startsAt: Date; endsAt: Date; next: string } {
  const [year, month] = id.split('-').map(Number) as [number, number];
  const startsAt = new Date(Date.UTC(year, month - 1, 1));
  const endsAt = new Date(Date.UTC(year, month, 1));
  return { startsAt, endsAt, next: seasonIdOf(endsAt) };
}

/** What a rating carries into the next season: halfway back to 1500, at least RD 200. */
export function softReset(r: Glicko): Glicko {
  return { rating: ARENA_START_RATING + (r.rating - ARENA_START_RATING) / 2, rd: Math.max(r.rd, ARENA_RESET_RD), vol: r.vol };
}

/** Both ratings after one match; `winner` null = draw. */
export function settleMatch(a: Glicko, b: Glicko, winner: 'a' | 'b' | null): { a: Glicko; b: Glicko } {
  const score = winner === null ? 0.5 : winner === 'a' ? 1 : 0;
  return { a: rate(a, b, score), b: rate(b, a, 1 - score) };
}

export function previousSeasonId(id: string): string {
  return seasonIdOf(new Date(seasonBounds(id).startsAt.getTime() - 86_400_000));
}

/** The rating a season starts from: last season's, soft-reset, or the Glicko-2 default. */
export function seedRating(previous: Glicko | null | undefined): Glicko {
  return previous ? softReset(previous) : { ...GLICKO_START };
}

/**
 * What one finished match changes. Only ranked matches under the pair-per-day cap count; a counted win pays
 * ARENA_WIN_BITS while the winner is under the daily cap. Everything else leaves ratings alone and pays nothing.
 */
export function settleArena(
  mode: ArenaMode,
  winner: 'a' | 'b' | null,
  ctx: { a: Glicko; b: Glicko; pairCountedToday: number; winnerRewardedToday: number },
): { counted: boolean; a: Glicko; b: Glicko; reward: number } {
  const counted = mode === 'ranked' && ctx.pairCountedToday < ARENA_PAIR_DAILY_CAP;
  if (!counted) return { counted, a: ctx.a, b: ctx.b, reward: 0 };
  return { counted, ...settleMatch(ctx.a, ctx.b, winner), reward: winner !== null && ctx.winnerRewardedToday < ARENA_DAILY_WINS ? ARENA_WIN_BITS : 0 };
}
```

`packages/rules/src/index.ts`: `export * from './glicko2.js';`.

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules` — expected: green (6 new tests; the paper's example gives 1464.06 / 151.52 / 0.05999).

```bash
git add packages/rules
git commit -m "feat(rules): Glicko-2, arena seasons, bands and match settlement"
```

---

### Task 2: Recording results

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261002000004_sp6_arena/migration.sql`
- Modify: `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/test/store.test.ts`

**Interfaces:**
- `ArenaResultInput { matchId, mode, aId, bId, winnerId, reason, durationMs, endedAt, dealt }`, `ArenaSideResult { before, after, reward, arenaWins }`, `ArenaSettlement { counted, a, b }`.
- `Store.recordArenaResult(input) → ArenaSettlement` (idempotent by `matchId`), `Store.arenaRating(operatorId, at) → number`.

- [ ] **Step 1: Schema and migration**

```prisma
/// Arena seasons are UTC months (SP6 spec §6); `closedAt` is set once payouts and the soft reset have run.
model ArenaSeason {
  id       String    @id
  startsAt DateTime
  endsAt   DateTime
  closedAt DateTime?
}

/// Glicko-2 rating of one operator in one season; the record counts counted (ranked) matches only.
model ArenaRating {
  operatorId String
  seasonId   String
  rating     Float
  rd         Float
  vol        Float
  wins       Int    @default(0)
  losses     Int    @default(0)
  draws      Int    @default(0)

  @@id([operatorId, seasonId])
  @@index([seasonId, rating])
}

/// Every finished match. `counted` = it moved ratings (ranked, under the pair-per-day cap).
model ArenaMatch {
  id         String   @id
  seasonId   String
  /// ranked | unranked
  mode       String
  aId        String
  bId        String
  winnerId   String?
  /// wipeout | timeout | forfeit | disconnect
  reason     String
  aBefore    Float
  aAfter     Float
  bBefore    Float
  bAfter     Float
  aReward    Int      @default(0)
  bReward    Int      @default(0)
  counted    Boolean
  durationMs Int
  endedAt    DateTime

  @@index([aId, endedAt])
  @@index([bId, endedAt])
  @@index([endedAt])
}
```

```sql
-- CreateTable
CREATE TABLE "ArenaSeason" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ArenaSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaRating" (
    "operatorId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "rd" DOUBLE PRECISION NOT NULL,
    "vol" DOUBLE PRECISION NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaRating_pkey" PRIMARY KEY ("operatorId","seasonId")
);

-- CreateTable
CREATE TABLE "ArenaMatch" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "winnerId" TEXT,
    "reason" TEXT NOT NULL,
    "aBefore" DOUBLE PRECISION NOT NULL,
    "aAfter" DOUBLE PRECISION NOT NULL,
    "bBefore" DOUBLE PRECISION NOT NULL,
    "bAfter" DOUBLE PRECISION NOT NULL,
    "aReward" INTEGER NOT NULL DEFAULT 0,
    "bReward" INTEGER NOT NULL DEFAULT 0,
    "counted" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArenaRating_seasonId_rating_idx" ON "ArenaRating"("seasonId", "rating");

-- CreateIndex
CREATE INDEX "ArenaMatch_aId_endedAt_idx" ON "ArenaMatch"("aId", "endedAt");

-- CreateIndex
CREATE INDEX "ArenaMatch_bId_endedAt_idx" ON "ArenaMatch"("bId", "endedAt");

-- CreateIndex
CREATE INDEX "ArenaMatch_endedAt_idx" ON "ArenaMatch"("endedAt");
```

Deploy and regenerate.

- [ ] **Step 2: Failing contract test**

`apps/sim/test/store.test.ts` — import `type ArenaResultInput`; add `"ArenaMatch", "ArenaRating", "ArenaSeason"` to the PrismaStore `TRUNCATE` (they have no foreign key to `Operator`); add to the contract:

```ts
    it('settles arena matches: ratings, capped win bits, arenaWins, idempotent by match id', async () => {
      const ops: string[] = [];
      for (const name of ['ann', 'ben', 'cy', 'di', 'ed', 'flo']) {
        const op = await store.loadOrCreateOperator(`sub-ar-${name}`, 'lo', SPAWN);
        await store.applyIntent(claim(op.id, `ar${name}`, ownedRecord('pingling', 5, 0, `abcd1234-ar-${name}`)), { seedId: 'abcd1234' });
        ops.push(op.id);
      }
      const [ann, ben] = ops as [string, string];
      let n = 0;
      const match = (over: Partial<ArenaResultInput>): ArenaResultInput => ({
        matchId: `m-${++n}`, mode: 'ranked', aId: ann, bId: ben, winnerId: ann, reason: 'wipeout', durationMs: 60_000, endedAt: '2026-10-02T12:00:00.000Z',
        dealt: { [ann]: ['abcd1234-ar-ann', 'abcd1234-ar-ben'], [ben]: ['abcd1234-ar-ben'] }, ...over,
      });
      const bitsOf = async (i: number) => (await store.loadOrCreateOperator(`sub-ar-${['ann', 'ben', 'cy', 'di', 'ed', 'flo'][i]}`, 'lo', SPAWN)).bits;
      const winsOf = async (name: string) => (await store.loadOrCreateOperator(`sub-ar-${name}`, 'lo', SPAWN)).ram[0]!.arenaWins;

      expect(await store.arenaRating(ann, new Date('2026-10-02T12:00:00Z'))).toBe(1500);
      const first = match({});
      const s1 = await store.recordArenaResult(first);
      expect(s1).toMatchObject({ counted: true, a: { before: 1500, reward: 32, arenaWins: ['abcd1234-ar-ann'] }, b: { before: 1500, reward: 0, arenaWins: [] } });
      expect(s1.a.after).toBeGreaterThan(1600);
      expect(s1.b.after).toBeCloseTo(3000 - s1.a.after, 6);
      // a retry of the same match changes nothing
      expect(await store.recordArenaResult(first)).toMatchObject({ counted: true, a: { after: s1.a.after, reward: 32 } });
      expect(await bitsOf(0)).toBe(32);
      expect([await winsOf('ann'), await winsOf('ben')]).toEqual([1, 0]); // only the winner's own daemons that dealt damage
      expect(await store.arenaRating(ann, new Date('2026-10-20T00:00:00Z'))).toBe(s1.a.after);
      expect((await store.ledgerFor(ann)).filter((l) => l.reason === 'arena')).toMatchObject([{ delta: 32, ref: 'm-1' }]);

      // unranked: recorded, nothing moves
      expect(await store.recordArenaResult(match({ mode: 'unranked' }))).toMatchObject({ counted: false, a: { before: s1.a.after, after: s1.a.after, reward: 0 } });
      // a draw counts and pays nobody
      const draw = await store.recordArenaResult(match({ winnerId: null }));
      expect(draw).toMatchObject({ counted: true, a: { reward: 0 }, b: { reward: 0 } });
      expect(draw.a.after).toBeLessThan(s1.a.after); // the favourite loses a little
      // the same pair: two more count (4 a day), the next does not
      await store.recordArenaResult(match({ winnerId: ben }));
      await store.recordArenaResult(match({}));
      expect(await store.recordArenaResult(match({}))).toMatchObject({ counted: false, a: { reward: 0 } });
      // another UTC day counts again
      expect(await store.recordArenaResult(match({ endedAt: '2026-10-03T00:00:01.000Z' }))).toMatchObject({ counted: true, a: { reward: 32 } });

      // daily reward cap: ann has 2 rewarded wins on the 2nd; 14 more pay, the 17th does not
      let paid = 0;
      for (const opp of ops.slice(2)) {
        for (let i = 0; i < 4; i++) paid += (await store.recordArenaResult(match({ bId: opp, dealt: {} }))).a.reward;
      }
      expect(paid).toBe(14 * 32);
      expect(await bitsOf(0)).toBe(17 * 32);

      // next season: the first match starts from the soft-reset rating
      const before = await store.arenaRating(ann, new Date('2026-10-31T00:00:00Z'));
      expect(await store.arenaRating(ann, new Date('2026-11-01T00:00:00Z'))).toBeCloseTo(1500 + (before - 1500) / 2, 6);
      const nov = await store.recordArenaResult(match({ endedAt: '2026-11-05T00:00:00.000Z', bId: ops[2]! }));
      expect(nov.a.before).toBeCloseTo(1500 + (before - 1500) / 2, 6);
    });
```

- [ ] **Step 3: Store types and the in-memory implementation**

`apps/sim/src/runtime/store.ts` (import `previousSeasonId, seasonIdOf, seedRating, settleArena, type ArenaMode, type Glicko` from rules):

```ts
/** A finished arena match as the sim reports it (SP6 spec §6). `dealt`: operator id → its copies that dealt damage. */
export interface ArenaResultInput {
  matchId: string;
  mode: ArenaMode;
  aId: string;
  bId: string;
  winnerId: string | null;
  reason: 'wipeout' | 'timeout' | 'forfeit' | 'disconnect';
  durationMs: number;
  /** ISO timestamp; decides the season and the UTC day of the caps. */
  endedAt: string;
  dealt: Record<string, string[]>;
}

export interface ArenaSideResult {
  before: number;
  after: number;
  reward: number;
  /** Daemons whose `arenaWins` went up by one. */
  arenaWins: string[];
}

export interface ArenaSettlement {
  counted: boolean;
  a: ArenaSideResult;
  b: ArenaSideResult;
}
```

in `interface Store`:

```ts
  /**
   * Records a finished match in one transaction: ratings (counted matches only), the per-win bits with their
   * ledger row, `arenaWins` on the winner's daemons that dealt damage, and the match row. Idempotent by match id.
   */
  recordArenaResult(input: ArenaResultInput): Promise<ArenaSettlement>;
  /** The operator's rating in the season of `at` (or what its first match there would start from). */
  arenaRating(operatorId: string, at: Date): Promise<number>;
```

`MemoryStore` gets the fields

```ts
  /** `${operatorId}:${seasonId}` -> rating and record */
  readonly arenaRatings = new Map<string, Glicko & { wins: number; losses: number; draws: number }>();
  readonly arenaMatches = new Map<string, { input: ArenaResultInput; settlement: ArenaSettlement }>();
```

and

```ts
  private arenaRow(operatorId: string, seasonId: string): Glicko & { wins: number; losses: number; draws: number } {
    const key = `${operatorId}:${seasonId}`;
    let row = this.arenaRatings.get(key);
    if (!row) this.arenaRatings.set(key, (row = { ...seedRating(this.arenaRatings.get(`${operatorId}:${previousSeasonId(seasonId)}`)), wins: 0, losses: 0, draws: 0 }));
    return row;
  }

  async arenaRating(operatorId: string, at: Date): Promise<number> {
    const season = seasonIdOf(at);
    return (this.arenaRatings.get(`${operatorId}:${season}`) ?? seedRating(this.arenaRatings.get(`${operatorId}:${previousSeasonId(season)}`))).rating;
  }

  async recordArenaResult(input: ArenaResultInput): Promise<ArenaSettlement> {
    const done = this.arenaMatches.get(input.matchId);
    if (done) return done.settlement;
    const endedAt = new Date(input.endedAt);
    const season = seasonIdOf(endedAt);
    const day = input.endedAt.slice(0, 10);
    const a = this.arenaRow(input.aId, season);
    const b = this.arenaRow(input.bId, season);
    const samePair = (m: ArenaResultInput) => (m.aId === input.aId && m.bId === input.bId) || (m.aId === input.bId && m.bId === input.aId);
    const pairCountedToday = [...this.arenaMatches.values()].filter((m) => m.settlement.counted && m.input.endedAt.slice(0, 10) === day && samePair(m.input)).length;
    const winnerRewardedToday = input.winnerId ? this.ledger.filter((l) => l.operatorId === input.winnerId && l.reason === 'arena' && l.at.slice(0, 10) === day).length : 0;
    const winner = input.winnerId === null ? null : input.winnerId === input.aId ? 'a' : 'b';
    const s = settleArena(input.mode, winner, { a, b, pairCountedToday, winnerRewardedToday });
    const side = (before: number, after: number): ArenaSideResult => ({ before, after, reward: 0, arenaWins: [] });
    const settlement: ArenaSettlement = { counted: s.counted, a: side(a.rating, s.a.rating), b: side(b.rating, s.b.rating) };
    if (s.counted) {
      Object.assign(a, s.a, winner === null ? { draws: a.draws + 1 } : winner === 'a' ? { wins: a.wins + 1 } : { losses: a.losses + 1 });
      Object.assign(b, s.b, winner === null ? { draws: b.draws + 1 } : winner === 'b' ? { wins: b.wins + 1 } : { losses: b.losses + 1 });
      if (winner && input.winnerId) {
        const won = settlement[winner];
        if (s.reward > 0) {
          const op = this.operators.get(input.winnerId);
          if (op) op.bits += s.reward;
          this.ledger.push({ operatorId: input.winnerId, delta: s.reward, reason: 'arena', ref: input.matchId, at: input.endedAt });
          won.reward = s.reward;
        }
        for (const id of input.dealt[input.winnerId] ?? []) {
          const d = this.daemons.get(id);
          if (!d || d.operatorId !== input.winnerId) continue;
          d.arenaWins++;
          won.arenaWins.push(id);
        }
      }
    }
    this.arenaMatches.set(input.matchId, { input, settlement });
    return settlement;
  }
```

- [ ] **Step 4: PrismaStore**

`apps/sim/src/runtime/prisma-store.ts` (import `previousSeasonId, seasonBounds, seasonIdOf, seedRating, settleArena` and the two types). The caps are counted inside the match's own UTC day (`gte` day start, `lt` next day):

```ts
  async arenaRating(operatorId: string, at: Date): Promise<number> {
    const seasonId = seasonIdOf(at);
    const row = await this.prisma.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId } } });
    if (row) return row.rating;
    return seedRating(await this.prisma.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId: previousSeasonId(seasonId) } } })).rating;
  }

  async recordArenaResult(input: ArenaResultInput): Promise<ArenaSettlement> {
    const fromRow = (m: { counted: boolean; aBefore: number; aAfter: number; bBefore: number; bAfter: number; aReward: number; bReward: number }): ArenaSettlement => ({
      counted: m.counted,
      a: { before: m.aBefore, after: m.aAfter, reward: m.aReward, arenaWins: [] },
      b: { before: m.bBefore, after: m.bAfter, reward: m.bReward, arenaWins: [] },
    });
    const endedAt = new Date(input.endedAt);
    const seasonId = seasonIdOf(endedAt);
    const dayStart = new Date(Date.UTC(endedAt.getUTCFullYear(), endedAt.getUTCMonth(), endedAt.getUTCDate()));
    const today = { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const done = await tx.arenaMatch.findUnique({ where: { id: input.matchId } });
        if (done) return fromRow(done);
        const bounds = seasonBounds(seasonId);
        await tx.arenaSeason.upsert({ where: { id: seasonId }, create: { id: seasonId, startsAt: bounds.startsAt, endsAt: bounds.endsAt }, update: {} });
        const ratingOf = async (operatorId: string) => {
          const row = await tx.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId } } });
          if (row) return row;
          const previous = await tx.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId: previousSeasonId(seasonId) } } });
          return tx.arenaRating.create({ data: { operatorId, seasonId, ...seedRating(previous) } });
        };
        const a = await ratingOf(input.aId);
        const b = await ratingOf(input.bId);
        const pairCountedToday = await tx.arenaMatch.count({
          where: { counted: true, endedAt: today, OR: [{ aId: input.aId, bId: input.bId }, { aId: input.bId, bId: input.aId }] },
        });
        const winnerRewardedToday = input.winnerId ? await tx.bitsLedger.count({ where: { operatorId: input.winnerId, reason: 'arena', at: today } }) : 0;
        const winner = input.winnerId === null ? null : input.winnerId === input.aId ? 'a' : 'b';
        const s = settleArena(input.mode, winner, { a, b, pairCountedToday, winnerRewardedToday });
        const settlement: ArenaSettlement = {
          counted: s.counted,
          a: { before: a.rating, after: s.a.rating, reward: 0, arenaWins: [] },
          b: { before: b.rating, after: s.b.rating, reward: 0, arenaWins: [] },
        };
        if (s.counted) {
          const record = (side: 'a' | 'b') => (winner === null ? { draws: { increment: 1 } } : winner === side ? { wins: { increment: 1 } } : { losses: { increment: 1 } });
          await tx.arenaRating.update({ where: { operatorId_seasonId: { operatorId: input.aId, seasonId } }, data: { rating: s.a.rating, rd: s.a.rd, vol: s.a.vol, ...record('a') } });
          await tx.arenaRating.update({ where: { operatorId_seasonId: { operatorId: input.bId, seasonId } }, data: { rating: s.b.rating, rd: s.b.rd, vol: s.b.vol, ...record('b') } });
          if (winner && input.winnerId) {
            const won = settlement[winner];
            if (s.reward > 0) {
              await tx.operator.update({ where: { id: input.winnerId }, data: { bits: { increment: BigInt(s.reward) } } });
              await tx.bitsLedger.create({ data: { operatorId: input.winnerId, delta: BigInt(s.reward), reason: 'arena', ref: input.matchId, at: endedAt } });
              won.reward = s.reward;
            }
            const ids = input.dealt[input.winnerId] ?? [];
            if (ids.length > 0) {
              const mine = await tx.daemon.findMany({ where: { id: { in: ids }, operatorId: input.winnerId }, select: { id: true } });
              won.arenaWins = mine.map((d) => d.id);
              await tx.daemon.updateMany({ where: { id: { in: won.arenaWins } }, data: { arenaWins: { increment: 1 } } });
            }
          }
        }
        await tx.arenaMatch.create({
          data: {
            id: input.matchId, seasonId, mode: input.mode, aId: input.aId, bId: input.bId, winnerId: input.winnerId, reason: input.reason,
            aBefore: settlement.a.before, aAfter: settlement.a.after, bBefore: settlement.b.before, bAfter: settlement.b.after,
            aReward: settlement.a.reward, bReward: settlement.b.reward, counted: settlement.counted, durationMs: input.durationMs, endedAt,
          },
        });
        return settlement;
      });
    } catch (err) {
      // a retry that raced its first attempt: the match row is there, report what it recorded
      if (!isUniqueViolation(err)) throw err;
      return fromRow(await this.prisma.arenaMatch.findUniqueOrThrow({ where: { id: input.matchId } }));
    }
  }
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && DATABASE_URL=... pnpm exec vitest run apps/sim/test/store.test.ts` — expected: green for both stores.

```bash
git add packages/db apps/sim
git commit -m "feat(sim): record arena results — ratings, capped win bits, arenaWins, idempotent"
```

---

### Task 3: The service settles through the store

**Files:**
- Modify: `apps/sim/src/runtime/arena.ts`, `apps/sim/src/runtime/game.ts`
- Replace: `apps/sim/test/arena-service.test.ts`

**Interfaces:**
- `ArenaDeps.record(input) → Promise<ArenaSettlement | null>` (null = the store stayed unreachable), `ArenaDeps.rated(id, rating)`.
- `Match.startedAt`; `ArenaService.report` → `announce` → `credit`.

- [ ] **Step 1: Tests**

Results now arrive asynchronously, so the harness settles with a real `MemoryStore` and the tests wait for it. Replace `apps/sim/test/arena-service.test.ts`:

```ts
import { MemoryBus } from '@daemonet/bus';
import { ARENA_LEVEL, ARENA_MAX_MATCHES, SANDBOX, msToTicks } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type OperatorRecord } from '../src/core/index.js';
import { ArenaService } from '../src/runtime/arena.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore, type ArenaResultInput } from '../src/runtime/store.js';
import { TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const COUNTDOWN = msToTicks(3000);
const RETURN = msToTicks(3000);

/** ArenaService over one real home world, with the runtime's part (sessions, snapshots) faked. */
function harness(names: string[], ratings: Record<string, number> = {}) {
  const home = makeWorld('home');
  /** Results are settled by a real MemoryStore that knows the operators and their RAM daemons. */
  const store = new MemoryStore();
  const recorded: ArenaResultInput[] = [];
  let storeDown = false;
  const where = new Map<string, World>();
  const events: Array<{ to: string; event: GameEvent }> = [];
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  const offline = new Set<string>();
  let now = Date.parse('2026-10-02T12:00:00Z');
  let n = 0;
  for (const name of names) {
    const rec = operatorRecord(name);
    home.addOperator(rec);
    where.set(name, home);
    store.operators.set(name, { id: name, sub: name, name, starterClaimed: true, subnet: 'test', bits: 0, diskCapacity: 256, x: 0, y: 0, inventory: {} });
    for (const d of rec.ram) store.daemons.set(d.id, { ...d, operatorId: name, location: 'RAM' });
  }
  const arena = new ArenaService({
    locate: (id) => {
      const world = where.get(id);
      const op = world?.operators.get(id);
      return world === home && op ? { op, world } : undefined;
    },
    connected: (id) => !offline.has(id),
    transfer: (id, to, record: OperatorRecord) => {
      where.get(id)!.removeOperator(id);
      to.addOperator({ ...record, subnet: to.subnet.id });
      where.set(id, to);
    },
    event: (to, event) => events.push({ to, event }),
    send: (to, msg) => sent.push({ to, msg }),
    rating: (id) => ratings[id] ?? 1500,
    record: async (input) => {
      recorded.push(input);
      return storeDown ? null : store.recordArenaResult(input);
    },
    rated: (id, rating) => (ratings[id] = rating),
    now: () => now,
    newId: () => `${(++n).toString(16).padStart(8, '0')}${'0'.repeat(24)}`,
  });
  /** One game tick: match worlds step, then the service. */
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      for (const w of arena.worlds()) w.step([]);
      arena.tick();
    }
  };
  /** Lets the (asynchronous) store settle and the service announce. */
  const settled = () => new Promise<void>((r) => setImmediate(r));
  return { home, where, arena, events, sent, offline, tick, store, recorded, ratings, settled, failStore: () => (storeDown = true), advance: (ms: number) => (now += ms), of: (e: GameEvent['e'], to?: string) => events.filter((x) => x.event.e === e && (!to || x.to === to)).map((x) => x.event) };
}

describe('ArenaService', () => {
  it('checks who may enter', () => {
    const h = harness(['alice', 'bob']);
    const alice = h.home.operators.get('alice')!;
    step(h.home, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ code: 'E_STATE', message: 'recall running daemons first' });
    h.home.deactivate(h.home.daemons.get('alice-d0')!);
    h.home.daemons.get('alice-d1')!.crashed = true;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'the arena needs 2 daemons in RAM that have not crashed' });
    h.home.daemons.get('alice-d1')!.crashed = false;
    alice.starterClaimed = false;
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'claim a starter first' });
    alice.starterClaimed = true;
    expect(h.arena.queueUp('nobody', 'unranked')).toMatchObject({ message: 'not connected' });
    expect(h.arena.forfeit('alice')).toMatchObject({ message: 'not in an arena match' });
    expect(h.arena.queueUp('alice', 'unranked')).toEqual({ queued: 'unranked' });
    expect(h.arena.queued('alice')).toBe('unranked');
    h.arena.leaveQueue('alice');
    expect(h.of('arenaQueued', 'alice')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }, { e: 'arenaQueued', mode: null }]);
  });

  it('pairs the unranked queue in order, runs the match and brings both home as they were', async () => {
    const h = harness(['alice', 'bob', 'carol']);
    h.home.daemons.get('alice-d0')!.hp = 7;
    h.home.operators.get('alice')!.x = 9.5;
    for (const name of ['alice', 'bob', 'carol']) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
    expect(h.arena.queued('carol')).toBe('unranked');
    const [world] = h.arena.worlds();
    expect(world!.subnet.id).toBe('sandbox');
    expect([...h.home.operators.keys()]).toEqual(['carol']);
    expect(world!.operators.get('alice')).toMatchObject(SANDBOX.arenaSpawns[0]);
    expect(world!.operators.get('bob')).toMatchObject(SANDBOX.arenaSpawns[1]);
    expect(world!.daemons.get('alice-d0')!.hp).toBeGreaterThan(7); // the copy is healed
    expect(h.of('arenaMatch', 'alice')[0]).toMatchObject({ mode: 'unranked', opponent: { id: 'bob', name: 'bob', rating: 1500 }, startsAtTick: COUNTDOWN });
    expect(h.arena.queueUp('alice', 'unranked')).toMatchObject({ message: 'already in an arena match' });
    // what a checkpoint would write while the match runs
    expect(h.arena.homeRecord('alice')).toMatchObject({ subnet: 'test', x: 9.5, ram: [{ id: 'alice-d0', hp: 7, level: 20 }, { id: 'alice-d1' }] });

    h.tick(COUNTDOWN);
    world!.operators.get('alice')!.bits += 50; // a sale on the Exchange lands mid-match
    expect(h.arena.forfeit('bob')).toEqual({ ok: true });
    h.tick();
    await h.settled();
    expect(h.recorded[0]).toMatchObject({ mode: 'unranked', aId: 'alice', bId: 'bob', winnerId: 'alice', reason: 'forfeit' });
    expect(h.of('arenaResult', 'alice')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit', counted: false, reward: 0 });
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'loss', reason: 'forfeit' });
    expect(h.arena.inMatch('alice')).toBe(true);
    h.tick(RETURN);
    expect(h.arena.inMatch('alice') || h.arena.inMatch('bob')).toBe(false);
    expect(h.arena.worlds()).toEqual([]);
    const alice = h.home.operators.get('alice')!;
    expect(alice).toMatchObject({ x: 9.5, bits: 50 });
    expect(h.home.daemons.get('alice-d0')).toMatchObject({ hp: 7, level: 20, crashed: false });
    expect(h.home.operators.has('bob')).toBe(true);
  });

  it('pairs ranked operators by rating, widening the window every 8 s', () => {
    const h = harness(['a', 'b', 'c'], { a: 1500, b: 1700, c: 1960 });
    for (const name of ['a', 'b', 'c']) h.arena.queueUp(name, 'ranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(0); // 200 apart, windows 64 + 64
    h.advance(8000);
    h.tick(16);
    expect(h.arena.inMatch('a') && h.arena.inMatch('b')).toBe(true); // 128 + 128
    expect(h.arena.inMatch('c')).toBe(false);
    const [world] = h.arena.worlds();
    expect(world!.daemons.get('a-d0')!.level).toBe(ARENA_LEVEL);
    expect(world!.arena).toMatchObject({ mode: 'ranked', ratings: { a: 1500, b: 1700 } });
  });

  it('challenges: delivered, accepted within 60 s, one at a time', () => {
    const h = harness(['alice', 'bob']);
    expect(h.arena.challenge('alice', 'alice', 'unranked')).toMatchObject({ code: 'E_INVALID' });
    expect(h.arena.challenge('alice', 'nobody', 'unranked')).toMatchObject({ message: 'that operator is not online' });
    const first = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.sent.at(-1)).toMatchObject({ to: 'bob', msg: { t: 'arenaChallenge', d: { challengeId: first.challengeId, from: 'alice', name: 'alice', mode: 'unranked' } } });
    expect(h.arena.accept('alice', first.challengeId)).toMatchObject({ code: 'E_INVALID' }); // not addressed to alice
    h.advance(61_000);
    expect(h.arena.accept('bob', first.challengeId)).toMatchObject({ message: 'that challenge has expired' });
    const second = h.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string };
    const third = h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string };
    expect(h.arena.accept('bob', second.challengeId)).toMatchObject({ code: 'E_INVALID' }); // replaced by the third
    expect(h.arena.accept('bob', third.challengeId)).toMatchObject({ matchId: expect.any(String) });
    expect(h.arena.inMatch('alice') && h.arena.inMatch('bob')).toBe(true);
  });

  it('a controller gone for 8 s forfeits; an operator that leaves is sent home at once', async () => {
    const h = harness(['alice', 'bob', 'carol', 'dave']);
    h.arena.accept('bob', (h.arena.challenge('alice', 'bob', 'unranked') as { challengeId: string }).challengeId);
    h.offline.add('alice');
    h.tick(msToTicks(8000) - 1);
    expect(h.of('arenaResult')).toEqual([]);
    h.tick();
    await h.settled();
    expect(h.of('arenaResult', 'bob')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });

    h.arena.accept('dave', (h.arena.challenge('carol', 'dave', 'unranked') as { challengeId: string }).challengeId);
    h.arena.drop('carol');
    expect(h.where.get('carol')).toBe(h.home);
    expect(h.arena.inMatch('carol')).toBe(false);
    expect(h.arena.inMatch('dave')).toBe(true);
    await h.settled();
    expect(h.of('arenaResult', 'dave')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    h.tick(RETURN + 1);
    expect(h.where.get('dave')).toBe(h.home);
  });

  it('settles ranked results: ratings, the win reward and arenaWins reach the store and the operators', async () => {
    const h = harness(['alice', 'bob']);
    const play = async (winner: string, loser: string) => {
      h.arena.accept('bob', (h.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string }).challengeId);
      const [world] = h.arena.worlds();
      world!.arena!.dealt.add(`${winner}-d0`).add(`${loser}-d1`);
      h.tick(COUNTDOWN);
      h.arena.forfeit(loser);
      h.tick();
      await h.settled();
      const result = { winner: h.of('arenaResult', winner).at(-1)!, loser: h.of('arenaResult', loser).at(-1)!, world: world! };
      return result;
    };
    const first = await play('alice', 'bob');
    expect(h.recorded[0]).toMatchObject({ mode: 'ranked', winnerId: 'alice', dealt: { alice: ['alice-d0'], bob: ['bob-d1'] } });
    expect(first.winner).toMatchObject({ outcome: 'win', counted: true, ratingBefore: 1500, reward: 32 });
    expect(first.loser).toMatchObject({ outcome: 'loss', counted: true, reward: 0 });
    expect((first.winner as { ratingAfter: number }).ratingAfter).toBeGreaterThan(1600);
    expect((first.loser as { ratingAfter: number }).ratingAfter).toBeLessThan(1400);
    expect(h.of('bits', 'alice')).toEqual([{ e: 'bits', delta: 32, reason: 'arena', balance: 32 }]);
    // still in the match world: the reward and the counter travel home with the operator
    expect(first.world.operators.get('alice')!.bits).toBe(32);
    h.tick(RETURN + 1);
    expect(h.home.operators.get('alice')!.bits).toBe(32);
    expect([h.home.daemons.get('alice-d0')!.arenaWins, h.home.daemons.get('alice-d1')!.arenaWins, h.home.daemons.get('bob-d1')!.arenaWins]).toEqual([1, 0, 0]);
    expect(h.store.operators.get('alice')!.bits).toBe(32);
    expect(h.store.daemons.get('alice-d0')!.arenaWins).toBe(1);
    expect(h.store.ledger).toMatchObject([{ operatorId: 'alice', delta: 32, reason: 'arena' }]);
    // the next match starts from the new ratings
    expect(h.ratings.alice).toBeGreaterThan(1600);
    const second = await play('bob', 'alice');
    expect(second.world.arena!.ratings).toEqual({ alice: h.store.arenaMatches.get(h.recorded[0]!.matchId)!.settlement.a.after, bob: h.store.arenaMatches.get(h.recorded[0]!.matchId)!.settlement.b.after });
    expect(second.winner).toMatchObject({ outcome: 'win', counted: true, reward: 32 });
    h.tick(RETURN + 1);

    // the store is unreachable: the match still ends and everyone goes home, nothing is counted
    h.failStore();
    const third = await play('alice', 'bob');
    expect(third.winner).toMatchObject({ outcome: 'win', counted: false, reward: 0, ratingBefore: h.ratings.alice, ratingAfter: h.ratings.alice });
    h.tick(RETURN + 1);
    expect(h.home.operators.get('alice')!.bits).toBe(32);
  });

  it('caps concurrent matches at 16 and ranked matches between the same pair at 4 a day', () => {
    const names = Array.from({ length: 2 * ARENA_MAX_MATCHES + 2 }, (_, i) => `op${i}`);
    const h = harness(names);
    for (const name of names) h.arena.queueUp(name, 'unranked');
    h.tick(16);
    expect(h.arena.worlds()).toHaveLength(ARENA_MAX_MATCHES);
    expect(h.arena.queued('op32')).toBe('unranked');
    expect(h.arena.accept('op33', (h.arena.challenge('op32', 'op33', 'unranked') as { challengeId: string }).challengeId)).toMatchObject({ message: 'the arena is full; try again shortly' });

    const pair = harness(['alice', 'bob']);
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      pair.arena.accept('bob', (pair.arena.challenge('alice', 'bob', 'ranked') as { challengeId: string }).challengeId);
      modes.push(pair.arena.worlds()[0]!.arena!.mode);
      pair.arena.forfeit('alice');
      pair.tick(RETURN + 2);
    }
    expect(modes).toEqual(['ranked', 'ranked', 'ranked', 'ranked', 'unranked']);
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `arena-conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  events<E extends GameEvent['e']>(e: E) {
    return this.of('delta').flatMap((m) => m.d.events).filter((x): x is Extract<GameEvent, { e: E }> => x.e === e);
  }
}

describe('arena matches in the runtime', () => {
  async function setup(opts: { leaveAfterTicks?: number; checkpointEveryTicks?: number } = {}) {
    const store = new MemoryStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), ...opts });
    let seq = 0;
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      const id = conn.of('authOk')[0]!.d.operatorId;
      const op = world.operators.get(id)!;
      op.starterClaimed = true;
      op.name = name;
      world.addOwned(op, { ...ownedRecord('pingling', 20, 0, `${name}-d0`), originalOperatorId: id });
      world.addOwned(op, { ...ownedRecord('glitchmite', 20, 1, `${name}-d1`), originalOperatorId: id });
      const cmd = (command: object) => game.message(conn, JSON.stringify({ t: 'cmd', seq: ++seq, d: { reqId: `q${seq}`, ...command } }));
      return { conn, id, cmd };
    };
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) game.tick();
    };
    return { game, world, store, join, ticks };
  }

  it('queues two operators into a sandbox world with fresh snapshots, and back', async () => {
    const { game, world, join, ticks } = await setup();
    const a = await join('alice');
    const b = await join('bob');
    await a.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'not in an arena match' });
    await a.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    await b.cmd({ cmd: 'arenaQueue', actor: 'self', args: { mode: 'unranked' } });
    expect(a.conn.of('ack').at(-1)!.d.result).toEqual({ queued: 'unranked' });
    ticks(17);
    expect(a.conn.events('arenaQueued')).toEqual([{ e: 'arenaQueued', mode: 'unranked' }]);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'sandbox', self: { arena: { phase: 'countdown', mode: 'unranked', opponent: { id: b.id } } } });
    // alice entered first; the delta that follows shows bob and his team
    expect(a.conn.of('delta').at(-1)!.d.self!.arena!.opponent).toMatchObject({ name: 'bob', team: [{ id: 'bob-d0', running: false }, { id: 'bob-d1' }] });
    expect(a.conn.events('arenaMatch')[0]).toMatchObject({ opponent: { id: b.id } });
    expect(world.operators.size).toBe(0);
    expect(game.worldOf(a.id)!.subnet.id).toBe('sandbox');

    ticks(COUNTDOWN);
    // a normal command now runs in the match world; one outside the whitelist is refused there
    await a.cmd({ cmd: 'run', actor: 'self', args: { daemonId: 'alice-d0' } });
    await a.cmd({ cmd: 'restoreAll', actor: 'self', args: {} });
    ticks(1);
    expect(a.conn.of('ack').at(-1)!.d.reqId).toBeDefined();
    expect(a.conn.of('err').at(-1)!.d).toMatchObject({ message: 'not available in an arena match' });
    expect(a.conn.of('delta').at(-1)!.d.self).toMatchObject({ running: ['alice-d0'], arena: { phase: 'live' } });

    await b.cmd({ cmd: 'arenaForfeit', actor: 'self', args: {} });
    ticks(2);
    await game.flush();
    ticks(1);
    expect(a.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'forfeit', counted: false });
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'loss' });
    ticks(RETURN + 1);
    expect(a.conn.of('snapshot').at(-1)!.d).toMatchObject({ subnet: 'test', self: { arena: null, running: [], ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1' }] } });
    expect(world.operators.size).toBe(2);
    await game.shutdown();
  });

  it('checkpoints the home record during a match and forfeits for an operator that leaves', async () => {
    const { game, world, store, join, ticks } = await setup({ leaveAfterTicks: 24, checkpointEveryTicks: 8 });
    const a = await join('alice');
    const b = await join('bob');
    const checkpoints: OperatorRecord[][] = [];
    const checkpoint = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(records.map((r) => structuredClone(r)));
      return checkpoint(records);
    };
    await a.cmd({ cmd: 'arenaChallenge', actor: 'self', args: { operatorId: b.id, mode: 'ranked' } });
    const challenge = b.conn.of('arenaChallenge')[0]!.d;
    expect(challenge).toMatchObject({ from: a.id, name: 'alice', mode: 'ranked' });
    await b.cmd({ cmd: 'arenaAccept', actor: 'self', args: { challengeId: challenge.challengeId } });
    expect(a.conn.of('snapshot').at(-1)!.d.self.ram[0]).toMatchObject({ level: ARENA_LEVEL });
    ticks(16);
    await game.flush();
    expect(checkpoints.at(-1)!.find((r) => r.id === a.id)).toMatchObject({ subnet: 'test', ram: [{ id: 'alice-d0', level: 20 }, { id: 'alice-d1', level: 20 }] });

    game.disconnect(a.conn);
    ticks(25);
    await game.flush();
    expect(game.worldOf(a.id)).toBeUndefined(); // gone from the server…
    ticks(1);
    expect(b.conn.events('arenaResult')[0]).toMatchObject({ outcome: 'win', reason: 'disconnect' });
    expect(checkpoints.at(-1)).toMatchObject([{ id: a.id, subnet: 'test', ram: [{ level: 20 }, { level: 20 }] }]); // …with its real daemons
    ticks(RETURN + 1);
    expect(game.worldOf(b.id)).toBe(world);
    await game.shutdown();
  });
});
```

- [ ] **Step 2: The service**

`apps/sim/src/runtime/arena.ts` — import the three store types; `ArenaDeps` gains

```ts
  /** Persists a finished match (with retries); null when the store could not be reached. */
  record(input: ArenaResultInput): Promise<ArenaSettlement | null>;
  /** The operator's rating changed. */
  rated(id: string, rating: number): void;
```

`Match` gains `startedAt: number` (set to `this.deps.now()` in `start`), and `report` is replaced by

```ts
  /** Schedules the way home and has the match recorded; both operators hear the result once the store has settled it. */
  private report(match: Match): void {
    const arena = match.world.arena!;
    const result = arena.result!;
    match.reported = true;
    match.returnAtTick = match.world.tick + msToTicks(ARENA_RETURN_MS);
    const [a, b] = match.sides;
    const now = this.deps.now();
    const dealt: Record<string, string[]> = { [a.id]: [], [b.id]: [] };
    for (const id of arena.dealt) {
      const owner = [a, b].find((s) => s.record.ram.some((d) => d.id === id));
      if (owner) dealt[owner.id]!.push(id);
    }
    const input: ArenaResultInput = { matchId: match.id, mode: match.mode, aId: a.id, bId: b.id, winnerId: result.winner, reason: result.reason, durationMs: now - match.startedAt, endedAt: new Date(now).toISOString(), dealt };
    void this.deps.record(input).then((settlement) => this.announce(match, settlement));
  }

  private announce(match: Match, settlement: ArenaSettlement | null): void {
    const arena = match.world.arena!;
    const result = arena.result!;
    match.sides.forEach((side, i) => {
      const before = arena.ratings[side.id]!;
      const r: ArenaSideResult = settlement ? settlement[i === 0 ? 'a' : 'b'] : { before, after: before, reward: 0, arenaWins: [] };
      const outcome = result.winner === null ? 'draw' : result.winner === side.id ? 'win' : 'loss';
      this.deps.rated(side.id, r.after);
      this.credit(match, side, r);
      this.deps.event(side.id, { e: 'arenaResult', id: match.id, mode: match.mode, outcome, reason: result.reason, ratingBefore: r.before, ratingAfter: r.after, reward: r.reward, counted: settlement?.counted ?? false });
    });
  }

  /** The store has already paid the win and bumped `arenaWins`; mirror both in memory, wherever the operator is by now. */
  private credit(match: Match, side: Side, r: ArenaSideResult): void {
    if (r.reward === 0 && r.arenaWins.length === 0) return;
    const home = side.returned ? this.deps.locate(side.id) : undefined;
    const op = side.returned ? home?.op : match.world.operators.get(side.id);
    if (op && r.reward > 0) {
      // in the match world the balance travels home with the operator (sendHome)
      op.bits += r.reward;
      this.deps.event(side.id, { e: 'bits', delta: r.reward, reason: 'arena', balance: op.bits });
    }
    for (const id of r.arenaWins) {
      const original = side.returned ? home?.world.daemons.get(id) : side.record.ram.find((d) => d.id === id);
      if (original) original.arenaWins++;
    }
  }
```

The return home stays on its 3-second schedule whether or not the store has answered; `credit` handles both orders.

- [ ] **Step 3: `Game`**

A field `private readonly ratings = new Map<string, number>();`, deleted in `leave` next to `this.sessions.delete(...)`. The service's deps:

```ts
      rating: (id) => this.ratings.get(id) ?? ARENA_START_RATING,
      record: (input) => {
        const done = this.recordArena(input);
        this.track(done);
        return done;
      },
      rated: (id, rating) => {
        if (this.sessions.has(id)) this.ratings.set(id, rating);
      },
```

When a session is created in `authenticate` (after `this.chat.loadMute(...)`):

```ts
        const operatorId = rec.id;
        this.track(
          this.store.arenaRating(operatorId, new Date()).then(
            (rating) => void (this.sessions.has(operatorId) && this.ratings.set(operatorId, rating)),
            (err: Error) => this.log.warn({ err: err.message }, 'arena rating load failed'),
          ),
        );
```

and

```ts
  /** Persists an arena result with the same patience as an intent; null = the store stayed unreachable. */
  private async recordArena(input: ArenaResultInput): Promise<ArenaSettlement | null> {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      try {
        return await this.store.recordArenaResult(input);
      } catch (err) {
        this.log.warn({ match: input.matchId, attempt, err: (err as Error).message }, 'arena result persist failed');
        const delay = this.retryDelays[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
    }
    return null;
  }
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm exec vitest run apps/sim` — expected: green (9 service / runtime tests).

```bash
git add apps/sim
git commit -m "feat(sim): arena results settle through the store; rating cache for matchmaking"
```

---

### Task 4: Seasons and the api

**Files:**
- Create: `apps/api/src/arena/seasons.ts`, `apps/api/src/routes/arena.ts`, `apps/api/test/arena.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/server.ts`

**Interfaces:**
- `closeSeasons(prisma, bus, now?) → number` (seasons closed).
- `GET /api/arena/me` → `{ season, seasonEndsAt, rating, rd, wins, losses, draws, band: { min, payout }, payoutEligible, matchesForPayout, rewardedWinsToday, dailyWins, winBits }`; `GET /api/arena/ladder?season=&cursor=` → `{ season, rows: [{ rank, operatorId, name, tag, rating, rd, wins, losses, draws }], next }`; `GET /api/arena/matches?mine=0|1` → last 32 `{ id, season, mode, reason, counted, durationMs, endedAt, winnerId, a: { id, name, before, after, reward }, b }`; `GET /api/arena/seasons`.

- [ ] **Step 1: Failing tests**

```ts
import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { seasonBounds, seasonIdOf } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeSeasons } from '../src/arena/seasons.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Arena api (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();
  const season = seasonIdOf(new Date());

  beforeAll(async () => {
    app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: null, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
      bearer: createDevBearerVerifier('daemonet-users'),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "ArenaMatch", "ArenaRating", "ArenaSeason", "BitsLedger", "Session", "Daemon", "Operator" CASCADE');
    bus.log.length = 0;
  });

  /** An operator with a name and, optionally, a rating row. */
  async function player(name: string, rating?: { rating: number; rd?: number; wins?: number; losses?: number; draws?: number; seasonId?: string }) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/arena/seasons', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    await prisma!.operator.update({ where: { id: op.id }, data: { name } });
    if (rating) {
      await prisma!.arenaRating.create({
        data: { operatorId: op.id, seasonId: rating.seasonId ?? season, rating: rating.rating, rd: rating.rd ?? 80, vol: 0.06, wins: rating.wins ?? 8, losses: rating.losses ?? 0, draws: rating.draws ?? 0 },
      });
    }
    const get = async (path: string) => {
      const r = await app.inject({ method: 'GET', url: `/api/arena${path}`, headers });
      return { status: r.statusCode, body: r.json() };
    };
    return { id: op.id, get, bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits) };
  }

  it('shows the caller’s standing, starting from the default or last season’s soft reset', async () => {
    const fresh = await player('fresh');
    expect((await fresh.get('/me')).body).toMatchObject({ season, rating: 1500, rd: 350, wins: 0, band: { min: 1400, payout: 2048 }, payoutEligible: false, matchesForPayout: 8, rewardedWinsToday: 0, dailyWins: 16, winBits: 32 });

    const last = seasonIdOf(new Date(seasonBounds(season).startsAt.getTime() - 86_400_000));
    const veteran = await player('veteran', { rating: 1900, seasonId: last });
    expect((await veteran.get('/me')).body).toMatchObject({ rating: 1700, rd: 200, wins: 0, band: { min: 1600, payout: 4096 } });

    const active = await player('active', { rating: 1812.5, wins: 6, losses: 3, draws: 1 });
    await prisma!.bitsLedger.createMany({ data: [1, 2, 3].map((i) => ({ operatorId: active.id, delta: 32n, reason: 'arena', ref: `m${i}` })) });
    await prisma!.bitsLedger.create({ data: { operatorId: active.id, delta: 32n, reason: 'arena', ref: 'old', at: new Date(Date.now() - 2 * 86_400_000) } });
    expect((await active.get('/me')).body).toMatchObject({ rating: 1812.5, wins: 6, losses: 3, draws: 1, band: { min: 1800, payout: 8192 }, payoutEligible: true, rewardedWinsToday: 3 });
    expect((await app.inject({ method: 'GET', url: '/api/arena/me' })).statusCode).toBe(401);
  });

  it('ranks the ladder by rating among operators with 8 matches, in pages of 32', async () => {
    const top = await player('top', { rating: 2100 });
    await player('mid', { rating: 1650, wins: 4, losses: 4 });
    await player('new', { rating: 2400, wins: 7 }); // not enough matches yet
    for (let i = 0; i < 33; i++) await player(`p${i}`, { rating: 1000 + i });
    const first = (await top.get('/ladder')).body;
    expect(first.rows).toHaveLength(32);
    expect(first.rows.slice(0, 3)).toMatchObject([{ rank: 1, name: 'top', rating: 2100, wins: 8 }, { rank: 2, name: 'mid' }, { rank: 3, name: 'p32', rating: 1032 }]);
    expect(first.next).toBe(32);
    const second = (await top.get(`/ladder?cursor=${first.next}`)).body;
    expect(second.rows.map((r: { rank: number; name: string }) => [r.rank, r.name])).toEqual([[33, 'p2'], [34, 'p1'], [35, 'p0']]);
    expect(second.next).toBeNull();
    expect((await top.get('/ladder?season=1999-01')).body).toMatchObject({ season: '1999-01', rows: [] });
    expect((await top.get('/ladder?season=soon')).status).toBe(400);
  });

  it('lists matches, mine by default', async () => {
    const a = await player('alice');
    const b = await player('bob');
    const c = await player('carol');
    const row = (id: string, aId: string, bId: string, minutesAgo: number) => ({
      id, seasonId: season, mode: 'ranked', aId, bId, winnerId: aId, reason: 'wipeout', aBefore: 1500, aAfter: 1620, bBefore: 1500, bAfter: 1380, aReward: 32, counted: true, durationMs: 90_000, endedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await prisma!.arenaMatch.createMany({ data: [row('m1', a.id, b.id, 30), row('m2', b.id, c.id, 20), row('m3', c.id, a.id, 10)] });
    const mine = (await a.get('/matches')).body;
    expect(mine.map((m: { id: string }) => m.id)).toEqual(['m3', 'm1']);
    expect(mine[1]).toMatchObject({ mode: 'ranked', reason: 'wipeout', counted: true, winnerId: a.id, a: { id: a.id, name: 'alice', before: 1500, after: 1620, reward: 32 }, b: { name: 'bob', after: 1380, reward: 0 } });
    expect((await a.get('/matches?mine=0')).body.map((m: { id: string }) => m.id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('closes a finished season once: band payouts for 8+ matches, soft-reset rows, bus pushes', async () => {
    const rich = await player('rich', { rating: 2050, seasonId: '2026-09' });
    const mid = await player('mid', { rating: 1500, seasonId: '2026-09', wins: 3, losses: 5 });
    const casual = await player('casual', { rating: 1900, seasonId: '2026-09', wins: 7 });
    const early = await player('early', { rating: 1300, rd: 260, seasonId: '2026-09' });
    // `early` already played in October: its new row must survive the close
    await prisma!.arenaRating.create({ data: { operatorId: early.id, seasonId: '2026-10', rating: 1444, rd: 150, vol: 0.06, wins: 1 } });
    const sept = seasonBounds('2026-09');
    await prisma!.arenaSeason.create({ data: { id: '2026-09', startsAt: sept.startsAt, endsAt: sept.endsAt } });

    expect(await closeSeasons(prisma!, bus, new Date('2026-09-30T23:59:59Z'))).toBe(0);
    const now = new Date('2026-10-01T00:00:05Z');
    expect(await closeSeasons(prisma!, bus, now)).toBe(1);
    expect(await closeSeasons(prisma!, bus, now)).toBe(0);

    expect([await rich.bits(), await mid.bits(), await casual.bits(), await early.bits()]).toEqual([16384, 2048, 0, 1024]);
    expect(await prisma!.bitsLedger.findMany({ where: { reason: 'arena:season' }, orderBy: { delta: 'desc' }, select: { operatorId: true, delta: true, ref: true } })).toEqual([
      { operatorId: rich.id, delta: 16384n, ref: '2026-09' },
      { operatorId: mid.id, delta: 2048n, ref: '2026-09' },
      { operatorId: early.id, delta: 1024n, ref: '2026-09' },
    ]);
    expect(bus.log.filter((m) => m.channel === 'admin').map((m) => m.message)).toEqual(
      expect.arrayContaining([{ kind: 'bits', operatorId: rich.id, delta: 16384, reason: 'arena:season', balance: 16384 }]),
    );
    expect(bus.log).toHaveLength(3);
    const next = Object.fromEntries((await prisma!.arenaRating.findMany({ where: { seasonId: '2026-10' } })).map((r) => [r.operatorId, r]));
    expect(next[rich.id]).toMatchObject({ rating: 1775, rd: 200, wins: 0, losses: 0 });
    expect(next[casual.id]).toMatchObject({ rating: 1700, rd: 200 });
    expect(next[early.id]).toMatchObject({ rating: 1444, rd: 150, wins: 1 });
    expect((await rich.get('/seasons')).body).toMatchObject([{ id: '2026-10', closedAt: null }, { id: '2026-09', closedAt: now.toISOString() }]);
  });
});
```

- [ ] **Step 2: Season close**

```ts
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { ARENA_SEASON_MIN_MATCHES, arenaBand, seasonBounds, softReset } from '@daemonet/rules';

/**
 * Closes every season whose month is over (SP6 spec §6): pays the rating-band reward to operators with enough
 * ranked matches, and opens the next season with soft-reset ratings. Claiming `closedAt` first makes it
 * idempotent; a rating row the sim already created for the new season is left alone.
 */
export async function closeSeasons(prisma: PrismaClient, bus: Bus, now = new Date()): Promise<number> {
  const due = await prisma.arenaSeason.findMany({ where: { closedAt: null, endsAt: { lte: now } }, orderBy: { endsAt: 'asc' } });
  let closed = 0;
  for (const season of due) {
    const paid = await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.arenaSeason.updateMany({ where: { id: season.id, closedAt: null }, data: { closedAt: now } });
        if (claimed.count !== 1) return null;
        const { next } = seasonBounds(season.id);
        const bounds = seasonBounds(next);
        await tx.arenaSeason.upsert({ where: { id: next }, create: { id: next, startsAt: bounds.startsAt, endsAt: bounds.endsAt }, update: {} });
        const payouts: Array<{ operatorId: string; payout: number; balance: number }> = [];
        for (const r of await tx.arenaRating.findMany({ where: { seasonId: season.id } })) {
          await tx.arenaRating.createMany({ data: [{ operatorId: r.operatorId, seasonId: next, ...softReset(r) }], skipDuplicates: true });
          if (r.wins + r.losses + r.draws < ARENA_SEASON_MIN_MATCHES) continue;
          const payout = arenaBand(r.rating).payout;
          const op = await tx.operator.update({ where: { id: r.operatorId }, data: { bits: { increment: BigInt(payout) } }, select: { bits: true } });
          await tx.bitsLedger.create({ data: { operatorId: r.operatorId, delta: BigInt(payout), reason: 'arena:season', ref: season.id } });
          payouts.push({ operatorId: r.operatorId, payout, balance: Number(op.bits) });
        }
        return payouts;
      },
      { timeout: 60_000 },
    );
    if (!paid) continue;
    closed++;
    for (const p of paid) await bus.publish('admin', { kind: 'bits', operatorId: p.operatorId, delta: p.payout, reason: 'arena:season', balance: p.balance });
  }
  return closed;
}
```

- [ ] **Step 3: Routes and the timer**

```ts
import type { PrismaClient } from '@daemonet/db';
import { ARENA_DAILY_WINS, ARENA_SEASON_MIN_MATCHES, ARENA_WIN_BITS, arenaBand, previousSeasonId, seasonBounds, seasonIdOf, seedRating } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';

const LADDER_PAGE = 32;
const LadderQuery = z.object({ season: z.string().regex(/^\d{4}-\d{2}$/).optional(), cursor: z.coerce.number().int().min(0).max(100_000).optional() });
const MatchesQuery = z.object({ mine: z.enum(['0', '1']).optional() });

/** Arena ratings, ladder, history and seasons (SP6 spec §6). Matches themselves are played in the sim. */
export function registerArenaRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth };

  const names = async (ids: string[]) => {
    const unique = [...new Set(ids)];
    const [ops, members] = await Promise.all([
      prisma.operator.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }),
      prisma.orgMember.findMany({ where: { operatorId: { in: unique } }, select: { operatorId: true, org: { select: { tag: true } } } }),
    ]);
    const tags = new Map(members.map((m) => [m.operatorId, m.org.tag]));
    return new Map(ops.map((o) => [o.id, { name: o.name, tag: tags.get(o.id) ?? null }]));
  };

  /** The caller's standing this season. Before the first ranked match it shows what the first match will start from. */
  app.get('/api/arena/me', auth, async (req) => {
    const operatorId = req.operator!.id;
    const now = new Date();
    const season = seasonIdOf(now);
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [row, previous, rewardedWinsToday] = await Promise.all([
      prisma.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId: season } } }),
      prisma.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId, seasonId: previousSeasonId(season) } } }),
      prisma.bitsLedger.count({ where: { operatorId, reason: 'arena', at: { gte: dayStart } } }),
    ]);
    const r = row ?? { ...seedRating(previous), wins: 0, losses: 0, draws: 0 };
    const matches = r.wins + r.losses + r.draws;
    return {
      season,
      seasonEndsAt: seasonBounds(season).endsAt,
      rating: r.rating,
      rd: r.rd,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      band: arenaBand(r.rating),
      payoutEligible: matches >= ARENA_SEASON_MIN_MATCHES,
      matchesForPayout: ARENA_SEASON_MIN_MATCHES,
      rewardedWinsToday,
      dailyWins: ARENA_DAILY_WINS,
      winBits: ARENA_WIN_BITS,
    };
  });

  /** Top ratings of a season among operators with enough ranked matches; `cursor` is the offset of the next page. */
  app.get('/api/arena/ladder', auth, async (req) => {
    const q = LadderQuery.safeParse(req.query);
    if (!q.success) throw badRequest('season must be YYYY-MM');
    const season = q.data.season ?? seasonIdOf(new Date());
    const offset = q.data.cursor ?? 0;
    // the match-count filter needs a sum of columns: raw SQL, ids only, then a normal fetch
    const ids = await prisma.$queryRaw<Array<{ operatorId: string }>>`
      SELECT "operatorId" FROM "ArenaRating"
      WHERE "seasonId" = ${season} AND "wins" + "losses" + "draws" >= ${ARENA_SEASON_MIN_MATCHES}
      ORDER BY "rating" DESC, "operatorId" ASC
      LIMIT ${LADDER_PAGE + 1} OFFSET ${offset}`;
    const page = ids.slice(0, LADDER_PAGE).map((r) => r.operatorId);
    const rows = new Map((await prisma.arenaRating.findMany({ where: { seasonId: season, operatorId: { in: page } } })).map((r) => [r.operatorId, r]));
    const who = await names(page);
    return {
      season,
      rows: page.map((id, i) => {
        const r = rows.get(id)!;
        return { rank: offset + i + 1, operatorId: id, name: who.get(id)?.name ?? null, tag: who.get(id)?.tag ?? null, rating: r.rating, rd: r.rd, wins: r.wins, losses: r.losses, draws: r.draws };
      }),
      next: ids.length > LADDER_PAGE ? offset + LADDER_PAGE : null,
    };
  });

  /** The last 32 matches: the caller's (`mine=1`, the default) or everyone's. */
  app.get('/api/arena/matches', auth, async (req) => {
    const q = MatchesQuery.safeParse(req.query);
    if (!q.success) throw badRequest('mine must be 0 or 1');
    const me = req.operator!.id;
    const rows = await prisma.arenaMatch.findMany({ where: q.data.mine === '0' ? {} : { OR: [{ aId: me }, { bId: me }] }, orderBy: { endedAt: 'desc' }, take: 32 });
    const who = await names(rows.flatMap((r) => [r.aId, r.bId]));
    return rows.map((r) => ({
      id: r.id,
      season: r.seasonId,
      mode: r.mode,
      reason: r.reason,
      counted: r.counted,
      durationMs: r.durationMs,
      endedAt: r.endedAt,
      winnerId: r.winnerId,
      a: { id: r.aId, name: who.get(r.aId)?.name ?? null, before: r.aBefore, after: r.aAfter, reward: r.aReward },
      b: { id: r.bId, name: who.get(r.bId)?.name ?? null, before: r.bBefore, after: r.bAfter, reward: r.bReward },
    }));
  });

  app.get('/api/arena/seasons', auth, async () => prisma.arenaSeason.findMany({ orderBy: { startsAt: 'desc' }, take: 24 }));
}
```

`apps/api/src/app.ts`: `registerArenaRoutes(app, o.prisma);` after the Exchange routes. `apps/api/src/server.ts` (import `closeSeasons`; clear `seasonTimer` in `shutdown`):

```ts
// arena seasons end with the UTC month; the sweep is idempotent, so a frequent check is fine
const seasons = () => closeSeasons(prisma, bus).then((n) => n > 0 && app.log.info({ closed: n }, 'closed arena seasons')).catch((err: Error) => app.log.error({ err: err.message }, 'arena season close failed'));
const seasonTimer = setInterval(seasons, 5 * 60_000);
void seasons();
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 55 files, 427 tests. `playwright test` — 4 passed.

```bash
git add apps/api
git commit -m "feat(api): arena standings, ladder, history, seasons with band payouts and soft reset"
```

---

## Self-review

- **Spec coverage:** §6 `glicko2.ts` with `rate` and `decayRd` tested against the paper's example, symmetry and RD behaviour; the three tables; one transaction for ratings, match row, capped per-win bits and `arenaWins` on the winner's daemons that dealt damage; season close on an api timer, idempotent per season, with ledger rows, bus `bits` pushes, soft-reset rows and `closedAt`; all four endpoints (ladder with the 8-match minimum). §3 rewards, seasons and the win-trading rule (now authoritative in the store; plan 1's in-memory count only decides whether a pairing is played normalised). §8 store / api tests. Deviations are listed at the top. The client is plan 3.
- **Type consistency:** `ArenaResultInput.reason` ↔ `ArenaState.result.reason`; `ArenaSettlement` is produced by both stores and consumed only by `ArenaService.announce`; `settleArena`'s context field names are the same in both stores.
- **Placeholders:** none.
