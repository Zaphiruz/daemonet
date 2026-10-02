# Daemonet SP5 · Plan 4 — Direct trades, SDK client, admin market view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Exchange: two operators trade bits, vault items and Disk daemons directly with a both-sides-confirm flow; bots get a typed REST client in the SDK; admins get a market view.

**Architecture:** A third api module (`exchange/trades.ts`). A `Trade` row holds both offers as JSON plus a `version` counter. Every mutation locks the row `FOR UPDATE`. Setting an offer validates it against the caller's balance, vault and Disk, locks the offered daemons (`lockedBy = trade:<id>`), clears both confirmations and bumps `version`; a confirmation must quote the `version` it saw, so nobody can be made to confirm an offer that changed under them. The second confirmation executes the swap inside the same transaction with the order book's guarded primitives (`debit` / `credit` with the 1/16 fee on received bits, `vaultTake` / `vaultAdd`); daemons are first parked on negative slots so two Disks can swap without violating the slot uniqueness, then given the receiver's lowest free slots. Any failed check rolls the whole step back and the trade stays open. Afterwards the api pushes `admin bits` / `admin disk` and an `exchange { kind: 'trade' }` notification, which clients use to refetch.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP5 plans 1–3 merged.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp5-exchange-design.md` §7, §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Bits and items are conserved by a trade except the fee: each side's received bits lose `floor(bits / 16)`; ledger reason `exchange:trade` with the trade id as `ref`.
- ≤ 4 open trades per operator, one open trade per pair, ≤ 8 daemons and ≤ 16 kinds of item per offer; open trades idle for 1 hour are cancelled.
- An operator who blocked you (chat block list) cannot be sent a trade.

## Deviations from the spec (deliberate)

- `Trade.version` and the `version` argument of confirm are additions (see Architecture) — without them the "any offer change clears both confirmations" rule still leaves a race between a late offer change and a confirmation already in flight.
- `POST /api/exchange/trades` also accepts `{ withName }`, because players know names, not ids.
- The SDK `ExchangeClient` is for Node bots (bearer token) and for pages on the Daemonet origin (cookie). Scripts inside the in-browser sandbox do **not** get it: the sandbox iframe keeps `connect-src 'none'`, and proxying authenticated REST calls through the bridge is left out until there is a concrete need.

## File map

```
packages/db/prisma/schema.prisma            Trade, TradeStatus (+ migration 20261002000003)
apps/api/src/exchange/orders.ts             exports Moves, credit, debit
apps/api/src/exchange/trades.ts             openTrade, setOffer, confirmTrade, cancelTrade, expireTrades, tradeViews, listTrades
apps/api/src/routes/exchange.ts             /api/exchange/trades…, /api/admin/market
apps/api/src/server.ts                      expiry timer also sweeps idle trades
apps/api/test/trades.test.ts
packages/sdk/src/exchange.ts                ExchangeClient, ExchangeError
packages/sdk/test/exchange.test.ts
apps/frontend/src/panels/TradesPanel.tsx
apps/frontend/src/panels/{ExchangePanel,DiskPanel,AdminPanel}.tsx
apps/frontend/src/game/{exchange,connection}.ts
```

---

### Task 1: Trades in the api

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261002000003_sp5_trades/migration.sql`
- Modify: `apps/api/src/exchange/orders.ts` (add `export` to `class Moves`, `credit`, `debit`)
- Create: `apps/api/src/exchange/trades.ts`, `apps/api/test/trades.test.ts`
- Modify: `apps/api/src/routes/exchange.ts`, `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `Moves`, `credit(tx, moves, operatorId, bits, reason, ref)`, `debit(…)`, `vaultAdd`, `vaultTake`, `feeOn`, `MAX_PRICE`, `MAX_QTY` (orders); `daemonView` (listings); `ChatBlock`.
- Produces: `MAX_OPEN_TRADES = 4`, `TRADE_IDLE_MS`, `MAX_TRADE_DAEMONS = 8`, `MAX_TRADE_ITEMS = 16`, `Offer { bits, items, daemonIds }`; `openTrade(prisma, bus, aId, { id?, name? })`, `setOffer(prisma, bus, operatorId, tradeId, offer, now?)`, `confirmTrade(prisma, bus, operatorId, tradeId, version, now?)`, `cancelTrade(…)`, `expireTrades(prisma, bus, now?) → number`, `tradeViews(prisma, trades, viewerId)`, `listTrades(prisma, operatorId)`.
- REST (cookie or bearer): `GET /api/exchange/trades`, `POST /api/exchange/trades { withId | withName }`, `PUT /api/exchange/trades/:id/offer { bits, items, daemonIds }`, `POST …/:id/confirm { version }`, `POST …/:id/cancel`; each returns the trade view `{ id, status, version, createdAt, updatedAt, me, them }` with sides `{ id, name, confirmed, offer: { bits, items, daemons[] } }`. Errors: 402 `insufficient_bits`, 409 `stale_offer`, 403 (not your trade / blocked), 404, 400.
- Bus: `exchange { kind: 'trade', operators: [aId, bId], detail: { tradeId, status } }` after every mutation; on execution also `admin bits` (net per operator) and one `admin disk` per moved slot.

- [ ] **Step 1: Schema and migration**

`packages/db/prisma/schema.prisma`, before `enum ListingStatus`:

```prisma
enum TradeStatus {
  OPEN
  DONE
  CANCELLED
}

/// Direct trade between two operators (SP5 spec §7). Offers are `{ bits, items: { item: qty }, daemonIds: [] }`.
model Trade {
  id         String      @id
  aId        String
  bId        String
  status     TradeStatus @default(OPEN)
  aOffer     Json
  bOffer     Json
  aConfirmed Boolean     @default(false)
  bConfirmed Boolean     @default(false)
  /// bumped by every offer change; a confirmation must quote it
  version    Int         @default(0)
  createdAt  DateTime    @default(now())
  updatedAt  DateTime    @default(now())

  @@index([aId, status])
  @@index([bId, status])
  @@index([status, updatedAt])
}
```

```sql
-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
    "aOffer" JSONB NOT NULL,
    "bOffer" JSONB NOT NULL,
    "aConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "bConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trade_aId_status_idx" ON "Trade"("aId", "status");

-- CreateIndex
CREATE INDEX "Trade_bId_status_idx" ON "Trade"("bId", "status");

-- CreateIndex
CREATE INDEX "Trade_status_updatedAt_idx" ON "Trade"("status", "updatedAt");
```

Run `pnpm --filter @daemonet/db exec prisma migrate deploy && pnpm --filter @daemonet/db exec prisma generate`.

- [ ] **Step 2: Failing tests**

