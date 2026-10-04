// @vitest-environment jsdom
import { FEE_DIVISOR, MAX_OPEN_TRADES, MAX_TRADE_BITS, MAX_TRADE_DAEMONS, MAX_TRADE_ITEMS, TRADE_IDLE_MS } from '@daemonet/rules';
import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTradeError, type DiskDaemon, type ListedDaemon, type Trade, type TradeSide } from '../src/api.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createTradeStore, parseTradeNote } from '../src/game/exchange.ts';
import { createLog } from '../src/game/log.ts';

describe('trade limits come from @daemonet/rules (the api re-exports them)', () => {
  it('pins the values', () => {
    expect([MAX_OPEN_TRADES, MAX_TRADE_DAEMONS, MAX_TRADE_ITEMS, TRADE_IDLE_MS, FEE_DIVISOR]).toEqual([4, 8, 16, 3_600_000, 16]);
    expect(MAX_TRADE_BITS).toBe(1_048_576 * 16);
  });
});

describe('describeTradeError', () => {
  const e = (status: number, error: string, message: string) => ({ status, data: { error, message } });
  it('says what a stale confirmation, a lost slot, a short balance and the api`s own reasons mean', () => {
    expect(describeTradeError(e(409, 'stale_offer', 'the offers changed; look again before confirming'), 'confirm')).toContain('review the new offer');
    expect(describeTradeError(e(409, 'conflict', 'a daemon just arrived in a Disk slot; try again'), 'confirm')).toBe('a daemon just arrived in a Disk slot; try again (nothing moved)');
    expect(describeTradeError(e(402, 'insufficient_bits', 'you do not have 64 bits'), 'offer')).toBe('not enough bits: you do not have 64 bits');
    expect(describeTradeError(e(402, 'insufficient_bits', 'they cannot pay'), 'confirm')).toContain('still open');
    expect(describeTradeError(e(400, 'validation_error', 'at most 8 daemons'), 'offer')).toBe('at most 8 daemons');
    expect(describeTradeError(e(403, 'forbidden', 'that operator is not accepting trades from you'), 'open')).toBe('that operator is not accepting trades from you');
    expect(describeTradeError({ status: 'FETCH_ERROR' }, 'offer')).toContain('network error');
    expect(describeTradeError(e(500, 'internal_error', 'secret'), 'offer')).not.toContain('secret');
  });
});

describe('trade store', () => {
  it('keeps the newest changes, is cleared on demand and notifies; details are validated', () => {
    const s = createTradeStore();
    const seen = vi.fn();
    s.subscribe(seen);
    for (let i = 0; i < 20; i++) s.push({ tradeId: `t${i}`, status: 'OPEN' });
    expect(s.get().notes).toHaveLength(16);
    expect(s.get().notes[0]).toEqual({ tradeId: 't19', status: 'OPEN' });
    s.emit();
    s.clear();
    expect(s.get().notes).toEqual([]);
    expect(seen).toHaveBeenCalled();
    expect(parseTradeNote({ tradeId: 'x', status: 'DONE' })).toEqual({ tradeId: 'x', status: 'DONE' });
    expect(parseTradeNote({ tradeId: 'x', status: 'ODD' })).toBeNull();
    expect(parseTradeNote({ status: 'DONE' })).toBeNull();
    expect(parseTradeNote(null)).toBeNull();
  });
});

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

