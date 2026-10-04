// @vitest-environment jsdom
import { FEE_DIVISOR, LISTING_TTL_MS, MAX_ACTIVE_LISTINGS, MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY } from '@daemonet/rules';
import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeListingError, type DiskDaemon, type Listing, type MyListing, type MyOrder } from '../src/api.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createExchangeStore, createListingStore, excludeOwn, feeOn, fillEstimate, ivTotal, listingNet, orderPreview, simulateOrder, spread, type OwnOrder } from '../src/game/exchange.ts';
import { createLog } from '../src/game/log.ts';

const book = { bids: [{ price: 40, qty: 5 }, { price: 38, qty: 2 }], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }] };

describe('exchange maths', () => {
  it('previews escrow for buys and proceeds after the 1/16 fee for sells', () => {
    expect(feeOn(96)).toBe(6);
    expect(feeOn(15)).toBe(0);
    expect(orderPreview('BUY', 50, 4)).toEqual({ total: 200, fee: 0, net: -200 });
    expect(orderPreview('SELL', 50, 4)).toEqual({ total: 200, fee: 12, net: 188 });
  });

  it('uses the rules constants the api uses', () => {
    expect(FEE_DIVISOR).toBe(16);
    expect(feeOn(MAX_PRICE * MAX_QTY)).toBe(2 ** 26); // the api's overflow test
    expect(MAX_ACTIVE_LISTINGS).toBe(16);
    expect(LISTING_TTL_MS).toBe(7 * 86_400_000);
  });

  it('a daemon listing brings its seller the price less the 1/16 fee; IVs add up', () => {
    expect(listingNet(160)).toBe(150);
    expect(listingNet(15)).toBe(15);
    expect(ivTotal([1, 2, 3, 4, 5, 6, 7, 8])).toBe(36);
  });

  it('describes listing failures: a lost Disk slot says nothing was charged and to retry; a short balance says so', () => {
    const e = (status: number, error: string, message: string) => ({ status, data: { error, message } });
    expect(describeListingError(e(409, 'conflict', 'a daemon just arrived in that Disk slot; try again'), 'buy')).toContain('try again');
    expect(describeListingError(e(409, 'conflict', 'a daemon just arrived in that Disk slot; try again'), 'buy')).toContain('nothing was charged');
    expect(describeListingError(e(402, 'insufficient_bits', 'need 64 bits'), 'buy')).toBe('not enough bits: need 64 bits');
    expect(describeListingError(e(400, 'bad_request', 'your Disk is full'), 'buy')).toBe('your Disk is full');
    expect(describeListingError({ status: 'FETCH_ERROR' }, 'buy')).toContain('network error');
    expect(describeListingError(e(500, 'internal_error', 'secret'), 'buy')).not.toContain('secret');
  });

  it('only a buy is told that nothing was charged: listing and unlisting never charge', () => {
    const conflict = { status: 409, data: { error: 'conflict', message: 'try again' } };
    expect(describeListingError(conflict, 'list')).not.toContain('charged');
    expect(describeListingError(conflict, 'unlist')).not.toContain('charged');
    expect(describeListingError(conflict, 'list')).toContain('try again');
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

const own = (side: 'BUY' | 'SELL', price: number, remaining: number, over: Partial<OwnOrder> = {}): OwnOrder => ({ side, price, remaining, status: 'OPEN', expiresAt: new Date(Date.now() + 60_000).toISOString(), ...over });

describe('simulateOrder (the engine`s own cases from the api tests)', () => {
  const asks = { bids: [], asks: [{ price: 48, qty: 2 }, { price: 64, qty: 6 }] };
  it('a BUY fills best price first at resting prices and refunds the difference to its limit', () => {
    const r = simulateOrder(asks, [], 'BUY', 80, 6);
    expect(r.fills).toEqual([
      { price: 48, qty: 2, fee: feeOn(96) },
      { price: 64, qty: 4, fee: feeOn(256) },
    ]);
    expect(r).toMatchObject({ filled: 6, resting: 0, spent: 96 + 256, refund: 32 * 2 + 16 * 4, escrow: 480, selfSkipped: 0 });
    expect(r.net).toBe(-(96 + 192 + 64)); // the api test's buyer balance change
    expect(r.average).toBe((96 + 256) / 6);
  });

  it('a SELL hits resting bids at their price, skips the player`s own bid, and the rest rests', () => {
    const bids = { bids: [{ price: 100, qty: 2 }, { price: 95, qty: 1 }, { price: 90, qty: 2 }], asks: [] };
    const r = simulateOrder(bids, [own('BUY', 95, 1)], 'SELL', 85, 5);
    expect(r.fills).toEqual([
      { price: 100, qty: 2, fee: 12 },
      { price: 90, qty: 2, fee: 11 },
    ]);
    expect(r).toMatchObject({ filled: 4, resting: 1, selfSkipped: 1, fee: 23 });
    expect(r.net).toBe(200 - 12 + (180 - 11)); // the api test: 357 in, the 95 bid stays untouched
  });

  it('a limit that does not cross rests whole: a BUY escrows price x qty, a SELL holds its items', () => {
    expect(simulateOrder(asks, [], 'BUY', 40, 3)).toMatchObject({ filled: 0, average: null, resting: 3, escrow: 120, net: -120, fills: [] });
    expect(simulateOrder(asks, [], 'SELL', 70, 3)).toMatchObject({ filled: 0, resting: 3, escrow: 0, net: 0 });
  });

  it('the largest order keeps its fee exact (no overflow)', () => {
    const r = simulateOrder({ bids: [{ price: MAX_PRICE, qty: MAX_QTY }], asks: [] }, [], 'SELL', MAX_PRICE, MAX_QTY);
    expect(r.fills).toEqual([{ price: MAX_PRICE, qty: MAX_QTY, fee: 2 ** 26 }]);
  });

  it('own resting quantity is taken out of a level, a level that was all the player`s own disappears, expired or closed orders are ignored', () => {
    const ex = excludeOwn({ bids: [], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }] }, [own('SELL', 50, 1), own('SELL', 60, 2), own('SELL', 60, 9, { status: 'CANCELLED' }), own('SELL', 50, 9, { expiresAt: new Date(Date.now() - 1).toISOString() }), own('BUY', 50, 9)]);
    expect(ex.asks).toEqual([{ price: 50, qty: 3 }]);
    expect(ex.bids).toEqual([]);
    expect(simulateOrder({ bids: [], asks: [{ price: 50, qty: 4 }] }, [own('SELL', 50, 3)], 'BUY', 50, 4)).toMatchObject({ filled: 1, resting: 3, selfSkipped: 3 });
  });
});

describe('listing store', () => {
  it('keeps the newest sales, is cleared on demand and notifies; emit() pokes subscribers', () => {
    const s = createListingStore();
    const seen = vi.fn();
    s.subscribe(seen);
    for (let i = 0; i < 20; i++) s.push({ listingId: `l${i}`, species: 'pingling', price: i + 1, fee: 0, role: 'seller' });
    expect(s.get().sales).toHaveLength(16);
    expect(s.get().sales[0]).toMatchObject({ listingId: 'l19' });
    const before = seen.mock.calls.length;
    s.emit();
    expect(seen.mock.calls.length).toBe(before + 1);
    s.clear();
    expect(s.get().sales).toEqual([]);
  });
});

describe('exchange store', () => {
  it('keeps the newest fills, is cleared on demand and notifies', () => {
    const s = createExchangeStore();
    const seen = vi.fn();
    s.subscribe(seen);
    for (let i = 0; i < 40; i++) s.push({ item: 'frag:heap', price: i + 1, qty: 1, side: 'buy' });
    expect(s.get().fills).toHaveLength(32);
    expect(s.get().fills[0]).toMatchObject({ price: 40 });
    s.clear();
    expect(s.get().fills).toEqual([]);
    expect(seen).toHaveBeenCalled();
  });
});

// ---- connection wiring ----

class FakeClient {
  readonly handlers = new Map<string, Set<(v: unknown) => void>>();
  subnet = 'lo';
  operatorId = 'op1';
  self = { ram: [] };
  constructor(readonly opts: ConnectOptions) {}
  on(name: string, h: (v: unknown) => void) {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }
  emit(name: string, v?: unknown) {
    for (const h of this.handlers.get(name) ?? []) h(v);
  }
  async start() {
    await this.opts.auth.getToken();
  }
  close() {}
}

describe('exchange events', () => {
  it('are captured in the store wired in the connection: logged, kept, and the orders, book and vault queries refetch', async () => {
    const clients: FakeClient[] = [];
    const log = createLog(100);
    const exchange = createExchangeStore();
    const invalidateExchange = vi.fn();
    const deps: ConnectionDeps = {
      fetchTicket: async () => 'ticket:t',
      createClient: (opts) => (clients.push(new FakeClient(opts)), clients.at(-1) as unknown as GameClient),
      url: () => 'ws://test/ws',
      log,
      capture: createCaptureStore(),
      stopSandbox: vi.fn(),
      invalidateCodex: vi.fn(),
      exchange,
      invalidateExchange,
    };
    const conn = createConnection(deps);
    await conn.open('controller');
    const c = clients[0]!;
    c.emit('exchange', { e: 'exchange', kind: 'fill', detail: { item: 'frag:heap', price: 20, qty: 3, side: 'sell', fee: 3 } });
    c.emit('exchange', { e: 'exchange', kind: 'fill', detail: { item: 'frag:heap', price: 20, qty: 1, side: 'buy' } });
    const texts = log.get().map((e) => e.text);
    expect(texts).toContain('Exchange: sold 3 frag:heap @ 20 (fee 3)');
    expect(texts).toContain('Exchange: bought 1 frag:heap @ 20');
    expect(exchange.get().fills.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(invalidateExchange).toHaveBeenCalledTimes(2);
    // anything else (an unknown kind, a malformed detail) is a log line only, never a crash
    c.emit('exchange', { e: 'exchange', kind: 'listing', detail: {} });
    c.emit('exchange', { e: 'exchange', kind: 'fill', detail: { item: 5, price: 'x' } });
    expect(log.get().map((e) => e.text)).toContain('Exchange: listing');
    expect(exchange.get().fills).toHaveLength(2);
    expect(invalidateExchange).toHaveBeenCalledTimes(4);
    // a reconnect may have missed fills
    c.emit('reconnect');
    expect(invalidateExchange).toHaveBeenCalledTimes(5);
    conn.close();
    expect(exchange.get().fills).toEqual([]);
  });
});

describe('listingSold events', () => {
  const setup = async () => {
    const clients: FakeClient[] = [];
    const log = createLog(100);
    const listings = createListingStore();
    const invalidateListings = vi.fn();
    const deps: ConnectionDeps = {
      fetchTicket: async () => 'ticket:t',
      createClient: (opts) => (clients.push(new FakeClient(opts)), clients.at(-1) as unknown as GameClient),
      url: () => 'ws://test/ws',
      log,
      capture: createCaptureStore(),
      stopSandbox: vi.fn(),
      invalidateCodex: vi.fn(),
      listings,
      invalidateListings,
    };
    const conn = createConnection(deps);
    await conn.open('controller');
    return { conn, c: clients[0]!, log, listings, invalidateListings };
  };

  it('are captured in the store wired in the connection: the seller is told, the buyer is not (their purchase logged itself), both refetch listings, Disk and ledger', async () => {
    const { conn, c, log, listings, invalidateListings } = await setup();
    c.emit('exchange', { e: 'exchange', kind: 'listingSold', detail: { listingId: 'l1', daemonId: 'd1', species: 'pingling', price: 64, side: 'sell', fee: 4 } });
    expect(log.get().map((e) => e.text)).toContain('Exchange: your pingling sold for 64 bits (60 after the fee)');
    expect(listings.get().sales).toEqual([{ listingId: 'l1', species: 'pingling', price: 64, fee: 4, role: 'seller' }]);
    expect(invalidateListings).toHaveBeenCalledTimes(1);
    c.emit('exchange', { e: 'exchange', kind: 'listingSold', detail: { listingId: 'l2', daemonId: 'd2', species: 'pingling', price: 32, side: 'buy' } });
    expect(log.get().filter((e) => e.text.includes('sold for'))).toHaveLength(1);
    expect(listings.get().sales[0]).toEqual({ listingId: 'l2', species: 'pingling', price: 32, fee: 0, role: 'buyer' });
    expect(invalidateListings).toHaveBeenCalledTimes(2);
    // a malformed detail is a log line and a refetch, never a crash or a sale
    c.emit('exchange', { e: 'exchange', kind: 'listingSold', detail: { species: 5, price: 'x' } });
    c.emit('exchange', { e: 'exchange', kind: 'listingSold', detail: { listingId: 'l3', species: 'pingling', price: 8, side: 'sell' } }); // a seller's view always carries the fee
    expect(log.get().map((e) => e.text)).toContain('Exchange: listingSold');
    expect(listings.get().sales).toHaveLength(2);
    expect(invalidateListings).toHaveBeenCalledTimes(4);
    c.emit('reconnect');
    expect(invalidateListings).toHaveBeenCalledTimes(5);
    conn.close();
    expect(listings.get().sales).toEqual([]);
  });
});

// ---- the panel ----

const q = vi.hoisted(() => ({
  items: { data: undefined as unknown },
  book: { data: undefined as unknown, error: undefined as unknown },
  orders: { data: undefined as unknown },
  vault: { data: undefined as unknown },
  place: vi.fn(),
  cancel: vi.fn(),
  bookArgs: [] as unknown[],
  polls: {} as Record<string, number | undefined>,
  listings: { data: undefined as unknown, error: undefined as unknown, refetch: vi.fn() },
  listingArgs: [] as unknown[],
  mine: { data: undefined as unknown },
  buy: vi.fn(),
  unlist: vi.fn(),
  list: vi.fn(),
  disk: { data: [] as unknown[], refetch: vi.fn() },
}));
type Poll = { pollingInterval?: number } | undefined;
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useExchangeItemsQuery: (_: unknown, o: Poll) => ((q.polls.items = o?.pollingInterval), q.items),
  useBookQuery: (item: string, o: Poll) => (q.bookArgs.push(item), (q.polls.book = o?.pollingInterval), q.book),
  useMyOrdersQuery: (_: unknown, o: Poll) => ((q.polls.orders = o?.pollingInterval), q.orders),
  useVaultQuery: (_: unknown, o: Poll) => ((q.polls.vault = o?.pollingInterval), q.vault),
  usePlaceOrderMutation: () => [q.place],
  useCancelOrderMutation: () => [q.cancel],
  useListingsQuery: (arg: unknown, o: Poll) => (q.listingArgs.push(arg), (q.polls.listings = o?.pollingInterval), q.listings),
  useMyListingsQuery: (_: unknown, o: Poll) => ((q.polls.mine = o?.pollingInterval), q.mine),
  useBuyListingMutation: () => [q.buy],
  useUnlistMutation: () => [q.unlist],
  useListDaemonMutation: () => [q.list],
  useDiskQuery: () => q.disk,
}));
vi.mock('../src/render/draw.ts', () => ({ spriteCanvas: () => document.createElement('canvas') }));
const { ExchangePanel } = await import('../src/panels/ExchangePanel.tsx');
const { exchangeStore } = await import('../src/game/exchange.ts');
const { DiskPanel } = await import('../src/panels/DiskPanel.tsx');
const { log: appLog } = await import('../src/game/log.ts');

