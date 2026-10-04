// @vitest-environment jsdom
import { FEE_DIVISOR, MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY } from '@daemonet/rules';
import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyOrder } from '../src/api.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createExchangeStore, excludeOwn, feeOn, fillEstimate, orderPreview, simulateOrder, spread, type OwnOrder } from '../src/game/exchange.ts';
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
}));
const { ExchangePanel } = await import('../src/panels/ExchangePanel.tsx');
const { exchangeStore } = await import('../src/game/exchange.ts');

const client = (bits: number) => ({ self: { bits }, role: 'controller' }) as unknown as GameClient;
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
  exchangeStore.clear();
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

  it('previews exactly what the engine would do: fills at resting prices, the refund, the per-fill fee', () => {
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
    expect(sell).toContain('fee 12'); // 200 / 16
    expect(sell).toContain('receive 188');
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