describe('trade events', () => {
  const setup = async () => {
    const clients: FakeClient[] = [];
    const log = createLog(100);
    const trades = createTradeStore();
    const invalidateTrades = vi.fn();
    const deps: ConnectionDeps = {
      fetchTicket: async () => 'ticket:t',
      createClient: (opts) => (clients.push(new FakeClient(opts)), clients.at(-1) as unknown as GameClient),
      url: () => 'ws://test/ws',
      log,
      capture: createCaptureStore(),
      stopSandbox: vi.fn(),
      invalidateCodex: vi.fn(),
      trades,
      invalidateTrades,
    };
    const conn = createConnection(deps);
    await conn.open('controller');
    return { conn, c: clients[0]!, log, trades, invalidateTrades };
  };

  it('are captured in the store wired in the connection: logged on done / cancelled, every change refetches, a reconnect refetches, close clears', async () => {
    const { conn, c, log, trades, invalidateTrades } = await setup();
    c.emit('exchange', { e: 'exchange', kind: 'trade', detail: { tradeId: 't1', status: 'OPEN' } });
    expect(trades.get().notes).toEqual([{ tradeId: 't1', status: 'OPEN' }]);
    expect(invalidateTrades).toHaveBeenCalledTimes(1);
    expect(log.get().map((e) => e.text)).not.toContain('Exchange: trade');
    c.emit('exchange', { e: 'exchange', kind: 'trade', detail: { tradeId: 't1', status: 'DONE' } });
    expect(log.get().map((e) => e.text)).toContain('Exchange: trade completed');
    c.emit('exchange', { e: 'exchange', kind: 'trade', detail: { tradeId: 't2', status: 'CANCELLED' } });
    expect(log.get().map((e) => e.text)).toContain('Exchange: trade cancelled');
    expect(invalidateTrades).toHaveBeenCalledTimes(3);
    // a malformed detail is a log line and a refetch, never a crash or a note
    c.emit('exchange', { e: 'exchange', kind: 'trade', detail: { status: 5 } });
    expect(log.get().map((e) => e.text)).toContain('Exchange: trade');
    expect(trades.get().notes).toHaveLength(3);
    expect(invalidateTrades).toHaveBeenCalledTimes(4);
    c.emit('reconnect');
    expect(invalidateTrades).toHaveBeenCalledTimes(5);
    conn.close();
    expect(trades.get().notes).toEqual([]);
  });
});

// ---- the panel ----

const q = vi.hoisted(() => ({
  trades: { data: [] as unknown[], error: undefined as unknown },
  tradeArgs: [] as unknown[],
  polls: {} as Record<string, number | undefined>,
  open: vi.fn(),
  setOffer: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  vault: { data: { 'frag:heap': 5 } as Record<string, number> | undefined },
  mine: { data: [] as unknown },
  disk: { data: [] as unknown[], refetch: vi.fn() },
}));
type Poll = { pollingInterval?: number } | undefined;
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useTradesQuery: (arg: unknown, o: Poll) => (q.tradeArgs.push(arg), (q.polls.trades = o?.pollingInterval), q.trades),
  useOpenTradeMutation: () => [q.open],
  useSetOfferMutation: () => [q.setOffer],
  useConfirmTradeMutation: () => [q.confirm],
  useCancelTradeMutation: () => [q.cancel],
  useVaultQuery: () => q.vault,
  useDiskQuery: () => q.disk,
  useMyListingsQuery: () => q.mine,
  useListDaemonMutation: () => [vi.fn()],
  useUnlistMutation: () => [vi.fn()],
  useExchangeItemsQuery: () => ({ data: [] }),
  useBookQuery: () => ({ data: undefined, error: undefined }),
  useMyOrdersQuery: () => ({ data: [] }),
  usePlaceOrderMutation: () => [vi.fn()],
  useCancelOrderMutation: () => [vi.fn()],
}));
vi.mock('../src/render/draw.ts', () => ({ spriteCanvas: () => document.createElement('canvas') }));
const { TradesPanel } = await import('../src/panels/TradesPanel.tsx');
const { ExchangePanel } = await import('../src/panels/ExchangePanel.tsx');
const { DiskPanel } = await import('../src/panels/DiskPanel.tsx');
const { log: appLog } = await import('../src/game/log.ts');

