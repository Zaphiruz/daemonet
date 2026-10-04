import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { FEE_DIVISOR, ITEMS, isTradable } from '@daemonet/rules';
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound, rateLimited } from '../errors.js';
import { browseListings, buyListing, cancelListing, createListing, daemonView } from '../exchange/listings.js';
import { MAX_PRICE, MAX_QTY, bookFor, cancelOrder, placeOrder } from '../exchange/orders.js';
import { MAX_TRADE_BITS, MAX_TRADE_DAEMONS, cancelTrade, confirmTrade, listTrades, openTrade, setOffer, tradeViews } from '../exchange/trades.js';

/** Exchange request budget per operator (SP5 spec: 120 / minute), shared by every Exchange route. */
export const EXCHANGE_RATE = { max: 120, timeWindow: '1 minute' } as const;
/**
 * Per client address (IPv6 by /64), before authentication: several operators behind one address (NAT, a household)
 * share it, so it is a multiple of the per-operator budget; it still throttles token guessing.
 */
export const EXCHANGE_IP_RATE = { max: 4 * EXCHANGE_RATE.max, timeWindow: EXCHANGE_RATE.timeWindow } as const;

const OrderBody = z.object({
  item: z.string().min(1).max(64),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().int().min(1).max(MAX_PRICE),
  qty: z.number().int().min(1).max(MAX_QTY),
});

