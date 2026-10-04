import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rateLimited } from '../errors.js';

/** Exchange request budget (SP5 spec): per operator, and separately per client IP. */
export const EXCHANGE_RATE = { max: 120, timeWindow: '1 minute' } as const;

/** Exchange (SP5). Plan 1: the vault view; orders, listings and trades are added by plans 2–4. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, _bus: Bus): void {
  // Two budgets: the route's onRequest limit is per client IP and runs before authentication, so refused tokens count
  // too (it throttles guessing); the preHandler limit after requireAuth is per operator, so one operator cannot exceed
  // the budget by spreading requests over several addresses. Without the rate-limit plugin (tests) only auth applies.
  const perOperator = app.hasDecorator('createRateLimit')
    ? app.createRateLimit({ ...EXCHANGE_RATE, keyGenerator: (req: FastifyRequest) => (req.operator ? `op:${req.operator.id}` : `ip:${req.ip}`) })
    : null;
  const operatorLimit = async (req: FastifyRequest): Promise<void> => {
    if (!perOperator) return;
    const r = await perOperator(req);
    if (!r.isAllowed && r.isExceeded) throw rateLimited();
  };
  const auth = { preHandler: [app.requireAuth, operatorLimit], config: { bearer: true, rateLimit: { ...EXCHANGE_RATE } } };

  /** The caller's own Exchange vault: `{ item: qty }`. */
  app.get('/api/exchange/vault', auth, async (req) => {
    const rows = await prisma.exchangeVault.findMany({ where: { operatorId: req.operator!.id }, orderBy: { item: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.item, r.qty]));
  });
}