const client = (bits: number) => ({ self: { bits, ram: [], diskCapacity: 256 }, role: 'controller', operatorId: 'me', subnet: 'lo' }) as unknown as GameClient;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const listed = (id: string, over: Partial<ListedDaemon> = {}): ListedDaemon => ({
  id, species: 'pingling', level: 8, nature: 0, traitSlot: 0, ivs: [1, 2, 3, 4], clean: false, signature: 0, moves: ['ping'], heldItem: null, patched: false, crashes: 0, arenaWins: 0, history: [],
  log: { originalOperatorId: 'x', capturedAt: '2026-10-01T00:00:00Z', subnet: 'lo', spawnIndex: null, tool: 'sniff' },
  ...over,
});
const side = (id: string, name: string | null, offer: Partial<TradeSide['offer']> = {}, confirmed = false): TradeSide => ({ id, name, confirmed, offer: { bits: 0, items: {}, daemons: [], ...offer } });
const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 'T1', status: 'OPEN', version: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  me: side('me', 'Me'), them: side('o1', 'Bob'), ...over,
});
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const setInput = (id: string, v: string) => fireEvent.change(screen.getByTestId(id), { target: { value: v } });
const ok = <T,>(v: T) => ({ unwrap: () => Promise.resolve(v) });

beforeEach(() => {
  q.trades.data = [];
  q.trades.error = undefined;
  q.tradeArgs = [];
  q.open.mockReset();
  q.setOffer.mockReset();
  q.confirm.mockReset();
  q.cancel.mockReset();
  q.vault.data = { 'frag:heap': 5 };
  q.mine.data = [];
  q.disk.data = [];
  appLog.clear();
  HTMLCanvasElement.prototype.getContext = (() => ({ imageSmoothingEnabled: false, clearRect() {}, drawImage() {} })) as never;
});
afterEach(cleanup);

describe('Exchange tab', () => {
  it('has a trades view', () => {
    render(<ExchangePanel client={client(1000)} />);
    expect(screen.queryByTestId('trades')).toBeNull();
    fireEvent.click(screen.getByTestId('exchange-trades'));
    expect(screen.getByTestId('trades')).toBeTruthy();
    expect(q.polls.trades).toBeGreaterThanOrEqual(5000); // well inside the per-operator Exchange budget
    fireEvent.click(screen.getByTestId('exchange-items'));
    expect(screen.queryByTestId('trades')).toBeNull();
  });
});

describe('TradesPanel: loading', () => {
  it('says "no trades" only once the list has loaded', () => {
    q.trades.data = undefined as unknown as unknown[];
    render(<TradesPanel client={client(1000)} />);
    expect(screen.queryByText('no trades')).toBeNull();
    cleanup();
    q.trades.data = [];
    render(<TradesPanel client={client(1000)} />);
    expect(screen.getByText('no trades')).toBeTruthy();
  });
});

