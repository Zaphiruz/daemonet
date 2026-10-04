import { consoleBusLogger, type Bus } from '@daemonet/bus';
import type { Daemon, Prisma, PrismaClient } from '@daemonet/db';
import { getSpecies } from '@daemonet/rules';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { publishSafely, type PublishLog } from '../publish.js';
import { Outbox, announce, credit, debit, lockOperators, type Tx } from './ledger.js';
import { MAX_PRICE, feeOn } from './orders.js';

/** Daemon listings (SP5 spec §6): fixed price, from Disk, locked while listed. */
export const MAX_ACTIVE_LISTINGS = 16;
export const LISTING_TTL_MS = 7 * 86_400_000;
export const PAGE_SIZE = 32;

/**
 * Ledger reasons a sale writes (carry-forward #30, #33): neither is one of the sim's intent reasons, so the sim applies
 * the rows as deltas, from the bus push or on its next resync. There is no fee row: the seller is credited net.
 */
export const LISTING_LEDGER_REASONS = Object.freeze({ buy: 'exchange:buy', sale: 'exchange:sale' } as const);

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

/**
 * Lock order (carry-forward #32, #33), the same in every listing transaction: the Listing row `FOR UPDATE` (it plays
 * the role of the order book's advisory lock; the sim never locks listings), then every Operator row involved, sorted
 * by id, then Daemon rows. A new listing has no row yet: it starts at the seller's Operator row.
 */
type ListingRow = { id: string; sellerId: string; daemonId: string; price: number; status: string; expiresAt: Date };
async function lockListing(tx: Tx, listingId: string): Promise<ListingRow | undefined> {
  const rows = await tx.$queryRaw<ListingRow[]>`
    SELECT "id", "sellerId", "daemonId", "price", "status"::text AS "status", "expiresAt" FROM "Listing" WHERE "id" = ${listingId} FOR UPDATE`;
  return rows[0];
}

const lockValue = (listingId: string) => `listing:${listingId}`;

/**
 * The daemon as buyers see it: everything that makes it worth its price, including the capture log and history. No
 * evolution requirement data (carry-forward #24): that lives only in `@daemonet/rules/evolution`.
 */
export function daemonView(d: Daemon) {
  return {
    id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus, clean: d.clean, signature: d.signature,
    moves: d.moves, heldItem: d.heldItem, patched: d.patched, crashes: d.crashes, arenaWins: d.arenaWins, history: d.history,
    log: { originalOperatorId: d.originalOperatorId, capturedAt: d.capturedAt, subnet: d.captureSubnet, tool: d.captureTool, spawnIndex: d.spawnIndex },
  };
}

/**
 * Lists a daemon from the seller's Disk at a fixed price and locks it (`lockedBy = listing:<id>`), so the sim cannot
 * load it. Only a DISK row with `lockedBy: null` can be locked: a daemon in RAM (including one with a pending store /
 * evolve / decompile in the sim, which is still RAM in the DB), already listed or offered in a trade is refused.
 */
export async function createListing(prisma: PrismaClient, sellerId: string, daemonId: string, price: number, now?: Date) {
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) throw badRequest(`price must be 1-${MAX_PRICE}`);
  return prisma.$transaction(async (tx) => {
    // Under the seller's lock, concurrent listings of this seller have committed or wait for us: the cap holds.
    await lockOperators(tx, [sellerId]);
    const at = now ?? new Date();
    // listings past their expiry no longer count, even before the sweep reaches them
    if ((await tx.listing.count({ where: { sellerId, status: 'ACTIVE', expiresAt: { gt: at } } })) >= MAX_ACTIVE_LISTINGS) {
      throw badRequest(`at most ${MAX_ACTIVE_LISTINGS} active listings`);
    }
    const id = crypto.randomUUID();
    const locked = await tx.daemon.updateMany({ where: { id: daemonId, operatorId: sellerId, location: 'DISK', lockedBy: null }, data: { lockedBy: lockValue(id) } });
    if (locked.count !== 1) throw badRequest('that daemon is not on your Disk, or is already on the Exchange');
    const d = await tx.daemon.findUniqueOrThrow({ where: { id: daemonId } });
    const sp = getSpecies(d.species);
    return tx.listing.create({
      data: {
        id, sellerId, daemonId, price, species: d.species, line: sp.line, types: [...sp.types], level: d.level, clean: d.clean, signature: d.signature,
        ivSum: d.ivs.reduce((a, b) => a + b, 0), createdAt: at, expiresAt: new Date(at.getTime() + LISTING_TTL_MS),
      },
    });
  });
}

