# Daemonet SP5 · Plan 2 — Order book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working market for fungible items: limit orders with escrow, price-time matching at the resting price, the 1/16 seller fee, cancel and 7-day expiry, a REST API bots can drive with their bearer token, fill notifications to online operators, and an **Exchange** tab in the client.

**Architecture:** The engine is one module in the api (`exchange/orders.ts`). Every mutation is a single Postgres transaction that first takes a per-item advisory lock (`pg_advisory_xact_lock(hashtext('exchange:<item>'))`), so a book is only ever matched by one transaction at a time. BUY orders escrow `price × qty` bits (guarded decrement + ledger), SELL orders escrow the items from the vault. Matching walks the opposite side — best price, then oldest, never the placer's own orders — and executes at the **resting** order's price: items go to the buyer's vault, the seller is credited the proceeds minus `floor(total / 16)` (the fee is simply never re-credited: bits destroyed), and a BUY filled below its limit is refunded the difference. After the commit the api tells the sim: an `admin bits` push per affected operator and an `exchange { kind: 'fill' }` message, which the sim forwards to online operators as the `exchange` event.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP5 plan 1 merged.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp5-exchange-design.md` §3, §5, §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Bits and items are conserved by every Exchange operation except the fee; every balance change has a ledger row (`exchange:escrow`, `exchange:refund`, `exchange:sale`). A property test over random order flow checks both.
- ≤ 16 open orders per operator; orders expire after 7 days; price 1 – 1,048,576; qty 1 – 1024.

## File map

```
packages/db/prisma/schema.prisma            Order, Fill (+ migration 20261002000001)
packages/shared/src/protocol.ts             exchange event
apps/sim/src/runtime/game.ts                forwards bus `exchange` messages
apps/api/src/exchange/orders.ts             placeOrder, cancelOrder, expireOrders, bookFor, vaultAdd / vaultTake, feeOn
apps/api/src/routes/exchange.ts             items, book, orders (GET / POST / DELETE)
apps/api/src/server.ts                      expiry timer (5 min)
apps/api/src/auth/dev-bypass.ts             POST /api/dev/vault
apps/api/test/exchange.test.ts
apps/frontend/src/game/exchange.ts          feeOn, orderPreview, spread, fillEstimate
apps/frontend/src/panels/ExchangePanel.tsx
```

---

### Task 1: The engine and its API

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261002000001_sp5_orders/migration.sql`
- Create: `apps/api/src/exchange/orders.ts`, `apps/api/test/exchange.test.ts`
- Modify: `apps/api/src/routes/exchange.ts`, `apps/api/src/server.ts`, `apps/api/src/auth/dev-bypass.ts`

**Interfaces:**
- `MAX_OPEN_ORDERS = 16`, `ORDER_TTL_MS` (7 days), `MAX_PRICE = 1048576`, `MAX_QTY = 1024`, `FEE_DIVISOR = 16`, `feeOn(bits)`.
- `placeOrder(prisma, bus, operatorId, { item, side, price, qty }, now?) → { order, fills }`; `cancelOrder(prisma, bus, operatorId, orderId)`; `expireOrders(prisma, bus, now?) → number`; `bookFor(prisma, item, now?) → { item, bids, asks, fills }`; `vaultAdd(tx, operatorId, item, qty)`, `vaultTake(tx, …)` (reused by plans 3–4).
- REST (cookie or bearer, 120 / min): `GET /api/exchange/items`, `GET /api/exchange/book/:item`, `GET /api/exchange/orders`, `POST /api/exchange/orders { item, side, price, qty }`, `DELETE /api/exchange/orders/:id`. Errors: 402 `insufficient_bits`, 400 validation / caps / empty vault, 403 not your order, 404.
- Bus: `admin { kind: 'bits', operatorId, delta, reason: 'exchange', balance }`, `exchange { kind: 'fill', operators: [buyerId, sellerId], detail }`.
- Dev: `POST /api/dev/vault { item, qty }`.

- [ ] **Step 1: Schema and migration**

```prisma
enum OrderSide {
  BUY
  SELL
}

enum OrderStatus {
  OPEN
  FILLED
  CANCELLED
  EXPIRED
}

/// Exchange limit order (SP5 spec §5). BUY escrows price × qty bits, SELL escrows the items from the vault.
model Order {
  id         String      @id
  operatorId String
  item       String
  side       OrderSide
  price      Int
  qty        Int
  remaining  Int
  status     OrderStatus @default(OPEN)
  createdAt  DateTime    @default(now())
  expiresAt  DateTime

  @@index([item, side, status, price, createdAt])
  @@index([operatorId, status])
  @@index([status, expiresAt])
}

model Fill {
  id          String   @id
  item        String
  price       Int
  qty         Int
  buyOrderId  String
  sellOrderId String
  buyerId     String
  sellerId    String
  /// bits destroyed (1/16 of price × qty, floored)
  fee         Int
  at          DateTime @default(now())

  @@index([item, at])
}
```

```sql
-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "buyOrderId" TEXT NOT NULL,
    "sellOrderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_item_side_status_price_createdAt_idx" ON "Order"("item", "side", "status", "price", "createdAt");

