# Daemonet SP5 · Plan 3 — Daemon listings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators sell individual daemons at a fixed price: list from the Disk tab (the daemon is locked, not moved), browse with filters in the Exchange tab, buy with one click — bits to the seller minus the 1/16 fee, the daemon onto the buyer's Disk with a `traded` history entry — plus unlist, a 16-listing cap and 7-day expiry.

**Architecture:** A second api module next to the order book (`exchange/listings.ts`). A `Listing` row carries a small snapshot of the daemon for filtering; the daemon itself stays on the seller's Disk with `lockedBy = listing:<id>` (plan 1 already refuses to load locked daemons). Buying is one Postgres transaction that takes the listing row `FOR UPDATE` — two simultaneous buyers queue, the second finds it `SOLD` — then does the guarded bits decrement, the fee-reduced credit, both ledger rows, the ownership / slot / lock / history update and the listing status. After the commit the api tells the sim what changed for operators that are online: the usual `admin bits` pushes, a new `admin { kind: 'disk', add | remove }` push so the sim's in-memory set of occupied Disk slots stays right, and an `exchange { kind: 'listingSold' }` notification.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP5 plans 1–2 merged.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp5-exchange-design.md` §3, §6, §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Bits change only through guarded updates with a `BitsLedger` row (`exchange:buy`, `exchange:sale`); the fee is `floor(price / 16)`, paid by the seller, destroyed.
- ≤ 16 active listings per operator; listings expire after 7 days; price 1 – 1,048,576.
- Only Disk daemons that are not already locked can be listed; a listed daemon cannot be loaded into RAM.

## Deviations from the spec (deliberate)

- `Listing.daemonId` is indexed, not `@unique`: a daemon can be listed again after a cancel, an expiry or a resale, and the old rows are kept as history. "One active listing per daemon" is guaranteed by the lock (`lockedBy IS NULL` in the guarded update).
- The snapshot holds `species, line, types[], level, clean, signature, ivSum` — exactly the columns the filters and sorts use. `nature` and `traitSlot` are read from the live daemon in the browse response instead.
- Browse pages with `page` (32 per page, `more` flag) instead of an opaque cursor; listings are few and sorted by price, where offset paging is stable enough.

## File map

```
packages/db/prisma/schema.prisma            Listing, ListingStatus (+ migration 20261002000002)
apps/api/src/exchange/listings.ts           createListing, cancelListing, buyListing, browseListings, expireListings, freeDiskSlot, daemonView
apps/api/src/routes/exchange.ts             /api/exchange/listings (GET, GET mine, POST, DELETE, POST buy)
apps/api/src/server.ts                      expiry timer also sweeps listings
apps/api/test/listings.test.ts
apps/sim/src/core/model.ts                  history kind 'traded'
apps/sim/src/runtime/game.ts                admin { kind: 'disk' }
apps/sim/src/runtime/prisma-store.ts        Disk-slot unique violation → domain failure
apps/frontend/src/game/exchange.ts          listingNet, ivTotal, listingSold signal
apps/frontend/src/panels/ListingsPanel.tsx  browse / buy / my listings
apps/frontend/src/panels/ExchangePanel.tsx  items | daemons switch
apps/frontend/src/panels/DiskPanel.tsx      list / unlist
```

---

### Task 1: Listings in the api

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261002000002_sp5_listings/migration.sql`
- Create: `apps/api/src/exchange/listings.ts`, `apps/api/test/listings.test.ts`
- Modify: `apps/api/src/routes/exchange.ts`, `apps/api/src/server.ts`

**Interfaces:**
- Consumes (plan 2): `MAX_PRICE`, `feeOn` from `exchange/orders.ts`; `AppError`, `badRequest`, `forbidden`, `notFound`; `Bus.publish`.
- Produces: `MAX_ACTIVE_LISTINGS = 16`, `LISTING_TTL_MS`, `PAGE_SIZE = 32`; `createListing(prisma, sellerId, daemonId, price, now?)`; `cancelListing(prisma, sellerId, listingId)`; `buyListing(prisma, bus, buyerId, listingId, now?) → { daemonId, slot, price, fee }`; `browseListings(prisma, query, now?) → { page, more, listings }`; `expireListings(prisma, now?) → number`; `freeDiskSlot(tx, operatorId) → number | null` and `daemonView(daemon)` (both reused by plan 4).
- REST (cookie or bearer): `GET /api/exchange/listings?species=&line=&type=&clean=&minSignature=&maxPrice=&sort=price|new&page=`, `GET /api/exchange/listings/mine`, `POST /api/exchange/listings { daemonId, price }`, `DELETE /api/exchange/listings/:id`, `POST /api/exchange/listings/:id/buy`. Errors: 402 `insufficient_bits`, 400 (not on Disk / locked / cap / own listing / Disk full / no longer available), 403 not your listing, 404.
- Bus: `admin { kind: 'bits', … }` for buyer and seller, `admin { kind: 'disk', operatorId, add?: slot, remove?: slot }`, `exchange { kind: 'listingSold', operators: [buyerId, sellerId], detail: { listingId, daemonId, species, price, fee, buyerId, sellerId } }`.

- [ ] **Step 1: Schema and migration**

`packages/db/prisma/schema.prisma`, before `enum OrderSide`:

```prisma
enum ListingStatus {
  ACTIVE
  SOLD
  CANCELLED
  EXPIRED
}

/// Fixed-price daemon listing (SP5 spec §6). The daemon stays on the seller's Disk, locked, until sold or released.
model Listing {
  id        String        @id
  sellerId  String
  daemonId  String
  price     Int
  status    ListingStatus @default(ACTIVE)
  /// snapshot for browsing and filters
  species   String
  line      Int
  types     String[]
  level     Int
  clean     Boolean
  signature Int
  ivSum     Int
  createdAt DateTime      @default(now())
  expiresAt DateTime
  buyerId   String?
  soldAt    DateTime?

  @@index([status, price])
  @@index([status, species])
  @@index([sellerId, status])
  @@index([daemonId])
  @@index([status, expiresAt])
}
```

