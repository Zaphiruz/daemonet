import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { ITEMS, isTradable } from '@daemonet/rules';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound, rateLimited } from '../errors.js';
import { MAX_PRICE, MAX_QTY, bookFor, cancelOrder, placeOrder } from '../exchange/orders.js';

/** Exchange request budget (SP5 spec): per operator, and separately per client IP. */
export const EXCHANGE_RATE = { max: 120, timeWindow: '1 minute' } as const;

const OrderBody = z.object({
  item: z.string().min(1).max(64),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().int().min(1).max(MAX_PRICE),
  qty: z.number().int().min(1).max(MAX_QTY),
});

/** How many closed (filled, cancelled, expired) orders `GET /api/exchange/orders` returns; open ones are never cut. */
export const CLOSED_ORDERS_SHOWN = 64;
const OrdersQuery = z.object({ status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED']).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Exchange (SP5): the vault view and the order book; listings and trades are added by plans 3–4. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  // Two budgets, each shared by every Exchange route: per client IP in onRequest, before authentication, so refused
  // tokens count too (it throttles guessing); per operator after requireAuth, so one operator cannot exceed the budget
  // by spreading requests over several addresses. (The plugin's per-route limit is off here: its local store keeps one
  // counter per route, so it could not share a budget across routes.) Without the rate-limit plugin (tests) only auth
  // applies.
  const limiter = (keyGenerator: (req: FastifyRequest) => string) => {
    const limit = app.hasDecorator('createRateLimit') ? app.createRateLimit({ ...EXCHANGE_RATE, keyGenerator }) : null;
    return async (req: FastifyRequest): Promise<void> => {
      if (!limit) return;
      const r = await limit(req);
      if (!r.isAllowed && r.isExceeded) throw rateLimited();
    };
  };
  const perIp = limiter((req) => `exchange-ip:${req.ip}`);
  const perOperator = limiter((req) => (req.operator ? `exchange-op:${req.operator.id}` : `exchange-ip:${req.ip}`));
  const auth = { onRequest: perIp, preHandler: [app.requireAuth, perOperator], config: { bearer: true, rateLimit: false as const } };
  const log = app.log;

  /** The caller's own Exchange vault: `{ item: qty }`. */
  app.get('/api/exchange/vault', auth, async (req) => {
    const rows = await prisma.exchangeVault.findMany({ where: { operatorId: req.operator!.id }, orderBy: { item: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.item, r.qty]));
  });

  /** Every tradable item with its best bid and ask. */
  app.get('/api/exchange/items', auth, async () => {
    const open = await prisma.order.groupBy({ by: ['item', 'side'], where: { status: 'OPEN', expiresAt: { gt: new Date() } }, _max: { price: true }, _min: { price: true } });
    const best = new Map<string, { bid: number | null; ask: number | null }>();
    for (const g of open) {
      const row = best.get(g.item) ?? { bid: null, ask: null };
      if (g.side === 'BUY') row.bid = g._max.price;
      else row.ask = g._min.price;
      best.set(g.item, row);
    }
    return ITEMS.filter((i) => isTradable(i.id)).map((i) => ({ id: i.id, name: i.name, kind: i.kind, bid: best.get(i.id)?.bid ?? null, ask: best.get(i.id)?.ask ?? null }));
  });

  app.get<{ Params: { item: string } }>('/api/exchange/book/:item', auth, async (req) => {
    if (!isTradable(req.params.item)) throw badRequest('unknown item');
    return bookFor(prisma, req.params.item);
  });

  /**
   * The caller's orders, newest first: every OPEN one (bounded by the open-order cap plus any not yet swept by expiry),
   * then the CLOSED_ORDERS_SHOWN most recent closed ones. `?status=` narrows it to one status (closed ones still capped).
   */
  app.get<{ Querystring: unknown }>('/api/exchange/orders', auth, async (req) => {
    const { status } = parse(OrdersQuery, req.query);
    const operatorId = req.operator!.id;
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const open = status === undefined || status === 'OPEN' ? await prisma.order.findMany({ where: { operatorId, status: 'OPEN' }, orderBy }) : [];
    const closed =
      status === 'OPEN'
        ? []
        : await prisma.order.findMany({ where: { operatorId, status: status ?? { not: 'OPEN' } }, orderBy, take: CLOSED_ORDERS_SHOWN });
    const rows = [...open, ...closed].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return rows.map((o) => ({ id: o.id, item: o.item, side: o.side, price: o.price, qty: o.qty, remaining: o.remaining, status: o.status, createdAt: o.createdAt, expiresAt: o.expiresAt }));
  });

  app.post('/api/exchange/orders', auth, async (req) => {
    const body = parse(OrderBody, req.body);
    if (!isTradable(body.item)) throw badRequest('unknown item');
    const { order, fills } = await placeOrder(prisma, bus, req.operator!.id, body, new Date(), log);
    return {
      order: { id: order.id, item: order.item, side: order.side, price: order.price, qty: order.qty, remaining: order.remaining, status: order.status, expiresAt: order.expiresAt },
      fills: fills.map((f) => ({ price: f.price, qty: f.qty, fee: f.fee })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/exchange/orders/:id', auth, async (req) => {
    if (req.params.id.length > 64) throw notFound('no such order');
    await cancelOrder(prisma, bus, req.operator!.id, req.params.id, log);
    return { ok: true };
  });
}