/** Closes an ACTIVE listing without a sale and releases its daemon (caller holds the listing and seller locks). */
async function close(tx: Tx, listing: { id: string; daemonId: string }, status: 'CANCELLED' | 'EXPIRED'): Promise<void> {
  await tx.daemon.updateMany({ where: { id: listing.daemonId, lockedBy: lockValue(listing.id) }, data: { lockedBy: null } });
  const res = await tx.listing.updateMany({ where: { id: listing.id, status: 'ACTIVE' }, data: { status } });
  if (res.count !== 1) throw new Error(`listing ${listing.id} changed under its lock`);
}

/** Cancels the caller's ACTIVE listing and unlocks the daemon. 404 unknown, 403 not yours, 400 not active. */
export async function cancelListing(prisma: PrismaClient, sellerId: string, listingId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const listing = await lockListing(tx, listingId);
    if (!listing) throw notFound('no such listing');
    if (listing.sellerId !== sellerId) throw forbidden('not your listing');
    if (listing.status !== 'ACTIVE') throw badRequest(`listing is ${listing.status.toLowerCase()}`);
    await lockOperators(tx, [listing.sellerId]);
    await close(tx, listing, 'CANCELLED');
  });
}

/**
 * Expires ACTIVE listings past their time and unlocks their daemons; run by the api at boot and every five minutes.
 * Returns how many were closed. A listing whose transaction fails is logged and skipped (the next run retries it).
 */
export async function expireListings(prisma: PrismaClient, now = new Date(), log: PublishLog = consoleBusLogger): Promise<number> {
  const BATCH = 256;
  let closed = 0;
  const failed: string[] = [];
  for (;;) {
    const due = await prisma.listing.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now }, ...(failed.length ? { id: { notIn: failed } } : {}) },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: BATCH,
    });
    for (const d of due) {
      try {
        const expired = await prisma.$transaction(async (tx) => {
          // re-read under the lock: a sale or a cancel may have closed it since
          const listing = await lockListing(tx, d.id);
          if (!listing || listing.status !== 'ACTIVE' || listing.expiresAt > now) return false;
          await lockOperators(tx, [listing.sellerId]);
          await close(tx, listing, 'EXPIRED');
          return true;
        });
        if (expired) closed++;
      } catch (err) {
        failed.push(d.id);
        const e = err as { name?: unknown; code?: unknown };
        log.warn({ listingId: d.id, err: { name: String(e?.name ?? 'Error'), code: e?.code === undefined ? undefined : String(e.code) } }, 'listing expiry failed');
      }
    }
    if (due.length < BATCH) return closed;
  }
}

/**
 * Lowest free Disk slot of an operator, or null when the Disk is full. Read from the DB (never the sim's memory) against
 * `Operator.diskCapacity`; call it under the operator's lock. A sim store / capture that does not take the operator lock
 * can still claim the same slot concurrently: the `(operatorId, location, slot)` unique index then refuses one of them.
 */
export async function freeDiskSlot(tx: Tx, operatorId: string): Promise<number | null> {
  const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { diskCapacity: true } });
  const used = new Set((await tx.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((d) => d.slot));
  for (let s = 0; s < op.diskCapacity; s++) if (!used.has(s)) return s;
  return null;
}

/** True for the unique violation of a Disk (or RAM) slot (Prisma 7 + pg adapter report it under meta.driverAdapterError). */
function isSlotTaken(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: { constraint?: { index?: string }; originalMessage?: string } } | undefined)?.cause;
  const target = meta.target ?? meta.constraint;
  return [cause?.constraint?.index, cause?.originalMessage, Array.isArray(target) ? target.join(',') : target, (err as Error).message]
    .filter((x): x is string => typeof x === 'string')
    .some((s) => s.includes('Daemon_operatorId_location_slot_key') || s.includes('operatorId,location,slot'));
}

/**
 * Buys a listing: one transaction moves the bits (seller pays the 1/16 fee, destroyed; ledger `exchange:buy` and
 * `exchange:sale`), the daemon (new owner, lowest free Disk slot, lock cleared, one `traded` history entry) and closes
 * the listing. The listing row lock makes concurrent buyers (and a racing cancel or expiry) queue; whoever comes second
 * finds it closed and pays nothing. After commit the sim is told: one bits push per ledger row, the Disk slots that
 * changed hands on both operators, and a `listingSold` event.
 */