const client = (bits: number) => ({ self: { bits, ram: [], diskCapacity: 256 }, role: 'controller', operatorId: 'me', subnet: 'lo' }) as unknown as GameClient;
const order = (over: Partial<MyOrder> = {}): MyOrder => ({ id: 'o1', item: 'frag:packet', side: 'SELL', price: 20, qty: 3, remaining: 3, status: 'OPEN', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over });
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const setInput = (id: string, v: string) => fireEvent.change(screen.getByTestId(id), { target: { value: v } });

beforeEach(() => {
  q.items.data = [{ id: 'frag:packet', name: 'Packet fragment', kind: 'fragment', bid: 40, ask: 50 }];
  q.book.data = { item: 'frag:packet', bids: [{ price: 40, qty: 5 }], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }], fills: [{ price: 50, qty: 1, at: new Date().toISOString() }] };
  q.book.error = undefined;
  q.orders.data = [];
  q.vault.data = { 'frag:packet': 5 };
  q.place.mockReset();
  q.cancel.mockReset();
  q.bookArgs = [];
  q.listings.data = { page: 0, more: false, listings: [] };
  q.listings.error = undefined;
  q.listings.refetch.mockReset();
  q.listingArgs = [];
  q.mine.data = [];
  q.buy.mockReset();
  q.unlist.mockReset();
  q.list.mockReset();
  q.disk.data = [];
  exchangeStore.clear();
  appLog.clear();
  HTMLCanvasElement.prototype.getContext = (() => ({ imageSmoothingEnabled: false, clearRect() {}, drawImage() {} })) as never;
});
afterEach(cleanup);

