import { consoleBusLogger, type Bus } from '@daemonet/bus';
import type { Daemon, Prisma, PrismaClient, Trade } from '@daemonet/db';
import { MAX_OPEN_TRADES, MAX_TRADE_BITS, MAX_TRADE_DAEMONS, MAX_TRADE_ITEMS, TRADE_IDLE_MS, isTradable } from '@daemonet/rules';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { publishSafely, type PublishLog } from '../publish.js';
import { Outbox, announce, credit, debit, freeDiskSlot, isSlotTaken, lockOperators, type Tx } from './ledger.js';
import { daemonView } from './listings.js';
import { MAX_QTY, feeOn, vaultAdd, vaultTake } from './orders.js';

/** Direct trades (SP5 spec §7): two operators put bits, vault items and Disk daemons on the table and both confirm. */
export { MAX_OPEN_TRADES, MAX_TRADE_BITS, MAX_TRADE_DAEMONS, MAX_TRADE_ITEMS, TRADE_IDLE_MS };

/**
 * The ledger reason of every bits row a trade writes (`ref` = the trade id), one debit and one net credit per side that
 * offers bits. Not one of the sim's intent reasons (carry-forward #30): the sim applies these rows as deltas, from the
 * bus push or on its next resync. There is no fee row: the receiver is credited `bits - floor(bits / 16)`.
 */
export const TRADE_LEDGER_REASON = 'exchange:trade';

export interface Offer {
  bits: number;
  items: Record<string, number>;
  daemonIds: string[];
  /**
   * What the offered daemons were when offered (stored by setOffer; a locked Disk daemon cannot level or evolve): a
   * closed trade shows these, never a full view of a daemon that has left either Disk.
   */
  daemons?: DaemonSummary[];
}
export interface DaemonSummary {
  id: string;
  species: string;
  level: number;
}
const EMPTY: Offer = { bits: 0, items: {}, daemonIds: [] };
const isEmpty = (o: Offer): boolean => o.bits === 0 && Object.keys(o.items).length === 0 && o.daemonIds.length === 0;
const offerOf = (json: Prisma.JsonValue): Offer => json as unknown as Offer;
const lockValue = (tradeId: string): string => `trade:${tradeId}`;

/** Execution waits for both operators' rows and can touch a few dozen rows: give it room (the default is 5 s). */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Disk changes behind the sim, announced after commit: every removal first. */
interface DiskMoves {
  remove: Array<{ operatorId: string; slot: number }>;
  add: Array<{ operatorId: string; slot: number }>;
}

/**
 * The Disk pushes that change something: a slot freed and refilled on the same Disk (a swap reuses the slot a departing
 * daemon left) is occupied before and after, so its remove / add pair is dropped. Removals still go first.
 */
function netDiskMoves(disk: DiskMoves): DiskMoves {
  const key = (d: { operatorId: string; slot: number }) => `${d.operatorId}\u0000${d.slot}`;
  const removed = new Set(disk.remove.map(key));
  const added = new Set(disk.add.map(key));
  return { remove: disk.remove.filter((d) => !added.has(key(d))), add: disk.add.filter((d) => !removed.has(key(d))) };
}

/** After commit: bits pushes (one per ledger row), Disk pushes, then the `trade` notification both clients refetch on. */
function publish(bus: Bus, log: PublishLog, trade: Pick<Trade, 'id' | 'aId' | 'bId' | 'status'>, out?: Outbox, disk?: DiskMoves): void {
  if (out) announce(bus, log, out);
  if (disk) {
    const net = netDiskMoves(disk);
    for (const d of net.remove) publishSafely(bus, log, 'admin', { kind: 'disk', operatorId: d.operatorId, remove: d.slot, origin: 'api' });
    for (const d of net.add) publishSafely(bus, log, 'admin', { kind: 'disk', operatorId: d.operatorId, add: d.slot, origin: 'api' });
  }
  // `detail` names no operator: the sim passes it to each side as is (exchangeView)
  publishSafely(bus, log, 'exchange', { kind: 'trade', operators: [trade.aId, trade.bId], detail: { tradeId: trade.id, status: trade.status } });
}

/**
 * Lock order (carry-forward #32, #33), the same in every trade transaction: the Trade row `FOR UPDATE` (it plays the
 * role of the order book's advisory lock; the sim never locks trades), then the Operator rows involved, sorted by id,
 * then Daemon / ExchangeVault rows. Opening a trade has no row yet: it starts at the two Operator rows.
 */