```sql
-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "daemonId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "species" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "types" TEXT[],
    "level" INTEGER NOT NULL,
    "clean" BOOLEAN NOT NULL,
    "signature" INTEGER NOT NULL,
    "ivSum" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "buyerId" TEXT,
    "soldAt" TIMESTAMP(3),

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Listing_status_price_idx" ON "Listing"("status", "price");

-- CreateIndex
CREATE INDEX "Listing_status_species_idx" ON "Listing"("status", "species");

-- CreateIndex
CREATE INDEX "Listing_sellerId_status_idx" ON "Listing"("sellerId", "status");

-- CreateIndex
CREATE INDEX "Listing_daemonId_idx" ON "Listing"("daemonId");

-- CreateIndex
CREATE INDEX "Listing_status_expiresAt_idx" ON "Listing"("status", "expiresAt");
```

Run `pnpm --filter @daemonet/db exec prisma migrate deploy && pnpm --filter @daemonet/db exec prisma generate`.

- [ ] **Step 2: Failing tests**

Create `apps/api/test/listings.test.ts`:

```ts
import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { LISTING_TTL_MS, MAX_ACTIVE_LISTINGS, expireListings } from '../src/exchange/listings.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Exchange daemon listings (needs DATABASE_URL)', () => {
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Listing", "Order", "Fill", "ExchangeVault", "BitsLedger", "Session", "Daemon", "Operator" CASCADE');
    bus.log.length = 0;
  });

  let seq = 0;
  /** An operator driving the api with a dev bearer token; `seed` puts a daemon straight onto their Disk. */
  async function trader(name: string, bits = 0) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/exchange/vault', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    if (bits) await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits) } });
    const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      seed: async (species = 'initling', over: { level?: number; clean?: boolean; signature?: number; location?: 'DISK' | 'RAM' } = {}) => {
        const id = `t-${name}-${seq++}`;
        const used = await prisma!.daemon.count({ where: { operatorId: op.id, location: over.location ?? 'DISK' } });
        await prisma!.daemon.create({
          data: {
            id, operatorId: op.id, species, level: over.level ?? 5, xp: 0, nature: 0, traitSlot: 0, ivs: [1, 2, 3, 4, 5, 6, 7, 8], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: over.clean ?? false, signature: over.signature ?? 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: over.location ?? 'DISK', slot: used,
            moveTypeUses: new Array(16).fill(0), history: [{ at: new Date().toISOString(), kind: 'captured', detail: 'test' }],
            originalOperatorId: op.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
          },
        });
        return id;
      },
      list: (daemonId: string, price: number) => call('POST', '/listings', { daemonId, price }),
      unlist: (id: string) => call('DELETE', `/listings/${id}`),
      buy: (id: string) => call('POST', `/listings/${id}/buy`),
      get: (path: string) => call('GET', path),
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
    };
  }

  it('lists a Disk daemon, locks it, and shows it to browsers with its log', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy');
    const d = await seller.seed('initling', { level: 9 });
    const made = await seller.list(d, 500);
    expect(made.status).toBe(200);
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBe(`listing:${made.body.id}`);
    expect((await seller.list(d, 600)).status).toBe(400); // already on the Exchange
    const ram = await seller.seed('initling', { location: 'RAM' });
    expect((await seller.list(ram, 100)).status).toBe(400); // only from Disk
    expect((await buyer.list(d, 100)).status).toBe(400); // not yours
    expect((await seller.list(await seller.seed(), 0)).status).toBe(400);

    const seen = (await buyer.get('/listings')).body;
    expect(seen.listings).toHaveLength(1);
    expect(seen.listings[0]).toMatchObject({ id: made.body.id, price: 500, sellerId: seller.id, daemon: { id: d, species: 'initling', level: 9, ivs: [1, 2, 3, 4, 5, 6, 7, 8], log: { tool: 'test' } } });
    expect(seen.listings[0].daemon.history).toHaveLength(1);
    expect((await seller.get('/listings/mine')).body[0]).toMatchObject({ id: made.body.id, status: 'ACTIVE', price: 500 });
  });

  it('filters and sorts', async () => {
    const seller = await trader('sel');
    await seller.list(await seller.seed('initling', { clean: true }), 300);
    await seller.list(await seller.seed('initling', { signature: 3 }), 100);
    await seller.list(await seller.seed('bootlet', { level: 20 }), 200);
    const ids = async (q: string) => (await seller.get(`/listings${q}`)).body.listings.map((l: { price: number }) => l.price);
    expect(await ids('')).toEqual([100, 200, 300]);
    expect(await ids('?sort=new')).toEqual([200, 100, 300]);
    expect(await ids('?species=initling')).toEqual([100, 300]);
    expect(await ids('?species=bootlet')).toEqual([200]);
    expect(await ids('?line=1')).toEqual([100, 200, 300]);
    expect(await ids('?clean=true')).toEqual([300]);
    expect(await ids('?minSignature=2')).toEqual([100]);
    expect(await ids('?maxPrice=200')).toEqual([100, 200]);
    expect(await ids('?type=kernel')).toEqual([100, 200, 300]);
    expect(await ids('?type=shell')).toEqual([]);
    expect((await seller.get('/listings?clean=maybe')).status).toBe(400);
  });

  it('sells: bits minus the fee, ownership, slot, history, lock, notifications', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 1000);
    await buyer.seed(); // occupies the buyer's Disk slot 0
    const d = await seller.seed('initling');
    const { body: made } = await seller.list(d, 160);
    expect((await seller.buy(made.id)).status).toBe(400); // own listing
    const poor = await trader('poor', 159);
    expect((await poor.buy(made.id)).body).toMatchObject({ error: 'insufficient_bits' });

    const bought = await buyer.buy(made.id);
    expect(bought).toMatchObject({ status: 200, body: { daemonId: d, slot: 1, price: 160, fee: 10 } });
    expect(await buyer.bits()).toBe(840);
    expect(await seller.bits()).toBe(150);
    const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: d } });
    expect(row).toMatchObject({ operatorId: buyer.id, location: 'DISK', slot: 1, lockedBy: null, originalOperatorId: seller.id });
    expect((row.history as Array<{ kind: string }>).map((h) => h.kind)).toEqual(['captured', 'traded']);
    expect(await prisma!.bitsLedger.findMany({ where: { ref: made.id }, orderBy: { delta: 'asc' }, select: { operatorId: true, delta: true, reason: true } })).toEqual([
      { operatorId: buyer.id, delta: -160n, reason: 'exchange:buy' },
      { operatorId: seller.id, delta: 150n, reason: 'exchange:sale' },
    ]);
    expect(bus.log.filter((m) => m.channel === 'admin').map((m) => m.message)).toEqual([
      { kind: 'bits', operatorId: buyer.id, delta: -160, reason: 'exchange', balance: 840 },
      { kind: 'bits', operatorId: seller.id, delta: 150, reason: 'exchange', balance: 150 },
      { kind: 'disk', operatorId: buyer.id, add: 1 },
      { kind: 'disk', operatorId: seller.id, remove: 0 },
    ]);
    expect(bus.log.find((m) => m.channel === 'exchange')!.message).toMatchObject({ kind: 'listingSold', operators: [buyer.id, seller.id], detail: { species: 'initling', price: 160, fee: 10 } });

    expect((await buyer.get('/listings')).body.listings).toEqual([]);
    expect((await seller.get('/listings/mine')).body[0]).toMatchObject({ status: 'SOLD', daemon: null });
    expect((await poor.buy(made.id)).status).toBe(400); // gone
    // the new owner can sell it on
    expect((await buyer.list(d, 200)).status).toBe(200);
  });

  it('sells to exactly one of two simultaneous buyers', async () => {
    const seller = await trader('sel');
    const a = await trader('a', 500);
    const b = await trader('b', 500);
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 320);
    const results = await Promise.all([a.buy(made.id), b.buy(made.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await a.bits()) + (await b.bits())).toBe(680);
    expect(await seller.bits()).toBe(300);
  });

  it('refuses a buyer whose Disk is full', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 500);
    await prisma!.operator.update({ where: { id: buyer.id }, data: { diskCapacity: 1 } });
    await buyer.seed();
    const { body: made } = await seller.list(await seller.seed(), 100);
    expect((await buyer.buy(made.id)).body.message).toMatch(/Disk is full/);
    expect(await buyer.bits()).toBe(500);
  });

  it('cancels, expires and caps active listings', async () => {
    const seller = await trader('sel');
    const other = await trader('oth');
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 100);
    expect((await other.unlist(made.id)).status).toBe(403);
    expect((await seller.unlist(made.id)).status).toBe(200);
    expect((await seller.unlist(made.id)).status).toBe(400);
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBeNull();

    const { body: again } = await seller.list(d, 120); // the same daemon can be listed again
    expect(await expireListings(prisma!, new Date(Date.now() + LISTING_TTL_MS - 1000))).toBe(0);
    expect(await expireListings(prisma!, new Date(Date.now() + LISTING_TTL_MS + 1000))).toBe(1);
    expect((await prisma!.listing.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('EXPIRED');
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBeNull();
    expect((await other.buy(again.id)).status).toBe(400);

    for (let i = 0; i < MAX_ACTIVE_LISTINGS; i++) expect((await seller.list(await seller.seed(), 10 + i)).status).toBe(200);
    expect((await seller.list(await seller.seed(), 10)).body.message).toMatch(/at most 16/);
  });
});
```