describe('ExchangePanel', () => {
  it('shows the book, the vault and the player`s bits; clicking an ask fills the form with a BUY at that price', () => {
    render(<ExchangePanel client={client(1000)} />);
    expect(screen.getByTestId('exchange-vault').textContent).toContain('vault ×5');
    expect(screen.getByTestId('exchange-vault').textContent).toContain('1000 bits');
    expect(screen.getByTestId('ask-50').textContent).toContain('×4');
    expect(screen.getByTestId('book').textContent).toContain('spread 10');
    fireEvent.click(screen.getByTestId('ask-60'));
    expect((screen.getByTestId('order-price') as HTMLInputElement).value).toBe('60');
    expect(screen.getByTestId('side-BUY').className).toContain('emerald');
  });

  it('previews what the engine would do: fills at resting prices and the refund; a SELL`s fee is an upper bound (the engine floors it per resting order)', () => {
    render(<ExchangePanel client={client(1000)} />);
    setInput('order-price', '60');
    setInput('order-qty', '5');
    const text = screen.getByTestId('order-preview').textContent!;
    expect(text).toContain('fills 5 now'); // 4 at 50, 1 at 60
    expect(text).toContain('spend 260'); // 200 + 60
    expect(text).toContain('refund 40'); // limit 60: 4 x 10 back
    fireEvent.click(screen.getByTestId('side-SELL'));
    setInput('order-price', '40');
    setInput('order-qty', '5');
    const sell = screen.getByTestId('order-preview').textContent!;
    expect(sell).toContain('fills 5 now');
    expect(sell).toContain('fee up to 12'); // 200 / 16 for the level; per resting order it can floor lower
    expect(sell).toContain('receive at least 188');
  });

  it('says the vault is loading instead of claiming it is empty', () => {
    q.vault.data = undefined;
    render(<ExchangePanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('side-SELL'));
    expect(screen.getByTestId('exchange-vault').textContent).toContain('vault ×…');
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('order-why').textContent).toContain('…');
    expect(screen.getByTestId('order-why').textContent).not.toContain('only 0');
  });

  it('notes when the player`s own resting order would be skipped', () => {
    q.orders.data = [order({ id: 'mine', side: 'SELL', item: 'frag:packet', price: 50, qty: 4, remaining: 4 })];
    render(<ExchangePanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('side-BUY'));
    setInput('order-price', '50');
    setInput('order-qty', '2');
    expect(screen.getByTestId('order-preview').textContent).toContain('fills 0 now');
    expect(screen.getByTestId('self-match').textContent).toContain('4');
  });

  it('places a limit order once (in-flight guard), shows the result, and reports a refusal inline', async () => {
    const d = deferred<unknown>();
    q.place.mockReturnValue({ unwrap: () => d.promise });
    render(<ExchangePanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('side-BUY'));
    setInput('order-price', '50');
    setInput('order-qty', '2');
    fireEvent.click(screen.getByTestId('order-place'));
    fireEvent.click(screen.getByTestId('order-place')); // double click
    expect(q.place).toHaveBeenCalledTimes(1);
    expect(q.place).toHaveBeenCalledWith({ item: 'frag:packet', side: 'BUY', price: 50, qty: 2 });
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => d.resolve({ order: order({ remaining: 0, status: 'FILLED' }), fills: [{ price: 50, qty: 2, fee: 6 }] }));
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('order-result').textContent).toContain('2 filled');
    q.place.mockReturnValue({ unwrap: () => Promise.reject({ status: 400, data: { error: 'bad_request', message: 'at most 16 open orders' } }) });
    fireEvent.click(screen.getByTestId('order-place'));
    await act(async () => {});
    expect(screen.getByTestId('order-error').textContent).toBe('at most 16 open orders');
    q.place.mockReturnValue({ unwrap: () => Promise.reject({ status: 'FETCH_ERROR' }) });
    fireEvent.click(screen.getByTestId('order-place'));
    await act(async () => {});
    expect(screen.getByTestId('order-error').textContent).toContain('network error');
  });

  it('says why placing is disabled: bits, vault items, bounds, the open-order cap', () => {
    render(<ExchangePanel client={client(10)} />);
    fireEvent.click(screen.getByTestId('side-BUY'));
    setInput('order-price', '50');
    setInput('order-qty', '1');
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('order-why').textContent).toContain('not enough bits');
    fireEvent.click(screen.getByTestId('side-SELL'));
    setInput('order-qty', '6');
    expect(screen.getByTestId('order-why').textContent).toContain('vault');
    setInput('order-qty', '1');
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(false);
    setInput('order-price', String(MAX_PRICE + 1));
    expect((screen.getByTestId('order-price') as HTMLInputElement).value).toBe(String(MAX_PRICE)); // clamped
    cleanup();
    q.orders.data = Array.from({ length: MAX_OPEN_ORDERS }, (_, i) => order({ id: `o${i}`, item: 'frag:socket' }));
    render(<ExchangePanel client={client(100_000)} />);
    fireEvent.click(screen.getByTestId('side-SELL'));
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('order-why').textContent).toContain(`${MAX_OPEN_ORDERS} open orders`);
  });

  it('polls slowly (fills and actions refetch at once through events and tag invalidation)', () => {
    render(<ExchangePanel client={client(1000)} />);
    expect(q.polls).toEqual({ items: 60_000, book: 16_000, orders: 16_000, vault: 16_000 });
  });

  it('the open-order cap counts only orders that have not expired (as the api does)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    q.orders.data = [
      ...Array.from({ length: MAX_OPEN_ORDERS }, (_, i) => order({ id: `x${i}`, item: 'frag:socket', expiresAt: past })),
      order({ id: 'live', item: 'frag:socket' }),
    ];
    render(<ExchangePanel client={client(100_000)} />);
    fireEvent.click(screen.getByTestId('side-SELL'));
    expect((screen.getByTestId('order-place') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('my-orders').textContent).toContain(`(1/${MAX_OPEN_ORDERS} open)`);
  });

  it('lists the player`s orders with progress, cancels an open one once, and shows a failed cancel', async () => {
    const d = deferred<unknown>();
    q.cancel.mockReturnValue({ unwrap: () => d.promise });
    q.orders.data = [order({ id: 'a', remaining: 1 }), order({ id: 'b', status: 'FILLED', remaining: 0 })];
    render(<ExchangePanel client={client(1000)} />);
    const mine = screen.getByTestId('my-orders');
    expect(mine.textContent).toContain('2/3 @ 20');
    expect(mine.textContent).toContain('3/3 @ 20');
    expect(screen.getAllByRole('button', { name: 'cancel' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect((screen.getByRole('button', { name: 'cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(q.cancel).toHaveBeenCalledTimes(1);
    expect(q.cancel).toHaveBeenCalledWith('a');
    await act(async () => d.reject({ status: 400, data: { error: 'bad_request', message: 'order is filled' } }));
    expect(screen.getByTestId('order-error').textContent).toBe('order is filled');
    expect((screen.getByRole('button', { name: 'cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists fills captured by the connection store and renders only text', () => {
    exchangeStore.push({ item: 'frag:packet', price: 20, qty: 3, side: 'sell', fee: 3 });
    exchangeStore.push({ item: '<img src=x onerror=alert(1)>', price: 5, qty: 1, side: 'buy' });
    render(<ExchangePanel client={client(1000)} />);
    const fills = screen.getByTestId('my-fills');
    expect(fills.textContent).toContain('sold 3 frag:packet @ 20');
    expect(fills.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(fills.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/github\.com/i);
  });

  it('switches the book with the item selector and shows a load error instead of a stale book', () => {
    q.items.data = [
      { id: 'frag:packet', name: 'Packet fragment', kind: 'fragment', bid: null, ask: null },
      { id: 'frag:heap', name: 'Heap fragment', kind: 'fragment', bid: null, ask: 20 },
    ];
    render(<ExchangePanel client={client(1000)} />);
    fireEvent.change(screen.getByTestId('exchange-item'), { target: { value: 'frag:heap' } });
    expect(q.bookArgs.at(-1)).toBe('frag:heap');
    q.book.error = { status: 500 };
    q.book.data = undefined;
    fireEvent.change(screen.getByTestId('exchange-item'), { target: { value: 'frag:packet' } });
    expect(screen.getByTestId('book-error').textContent).toContain('server error');
  });
});

// ---- daemon listings ----

const listing = (id: string, over: Partial<Listing> = {}, daemon: Partial<Listing['daemon']> = {}): Listing => ({
  id: `L-${id}`,
  price: 64,
  sellerId: 'seller',
  sellerName: 'Bob',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
  daemon: {
    id,
    species: 'pingling',
    level: 8,
    nature: 0,
    traitSlot: 0,
    ivs: [1, 2, 3, 4, 5, 6, 7, 8],
    clean: false,
    signature: 0,
    moves: ['ping'],
    heldItem: null,
    patched: false,
    crashes: 0,
    arenaWins: 0,
    history: [{ at: '2026-10-02T00:00:00.000Z', kind: 'traded', detail: 'sold on the Exchange for 40 bits' }],
    log: { originalOperatorId: 'x', capturedAt: '2026-10-01T00:00:00Z', subnet: 'lo', tool: 'sniff', spawnIndex: null },
    ...daemon,
  },
  ...over,
});
const mineRow = (id: string, over: Partial<MyListing> = {}): MyListing => ({ id, price: 64, status: 'ACTIVE', species: 'pingling', level: 8, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), soldAt: null, ...over });
const open = () => fireEvent.click(screen.getByTestId('exchange-daemons'));
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

describe('ExchangePanel views', () => {
  it('switches between the item market and the daemon listings', () => {
    render(<ExchangePanel client={client(1000)} />);
    expect(screen.getByTestId('book')).toBeTruthy();
    expect(screen.queryByTestId('listings')).toBeNull();
    open();
    expect(screen.getByTestId('listings')).toBeTruthy();
    expect(screen.queryByTestId('book')).toBeNull();
    fireEvent.click(screen.getByTestId('exchange-items'));
    expect(screen.getByTestId('book')).toBeTruthy();
  });
});

describe('ListingsPanel', () => {
  it('lists daemons as text only with the seller, price and details (capture log, history incl. traded); polls slowly', () => {
    q.listings.data = { page: 0, more: false, listings: [listing('d1', { sellerName: '<img src=x onerror=alert(1)>' }), listing('d2', { sellerId: 'me', sellerName: 'Me' })] };
    render(<ExchangePanel client={client(1000)} />);
    open();
    const row = screen.getByTestId('listing-d1');
    expect(row.textContent).toContain('64 bits');
    expect(row.textContent).toContain('ivs 36');
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(row.querySelector('img')).toBeNull();
    expect(screen.getByTestId('listing-d2').textContent).toContain('yours');
    expect(screen.queryByTestId('buy-d2')).toBeNull();
    fireEvent.click(screen.getByTestId('details-d1'));
    expect(screen.getByTestId('listing-d1').textContent).toContain('traded: sold on the Exchange for 40 bits');
    expect(screen.getByTestId('listing-d1').textContent).toContain('sniff');
    expect(q.polls.listings).toBe(8000);
    expect(q.polls.mine).toBe(8000);
    expect(document.body.innerHTML).not.toMatch(/github\.com/i);
  });

  it('buying asks for confirmation, then buys once (in-flight guard), logs it and shows the result', async () => {
    const d = deferred<unknown>();
    q.buy.mockReturnValue({ unwrap: () => d.promise });
    q.listings.data = { page: 0, more: false, listings: [listing('d1')] };
    render(<ExchangePanel client={client(1000)} />);
    open();
    fireEvent.click(btn('buy-d1'));
    expect(q.buy).not.toHaveBeenCalled(); // spends bits: confirm first
    fireEvent.click(btn('buy-confirm-d1'));
    fireEvent.click(btn('buy-confirm-d1'));
    expect(q.buy).toHaveBeenCalledTimes(1);
    expect(q.buy).toHaveBeenCalledWith('L-d1');
    expect(btn('buy-confirm-d1').disabled).toBe(true);
    await act(async () => d.resolve({ daemonId: 'd1', slot: 3, price: 64, fee: 4 }));
    expect(screen.getByTestId('listings-result').textContent).toContain('bought Pingling for 64 bits');
    expect(appLog.get().map((e) => e.text)).toContain('bought Pingling for 64 bits (Disk slot 3)');
    expect(screen.queryByTestId('buy-confirm-d1')).toBeNull();
  });

  it('a lost Disk slot (409) says nothing was charged and to try again; a closed listing shows inline', async () => {
    q.listings.data = { page: 0, more: false, listings: [listing('d1')] };
    render(<ExchangePanel client={client(1000)} />);
    open();
    q.buy.mockReturnValue({ unwrap: () => Promise.reject({ status: 409, data: { error: 'conflict', message: 'a daemon just arrived in that Disk slot; try again' } }) });
    fireEvent.click(btn('buy-d1'));
    fireEvent.click(btn('buy-confirm-d1'));
    await act(async () => {});
    expect(screen.getByTestId('listings-error').textContent).toContain('try again');
    expect(screen.getByTestId('listings-error').textContent).toContain('nothing was charged');
    expect(btn('buy-d1').disabled).toBe(false); // retryable
    q.buy.mockReturnValue({ unwrap: () => Promise.reject({ status: 400, data: { error: 'bad_request', message: 'that listing is no longer available' } }) });
    fireEvent.click(btn('buy-d1'));
    fireEvent.click(btn('buy-confirm-d1'));
    await act(async () => {});
    expect(screen.getByTestId('listings-error').textContent).toBe('that listing is no longer available');
  });

  it('a failed buy refetches the listings (the shown one may be gone or changed); a successful one does not need to', async () => {
    q.listings.data = { page: 0, more: false, listings: [listing('d1')] };
    render(<ExchangePanel client={client(1000)} />);
    open();
    q.buy.mockReturnValue({ unwrap: () => Promise.reject({ status: 400, data: { error: 'bad_request', message: 'that listing is no longer available' } }) });
    fireEvent.click(btn('buy-d1'));
    fireEvent.click(btn('buy-confirm-d1'));
    await act(async () => {});
    expect(q.listings.refetch).toHaveBeenCalledTimes(1);
    q.buy.mockReturnValue({ unwrap: () => Promise.resolve({ daemonId: 'd1', slot: 0, price: 64, fee: 4 }) });
    fireEvent.click(btn('buy-d1'));
    fireEvent.click(btn('buy-confirm-d1'));
    await act(async () => {});
    expect(q.listings.refetch).toHaveBeenCalledTimes(1); // the mutation's tag invalidation refetches on success
  });

  it('filters by bestiary line', () => {
    vi.useFakeTimers();
    try {
      render(<ExchangePanel client={client(1000)} />);
      open();
      const line = screen.getByTestId('listing-line') as HTMLSelectElement;
      expect(line.textContent).toContain('Initling'); // each line is named after its first form
      fireEvent.change(line, { target: { value: '2' } });
      act(() => void vi.advanceTimersByTime(500));
      expect(q.listingArgs.at(-1)).toEqual({ sort: 'price', page: 0, line: 2 });
      fireEvent.change(screen.getByTestId('listing-line'), { target: { value: '' } });
      act(() => void vi.advanceTimersByTime(500));
      expect(q.listingArgs.at(-1)).toEqual({ sort: 'price', page: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why buying is disabled when the balance is short', () => {
    q.listings.data = { page: 0, more: false, listings: [listing('d1', { price: 500 })] };
    render(<ExchangePanel client={client(100)} />);
    open();
    expect(btn('buy-d1').disabled).toBe(true);
    expect(btn('buy-d1').title).toContain('400');
    expect(screen.getByTestId('listing-d1').textContent).toContain('need 400 more bits');
  });

  it('filters are applied together after a short pause and return to page 0; pages move with next / previous', () => {
    vi.useFakeTimers();
    try {
      q.listings.data = { page: 0, more: true, listings: [listing('d1')] };
      render(<ExchangePanel client={client(1000)} />);
      open();
      expect(q.listingArgs.at(-1)).toEqual({ sort: 'price', page: 0 });
      fireEvent.change(screen.getByTestId('listing-species'), { target: { value: ' Pingling ' } });
      fireEvent.change(screen.getByTestId('listing-max'), { target: { value: '100' } });
      fireEvent.click(screen.getByTestId('listing-clean'));
      fireEvent.change(screen.getByTestId('listing-sig'), { target: { value: '3' } });
      fireEvent.change(screen.getByTestId('listing-type'), { target: { value: 'glitch' } });
      fireEvent.change(screen.getByTestId('listing-sort'), { target: { value: 'new' } });
      const calls = q.listingArgs.length;
      act(() => void vi.advanceTimersByTime(100));
      expect(q.listingArgs.slice(calls).every((a) => JSON.stringify(a) === JSON.stringify({ sort: 'price', page: 0 }))).toBe(true); // nothing fired mid-typing
      act(() => void vi.advanceTimersByTime(500));
      expect(q.listingArgs.at(-1)).toEqual({ sort: 'new', page: 0, species: 'pingling', maxPrice: 100, clean: true, minSignature: 3, type: 'glitch' });
      fireEvent.click(screen.getByTestId('listing-next'));
      act(() => void vi.advanceTimersByTime(500));
      expect(q.listingArgs.at(-1)).toMatchObject({ page: 1 });
      q.listings.data = { page: 1, more: false, listings: [] };
      fireEvent.click(screen.getByTestId('listing-prev'));
      act(() => void vi.advanceTimersByTime(500));
      expect(q.listingArgs.at(-1)).toMatchObject({ page: 0 });
      fireEvent.change(screen.getByTestId('listing-sig'), { target: { value: '99' } });
      expect((screen.getByTestId('listing-sig') as HTMLInputElement).value).toBe('15');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an empty result and a load error instead of stale listings', () => {
    q.listings.data = { page: 0, more: false, listings: [] };
    render(<ExchangePanel client={client(1000)} />);
    open();
    expect(screen.getByTestId('listings').textContent).toContain('no listings match');
    q.listings.error = { status: 500 };
    q.listings.data = undefined;
    cleanup();
    render(<ExchangePanel client={client(1000)} />);
    open();
    expect(screen.getByTestId('listings-load-error').textContent).toContain('server error');
  });

  it('my listings show the price after the fee and the status; an active one can be unlisted once, a failure shows inline', async () => {
    const d = deferred<unknown>();
    q.unlist.mockReturnValue({ unwrap: () => d.promise });
    q.mine.data = [mineRow('a'), mineRow('b', { status: 'SOLD', soldAt: '2026-10-03T00:00:00.000Z' })];
    render(<ExchangePanel client={client(1000)} />);
    open();
    const mine = screen.getByTestId('my-listings');
    expect(mine.textContent).toContain('64 bits (60 after the fee)');
    expect(mine.textContent).toContain('sold');
    expect(screen.getAllByRole('button', { name: 'unlist' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'unlist' }));
    fireEvent.click(screen.getByRole('button', { name: 'unlist' }));
    expect(q.unlist).toHaveBeenCalledTimes(1);
    expect(q.unlist).toHaveBeenCalledWith('a');
    await act(async () => d.reject({ status: 400, data: { error: 'bad_request', message: 'listing is sold' } }));
    expect(screen.getByTestId('listings-error').textContent).toBe('listing is sold');
    expect((screen.getByRole('button', { name: 'unlist' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('DiskPanel and the Exchange', () => {
  const row = (id: string, lockedBy: string | null, over: Partial<DiskDaemon> = {}): DiskDaemon => ({
    id, species: 'pingling', level: 8, clean: false, signature: 0, slot: 1, hp: 10, moves: ['ping'], ivs: [1], heldItem: null, patched: false, moveTypeUses: [], crashes: 0, history: [], lockedBy,
    log: { originalOperatorId: 'x', capturedAt: '2026-10-01T00:00:00Z', subnet: 'lo', spawnIndex: null, tool: 'sniff' },
    ...over,
  });

  it('offers list for an unlocked daemon and unlist for one locked by a listing (not for an order lock)', async () => {
    q.disk.data = [row('free', null), row('listed', 'listing:L-9'), row('ordered', 'order:o1')];
    q.unlist.mockReturnValue({ unwrap: () => Promise.resolve({ ok: true }) });
    render(<DiskPanel client={client(1000)} />);
    expect(screen.getByTestId('list-free').textContent).toBe('list');
    expect(screen.queryByTestId('unlist-free')).toBeNull();
    expect(screen.queryByTestId('list-listed')).toBeNull();
    expect(screen.getByTestId('unlist-listed').textContent).toBe('unlist');
    expect(screen.queryByTestId('list-ordered')).toBeNull();
    expect(screen.queryByTestId('unlist-ordered')).toBeNull();
    fireEvent.click(screen.getByTestId('unlist-listed'));
    fireEvent.click(screen.getByTestId('unlist-listed'));
    expect(q.unlist).toHaveBeenCalledTimes(1);
    expect(q.unlist).toHaveBeenCalledWith('L-9');
    await act(async () => {});
  });

  it('lists at a price after a confirm step that shows the fee and the lock, once; a refusal shows inline', async () => {
    const d = deferred<unknown>();
    q.list.mockReturnValue({ unwrap: () => d.promise });
    q.disk.data = [row('free', null)];
    render(<DiskPanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('list-free'));
    expect(q.list).not.toHaveBeenCalled();
    setInput('list-price', '64');
    expect(screen.getByTestId('list-preview').textContent).toContain('you get 60');
    expect(screen.getByTestId('list-preview').textContent).toContain('7 days');
    expect(screen.getByTestId('list-preview').textContent).toContain('locked');
    fireEvent.click(screen.getByTestId('list-confirm'));
    fireEvent.click(screen.getByTestId('list-confirm'));
    expect(q.list).toHaveBeenCalledTimes(1);
    expect(q.list).toHaveBeenCalledWith({ daemonId: 'free', price: 64 });
    expect(btn('list-confirm').disabled).toBe(true);
    await act(async () => d.reject({ status: 400, data: { error: 'bad_request', message: 'at most 16 active listings' } }));
    expect(screen.getByTestId('list-error').textContent).toBe('at most 16 active listings');
    expect(btn('list-confirm').disabled).toBe(false);
    q.list.mockReturnValue({ unwrap: () => Promise.resolve({ id: 'x', price: 64, expiresAt: 'z' }) });
    fireEvent.click(screen.getByTestId('list-confirm'));
    await act(async () => {});
    expect(screen.queryByTestId('list-price')).toBeNull();
    expect(appLog.get().map((e) => e.text)).toContain('listed Pingling for 64 bits');
  });

  it('refuses prices outside 1..max and says why; listing is disabled at the active-listing cap', () => {
    q.disk.data = [row('free', null)];
    render(<DiskPanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('list-free'));
    setInput('list-price', '0');
    expect(btn('list-confirm').disabled).toBe(true);
    expect(screen.getByTestId('list-why').textContent).toContain(String(MAX_PRICE));
    setInput('list-price', String(MAX_PRICE + 1));
    expect(btn('list-confirm').disabled).toBe(true);
    setInput('list-price', '');
    expect(btn('list-confirm').disabled).toBe(true);
    setInput('list-price', String(MAX_PRICE));
    expect(btn('list-confirm').disabled).toBe(false);
    cleanup();
    q.mine.data = Array.from({ length: MAX_ACTIVE_LISTINGS }, (_, i) => mineRow(`m${i}`));
    render(<DiskPanel client={client(1000)} />);
    expect(btn('list-free').disabled).toBe(true);
    expect(btn('list-free').title).toContain(`${MAX_ACTIVE_LISTINGS} active listings`);
  });

  it('shows the daemon history, including traded entries, as text', () => {
    q.disk.data = [row('free', null, { history: [{ at: '2026-10-02T00:00:00.000Z', kind: 'traded', detail: 'sold on the Exchange for 40 bits <b>x</b>' }] })];
    render(<DiskPanel client={client(1000)} />);
    fireEvent.click(screen.getByTestId('history-toggle-free'));
    const h = screen.getByTestId('history-free');
    expect(h.textContent).toContain('traded: sold on the Exchange for 40 bits <b>x</b>');
    expect(h.querySelector('b')).toBeNull();
  });
});
