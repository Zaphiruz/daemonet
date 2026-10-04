import { FEE_DIVISOR, feeOn } from '@daemonet/rules';
import { useSyncExternalStore } from 'react';

/**
 * Exchange maths shown in the client (the api is authoritative). The limits and the fee come from `@daemonet/rules`,
 * the same numbers the api uses: the seller pays 1/16 of the proceeds of each fill, floored.
 */
export { FEE_DIVISOR, feeOn };

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
type Side = 'BUY' | 'SELL';
type Levels = Pick<Book, 'bids' | 'asks'>;

/** What placing the order costs now (BUY: escrow) or would bring in if it fills completely at its limit (SELL: after the fee). */
export function orderPreview(side: Side, price: number, qty: number): { total: number; fee: number; net: number } {
  const total = price * qty;
  if (side === 'BUY') return { total, fee: 0, net: -total };
  const fee = feeOn(total);
  return { total, fee, net: total - fee };
}

/** What a daemon listing brings its seller after the fee. */
export function listingNet(price: number): number {
  return price - feeOn(price);
}

export function ivTotal(ivs: readonly number[]): number {
  return ivs.reduce((a, b) => a + b, 0);
}

export function spread(book: Levels): { bid: number | null; ask: number | null; spread: number | null } {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  return { bid, ask, spread: bid !== null && ask !== null ? ask - bid : null };
}