Run `DATABASE_URL=... pnpm exec vitest run apps/api/test/listings.test.ts` — expected: FAIL (`../src/exchange/listings.js` does not exist).

- [ ] **Step 3: The module**

Create `apps/api/src/exchange/listings.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { Daemon, Prisma, PrismaClient } from '@daemonet/db';
import { getSpecies } from '@daemonet/rules';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { MAX_PRICE, feeOn } from './orders.js';

/** Daemon listings (SP5 spec §6): fixed price, from Disk, locked while listed. */
export const MAX_ACTIVE_LISTINGS = 16;
export const LISTING_TTL_MS = 7 * 86_400_000;

type Tx = Prisma.TransactionClient;

export interface ListingQuery {
  species?: string | undefined;
  line?: number | undefined;
  type?: string | undefined;
  clean?: boolean | undefined;
  minSignature?: number | undefined;
  maxPrice?: number | undefined;
  sort?: 'price' | 'new' | undefined;
  page?: number | undefined;
}

export const PAGE_SIZE = 32;

/** The daemon as buyers see it: everything that makes it worth its price, including the capture log and history. */
export function daemonView(d: Daemon) {
  return {
    id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus, clean: d.clean, signature: d.signature,
    moves: d.moves, heldItem: d.heldItem, patched: d.patched, crashes: d.crashes, arenaWins: d.arenaWins, history: d.history,
    log: { originalOperatorId: d.originalOperatorId, capturedAt: d.capturedAt, subnet: d.captureSubnet, tool: d.captureTool, spawnIndex: d.spawnIndex },
  };
}

export async function createListing(prisma: PrismaClient, sellerId: string, daemonId: string, price: number, now = new Date()) {
  if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw badRequest(`price must be 1-${MAX_PRICE}`);
  return prisma.$transaction(async (tx) => {
    if ((await tx.listing.count({ where: { sellerId, status: 'ACTIVE' } })) >= MAX_ACTIVE_LISTINGS) throw badRequest(`at most ${MAX_ACTIVE_LISTINGS} active listings`);
    const id = crypto.randomUUID();
    const locked = await tx.daemon.updateMany({ where: { id: daemonId, operatorId: sellerId, location: 'DISK', lockedBy: null }, data: { lockedBy: `listing:${id}` } });
    if (locked.count !== 1) throw badRequest('that daemon is not on your Disk, or is already on the Exchange');
    const d = await tx.daemon.findUniqueOrThrow({ where: { id: daemonId } });
    const sp = getSpecies(d.species);
    return tx.listing.create({
      data: {
        id, sellerId, daemonId, price, species: d.species, line: sp.line, types: [...sp.types], level: d.level, clean: d.clean, signature: d.signature,
        ivSum: d.ivs.reduce((a, b) => a + b, 0), createdAt: now, expiresAt: new Date(now.getTime() + LISTING_TTL_MS),
      },
    });
  });
}

async function close(tx: Tx, listing: { id: string; daemonId: string }, status: 'CANCELLED' | 'EXPIRED'): Promise<void> {
  await tx.daemon.updateMany({ where: { id: listing.daemonId, lockedBy: `listing:${listing.id}` }, data: { lockedBy: null } });
  await tx.listing.update({ where: { id: listing.id }, data: { status } });
}

export async function cancelListing(prisma: PrismaClient, sellerId: string, listingId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; sellerId: string; daemonId: string; status: string }>>`SELECT "id", "sellerId", "daemonId", "status" FROM "Listing" WHERE "id" = ${listingId} FOR UPDATE`;
    const listing = rows[0];
    if (!listing) throw notFound('no such listing');
    if (listing.sellerId !== sellerId) throw forbidden('not your listing');
    if (listing.status !== 'ACTIVE') throw badRequest(`listing is ${listing.status.toLowerCase()}`);
    await close(tx, listing, 'CANCELLED');
  });
}

export async function expireListings(prisma: PrismaClient, now = new Date()): Promise<number> {
  const due = await prisma.listing.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true }, take: 256 });
  let closed = 0;
  for (const d of due) {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; daemonId: string; status: string }>>`SELECT "id", "daemonId", "status" FROM "Listing" WHERE "id" = ${d.id} FOR UPDATE`;
      if (rows[0]?.status !== 'ACTIVE') return;
      await close(tx, rows[0], 'EXPIRED');
      closed++;
    });
  }
  return closed;
}

/** Lowest free Disk slot of an operator, or null when the Disk is full. */
export async function freeDiskSlot(tx: Tx, operatorId: string): Promise<number | null> {
  const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { diskCapacity: true } });
  const used = new Set((await tx.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((d) => d.slot));
  for (let s = 0; s < op.diskCapacity; s++) if (!used.has(s)) return s;
  return null;
}

/**
 * Buys a listing: one transaction moves the bits (seller pays the 1/16 fee), the daemon (new owner, free Disk
 * slot, lock cleared, `traded` history entry) and closes the listing. The row lock makes concurrent buyers
 * queue; the second one finds it SOLD.
 */
export async function buyListing(prisma: PrismaClient, bus: Bus, buyerId: string, listingId: string, now = new Date()) {
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; sellerId: string; daemonId: string; price: number; status: string; expiresAt: Date }>>`SELECT "id", "sellerId", "daemonId", "price", "status", "expiresAt" FROM "Listing" WHERE "id" = ${listingId} FOR UPDATE`;
    const listing = rows[0];
    if (!listing) throw notFound('no such listing');
    if (listing.status !== 'ACTIVE' || listing.expiresAt <= now) throw badRequest('that listing is no longer available');
    if (listing.sellerId === buyerId) throw badRequest('that is your own listing');
    const slot = await freeDiskSlot(tx, buyerId);
    if (slot === null) throw badRequest('your Disk is full');
    const paid = await tx.operator.updateMany({ where: { id: buyerId, bits: { gte: BigInt(listing.price) } }, data: { bits: { decrement: BigInt(listing.price) } } });
    if (paid.count !== 1) throw new AppError(402, 'insufficient_bits', `costs ${listing.price} bits`);
    await tx.bitsLedger.create({ data: { operatorId: buyerId, delta: BigInt(-listing.price), reason: 'exchange:buy', ref: listing.id } });
    const fee = feeOn(listing.price);
    await tx.operator.update({ where: { id: listing.sellerId }, data: { bits: { increment: BigInt(listing.price - fee) } } });
    await tx.bitsLedger.create({ data: { operatorId: listing.sellerId, delta: BigInt(listing.price - fee), reason: 'exchange:sale', ref: listing.id } });
    const daemon = await tx.daemon.findUniqueOrThrow({ where: { id: listing.daemonId } });
    const sellerSlot = daemon.slot;
    const history = [...(Array.isArray(daemon.history) ? (daemon.history as Prisma.JsonArray) : []), { at: now.toISOString(), kind: 'traded', detail: `sold on the Exchange for ${listing.price} bits` }];
    await tx.daemon.update({ where: { id: daemon.id }, data: { operatorId: buyerId, slot, lockedBy: null, history } });
    await tx.listing.update({ where: { id: listing.id }, data: { status: 'SOLD', buyerId, soldAt: now } });
    const [buyer, seller] = await Promise.all([
      tx.operator.findUniqueOrThrow({ where: { id: buyerId }, select: { bits: true } }),
      tx.operator.findUniqueOrThrow({ where: { id: listing.sellerId }, select: { bits: true } }),
    ]);
    return { listing, fee, slot, sellerSlot, daemonId: daemon.id, species: daemon.species, buyerBits: Number(buyer.bits), sellerBits: Number(seller.bits) };
  });
  const { listing, fee } = result;
  // the sim keeps balances and occupied Disk slots of online operators in memory: tell it what moved
  await bus.publish('admin', { kind: 'bits', operatorId: buyerId, delta: -listing.price, reason: 'exchange', balance: result.buyerBits });
  await bus.publish('admin', { kind: 'bits', operatorId: listing.sellerId, delta: listing.price - fee, reason: 'exchange', balance: result.sellerBits });
  await bus.publish('admin', { kind: 'disk', operatorId: buyerId, add: result.slot });
  await bus.publish('admin', { kind: 'disk', operatorId: listing.sellerId, remove: result.sellerSlot });
  await bus.publish('exchange', { kind: 'listingSold', operators: [buyerId, listing.sellerId], detail: { listingId: listing.id, daemonId: result.daemonId, species: result.species, price: listing.price, fee, buyerId, sellerId: listing.sellerId } });
  return { daemonId: result.daemonId, slot: result.slot, price: listing.price, fee };
}

export async function browseListings(prisma: PrismaClient, q: ListingQuery, now = new Date()) {
  const where: Prisma.ListingWhereInput = {
    status: 'ACTIVE',
    expiresAt: { gt: now },
    ...(q.species ? { species: q.species } : {}),
    ...(q.line !== undefined ? { line: q.line } : {}),
    ...(q.type ? { types: { has: q.type } } : {}),
    ...(q.clean !== undefined ? { clean: q.clean } : {}),
    ...(q.minSignature !== undefined ? { signature: { gte: q.minSignature } } : {}),
    ...(q.maxPrice !== undefined ? { price: { lte: q.maxPrice } } : {}),
  };
  const page = Math.max(0, q.page ?? 0);
  const rows = await prisma.listing.findMany({ where, orderBy: q.sort === 'new' ? [{ createdAt: 'desc' }] : [{ price: 'asc' }, { createdAt: 'asc' }], skip: page * PAGE_SIZE, take: PAGE_SIZE + 1 });
  const shown = rows.slice(0, PAGE_SIZE);
  const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: shown.map((r) => r.daemonId) } } })).map((d) => [d.id, d]));
  const sellers = new Map((await prisma.operator.findMany({ where: { id: { in: [...new Set(shown.map((r) => r.sellerId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  return {
    page,
    more: rows.length > PAGE_SIZE,
    listings: shown.flatMap((r) => {
      const d = daemons.get(r.daemonId);
      return d ? [{ id: r.id, price: r.price, sellerId: r.sellerId, sellerName: sellers.get(r.sellerId) ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt, daemon: daemonView(d) }] : [];
    }),
  };
}
```

