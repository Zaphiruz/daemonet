import { consoleBusLogger, type Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { ARENA_SEASON_MIN_MATCHES, arenaBand, seasonBounds, softReset } from '@daemonet/rules';
import type { PublishLog } from '../publish.js';
import { Outbox, announce, credit, lockOperators } from '../exchange/ledger.js';

/**
 * The season payout's ledger reason (ref = season id). An api grant: not one of the sim's intent reasons
 * (SIM_LEDGER_REASONS), so the sim applies it as a delta from the bus push, or on its next resync if the push is lost.
 */
export const ARENA_SEASON_LEDGER_REASON = 'arena:season';

/**
 * A season is closed only this long after its UTC month ends: longer than any settlement retry (the sim retries an
 * unknown arena result for at most 10 minutes), so late results of the last matches still count before the payout.
 */
export const ARENA_SEASON_CLOSE_GRACE_MS = 3_600_000;

/** Every operator of a season can be paid in one transaction; give it room (the default interactive timeout is 5 s). */
const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * Closes every season whose month ended more than ARENA_SEASON_CLOSE_GRACE_MS ago (SP6 spec §6): pays the rating-band
 * reward to operators with at least ARENA_SEASON_MIN_MATCHES counted matches, and opens the next season with
 * soft-reset ratings for everyone who played a counted match. Returns the number of seasons this call closed.
 *
 * Exactly once per (season, operator), also when two api processes sweep at once or a sweep crashed: everything happens
 * in one transaction whose guarded `closedAt` flip lets only one sweep through (a concurrent one waits on the row,
 * then finds it closed and rolls back). Lock order (#30/#32): every Operator row with a counted match is locked first,
 * sorted, then the season row; the sim's `recordArenaResult` reads `closedAt` under its operator locks, so a result
 * that waited for this close records uncounted. A rating row the sim already created for the new season is kept.
 */
export async function closeSeasons(prisma: PrismaClient, bus: Bus, now = new Date(), log: PublishLog = consoleBusLogger): Promise<number> {
  const due = await prisma.arenaSeason.findMany({
    where: { closedAt: null, endsAt: { lte: new Date(now.getTime() - ARENA_SEASON_CLOSE_GRACE_MS) } },
    orderBy: { endsAt: 'asc' },
  });
  let closed = 0;
  for (const season of due) {
    const out = await prisma.$transaction(async (tx) => {
      const played = async () =>
        tx.$queryRaw<Array<{ operatorId: string; rating: number; rd: number; vol: number; matches: number }>>`
          SELECT "operatorId", "rating", "rd", "vol", ("wins" + "losses" + "draws")::int AS "matches" FROM "ArenaRating"
          WHERE "seasonId" = ${season.id} AND "wins" + "losses" + "draws" > 0
          ORDER BY "operatorId"`;
      const locked = new Set((await played()).map((r) => r.operatorId));
      await lockOperators(tx, [...locked]);
      const claimed = await tx.arenaSeason.updateMany({ where: { id: season.id, closedAt: null }, data: { closedAt: now } });
      if (claimed.count !== 1) return null;
      const { next } = seasonBounds(season.id);
      const bounds = seasonBounds(next);
      // ON CONFLICT DO NOTHING: the sim may have opened the new season (and rated its first matches) already.
      await tx.arenaSeason.createMany({ data: [{ id: next, startsAt: bounds.startsAt, endsAt: bounds.endsAt }], skipDuplicates: true });
      // Read again under the locks: the records are final now (a result that had not taken its locks yet sees closedAt).
      const rows = await played();
      // A first counted match committed between the two reads: lock its operator too before writing its ledger row.
      const late = rows.map((r) => r.operatorId).filter((id) => !locked.has(id));
      if (late.length > 0) await lockOperators(tx, late);
      if (rows.length > 0) {
        await tx.arenaRating.createMany({ data: rows.map((r) => ({ operatorId: r.operatorId, seasonId: next, ...softReset(r) })), skipDuplicates: true });
      }
      const box = new Outbox();
      for (const r of rows) {
        if (r.matches < ARENA_SEASON_MIN_MATCHES) continue;
        await credit(tx, box, r.operatorId, arenaBand(r.rating).payout, ARENA_SEASON_LEDGER_REASON, season.id);
      }
      return box;
    }, TX_OPTIONS);
    if (!out) continue;
    closed++;
    announce(bus, log, out);
  }
  return closed;
}