describe('TradesPanel: opening', () => {
  it('opens by name once (in-flight guard), clears the field, and shows a refusal inline', async () => {
    const d = deferred<unknown>();
    q.open.mockReturnValue({ unwrap: () => d.promise });
    render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-open').disabled).toBe(true);
    expect(screen.queryByTestId('trade-open-why')).toBeNull(); // nothing typed: no nagging
    setInput('trade-with', ' Bob ');
    fireEvent.click(btn('trade-open'));
    fireEvent.click(btn('trade-open'));
    expect(q.open).toHaveBeenCalledTimes(1);
    expect(q.open).toHaveBeenCalledWith({ withName: 'Bob' });
    expect(btn('trade-open').disabled).toBe(true);
    await act(async () => d.reject({ status: 403, data: { error: 'forbidden', message: 'that operator is not accepting trades from you' } }));
    expect(screen.getByTestId('trade-open-error').textContent).toBe('that operator is not accepting trades from you');
    expect(appLog.get().map((e) => e.text)).toContain('trade: that operator is not accepting trades from you');
    expect(btn('trade-open').disabled).toBe(false);
    q.open.mockReturnValue(ok(trade()));
    fireEvent.click(btn('trade-open'));
    await act(async () => {});
    expect((screen.getByTestId('trade-with') as HTMLInputElement).value).toBe('');
  });

  it('is disabled with a reason at the open-trade cap and for an operator you already trade with', () => {
    q.trades.data = [trade({ id: 'A', them: side('o1', 'Bob') }), trade({ id: 'B', them: side('o2', 'Cy') })];
    render(<TradesPanel client={client(1000)} />);
    setInput('trade-with', 'bob');
    expect(btn('trade-open').disabled).toBe(true);
    expect(screen.getByTestId('trade-open-why').textContent).toContain('already have an open trade');
    setInput('trade-with', 'Dee');
    expect(btn('trade-open').disabled).toBe(false);
    cleanup();
    q.trades.data = Array.from({ length: MAX_OPEN_TRADES }, (_, i) => trade({ id: `T${i}`, them: side(`o${i}`, `Op${i}`) }));
    render(<TradesPanel client={client(1000)} />);
    setInput('trade-with', 'Dee');
    expect(btn('trade-open').disabled).toBe(true);
    expect(screen.getByTestId('trade-open-why').textContent).toContain(`at most ${MAX_OPEN_TRADES} open trades`);
  });
});