/** How many closed (filled, cancelled, expired) orders `GET /api/exchange/orders` returns; open ones are never cut. */
export const CLOSED_ORDERS_SHOWN = 64;
const OrdersQuery = z.object({ status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED']).optional() });

/** How many closed (sold, cancelled, expired) listings `GET /api/exchange/listings/mine` returns; ACTIVE ones are never cut. */
export const CLOSED_LISTINGS_SHOWN = 64;
const ListBody =z.object({ daemonId: z.string().min(1).max(64), price: z.number().int().min(1).max(MAX_PRICE) });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const BrowseQuery = z.object({
  species: z.string().max(32).optional(),
  line: z.coerce.number().int().min(1).max(50).optional(),
  type: z.string().max(16).optional(),
  clean: bool.optional(),
  minSignature: z.coerce.number().int().min(0).max(15).optional(),
  // bounded: an unbounded number reached Postgres as an out-of-range int (a 500)
  maxPrice: z.coerce.number().int().min(1).max(MAX_PRICE).optional(),
  sort: z.enum(['price', 'new']).optional(),
  page: z.coerce.number().int().min(0).max(1000).optional(),
});

const OpenTradeBody = z
  .object({ withId: z.string().min(1).max(64).optional(), withName: z.string().min(1).max(32).optional() })
  .refine((b) => !!b.withId !== !!b.withName, 'give withId or withName');
const OfferBody = z.object({
  bits: z.number().int().min(0).max(MAX_TRADE_BITS),
  items: z.record(z.string().min(1).max(64), z.number().int().min(1).max(MAX_QTY)),
  daemonIds: z.array(z.string().min(1).max(64)).max(MAX_TRADE_DAEMONS),
});
const ConfirmBody = z.object({ version: z.number().int().min(0) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Exchange (SP5): the vault view, the order book, daemon listings and direct trades. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  // Two budgets, each shared by every Exchange route: per client IP in onRequest, before authentication, so refused
  // tokens count too (it throttles guessing); per operator after requireAuth, so one operator cannot exceed the budget
  // by spreading requests over several addresses. (The plugin's per-route limit is off here: its local store keeps one
  // counter per route, so it could not share a budget across routes.) Without the rate-limit plugin (tests) only auth
  // applies.
  // Every response carries the tighter budget's x-ratelimit-* headers; a 429 adds retry-after.
  const limiter = (rate: { max: number; timeWindow: string }, keyGenerator: (req: FastifyRequest) => string) => {
    const limit = app.hasDecorator('createRateLimit') ? app.createRateLimit({ ...rate, keyGenerator }) : null;
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!limit) return;
      const r = await limit(req);
      if (r.isAllowed) return;
      const shown = reply.getHeader('x-ratelimit-remaining');
      if (shown === undefined || Number(shown) >= r.remaining) {
        reply.header('x-ratelimit-limit', r.max).header('x-ratelimit-remaining', r.remaining).header('x-ratelimit-reset', r.ttlInSeconds);
      }
      if (r.isExceeded) {
        reply.header('retry-after', r.ttlInSeconds);
        throw rateLimited();
      }
    };
  };
  // the plugin's own key normalisation: an IPv6 client is one /64 (rotating interface ids buys no fresh budget)
  const perIp = limiter(EXCHANGE_IP_RATE, (req) => `exchange-ip:${normalizeIP(req.ip)}`);
  const perOperator = limiter(EXCHANGE_RATE, (req) => (req.operator ? `exchange-op:${req.operator.id}` : `exchange-ip:${normalizeIP(req.ip)}`));
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
    const { order, fills } = await placeOrder(prisma, bus, req.operator!.id, body, log);
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

  // ---- daemon listings
  app.get<{ Querystring: unknown }>('/api/exchange/listings', auth, async (req) => browseListings(prisma, parse(BrowseQuery, req.query)));

  /**
   * The caller's listings, newest first: every ACTIVE one (bounded by the active-listing cap plus any not yet swept by
   * expiry), then the CLOSED_LISTINGS_SHOWN most recent closed ones. The daemon is shown only while the listing is ACTIVE.
   */
  app.get('/api/exchange/listings/mine', auth, async (req) => {
    const sellerId = req.operator!.id;
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const [active, closed] = await Promise.all([
      prisma.listing.findMany({ where: { sellerId, status: 'ACTIVE' }, orderBy }),
      prisma.listing.findMany({ where: { sellerId, status: { not: 'ACTIVE' } }, orderBy, take: CLOSED_LISTINGS_SHOWN }),
    ]);
    // a listing that closed between the two reads may be in both: keep it once (the closed row is the newer state)
    const byId = new Map([...active, ...closed].map((r) => [r.id, r]));
    const rows = [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: rows.filter((r) => r.status === 'ACTIVE').map((r) => r.daemonId) } } })).map((d) => [d.id, d]));
    return rows.map((r) => {
      const d = r.status === 'ACTIVE' ? daemons.get(r.daemonId) : undefined;
      return { id: r.id, price: r.price, status: r.status, species: r.species, level: r.level, createdAt: r.createdAt, expiresAt: r.expiresAt, soldAt: r.soldAt, daemon: d ? daemonView(d) : null };
    });
  });

  app.post('/api/exchange/listings', auth, async (req) => {
    const body = parse(ListBody, req.body);
    const l = await createListing(prisma, req.operator!.id, body.daemonId, body.price);
    return { id: l.id, price: l.price, expiresAt: l.expiresAt };
  });

  app.delete<{ Params: { id: string } }>('/api/exchange/listings/:id', auth, async (req) => {
    if (req.params.id.length > 64) throw notFound('no such listing');
    await cancelListing(prisma, req.operator!.id, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/exchange/listings/:id/buy', auth, async (req) => {
    if (req.params.id.length > 64) throw notFound('no such listing');
    return buyListing(prisma, bus, req.operator!.id, req.params.id, undefined, log);
  });

  // ---- direct trades (each mutation answers with the caller's view of the trade)
  const view = async (operatorId: string, trade: Parameters<typeof tradeViews>[1][number]) => (await tradeViews(prisma, [trade], operatorId))[0]!;
  const tradeId = (id: string) => {
    if (id.length > 64) throw notFound('no such trade');
    return id;
  };

  app.get('/api/exchange/trades', auth, async (req) => listTrades(prisma, req.operator!.id));

  app.post('/api/exchange/trades', auth, async (req) => {
    const body = parse(OpenTradeBody, req.body);
    return view(req.operator!.id, await openTrade(prisma, bus, req.operator!.id, { id: body.withId, name: body.withName }, log));
  });

  app.put<{ Params: { id: string } }>('/api/exchange/trades/:id/offer', auth, async (req) => {
    const id = tradeId(req.params.id);
    return view(req.operator!.id, await setOffer(prisma, bus, req.operator!.id, id, parse(OfferBody, req.body), undefined, log));
  });

  app.post<{ Params: { id: string } }>('/api/exchange/trades/:id/confirm', auth, async (req) => {
    const id = tradeId(req.params.id);
    return view(req.operator!.id, await confirmTrade(prisma, bus, req.operator!.id, id, parse(ConfirmBody, req.body).version, undefined, log));
  });

  app.post<{ Params: { id: string } }>('/api/exchange/trades/:id/cancel', auth, async (req) => view(req.operator!.id, await cancelTrade(prisma, bus, req.operator!.id, tradeId(req.params.id), undefined, log)));

  /**
   * Admin market view: what is open, what traded in the last 24 hours and the bits the fee destroyed. Admins only, from
   * a browser session: the route does not opt into bearer auth (a bot token never carries admin rights, #17). Only
   * aggregates plus the 16 latest sales (species, level, price, time: no operator ids or names); everything is summed in
   * the database, in one REPEATABLE READ snapshot, with every result set bounded (#33).
   */
  app.get('/api/admin/market', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const since = new Date(Date.now() - 86_400_000);
    const stamp = since.toISOString();
    const r = await prisma.$transaction(
      async (tx) => {
        const [openOrders, activeListings, openTrades, trades, sales, salesCount, listingFees, items, fillFees] = await Promise.all([
          tx.order.count({ where: { status: 'OPEN' } }),
          tx.listing.count({ where: { status: 'ACTIVE' } }),
          tx.trade.count({ where: { status: 'OPEN' } }),
          tx.trade.count({ where: { status: 'DONE', updatedAt: { gte: since } } }),
          tx.listing.findMany({ where: { status: 'SOLD', soldAt: { gte: since } }, orderBy: [{ soldAt: 'desc' }, { id: 'desc' }], take: 16, select: { species: true, level: true, price: true, soldAt: true } }),
          tx.listing.count({ where: { status: 'SOLD', soldAt: { gte: since } } }),
          // Each sale's fee is floored on its own (feeOn), so sum the per-row integer division.
          tx.$queryRaw<Array<{ fees: bigint }>>`
            SELECT COALESCE(SUM("price" / ${FEE_DIVISOR}), 0)::bigint AS "fees" FROM "Listing"
            WHERE "status" = 'SOLD' AND "soldAt" >= (${stamp}::timestamptz AT TIME ZONE 'UTC')`,
          // "at" is a UTC timestamp without time zone (as Prisma writes it). One row per item, so at most the item table.
          tx.$queryRaw<Array<{ item: string; qty: bigint; bits: bigint; fees: bigint; last: number }>>`
            SELECT "item", SUM("qty")::bigint AS "qty", SUM("price"::bigint * "qty")::bigint AS "bits", SUM("fee")::bigint AS "fees",
                   (ARRAY_AGG("price" ORDER BY "at" DESC, "id" DESC))[1] AS "last"
            FROM "Fill" WHERE "at" >= (${stamp}::timestamptz AT TIME ZONE 'UTC')
            GROUP BY "item" ORDER BY "bits" DESC, "item" LIMIT 256`,
          tx.$queryRaw<Array<{ fees: bigint }>>`
            SELECT COALESCE(SUM("fee"), 0)::bigint AS "fees" FROM "Fill" WHERE "at" >= (${stamp}::timestamptz AT TIME ZONE 'UTC')`,
        ]);
        return { openOrders, activeListings, openTrades, trades, sales, salesCount, listingFees: Number(listingFees[0]!.fees), items, fillFees: Number(fillFees[0]!.fees) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      openOrders: r.openOrders,
      activeListings: r.activeListings,
      openTrades: r.openTrades,
      day: {
        items: r.items.map((i) => ({ item: i.item, qty: Number(i.qty), bits: Number(i.bits), fees: Number(i.fees), last: i.last })),
        sales: r.sales,
        salesCount: r.salesCount,
        trades: r.trades,
        feesDestroyed: r.fillFees + r.listingFees,
      },
    };
  });
}