- [ ] **Step 4: Routes and expiry**

`apps/api/src/routes/exchange.ts` — import `browseListings, buyListing, cancelListing, createListing, daemonView` from `'../exchange/listings.js'`; add the schemas above `parse`:

```ts
const ListBody = z.object({ daemonId: z.string().min(1).max(64), price: z.number().int().min(1).max(MAX_PRICE) });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const BrowseQuery = z.object({
  species: z.string().max(32).optional(),
  line: z.coerce.number().int().min(1).max(50).optional(),
  type: z.string().max(16).optional(),
  clean: bool.optional(),
  minSignature: z.coerce.number().int().min(0).max(15).optional(),
  maxPrice: z.coerce.number().int().min(1).optional(),
  sort: z.enum(['price', 'new']).optional(),
  page: z.coerce.number().int().min(0).max(1000).optional(),
});
```

and the routes after `DELETE /api/exchange/orders/:id`:

```ts
  // ---- daemon listings
  app.get('/api/exchange/listings', auth, async (req) => browseListings(prisma, parse(BrowseQuery, req.query)));

  app.get('/api/exchange/listings/mine', auth, async (req) => {
    const rows = await prisma.listing.findMany({ where: { sellerId: req.operator!.id }, orderBy: { createdAt: 'desc' }, take: 64 });
    const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: rows.map((r) => r.daemonId) } } })).map((d) => [d.id, d]));
    return rows.map((r) => ({ id: r.id, price: r.price, status: r.status, species: r.species, level: r.level, createdAt: r.createdAt, expiresAt: r.expiresAt, soldAt: r.soldAt, daemon: daemons.has(r.daemonId) && r.status === 'ACTIVE' ? daemonView(daemons.get(r.daemonId)!) : null }));
  });

  app.post('/api/exchange/listings', auth, async (req) => {
    const body = parse(ListBody, req.body);
    const l = await createListing(prisma, req.operator!.id, body.daemonId, body.price);
    return { id: l.id, price: l.price, expiresAt: l.expiresAt };
  });

  app.delete<{ Params: { id: string } }>('/api/exchange/listings/:id', auth, async (req) => {
    await cancelListing(prisma, req.operator!.id, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/exchange/listings/:id/buy', auth, async (req) => buyListing(prisma, bus, req.operator!.id, req.params.id));
```

