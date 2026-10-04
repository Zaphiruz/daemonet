// @vitest-environment jsdom
import { BUY_MAX_QTY, CRAFT_MAX_QTY, DISK_MAX, getRecipe, getSubnet } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { craftCheck, formatBits, fragmentTypes } from '../src/game/economy.ts';
import { scanLevel } from '../src/panels/CodexPanel.tsx';

const ledger = vi.hoisted(() => ({ data: undefined as unknown, skip: [] as unknown[], refetch: vi.fn() }));
const tickets = vi.hoisted(() => ({ board: undefined as unknown, history: undefined as unknown, skip: [] as unknown[], refetch: vi.fn(() => Promise.resolve()) }));
const vault = vi.hoisted(() => ({ data: undefined as unknown, skip: [] as unknown[], refetch: vi.fn() }));
const diskRows = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useLedgerQuery: (_a: unknown, opts: { skip?: boolean }) => {
    ledger.skip.push(opts?.skip);
    return { data: opts?.skip ? undefined : ledger.data, refetch: ledger.refetch };
  },
  useBoardQuery: (_a: unknown, opts: { skip?: boolean }) => {
    tickets.skip.push(opts?.skip);
    return { data: opts?.skip ? undefined : tickets.board, refetch: tickets.refetch };
  },
  useTicketHistoryQuery: (_a: unknown, opts: { skip?: boolean }) => ({ data: opts?.skip ? undefined : tickets.history, refetch: vi.fn() }),
  useVaultQuery: (_a: unknown, opts: { skip?: boolean }) => {
    vault.skip.push(opts?.skip);
    return { data: opts?.skip ? undefined : vault.data, refetch: vault.refetch };
  },
  useDiskQuery: () => ({ data: diskRows.data, refetch: vi.fn() }),
  useMyListingsQuery: () => ({ data: [] }),
  useListDaemonMutation: () => [vi.fn()],
  useUnlistMutation: () => [vi.fn()],
}));
vi.mock('../src/render/draw.ts', () => ({ spriteCanvas: () => document.createElement('canvas') }));

import { api } from '../src/api.ts';
import { store } from '../src/store.ts';
import { DiskPanel } from '../src/panels/DiskPanel.tsx';
import { HostPanel } from '../src/panels/HostPanel.tsx';
import { RamPanel } from '../src/panels/RamPanel.tsx';