-- CreateIndex
CREATE INDEX "Order_operatorId_status_idx" ON "Order"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Fill_item_at_idx" ON "Fill"("item", "at");
```

- [ ] **Step 2: Failing tests**

Create `apps/api/test/exchange.test.ts`:

```ts
import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { createRng } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { MAX_OPEN_ORDERS, ORDER_TTL_MS, expireOrders, feeOn } from '../src/exchange/orders.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Exchange order book (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();

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
    await prisma!.$executeRawUnsafe('TRUNCATE "Order", "Fill", "ExchangeVault", "BitsLedger", "Session", "Daemon", "Operator" CASCADE');
    bus.log.length = 0;
  });

  /** A bot operator with bits and vault items, talking to the api with a dev bearer token. */
  async function trader(name: string, bits = 0, vault: Record<string, number> = {}) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/me', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    if (bits) await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits) } });
    for (const [item, qty] of Object.entries(vault)) await prisma!.exchangeVault.create({ data: { operatorId: op.id, item, qty } });
    const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      order: (side: 'BUY' | 'SELL', price: number, qty: number, item = 'frag:packet') => call('POST', '/orders', { item, side, price, qty }),
      cancel: (id: string) => call('DELETE', `/orders/${id}`),
      get: (path: string) => call('GET', path),
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
      vault: async () => Object.fromEntries((await prisma!.exchangeVault.findMany({ where: { operatorId: op.id } })).map((v) => [v.item, v.qty])),
    };
  }

  it('escrows, rests, and shows the book', async () => {
    const seller = await trader('sel', 0, { 'frag:packet': 10 });
    const buyer = await trader('buy', 1000);
    expect((await seller.order('SELL', 50, 4)).body).toMatchObject({ order: { status: 'OPEN', remaining: 4 }, fills: [] });
    expect((await seller.order('SELL', 60, 2)).status).toBe(200);
    expect((await buyer.order('BUY', 40, 5)).body.order).toMatchObject({ status: 'OPEN', remaining: 5 });
    expect(await seller.vault()).toEqual({ 'frag:packet': 4 });
    expect(await buyer.bits()).toBe(800);
    const book = (await buyer.get('/book/frag:packet')).body;
    expect(book).toMatchObject({ bids: [{ price: 40, qty: 5 }], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }], fills: [] });
    const items = (await buyer.get('/items')).body as Array<{ id: string; bid: number | null; ask: number | null }>;
    expect(items.find((i) => i.id === 'frag:packet')).toMatchObject({ bid: 40, ask: 50 });
    expect((await buyer.get('/orders')).body).toHaveLength(1);
    expect((await buyer.get('/book/nonsense')).status).toBe(400);
    expect((await seller.order('SELL', 50, 99)).status).toBe(400);
    expect((await buyer.order('BUY', 1000, 5)).status).toBe(402);
    expect((await buyer.order('BUY', 0, 5)).status).toBe(400);
  });

  it('matches best price first, then oldest, at the resting price; refunds the difference; the seller pays 1/16', async () => {
    const a = await trader('a', 0, { 'frag:packet': 10 });
    const b = await trader('b', 0, { 'frag:packet': 10 });
    const buyer = await trader('c', 10_000);
    await a.order('SELL', 64, 3); // older at 64
    await b.order('SELL', 48, 2); // best price
    await b.order('SELL', 64, 3); // newer at 64
    const r = await buyer.order('BUY', 80, 6);
    expect(r.body.fills).toEqual([
      { price: 48, qty: 2, fee: feeOn(96) },
      { price: 64, qty: 3, fee: feeOn(192) },
      { price: 64, qty: 1, fee: feeOn(64) },
    ]);
    expect(r.body.order).toMatchObject({ status: 'FILLED', remaining: 0 });
    expect(await buyer.vault()).toEqual({ 'frag:packet': 6 });
    expect(await buyer.bits()).toBe(10_000 - (96 + 192 + 64));
    expect(await a.bits()).toBe(192 - 12);
    expect(await b.bits()).toBe(96 - 6 + (64 - 4));
    const fills = await prisma!.fill.findMany({ orderBy: { at: 'asc' } });
    expect(fills.map((f) => f.sellerId)).toEqual([b.id, a.id, b.id]);
    // everyone affected is told: balances over `admin`, fills over `exchange`
    expect(bus.log.filter((l) => l.channel === 'exchange')).toHaveLength(3);
    expect(bus.log.filter((l) => l.channel === 'admin' && (l.message as { kind: string }).kind === 'bits').map((l) => (l.message as { operatorId: string }).operatorId).sort()).toEqual([a.id, b.id, buyer.id].sort());
    const ledger = await prisma!.bitsLedger.findMany({ where: { operatorId: buyer.id } });
    expect(ledger.reduce((s, l) => s + Number(l.delta), 0)).toBe(-(96 + 192 + 64));
  });

  it('a SELL hits resting bids at their price; partial fills rest; own orders never match', async () => {
    const buyer = await trader('b1', 5000);
    const seller = await trader('s1', 500, { 'frag:packet': 10 });
    await buyer.order('BUY', 100, 2);
    await buyer.order('BUY', 90, 2);
    await seller.order('BUY', 95, 1); // the seller's own bid must be skipped
    const r = await seller.order('SELL', 85, 5);
    expect(r.body.fills.map((f: { price: number; qty: number }) => [f.price, f.qty])).toEqual([[100, 2], [90, 2]]);
    expect(r.body.order).toMatchObject({ status: 'OPEN', remaining: 1 });
    expect(await seller.bits()).toBe(500 - 95 + (200 - 12) + (180 - 11));
    expect(await buyer.vault()).toEqual({ 'frag:packet': 4 });
    expect((await buyer.get('/book/frag:packet')).body).toMatchObject({ bids: [{ price: 95, qty: 1 }], asks: [{ price: 85, qty: 1 }] });
  });

  it('cancel returns the unfilled escrow; only the owner may cancel; orders are capped at 16', async () => {
    const buyer = await trader('b2', 10_000);
    const seller = await trader('s2', 0, { 'frag:packet': 5 });
    const buy = (await buyer.order('BUY', 10, 10)).body.order;
    const sell = (await seller.order('SELL', 500, 5)).body.order;
    expect((await seller.cancel(buy.id)).status).toBe(403);
    expect((await buyer.cancel(buy.id)).body).toEqual({ ok: true });
    expect(await buyer.bits()).toBe(10_000);
    expect((await buyer.cancel(buy.id)).status).toBe(400);
    await seller.cancel(sell.id);
    expect(await seller.vault()).toEqual({ 'frag:packet': 5 });
    expect((await buyer.cancel('nope')).status).toBe(404);
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) expect((await buyer.order('BUY', 1, 1)).status).toBe(200);
    expect((await buyer.order('BUY', 1, 1)).status).toBe(400);
  });

  it('expires orders after seven days and returns their escrow', async () => {
    const buyer = await trader('b3', 1000);
    const seller = await trader('s3', 0, { 'frag:packet': 5 });
    await buyer.order('BUY', 10, 10);
    await seller.order('SELL', 500, 5);
    expect(await expireOrders(prisma!, bus, new Date(Date.now() + ORDER_TTL_MS - 60_000))).toBe(0);
    expect(await expireOrders(prisma!, bus, new Date(Date.now() + ORDER_TTL_MS + 60_000))).toBe(2);
    expect(await buyer.bits()).toBe(1000);
    expect(await seller.vault()).toEqual({ 'frag:packet': 5 });
    expect((await prisma!.order.findMany()).map((o) => o.status)).toEqual(['EXPIRED', 'EXPIRED']);
  });

  it('conserves bits and items over random order flow: only fees leave the system', async () => {
    const rng = createRng('exchange-conservation');
    const traders = [await trader('r0', 20_000, { 'frag:packet': 200 }), await trader('r1', 20_000, { 'frag:packet': 200 }), await trader('r2', 20_000, { 'frag:packet': 200 })];
    for (let i = 0; i < 60; i++) {
      const t = rng.pick(traders);
      if (rng.chance(0.15)) {
        const open = ((await t.get('/orders')).body as Array<{ id: string; status: string }>).filter((o) => o.status === 'OPEN');
        if (open.length) await t.cancel(rng.pick(open).id);
        continue;
      }
      await t.order(rng.chance(0.5) ? 'BUY' : 'SELL', rng.int(20, 40), rng.int(1, 8));
    }
    const orders = await prisma!.order.findMany({ where: { status: 'OPEN' } });
    const fees = (await prisma!.fill.findMany()).reduce((s, f) => s + f.fee, 0);
    let bits = 0;
    let items = 0;
    for (const t of traders) {
      bits += await t.bits();
      items += (await t.vault())['frag:packet'] ?? 0;
    }
    bits += orders.filter((o) => o.side === 'BUY').reduce((s, o) => s + o.price * o.remaining, 0);
    items += orders.filter((o) => o.side === 'SELL').reduce((s, o) => s + o.remaining, 0);
    expect(fees).toBeGreaterThan(0);
    expect(bits + fees).toBe(60_000);
    expect(items).toBe(600);
    // and every balance equals the sum of its ledger rows
    for (const t of traders) {
      const ledger = await prisma!.bitsLedger.findMany({ where: { operatorId: t.id } });
      expect(20_000 + ledger.reduce((s, l) => s + Number(l.delta), 0)).toBe(await t.bits());
    }
  });
});
```

- [ ] **Step 3: The engine**

Create `apps/api/src/exchange/orders.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { Prisma, PrismaClient } from '@daemonet/db';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';