Create `apps/api/test/trades.test.ts` (the last test also covers Task 3's admin route; it fails until then):

```ts
import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { MAX_OPEN_TRADES, TRADE_IDLE_MS, expireTrades } from '../src/exchange/trades.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Exchange direct trades (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();
  const dev = createDevBearerVerifier('daemonet-users');

  beforeAll(async () => {
    app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: null, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
      // `dev:root` is an admin
      bearer: async (token) => {
        const claims = await dev(token);
        return token === 'dev:root' ? { ...claims, groups: [...claims.groups, 'daemonet-admins'] } : claims;
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Trade", "Listing", "Order", "Fill", "ExchangeVault", "ChatBlock", "BitsLedger", "Session", "Daemon", "Operator" CASCADE');
    bus.log.length = 0;
  });

  let seq = 0;
  async function trader(name: string, bits = 0, vault: Record<string, number> = {}) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/exchange/vault', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits), name } });
    for (const [item, qty] of Object.entries(vault)) await prisma!.exchangeVault.create({ data: { operatorId: op.id, item, qty } });
    const call = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      seed: async (slot: number) => {
        const id = `t-${name}-${seq++}`;
        await prisma!.daemon.create({
          data: {
            id, operatorId: op.id, species: 'initling', level: 5, xp: 0, nature: 0, traitSlot: 0, ivs: [1, 2, 3, 4, 5, 6, 7, 8], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: false, signature: 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: 'DISK', slot,
            moveTypeUses: new Array(16).fill(0), history: [], originalOperatorId: op.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
          },
        });
        return id;
      },
      open: (withId: string) => call('POST', '/trades', { withId }),
      offer: (id: string, o: { bits?: number; items?: Record<string, number>; daemonIds?: string[] }) => call('PUT', `/trades/${id}/offer`, { bits: 0, items: {}, daemonIds: [], ...o }),
      confirm: (id: string, version: number) => call('POST', `/trades/${id}/confirm`, { version }),
      cancel: (id: string) => call('POST', `/trades/${id}/cancel`),
      list: () => call('GET', '/trades'),
      call,
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
      vault: async () => Object.fromEntries((await prisma!.exchangeVault.findMany({ where: { operatorId: op.id } })).map((v) => [v.item, v.qty])),
      disk: async () => (await prisma!.daemon.findMany({ where: { operatorId: op.id, location: 'DISK' }, orderBy: { slot: 'asc' } })).map((d) => `${d.slot}:${d.id}`),
    };
  }
  const lockOf = async (id: string) => (await prisma!.daemon.findUniqueOrThrow({ where: { id } })).lockedBy;

  it('opens trades by id or name, one per pair, respecting blocks and the cap', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    expect((await a.open(a.id)).status).toBe(400);
    expect((await a.open('nobody')).status).toBe(404);
    const made = await a.call('POST', '/trades', { withName: 'bob' });
    expect(made).toMatchObject({ status: 200, body: { status: 'OPEN', version: 0, me: { id: a.id, confirmed: false, offer: { bits: 0, items: {}, daemons: [] } }, them: { id: b.id, name: 'bob' } } });
    expect((await b.open(a.id)).body.message).toMatch(/already have an open trade/);
    expect((await b.list()).body[0]).toMatchObject({ id: made.body.id, me: { id: b.id }, them: { id: a.id } });
    expect(bus.log.at(-1)).toMatchObject({ channel: 'exchange', message: { kind: 'trade', operators: [a.id, b.id], detail: { tradeId: made.body.id, status: 'OPEN' } } });

    const c = await trader('carol');
    await prisma!.chatBlock.create({ data: { blockerId: c.id, blockedId: a.id } });
    expect((await a.open(c.id)).status).toBe(403);
    expect((await c.open(a.id)).status).toBe(200); // the blocker may still start one
    for (let i = 0; i < MAX_OPEN_TRADES - 2; i++) expect((await a.open((await trader(`x${i}`)).id)).status).toBe(200);
    expect((await a.open((await trader('y')).id)).body.message).toMatch(/at most 4/);
    expect((await (await trader('z')).open(a.id)).body.message).toMatch(/too many open trades/);
  });

  it('validates offers, locks offered daemons and clears confirmations on any change', async () => {
    const a = await trader('alice', 100, { 'frag:packet': 5 });
    const b = await trader('bob', 50);
    const d1 = await a.seed(0);
    const d2 = await a.seed(1);
    const { body: t } = await a.open(b.id);
    expect((await a.offer(t.id, { bits: 101 })).status).toBe(402);
    expect((await a.offer(t.id, { items: { 'frag:packet': 6 } })).status).toBe(400);
    expect((await a.offer(t.id, { items: { tap: 1 } })).status).toBe(400); // not tradable
    expect((await a.offer(t.id, { daemonIds: [d1, d1] })).status).toBe(400);
    expect((await b.offer(t.id, { daemonIds: [d1] })).status).toBe(400); // not bob's
    expect((await (await trader('eve')).offer(t.id, { bits: 0 })).status).toBe(403);

    const o1 = await a.offer(t.id, { bits: 40, items: { 'frag:packet': 2 }, daemonIds: [d1, d2] });
    expect(o1.body).toMatchObject({ version: 1, me: { offer: { bits: 40, items: { 'frag:packet': 2 }, daemons: [{ id: d1 }, { id: d2 }] } } });
    expect(await lockOf(d1)).toBe(`trade:${t.id}`);
    expect((await b.confirm(t.id, 0)).body).toMatchObject({ error: 'stale_offer' });
    expect((await b.confirm(t.id, 1)).body).toMatchObject({ status: 'OPEN', me: { confirmed: true }, them: { confirmed: false } });
    // alice takes a daemon back: bob's confirmation is void, the daemon is free again
    const o2 = await a.offer(t.id, { bits: 40, items: { 'frag:packet': 2 }, daemonIds: [d1] });
    expect(o2.body).toMatchObject({ version: 2, me: { confirmed: false }, them: { confirmed: false } });
    expect(await lockOf(d2)).toBeNull();
    // a locked daemon cannot also be listed
    expect((await a.call('POST', '/listings', { daemonId: d1, price: 10 })).status).toBe(400);
    expect((await a.cancel(t.id)).body.status).toBe('CANCELLED');
    expect(await lockOf(d1)).toBeNull();
    expect((await a.offer(t.id, { bits: 1 })).status).toBe(400);
    expect(await a.bits()).toBe(100);
  });

  it('swaps bits (fee on each side), items and daemons atomically when both confirm', async () => {
    const a = await trader('alice', 1000, { 'frag:packet': 5 });
    const b = await trader('bob', 320, { 'frag:heap': 2 });
    const a0 = await a.seed(0);
    const a1 = await a.seed(1);
    const b0 = await b.seed(0);
    await b.seed(1);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { bits: 160, items: { 'frag:packet': 3 }, daemonIds: [a0, a1] });
    const { body: offered } = await b.offer(t.id, { bits: 32, items: { 'frag:heap': 2 }, daemonIds: [b0] });
    expect((await a.confirm(t.id, offered.version)).body.status).toBe('OPEN');
    bus.log.length = 0;
    const done = await b.confirm(t.id, offered.version);
    expect(done.body).toMatchObject({ status: 'DONE', me: { confirmed: true }, them: { confirmed: true } });

    expect(await a.bits()).toBe(1000 - 160 + 30);
    expect(await b.bits()).toBe(320 - 32 + 150);
    expect(await a.vault()).toEqual({ 'frag:packet': 2, 'frag:heap': 2 });
    expect(await b.vault()).toEqual({ 'frag:packet': 3 });
    expect(await a.disk()).toEqual([`0:${b0}`]);
    expect(await b.disk()).toEqual([`0:${a0}`, expect.stringMatching(/^1:t-bob/), `2:${a1}`]);
    const moved = await prisma!.daemon.findUniqueOrThrow({ where: { id: a0 } });
    expect(moved).toMatchObject({ lockedBy: null, originalOperatorId: a.id });
    expect(moved.history).toMatchObject([{ kind: 'traded' }]);
    expect((await prisma!.bitsLedger.findMany({ where: { ref: t.id }, orderBy: { delta: 'asc' } })).map((l) => [l.operatorId === a.id ? 'a' : 'b', Number(l.delta), l.reason])).toEqual([
      ['a', -160, 'exchange:trade'],
      ['b', -32, 'exchange:trade'],
      ['a', 30, 'exchange:trade'],
      ['b', 150, 'exchange:trade'],
    ]);
    const admin = bus.log.filter((m) => m.channel === 'admin').map((m) => m.message);
    expect(admin).toEqual(
      expect.arrayContaining([
        { kind: 'bits', operatorId: a.id, delta: -130, reason: 'exchange', balance: 870 },
        { kind: 'bits', operatorId: b.id, delta: 118, reason: 'exchange', balance: 438 },
        { kind: 'disk', operatorId: a.id, remove: 0 },
        { kind: 'disk', operatorId: a.id, remove: 1 },
        { kind: 'disk', operatorId: b.id, remove: 0 },
        { kind: 'disk', operatorId: b.id, add: 0 },
        { kind: 'disk', operatorId: b.id, add: 2 },
        { kind: 'disk', operatorId: a.id, add: 0 },
      ]),
    );
    expect(admin).toHaveLength(8);
    expect(bus.log.at(-1)!.message).toMatchObject({ kind: 'trade', detail: { status: 'DONE' } });
    expect((await a.confirm(t.id, offered.version)).status).toBe(400); // done is done
  });

  it('rolls everything back when a side can no longer deliver', async () => {
    const a = await trader('alice', 100, { 'frag:packet': 2 });
    const b = await trader('bob', 0);
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    const { body: o } = await a.offer(t.id, { bits: 100, items: { 'frag:packet': 2 }, daemonIds: [d] });
    await b.confirm(t.id, o.version);
    await prisma!.operator.update({ where: { id: a.id }, data: { bits: 99n } }); // spent a bit elsewhere
    expect((await a.confirm(t.id, o.version)).status).toBe(402);
    await prisma!.operator.update({ where: { id: a.id }, data: { bits: 100n } });
    await prisma!.exchangeVault.updateMany({ where: { operatorId: a.id }, data: { qty: 1 } });
    expect((await a.confirm(t.id, o.version)).status).toBe(400);
    expect(await a.bits()).toBe(100);
    expect(await b.bits()).toBe(0);
    expect(await a.disk()).toEqual([`0:${d}`]);
    expect((await a.list()).body[0]).toMatchObject({ status: 'OPEN', me: { confirmed: false }, them: { confirmed: true } });
    // nothing on the table is not a trade
    const c = await trader('carol');
    const { body: empty } = await b.open(c.id);
    await b.confirm(empty.id, 0);
    expect((await c.confirm(empty.id, 0)).body.message).toMatch(/nothing on the table/);
    // a receiver without Disk space
    await prisma!.exchangeVault.updateMany({ where: { operatorId: a.id }, data: { qty: 2 } });
    await prisma!.operator.update({ where: { id: b.id }, data: { diskCapacity: 0 } });
    expect((await a.confirm(t.id, o.version)).body.message).toMatch(/too full/);
    expect(await a.bits()).toBe(100);
  });

  it('cancels trades idle for an hour and frees their daemons', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { daemonIds: [d] });
    expect(await expireTrades(prisma!, bus, new Date(Date.now() + TRADE_IDLE_MS - 60_000))).toBe(0);
    expect(await expireTrades(prisma!, bus, new Date(Date.now() + TRADE_IDLE_MS + 60_000))).toBe(1);
    expect(await lockOf(d)).toBeNull();
    expect((await a.list()).body[0]).toMatchObject({ id: t.id, status: 'CANCELLED' });
  });

  it('shows admins the market: open counts, 24 h volume and destroyed fees', async () => {
    const a = await trader('alice', 1000, { 'frag:packet': 4 });
    const b = await trader('bob', 1000);
    await a.call('POST', '/orders', { item: 'frag:packet', side: 'SELL', price: 50, qty: 4 });
    await b.call('POST', '/orders', { item: 'frag:packet', side: 'BUY', price: 50, qty: 3 });
    const { body: listing } = await a.call('POST', '/listings', { daemonId: await a.seed(0), price: 160 });
    await b.call('POST', `/listings/${listing.id}/buy`);
    await a.open(b.id);
    expect((await app.inject({ method: 'GET', url: '/api/admin/market', headers: { authorization: 'Bearer dev:alice' } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/admin/market', headers: { authorization: 'Bearer dev:root' } });
    expect(r.json()).toMatchObject({
      openOrders: 1, activeListings: 0, openTrades: 1,
      day: { items: [{ item: 'frag:packet', qty: 3, bits: 150, fees: 9, last: 50 }], salesCount: 1, sales: [{ species: 'initling', price: 160 }], trades: 0, feesDestroyed: 19 },
    });
  });
});
```

- [ ] **Step 3: The module**

In `apps/api/src/exchange/orders.ts` export `Moves`, `credit` and `debit`. Create `apps/api/src/exchange/trades.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { Prisma, PrismaClient, Trade } from '@daemonet/db';
import { isTradable } from '@daemonet/rules';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { daemonView } from './listings.js';
import { MAX_PRICE, MAX_QTY, Moves, credit, debit, feeOn, vaultAdd, vaultTake } from './orders.js';

/** Direct trades (SP5 spec §7): two operators put bits, vault items and Disk daemons on the table and both confirm. */
export const MAX_OPEN_TRADES = 4;
export const TRADE_IDLE_MS = 3_600_000;
export const MAX_TRADE_DAEMONS = 8;
export const MAX_TRADE_ITEMS = 16;

type Tx = Prisma.TransactionClient;

export interface Offer {
  bits: number;
  items: Record<string, number>;
  daemonIds: string[];
}
const EMPTY: Offer = { bits: 0, items: {}, daemonIds: [] };
const isEmpty = (o: Offer): boolean => o.bits === 0 && Object.keys(o.items).length === 0 && o.daemonIds.length === 0;
const offerOf = (json: Prisma.JsonValue): Offer => json as unknown as Offer;
const lockOf = (tradeId: string): string => `trade:${tradeId}`;

/** What changed outside the database's view of the sim, collected inside a transaction and announced after it. */
interface Effects {
  moves: Moves;
  disk: Array<{ operatorId: string; add?: number; remove?: number }>;
}

async function announce(prisma: PrismaClient, bus: Bus, trade: Pick<Trade, 'id' | 'aId' | 'bId' | 'status'>, effects?: Effects): Promise<void> {
  if (effects) {
    for (const [operatorId, delta] of effects.moves.bits) {
      if (delta === 0) continue;
      const op = await prisma.operator.findUnique({ where: { id: operatorId }, select: { bits: true } });
      if (op) await bus.publish('admin', { kind: 'bits', operatorId, delta, reason: 'exchange', balance: Number(op.bits) });
    }
    for (const d of effects.disk) await bus.publish('admin', { kind: 'disk', ...d });
  }
  await bus.publish('exchange', { kind: 'trade', operators: [trade.aId, trade.bId], detail: { tradeId: trade.id, status: trade.status } });
}

async function lockTrade(tx: Tx, tradeId: string, operatorId: string): Promise<Trade> {
  await tx.$queryRaw`SELECT 1 FROM "Trade" WHERE "id" = ${tradeId} FOR UPDATE`;
  const trade = await tx.trade.findUnique({ where: { id: tradeId } });
  if (!trade) throw notFound('no such trade');
  if (trade.aId !== operatorId && trade.bId !== operatorId) throw forbidden('not your trade');
  if (trade.status !== 'OPEN') throw badRequest(`trade is ${trade.status.toLowerCase()}`);
  return trade;
}

async function openCount(tx: Tx, operatorId: string): Promise<number> {
  return tx.trade.count({ where: { status: 'OPEN', OR: [{ aId: operatorId }, { bId: operatorId }] } });
}

export async function openTrade(prisma: PrismaClient, bus: Bus, aId: string, target: { id?: string | undefined; name?: string | undefined }): Promise<Trade> {
  const other = target.id ? await prisma.operator.findUnique({ where: { id: target.id }, select: { id: true } }) : target.name ? await prisma.operator.findUnique({ where: { name: target.name }, select: { id: true } }) : null;
  if (!other) throw notFound('no such operator');
  const bId = other.id;
  if (bId === aId) throw badRequest('you cannot trade with yourself');
  const trade = await prisma.$transaction(async (tx) => {
    if (await tx.chatBlock.findUnique({ where: { blockerId_blockedId: { blockerId: bId, blockedId: aId } } })) throw forbidden('that operator is not accepting trades from you');
    if (await tx.trade.findFirst({ where: { status: 'OPEN', OR: [{ aId, bId }, { aId: bId, bId: aId }] } })) throw badRequest('you already have an open trade with that operator');
    if ((await openCount(tx, aId)) >= MAX_OPEN_TRADES) throw badRequest(`at most ${MAX_OPEN_TRADES} open trades`);
    if ((await openCount(tx, bId)) >= MAX_OPEN_TRADES) throw badRequest('that operator has too many open trades');
    return tx.trade.create({ data: { id: crypto.randomUUID(), aId, bId, aOffer: { ...EMPTY }, bOffer: { ...EMPTY } } });
  });
  await announce(prisma, bus, trade);
  return trade;
}

function validateShape(offer: Offer): void {
  if (!Number.isInteger(offer.bits) || offer.bits < 0 || offer.bits > MAX_PRICE * 16) throw badRequest('bits out of range');
  const items = Object.entries(offer.items);
  if (items.length > MAX_TRADE_ITEMS) throw badRequest(`at most ${MAX_TRADE_ITEMS} kinds of item`);
  for (const [item, qty] of items) {
    if (!isTradable(item)) throw badRequest(`${item} cannot be traded`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw badRequest(`quantity of ${item} must be 1-${MAX_QTY}`);
  }
  if (offer.daemonIds.length > MAX_TRADE_DAEMONS) throw badRequest(`at most ${MAX_TRADE_DAEMONS} daemons`);
  if (new Set(offer.daemonIds).size !== offer.daemonIds.length) throw badRequest('a daemon is offered twice');
}

/**
 * Replaces the caller's offer. Bits and items are only checked against the balance and the vault here (and again
 * when the trade executes); daemons are locked to the trade. Any change clears both confirmations and bumps
 * `version`, which a confirmation has to quote — nobody can be made to confirm an offer they have not seen.
 */
export async function setOffer(prisma: PrismaClient, bus: Bus, operatorId: string, tradeId: string, offer: Offer, now = new Date()): Promise<Trade> {
  validateShape(offer);
  const trade = await prisma.$transaction(async (tx) => {
    const t = await lockTrade(tx, tradeId, operatorId);
    const me = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } });
    if (me.bits < BigInt(offer.bits)) throw new AppError(402, 'insufficient_bits', `you do not have ${offer.bits} bits`);
    const vault = new Map((await tx.exchangeVault.findMany({ where: { operatorId } })).map((v) => [v.item, v.qty]));
    for (const [item, qty] of Object.entries(offer.items)) if ((vault.get(item) ?? 0) < qty) throw badRequest(`not enough ${item} in your vault`);
    const lock = lockOf(t.id);
    await tx.daemon.updateMany({ where: { operatorId, lockedBy: lock, id: { notIn: offer.daemonIds } }, data: { lockedBy: null } });
    for (const id of offer.daemonIds) {
      const res = await tx.daemon.updateMany({ where: { id, operatorId, location: 'DISK', OR: [{ lockedBy: null }, { lockedBy: lock }] }, data: { lockedBy: lock } });
      if (res.count !== 1) throw badRequest('a daemon you offered is not on your Disk, or is already on the Exchange');
    }
    const mine = t.aId === operatorId ? { aOffer: offer as unknown as Prisma.InputJsonValue } : { bOffer: offer as unknown as Prisma.InputJsonValue };
    return tx.trade.update({ where: { id: t.id }, data: { ...mine, aConfirmed: false, bConfirmed: false, version: { increment: 1 }, updatedAt: now } });
  });
  await announce(prisma, bus, trade);
  return trade;
}

async function unlockAll(tx: Tx, tradeId: string): Promise<void> {
  await tx.daemon.updateMany({ where: { lockedBy: lockOf(tradeId) }, data: { lockedBy: null } });
}

/** Moves everything on the table. Runs inside the confirming transaction; any failed check rolls the whole trade step back. */
async function execute(tx: Tx, t: Trade, now: Date): Promise<Effects> {
  const effects: Effects = { moves: new Moves(), disk: [] };
  const sides = [
    { from: t.aId, to: t.bId, offer: offerOf(t.aOffer) },
    { from: t.bId, to: t.aId, offer: offerOf(t.bOffer) },
  ];
  if (sides.every((s) => isEmpty(s.offer))) throw badRequest('there is nothing on the table');
  for (const s of sides) {
    if (s.offer.bits > 0) {
      await debit(tx, effects.moves, s.from, s.offer.bits, 'exchange:trade', t.id);
      await credit(tx, effects.moves, s.to, s.offer.bits - feeOn(s.offer.bits), 'exchange:trade', t.id);
    }
    for (const [item, qty] of Object.entries(s.offer.items)) {
      await vaultTake(tx, s.from, item, qty);
      await vaultAdd(tx, s.to, item, qty);
    }
  }
  // Daemons: park every traded daemon on a negative slot first, so two Disks can swap without tripping the
  // (operator, location, slot) unique constraint, then hand each one the receiver's lowest free slot.
  const lock = lockOf(t.id);
  let parked = 0;
  for (const s of sides) {
    for (const id of s.offer.daemonIds) {
      const d = await tx.daemon.findFirst({ where: { id, operatorId: s.from, location: 'DISK', lockedBy: lock }, select: { slot: true } });
      if (!d) throw badRequest('an offered daemon is no longer available');
      effects.disk.push({ operatorId: s.from, remove: d.slot });
      await tx.daemon.update({ where: { id }, data: { slot: -1 - parked++ } });
    }
  }
  for (const s of sides) {
    if (s.offer.daemonIds.length === 0) continue;
    const { diskCapacity } = await tx.operator.findUniqueOrThrow({ where: { id: s.to }, select: { diskCapacity: true } });
    const used = new Set((await tx.daemon.findMany({ where: { operatorId: s.to, location: 'DISK', slot: { gte: 0 } }, select: { slot: true } })).map((d) => d.slot));
    let slot = 0;
    for (const id of s.offer.daemonIds) {
      while (used.has(slot)) slot++;
      if (slot >= diskCapacity) throw badRequest('a Disk is too full to receive the daemons');
      used.add(slot);
      const d = await tx.daemon.findUniqueOrThrow({ where: { id }, select: { history: true } });
      const history = [...(Array.isArray(d.history) ? (d.history as Prisma.JsonArray) : []), { at: now.toISOString(), kind: 'traded', detail: 'traded directly' }];
      await tx.daemon.update({ where: { id }, data: { operatorId: s.to, slot, lockedBy: null, history } });
      effects.disk.push({ operatorId: s.to, add: slot });
    }
  }
  return effects;
}

/** Confirms the offers as of `version`. When both sides have confirmed, the trade executes in the same transaction. */
export async function confirmTrade(prisma: PrismaClient, bus: Bus, operatorId: string, tradeId: string, version: number, now = new Date()): Promise<Trade> {
  const { trade, effects } = await prisma.$transaction(async (tx) => {
    const t = await lockTrade(tx, tradeId, operatorId);
    if (t.version !== version) throw new AppError(409, 'stale_offer', 'the offers changed; look again before confirming');
    const aConfirmed = t.aConfirmed || t.aId === operatorId;
    const bConfirmed = t.bConfirmed || t.bId === operatorId;
    if (!(aConfirmed && bConfirmed)) return { trade: await tx.trade.update({ where: { id: t.id }, data: { aConfirmed, bConfirmed, updatedAt: now } }), effects: undefined };
    const done = await execute(tx, t, now);
    return { trade: await tx.trade.update({ where: { id: t.id }, data: { aConfirmed, bConfirmed, status: 'DONE', updatedAt: now } }), effects: done };
  });
  await announce(prisma, bus, trade, effects);
  return trade;
}

export async function cancelTrade(prisma: PrismaClient, bus: Bus, operatorId: string, tradeId: string, now = new Date()): Promise<Trade> {
  const trade = await prisma.$transaction(async (tx) => {
    const t = await lockTrade(tx, tradeId, operatorId);
    await unlockAll(tx, t.id);
    return tx.trade.update({ where: { id: t.id }, data: { status: 'CANCELLED', updatedAt: now } });
  });
  await announce(prisma, bus, trade);
  return trade;
}

/** Cancels open trades nobody touched for an hour. */
export async function expireTrades(prisma: PrismaClient, bus: Bus, now = new Date()): Promise<number> {
  const idle = await prisma.trade.findMany({ where: { status: 'OPEN', updatedAt: { lte: new Date(now.getTime() - TRADE_IDLE_MS) } }, select: { id: true }, take: 256 });
  let closed = 0;
  for (const { id } of idle) {
    const trade = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Trade" WHERE "id" = ${id} FOR UPDATE`;
      const t = await tx.trade.findUnique({ where: { id } });
      if (!t || t.status !== 'OPEN') return null;
      await unlockAll(tx, id);
      return tx.trade.update({ where: { id }, data: { status: 'CANCELLED', updatedAt: now } });
    });
    if (trade) {
      closed++;
      await announce(prisma, bus, trade);
    }
  }
  return closed;
}