async function lockTrade(tx: Tx, tradeId: string, operatorId: string): Promise<Trade> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Trade" WHERE "id" = ${tradeId} FOR UPDATE`;
  const trade = rows.length === 1 ? await tx.trade.findUnique({ where: { id: tradeId } }) : null;
  if (!trade) throw notFound('no such trade');
  if (trade.aId !== operatorId && trade.bId !== operatorId) throw forbidden('not your trade');
  if (trade.status !== 'OPEN') throw badRequest(`trade is ${trade.status === 'DONE' ? 'done' : 'cancelled'}`);
  return trade;
}

/** An open trade nobody touched for TRADE_IDLE_MS is over, even before the sweep closes it (only a cancel still works). */
function refuseIdle(trade: Trade, at: Date): void {
  if (trade.updatedAt.getTime() <= at.getTime() - TRADE_IDLE_MS) throw badRequest('trade has expired');
}

const openCount = (tx: Tx, operatorId: string) => tx.trade.count({ where: { status: 'OPEN', OR: [{ aId: operatorId }, { bId: operatorId }] } });

/**
 * Opens a trade with another operator, by id or name. Under both operators' locks (sorted), so concurrent opens cannot
 * break the cap or the one-open-trade-per-pair rule. An operator who blocked the caller cannot be sent a trade.
 */
export async function openTrade(
  prisma: PrismaClient,
  bus: Bus,
  aId: string,
  target: { id?: string | undefined; name?: string | undefined },
  log: PublishLog = consoleBusLogger,
): Promise<Trade> {
  const where = target.id ? { id: target.id } : target.name ? { name: target.name } : null;
  if (!where) throw badRequest('give withId or withName');
  const other = await prisma.operator.findUnique({ where, select: { id: true } });
  if (!other) throw notFound('no such operator');
  const bId = other.id;
  if (bId === aId) throw badRequest('you cannot trade with yourself');
  const trade = await prisma.$transaction(async (tx) => {
    await lockOperators(tx, [aId, bId]);
    const at = new Date();
    if (await tx.chatBlock.findUnique({ where: { blockerId_blockedId: { blockerId: bId, blockedId: aId } } })) throw forbidden('that operator is not accepting trades from you');
    if (await tx.trade.findFirst({ where: { status: 'OPEN', OR: [{ aId, bId }, { aId: bId, bId: aId }] } })) throw badRequest('you already have an open trade with that operator');
    if ((await openCount(tx, aId)) >= MAX_OPEN_TRADES) throw badRequest(`at most ${MAX_OPEN_TRADES} open trades`);
    if ((await openCount(tx, bId)) >= MAX_OPEN_TRADES) throw badRequest('that operator has too many open trades');
    return tx.trade.create({ data: { id: crypto.randomUUID(), aId, bId, aOffer: { ...EMPTY }, bOffer: { ...EMPTY }, createdAt: at, updatedAt: at } });
  }, TX_OPTIONS);
  publish(bus, log, trade);
  return trade;
}

/** Shape checks (the route's schema does most of them; this guards direct callers). Returns the offer as stored. */
function validateShape(offer: Offer): Offer {
  if (!Number.isSafeInteger(offer.bits) || offer.bits < 0 || offer.bits > MAX_TRADE_BITS) throw badRequest('bits out of range');
  const items = Object.entries(offer.items);
  if (items.length > MAX_TRADE_ITEMS) throw badRequest(`at most ${MAX_TRADE_ITEMS} kinds of item`);
  for (const [item, qty] of items) {
    if (!isTradable(item)) throw badRequest(`${item} cannot be traded`);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw badRequest(`quantity of ${item} must be 1-${MAX_QTY}`);
  }
  if (offer.daemonIds.length > MAX_TRADE_DAEMONS) throw badRequest(`at most ${MAX_TRADE_DAEMONS} daemons`);
  if (new Set(offer.daemonIds).size !== offer.daemonIds.length) throw badRequest('a daemon is offered twice');
  return { bits: offer.bits, items: Object.fromEntries(items), daemonIds: [...offer.daemonIds] };
}

/**
 * Replaces the caller's offer. Bits and items are only checked against the balance and the vault here (and again
 * when the trade executes); daemons are locked to the trade (`lockedBy = trade:<id>`; only unlocked Disk daemons, so a
 * daemon in RAM, listed or in another trade is refused, and a load racing it sees one or the other). Any change clears
 * both confirmations and bumps `version`, which a confirmation has to quote — nobody can be made to confirm an offer
 * they have not seen.
 */
