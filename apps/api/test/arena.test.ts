import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { seasonBounds, seasonIdOf } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIM_LEDGER_REASONS } from '../../sim/src/runtime/store.js';
import { buildApp } from '../src/app.js';
import { ARENA_SEASON_LEDGER_REASON, closeSeasons } from '../src/arena/seasons.js';
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
      return { status: r.statusCode, body: r.json(), headers: r.headers };
    };
    return { id: op.id, get, bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits) };
  }

  /** The September season row and four players with September ratings (`early` already played in October). */
  async function september() {
    const rich = await player('rich', { rating: 2050, seasonId: '2026-09' });
    const mid = await player('mid', { rating: 1500, seasonId: '2026-09', wins: 3, losses: 5 });
    const casual = await player('casual', { rating: 1900, seasonId: '2026-09', wins: 7 });
    const early = await player('early', { rating: 1300, rd: 260, seasonId: '2026-09' });
    await prisma!.arenaRating.create({ data: { operatorId: early.id, seasonId: '2026-10', rating: 1444, rd: 150, vol: 0.06, wins: 1 } });
    const sept = seasonBounds('2026-09');
    await prisma!.arenaSeason.create({ data: { id: '2026-09', startsAt: sept.startsAt, endsAt: sept.endsAt } });
    return { rich, mid, casual, early };
  }

  it('shows the caller’s standing, starting from the default or last season’s soft reset', async () => {
    const fresh = await player('fresh');
    const me = await fresh.get('/me');
    expect(me.body).toMatchObject({ season, rating: 1500, rd: 350, wins: 0, band: { min: 1400, payout: 2048 }, payoutEligible: false, matchesForPayout: 8, rewardedWinsToday: 0, dailyWins: 16, winBits: 32 });
    expect(me.headers['cache-control']).toBe('private, no-store');

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
    await player('idle', { rating: 2500, wins: 0 }); // seeded by uncounted matches only
    for (let i = 0; i < 33; i++) await player(`p${i}`, { rating: 1000 + i });
    const first = (await top.get('/ladder')).body;
    expect(first.rows).toHaveLength(32);
    expect(first.rows.slice(0, 3)).toMatchObject([{ rank: 1, name: 'top', rating: 2100, wins: 8 }, { rank: 2, name: 'mid' }, { rank: 3, name: 'p32', rating: 1032 }]);
    expect(first.next).toBe(32);
    const second = (await top.get(`/ladder?cursor=${first.next}`)).body;
    expect(second.rows.map((r: { rank: number; name: string }) => [r.rank, r.name])).toEqual([[33, 'p2'], [34, 'p1'], [35, 'p0']]);
    expect(second.next).toBeNull();
    expect((await top.get('/ladder?season=1999-01')).body).toMatchObject({ season: '1999-01', rows: [] });
    const bad = await top.get('/ladder?season=soon');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'validation_error' });
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
    expect((await a.get('/matches?mine=yes')).status).toBe(400);
  });

  it('closes a finished season once, an hour after its end: band payouts for 8+ matches, soft-reset rows, bus pushes', async () => {
    const { rich, mid, casual, early } = await september();

    expect(await closeSeasons(prisma!, bus, new Date('2026-09-30T23:59:59Z'))).toBe(0);
    expect(await closeSeasons(prisma!, bus, new Date('2026-10-01T00:59:59Z'))).toBe(0); // settlements may still be retrying
    const now = new Date('2026-10-01T01:00:05Z');
    expect(await closeSeasons(prisma!, bus, now)).toBe(1);
    expect(await closeSeasons(prisma!, bus, now)).toBe(0);

    expect([await rich.bits(), await mid.bits(), await casual.bits(), await early.bits()]).toEqual([16384, 2048, 0, 1024]);
    const ledger = await prisma!.bitsLedger.findMany({ where: { reason: 'arena:season' }, orderBy: { delta: 'desc' }, select: { id: true, seq: true, operatorId: true, delta: true, ref: true } });
    expect(ledger.map(({ operatorId, delta, ref }) => ({ operatorId, delta, ref }))).toEqual([
      { operatorId: rich.id, delta: 16384n, ref: '2026-09' },
      { operatorId: mid.id, delta: 2048n, ref: '2026-09' },
      { operatorId: early.id, delta: 1024n, ref: '2026-09' },
    ]);
    // one BitsPush per ledger row (#30), so an online sim applies the delta once
    expect(bus.log.filter((m) => m.channel === 'admin').map((m) => m.message)).toEqual(
      expect.arrayContaining([{ kind: 'bits', operatorId: rich.id, ledgerId: ledger[0]!.id, seq: Number(ledger[0]!.seq), delta: 16384, reason: 'arena:season', balance: 16384, origin: 'api' }]),
    );
    expect(bus.log).toHaveLength(3);
    const next = Object.fromEntries((await prisma!.arenaRating.findMany({ where: { seasonId: '2026-10' } })).map((r) => [r.operatorId, r]));
    expect(next[rich.id]).toMatchObject({ rating: 1775, rd: 200, wins: 0, losses: 0 });
    expect(next[casual.id]).toMatchObject({ rating: 1700, rd: 200 });
    expect(next[early.id]).toMatchObject({ rating: 1444, rd: 150, wins: 1 });
    expect((await rich.get('/seasons')).body).toMatchObject([{ id: '2026-10', closedAt: null }, { id: '2026-09', closedAt: now.toISOString() }]);
    expect(SIM_LEDGER_REASONS.has(ARENA_SEASON_LEDGER_REASON)).toBe(false);
  });

  it('pays each operator once when two sweeps race, and skips rows without a counted match', async () => {
    const { rich } = await september();
    const idle = await player('idle', { rating: 2400, seasonId: '2026-09', wins: 0 }); // seeded by uncounted matches only
    const now = new Date('2026-10-01T02:00:00Z');
    const closed = await Promise.all([closeSeasons(prisma!, bus, now), closeSeasons(prisma!, bus, now), closeSeasons(prisma!, bus, now)]);
    expect(closed.reduce((s, n) => s + n, 0)).toBe(1);
    expect(await rich.bits()).toBe(16384);
    expect(await idle.bits()).toBe(0);
    expect(await prisma!.bitsLedger.count({ where: { reason: 'arena:season' } })).toBe(3);
    expect(bus.log).toHaveLength(3);
    expect(await prisma!.arenaRating.findUnique({ where: { operatorId_seasonId: { operatorId: idle.id, seasonId: '2026-10' } } })).toBeNull();
  });
});