/** Trades as a participant sees them: `me` and `them`, with the offered daemons expanded for inspection. */
export async function tradeViews(prisma: PrismaClient, trades: Trade[], viewerId: string) {
  const offers = trades.flatMap((t) => [offerOf(t.aOffer), offerOf(t.bOffer)]);
  const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: offers.flatMap((o) => o.daemonIds) } } })).map((d) => [d.id, d]));
  const names = new Map((await prisma.operator.findMany({ where: { id: { in: [...new Set(trades.flatMap((t) => [t.aId, t.bId]))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const side = (id: string, offer: Offer, confirmed: boolean) => ({
    id,
    name: names.get(id) ?? null,
    confirmed,
    offer: { bits: offer.bits, items: offer.items, daemons: offer.daemonIds.flatMap((d) => (daemons.has(d) ? [daemonView(daemons.get(d)!)] : [])) },
  });
  return trades.map((t) => {
    const a = side(t.aId, offerOf(t.aOffer), t.aConfirmed);
    const b = side(t.bId, offerOf(t.bOffer), t.bConfirmed);
    const mine = t.aId === viewerId;
    return { id: t.id, status: t.status, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt, me: mine ? a : b, them: mine ? b : a };
  });
}

/** The caller's open trades and their eight most recent closed ones. */
export async function listTrades(prisma: PrismaClient, operatorId: string) {
  const mine = { OR: [{ aId: operatorId }, { bId: operatorId }] };
  const [open, closed] = await Promise.all([
    prisma.trade.findMany({ where: { status: 'OPEN', ...mine }, orderBy: { createdAt: 'asc' } }),
    prisma.trade.findMany({ where: { status: { not: 'OPEN' }, ...mine }, orderBy: { updatedAt: 'desc' }, take: 8 }),
  ]);
  return tradeViews(prisma, [...open, ...closed], operatorId);
}
```

- [ ] **Step 4: Routes and the idle sweep**

`apps/api/src/routes/exchange.ts` — import `cancelTrade, confirmTrade, listTrades, openTrade, setOffer, tradeViews` from `'../exchange/trades.js'`; schemas above `parse`:

```ts
const OpenTradeBody = z.object({ withId: z.string().min(1).max(64).optional(), withName: z.string().min(1).max(32).optional() }).refine((b) => !!b.withId !== !!b.withName, 'give withId or withName');
const OfferBody = z.object({
  bits: z.number().int().min(0),
  items: z.record(z.string().min(1).max(64), z.number().int().min(1).max(MAX_QTY)),
  daemonIds: z.array(z.string().min(1).max(64)).max(8),
});
const ConfirmBody = z.object({ version: z.number().int().min(0) });
```

routes after the listing routes:

```ts
  // ---- direct trades
  const view = async (operatorId: string, trade: Parameters<typeof tradeViews>[1][number]) => (await tradeViews(prisma, [trade], operatorId))[0]!;

  app.get('/api/exchange/trades', auth, async (req) => listTrades(prisma, req.operator!.id));

  app.post('/api/exchange/trades', auth, async (req) => {
    const body = parse(OpenTradeBody, req.body);
    return view(req.operator!.id, await openTrade(prisma, bus, req.operator!.id, { id: body.withId, name: body.withName }));
  });

  app.put<{ Params: { id: string } }>('/api/exchange/trades/:id/offer', auth, async (req) => view(req.operator!.id, await setOffer(prisma, bus, req.operator!.id, req.params.id, parse(OfferBody, req.body))));

  app.post<{ Params: { id: string } }>('/api/exchange/trades/:id/confirm', auth, async (req) => view(req.operator!.id, await confirmTrade(prisma, bus, req.operator!.id, req.params.id, parse(ConfirmBody, req.body).version)));

  app.post<{ Params: { id: string } }>('/api/exchange/trades/:id/cancel', auth, async (req) => view(req.operator!.id, await cancelTrade(prisma, bus, req.operator!.id, req.params.id)));
```

`apps/api/src/server.ts` — import `expireTrades`; the timer function becomes

```ts
const expire = () =>
  Promise.all([expireOrders(prisma, bus), expireListings(prisma), expireTrades(prisma, bus)])
    .then(([orders, listings, trades]) => orders + listings + trades > 0 && app.log.info({ orders, listings, trades }, 'expired exchange orders, listings and trades'))
    .catch((err: Error) => app.log.error({ err: err.message }, 'exchange expiry failed'));
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api/test/trades.test.ts` — expected: 5 passed, 1 failed (admin market, Task 3).

```bash
git add packages/db apps/api
git commit -m "feat(api): direct trades — versioned offers, daemon locks, atomic swap with fee, idle expiry"
```

---

### Task 2: SDK `ExchangeClient`

**Files:**
- Create: `packages/sdk/src/exchange.ts`, `packages/sdk/test/exchange.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- `new ExchangeClient({ baseUrl, auth: TokenSource | 'cookie', fetch? })` with `vault()`, `items()`, `book(item)`, `orders()`, `placeOrder(order)`, `cancelOrder(id)`, `listings(query?)`, `myListings()`, `list(daemonId, price)`, `unlist(listingId)`, `buy(listingId)`, `trades()`, `openTrade({ id } | { name })`, `offer(tradeId, offer)`, `confirm(tradeId, version)`, `cancelTrade(tradeId)`.
- `ExchangeError { status, code, message }`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { devToken } from '../src/auth.js';
import { ExchangeClient, ExchangeError } from '../src/exchange.js';

/** A fetch that records requests and answers from a queue. */
function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown; credentials: string | undefined }> = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined, credentials: init.credentials });
    const a = answers.shift() ?? { body: null };
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe('ExchangeClient', () => {
  it('sends bearer requests to /api/exchange and returns the JSON', async () => {
    const f = fakeFetch([{ body: { 'frag:packet': 3 } }, { body: { order: { id: 'o1', status: 'OPEN', remaining: 2 }, fills: [] } }, { body: { page: 0, more: false, listings: [] } }, { body: { id: 't1', version: 0 } }]);
    const ex = new ExchangeClient({ baseUrl: 'https://daemonet.test/', auth: devToken('bot'), fetch: f.fn });
    expect(await ex.vault()).toEqual({ 'frag:packet': 3 });
    expect((await ex.placeOrder({ item: 'frag:packet', side: 'SELL', price: 20, qty: 2 })).order.id).toBe('o1');
    await ex.listings({ species: 'pingling', clean: true, maxPrice: 500 });
    await ex.openTrade({ name: 'alice' });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://daemonet.test/api/exchange/vault',
      'POST https://daemonet.test/api/exchange/orders',
      'GET https://daemonet.test/api/exchange/listings?species=pingling&clean=true&maxPrice=500',
      'POST https://daemonet.test/api/exchange/trades',
    ]);
    expect(f.calls[0]!.headers).toEqual({ authorization: 'Bearer dev:bot' });
    expect(f.calls[1]).toMatchObject({ headers: { authorization: 'Bearer dev:bot', 'content-type': 'application/json' }, body: { item: 'frag:packet', side: 'SELL', price: 20, qty: 2 } });
    expect(f.calls[3]!.body).toEqual({ withName: 'alice' });
  });

  it('uses the session cookie and the CSRF header in a page', async () => {
    const f = fakeFetch([{ body: [] }, { body: { id: 't1' } }]);
    const ex = new ExchangeClient({ baseUrl: '', auth: 'cookie', fetch: f.fn });
    await ex.trades();
    await ex.confirm('t 1', 4);
    expect(f.calls[0]).toMatchObject({ url: '/api/exchange/trades', credentials: 'include', headers: { 'x-requested-with': 'daemonet' } });
    expect(f.calls[1]).toMatchObject({ url: '/api/exchange/trades/t%201/confirm', body: { version: 4 } });
  });

  it('throws ExchangeError with the api code, or http_error for non-JSON failures', async () => {
    const f = fakeFetch([{ status: 402, body: { error: 'insufficient_bits', message: 'costs 160 bits' } }, { status: 502, body: '<html>bad gateway</html>' }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    const e1 = await ex.buy('l1').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ExchangeError);
    expect(e1).toMatchObject({ status: 402, code: 'insufficient_bits', message: 'insufficient_bits: costs 160 bits' });
    expect(await ex.vault().catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'http_error' });
  });
});
```

- [ ] **Step 2: Implementation**

```ts
import type { TokenSource } from './auth.js';

/** A failed Exchange request: the HTTP status and the api's error code and message. */
export class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ExchangeError';
  }
}