export async function setOffer(prisma: PrismaClient, bus: Bus, operatorId: string, tradeId: string, input: Offer, now?: Date, log: PublishLog = consoleBusLogger): Promise<Trade> {
  const offer = validateShape(input);
  const trade = await prisma.$transaction(async (tx) => {
    const t = await lockTrade(tx, tradeId, operatorId);
    const at = now ?? new Date();
    refuseIdle(t, at);
    await lockOperators(tx, [operatorId]);
    const me = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } });
    if (me.bits < BigInt(offer.bits)) throw new AppError(402, 'insufficient_bits', `you do not have ${offer.bits} bits`);
    const vault = new Map((await tx.exchangeVault.findMany({ where: { operatorId } })).map((v) => [v.item, v.qty]));
    for (const [item, qty] of Object.entries(offer.items)) if ((vault.get(item) ?? 0) < qty) throw badRequest(`not enough ${item} in your vault`);
    const lock = lockValue(t.id);
    // released only where this trade holds the lock (never a listing's or another trade's)
    await tx.daemon.updateMany({ where: { operatorId, lockedBy: lock, id: { notIn: offer.daemonIds } }, data: { lockedBy: null } });
    for (const id of offer.daemonIds) {
      const res = await tx.daemon.updateMany({ where: { id, operatorId, location: 'DISK', OR: [{ lockedBy: null }, { lockedBy: lock }] }, data: { lockedBy: lock } });
      if (res.count !== 1) throw badRequest('a daemon you offered is not on your Disk, or is already on the Exchange');
    }
    const rows = new Map((await tx.daemon.findMany({ where: { id: { in: offer.daemonIds } }, select: { id: true, species: true, level: true } })).map((d) => [d.id, d]));
    const stored: Offer = { ...offer, daemons: offer.daemonIds.map((id) => ({ id, species: rows.get(id)!.species, level: rows.get(id)!.level })) };
    const mine = t.aId === operatorId ? { aOffer: stored as unknown as Prisma.InputJsonValue } : { bOffer: stored as unknown as Prisma.InputJsonValue };
    return tx.trade.update({ where: { id: t.id }, data: { ...mine, aConfirmed: false, bConfirmed: false, version: { increment: 1 }, updatedAt: at } });
  }, TX_OPTIONS);
  publish(bus, log, trade);
  return trade;
}

/**
 * Moves everything on the table (caller holds the trade and both operator locks). Every check is a guarded write, so
 * whatever was spent, withdrawn, loaded or listed since the offer fails here and rolls the whole step back.
 */
async function execute(tx: Tx, t: Trade, confirmerId: string, at: Date, out: Outbox): Promise<DiskMoves> {
  const disk: DiskMoves = { remove: [], add: [] };
  const sides = [
    { from: t.aId, to: t.bId, offer: offerOf(t.aOffer) },
    { from: t.bId, to: t.aId, offer: offerOf(t.bOffer) },
  ];
  if (sides.every((s) => isEmpty(s.offer))) throw badRequest('there is nothing on the table');
  for (const s of sides) {
    if (s.offer.bits > 0) {
      await debit(tx, out, s.from, s.offer.bits, TRADE_LEDGER_REASON, t.id);
      await credit(tx, out, s.to, s.offer.bits - feeOn(s.offer.bits), TRADE_LEDGER_REASON, t.id);
    }
    for (const [item, qty] of Object.entries(s.offer.items)) {
      await vaultTake(tx, s.from, item, qty);
      await vaultAdd(tx, s.to, item, qty);
    }
  }
  // Daemons: park every traded daemon on a negative slot first (never committed: the transaction ends with each on a
  // real slot or rolls back), so two Disks can swap without tripping the (operator, location, slot) unique index, then
  // hand each one the receiver's lowest free slot below its Disk capacity.
  const lock = lockValue(t.id);
  let parked = 0;
  for (const s of sides) {
    for (const id of s.offer.daemonIds) {
      const rows = await tx.$queryRaw<Array<{ slot: number }>>`
        SELECT "slot" FROM "Daemon" WHERE "id" = ${id} AND "operatorId" = ${s.from} AND "location" = 'DISK' AND "lockedBy" = ${lock} FOR UPDATE`;
      if (rows.length !== 1) throw badRequest('an offered daemon is no longer available');
      await tx.daemon.update({ where: { id }, data: { slot: -1 - parked++ } });
      disk.remove.push({ operatorId: s.from, slot: rows[0]!.slot });
    }
  }
  for (const s of sides) {
    for (const id of s.offer.daemonIds) {
      const slot = await freeDiskSlot(tx, s.to);
      if (slot === null) throw badRequest(`${s.to === confirmerId ? 'your' : "the other operator's"} Disk is too full to receive the daemons`);
      const d = await tx.daemon.findUniqueOrThrow({ where: { id }, select: { history: true } });
      const history = [...(Array.isArray(d.history) ? (d.history as Prisma.JsonArray) : []), { at: at.toISOString(), kind: 'traded', detail: 'traded directly' }];
      await tx.daemon.update({ where: { id }, data: { operatorId: s.to, slot, lockedBy: null, history } });
      disk.add.push({ operatorId: s.to, slot });
    }
  }
  return disk;
}