beforeEach(() => {
  ledger.data = undefined;
  ledger.skip = [];
  vault.data = undefined;
  vault.skip = [];
  diskRows.data = [];
  tickets.board = undefined;
  tickets.history = undefined;
  tickets.skip = [];
  tickets.refetch.mockClear();
  HTMLCanvasElement.prototype.getContext = (() => ({ imageSmoothingEnabled: false, clearRect() {}, drawImage() {} })) as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('craftCheck', () => {
  it('reports have / need per fragment and the bits cost', () => {
    const c = craftCheck(getRecipe('tap'), 2, { 'frag:packet': 8, 'frag:socket': 3 }, 200);
    expect(c.bits).toBe(128);
    expect(c.needs).toEqual([
      { item: 'frag:packet', have: 8, need: 8 },
      { item: 'frag:socket', have: 3, need: 8 },
    ]);
    expect(c.ok).toBe(false);
    expect(craftCheck(getRecipe('tap'), 1, { 'frag:packet': 4, 'frag:socket': 4 }, 64).ok).toBe(true);
    expect(craftCheck(getRecipe('tap'), 1, { 'frag:packet': 4, 'frag:socket': 4 }, 63).ok).toBe(false);
  });

  it('needs a type for "any" recipes and resolves it when given', () => {
    const none = craftCheck(getRecipe('restore'), 1, { 'frag:glitch': 2 }, 16);
    expect(none).toMatchObject({ ok: false, needsType: true, needs: [] });
    const chosen = craftCheck(getRecipe('restore'), 1, { 'frag:glitch': 2 }, 16, 'glitch');
    expect(chosen).toMatchObject({ ok: true, needsType: false, needs: [{ item: 'frag:glitch', have: 2, need: 2 }] });
  });
});

describe('inventory helpers', () => {
  it('lists held fragment types and formats bits in binary units', () => {
    expect(fragmentTypes({ 'frag:packet': 2, 'frag:null': 0, sniff: 3 })).toEqual(['packet']);
    expect(formatBits(5)).toBe('5 b');
    expect(formatBits(64)).toBe('8 B');
    expect(formatBits(100)).toBe('12.50 B');
    expect(formatBits(8192)).toBe('1.00 KiB');
    expect(formatBits(8192 * 1024)).toBe('1.00 MiB');
  });
});

const host = getSubnet('lo').host;
const daemon = (over: Record<string, unknown> = {}) => ({
  id: 'd1', species: 'echolet', level: 5, xp: 0, nature: 0, traitSlot: 0 as const, ivs: [1, 1, 1, 1, 1, 1, 1, 1], bonus: [], clean: false, signature: 0,
  hp: 10, maxHp: 10, energy: 10, moves: ['ping'], crashed: false, slot: 1, cooldowns: {}, heldItem: null, patched: false, moveTypeUses: [], crashes: 0, evolutions: [], ...over,
});

type Mock = ReturnType<typeof vi.fn>;
function fakeClient(self: Record<string, unknown> = {}, over: { role?: 'controller' | 'spectator'; x?: number; y?: number } = {}) {
  const buy: Mock = vi.fn(() => Promise.resolve({ ok: true }));
  const craft: Mock = vi.fn(() => Promise.resolve({ ok: true }));
  const decompile: Mock = vi.fn(() => Promise.resolve({ ok: true }));
  const deposit: Mock = vi.fn(() => Promise.resolve({ ok: true }));
  const withdraw: Mock = vi.fn(() => Promise.resolve({ ok: true }));
  const client = {
    subnet: 'lo',
    role: over.role ?? 'controller',
    self: { x: over.x ?? host.x, y: over.y ?? host.y, bits: 1000, diskCapacity: 256, tickets: [], ticketsToday: 0, research: {}, ram: [], running: [], capture: null, inventory: {}, ...self },
    operator: { buy, craft, decompile, deposit, withdraw, hold: vi.fn(), unhold: vi.fn(), evolve: vi.fn(), run: vi.fn(), recall: vi.fn(), store: vi.fn(), useRestore: vi.fn(), load: vi.fn(() => Promise.resolve({})) },
  };
  return { client: client as unknown as GameClient, buy, craft, decompile, deposit, withdraw };
}

/** The Host panel opens on tickets; the shop and craft tests start on their own view. */
function renderHost(client: GameClient, view: 'shop' | 'craft' | 'ledger' | 'vault' = 'shop') {
  const r = render(<HostPanel client={client} />);
  fireEvent.click(screen.getByTestId(`host-${view}`));
  return r;
}
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('HostPanel shop', () => {
  it('shows balance and capacity, buys with qty, and disables a buy it cannot afford', async () => {
    const { client, buy } = fakeClient({ bits: 150 });
    renderHost(client);
    expect(screen.getByTestId('host-status').textContent).toContain('at the host');
    expect(screen.getByTestId('host-status').textContent).toContain('150 bits');
    expect(screen.getByTestId('host-status').textContent).toContain('Disk 256');
    expect(btn('buy-sniff').disabled).toBe(false);
    expect(btn('buy-tap').disabled).toBe(false);
    expect(btn('buy-mirror').disabled).toBe(true);
    expect(btn('buy-diskExpansion').disabled).toBe(true);
    fireEvent.click(btn('buy-tap'));
    expect(buy).toHaveBeenCalledWith('tap', 1);
    await flush();
    fireEvent.change(screen.getByTestId('qty'), { target: { value: '3' } });
    expect(btn('buy-tap').disabled).toBe(true); // 3 x 128 > 150
    fireEvent.click(btn('buy-sniff'));
    expect(buy).toHaveBeenLastCalledWith('sniff', 3);
  });

  it('buys a disk expansion and shows maxed at the cap', () => {
    const { client, buy } = fakeClient({ bits: 100_000 });
    const { unmount } = renderHost(client);
    fireEvent.click(btn('buy-diskExpansion'));
    expect(buy).toHaveBeenCalledWith('diskExpansion', 1);
    unmount();
    const max = fakeClient({ bits: 100_000, diskCapacity: DISK_MAX });
    renderHost(max.client);
    expect(btn('buy-diskExpansion').disabled).toBe(true);
    expect(btn('buy-diskExpansion').textContent).toBe('maxed');
  });

  it('disables everything away from the host and for spectators', () => {
    const away = fakeClient({}, { x: host.x + 20, y: host.y });
    const { unmount } = renderHost(away.client);
    expect(screen.getByTestId('host-status').textContent).toContain('walk to the host');
    expect(btn('buy-sniff').disabled).toBe(true);
    unmount();
    renderHost(fakeClient({}, { role: 'spectator' }).client);
    expect(btn('buy-sniff').disabled).toBe(true);
  });

  it('disables a buy while its request is in flight, until it settles either way', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const { client, buy } = fakeClient();
      let settle!: () => void;
      buy.mockImplementation(() => new Promise((res, rej) => (settle = () => (outcome === 'resolve' ? res({ ok: true }) : rej(new Error('no'))))));
      const { unmount } = renderHost(client);
      fireEvent.click(btn('buy-sniff'));
      expect(btn('buy-sniff').disabled).toBe(true);
      expect(btn('buy-tap').disabled).toBe(true);
      fireEvent.click(btn('buy-sniff'));
      expect(buy).toHaveBeenCalledTimes(1);
      settle();
      await flush();
      expect(btn('buy-sniff').disabled).toBe(false);
      unmount();
    }
  });
});