/** Exchange limits and the fee (SP5 spec §3, §5). */
export const MAX_OPEN_ORDERS = 16;
export const ORDER_TTL_MS = 7 * 86_400_000;
export const MAX_PRICE = 1_048_576;
export const MAX_QTY = 1024;
export const FEE_DIVISOR = 16;

export const feeOn = (bits: number): number => Math.floor(bits / FEE_DIVISOR);

type Tx = Prisma.TransactionClient;
export interface PlaceOrderInput {
  item: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
}
export interface FillView {
  id: string;
  item: string;
  price: number;
  qty: number;
  buyerId: string;
  sellerId: string;
  fee: number;
}

/** Bits moved for each operator inside one transaction, so the sim can be told once after the commit. */
class Moves {
  readonly bits = new Map<string, number>();
  add(operatorId: string, delta: number): void {
    this.bits.set(operatorId, (this.bits.get(operatorId) ?? 0) + delta);
  }
}

async function credit(tx: Tx, moves: Moves, operatorId: string, bits: number, reason: string, ref: string): Promise<void> {
  if (bits === 0) return;
  await tx.operator.update({ where: { id: operatorId }, data: { bits: { increment: BigInt(bits) } } });
  await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(bits), reason, ref } });
  moves.add(operatorId, bits);
}

async function debit(tx: Tx, moves: Moves, operatorId: string, bits: number, reason: string, ref: string): Promise<void> {
  const res = await tx.operator.updateMany({ where: { id: operatorId, bits: { gte: BigInt(bits) } }, data: { bits: { decrement: BigInt(bits) } } });
  if (res.count !== 1) throw new AppError(402, 'insufficient_bits', `needs ${bits} bits`);
  await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(-bits), reason, ref } });
  moves.add(operatorId, -bits);
}

export async function vaultAdd(tx: Tx, operatorId: string, item: string, qty: number): Promise<void> {
  await tx.exchangeVault.upsert({ where: { operatorId_item: { operatorId, item } }, create: { operatorId, item, qty }, update: { qty: { increment: qty } } });
}

export async function vaultTake(tx: Tx, operatorId: string, item: string, qty: number): Promise<void> {
  const res = await tx.exchangeVault.updateMany({ where: { operatorId, item, qty: { gte: qty } }, data: { qty: { decrement: qty } } });
  if (res.count !== 1) throw badRequest(`not enough ${item} in your vault`);
  await tx.exchangeVault.deleteMany({ where: { operatorId, item, qty: 0 } });
}