describe('TradesPanel: the table', () => {
  it('shows both offers as text only (names, items, daemons), what you receive after the fee, and closed trades', () => {
    q.trades.data = [
      trade({ them: side('o1', '<img src=x onerror=alert(1)>', { bits: 96, items: { 'frag:heap': 2 }, daemons: [listed('d9', { clean: true, signature: 2 })] }), me: side('me', 'Me', { bits: 32 }) }),
      trade({ id: 'T0', status: 'DONE', them: side('o3', 'Old'), updatedAt: '2026-10-01T00:00:00.000Z' }),
    ];
    render(<TradesPanel client={client(1000)} />);
    const card = screen.getByTestId('trade-<img src=x onerror=alert(1)>');
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('96 bits');
    expect(card.textContent).toContain('you receive 90 after the fee');
    expect(card.textContent).toContain('they receive 30 after the fee');
    expect(card.textContent).toContain('frag:heap ×2');
    expect(card.textContent).toContain('Pingling L8 · ivs 10 · clean · T2');
    expect(screen.getByTestId('trade-closed-Old').textContent).toContain('done');
    expect(document.body.innerHTML).not.toMatch(/github\.com/i);
  });

  it('closed trades say what each side gave (daemons as species and level only)', () => {
    q.trades.data = [
      trade({
        id: 'T0', status: 'DONE', updatedAt: '2026-10-01T00:00:00.000Z',
        me: side('me', 'Me', { bits: 32, daemons: [{ id: 'd1', species: 'pingling', level: 8 }] }),
        them: side('o3', 'Old', { items: { 'frag:heap': 2 } }),
      }),
      trade({ id: 'T9', status: 'CANCELLED', them: side('o4', 'Gone') }),
    ];
    render(<TradesPanel client={client(1000)} />);
    const row = screen.getByTestId('trade-closed-Old').textContent!;
    expect(row).toContain('you gave 32 bits, Pingling L8');
    expect(row).toContain('they gave frag:heap ×2');
    expect(screen.getByTestId('trade-closed-Gone').textContent).toContain('you gave nothing');
  });

  it('the confirm line states exactly what you give and what you receive, with the fee', () => {
    q.trades.data = [trade({ them: side('o1', 'Bob', { bits: 100, items: { 'frag:heap': 2 } }), me: side('me', 'Me', { bits: 32, daemons: [listed('d1')] }) })];
    render(<TradesPanel client={client(1000)} />);
    const s = screen.getByTestId('trade-summary').textContent!;
    expect(s).toContain('you give 32 bits, Pingling L8');
    expect(s).toContain('you receive 94 bits (100 less a fee of 6), frag:heap ×2');
  });

  it('sets the offer once (in-flight guard) with bits, items and daemon ids; it is disabled with a reason until something changes', async () => {
    q.disk.data = [{ id: 'd1', species: 'pingling', level: 8, lockedBy: null }, { id: 'd2', species: 'pingling', level: 9, lockedBy: 'trade:T1' }, { id: 'd3', species: 'pingling', level: 1, lockedBy: 'listing:L' }, { id: 'd4', species: 'pingling', level: 2, lockedBy: 'trade:T9' }] as unknown as DiskDaemon[];
    const d = deferred<Trade>();
    q.setOffer.mockReturnValue({ unwrap: () => d.promise });
    q.trades.data = [trade()];
    render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-offer').disabled).toBe(true);
    expect(btn('trade-offer').title).toBe('your offer is already set');
    // only unlocked daemons and the ones this trade holds can be offered
    expect(screen.getByTestId('trade-daemon-d1')).toBeTruthy();
    expect(screen.getByTestId('trade-daemon-d2')).toBeTruthy();
    expect(screen.queryByTestId('trade-daemon-d3')).toBeNull();
    expect(screen.queryByTestId('trade-daemon-d4')).toBeNull();
    setInput('trade-bits', '64');
    setInput('trade-item-frag:heap', '9'); // clamped to the vault
    fireEvent.click(screen.getByTestId('trade-daemon-d1'));
    expect(btn('trade-offer').disabled).toBe(false);
    fireEvent.click(btn('trade-offer'));
    fireEvent.click(btn('trade-offer'));
    expect(q.setOffer).toHaveBeenCalledTimes(1);
    expect(q.setOffer).toHaveBeenCalledWith({ id: 'T1', offer: { bits: 64, items: { 'frag:heap': 5 }, daemonIds: ['d1'] } });
    expect(btn('trade-offer').disabled).toBe(true);
    expect(btn('trade-cancel').disabled).toBe(true);
    await act(async () => d.resolve(trade({ version: 2 })));
    expect(btn('trade-cancel').disabled).toBe(false);
  });

  it('refuses offers you cannot make and says why (too many daemons or kinds); bits above the balance are only a hint', async () => {
    q.disk.data = Array.from({ length: MAX_TRADE_DAEMONS + 1 }, (_, i) => ({ id: `d${i}`, species: 'pingling', level: 8, lockedBy: null })) as unknown as DiskDaemon[];
    q.trades.data = [trade()];
    q.setOffer.mockReturnValue(ok(trade({ version: 2 })));
    render(<TradesPanel client={client(100)} />);
    setInput('trade-bits', '101');
    // the client's balance can lag the api's (a credit not yet pushed): the api's 402 decides
    expect(btn('trade-offer').disabled).toBe(false);
    expect(screen.getByTestId('trade-bits-hint').textContent).toContain('you have 100 bits');
    fireEvent.click(btn('trade-offer'));
    expect(q.setOffer).toHaveBeenCalledWith({ id: 'T1', offer: { bits: 101, items: {}, daemonIds: [] } });
    await act(async () => {});
    setInput('trade-bits', '100');
    expect(screen.queryByTestId('trade-bits-hint')).toBeNull();
    for (let i = 0; i <= MAX_TRADE_DAEMONS; i++) fireEvent.click(screen.getByTestId(`trade-daemon-d${i}`));
    expect(btn('trade-offer').disabled).toBe(true);
    expect(screen.getByTestId('trade-offer-why').textContent).toContain(`at most ${MAX_TRADE_DAEMONS} daemons`);
    expect(MAX_TRADE_ITEMS).toBe(16);
  });

  it('a failed offer shows inline (402 balance) and keeps the draft', async () => {
    q.trades.data = [trade()];
    q.setOffer.mockReturnValue({ unwrap: () => Promise.reject({ status: 402, data: { error: 'insufficient_bits', message: 'you do not have 64 bits' } }) });
    render(<TradesPanel client={client(1000)} />);
    setInput('trade-bits', '64');
    fireEvent.click(btn('trade-offer'));
    await act(async () => {});
    expect(screen.getByTestId('trade-error').textContent).toBe('not enough bits: you do not have 64 bits');
    expect((screen.getByTestId('trade-bits') as HTMLInputElement).value).toBe('64');
    expect(appLog.get().map((e) => e.text)).toContain('offer: not enough bits: you do not have 64 bits');
  });
});