describe('HostPanel craft', () => {
  it('shows have/need, enables craft when covered, and passes the chosen type for any-recipes', () => {
    const { client, craft } = fakeClient({ bits: 100, inventory: { 'frag:packet': 4, 'frag:socket': 3, 'frag:glitch': 2 } });
    renderHost(client);
    fireEvent.click(screen.getByTestId('host-craft'));
    expect(screen.getByTestId('recipe-tap').textContent).toContain('socket 3/4');
    expect(btn('craft-tap').disabled).toBe(true);
    expect(btn('craft-restore').disabled).toBe(true); // needs a type
    expect(screen.getByTestId('recipe-restore').textContent).toContain('pick a fragment type');
    fireEvent.change(screen.getByTestId('using'), { target: { value: 'glitch' } });
    expect(btn('craft-restore').disabled).toBe(false);
    fireEvent.click(btn('craft-restore'));
    expect(craft).toHaveBeenCalledWith('restore', 1, 'glitch');
  });

  it('crafts a covered recipe without a type, multiplied by qty, and blocks double submit', async () => {
    const { client, craft } = fakeClient({ bits: 500, inventory: { 'frag:packet': 8, 'frag:socket': 8 } });
    let settle!: () => void;
    craft.mockImplementation(() => new Promise((res) => (settle = () => res({ ok: true }))));
    renderHost(client);
    fireEvent.click(screen.getByTestId('host-craft'));
    fireEvent.change(screen.getByTestId('qty'), { target: { value: '2' } });
    expect(btn('craft-tap').textContent).toContain('128');
    fireEvent.click(btn('craft-tap'));
    expect(craft).toHaveBeenCalledWith('tap', 2, undefined);
    expect(btn('craft-tap').disabled).toBe(true);
    settle();
    await flush();
    expect(btn('craft-tap').disabled).toBe(false);
  });
});