/** One item's book is matched by one transaction at a time. */
const lockBook = (tx: Tx, item: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`exchange:${item}`}))`;

async function announce(prisma: PrismaClient, bus: Bus, moves: Moves, reason: string, fills: FillView[]): Promise<void> {
  for (const [operatorId, delta] of moves.bits) {
    if (delta === 0) continue;
    const op = await prisma.operator.findUnique({ where: { id: operatorId }, select: { bits: true } });
    if (op) await bus.publish('admin', { kind: 'bits', operatorId, delta, reason, balance: Number(op.bits) });
  }
  for (const f of fills) await bus.publish('exchange', { kind: 'fill', operators: [f.buyerId, f.sellerId], detail: { item: f.item, price: f.price, qty: f.qty, buyerId: f.buyerId, sellerId: f.sellerId, fee: f.fee } });
}

/**
 * Places a limit order: escrow (bits for BUY, vault items for SELL), then match against the other side —
 * best price first, oldest first, never against the placer's own orders — at the resting order's price.
 * A BUY filled below its limit gets the difference back; the seller pays the 1/16 fee out of the proceeds.
 */
export async function placeOrder(prisma: PrismaClient, bus: Bus, operatorId: string, input: PlaceOrderInput, now = new Date()) {
  const moves = new Moves();
  const fills: FillView[] = [];
  const order = await prisma.$transaction(async (tx) => {
    await lockBook(tx, input.item);
    if ((await tx.order.count({ where: { operatorId, status: 'OPEN' } })) >= MAX_OPEN_ORDERS) throw badRequest(`at most ${MAX_OPEN_ORDERS} open orders`);
    const id = crypto.randomUUID();
    if (input.side === 'BUY') await debit(tx, moves, operatorId, input.price * input.qty, 'exchange:escrow', id);
    else await vaultTake(tx, operatorId, input.item, input.qty);
    let remaining = input.qty;
    const resting = await tx.order.findMany({
      where: {
        item: input.item,
        side: input.side === 'BUY' ? 'SELL' : 'BUY',
        status: 'OPEN',
        expiresAt: { gt: now },
        operatorId: { not: operatorId },
        price: input.side === 'BUY' ? { lte: input.price } : { gte: input.price },
      },
      orderBy: [{ price: input.side === 'BUY' ? 'asc' : 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 64,
    });
    for (const maker of resting) {
      if (remaining === 0) break;
      const qty = Math.min(remaining, maker.remaining);
      const price = maker.price;
      const total = price * qty;
      const fee = feeOn(total);
      const buyerId = input.side === 'BUY' ? operatorId : maker.operatorId;
      const sellerId = input.side === 'BUY' ? maker.operatorId : operatorId;
      await vaultAdd(tx, buyerId, input.item, qty);
      await credit(tx, moves, sellerId, total - fee, 'exchange:sale', id);
      // the taker escrowed at its own limit; a better resting price refunds the difference
      if (input.side === 'BUY' && input.price > price) await credit(tx, moves, operatorId, (input.price - price) * qty, 'exchange:refund', id);
      const left = maker.remaining - qty;
      await tx.order.update({ where: { id: maker.id }, data: { remaining: left, status: left === 0 ? 'FILLED' : 'OPEN' } });
      const fill = await tx.fill.create({
        data: { id: crypto.randomUUID(), item: input.item, price, qty, buyOrderId: input.side === 'BUY' ? id : maker.id, sellOrderId: input.side === 'BUY' ? maker.id : id, buyerId, sellerId, fee, at: now },
      });
      fills.push({ id: fill.id, item: fill.item, price, qty, buyerId, sellerId, fee });
      remaining -= qty;
    }
    return tx.order.create({
      data: { id, operatorId, item: input.item, side: input.side, price: input.price, qty: input.qty, remaining, status: remaining === 0 ? 'FILLED' : 'OPEN', createdAt: now, expiresAt: new Date(now.getTime() + ORDER_TTL_MS) },
    });
  });
  await announce(prisma, bus, moves, 'exchange', fills);
  return { order, fills };
}

/** Returns what an order still holds in escrow and closes it. */
async function release(tx: Tx, moves: Moves, order: { id: string; operatorId: string; item: string; side: 'BUY' | 'SELL'; price: number; remaining: number }, status: 'CANCELLED' | 'EXPIRED'): Promise<void> {
  if (order.side === 'BUY') await credit(tx, moves, order.operatorId, order.price * order.remaining, 'exchange:refund', order.id);
  else await vaultAdd(tx, order.operatorId, order.item, order.remaining);
  await tx.order.update({ where: { id: order.id }, data: { status } });
}

export async function cancelOrder(prisma: PrismaClient, bus: Bus, operatorId: string, orderId: string) {
  const moves = new Moves();
  await prisma.$transaction(async (tx) => {
    const found = await tx.order.findUnique({ where: { id: orderId } });
    if (!found) throw notFound('no such order');
    if (found.operatorId !== operatorId) throw forbidden('not your order');
    await lockBook(tx, found.item);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'OPEN') throw badRequest(`order is ${order.status.toLowerCase()}`);
    await release(tx, moves, order, 'CANCELLED');
  });
  await announce(prisma, bus, moves, 'exchange', []);
}

/** Expires open orders past their time; run by the api every few minutes. Returns how many were closed. */
export async function expireOrders(prisma: PrismaClient, bus: Bus, now = new Date()): Promise<number> {
  const due = await prisma.order.findMany({ where: { status: 'OPEN', expiresAt: { lte: now } }, select: { id: true, item: true }, take: 256 });
  let closed = 0;
  for (const d of due) {
    const moves = new Moves();
    await prisma.$transaction(async (tx) => {
      await lockBook(tx, d.item);
      const order = await tx.order.findUniqueOrThrow({ where: { id: d.id } });
      if (order.status !== 'OPEN') return;
      await release(tx, moves, order, 'EXPIRED');
      closed++;
    });
    await announce(prisma, bus, moves, 'exchange', []);
  }
  return closed;
}

/** Top of the book: up to 16 price levels per side and the last 16 fills. */
export async function bookFor(prisma: PrismaClient, item: string, now = new Date()) {
  const open = await prisma.order.findMany({ where: { item, status: 'OPEN', expiresAt: { gt: now } }, select: { side: true, price: true, remaining: true } });
  const levels = (side: 'BUY' | 'SELL') => {
    const byPrice = new Map<number, number>();
    for (const o of open) if (o.side === side) byPrice.set(o.price, (byPrice.get(o.price) ?? 0) + o.remaining);
    return [...byPrice.entries()].sort((a, b) => (side === 'BUY' ? b[0] - a[0] : a[0] - b[0])).slice(0, 16).map(([price, qty]) => ({ price, qty }));
  };
  const fills = await prisma.fill.findMany({ where: { item }, orderBy: { at: 'desc' }, take: 16, select: { price: true, qty: true, at: true } });
  return { item, bids: levels('BUY'), asks: levels('SELL'), fills };
}
```