`apps/api/src/server.ts` — import `expireListings` and replace the `expire` function so the 5-minute timer sweeps both:

```ts
const expire = () =>
  Promise.all([expireOrders(prisma, bus), expireListings(prisma)])
    .then(([orders, listings]) => orders + listings > 0 && app.log.info({ orders, listings }, 'expired exchange orders and listings'))
    .catch((err: Error) => app.log.error({ err: err.message }, 'exchange expiry failed'));
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green (6 listing tests, including two simultaneous buyers).

```bash
git add packages/db apps/api
git commit -m "feat(api): Exchange daemon listings — lock, browse, buy with fee, cancel and expiry"
```

---

### Task 2: The sim keeps up with Disk changes

A sale changes two Disks behind the sim's back. The sim only tracks *which slots are taken* (`op.diskSlots`, used to pick the slot for the next capture or `store`), so the api pushes exactly that. A push can still lose a race with a capture in the same instant; the `@@unique([operatorId, location, slot])` constraint then rejects the intent, and that must be a clean domain failure rather than a store outage.

**Files:**
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/runtime/game.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/test/exchange.test.ts`

- [ ] **Step 1: Failing test**

Append to the `describe` in `apps/sim/test/exchange.test.ts`:

```ts
  it('tracks Disk slots that changed hands through the Exchange (admin `disk` messages)', async () => {
    const bus = new MemoryBus();
    const world = new World({ subnet: TEST_SUBNET, seed: 'x', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store: new MemoryStore(), verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:carol' } }));
    const id = conn.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 0 });
    await bus.publish('admin', { kind: 'disk', operatorId: id, add: 1 });
    expect([...op.diskSlots]).toEqual([0, 1]); // the next capture or store goes to slot 2
    await bus.publish('admin', { kind: 'disk', operatorId: id, remove: 0 });
    await bus.publish('admin', { kind: 'disk', operatorId: 'someone-offline', add: 5 });
    expect([...op.diskSlots]).toEqual([1]);
    await game.shutdown();
  });
```

Run `pnpm exec vitest run apps/sim/test/exchange.test.ts` — expected: FAIL (`diskSlots` stays empty).

- [ ] **Step 2: Implementation**

`apps/sim/src/core/model.ts`: add `'traded'` to the `kind` union of the daemon history entry.

`apps/sim/src/runtime/game.ts`: widen `onAdmin`'s parameter type with `add?: number; remove?: number` and add, before the `rename` branch:

```ts
    if (m.kind === 'disk') {
      // a daemon arrived on (or left) this operator's Disk through the Exchange
      if (typeof m.add === 'number') op.diskSlots.add(m.add);
      if (typeof m.remove === 'number') op.diskSlots.delete(m.remove);
    }
```

`apps/sim/src/runtime/prisma-store.ts`, in `applyIntent`'s catch block next to the `claimStarter` case:

```ts
      if ((intent.kind === 'store' || intent.kind === 'capture') && isUniqueViolation(err)) return { ok: false, reason: 'that Disk slot was just taken; try again' };
```