describe('HostPanel limits and feedback', () => {
  it('clamps qty to the buy cap and disables crafts above the craft cap, with a reason', async () => {
    const { client, buy, craft } = fakeClient({ bits: 10_000_000, inventory: { 'frag:packet': 9999, 'frag:socket': 9999 } });
    renderHost(client);
    fireEvent.change(screen.getByTestId('qty'), { target: { value: '500' } });
    expect((screen.getByTestId('qty') as HTMLInputElement).value).toBe(String(BUY_MAX_QTY));
    fireEvent.click(btn('buy-sniff'));
    expect(buy).toHaveBeenCalledWith('sniff', BUY_MAX_QTY);
    await flush();
    fireEvent.click(screen.getByTestId('host-craft'));
    fireEvent.change(screen.getByTestId('qty'), { target: { value: String(CRAFT_MAX_QTY) } });
    expect(btn('craft-tap').disabled).toBe(false);
    fireEvent.change(screen.getByTestId('qty'), { target: { value: String(CRAFT_MAX_QTY + 1) } });
    expect(btn('craft-tap').disabled).toBe(true);
    expect(btn('craft-tap').title).toContain(String(CRAFT_MAX_QTY));
    fireEvent.click(btn('craft-tap'));
    expect(craft).not.toHaveBeenCalled();
  });

  it('shows the reason on a disabled button and the error of a rejected buy', async () => {
    const { client, buy } = fakeClient({ bits: 10 });
    buy.mockImplementation(() => Promise.reject(new Error('not enough bits')));
    const { unmount } = renderHost(client);
    expect(btn('buy-tap').title).toBe('not enough bits');
    unmount();
    const rich = fakeClient({ bits: 1000 });
    rich.buy.mockImplementation(() => Promise.reject(new Error('host is busy')));
    renderHost(rich.client);
    fireEvent.click(btn('buy-sniff'));
    await flush();
    expect(screen.getByTestId('host-error').textContent).toContain('host is busy');
    fireEvent.click(btn('buy-sniff'));
    expect(screen.queryByTestId('host-error')).toBeNull();
    const away = fakeClient({}, { x: host.x + 20 });
    cleanup();
    renderHost(away.client);
    expect(btn('buy-sniff').title).toContain('host');
  });

  it('forgets a chosen fragment type once it is no longer held', () => {
    const { client, craft } = fakeClient({ bits: 100, inventory: { 'frag:glitch': 2 } });
    const { rerender } = renderHost(client);
    fireEvent.click(screen.getByTestId('host-craft'));
    fireEvent.change(screen.getByTestId('using'), { target: { value: 'glitch' } });
    expect(btn('craft-restore').disabled).toBe(false);
    (client.self as { inventory: Record<string, number> }).inventory = {};
    rerender(<HostPanel client={client} />);
    expect((screen.getByTestId('using') as HTMLSelectElement).value).toBe('');
    expect(btn('craft-restore').disabled).toBe(true);
    expect(craft).not.toHaveBeenCalled();
  });
});

