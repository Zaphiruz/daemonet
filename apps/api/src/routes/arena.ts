import type { PrismaClient } from '@daemonet/db';
import { ARENA_DAILY_WINS, ARENA_SEASON_MIN_MATCHES, ARENA_WIN_BITS, arenaBand, previousSeasonId, seasonBounds, seasonIdOf, seedRating } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';

const LADDER_PAGE = 32;
const MATCHES_PAGE = 32;
const LadderQuery = z.object({ season: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), cursor: z.coerce.number().int().min(0).max(100_000).optional() });
const MatchesQuery = z.object({ mine: z.enum(['0', '1']).optional() });

/**
 * Arena ratings, ladder, history and seasons (SP6 spec §6). Matches themselves are played in the sim. All four are
 * read-only, so bots may read them with a bearer token too (as `/api/disk`); the ladder and match history show what the
 * Arena tab shows every player: operator ids (to challenge), names, org tags and ratings.
 */
export function registerArenaRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth, config: { bearer: true } };

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

  /** Top ratings of a season among operators with enough counted matches; `cursor` is the offset of the next page. */
  app.get('/api/arena/ladder', auth, async (req) => {
    const q = LadderQuery.safeParse(req.query);
    if (!q.success) throw badRequest('season must be YYYY-MM and cursor a page offset');
    const season = q.data.season ?? seasonIdOf(new Date());
    const offset = q.data.cursor ?? 0;
    // the match-count filter needs a sum of columns: raw SQL, ids only, then a normal fetch
    const ids = await prisma.$queryRaw<Array<{ operatorId: string }>>`
      SELECT "operatorId" FROM "ArenaRating"
      WHERE "seasonId" = ${season} AND "wins" + "losses" + "draws" >= ${ARENA_SEASON_MIN_MATCHES}
      ORDER BY "rating" DESC, "operatorId" ASC
      LIMIT ${LADDER_PAGE + 1} OFFSET ${offset}`;
    const page = ids.slice(0, LADDER_PAGE).map((r) => r.operatorId);
    const [ratings, who] = await Promise.all([prisma.arenaRating.findMany({ where: { seasonId: season, operatorId: { in: page } } }), names(page)]);
    const rows = new Map(ratings.map((r) => [r.operatorId, r]));
    return {
      season,
      rows: page.flatMap((id, i) => {
        const r = rows.get(id);
        if (!r) return [];
        return [{ rank: offset + i + 1, operatorId: id, name: who.get(id)?.name ?? null, tag: who.get(id)?.tag ?? null, rating: r.rating, rd: r.rd, wins: r.wins, losses: r.losses, draws: r.draws }];
      }),
      next: ids.length > LADDER_PAGE ? offset + LADDER_PAGE : null,
    };
  });

  /** The last 32 matches: the caller's (`mine=1`, the default) or everyone's. */
  app.get('/api/arena/matches', auth, async (req) => {
    const q = MatchesQuery.safeParse(req.query);
    if (!q.success) throw badRequest('mine must be 0 or 1');
    const me = req.operator!.id;
    const rows = await prisma.arenaMatch.findMany({
      where: q.data.mine === '0' ? {} : { OR: [{ aId: me }, { bId: me }] },
      orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
      take: MATCHES_PAGE,
    });
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

  /** The last 24 seasons, newest first (`closedAt` null = still open, or closing within the hour after its end). */
  app.get('/api/arena/seasons', auth, async () =>
    prisma.arenaSeason.findMany({ select: { id: true, startsAt: true, endsAt: true, closedAt: true }, orderBy: { startsAt: 'desc' }, take: 24 }),
  );
}