- [ ] **Step 4: Routes, expiry, dev seeding**

Replace `apps/api/src/routes/exchange.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { ITEMS, isTradable } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { MAX_PRICE, MAX_QTY, bookFor, cancelOrder, placeOrder } from '../exchange/orders.js';

const OrderBody = z.object({
  item: z.string().min(1).max(64),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().int().min(1).max(MAX_PRICE),
  qty: z.number().int().min(1).max(MAX_QTY),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Exchange (SP5): the vault view and the order book; listings and trades are added by plans 3–4. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

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
    return ITEMS.map((i) => ({ id: i.id, name: i.name, kind: i.kind, bid: best.get(i.id)?.bid ?? null, ask: best.get(i.id)?.ask ?? null }));
  });

  app.get<{ Params: { item: string } }>('/api/exchange/book/:item', auth, async (req) => {
    if (!isTradable(req.params.item)) throw badRequest('unknown item');
    return bookFor(prisma, req.params.item);
  });

  app.get('/api/exchange/orders', auth, async (req) => {
    const rows = await prisma.order.findMany({ where: { operatorId: req.operator!.id }, orderBy: { createdAt: 'desc' }, take: 64 });
    return rows.map((o) => ({ id: o.id, item: o.item, side: o.side, price: o.price, qty: o.qty, remaining: o.remaining, status: o.status, createdAt: o.createdAt, expiresAt: o.expiresAt }));
  });

  app.post('/api/exchange/orders', auth, async (req) => {
    const body = parse(OrderBody, req.body);
    if (!isTradable(body.item)) throw badRequest('unknown item');
    const { order, fills } = await placeOrder(prisma, bus, req.operator!.id, body);
    return {
      order: { id: order.id, item: order.item, side: order.side, price: order.price, qty: order.qty, remaining: order.remaining, status: order.status, expiresAt: order.expiresAt },
      fills: fills.map((f) => ({ price: f.price, qty: f.qty, fee: f.fee })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/exchange/orders/:id', auth, async (req) => {
    await cancelOrder(prisma, bus, req.operator!.id, req.params.id);
    return { ok: true };
  });
}
```

`apps/api/src/server.ts` — after the chat prune timer:

```ts
const expire = () => expireOrders(prisma, bus).then((n) => n > 0 && app.log.info({ expired: n }, 'expired exchange orders')).catch((err: Error) => app.log.error({ err: err.message }, 'order expiry failed'));
const expireTimer = setInterval(expire, 5 * 60_000);
```

(cleared in `shutdown`). `apps/api/src/auth/dev-bypass.ts` (import `isTradable`; `const VaultBody = z.object({ item: z.string().min(1).max(64), qty: z.number().int().min(1).max(1024) });`):

```ts
  /** Puts items straight into the caller's Exchange vault (tests of the order book without a hunting trip). */
  app.post('/api/dev/vault', { preHandler: app.requireAuth }, async (req) => {
    const parsed = VaultBody.safeParse(req.body);
    if (!parsed.success || !isTradable(parsed.data.item)) throw badRequest('body must be { item, qty 1-1024 }');
    const operatorId = req.operator!.id;
    const row = await deps.prisma.exchangeVault.upsert({
      where: { operatorId_item: { operatorId, item: parsed.data.item } },
      create: { operatorId, item: parsed.data.item, qty: parsed.data.qty },
      update: { qty: { increment: parsed.data.qty } },
    });
    return { item: row.item, qty: row.qty };
  });
```

- [ ] **Step 5: Verify and commit**

Deploy the migration, regenerate, `pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green (6 Exchange tests, including conservation over 60 random actions).

```bash
git add packages/db apps/api
git commit -m "feat(api): Exchange order book — escrow, price-time matching, 1/16 fee, cancel and expiry"
```

---

### Task 2: Fill notifications through the sim

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `apps/sim/src/runtime/game.ts`
- Create: `apps/sim/test/exchange.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