export interface ExchangeClientOptions {
  /** Origin of the Daemonet api, e.g. `https://daemonet.example` (no trailing `/api`). */
  baseUrl: string;
  /** Bots: a token source (device login, `devToken`). Pages served by Daemonet itself: `'cookie'`. */
  auth: TokenSource | 'cookie';
  /** Defaults to the global `fetch` (Node 18+, browsers). */
  fetch?: typeof fetch;
}

export interface ExchangeOffer {
  bits: number;
  items: Record<string, number>;
  daemonIds: string[];
}

export interface ExchangeListingQuery {
  species?: string;
  line?: number;
  type?: string;
  clean?: boolean;
  minSignature?: number;
  maxPrice?: number;
  sort?: 'price' | 'new';
  page?: number;
}

/**
 * REST client for the Exchange (order book, daemon listings, direct trades). Everything it trades lives in the
 * Exchange vault or on Disk; move items in and out at a host with `client.operator.deposit / withdraw`.
 * Responses are returned as the api sends them; failures throw `ExchangeError`.
 */
export class ExchangeClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ExchangeClientOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}/api/exchange`;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, headers };
    if (this.opts.auth === 'cookie') {
      init.credentials = 'include';
      headers['x-requested-with'] = 'daemonet';
    } else {
      headers.authorization = `Bearer ${await this.opts.auth.getToken()}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.doFetch(`${this.base}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: reported below with the status
    }
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; message?: string };
      throw new ExchangeError(res.status, err.error ?? 'http_error', err.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  // ---- vault and order book
  vault() {
    return this.call<Record<string, number>>('GET', '/vault');
  }
  items() {
    return this.call<Array<{ id: string; name: string; bid: number | null; ask: number | null }>>('GET', '/items');
  }
  book(item: string) {
    return this.call<{ item: string; bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }>; fills: Array<{ price: number; qty: number; at: string }> }>('GET', `/book/${encodeURIComponent(item)}`);
  }
  orders() {
    return this.call<Array<{ id: string; item: string; side: 'BUY' | 'SELL'; price: number; qty: number; remaining: number; status: string }>>('GET', '/orders');
  }
  placeOrder(order: { item: string; side: 'BUY' | 'SELL'; price: number; qty: number }) {
    return this.call<{ order: { id: string; status: string; remaining: number }; fills: Array<{ price: number; qty: number; fee: number }> }>('POST', '/orders', order);
  }
  cancelOrder(id: string) {
    return this.call<{ ok: boolean }>('DELETE', `/orders/${encodeURIComponent(id)}`);
  }

  // ---- daemon listings
  listings(query: ExchangeListingQuery = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.call<{ page: number; more: boolean; listings: Array<{ id: string; price: number; sellerId: string; daemon: { id: string; species: string; level: number } & Record<string, unknown> }> }>('GET', `/listings${qs ? `?${qs}` : ''}`);
  }
  myListings() {
    return this.call<Array<{ id: string; price: number; status: string; species: string; level: number }>>('GET', '/listings/mine');
  }
  /** Lists a Disk daemon at a fixed price; it stays on your Disk, locked, until it sells, expires or you `unlist` it. */
  list(daemonId: string, price: number) {
    return this.call<{ id: string; price: number; expiresAt: string }>('POST', '/listings', { daemonId, price });
  }
  unlist(listingId: string) {
    return this.call<{ ok: boolean }>('DELETE', `/listings/${encodeURIComponent(listingId)}`);
  }
  buy(listingId: string) {
    return this.call<{ daemonId: string; slot: number; price: number; fee: number }>('POST', `/listings/${encodeURIComponent(listingId)}/buy`);
  }

  // ---- direct trades
  trades() {
    return this.call<ExchangeTrade[]>('GET', '/trades');
  }
  openTrade(target: { id: string } | { name: string }) {
    return this.call<ExchangeTrade>('POST', '/trades', 'id' in target ? { withId: target.id } : { withName: target.name });
  }
  /** Replaces your offer. Clears both confirmations. */
  offer(tradeId: string, offer: ExchangeOffer) {
    return this.call<ExchangeTrade>('PUT', `/trades/${encodeURIComponent(tradeId)}/offer`, offer);
  }
  /** Confirms the offers as of `version` (from the trade you last looked at); fails with `stale_offer` if they changed since. */
  confirm(tradeId: string, version: number) {
    return this.call<ExchangeTrade>('POST', `/trades/${encodeURIComponent(tradeId)}/confirm`, { version });
  }
  cancelTrade(tradeId: string) {
    return this.call<ExchangeTrade>('POST', `/trades/${encodeURIComponent(tradeId)}/cancel`);
  }
}

interface TradeSide {
  id: string;
  name: string | null;
  confirmed: boolean;
  offer: { bits: number; items: Record<string, number>; daemons: Array<{ id: string; species: string; level: number } & Record<string, unknown>> };
}
export interface ExchangeTrade {
  id: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  version: number;
  createdAt: string;
  updatedAt: string;
  me: TradeSide;
  them: TradeSide;
}
```

`packages/sdk/src/index.ts`:

```ts
export { ExchangeClient, ExchangeError, type ExchangeClientOptions, type ExchangeOffer, type ExchangeListingQuery } from './exchange.js';
```

A bot uses it next to the game connection:

```ts
import { ExchangeClient } from '@daemonet/sdk';
import { deviceLogin } from '@daemonet/sdk/node';

const auth = await deviceLogin({ issuer: process.env.DAEMONET_ISSUER!, clientId: 'daemonet-cli' });
const exchange = new ExchangeClient({ baseUrl: 'https://daemonet.example', auth });
const { asks } = await exchange.book('frag:packet');
if (asks[0] && asks[0].price <= 24) await exchange.placeOrder({ item: 'frag:packet', side: 'BUY', price: asks[0].price, qty: 1 });
```

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b packages/sdk && pnpm exec vitest run packages/sdk` — expected: green (3 new tests).

```bash
git add packages/sdk
git commit -m "feat(sdk): ExchangeClient for the order book, listings and trades"
```

---

### Task 3: Admin market view

**Files:**
- Modify: `apps/api/src/routes/exchange.ts`, `apps/frontend/src/api.ts`, `apps/frontend/src/panels/AdminPanel.tsx`

**Interfaces:**
- `GET /api/admin/market` (admins) → `{ openOrders, activeListings, openTrades, day: { items: [{ item, qty, bits, fees, last }], sales: [{ species, level, price, soldAt }], salesCount, trades, feesDestroyed } }` — `day` covers the last 24 hours; `feesDestroyed` sums order-book and listing fees.

- [ ] **Step 1: Route**

At the end of `registerExchangeRoutes`:

```ts
  /** Admin market view: what is open, what traded in the last 24 hours, and the bits the fee destroyed. */
  app.get('/api/admin/market', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const since = new Date(Date.now() - 86_400_000);
    const [openOrders, activeListings, openTrades, fills, sales, doneTrades] = await Promise.all([
      prisma.order.count({ where: { status: 'OPEN' } }),
      prisma.listing.count({ where: { status: 'ACTIVE' } }),
      prisma.trade.count({ where: { status: 'OPEN' } }),
      prisma.fill.findMany({ where: { at: { gte: since } }, select: { item: true, price: true, qty: true, fee: true } }),
      prisma.listing.findMany({ where: { status: 'SOLD', soldAt: { gte: since } }, orderBy: { soldAt: 'desc' }, select: { species: true, level: true, price: true, soldAt: true } }),
      prisma.trade.count({ where: { status: 'DONE', updatedAt: { gte: since } } }),
    ]);
    const items = new Map<string, { item: string; qty: number; bits: number; fees: number; last: number }>();
    for (const f of fills) {
      let row = items.get(f.item);
      if (!row) items.set(f.item, (row = { item: f.item, qty: 0, bits: 0, fees: 0, last: f.price }));
      row.qty += f.qty;
      row.bits += f.price * f.qty;
      row.fees += f.fee;
    }
    const listingFees = sales.reduce((s, l) => s + Math.floor(l.price / 16), 0);
    return {
      openOrders,
      activeListings,
      openTrades,
      day: {
        items: [...items.values()].sort((a, b) => b.bits - a.bits),
        sales: sales.slice(0, 16),
        salesCount: sales.length,
        trades: doneTrades,
        feesDestroyed: [...items.values()].reduce((s, r) => s + r.fees, 0) + listingFees,
      },
    };
  });
