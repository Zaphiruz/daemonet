import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';

/** Exchange (SP5). Plan 1: the vault view; orders, listings and trades are added by plans 2–4. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, _bus: Bus): void {
  // Per client IP (the limiter runs before authentication, so refused bearer tokens count too).
  const auth = { preHandler: app.requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /** The caller's own Exchange vault: `{ item: qty }`. */
  app.get('/api/exchange/vault', auth, async (req) => {
    const rows = await prisma.exchangeVault.findMany({ where: { operatorId: req.operator!.id }, orderBy: { item: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.item, r.qty]));
  });
}