describe('HostPanel vault', () => {
  it('queries only on the vault view, lists tradable inventory and the vault, and deposits / withdraws qty', async () => {
    vault.data = { 'frag:signal': 3 };
    const { client, deposit, withdraw } = fakeClient({ inventory: { 'frag:signal': 2, sniff: 1, 'not-an-item': 5, 'frag:null': 0 } });
    render(<HostPanel client={client} />);
    expect(vault.skip.every((s) => s === true)).toBe(true);
    fireEvent.click(screen.getByTestId('host-vault'));
    expect(vault.skip.at(-1)).toBe(false);
    expect(screen.getByTestId('vault').textContent).toContain('1 at a time');
    expect(screen.queryByTestId('deposit-not-an-item')).toBeNull(); // not tradable
    expect(screen.queryByTestId('deposit-frag:null')).toBeNull(); // none held
    expect(screen.getByTestId('vault-frag:signal').textContent).toContain('×3');
    fireEvent.click(btn('deposit-frag:signal'));
    expect(deposit).toHaveBeenCalledWith('frag:signal', 1);
    await flush();
    fireEvent.click(btn('withdraw-frag:signal'));
    expect(withdraw).toHaveBeenCalledWith('frag:signal', 1);
    await flush();
  });

  it('invalidates the Vault tag after an ack, so the list refreshes', async () => {
    const dispatch = vi.spyOn(store, 'dispatch');
    const { client } = fakeClient({ inventory: { sniff: 2 } });
    renderHost(client, 'vault');
    fireEvent.click(btn('deposit-sniff'));
    await flush();
    expect(dispatch).toHaveBeenCalledWith(api.util.invalidateTags(['Vault']));
  });

  it('invalidates the Vault tag after a refused move too (it may have changed the vault)', async () => {
    const dispatch = vi.spyOn(store, 'dispatch');
    const { client, withdraw } = fakeClient({ inventory: {} });
    withdraw.mockImplementation(() => Promise.reject(new Error('not enough in the vault')));
    vault.data = { sniff: 1 };
    renderHost(client, 'vault');
    fireEvent.click(btn('withdraw-sniff'));
    await flush();
    expect(dispatch).toHaveBeenCalledWith(api.util.invalidateTags(['Vault']));
    expect(screen.getByText(/withdraw failed: not enough in the vault/)).toBeTruthy();
  });

  it('disables with a reason: short of qty, away from the host, spectators, in flight; shows empty and errors inline', async () => {
    vault.data = {};
    const { client, deposit } = fakeClient({ inventory: { sniff: 1 } });
    renderHost(client, 'vault');
    expect(screen.getByTestId('vault').textContent).toContain('empty');
    fireEvent.change(screen.getByTestId('qty'), { target: { value: '2' } });
    expect(btn('deposit-sniff').disabled).toBe(true);
    expect(btn('deposit-sniff').title).toContain('not enough');
    fireEvent.change(screen.getByTestId('qty'), { target: { value: '1' } });
    let settle!: (e?: Error) => void;
    deposit.mockImplementation(() => new Promise((res, rej) => (settle = (e) => (e ? rej(e) : res({ ok: true })))));
    fireEvent.click(btn('deposit-sniff'));
    expect(btn('deposit-sniff').disabled).toBe(true);
    expect(btn('deposit-sniff').title).toContain('previous');
    fireEvent.click(btn('deposit-sniff'));
    expect(deposit).toHaveBeenCalledTimes(1);
    settle(new Error('host is busy'));
    await flush();
    expect(screen.getByTestId('host-error').textContent).toContain('host is busy');
    cleanup();
    const away = fakeClient({ inventory: { sniff: 1 } }, { x: host.x + 20 });
    renderHost(away.client, 'vault');
    expect(btn('deposit-sniff').disabled).toBe(true);
    expect(btn('deposit-sniff').title).toContain('host');
    cleanup();
    vault.data = { sniff: 1 };
    renderHost(fakeClient({}, { role: 'spectator' }).client, 'vault');
    expect(btn('withdraw-sniff').disabled).toBe(true);
    expect(btn('withdraw-sniff').title).toContain('spectators');
  });
});

describe('craftCheck aggregation', () => {
  it('sums an any slot that resolves to an already-named type', () => {
    const r = { id: 'x', output: { item: 'tap' as const }, bits: 1, fragments: { packet: 2, any: 3 } } as unknown as Parameters<typeof craftCheck>[0];
    const c = craftCheck(r, 2, { 'frag:packet': 10 }, 5, 'packet');
    expect(c.needs).toEqual([{ item: 'frag:packet', have: 10, need: 10 }]);
    expect(c.ok).toBe(true);
    expect(craftCheck(r, 2, { 'frag:packet': 9 }, 5, 'packet').ok).toBe(false);
  });
});