```

Run `DATABASE_URL=... pnpm exec vitest run apps/api/test/trades.test.ts` — expected: 6 passed.

- [ ] **Step 2: Panel**

`apps/frontend/src/api.ts`: the `MarketView` type (shown with the trade types in Task 4), `adminMarket: b.query<MarketView, void>({ query: () => '/admin/market' })`, hook `useAdminMarketQuery`. `apps/frontend/src/panels/AdminPanel.tsx`: add `'market'` to `VIEWS` after `'economy'`, render `{view === 'market' && <Market />}`, and

```tsx
function Market() {
  const market = useAdminMarketQuery(undefined, { pollingInterval: 15_000 });
  if (!market.data) return <p className="text-xs text-neutral-500">loading…</p>;
  const { day } = market.data;
  return (
    <section className="mono space-y-2 text-xs" data-testid="admin-market">
      <p>
        {market.data.openOrders} open orders · {market.data.activeListings} listings · {market.data.openTrades} open trades
      </p>
      <p className="text-neutral-400">
        last 24 h: {day.salesCount} daemons sold · {day.trades} trades · <span className="text-red-300">{day.feesDestroyed} bits destroyed by the fee</span>
      </p>
      {day.items.map((i) => (
        <div key={i.item} className="flex justify-between border-b border-neutral-900 py-0.5">
          <span>{i.item}</span>
          <span>×{i.qty}</span>
          <span>{i.bits} bits</span>
          <span className="text-neutral-500">last {i.last}</span>
        </div>
      ))}
      {day.sales.map((s, i) => (
        <div key={i} className="flex justify-between border-b border-neutral-900 py-0.5 text-neutral-400">
          <span>
            {s.species} L{s.level}
          </span>
          <span>{s.price} bits</span>
          <span className="text-neutral-600">{new Date(s.soldAt).toLocaleTimeString()}</span>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api apps/frontend
git commit -m "feat: admin market view"
```

---

### Task 4: Trades in the client

**Files:**
- Create: `apps/frontend/src/panels/TradesPanel.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/game/exchange.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/panels/ExchangePanel.tsx`, `apps/frontend/src/panels/DiskPanel.tsx`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `tradeChanged` signal (same shape as `listingSold`); hooks `useTradesQuery`, `useOpenTradeMutation`, `useSetOfferMutation`, `useConfirmTradeMutation`, `useCancelTradeMutation`; tag `'Trades'`.
- Test ids: `exchange-trades`, `trades`, `trade-with`, `trade-open`, `trade-<their name>`, `trade-bits`, `trade-item-<item>`, `trade-daemon-<id>`, `trade-offer`, `trade-confirm`, `trade-closed-<their name>`.

- [ ] **Step 1: Signals and api slice**

`apps/frontend/src/game/exchange.ts` — replace the `listingSold` object with

```ts
function signal() {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(): void {
      for (const fn of listeners) fn();
    },
  };
}

/** Fired when one of this operator's daemons changed hands on the Exchange, so open panels can refetch. */
export const listingSold = signal();
/** Fired when one of this operator's direct trades changed (opened, offer, confirmation, done, cancelled). */
export const tradeChanged = signal();
```

`apps/frontend/src/game/connection.ts` — import `tradeChanged`; in the `exchange` handler, between the `listingSold` and `fill` branches:

```ts
      } else if (e.kind === 'trade') {
        const status = (e.detail as { status?: string }).status;
        tradeChanged.emit();
        if (status === 'DONE') {
          listingSold.emit();
          log.push('event', 'Exchange: trade completed');
        } else if (status === 'CANCELLED') {
          log.push('event', 'Exchange: trade cancelled');
        }
```

`apps/frontend/src/api.ts` — types

```ts
export interface TradeSide {
  id: string;
  name: string | null;
  confirmed: boolean;
  offer: { bits: number; items: Record<string, number>; daemons: ListedDaemon[] };
}
export interface Trade {
  id: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  /** bumped by every offer change; quoted when confirming */
  version: number;
  createdAt: string;
  updatedAt: string;
  me: TradeSide;
  them: TradeSide;
}
export interface MarketView {
  openOrders: number;
  activeListings: number;
  openTrades: number;
  day: {
    items: Array<{ item: string; qty: number; bits: number; fees: number; last: number }>;
    sales: Array<{ species: string; level: number; price: number; soldAt: string }>;
    salesCount: number;
    trades: number;
    feesDestroyed: number;
  };
}
```

tag `'Trades'`, endpoints

```ts
    trades: b.query<Trade[], void>({ query: () => '/exchange/trades', providesTags: ['Trades'] }),
    openTrade: b.mutation<Trade, { withId?: string; withName?: string }>({ query: (body) => ({ url: '/exchange/trades', method: 'POST', body }), invalidatesTags: ['Trades'] }),
    setOffer: b.mutation<Trade, { id: string; offer: { bits: number; items: Record<string, number>; daemonIds: string[] } }>({
      query: ({ id, offer }) => ({ url: `/exchange/trades/${id}/offer`, method: 'PUT', body: offer }),
      invalidatesTags: ['Trades', 'Disk'],
    }),
    confirmTrade: b.mutation<Trade, { id: string; version: number }>({
      query: ({ id, version }) => ({ url: `/exchange/trades/${id}/confirm`, method: 'POST', body: { version } }),
      invalidatesTags: ['Trades', 'Disk', 'Vault'],
    }),
    cancelTrade: b.mutation<Trade, string>({ query: (id) => ({ url: `/exchange/trades/${id}/cancel`, method: 'POST', body: {} }), invalidatesTags: ['Trades', 'Disk'] }),
    adminMarket: b.query<MarketView, void>({ query: () => '/admin/market' }),
```

and the hooks.

- [ ] **Step 2: Panel**

Create `apps/frontend/src/panels/TradesPanel.tsx`:

```tsx
import { getSpecies } from '@daemonet/rules';
import { useEffect, useState } from 'react';
import { type Trade, type TradeSide, useCancelTradeMutation, useConfirmTradeMutation, useDiskQuery, useOpenTradeMutation, useSetOfferMutation, useTradesQuery, useVaultQuery } from '../api.ts';
import { ivTotal, listingNet, tradeChanged } from '../game/exchange.ts';
import { log } from '../game/log.ts';

const POLL_MS = 5000;
const fail = (what: string) => (err: unknown) => log.push('reject', `${what}: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);

/** Direct trades (SP5): open one with an operator by name, put bits / vault items / Disk daemons on the table, both confirm. */
export function TradesPanel() {
  const trades = useTradesQuery(undefined, { pollingInterval: POLL_MS });
  const { refetch } = trades;
  useEffect(() => tradeChanged.subscribe(() => void refetch()), [refetch]);
  const [open] = useOpenTradeMutation();
  const [name, setName] = useState('');
  const rows = trades.data ?? [];
  return (
    <div className="space-y-3 text-sm" data-testid="trades">
      <div className="flex gap-1 text-xs">
        <input className="min-w-0 flex-1 rounded bg-neutral-900 px-1" placeholder="operator name" value={name} onChange={(e) => setName(e.target.value)} data-testid="trade-with" />
        <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={!name.trim()} onClick={() => void open({ withName: name.trim() }).unwrap().then(() => setName(''), fail('trade'))} data-testid="trade-open">
          open trade
        </button>
      </div>
      {rows.length === 0 && <p className="text-xs text-neutral-600">no trades</p>}
      {rows.filter((t) => t.status === 'OPEN').map((t) => (
        <TradeCard key={t.id} trade={t} />
      ))}
      <section className="text-xs">
        {rows.filter((t) => t.status !== 'OPEN').map((t) => (
          <div key={t.id} className="mono flex justify-between border-b border-neutral-900 py-0.5 text-neutral-500" data-testid={`trade-closed-${t.them.name ?? t.them.id}`}>
            <span>with {t.them.name ?? 'an operator'}</span>
            <span>{t.status.toLowerCase()}</span>
            <span>{new Date(t.updatedAt).toLocaleString()}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function OfferView({ side }: { side: TradeSide }) {
  const { offer } = side;
  const empty = offer.bits === 0 && Object.keys(offer.items).length === 0 && offer.daemons.length === 0;
  return (
    <div className="mono text-xs text-neutral-300">
      {empty && <span className="text-neutral-600">nothing</span>}
      {offer.bits > 0 && <div>{offer.bits} bits</div>}
      {Object.entries(offer.items).map(([item, qty]) => (
        <div key={item}>
          {item} ×{qty}
        </div>
      ))}
      {offer.daemons.map((d) => (
        <div key={d.id}>
          {getSpecies(d.species).name} L{d.level} · ivs {ivTotal(d.ivs)}
          {d.clean ? ' · clean' : ''}
          {d.signature > 0 ? ` · T${d.signature}` : ''}
        </div>
      ))}
    </div>
  );
}

function TradeCard({ trade }: { trade: Trade }) {
  const vault = useVaultQuery();
  const disk = useDiskQuery();
  const [setOffer, setting] = useSetOfferMutation();
  const [confirm] = useConfirmTradeMutation();
  const [cancel] = useCancelTradeMutation();
  const [bits, setBits] = useState(trade.me.offer.bits);
  const [items, setItems] = useState<Record<string, number>>(trade.me.offer.items);
  const [daemonIds, setDaemonIds] = useState<string[]>(trade.me.offer.daemons.map((d) => d.id));
  const lock = `trade:${trade.id}`;
  const offerable = (disk.data ?? []).filter((d) => !d.lockedBy || d.lockedBy === lock);
  const tag = trade.them.name ?? trade.them.id;

  const setQty = (item: string, qty: number) =>
    setItems((cur) => {
      const next = { ...cur };
      if (qty > 0) next[item] = qty;
      else delete next[item];
      return next;
    });
  const toggle = (id: string) => setDaemonIds((cur) => (cur.includes(id) ? cur.filter((d) => d !== id) : [...cur, id]));

  return (
    <div className="space-y-2 rounded border border-neutral-800 p-2" data-testid={`trade-${tag}`}>
      <div className="flex items-center justify-between text-xs">
        <span>
          with <span className="text-neutral-200">{trade.them.name ?? 'an operator'}</span>
        </span>
        <span className="text-neutral-500">
          {trade.me.confirmed ? 'you confirmed' : 'you have not confirmed'} · {trade.them.confirmed ? 'they confirmed' : 'they have not confirmed'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <h4 className="text-xs uppercase tracking-wide text-neutral-500">they give</h4>
          <OfferView side={trade.them} />
          {trade.them.offer.bits > 0 && <p className="mono text-xs text-neutral-500">you receive {listingNet(trade.them.offer.bits)} after the fee</p>}
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-wide text-neutral-500">you give</h4>
          <OfferView side={trade.me} />
        </div>
      </div>
      <div className="space-y-1 border-t border-neutral-900 pt-1 text-xs">
        <label className="text-neutral-500">
          bits
          <input className="ml-1 w-20 rounded bg-neutral-900 px-1" type="number" min={0} value={bits} onChange={(e) => setBits(Math.max(0, Number(e.target.value) || 0))} data-testid="trade-bits" />
        </label>
        {Object.entries(vault.data ?? {}).map(([item, have]) => (
          <label key={item} className="mono ml-2 text-neutral-500">
            {item}
            <input className="ml-1 w-12 rounded bg-neutral-900 px-1" type="number" min={0} max={have} value={items[item] ?? 0} onChange={(e) => setQty(item, Math.max(0, Math.min(have, Number(e.target.value) || 0)))} data-testid={`trade-item-${item}`} />
            <span className="text-neutral-600">/{have}</span>
          </label>
        ))}
        <div>
          {offerable.map((d) => (
            <label key={d.id} className="mono mr-2 text-neutral-400">
              <input type="checkbox" className="mr-1" checked={daemonIds.includes(d.id)} onChange={() => toggle(d.id)} data-testid={`trade-daemon-${d.id}`} />
              {getSpecies(d.species).name} L{d.level}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={setting.isLoading} onClick={() => void setOffer({ id: trade.id, offer: { bits, items, daemonIds } }).unwrap().catch(fail('offer'))} data-testid="trade-offer">
            set my offer
          </button>
          <button className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40" disabled={trade.me.confirmed} onClick={() => void confirm({ id: trade.id, version: trade.version }).unwrap().catch(fail('confirm'))} data-testid="trade-confirm">
            confirm
          </button>
          <button className="ml-auto text-neutral-500 hover:text-red-300" onClick={() => void cancel(trade.id).unwrap().catch(fail('cancel'))}>
            cancel trade
          </button>
        </div>
        <p className="text-neutral-600">Changing either offer clears both confirmations. Bits you receive lose 1/16 to the fee. Idle trades close after an hour.</p>
      </div>
    </div>
  );
}
```

`apps/frontend/src/panels/ExchangePanel.tsx` — import `TradesPanel`; the wrapper gets a third view:

```tsx
/** The Exchange (SP5): the item market, the daemon listings and direct trades. */
export function ExchangePanel({ client }: { client: GameClient }) {
  const [view, setView] = useState<'items' | 'daemons' | 'trades'>('items');
  return (
    <div className="space-y-3 p-3 text-sm" data-testid="exchange">
      <div className="flex gap-1 text-xs">
        {(['items', 'daemons', 'trades'] as const).map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-700' : 'bg-neutral-900 text-neutral-400'}`} onClick={() => setView(v)} data-testid={`exchange-${v}`}>
            {v}
          </button>
        ))}
      </div>
      {view === 'items' && <ItemMarket client={client} />}
      {view === 'daemons' && <ListingsPanel client={client} />}
      {view === 'trades' && <TradesPanel />}
    </div>
  );
}
```

`apps/frontend/src/panels/DiskPanel.tsx` — the lock badge distinguishes trades:

```tsx
                {d.lockedBy && <span className="ml-1 text-xs text-amber-300">{d.lockedBy.startsWith('trade:') ? 'in a trade' : 'on the Exchange'}</span>}