describe('Exchange notifications', () => {
  it('forwards bus `exchange` messages to the listed operators that are online, as an event', async () => {
    const bus = new MemoryBus();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store: new MemoryStore(), verify: createDevVerifier('daemonet-users'), bus });
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      return conn;
    };
    const alice = await join('alice');
    const bob = await join('bob');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    await bus.publish('exchange', { kind: 'fill', operators: [aliceId, 'someone-offline', aliceId], detail: { item: 'frag:packet', price: 20, qty: 3 } });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([{ e: 'exchange', kind: 'fill', detail: { item: 'frag:packet', price: 20, qty: 3 } }]);
    expect(bob.of('delta').at(-1)!.d.events).toEqual([]);
    await bus.publish('exchange', { nonsense: true });
    game.tick();
    expect(alice.of('delta').at(-1)!.d.events).toEqual([]);
    await game.shutdown();
  });
});
```

- [ ] **Step 2: Event and forwarding**

`packages/shared/src/protocol.ts` (`GameEvent`):

```ts
  /** Something happened to you on the Exchange (a fill, a sale, a trade update); `detail` depends on `kind`. */
  z.object({ e: z.literal('exchange'), kind: z.string(), detail: z.record(z.string(), z.unknown()) }),
```

`apps/sim/src/runtime/game.ts`: subscribe `opts.bus.subscribe('exchange', (m) => this.onExchange(m as never))` alongside `org` and `admin`, and add

```ts
  /** Exchange notifications from the api (SP5): delivered as an `exchange` event to each listed operator that is online. */
  private onExchange(m: { kind?: string; operators?: string[]; detail?: Record<string, unknown> }): void {
    if (typeof m.kind !== 'string' || !Array.isArray(m.operators)) return;
    for (const id of new Set(m.operators)) {
      const world = this.sessions.get(id)?.world;
      if (world?.operators.has(id)) world.emitCarry({ e: 'exchange', kind: m.kind, detail: m.detail ?? {} }, { to: id });
    }
  }
```

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b && pnpm exec vitest run apps/sim/test/exchange.test.ts` — expected: green.

```bash
git add packages/shared apps/sim
git commit -m "feat(sim): forward Exchange notifications to online operators"
```

---

### Task 3: Exchange tab

**Files:**
- Create: `apps/frontend/src/game/exchange.ts`, `apps/frontend/src/panels/ExchangePanel.tsx`, `apps/frontend/test/exchange.test.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `feeOn`, `orderPreview(side, price, qty) → { total, fee, net }`, `spread(book)`, `fillEstimate(book, side, price, qty) → { filled, average }`.
- Test ids: `exchange`, `exchange-item`, `exchange-vault`, `book`, `ask-<price>`, `side-BUY|SELL`, `order-price`, `order-qty`, `order-place`, `my-orders`.

- [ ] **Step 1: Failing unit test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { feeOn, fillEstimate, orderPreview, spread } from '../src/game/exchange.ts';

const book = { bids: [{ price: 40, qty: 5 }, { price: 38, qty: 2 }], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }] };

describe('exchange maths', () => {
  it('previews escrow for buys and proceeds after the 1/16 fee for sells', () => {
    expect(feeOn(96)).toBe(6);
    expect(feeOn(15)).toBe(0);
    expect(orderPreview('BUY', 50, 4)).toEqual({ total: 200, fee: 0, net: -200 });
    expect(orderPreview('SELL', 50, 4)).toEqual({ total: 200, fee: 12, net: 188 });
  });

  it('reads the spread and estimates immediate fills at resting prices', () => {
    expect(spread(book)).toEqual({ bid: 40, ask: 50, spread: 10 });
    expect(spread({ bids: [], asks: book.asks })).toEqual({ bid: null, ask: 50, spread: null });
    expect(fillEstimate(book, 'BUY', 55, 6)).toEqual({ filled: 4, average: 50 });
    expect(fillEstimate(book, 'BUY', 60, 6)).toEqual({ filled: 6, average: (200 + 120) / 6 });
    expect(fillEstimate(book, 'SELL', 39, 6)).toEqual({ filled: 5, average: 40 });
    expect(fillEstimate(book, 'BUY', 45, 3)).toEqual({ filled: 0, average: null });
  });
});
```

- [ ] **Step 2: Helpers and panel**

```ts
/** Exchange maths shown in the client (the api is authoritative): the seller pays 1/16 of the proceeds. */
export const FEE_DIVISOR = 16;

export interface BookLevel {
  price: number;
  qty: number;
}
export interface Book {
  item: string;
  bids: BookLevel[];
  asks: BookLevel[];
  fills: Array<{ price: number; qty: number; at: string }>;
}

export function feeOn(bits: number): number {
  return Math.floor(bits / FEE_DIVISOR);
}

/** What placing the order costs now (BUY: escrow) or would bring in if it fills completely at its limit (SELL: after the fee). */
export function orderPreview(side: 'BUY' | 'SELL', price: number, qty: number): { total: number; fee: number; net: number } {
  const total = price * qty;
  if (side === 'BUY') return { total, fee: 0, net: -total };
  const fee = feeOn(total);
  return { total, fee, net: total - fee };
}

export function spread(book: Pick<Book, 'bids' | 'asks'>): { bid: number | null; ask: number | null; spread: number | null } {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  return { bid, ask, spread: bid !== null && ask !== null ? ask - bid : null };
}

/** How much of `qty` a new order would fill immediately against the visible book, and at what average price. */
export function fillEstimate(book: Pick<Book, 'bids' | 'asks'>, side: 'BUY' | 'SELL', price: number, qty: number): { filled: number; average: number | null } {
  const levels = side === 'BUY' ? book.asks.filter((l) => l.price <= price) : book.bids.filter((l) => l.price >= price);
  let left = qty;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(left, l.qty);
    cost += take * l.price;
    left -= take;
    if (left === 0) break;
  }
  const filled = qty - left;
  return { filled, average: filled > 0 ? cost / filled : null };
}
```