(The world already reverts the optimistic slot reservation when an intent fails.)

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b && pnpm exec vitest run apps/sim` — expected: green.

```bash
git add apps/sim
git commit -m "feat(sim): track Disk slots that change hands on the Exchange"
```

---

### Task 3: Client — list from Disk, browse and buy

**Files:**
- Create: `apps/frontend/src/panels/ListingsPanel.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/game/exchange.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/panels/ExchangePanel.tsx`, `apps/frontend/src/panels/DiskPanel.tsx`, `apps/frontend/test/exchange.test.tsx`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `listingNet(price)`, `ivTotal(ivs)`, `listingSold.subscribe(fn) / emit()`.
- Hooks `useListingsQuery(query)`, `useMyListingsQuery()`, `useListDaemonMutation()`, `useUnlistMutation()`, `useBuyListingMutation()`; tag `'Listings'`.
- Test ids: `exchange-items`, `exchange-daemons`, `listings`, `listing-<daemonId>`, `buy-<daemonId>`, `my-listings`, `listing-species`, `list-<daemonId>`, `list-price`, `list-confirm`, `unlist-<daemonId>`.

- [ ] **Step 1: Failing unit test**

`apps/frontend/test/exchange.test.tsx` — import `ivTotal, listingNet` and add to the first test:

```ts
    expect(listingNet(160)).toBe(150);
    expect(ivTotal([1, 2, 3, 4, 5, 6, 7, 8])).toBe(36);
```

- [ ] **Step 2: Helpers and api slice**

`apps/frontend/src/game/exchange.ts`, above `orderPreview`:

```ts
/** What a daemon listing brings its seller after the fee. */
export function listingNet(price: number): number {
  return price - feeOn(price);
}

export function ivTotal(ivs: readonly number[]): number {
  return ivs.reduce((a, b) => a + b, 0);
}

/** Fired when one of this operator's daemons changed hands on the Exchange, so open panels can refetch. */
export const listingSold = {
  listeners: new Set<() => void>(),
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  },
  emit(): void {
    for (const fn of this.listeners) fn();
  },
};
```

`apps/frontend/src/api.ts` — types:

```ts
export interface ListedDaemon {
  id: string;
  species: string;
  level: number;
  nature: number;
  traitSlot: number;
  ivs: number[];
  clean: boolean;
  signature: number;
  moves: string[];
  heldItem: string | null;
  patched: boolean;
  crashes: number;
  arenaWins: number;
  history: Array<{ at: string; kind: string; detail: string }>;
  log: { originalOperatorId: string; capturedAt: string; subnet: string; tool: string; spawnIndex: number | null };
}
export interface Listing {
  id: string;
  price: number;
  sellerId: string;
  sellerName: string | null;
  createdAt: string;
  expiresAt: string;
  daemon: ListedDaemon;
}
export interface MyListing {
  id: string;
  price: number;
  status: 'ACTIVE' | 'SOLD' | 'CANCELLED' | 'EXPIRED';
  species: string;
  level: number;
  createdAt: string;
  expiresAt: string;
  soldAt: string | null;
}
export interface ListingQuery {
  species?: string | undefined;
  type?: string | undefined;
  clean?: boolean | undefined;
  minSignature?: number | undefined;
  maxPrice?: number | undefined;
  sort?: 'price' | 'new' | undefined;
  page?: number | undefined;
}
```

tag `'Listings'`, endpoints:

```ts
    listings: b.query<{ page: number; more: boolean; listings: Listing[] }, ListingQuery>({
      query: (q) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
        return `/exchange/listings?${params.toString()}`;
      },
      providesTags: ['Listings'],
    }),
    myListings: b.query<MyListing[], void>({ query: () => '/exchange/listings/mine', providesTags: ['Listings'] }),
    listDaemon: b.mutation<{ id: string; price: number; expiresAt: string }, { daemonId: string; price: number }>({
      query: (body) => ({ url: '/exchange/listings', method: 'POST', body }),
      invalidatesTags: ['Listings', 'Disk'],
    }),
    unlist: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `/exchange/listings/${id}`, method: 'DELETE' }), invalidatesTags: ['Listings', 'Disk'] }),
    buyListing: b.mutation<{ daemonId: string; slot: number; price: number; fee: number }, string>({
      query: (id) => ({ url: `/exchange/listings/${id}/buy`, method: 'POST' }),
      invalidatesTags: ['Listings', 'Disk'],
    }),