/**
 * Confirms the offers as of `version`. When both sides have confirmed, the trade executes in the same transaction;
 * anything that fails rolls the step back (the trade stays open, this confirmation unrecorded). A Disk slot taken by
 * the sim between our read and our write is a retryable 409 with nothing moved or announced.
 */
export async function confirmTrade(
  prisma: PrismaClient,
  bus: Bus,
  operatorId: string,
  tradeId: string,
  version: number,
  now?: Date,
  log: PublishLog = consoleBusLogger,
): Promise<Trade> {
  const out = new Outbox();
  let result: { trade: Trade; disk?: DiskMoves };
  try {
    result = await prisma.$transaction(async (tx) => {
      const t = await lockTrade(tx, tradeId, operatorId);
      const at = now ?? new Date();
      refuseIdle(t, at);
      if (t.version !== version) throw new AppError(409, 'stale_offer', 'the offers changed; look again before confirming');
      const aConfirmed = t.aConfirmed || t.aId === operatorId;
      const bConfirmed = t.bConfirmed || t.bId === operatorId;
      if (!(aConfirmed && bConfirmed)) return { trade: await tx.trade.update({ where: { id: t.id }, data: { aConfirmed, bConfirmed, updatedAt: at } }) };
      await lockOperators(tx, [t.aId, t.bId]);
      const disk = await execute(tx, t, operatorId, at, out);
      return { trade: await tx.trade.update({ where: { id: t.id }, data: { aConfirmed, bConfirmed, status: 'DONE', updatedAt: at } }), disk };
    }, TX_OPTIONS);
  } catch (err) {
    if (isSlotTaken(err)) throw conflict('a daemon just arrived in a Disk slot; try again');
    throw err;
  }
  publish(bus, log, result.trade, result.disk ? out : undefined, result.disk);
  return result.trade;
}

/** Releases every daemon this trade holds (only rows locked by exactly this trade). */
async function unlockAll(tx: Tx, tradeId: string): Promise<void> {
  await tx.daemon.updateMany({ where: { lockedBy: lockValue(tradeId) }, data: { lockedBy: null } });
}

export async function cancelTrade(prisma: PrismaClient, bus: Bus, operatorId: string, tradeId: string, now?: Date, log: PublishLog = consoleBusLogger): Promise<Trade> {
  const trade = await prisma.$transaction(async (tx) => {
    const t = await lockTrade(tx, tradeId, operatorId);
    const at = now ?? new Date();
    await lockOperators(tx, [t.aId, t.bId]);
    await unlockAll(tx, t.id);
    return tx.trade.update({ where: { id: t.id }, data: { status: 'CANCELLED', updatedAt: at } });
  }, TX_OPTIONS);
  publish(bus, log, trade);
  return trade;
}

/**
 * Cancels open trades nobody touched for TRADE_IDLE_MS and releases their daemons; run by the api at boot and every
 * five minutes. Re-checked under the trade lock, so a trade confirmed, cancelled or changed since the scan is left
 * alone and each is closed exactly once. A trade whose transaction fails is logged and skipped (the next run retries).
 */