export async function buyListing(prisma: PrismaClient, bus: Bus, buyerId: string, listingId: string, now?: Date, log: PublishLog = consoleBusLogger) {
  const out = new Outbox();
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const listing = await lockListing(tx, listingId);
      if (!listing) throw notFound('no such listing');
      // the time is read once the listing is ours: a buyer that waited for the lock must not buy what expired meanwhile
      const at = now ?? new Date();
      if (listing.status !== 'ACTIVE' || listing.expiresAt <= at) throw badRequest('that listing is no longer available');
      if (listing.sellerId === buyerId) throw badRequest('that is your own listing');
      await lockOperators(tx, [buyerId, listing.sellerId]);
      const daemons = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Daemon" WHERE "id" = ${listing.daemonId} FOR UPDATE`;
      const daemon = daemons.length === 1 ? await tx.daemon.findUniqueOrThrow({ where: { id: listing.daemonId } }) : null;
      if (!daemon || daemon.operatorId !== listing.sellerId || daemon.location !== 'DISK' || daemon.lockedBy !== lockValue(listing.id)) {
        throw new Error(`listing ${listing.id}: its daemon is no longer held by it`);
      }
      const slot = await freeDiskSlot(tx, buyerId);
      if (slot === null) throw badRequest('your Disk is full');
      const fee = feeOn(listing.price);
      await debit(tx, out, buyerId, listing.price, LISTING_LEDGER_REASONS.buy, listing.id);
      await credit(tx, out, listing.sellerId, listing.price - fee, LISTING_LEDGER_REASONS.sale, listing.id);
      const history = [...(Array.isArray(daemon.history) ? (daemon.history as Prisma.JsonArray) : []), { at: at.toISOString(), kind: 'traded', detail: `sold on the Exchange for ${listing.price} bits` }];
      const moved = await tx.daemon.updateMany({
        where: { id: daemon.id, operatorId: listing.sellerId, location: 'DISK', lockedBy: lockValue(listing.id) },
        data: { operatorId: buyerId, slot, lockedBy: null, history },
      });
      if (moved.count !== 1) throw new Error(`listing ${listing.id}: its daemon changed under the lock`);
      await tx.listing.update({ where: { id: listing.id }, data: { status: 'SOLD', buyerId, soldAt: at } });
      return { listing, fee, slot, sellerSlot: daemon.slot, daemonId: daemon.id, species: daemon.species };
    });
  } catch (err) {
    // a sim store or capture took the slot between our read and our write: nothing was charged, the buyer can retry
    if (isSlotTaken(err)) throw conflict('a daemon just arrived in that Disk slot; try again');
    throw err;
  }
  const { listing, fee, slot, sellerSlot, daemonId, species } = result;
  announce(bus, log, out);
  // the sim keeps the occupied Disk slots of online operators in memory: tell it which ones changed hands
  publishSafely(bus, log, 'admin', { kind: 'disk', operatorId: buyerId, add: slot, origin: 'api' });
  publishSafely(bus, log, 'admin', { kind: 'disk', operatorId: listing.sellerId, remove: sellerSlot, origin: 'api' });
  publishSafely(bus, log, 'exchange', {
    kind: 'listingSold',
    operators: [buyerId, listing.sellerId],
    detail: { listingId: listing.id, daemonId, species, price: listing.price, fee, buyerId, sellerId: listing.sellerId },
  });
  return { daemonId, slot, price: listing.price, fee };
}

/** ACTIVE, unexpired listings with their daemons, filtered and sorted (price ascending, or newest first), 32 per page. */
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
  const rows = await prisma.listing.findMany({
    where,
    orderBy: q.sort === 'new' ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ price: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const shown = rows.slice(0, PAGE_SIZE);
  const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: shown.map((r) => r.daemonId) } } })).map((d) => [d.id, d]));
  const sellers = new Map((await prisma.operator.findMany({ where: { id: { in: [...new Set(shown.map((r) => r.sellerId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  return {
    page,
    more: rows.length > PAGE_SIZE,
    listings: shown.flatMap((r) => {
      const d = daemons.get(r.daemonId);
      // only while the daemon is still the listing's (a sale or release in flight between the two reads drops it)
      return d && d.lockedBy === lockValue(r.id) ? [{ id: r.id, price: r.price, sellerId: r.sellerId, sellerName: sellers.get(r.sellerId) ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt, daemon: daemonView(d) }] : [];
    }),
  };
}