describe('TradesPanel: confirming', () => {
  const live = (over: Partial<Trade> = {}) => trade({ version: 3, me: side('me', 'Me', { bits: 32 }), them: side('o1', 'Bob', { items: { 'frag:heap': 2 } }), ...over });

  it('confirms once (in-flight guard), quoting the version the player saw', async () => {
    const d = deferred<Trade>();
    q.confirm.mockReturnValue({ unwrap: () => d.promise });
    q.trades.data = [live()];
    render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-confirm').disabled).toBe(false);
    fireEvent.click(btn('trade-confirm'));
    fireEvent.click(btn('trade-confirm'));
    expect(q.confirm).toHaveBeenCalledTimes(1);
    expect(q.confirm).toHaveBeenCalledWith({ id: 'T1', version: 3 });
    expect(btn('trade-confirm').disabled).toBe(true);
    await act(async () => d.resolve(live({ me: side('me', 'Me', { bits: 32 }, true) })));
    expect(btn('trade-confirm').disabled).toBe(false); // the cached trade has not refetched yet in this fake; the real one disables on `me.confirmed`
  });

  it('is disabled once you confirmed (waiting for them) and with nothing on the table', () => {
    q.trades.data = [live({ me: side('me', 'Me', { bits: 32 }, true) })];
    render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-confirm').disabled).toBe(true);
    expect(btn('trade-confirm').title).toContain('waiting for them');
    expect(screen.getByTestId('trade-status').textContent).toContain('you confirmed');
    cleanup();
    q.trades.data = [trade()];
    render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-confirm').disabled).toBe(true);
    expect(screen.getByTestId('trade-confirm-why').textContent).toContain('nothing on the table');
  });

  it('is disabled with unsent changes to your offer', () => {
    q.trades.data = [live()];
    render(<TradesPanel client={client(1000)} />);
    setInput('trade-bits', '40');
    expect(btn('trade-confirm').disabled).toBe(true);
    expect(screen.getByTestId('trade-confirm-why').textContent).toContain('unsent changes');
    fireEvent.click(screen.getByTestId('trade-reset'));
    expect((screen.getByTestId('trade-bits') as HTMLInputElement).value).toBe('32');
    expect(btn('trade-confirm').disabled).toBe(false);
  });

  it('when the offers change under the player the new offer is shown and confirming needs a review first; it then quotes the new version', async () => {
    q.confirm.mockReturnValue(ok(live()));
    q.trades.data = [live()];
    const { rerender } = render(<TradesPanel client={client(1000)} />);
    expect(btn('trade-confirm').disabled).toBe(false);
    // they swap their offer (version 4): the card shows it, but a confirm is not possible until reviewed
    q.trades.data = [live({ version: 4, them: side('o1', 'Bob', { bits: 160 }) })];
    rerender(<TradesPanel client={client(1000)} />);
    expect(screen.getByTestId('trade-Bob').textContent).toContain('160 bits');
    expect(screen.getByTestId('trade-summary').textContent).toContain('you receive 150 bits');
    expect(screen.getByTestId('trade-changed')).toBeTruthy();
    expect(btn('trade-confirm').disabled).toBe(true);
    fireEvent.click(btn('trade-confirm'));
    expect(q.confirm).not.toHaveBeenCalled();
    fireEvent.click(btn('trade-review'));
    expect(screen.queryByTestId('trade-changed')).toBeNull();
    expect(btn('trade-confirm').disabled).toBe(false);
    fireEvent.click(btn('trade-confirm'));
    expect(q.confirm).toHaveBeenCalledWith({ id: 'T1', version: 4 });
    await act(async () => {});
    // a version bump between the review and the click disables it again (it can never quote a version the player did not see)
    q.trades.data = [live({ version: 5, them: side('o1', 'Bob', { bits: 16 }) })];
    rerender(<TradesPanel client={client(1000)} />);
    expect(btn('trade-confirm').disabled).toBe(true);
  });

  it('making your own offer counts as having looked at the table', async () => {
    q.trades.data = [live()];
    q.setOffer.mockReturnValue(ok(live({ version: 4 })));
    const { rerender } = render(<TradesPanel client={client(1000)} />);
    setInput('trade-bits', '48');
    fireEvent.click(btn('trade-offer'));
    await act(async () => {});
    q.trades.data = [live({ version: 4, me: side('me', 'Me', { bits: 48 }) })];
    rerender(<TradesPanel client={client(1000)} />);
    expect(screen.queryByTestId('trade-changed')).toBeNull();
    expect(btn('trade-confirm').disabled).toBe(false);
  });

  it('a counter-offer that lands while your own offer is in flight still needs a review', async () => {
    q.trades.data = [live()];
    const d = deferred<Trade>();
    q.setOffer.mockReturnValue({ unwrap: () => d.promise });
    const { rerender } = render(<TradesPanel client={client(1000)} />);
    setInput('trade-bits', '48');
    fireEvent.click(btn('trade-offer'));
    // they changed their side (version 4) before our offer committed (version 5): our response carries their new offer
    const answer = live({ version: 5, me: side('me', 'Me', { bits: 48 }), them: side('o1', 'Bob', { bits: 1 }) });
    await act(async () => d.resolve(answer));
    q.trades.data = [answer];
    rerender(<TradesPanel client={client(1000)} />);
    expect(screen.getByTestId('trade-changed')).toBeTruthy();
    expect(btn('trade-confirm').disabled).toBe(true);
    fireEvent.click(btn('trade-review'));
    expect(btn('trade-confirm').disabled).toBe(false);
  });

  it('your own offer is only taken as reviewed when the other side is unchanged and the version moved by exactly one', async () => {
    // same version step, but the other side differs from what was on screen (a refetch had not shown it yet)
    q.trades.data = [live()];
    q.setOffer.mockReturnValue(ok(live({ version: 4, me: side('me', 'Me', { bits: 48 }), them: side('o1', 'Bob', { items: { 'frag:heap': 1 } }) })));
    const { rerender } = render(<TradesPanel client={client(1000)} />);
    setInput('trade-bits', '48');
    fireEvent.click(btn('trade-offer'));
    await act(async () => {});
    q.trades.data = [live({ version: 4, me: side('me', 'Me', { bits: 48 }), them: side('o1', 'Bob', { items: { 'frag:heap': 1 } }) })];
    rerender(<TradesPanel client={client(1000)} />);
    expect(screen.getByTestId('trade-changed')).toBeTruthy();
    expect(btn('trade-confirm').disabled).toBe(true);
  });

  it('shows 409 (stale or lost slot) and 402 refusals inline, keeps the trade, and logs them', async () => {
    q.trades.data = [live()];
    render(<TradesPanel client={client(1000)} />);
    q.confirm.mockReturnValueOnce({ unwrap: () => Promise.reject({ status: 409, data: { error: 'stale_offer', message: 'the offers changed; look again before confirming' } }) });
    fireEvent.click(btn('trade-confirm'));
    await act(async () => {});
    expect(screen.getByTestId('trade-error').textContent).toContain('review the new offer');
    q.confirm.mockReturnValueOnce({ unwrap: () => Promise.reject({ status: 409, data: { error: 'conflict', message: 'a daemon just arrived in a Disk slot; try again' } }) });
    fireEvent.click(btn('trade-confirm'));
    await act(async () => {});
    expect(screen.getByTestId('trade-error').textContent).toBe('a daemon just arrived in a Disk slot; try again (nothing moved)');
    q.confirm.mockReturnValueOnce({ unwrap: () => Promise.reject({ status: 402, data: { error: 'insufficient_bits', message: 'Bob does not have 100 bits' } }) });
    fireEvent.click(btn('trade-confirm'));
    await act(async () => {});
    expect(screen.getByTestId('trade-error').textContent).toBe('not enough bits: Bob does not have 100 bits (the trade is still open, nothing moved)');
    expect(btn('trade-confirm').disabled).toBe(false);
    expect(appLog.get().map((e) => e.text)).toContain('confirm: not enough bits: Bob does not have 100 bits (the trade is still open, nothing moved)');
  });

  it('cancelling goes once; a failure shows inline', async () => {
    const d = deferred<Trade>();
    q.cancel.mockReturnValue({ unwrap: () => d.promise });
    q.trades.data = [live()];
    render(<TradesPanel client={client(1000)} />);
    fireEvent.click(btn('trade-cancel'));
    fireEvent.click(btn('trade-cancel'));
    expect(q.cancel).toHaveBeenCalledTimes(1);
    expect(q.cancel).toHaveBeenCalledWith('T1');
    await act(async () => d.reject({ status: 400, data: { error: 'validation_error', message: 'trade is done' } }));
    expect(screen.getByTestId('trade-error').textContent).toBe('trade is done');
  });

  it('offering more bits than the client thinks you have is a hint, never a block; it follows the balance', async () => {
    q.trades.data = [live()];
    q.confirm.mockReturnValue(ok(live()));
    const c = client(10);
    const { rerender } = render(<TradesPanel client={c} />);
    expect(btn('trade-confirm').disabled).toBe(false);
    expect(screen.getByTestId('trade-bits-hint').textContent).toContain('you offer 32 bits but have 10');
    fireEvent.click(btn('trade-confirm'));
    expect(q.confirm).toHaveBeenCalledWith({ id: 'T1', version: 3 });
    await act(async () => {});
    // a bits push lands: the hint goes on the next render
    (c.self as { bits: number }).bits = 500;
    rerender(<TradesPanel client={c} />);
    expect(screen.queryByTestId('trade-bits-hint')).toBeNull();
  });
});