/** How much of `qty` a new order would fill immediately against the visible book, and at what average price. */
export function fillEstimate(book: Levels, side: Side, price: number, qty: number): { filled: number; average: number | null } {
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

/** The part of one of the player's orders that matters for matching (from `GET /api/exchange/orders`, filtered to one item). */
export interface OwnOrder {
  side: Side;
  price: number;
  remaining: number;
  status: string;
  expiresAt: string;
}

/**
 * The book as the engine will see it for this player: the engine never matches a player's own orders, so their open,
 * unexpired quantity is taken out of each level (a level that was all theirs disappears).
 */
export function excludeOwn(book: Levels, own: readonly OwnOrder[], now = Date.now()): Levels {
  const live = own.filter((o) => o.status === 'OPEN' && Date.parse(o.expiresAt) > now);
  const strip = (levels: BookLevel[], side: Side): BookLevel[] =>
    levels
      .map((l) => ({ price: l.price, qty: l.qty - live.filter((o) => o.side === side && o.price === l.price).reduce((s, o) => s + o.remaining, 0) }))
      .filter((l) => l.qty > 0);
  return { bids: strip(book.bids, 'BUY'), asks: strip(book.asks, 'SELL') };
}

export interface OrderSimulation {
  /** Immediate fills, best price first, at the resting prices. */
  fills: Array<{ price: number; qty: number; fee: number }>;
  filled: number;
  average: number | null;
  /** Quantity that would rest on the book. */
  resting: number;
  /** The player's own resting quantity at crossing prices, which the engine skips. */
  selfSkipped: number;
  /** BUY: bits spent on the fills. SELL: gross proceeds of the fills. */
  spent: number;
  /** BUY: escrow taken at the limit (`price × qty`); SELL: 0 (the items are escrowed instead). */
  escrow: number;
  /** BUY: the difference to the limit given back for fills below it. */
  refund: number;
  /** Fees destroyed on the fills (the seller pays them, so a SELL receives `spent - fee`). */
  fee: number;
  /** The change in the player's bits once the order has been placed (BUY: fills + what rests in escrow; SELL: proceeds after the fee). */
  net: number;
}

/**
 * Plays an order against the visible book the way the api's engine does: best price first at the resting price, the
 * player's own orders skipped, a BUY escrowing `price × qty` and getting the difference back for better prices, the
 * seller paying `floor(total / 16)` per fill. The book shows one row per price, so the fee is computed per price level;
 * the engine floors it per resting order, which can come out a few bits lower when a level holds several orders.
 */
export function simulateOrder(book: Levels, own: readonly OwnOrder[], side: Side, price: number, qty: number, now = Date.now()): OrderSimulation {
  const crossing = (l: BookLevel) => (side === 'BUY' ? l.price <= price : l.price >= price);
  const rows = side === 'BUY' ? book.asks : book.bids;
  const visible = excludeOwn(book, own, now);
  const levels = (side === 'BUY' ? visible.asks : visible.bids).filter(crossing);
  const selfSkipped = rows.filter(crossing).reduce((s, l) => s + l.qty, 0) - levels.reduce((s, l) => s + l.qty, 0);
  const fills: OrderSimulation['fills'] = [];
  let left = qty;
  let spent = 0;
  let fee = 0;
  let refund = 0;
  for (const l of levels) {
    if (left === 0) break;
    const take = Math.min(left, l.qty);
    const f = feeOn(take * l.price);
    fills.push({ price: l.price, qty: take, fee: f });
    spent += take * l.price;
    fee += f;
    if (side === 'BUY') refund += (price - l.price) * take;
    left -= take;
  }
  const filled = qty - left;
  const escrow = side === 'BUY' ? price * qty : 0;
  return {
    fills,
    filled,
    average: filled > 0 ? spent / filled : null,
    resting: left,
    selfSkipped,
    spent,
    escrow,
    refund,
    fee,
    net: side === 'BUY' ? -(spent + price * left) : spent - fee,
  };
}

/** One of the player's fills, as the sim reports it: `fee` only for a sale. */
export interface FillNote {
  item: string;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  fee?: number;
}

export const EXCHANGE_FILLS_KEPT = 32;

/** The player's latest fills, newest first. They arrive whether or not the Exchange tab is open, so the connection feeds it. */
export function createExchangeStore() {
  let fills: FillNote[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { fills };
  const notify = () => {
    snapshot = { fills };
    listeners.forEach((l) => l());
  };
  return {
    push(f: FillNote) {
      fills = [f, ...fills].slice(0, EXCHANGE_FILLS_KEPT);
      notify();
    },
    clear() {
      if (fills.length === 0) return;
      fills = [];
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type ExchangeStore = ReturnType<typeof createExchangeStore>;
export const exchangeStore = createExchangeStore();

export function useExchangeFills(): FillNote[] {
  return useSyncExternalStore(exchangeStore.subscribe, exchangeStore.get, exchangeStore.get).fills;
}

/**
 * Reads the detail of a sim `exchange` fill event (untrusted: type-checked field by field). Returns null for anything
 * that is not a well-formed fill.
 */
export function parseFill(detail: unknown): FillNote | null {
  const d = detail as Record<string, unknown> | null;
  if (d === null || typeof d !== 'object') return null;
  const { item, price, qty, side, fee } = d;
  if (typeof item !== 'string' || !Number.isSafeInteger(price) || !Number.isSafeInteger(qty) || (side !== 'buy' && side !== 'sell')) return null;
  return { item, price: price as number, qty: qty as number, side, ...(side === 'sell' && Number.isSafeInteger(fee) ? { fee: fee as number } : {}) };
}

/** One of this operator's daemons that changed hands on the Exchange, as the sim reports it (`listingSold`). */
export interface SaleNote {
  listingId: string;
  species: string;
  price: number;
  fee: number;
  /** Which side of the sale this operator was. */
  role: 'buyer' | 'seller';
}

export const LISTING_SALES_KEPT = 16;

/**
 * The operator's latest daemon sales and purchases, newest first. `listingSold` arrives whether or not the Exchange
 * or Disk tab is open, so the connection feeds this store; `emit()` tells subscribers to refetch without a new sale.
 */
export function createListingStore() {
  let sales: SaleNote[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { sales };
  const notify = () => {
    snapshot = { sales };
    listeners.forEach((l) => l());
  };
  return {
    push(s: SaleNote) {
      sales = [s, ...sales].slice(0, LISTING_SALES_KEPT);
      notify();
    },
    emit: notify,
    clear() {
      if (sales.length === 0) return;
      sales = [];
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export type ListingStore = ReturnType<typeof createListingStore>;
export const listingStore = createListingStore();
/** Fired when one of this operator's daemons changed hands on the Exchange, so open panels can refetch. */
export const listingSold = listingStore;

/** A change to one of this operator's direct trades, as the sim reports it (`exchange { kind: 'trade' }`). */
export interface TradeNote {
  tradeId: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
}

export const TRADE_NOTES_KEPT = 16;

/**
 * The operator's latest trade changes, newest first. They arrive whether or not the Exchange tab is open, so the
 * connection feeds this store; `emit()` tells subscribers to refetch without a new change.
 */
export function createTradeStore() {
  let notes: TradeNote[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { notes };
  const notify = () => {
    snapshot = { notes };
    listeners.forEach((l) => l());
  };
  return {
    push(n: TradeNote) {
      notes = [n, ...notes].slice(0, TRADE_NOTES_KEPT);
      notify();
    },
    emit: notify,
    clear() {
      if (notes.length === 0) return;
      notes = [];
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export type TradeStore = ReturnType<typeof createTradeStore>;
export const tradeStore = createTradeStore();
/** Fired when one of this operator's direct trades changed (opened, offer, confirmation, done, cancelled). */
export const tradeChanged = tradeStore;

export function useTradeNotes(): TradeNote[] {
  return useSyncExternalStore(tradeStore.subscribe, tradeStore.get, tradeStore.get).notes;
}

/** Reads the detail of a sim `exchange` trade event (untrusted): null unless it names a trade and a known status. */
export function parseTradeNote(detail: unknown): TradeNote | null {
  const d = detail as Record<string, unknown> | null;
  if (d === null || typeof d !== 'object') return null;
  const { tradeId, status } = d;
  if (typeof tradeId !== 'string' || (status !== 'OPEN' && status !== 'DONE' && status !== 'CANCELLED')) return null;
  return { tradeId, status };
}

export function useListingSales(): SaleNote[] {
  return useSyncExternalStore(listingStore.subscribe, listingStore.get, listingStore.get).sales;
}

/**
 * Reads the detail of a sim `listingSold` event (untrusted: type-checked field by field). The sim has already turned
 * the buyer and seller ids into this operator's own `side` ('buy' | 'sell') and keeps the fee for the seller, so the
 * counterparty is never named. Returns null for anything that is not a well-formed sale.
 */
export function parseSale(detail: unknown): SaleNote | null {
  const d = detail as Record<string, unknown> | null;
  if (d === null || typeof d !== 'object') return null;
  const { listingId, species, price, fee, side } = d;
  if (typeof listingId !== 'string' || typeof species !== 'string' || !Number.isSafeInteger(price) || (side !== 'buy' && side !== 'sell')) return null;
  if (side === 'sell' && !Number.isSafeInteger(fee)) return null;
  return { listingId, species, price: price as number, fee: side === 'sell' ? (fee as number) : 0, role: side === 'sell' ? 'seller' : 'buyer' };
}

/** The log line for a fill. */
export function describeFill(f: FillNote): string {
  return `${f.side === 'sell' ? 'sold' : 'bought'} ${f.qty} ${f.item} @ ${f.price}${f.fee ? ` (fee ${f.fee})` : ''}`;
}
