import type { PrismaClient } from '@daemonet/db';
import { RECIPES, SHOP, diskExpansionPrice } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';

export const ECONOMY_DAYS = 14;
export const LEDGER_ROWS = 64;

/** Shop, recipes, the caller's ledger, and the admin economy view (SP3b spec §5, design §10 "Economy"). */
export function registerEconomyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/api/shop', auth, async (req) => {
    const op = await prisma.operator.findUniqueOrThrow({ where: { id: req.operator!.id }, select: { bits: true, diskCapacity: true } });
    return { prices: SHOP, bits: Number(op.bits), diskCapacity: op.diskCapacity, diskExpansionPrice: diskExpansionPrice(op.diskCapacity) };
  });

  app.get('/api/recipes', auth, async () => RECIPES);

  /** Newest first by `seq` (timestamps can tie inside one transaction batch). */
  app.get('/api/ledger', auth, async (req) => {
    const rows = await prisma.bitsLedger.findMany({ where: { operatorId: req.operator!.id }, orderBy: { seq: 'desc' }, take: LEDGER_ROWS });
    return rows.map((r) => ({ delta: Number(r.delta), reason: r.reason, ref: r.ref, at: r.at }));
  });

  /**
   * Total supply, the all-time ledger sum and their difference (`drift`, 0 unless a balance changed without a ledger
   * row), and, per day for the last ECONOMY_DAYS days, bits created / destroyed and the split by reason. Everything is
   * read in one REPEATABLE READ transaction (one snapshot, so concurrent intents cannot show up as drift), and the days
   * are aggregated in the database.
   */
  app.get('/api/admin/economy', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const since = new Date(Date.now() - ECONOMY_DAYS * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const { supply, ledgerSum, operators, rows } = await prisma.$transaction(
      async (tx) => {
        const supply = await tx.operator.aggregate({ _sum: { bits: true } });
        const ledgerSum = await tx.bitsLedger.aggregate({ _sum: { delta: true } });
        const operators = await tx.operator.count();
        // "at" is a UTC timestamp without time zone (as Prisma writes it).
        const rows = await tx.$queryRaw<Array<{ day: string; reason: string; created: bigint; destroyed: bigint; net: bigint }>>`
          SELECT to_char("at", 'YYYY-MM-DD') AS "day", "reason",
                 COALESCE(SUM("delta") FILTER (WHERE "delta" >= 0), 0)::bigint AS "created",
                 COALESCE(-SUM("delta") FILTER (WHERE "delta" < 0), 0)::bigint AS "destroyed",
                 SUM("delta")::bigint AS "net"
          FROM "BitsLedger"
          WHERE "at" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          GROUP BY 1, 2`;
        return { supply: Number(supply._sum.bits ?? 0), ledgerSum: Number(ledgerSum._sum.delta ?? 0), operators, rows };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    const days = new Map<string, { day: string; created: number; destroyed: number; byReason: Record<string, number> }>();
    for (const r of rows) {
      let d = days.get(r.day);
      if (!d) days.set(r.day, (d = { day: r.day, created: 0, destroyed: 0, byReason: {} }));
      d.created += Number(r.created);
      d.destroyed += Number(r.destroyed);
      d.byReason[r.reason] = Number(r.net);
    }
    return { supply, ledgerSum, drift: supply - ledgerSum, operators, days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  });
}