describe('DiskPanel and trades', () => {
  const row = (id: string, lockedBy: string | null): DiskDaemon => ({
    id, species: 'pingling', level: 8, clean: false, signature: 0, slot: 1, hp: 10, moves: ['ping'], ivs: [1], heldItem: null, patched: false, moveTypeUses: [], crashes: 0, history: [], lockedBy,
    log: { originalOperatorId: 'x', capturedAt: '2026-10-01T00:00:00Z', subnet: 'lo', spawnIndex: null, tool: 'sniff' },
  });

  it('marks a daemon locked by a trade "in a trade" and disables load and list with the reason; other locks keep their wording', () => {
    q.disk.data = [row('t', 'trade:T1'), row('l', 'listing:L1'), row('f', null)];
    render(<DiskPanel client={client(1000)} />);
    expect(screen.getByTestId('lock-t').textContent).toBe('in a trade');
    expect(screen.getByTestId('lock-l').textContent).toBe('on the Exchange');
    expect(btn('list-t').disabled).toBe(true);
    expect(btn('list-t').title).toContain('in a trade');
    const loads = screen.getAllByRole('button', { name: 'load into RAM' }) as HTMLButtonElement[];
    expect(loads[0]!.disabled).toBe(true);
    expect(loads[0]!.title).toContain('in a trade');
    expect(btn('list-f').disabled).toBe(false);
  });
});
