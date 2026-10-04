import { consoleBusLogger, type Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { FEE_DIVISOR, MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY, ORDER_TTL_MS, feeOn } from '@daemonet/rules';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { PublishLog } from '../publish.js';
import { Outbox, announce, credit, debit, lockOperators, type FillView, type Tx } from './ledger.js';

/** Exchange limits and the fee live in `@daemonet/rules` (the client previews with the same numbers); re-exported for the api. */
export { FEE_DIVISOR, MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY, ORDER_TTL_MS, feeOn };

/**
 * Ledger reasons the order book writes. None of them is one of the sim's intent reasons (SIM_LEDGER_REASONS), so the
 * sim applies these rows as deltas: from the bus push, or on its next resync if the push is lost.
 */
export const EXCHANGE_LEDGER_REASONS = Object.freeze({ escrow: 'exchange:escrow', refund: 'exchange:refund', sale: 'exchange:sale' } as const);

export interface PlaceOrderInput {
  item: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
}
export type { FillView };

/** A matching sweep can touch up to MAX_QTY makers; give it room (the default interactive timeout is 5 s). */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Lock order (carry-forward #32), the same in every Exchange transaction: the item's book lock (an advisory lock, which
 * the sim never takes), then every Operator row involved, sorted by id, then ExchangeVault / Order / Fill rows. The sim
 * locks one Operator row before its ExchangeVault row, and api writers that lock several operators lock them sorted, so
 * no cycle is possible.
 *
 * The two-key advisory form lives in its own key space (it never collides with the one-key `hashtext` locks elsewhere).
 */
const BOOK_LOCK_SPACE = 0x45584348; // 'EXCH'
const lockBook = (tx: Tx, item: string) => tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(${BOOK_LOCK_SPACE}::int4, hashtext(${item}))`;

/**
 * Puts items into an operator's Exchange vault (INSERT … ON CONFLICT: never a primary-key race with the sim's
 * deposit). Call it after locking the operator row (lock order above). Reused by listings and trades.
 */
export async function vaultAdd(tx: Tx, operatorId: string, item: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  await tx.$executeRaw`
    INSERT INTO "ExchangeVault" ("operatorId", "item", "qty") VALUES (${operatorId}, ${item}, ${qty})
    ON CONFLICT ("operatorId", "item") DO UPDATE SET "qty" = "ExchangeVault"."qty" + EXCLUDED."qty"`;
}

/** Takes items from an operator's vault with a guarded decrement (400 when short). Call it after locking the operator row. */
export async function vaultTake(tx: Tx, operatorId: string, item: string, qty: number): Promise<void> {
  const res = await tx.exchangeVault.updateMany({ where: { operatorId, item, qty: { gte: qty } }, data: { qty: { decrement: qty } } });
  if (res.count !== 1) throw badRequest(`not enough ${item} in your vault`);
  await tx.exchangeVault.deleteMany({ where: { operatorId, item, qty: 0 } });
}

const inRange = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max;

/**
 * Places a limit order: escrow (bits for BUY, vault items for SELL), then match against the other side — best price
 * first, oldest first, never against the placer's own orders, never against an order past its expiry — at the resting
 * order's price. A BUY filled below its limit gets the difference back; the seller pays the 1/16 fee out of the
 * proceeds. Whatever is left rests on the book for ORDER_TTL_MS.
 */
export async function placeOrder(prisma: PrismaClient, bus: Bus, operatorId: string, input: PlaceOrderInput, now = new Date(), log: PublishLog = consoleBusLogger) {
  if (!inRange(input.price, MAX_PRICE) || !inRange(input.qty, MAX_QTY)) throw badRequest(`price 1-${MAX_PRICE}, qty 1-${MAX_QTY}`);
  const buying = input.side === 'BUY';
  const out = new Outbox();
  const order = await prisma.$transaction(async (tx) => {
    await lockBook(tx, input.item);
    // Under the book lock this item's resting orders cannot change (every placement, cancel and expiry of the item
    // takes it), so the makers this order will meet are known before any operator row is locked. Each supplies at
    // least one, so `qty` rows are enough.
    const resting = await tx.order.findMany({
      where: {
        item: input.item,
        side: buying ? 'SELL' : 'BUY',
        status: 'OPEN',
        expiresAt: { gt: now },
        operatorId: { not: operatorId },
        price: buying ? { lte: input.price } : { gte: input.price },
      },
      orderBy: [{ price: buying ? 'asc' : 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: input.qty,
    });
    const matches: Array<{ maker: (typeof resting)[number]; qty: number }> = [];
    let wanted = input.qty;
    for (const maker of resting) {
      if (wanted === 0) break;
      const qty = Math.min(wanted, maker.remaining);
      matches.push({ maker, qty });
      wanted -= qty;
    }
    await lockOperators(tx, [operatorId, ...matches.map((m) => m.maker.operatorId)]);

    // Under the operator lock: concurrent placements of this operator (on any item) have committed or wait for us.
    if ((await tx.order.count({ where: { operatorId, status: 'OPEN' } })) >= MAX_OPEN_ORDERS) throw badRequest(`at most ${MAX_OPEN_ORDERS} open orders`);
    const id = crypto.randomUUID();
    if (buying) await debit(tx, out, operatorId, input.price * input.qty, EXCHANGE_LEDGER_REASONS.escrow, id);
    else await vaultTake(tx, operatorId, input.item, input.qty);

    let remaining = input.qty;
    let refund = 0;
    for (const [n, { maker, qty }] of matches.entries()) {
      const price = maker.price;
      const total = price * qty;
      const fee = feeOn(total);
      const buyerId = buying ? operatorId : maker.operatorId;
      const sellerId = buying ? maker.operatorId : operatorId;
      // ordered ids: the fills of one placement share `at`, and sort in matching order by id
      const fillId = `${id}:${String(n).padStart(4, '0')}`;
      await vaultAdd(tx, buyerId, input.item, qty);
      await credit(tx, out, sellerId, total - fee, EXCHANGE_LEDGER_REASONS.sale, fillId);
      // the taker escrowed at its own limit; a better resting price refunds the difference
      if (buying) refund += (input.price - price) * qty;
      const left = maker.remaining - qty;
      const res = await tx.order.updateMany({ where: { id: maker.id, status: 'OPEN', remaining: maker.remaining }, data: { remaining: left, status: left === 0 ? 'FILLED' : 'OPEN' } });
      if (res.count !== 1) throw new Error(`order ${maker.id} changed under the book lock`);
      await tx.fill.create({
        data: { id: fillId, item: input.item, price, qty, buyOrderId: buying ? id : maker.id, sellOrderId: buying ? maker.id : id, buyerId, sellerId, fee, at: now },
      });
      out.fills.push({ id: fillId, item: input.item, price, qty, buyerId, sellerId, fee });
      remaining -= qty;
    }
    await credit(tx, out, operatorId, refund, EXCHANGE_LEDGER_REASONS.refund, id);
    return tx.order.create({
      data: { id, operatorId, item: input.item, side: input.side, price: input.price, qty: input.qty, remaining, status: remaining === 0 ? 'FILLED' : 'OPEN', createdAt: now, expiresAt: new Date(now.getTime() + ORDER_TTL_MS) },
    });
  }, TX_OPTIONS);
  announce(bus, log, out);
  return { order, fills: out.fills };
}

type Closable = { id: string; operatorId: string; item: string; side: 'BUY' | 'SELL'; price: number; remaining: number };

/** Returns what an OPEN order still holds in escrow and closes it (caller holds the book and operator locks). */
async function release(tx: Tx, out: Outbox, order: Closable, status: 'CANCELLED' | 'EXPIRED'): Promise<void> {
  const res = await tx.order.updateMany({ where: { id: order.id, status: 'OPEN', remaining: order.remaining }, data: { status } });
  if (res.count !== 1) throw new Error(`order ${order.id} changed under the book lock`);
  if (order.side === 'BUY') await credit(tx, out, order.operatorId, order.price * order.remaining, EXCHANGE_LEDGER_REASONS.refund, order.id);
  else await vaultAdd(tx, order.operatorId, order.item, order.remaining);
}

/** Cancels the caller's OPEN order and returns its unfilled escrow. 404 unknown, 403 not yours, 400 not open. */
export async function cancelOrder(prisma: PrismaClient, bus: Bus, operatorId: string, orderId: string, log: PublishLog = consoleBusLogger): Promise<void> {
  const found = await prisma.order.findUnique({ where: { id: orderId }, select: { operatorId: true, item: true } });
  if (!found) throw notFound('no such order');
  if (found.operatorId !== operatorId) throw forbidden('not your order');
  const out = new Outbox();
  await prisma.$transaction(async (tx) => {
    await lockBook(tx, found.item);
    await lockOperators(tx, [operatorId]);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'OPEN') throw badRequest(`order is ${order.status.toLowerCase()}`);
    await release(tx, out, order, 'CANCELLED');
  }, TX_OPTIONS);
  announce(bus, log, out);
}

/** Expires open orders past their time; run by the api every five minutes. Returns how many were closed. */
export async function expireOrders(prisma: PrismaClient, bus: Bus, now = new Date(), log: PublishLog = consoleBusLogger): Promise<number> {
  const BATCH = 256;
  let closed = 0;
  for (;;) {
    const due = await prisma.order.findMany({ where: { status: 'OPEN', expiresAt: { lte: now } }, select: { id: true, item: true, operatorId: true }, orderBy: { expiresAt: 'asc' }, take: BATCH });
    for (const d of due) {
      const out = new Outbox();
      await prisma.$transaction(async (tx) => {
        await lockBook(tx, d.item);
        await lockOperators(tx, [d.operatorId]);
        // re-read under the locks: a fill or a cancel may have closed it since
        const order = await tx.order.findUniqueOrThrow({ where: { id: d.id } });
        if (order.status !== 'OPEN' || order.expiresAt > now) return;
        await release(tx, out, order, 'EXPIRED');
        closed++;
      }, TX_OPTIONS);
      announce(bus, log, out);
    }
    if (due.length < BATCH) return closed;
  }
}

/** Top of the book: up to 16 price levels per side (orders past expiry excluded) and the last 16 fills. */
export async function bookFor(prisma: PrismaClient, item: string, now = new Date()) {
  const levels = async (side: 'BUY' | 'SELL') => {
    const rows = await prisma.order.groupBy({
      by: ['price'],
      where: { item, side, status: 'OPEN', expiresAt: { gt: now } },
      _sum: { remaining: true },
      orderBy: { price: side === 'BUY' ? 'desc' : 'asc' },
      take: 16,
    });
    return rows.map((r) => ({ price: r.price, qty: r._sum.remaining ?? 0 }));
  };
  const [bids, asks, fills] = await Promise.all([
    levels('BUY'),
    levels('SELL'),
    prisma.fill.findMany({ where: { item }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 16, select: { price: true, qty: true, at: true } }),
  ]);
  return { item, bids, asks, fills };
}