export async function expireTrades(prisma: PrismaClient, bus: Bus, now = new Date(), log: PublishLog = consoleBusLogger): Promise<number> {
  const BATCH = 256;
  const cutoff = new Date(now.getTime() - TRADE_IDLE_MS);
  let closed = 0;
  const failed: string[] = [];
  for (;;) {
    const due = await prisma.trade.findMany({
      where: { status: 'OPEN', updatedAt: { lte: cutoff }, ...(failed.length ? { id: { notIn: failed } } : {}) },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    for (const { id } of due) {
      let trade: Trade | null;
      try {
        trade = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Trade" WHERE "id" = ${id} FOR UPDATE`;
          const t = await tx.trade.findUnique({ where: { id } });
          if (!t || t.status !== 'OPEN' || t.updatedAt > cutoff) return null;
          await lockOperators(tx, [t.aId, t.bId]);
          await unlockAll(tx, id);
          return tx.trade.update({ where: { id }, data: { status: 'CANCELLED', updatedAt: now } });
        }, TX_OPTIONS);
      } catch (err) {
        failed.push(id);
        const e = err as { name?: unknown; code?: unknown };
        log.warn({ tradeId: id, err: { name: String(e?.name ?? 'Error'), code: e?.code === undefined ? undefined : String(e.code) } }, 'trade expiry failed');
        continue;
      }
      if (trade) {
        closed++;
        publish(bus, log, trade);
      }
    }
    if (due.length < BATCH) return closed;
  }
}

/**
 * Trades as a participant sees them: `me` and `them`. While a trade is open its daemons are expanded for inspection
 * (as long as the trade holds them); once it is closed, each side's daemons are shown as `{ id, species, level }` only,
 * so the history says what each side gave without anyone watching a daemon that went, or stayed, on the other Disk.
 */
export async function tradeViews(prisma: PrismaClient, trades: Trade[], viewerId: string) {
  const offers = trades.flatMap((t) => [offerOf(t.aOffer), offerOf(t.bOffer)]);
  const daemons = new Map((await prisma.daemon.findMany({ where: { id: { in: offers.flatMap((o) => o.daemonIds) } } })).map((d) => [d.id, d]));
  const names = new Map((await prisma.operator.findMany({ where: { id: { in: [...new Set(trades.flatMap((t) => [t.aId, t.bId]))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const held = (t: Trade, ownerId: string, d: Daemon | undefined): d is Daemon => !!d && d.operatorId === ownerId && d.lockedBy === lockValue(t.id);
  const summary = (offer: Offer, id: string): DaemonSummary[] => {
    const stored = offer.daemons?.find((d) => d.id === id);
    if (stored) return [{ id, species: stored.species, level: stored.level }];
    const row = daemons.get(id); // a trade stored before summaries were: the daemon as it is now, if it still exists
    return row ? [{ id, species: row.species, level: row.level }] : [];
  };
  const side = (t: Trade, id: string, offer: Offer, confirmed: boolean) => ({
    id,
    name: names.get(id) ?? null,
    confirmed,
    offer: {
      bits: offer.bits,
      items: offer.items,
      daemons: offer.daemonIds.flatMap((d): Array<ReturnType<typeof daemonView> | DaemonSummary> => {
        if (t.status !== 'OPEN') return summary(offer, d);
        const row = daemons.get(d);
        return held(t, id, row) ? [daemonView(row)] : [];
      }),
    },
  });
  return trades.map((t) => {
    const a = side(t, t.aId, offerOf(t.aOffer), t.aConfirmed);
    const b = side(t, t.bId, offerOf(t.bOffer), t.bConfirmed);
    const mine = t.aId === viewerId;
    return { id: t.id, status: t.status, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt, me: mine ? a : b, them: mine ? b : a };
  });
}

/** How many closed trades `listTrades` returns; open ones (at most MAX_OPEN_TRADES) are never cut. */
export const CLOSED_TRADES_SHOWN = 8;

/** The caller's open trades (oldest first) and their most recent closed ones. */
export async function listTrades(prisma: PrismaClient, operatorId: string) {
  const mine = { OR: [{ aId: operatorId }, { bId: operatorId }] };
  const [open, closed] = await Promise.all([
    prisma.trade.findMany({ where: { status: 'OPEN', ...mine }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.trade.findMany({ where: { status: { not: 'OPEN' }, ...mine }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: CLOSED_TRADES_SHOWN }),
  ]);
  // a trade that closed between the two reads may be in both: keep the closed row (the newer state)
  const closedIds = new Set(closed.map((t) => t.id));
  return tradeViews(prisma, [...open.filter((t) => !closedIds.has(t.id)), ...closed], operatorId);
}