describe('HostPanel ledger', () => {
  it('only queries on the ledger view and lists rows with signed deltas', () => {
    ledger.data = [
      { delta: -16, reason: 'craft', ref: 'restore', at: '2026-10-01T00:00:00Z' },
      { delta: 50, reason: 'admin', ref: null, at: '2026-10-01T00:00:00Z' },
    ];
    render(<HostPanel client={fakeClient().client} />);
    expect(ledger.skip.every((s) => s === true)).toBe(true);
    fireEvent.click(screen.getByTestId('host-ledger'));
    const l = screen.getByTestId('ledger').textContent!;
    expect(l).toContain('craft');
    expect(l).toContain('-16');
    expect(l).toContain('+50');
    ledger.data = [];
    fireEvent.click(screen.getByTestId('host-shop'));
    fireEvent.click(screen.getByTestId('host-ledger'));
    expect(screen.getByTestId('ledger').textContent).toContain('no bits have moved yet');
  });
});

describe('RamPanel decompile', () => {
  const ram = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) => fakeClient({ ram: [daemon(d)], ...extra });

  it('confirms before destroying a daemon, and only decompiles when confirmed', () => {
    const { client, decompile } = ram({});
    const confirm = vi.spyOn(window, 'confirm');
    render(<RamPanel client={client} />);
    confirm.mockReturnValueOnce(false);
    fireEvent.click(btn('decompile-1'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decompile).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(btn('decompile-1'));
    expect(decompile).toHaveBeenCalledWith('d1', false);
  });

  it('passes confirm=true for a clean or signature daemon, with the rare wording', () => {
    for (const rare of [{ clean: true }, { signature: 2 }]) {
      const { client, decompile } = ram(rare);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { unmount } = render(<RamPanel client={client} />);
      fireEvent.click(btn('decompile-1'));
      expect(String(confirm.mock.calls[0]![0])).toMatch(/clean image|signature T2/);
      expect(decompile).toHaveBeenCalledWith('d1', true);
      confirm.mockRestore();
      unmount();
    }
  });

  it('is disabled for running daemons, away from the host and for spectators', () => {
    const cases = [ram({}, { running: ['d1'] }).client, fakeClient({ ram: [daemon()] }, { x: host.x + 20 }).client, fakeClient({ ram: [daemon()] }, { role: 'spectator' }).client];
    for (const client of cases) {
      const { unmount } = render(<RamPanel client={client} />);
      expect(btn('decompile-1').disabled).toBe(true);
      unmount();
    }
  });

  it('disables decompile while one is in flight', async () => {
    const { client, decompile } = ram({});
    let settle!: () => void;
    decompile.mockImplementation(() => new Promise((res) => (settle = () => res({ ok: true }))));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RamPanel client={client} />);
    fireEvent.click(btn('decompile-1'));
    expect(btn('decompile-1').disabled).toBe(true);
    fireEvent.click(btn('decompile-1'));
    expect(decompile).toHaveBeenCalledTimes(1);
    settle();
    await flush();
    expect(btn('decompile-1').disabled).toBe(false);
  });
});

describe('DiskPanel capacity', () => {
  it('shows the operator disk capacity, not a constant', () => {
    render(<DiskPanel client={fakeClient({ diskCapacity: 288 }).client} />);
    expect(screen.getByText(/Disk 0\/288/)).toBeTruthy();
  });
});

