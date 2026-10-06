import { describe, expect, it } from 'vitest';
import {
  ARENA_BANDS,
  ARENA_DAILY_WINS,
  ARENA_PAIR_DAILY_CAP,
  ARENA_SEASON_MIN_MATCHES,
  ARENA_WIN_BITS,
  GLICKO_START,
  GLICKO_TAU,
  arenaBand,
  decayRd,
  previousSeasonId,
  rate,
  rateGames,
  seasonBounds,
  seasonIdOf,
  seedRating,
  settleArena,
  settleMatch,
  softReset,
} from '../src/index.js';

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

  it('stays finite when the expected score saturates (an extreme rating gap)', () => {
    const finite = (r: { rating: number; rd: number; vol: number }) => [r.rating, r.rd, r.vol].every(Number.isFinite);
    const top = { rating: 9000, rd: 30, vol: 0.06 };
    const bottom = { rating: -9000, rd: 30, vol: 0.06 };
    const settled = { rating: 1500, rd: 30, vol: 0.06 };
    for (const score of [0, 0.5, 1]) {
      for (const [p, o] of [[top, settled], [settled, top], [top, GLICKO_START], [GLICKO_START, top], [top, bottom], [bottom, top], [{ ...top, rd: 350 }, { ...bottom, rd: 30 }], [settled, { rating: 1500, rd: 1e9 }]] as const) {
        const after = rate(p, o, score);
        expect(finite(after), JSON.stringify({ p, o, score, after })).toBe(true);
        expect(after.rd).toBeLessThanOrEqual(350);
      }
    }
    // the expectation is exactly 1: nothing to learn from the game, the deviation only decays
    expect(rate(top, settled, 1)).toEqual(decayRd(top, 1));
  });

  it('uses the plan constants', () => {
    expect(GLICKO_START).toEqual({ rating: 1500, rd: 350, vol: 0.06 });
    expect(GLICKO_TAU).toBe(0.5);
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

  it('is deterministic and does not mutate its inputs', () => {
    const p = Object.freeze({ rating: 1612, rd: 120, vol: 0.057 });
    const o = Object.freeze({ rating: 1580, rd: 90 });
    expect(rate(p, o, 1)).toEqual(rate(p, o, 1));
    expect(decayRd(p, 3)).toEqual(decayRd(p, 3));
  });
});

describe('arena seasons and rewards', () => {
  it('names seasons by UTC month and bounds them', () => {
    expect(seasonIdOf(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(seasonIdOf(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
    expect(seasonBounds('2026-12')).toEqual({ startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: new Date('2027-01-01T00:00:00Z'), next: '2027-01' });
    expect(previousSeasonId('2027-01')).toBe('2026-12');
    expect(previousSeasonId('2026-03')).toBe('2026-02');
  });

  it('pays by rating band and soft-resets towards 1500', () => {
    expect(ARENA_BANDS.map((b) => b.payout)).toEqual([1024, 2048, 4096, 8192, 16384]);
    expect([1399.9, 1400, 1599, 1600, 1800, 1999.5, 2000, 2600].map((r) => arenaBand(r).payout)).toEqual([1024, 2048, 2048, 4096, 8192, 8192, 16384, 16384]);
    expect(softReset({ rating: 1900, rd: 80, vol: 0.05 })).toEqual({ rating: 1700, rd: 200, vol: 0.05 });
    expect(softReset({ rating: 1300, rd: 260, vol: 0.06 })).toEqual({ rating: 1400, rd: 260, vol: 0.06 });
  });

  it('seeds a season from the previous rating or the default', () => {
    expect(seedRating(null)).toEqual(GLICKO_START);
    expect(seedRating(undefined)).toEqual(GLICKO_START);
    expect(seedRating(null)).not.toBe(GLICKO_START);
    expect(seedRating({ rating: 1900, rd: 80, vol: 0.05 })).toEqual({ rating: 1700, rd: 200, vol: 0.05 });
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
    expect(draw.a).toEqual(rate(a, b, 0.5)); // a draw is a 0.5 / 0.5 game
    expect(draw.b).toEqual(rate(b, a, 0.5));
  });

  it('pins the reward constants', () => {
    expect([ARENA_WIN_BITS, ARENA_DAILY_WINS, ARENA_SEASON_MIN_MATCHES]).toEqual([32, 16, 8]);
  });

  it('settles an arena match: only ranked matches under the pair cap count, wins pay up to the daily cap', () => {
    const a = { rating: 1500, rd: 200, vol: 0.06 };
    const b = { rating: 1700, rd: 100, vol: 0.06 };
    const ctx = { a, b, pairCountedToday: 0, winnerRewardedToday: 0 };
    const win = settleArena('ranked', 'a', ctx);
    expect(win).toEqual({ counted: true, ...settleMatch(a, b, 'a'), reward: ARENA_WIN_BITS });
    expect(settleArena('ranked', 'b', ctx).reward).toBe(ARENA_WIN_BITS);
    expect(settleArena('ranked', null, ctx)).toMatchObject({ counted: true, reward: 0 });
    expect(settleArena('ranked', 'a', { ...ctx, winnerRewardedToday: ARENA_DAILY_WINS - 1 }).reward).toBe(ARENA_WIN_BITS);
    expect(settleArena('ranked', 'a', { ...ctx, winnerRewardedToday: ARENA_DAILY_WINS })).toMatchObject({ counted: true, reward: 0 });
    expect(settleArena('ranked', 'a', { ...ctx, pairCountedToday: ARENA_PAIR_DAILY_CAP - 1 }).counted).toBe(true);
    expect(settleArena('ranked', 'a', { ...ctx, pairCountedToday: ARENA_PAIR_DAILY_CAP })).toEqual({ counted: false, a, b, reward: 0 });
    expect(settleArena('unranked', 'a', ctx)).toEqual({ counted: false, a, b, reward: 0 });
  });

  it('never counts a match that ended before going live (countdown forfeit)', () => {
    const a = { rating: 1500, rd: 200, vol: 0.06 };
    const b = { rating: 1700, rd: 100, vol: 0.06 };
    expect(settleArena('ranked', 'a', { a, b, pairCountedToday: 0, winnerRewardedToday: 0, live: false })).toEqual({ counted: false, a, b, reward: 0 });
  });
});