```

and the five hooks in the export list.

- [ ] **Step 3: Panels**

Create `apps/frontend/src/panels/ListingsPanel.tsx`:

```tsx
import { TYPES, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { type ListingQuery, useBuyListingMutation, useListingsQuery, useMyListingsQuery, useUnlistMutation } from '../api.ts';
import { ivTotal, listingNet } from '../game/exchange.ts';
import { log } from '../game/log.ts';
import { SpriteImg } from './RamPanel.tsx';

const POLL_MS = 8000;

/** Daemon listings (SP5): browse with filters, buy to your Disk, and manage your own listings (made from the Disk tab). */
export function ListingsPanel({ client }: { client: GameClient }) {
  const [query, setQuery] = useState<ListingQuery>({ sort: 'price', page: 0 });
  const listings = useListingsQuery(query, { pollingInterval: POLL_MS });
  const mine = useMyListingsQuery(undefined, { pollingInterval: POLL_MS });
  const [buy, buying] = useBuyListingMutation();
  const [unlist] = useUnlistMutation();
  const [open, setOpen] = useState<string | null>(null);
  const me = client.self;
  const set = (patch: Partial<ListingQuery>) => setQuery((q) => ({ ...q, ...patch, page: patch.page ?? 0 }));

  const purchase = async (id: string, species: string) => {
    try {
      const r = await buy(id).unwrap();
      log.push('event', `bought ${species} for ${r.price} bits (Disk slot ${r.slot})`);
    } catch (err) {
      log.push('reject', `buy: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);
    }
  };

  return (
    <div className="space-y-3 text-sm" data-testid="listings">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <input className="w-24 rounded bg-neutral-900 px-1" placeholder="species" value={query.species ?? ''} onChange={(e) => set({ species: e.target.value.trim().toLowerCase() || undefined })} data-testid="listing-species" />
        <select className="rounded bg-neutral-800 px-1 py-0.5" value={query.type ?? ''} onChange={(e) => set({ type: e.target.value || undefined })}>
          <option value="">any type</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="text-neutral-500">
          <input type="checkbox" className="mr-1" checked={query.clean === true} onChange={(e) => set({ clean: e.target.checked ? true : undefined })} />
          clean
        </label>
        <label className="text-neutral-500">
          sig ≥
          <input className="ml-1 w-10 rounded bg-neutral-900 px-1" type="number" min={0} max={15} value={query.minSignature ?? 0} onChange={(e) => set({ minSignature: Number(e.target.value) || undefined })} />
        </label>
        <label className="text-neutral-500">
          max
          <input className="ml-1 w-16 rounded bg-neutral-900 px-1" type="number" min={1} value={query.maxPrice ?? ''} onChange={(e) => set({ maxPrice: Number(e.target.value) || undefined })} />
        </label>
        <select className="rounded bg-neutral-800 px-1 py-0.5" value={query.sort ?? 'price'} onChange={(e) => set({ sort: e.target.value as 'price' | 'new' })}>
          <option value="price">cheapest</option>
          <option value="new">newest</option>
        </select>
        <span className="mono ml-auto text-neutral-500">{me.bits} bits</span>
      </div>

      <section className="space-y-1">
        {listings.data?.listings.length === 0 && <p className="text-xs text-neutral-600">no listings match</p>}
        {listings.data?.listings.map((l) => {
          const sp = getSpecies(l.daemon.species);
          const own = l.sellerId === client.operatorId;
          return (
            <div key={l.id} className="rounded border border-neutral-800 p-2" data-testid={`listing-${l.daemon.id}`}>
              <div className="flex gap-2">
                <SpriteImg species={l.daemon.species} types={sp.types} clean={l.daemon.clean} signature={l.daemon.signature} />
                <div className="min-w-0 flex-1">
                  <div>
                    <span className="font-medium">{sp.name}</span> <span className="text-neutral-500">L{l.daemon.level}</span>
                    {l.daemon.clean && <span className="ml-1 text-white">clean</span>}
                    {l.daemon.signature > 0 && <span className="ml-1 text-fuchsia-300">T{l.daemon.signature}</span>}
                    {l.daemon.patched && <span className="ml-1 text-amber-300">patched</span>}
                  </div>
                  <div className="mono text-xs text-neutral-500">
                    ivs {ivTotal(l.daemon.ivs)} · {own ? 'yours' : `from ${l.sellerName ?? 'an operator'}`} ·{' '}
                    <button className="underline" onClick={() => setOpen(open === l.id ? null : l.id)}>
                      {open === l.id ? 'less' : 'details'}
                    </button>
                  </div>
                </div>
                <div className="text-right">
                  <div className="mono">{l.price} bits</div>
                  {!own && (
                    <button className="rounded bg-sky-800 px-2 py-0.5 text-xs hover:bg-sky-700 disabled:opacity-40" disabled={buying.isLoading || me.bits < l.price} onClick={() => void purchase(l.id, sp.name)} data-testid={`buy-${l.daemon.id}`}>
                      buy
                    </button>
                  )}
                </div>
              </div>
              {open === l.id && (
                <div className="mono mt-1 space-y-0.5 text-xs text-neutral-400">
                  <div>ivs {l.daemon.ivs.join(' ')} · moves {l.daemon.moves.join(', ')}</div>
                  <div>
                    captured {new Date(l.daemon.log.capturedAt).toLocaleString()} in {l.daemon.log.subnet} with {l.daemon.log.tool} · crashes {l.daemon.crashes}
                    {l.daemon.heldItem ? ` · holds ${l.daemon.heldItem}` : ''}
                  </div>
                  {l.daemon.history.map((h, i) => (
                    <div key={i} className="text-neutral-500">
                      {new Date(h.at).toLocaleDateString()} {h.kind}: {h.detail}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="flex gap-2 text-xs text-neutral-500">
          {(query.page ?? 0) > 0 && (
            <button className="underline" onClick={() => set({ page: (query.page ?? 0) - 1 })}>
              previous
            </button>
          )}
          {listings.data?.more && (
            <button className="underline" onClick={() => set({ page: (query.page ?? 0) + 1 })}>
              next
            </button>
          )}
        </div>
      </section>

      <section className="text-xs" data-testid="my-listings">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">my listings</h3>
        {(mine.data ?? []).length === 0 && <p className="text-neutral-600">none — list a daemon from the Disk tab</p>}
        {mine.data?.map((l) => (
          <div key={l.id} className="mono flex items-center justify-between border-b border-neutral-900 py-0.5">
            <span>
              {getSpecies(l.species).name} L{l.level}
            </span>
            <span>
              {l.price} bits{l.status === 'ACTIVE' ? ` (${listingNet(l.price)} after fee)` : ''}
            </span>
            <span className="text-neutral-500">{l.status.toLowerCase()}</span>
            {l.status === 'ACTIVE' ? (
              <button className="text-neutral-500 hover:text-red-300" onClick={() => void unlist(l.id)}>
                unlist
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

`apps/frontend/src/panels/ExchangePanel.tsx` — the existing component becomes `ItemMarket` (its outer `div` loses the padding and the `exchange` test id), wrapped by a view switch:

```tsx
/** The Exchange (SP5): the item market and the daemon listings. */
export function ExchangePanel({ client }: { client: GameClient }) {
  const [view, setView] = useState<'items' | 'daemons'>('items');
  return (
    <div className="space-y-3 p-3 text-sm" data-testid="exchange">
      <div className="flex gap-1 text-xs">
        {(['items', 'daemons'] as const).map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-700' : 'bg-neutral-900 text-neutral-400'}`} onClick={() => setView(v)} data-testid={`exchange-${v}`}>
            {v}
          </button>
        ))}
      </div>
      {view === 'items' ? <ItemMarket client={client} /> : <ListingsPanel client={client} />}
    </div>
  );
}

/** Order book per item, an order form, and the operator's own orders. Trades from the vault (Host tab). */
function ItemMarket({ client }: { client: GameClient }) {
```

Replace `apps/frontend/src/panels/DiskPanel.tsx`:

```tsx
import { getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useState } from 'react';
import { useDiskQuery, useListDaemonMutation, useUnlistMutation } from '../api.ts';
import { listingNet, listingSold } from '../game/exchange.ts';
import { log } from '../game/log.ts';
import { run } from '../components/WorldCanvas.tsx';
import { SpriteImg, nearHost } from './RamPanel.tsx';

export function DiskPanel({ client }: { client: GameClient }) {
  const disk = useDiskQuery();
  const me = client.self;
  const atHost = nearHost(client.subnet, me);
  const manual = client.role === 'controller';
  const rows = disk.data ?? [];
  const { refetch } = disk;
  useEffect(() => listingSold.subscribe(() => void refetch()), [refetch]);
  const [list] = useListDaemonMutation();
  const [unlist] = useUnlistMutation();
  /** the daemon whose price form is open, and the price typed into it */
  const [pricing, setPricing] = useState<{ id: string; price: number } | null>(null);
  const fail = (what: string) => (err: unknown) => log.push('reject', `${what}: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        Disk {rows.length}/256 · <button className="underline" onClick={() => disk.refetch()}>refresh</button>
      </p>
      {rows.length === 0 && <p className="text-neutral-500">nothing on Disk</p>}
      {rows.map((d) => {
        const sp = getSpecies(d.species);
        return (
          <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
            <div className="flex-1">
              <div>
                <span className="font-medium">{sp.name}</span> <span className="text-neutral-500">L{d.level} · slot {d.slot}</span>
                {d.clean && <span className="ml-1 text-white">clean</span>}
                {d.signature > 0 && <span className="ml-1 text-fuchsia-300">T{d.signature}</span>}
                {d.patched && <span className="ml-1 text-amber-300">patched</span>}
                {d.heldItem && <span className="mono ml-1 text-xs text-neutral-400">holds {d.heldItem}</span>}
                {d.lockedBy && <span className="ml-1 text-xs text-amber-300">on the Exchange</span>}
              </div>
              <div className="mono text-xs text-neutral-500">
                captured {new Date(d.log.capturedAt).toLocaleString()} in {d.log.subnet} with {d.log.tool}
              </div>
              <button
                className="mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40"
                disabled={!manual || !atHost || me.ram.length >= 8 || !!d.lockedBy}
                onClick={() => run(client.operator.load(d.id).then(() => disk.refetch()), 'load')}
              >
                load into RAM
              </button>
              {d.lockedBy?.startsWith('listing:') && (
                <button className="ml-3 mt-1 text-xs text-neutral-300 hover:text-white" onClick={() => void unlist(d.lockedBy!.slice(8)).unwrap().catch(fail('unlist'))} data-testid={`unlist-${d.id}`}>
                  unlist
                </button>
              )}
              {!d.lockedBy && pricing?.id !== d.id && (
                <button className="ml-3 mt-1 text-xs text-neutral-300 hover:text-white" onClick={() => setPricing({ id: d.id, price: 256 })} data-testid={`list-${d.id}`}>
                  list on the Exchange
                </button>
              )}
              {pricing?.id === d.id && (
                <span className="ml-3 text-xs text-neutral-400">
                  <input className="w-20 rounded bg-neutral-900 px-1" type="number" min={1} value={pricing.price} onChange={(e) => setPricing({ id: d.id, price: Math.max(1, Number(e.target.value) || 1) })} data-testid="list-price" />
                  <button className="ml-1 rounded bg-sky-800 px-2 hover:bg-sky-700" onClick={() => void list({ daemonId: d.id, price: pricing.price }).unwrap().then(() => setPricing(null), fail('list'))} data-testid="list-confirm">
                    list
                  </button>
                  <button className="ml-1 hover:text-white" onClick={() => setPricing(null)}>
                    cancel
                  </button>
                  <span className="mono ml-1 text-neutral-500">you get {listingNet(pricing.price)} · 7 days</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

`apps/frontend/src/game/connection.ts` (import `listingSold`):

```ts
    client.on('exchange', (e) => {
      const d = e.detail as { item?: string; price?: number; qty?: number; buyerId?: string; species?: string; fee?: number };
      if (e.kind === 'listingSold') {
        // the buyer's own client already logged the purchase
        if (d.buyerId !== client.operatorId) log.push('event', `Exchange: your ${d.species} sold for ${d.price} bits (${(d.price ?? 0) - (d.fee ?? 0)} after the fee)`);
        listingSold.emit();
      } else if (e.kind === 'fill') log.push('event', `Exchange: ${d.buyerId === client.operatorId ? 'bought' : 'sold'} ${d.qty} ${d.item} @ ${d.price}`);
      else log.push('event', `Exchange: ${e.kind}`);
    });
```

- [ ] **Step 4: End-to-end**

In the two-operator scenario, after the order-book step:

```ts
  // Daemon listings: B lists a daemon from the Disk tab; A buys it and finds it on their own Disk
  const seededB = await pb.request.post('/api/dev/daemon', { data: { species: 'pingling', level: 8 }, headers: hdr });
  const listed = (await seededB.json()) as { id: string };
  await pb.getByTestId('tab-disk').click();
  await pb.getByTestId(`list-${listed.id}`).click();
  await pb.getByTestId('list-price').fill('64');
  await pb.getByTestId('list-confirm').click();
  await expect(pb.getByTestId(`unlist-${listed.id}`)).toBeVisible({ timeout: 10_000 });
  await pa.getByTestId('exchange-daemons').click();
  await expect(pa.getByTestId(`listing-${listed.id}`)).toContainText('64 bits', { timeout: 15_000 });
  await pa.getByTestId(`buy-${listed.id}`).click();
  await expect(pa.getByTestId(`listing-${listed.id}`)).toHaveCount(0, { timeout: 10_000 });
  await pa.getByTestId('tab-disk').click();
  await expect(pa.getByTestId(`list-${listed.id}`)).toBeVisible({ timeout: 10_000 });
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('sold for 64 bits (60 after the fee)', { timeout: 10_000 });
  await pb.getByTestId('tab-disk').click();
  await expect(pb.getByTestId(`unlist-${listed.id}`)).toHaveCount(0, { timeout: 10_000 });
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 48 files, 390 tests. Build, start the stack (sim, api, `vite preview`), `playwright test` — 4 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): daemon listings — list from Disk, browse, buy"
```

---

## Self-review

- **Spec coverage:** §6 `Listing` with snapshot, list (Disk, unlocked → locked), unlist, buy (bits ≥ price, lowest free Disk slot, one transaction: bits with the §3 fee, ownership, slot, `traded` history, SOLD, lock cleared), browse with all six filters and both sorts returning the daemon view with capture log and history, expiry on the order timer; §3 the 16-listing cap, 7 days, bearer access (same `auth` hook as the order routes); §8 list from the Disk tab, browser with filters and a buy button, my listings. Deviations are listed at the top. Direct trades, the SDK `ExchangeClient` and the admin market view are plan 4.
- **Type consistency:** `daemonView` (api) ↔ `ListedDaemon` (client); `browseListings` return ↔ `useListingsQuery` result; `admin disk` message fields `add` / `remove` are the same in `buyListing`, `Game.onAdmin` and both tests.
- **Placeholders:** none.