describe('DiskPanel locks', () => {
  const row = (id: string, lockedBy: string | null) => ({
    id, species: 'echolet', level: 5, clean: false, signature: 0, slot: 1, hp: 10, moves: ['ping'], ivs: [1], heldItem: null, patched: false, moveTypeUses: [], crashes: 0, history: [], lockedBy,
    log: { originalOperatorId: 'x', capturedAt: '2026-10-01T00:00:00Z', subnet: 'lo', spawnIndex: null, tool: 'sniff' },
  });
  it('shows on the Exchange for a locked daemon and disables its load button with a reason', () => {
    diskRows.data = [row('a', 'order1'), row('b', null)];
    render(<DiskPanel client={fakeClient().client} />);
    expect(screen.getAllByText('on the Exchange')).toHaveLength(1);
    const loads = screen.getAllByRole('button', { name: 'load into RAM' }) as HTMLButtonElement[];
    expect(loads[0]!.disabled).toBe(true);
    expect(loads[0]!.title).toContain('Exchange');
    expect(loads[1]!.disabled).toBe(false);
  });

  it('a row without the lock field (an older api) is loadable', () => {
    const { lockedBy: _l, ...old } = row('c', null);
    diskRows.data = [old];
    render(<DiskPanel client={fakeClient().client} />);
    expect(screen.queryByText('on the Exchange')).toBeNull();
    expect((screen.getByRole('button', { name: 'load into RAM' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('scanLevel', () => {
  it('names what each research tier reveals', () => {
    expect(scanLevel(0)).toContain('none');
    expect(scanLevel(4)).toBe('nature');
    expect(scanLevel(16)).toBe('IV buckets');
    expect(scanLevel(64)).toBe('exact IVs');
    expect(scanLevel(256)).toContain('hints');
  });
});

describe('HostPanel tickets', () => {
  const def = (index: number, status: string | null = null) => ({ index, kind: 'clear', params: {}, target: 4, reward: 64, title: `Clear ${index}`, status });
  const open = (id: string) => ({ id, day: '2026-10-04', subnet: 'lo', index: 0, kind: 'clear', params: {}, target: 4, reward: 64, progress: 1, title: 'Clear packet' });

  it('opens on tickets, queries only there, and accepts a board ticket at the host', async () => {
    tickets.board = { day: '2026-10-04', subnet: 'lo', tickets: [def(0), def(1, 'DONE')], acceptedToday: 1 };
    const { client } = fakeClient({ ticketsToday: 1 });
    const accept: Mock = vi.fn(() => Promise.resolve({ ok: true }));
    (client.operator as unknown as { acceptTicket: Mock }).acceptTicket = accept;
    render(<HostPanel client={client} />);
    expect(screen.getByTestId('tickets').textContent).toContain('open (0/2) · accepted today 1/8');
    expect(btn('accept-0').disabled).toBe(false);
    expect(btn('accept-1').disabled).toBe(true);
    expect(screen.getByTestId('board-1').textContent).toContain('done');
    fireEvent.click(btn('accept-0'));
    expect(accept).toHaveBeenCalledWith(0, 'lo', '2026-10-04');
    await flush();
    expect(tickets.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('host-shop'));
    expect(tickets.skip.at(-1)).toBe(true);
  });

  it('shows open tickets with progress, abandons one, and disables accepts at the open cap or away from the host', async () => {
    tickets.board = { day: '2026-10-04', subnet: 'lo', tickets: [def(0)], acceptedToday: 2 };
    const { client } = fakeClient({ tickets: [open('a'), open('b')], ticketsToday: 2 });
    const abandon: Mock = vi.fn(() => Promise.resolve({ ok: true }));
    (client.operator as unknown as { abandonTicket: Mock }).abandonTicket = abandon;
    render(<HostPanel client={client} />);
    expect(screen.getByTestId('ticket-a').textContent).toContain('1/4 · 64 bits');
    expect(btn('accept-0').disabled).toBe(true);
    expect(btn('accept-0').title).toContain('open tickets');
    fireEvent.click(screen.getAllByRole('button', { name: 'abandon' })[0]!);
    expect(abandon).toHaveBeenCalledWith('a');
    await flush();
    cleanup();
    tickets.board = { day: '2026-10-04', subnet: 'lo', tickets: [def(0)], acceptedToday: 0 };
    render(<HostPanel client={fakeClient({}, { x: host.x + 20 }).client} />);
    expect(btn('accept-0').disabled).toBe(true);
    expect(btn('accept-0').title).toContain('host');
  });

  it('lists the history', () => {
    tickets.history = [{ id: 'h1', day: '2026-10-03', subnet: 'lo', index: 2, kind: 'capture', target: 1, reward: 128, progress: 1, status: 'DONE', acceptedAt: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T01:00:00Z' }];
    render(<HostPanel client={fakeClient().client} />);
    expect(screen.getByText('history (1)')).toBeTruthy();
    expect(screen.getByText(/lo #2 capture/)).toBeTruthy();
  });
});