```

- [ ] **Step 3: End-to-end**

In the two-operator scenario, after the daemon-listing step (B still has two `frag:heap` in the vault, A three):

```ts
  // Direct trade: A pays 32 bits for B's last two heap fragments; both confirm
  await pa.getByTestId('tab-exchange').click();
  await pa.getByTestId('exchange-trades').click();
  await pa.getByTestId('trade-with').fill(`${name}cb`);
  await pa.getByTestId('trade-open').click();
  const cardA = pa.getByTestId(`trade-${name}cb`);
  await cardA.getByTestId('trade-bits').fill('32');
  await cardA.getByTestId('trade-offer').click();
  await pb.getByTestId('tab-exchange').click();
  await pb.getByTestId('exchange-trades').click();
  const cardB = pb.getByTestId(`trade-${name}ca`);
  await expect(cardB).toContainText('you receive 30 after the fee', { timeout: 10_000 });
  await cardB.getByTestId('trade-item-frag:heap').fill('2');
  await cardB.getByTestId('trade-offer').click();
  await expect(cardA).toContainText('frag:heap ×2', { timeout: 10_000 });
  await cardA.getByTestId('trade-confirm').click();
  await expect(cardB).toContainText('they confirmed', { timeout: 10_000 });
  await cardB.getByTestId('trade-confirm').click();
  await expect(pa.getByTestId(`trade-closed-${name}cb`)).toContainText('done', { timeout: 10_000 });
  await pa.getByTestId('exchange-items').click();
  await pa.getByTestId('exchange-item').selectOption('frag:heap');
  await expect(pa.getByTestId('exchange-vault')).toContainText('vault ×5', { timeout: 10_000 });
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 50 files, 399 tests. Build, start the stack, `playwright test` — 4 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): direct trades in the Exchange tab"
```

---

## Self-review

- **Spec coverage:** §7 `Trade` with JSON offers, open / offer / confirm / cancel, validation against vault, Disk and balance, daemon locks, confirmations cleared on any change, execution in one transaction with full re-validation, Disk slots for incoming daemons, fee on each side's bits, 1-hour idle cancel, 4 open trades, bus `trade` events; §8 SDK `ExchangeClient` with every listed method (`client.operator.deposit / withdraw` exist since plan 1), Exchange tab trades view, admin market view. Deviations are listed at the top. This completes SP5.
- **Type consistency:** `tradeViews` (api) ↔ `Trade` / `TradeSide` (client) ↔ `ExchangeTrade` (SDK); `Offer` field names are identical in the zod schema, the module, the SDK and the client mutation; `admin disk` messages have the shape `Game.onAdmin` handles since plan 3.
- **Placeholders:** none.