```tsx
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { useBookQuery, useCancelOrderMutation, useExchangeItemsQuery, useMyOrdersQuery, usePlaceOrderMutation, useVaultQuery } from '../api.ts';
import { fillEstimate, orderPreview, spread } from '../game/exchange.ts';
import { log } from '../game/log.ts';

const POLL_MS = 4000;

/** The Exchange (SP5): order book per item, an order form, and the operator's own orders. Trades from the vault (Host tab). */
export function ExchangePanel({ client }: { client: GameClient }) {
  const items = useExchangeItemsQuery(undefined, { pollingInterval: POLL_MS * 4 });
  const [item, setItem] = useState('frag:packet');
  const book = useBookQuery(item, { pollingInterval: POLL_MS });
  const orders = useMyOrdersQuery(undefined, { pollingInterval: POLL_MS });
  const vault = useVaultQuery(undefined, { pollingInterval: POLL_MS });
  const [place, placing] = usePlaceOrderMutation();
  const [cancel] = useCancelOrderMutation();
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [price, setPrice] = useState(32);
  const [qty, setQty] = useState(1);
  const me = client.self;
  const have = vault.data?.[item] ?? 0;
  const preview = orderPreview(side, price, qty);
  const est = book.data ? fillEstimate(book.data, side, price, qty) : { filled: 0, average: null };
  const top = book.data ? spread(book.data) : { bid: null, ask: null, spread: null };
  const canPlace = side === 'BUY' ? me.bits >= preview.total : have >= qty;

  const submit = async () => {
    try {
      const r = await place({ item, side, price, qty }).unwrap();
      const filled = r.fills.reduce((s, f) => s + f.qty, 0);
      log.push('event', `${side.toLowerCase()} ${qty} ${item} @ ${price}: ${filled} filled, ${r.order.remaining} resting`);
    } catch (err) {
      log.push('reject', `order: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);
    }
  };

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="exchange">
      <div className="flex items-center gap-2 text-xs">
        <select className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5" value={item} onChange={(e) => setItem(e.target.value)} data-testid="exchange-item">
          {(items.data ?? [{ id: item, name: item, bid: null, ask: null }]).map((i) => (
            <option key={i.id} value={i.id}>
              {i.id}
              {i.bid !== null || i.ask !== null ? ` · ${i.bid ?? '—'} / ${i.ask ?? '—'}` : ''}
            </option>
          ))}
        </select>
        <span className="mono text-neutral-500" data-testid="exchange-vault">
          vault ×{have} · {me.bits} bits
        </span>
      </div>

      <section className="grid grid-cols-2 gap-2 text-xs" data-testid="book">
        <div>
          <h3 className="mb-1 uppercase tracking-wide text-emerald-400">bids</h3>
          {book.data?.bids.length === 0 && <p className="text-neutral-600">none</p>}
          {book.data?.bids.map((l) => (
            <button key={l.price} className="mono flex w-full justify-between text-emerald-300 hover:bg-neutral-900" onClick={() => (setSide('SELL'), setPrice(l.price))}>
              <span>{l.price}</span>
              <span className="text-neutral-400">×{l.qty}</span>
            </button>
          ))}
        </div>
        <div>
          <h3 className="mb-1 uppercase tracking-wide text-red-400">asks</h3>
          {book.data?.asks.length === 0 && <p className="text-neutral-600">none</p>}
          {book.data?.asks.map((l) => (
            <button key={l.price} className="mono flex w-full justify-between text-red-300 hover:bg-neutral-900" onClick={() => (setSide('BUY'), setPrice(l.price))} data-testid={`ask-${l.price}`}>
              <span>{l.price}</span>
              <span className="text-neutral-400">×{l.qty}</span>
            </button>
          ))}
        </div>
        <p className="mono col-span-2 text-neutral-500">
          spread {top.spread ?? '—'} · last {book.data?.fills[0] ? `${book.data.fills[0].price} ×${book.data.fills[0].qty}` : '—'}
        </p>
      </section>

      <section className="space-y-1 rounded border border-neutral-800 p-2 text-xs">
        <div className="flex items-center gap-1">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button key={s} className={`rounded px-2 py-0.5 ${side === s ? (s === 'BUY' ? 'bg-emerald-800' : 'bg-red-900') : 'bg-neutral-800 text-neutral-400'}`} onClick={() => setSide(s)} data-testid={`side-${s}`}>
              {s.toLowerCase()}
            </button>
          ))}
          <label className="ml-2 text-neutral-500">
            price
            <input className="ml-1 w-20 rounded bg-neutral-900 px-1" type="number" min={1} value={price} onChange={(e) => setPrice(Math.max(1, Number(e.target.value) || 1))} data-testid="order-price" />
          </label>
          <label className="text-neutral-500">
            qty
            <input className="ml-1 w-14 rounded bg-neutral-900 px-1" type="number" min={1} max={1024} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(1024, Number(e.target.value) || 1)))} data-testid="order-qty" />
          </label>
          <button className="ml-auto rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={placing.isLoading || !canPlace} onClick={() => void submit()} data-testid="order-place">
            place
          </button>
        </div>
        <p className="mono text-neutral-500">
          {side === 'BUY' ? `escrows ${preview.total} bits` : `brings ${preview.net} bits after the ${preview.fee}-bit fee (1/16)`} · fills {est.filled} now
          {est.average !== null ? ` at ~${est.average.toFixed(1)}` : ''}
          {!canPlace ? (side === 'BUY' ? ' · not enough bits' : ' · deposit items at a host first (Host → vault)') : ''}
        </p>
      </section>

      <section className="text-xs" data-testid="my-orders">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">my orders</h3>
        {(orders.data ?? []).length === 0 && <p className="text-neutral-600">none</p>}
        {orders.data?.map((o) => (
          <div key={o.id} className="mono flex items-center justify-between border-b border-neutral-900 py-0.5">
            <span className={o.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'}>{o.side.toLowerCase()}</span>
            <span>{o.item}</span>
            <span>
              {o.qty - o.remaining}/{o.qty} @ {o.price}
            </span>
            <span className="text-neutral-500">{o.status.toLowerCase()}</span>
            {o.status === 'OPEN' ? (
              <button className="text-neutral-500 hover:text-red-300" onClick={() => void cancel(o.id)}>
                cancel
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Wiring**

`apps/frontend/src/api.ts` — types

```ts
export interface ExchangeItem {
  id: string;
  name: string;
  kind: string;
  bid: number | null;
  ask: number | null;
}
export interface MyOrder {
  id: string;
  item: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  remaining: number;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}
```

tags `'Orders'`, `'Book'`, endpoints

```ts
    exchangeItems: b.query<ExchangeItem[], void>({ query: () => '/exchange/items', providesTags: ['Book'] }),
    book: b.query<Book, string>({ query: (item) => `/exchange/book/${encodeURIComponent(item)}`, providesTags: ['Book'] }),
    myOrders: b.query<MyOrder[], void>({ query: () => '/exchange/orders', providesTags: ['Orders'] }),
    placeOrder: b.mutation<{ order: MyOrder; fills: Array<{ price: number; qty: number; fee: number }> }, { item: string; side: 'BUY' | 'SELL'; price: number; qty: number }>({
      query: (body) => ({ url: '/exchange/orders', method: 'POST', body }),
      invalidatesTags: ['Orders', 'Book', 'Vault'],
    }),
    cancelOrder: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `/exchange/orders/${id}`, method: 'DELETE' }), invalidatesTags: ['Orders', 'Book', 'Vault'] }),
    startIncident: b.mutation<{ ok: boolean }, void>({ query: () => ({ url: '/admin/incidents/start', method: 'POST' }) }),
```

and the hooks `useExchangeItemsQuery`, `useBookQuery`, `useMyOrdersQuery`, `usePlaceOrderMutation`, `useCancelOrderMutation`.

`App.tsx`: an `exchange` tab after `codex` rendering `<ExchangePanel client={client} />`. `connection.ts`:

```ts
    client.on('exchange', (e) => {
      const d = e.detail as { item?: string; price?: number; qty?: number; buyerId?: string };
      if (e.kind === 'fill') log.push('event', `Exchange: ${d.buyerId === client.operatorId ? 'bought' : 'sold'} ${d.qty} ${d.item} @ ${d.price}`);
      else log.push('event', `Exchange: ${e.kind}`);
    });
```

`sdk-types.ts`: `on(name: 'exchange', handler: (ev: { kind: string; detail: Record<string, unknown> }) => void): () => void;`.

- [ ] **Step 4: End-to-end**

In the two-operator scenario, before the Incident step (an item no other test trades, so the book is empty):

```ts
  // Exchange: B sells fragments from the vault; A (who still has bits) buys them at B's price
  const hdr = { 'x-requested-with': 'daemonet' };
  expect((await pb.request.post('/api/dev/vault', { data: { item: 'frag:heap', qty: 5 }, headers: hdr })).ok()).toBeTruthy();
  await pb.getByTestId('tab-exchange').click();
  await pb.getByTestId('exchange-item').selectOption('frag:heap');
  await pb.getByTestId('side-SELL').click();
  await pb.getByTestId('order-price').fill('20');
  await pb.getByTestId('order-qty').fill('3');
  await expect(pb.getByTestId('exchange-vault')).toContainText('vault ×5', { timeout: 10_000 });
  await pb.getByTestId('order-place').click();
  await expect(pb.getByTestId('my-orders')).toContainText('0/3 @ 20', { timeout: 10_000 });
  await pa.getByTestId('tab-exchange').click();
  await pa.getByTestId('exchange-item').selectOption('frag:heap');
  await expect(pa.getByTestId('ask-20')).toContainText('×3', { timeout: 10_000 });
  await pa.getByTestId('side-BUY').click();
  await pa.getByTestId('order-price').fill('25');
  await pa.getByTestId('order-qty').fill('3');
  await pa.getByTestId('order-place').click();
  await expect(pa.getByTestId('my-orders')).toContainText('3/3 @ 25', { timeout: 10_000 });
  await expect(pa.getByTestId('exchange-vault')).toContainText('vault ×3', { timeout: 10_000 });
  await expect(pb.getByTestId('my-orders')).toContainText('3/3 @ 20', { timeout: 10_000 });
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('Exchange: sold 3 frag:heap @ 20', { timeout: 10_000 });
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 47 files, 383 tests. Build, start the stack, `playwright test` — 4 passed. With the dev bypass, a bot can trade with curl: `curl -H "authorization: Bearer dev:bot" -H "content-type: application/json" -d '{"item":"frag:heap","side":"BUY","price":10,"qty":1}' http://127.0.0.1:3001/api/exchange/orders`.

```bash
git add apps/frontend
git commit -m "feat(frontend): Exchange tab with order book, order form and own orders"
```

---

## Self-review

- **Spec coverage:** §5 `Order` / `Fill`, escrow on both sides, price and quantity bounds, per-item serialisation with an advisory lock, best price then oldest, resting price, refund of the difference, fee from the seller's proceeds, `Fill` rows, bus messages, cancel, 5-minute expiry sweep, all five REST endpoints; §3 limits and bearer access; §8 the sim's `exchange` event and the client tab. The SDK `ExchangeClient` comes with plan 4.
- **Type consistency:** `feeOn` exists on both sides (api authoritative, client for previews) with the same divisor; `Book` in the client matches `bookFor`'s return shape.
- **Placeholders:** none.
