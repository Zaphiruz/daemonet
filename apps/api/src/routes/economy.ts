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

  /** Total supply and, per day for the last ECONOMY_DAYS days, bits created / destroyed and the split by reason. */
  app.get('/api/admin/economy', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const [supply, operators] = await Promise.all([prisma.operator.aggregate({ _sum: { bits: true } }), prisma.operator.count()]);
    const since = new Date(Date.now() - ECONOMY_DAYS * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await prisma.bitsLedger.findMany({ where: { at: { gte: since } }, select: { delta: true, reason: true, at: true } });
    const days = new Map<string, { day: string; created: number; destroyed: number; byReason: Record<string, number> }>();
    for (const r of rows) {
      const day = r.at.toISOString().slice(0, 10);
      let d = days.get(day);
      if (!d) days.set(day, (d = { day, created: 0, destroyed: 0, byReason: {} }));
      const delta = Number(r.delta);
      if (delta >= 0) d.created += delta;
      else d.destroyed -= delta;
      d.byReason[r.reason] = (d.byReason[r.reason] ?? 0) + delta;
    }
    return { supply: Number(supply._sum.bits ?? 0), operators, days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  });
}
