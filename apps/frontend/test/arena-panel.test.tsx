// @vitest-environment jsdom
import { getSubnet } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({
  me: undefined as unknown,
  ladder: undefined as unknown,
  matches: undefined as unknown,
  refetchMatches: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useArenaMeQuery: () => ({ data: q.me, refetch: vi.fn() }),
  useLadderQuery: () => ({ data: q.ladder, refetch: vi.fn() }),
  useArenaMatchesQuery: () => ({ data: q.matches, refetch: q.refetchMatches }),
  useDiskQuery: () => ({ data: [], refetch: vi.fn() }),
}));
vi.mock('../src/render/draw.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/render/draw.ts')>()), spriteCanvas: () => document.createElement('canvas') }));

import { arenaStore, type ArenaResultInfo } from '../src/game/arena.ts';
import { log } from '../src/game/log.ts';
import { ArenaPanel, PENDING_POLL_DELAYS_MS } from '../src/panels/ArenaPanel.tsx';
import { RamPanel } from '../src/panels/RamPanel.tsx';
import { drawWorld } from '../src/render/draw.ts';

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({ imageSmoothingEnabled: false, clearRect() {}, drawImage() {} })) as never;
  q.me = undefined;
  q.ladder = undefined;
  q.matches = undefined;
});
afterEach(() => {
  cleanup();
  arenaStore.clear();
  vi.useRealTimers();
});

const dm = (id: string, over: Record<string, unknown> = {}) => ({ id, slot: 0, species: 'pingling', level: 64, hp: 100, maxHp: 100, energy: 10, xp: 0, crashed: false, clean: false, signature: 0, patched: false, traitSlot: 0, crashes: 0, moves: [], ivs: [1, 1, 1, 1, 1, 1], evolutions: [], heldItem: null, ...over });

interface Over {
  ram?: unknown[];
  running?: string[];
  capture?: unknown;
  arena?: unknown;
  role?: 'controller' | 'spectator';
  others?: Array<{ id: string; name: string | null }>;
  starter?: boolean;
}

function fakeClient(over: Over = {}) {
  const settle: Array<(ok: boolean) => void> = [];
  const mk = () => vi.fn(() => new Promise((res, rej) => settle.push((ok) => (ok ? res({ ok: true }) : rej(new Error('no'))))));
  const arena = { queue: mk(), leave: mk(), challenge: mk(), accept: mk(), forfeit: mk() };
  const h = getSubnet('lo').host;
  const client = {
    subnet: 'lo',
    role: over.role ?? 'controller',
    tick: 1,
    operatorId: 'me',
    self: { id: 'me', x: h.x, y: h.y, starterClaimed: over.starter ?? true, ram: over.ram ?? [dm('a', { slot: 0 }), dm('b', { slot: 1 })], running: over.running ?? [], capture: over.capture ?? null, arena: over.arena ?? null, inventory: {}, bits: 0 },
    world: { operators: { all: () => [{ id: 'me', name: 'me' }, ...(over.others ?? [])] } },
    arena,
    operator: { store: vi.fn(), decompile: vi.fn(), evolve: vi.fn(), hold: vi.fn(), unhold: vi.fn(), run: vi.fn(), recall: vi.fn(), useRestore: vi.fn() },
  };
  return { client: client as unknown as GameClient, arena, settle };
}
const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const rendered = (c: GameClient) => render(<ArenaPanel client={c} />);

describe('ArenaPanel queue', () => {
  it('queues ranked or unranked, and waits for the server before another command', async () => {
    const { client, arena, settle } = fakeClient();
    rendered(client);
    expect(btn('arena-queue-ranked').disabled).toBe(false);
    fireEvent.click(btn('arena-queue-ranked'));
    expect(arena.queue).toHaveBeenCalledWith('ranked');
    expect(btn('arena-queue-ranked').disabled).toBe(true);
    expect(btn('arena-queue-unranked').disabled).toBe(true);
    fireEvent.click(btn('arena-queue-unranked'));
    expect(arena.queue).toHaveBeenCalledTimes(1);
    await act(async () => settle[0]!(true));
    expect(btn('arena-queue-unranked').disabled).toBe(false);
    fireEvent.click(btn('arena-queue-unranked'));
    expect(arena.queue).toHaveBeenLastCalledWith('unranked');
    await act(async () => settle[1]!(false)); // refused: re-enabled, the refusal is logged
    expect(btn('arena-queue-unranked').disabled).toBe(false);
    expect(log.get().some((e) => e.kind === 'reject' && e.text.startsWith('arena queue: no'))).toBe(true);
  });

  it('disables with the reason of the server check that would refuse', () => {
    const reasons: Array<[Over, RegExp]> = [
      [{ arena: { id: 'm', phase: 'live' } }, /in a match/],
      [{ starter: false }, /starter/],
      [{ ram: [dm('a')] }, /2 daemons in RAM/],
      [{ ram: [dm('a'), dm('b', { crashed: true, slot: 1 })] }, /2 daemons in RAM/],
      [{ running: ['a'] }, /recall/],
      [{ capture: { captureId: 'c' } }, /capture/],
      [{ role: 'spectator' }, /spectator/],
    ];
    for (const [over, re] of reasons) {
      const { client } = fakeClient(over);
      const { unmount } = rendered(client);
      expect(btn('arena-queue-ranked').disabled).toBe(true);
      expect(btn('arena-queue-unranked').disabled).toBe(true);
      expect(screen.getByTestId('arena').textContent).toMatch(re);
      unmount();
    }
  });

  it('shows the waiting state with the leave button, and why the server dropped the queue', async () => {
    vi.useFakeTimers();
    const { client, arena, settle } = fakeClient();
    rendered(client);
    act(() => arenaStore.onQueued('ranked', undefined, Date.now()));
    act(() => void vi.advanceTimersByTime(65_000));
    expect(screen.getByTestId('arena-waiting').textContent).toContain('1:05');
    fireEvent.click(btn('arena-leave'));
    expect(arena.leave).toHaveBeenCalledOnce();
    expect(btn('arena-leave').disabled).toBe(true);
    await act(async () => settle[0]!(true));
    act(() => arenaStore.onQueued(null, 'recall running daemons first', Date.now()));
    expect(screen.queryByTestId('arena-waiting')).toBeNull();
    expect(screen.getByTestId('arena').textContent).toContain('recall running daemons first');
  });
});

describe('ArenaPanel challenges', () => {
  const challenge = { challengeId: 'c1', from: 'bob', name: '<b>bob</b>', mode: 'ranked' as const, expiresAt: new Date(Date.now() + 60_000).toISOString() };

  it('accepts an incoming challenge once, dismissing it when it succeeds, and keeps it when refused', async () => {
    const { client, arena, settle } = fakeClient();
    rendered(client);
    act(() => arenaStore.onChallenge(challenge));
    const card = screen.getByTestId('arena-challenge');
    expect(card.textContent).toContain('<b>bob</b> challenges you (ranked)'); // text only
    expect(card.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByText('accept'));
    fireEvent.click(screen.getByText('accept'));
    expect(arena.accept).toHaveBeenCalledTimes(1);
    expect(arena.accept).toHaveBeenCalledWith('c1');
    await act(async () => settle[0]!(false));
    expect(screen.queryByTestId('arena-challenge')).not.toBeNull();
    fireEvent.click(screen.getByText('accept'));
    await act(async () => settle[1]!(true));
    expect(screen.queryByTestId('arena-challenge')).toBeNull();
  });

  it('does not render a challenge past its 60 seconds, even before the next prune', () => {
    rendered(fakeClient().client);
    act(() => arenaStore.onChallenge({ ...challenge, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(screen.queryByTestId('arena-challenge')).toBeNull();
  });

  it('does not accept while blocked, and ignore dismisses', () => {
    const { client } = fakeClient({ running: ['a'] });
    rendered(client);
    act(() => arenaStore.onChallenge(challenge));
    expect((screen.getByText('accept') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('arena-ignore-c1'));
    expect(screen.queryByTestId('arena-challenge')).toBeNull();
  });

  it('challenges someone nearby in either mode, one command at a time', () => {
    const { client, arena } = fakeClient({ others: [{ id: 'bob', name: 'bob' }] });
    rendered(client);
    fireEvent.click(screen.getByTestId('arena-challenge-bob-ranked'));
    expect(arena.challenge).toHaveBeenCalledWith('bob', 'ranked');
    expect(btn('arena-challenge-bob-unranked').disabled).toBe(true);
  });
});

describe('ArenaPanel standing, ladder, history', () => {
  it('renders the three views as text', () => {
    q.me = { season: '2026-10', seasonEndsAt: '2026-11-01T00:00:00.000Z', rating: 1612.4, rd: 80.2, wins: 5, losses: 2, draws: 1, band: { min: 1600, payout: 256 }, payoutEligible: false, matchesForPayout: 8, rewardedWinsToday: 2, dailyWins: 8, winBits: 16 };
    q.ladder = { season: '2026-10', next: null, rows: [{ rank: 1, operatorId: 'bob', name: '<i>bob</i>', tag: 'ROOT', rating: 1700.2, rd: 50, wins: 9, losses: 1, draws: 0 }] };
    q.matches = [{ id: 'm1', season: '2026-10', mode: 'ranked', reason: 'wipeout', counted: true, durationMs: 1, endedAt: '2026-10-02T00:00:00Z', winnerId: 'me', a: { id: 'me', name: 'me', before: 1500, after: 1532, reward: 16 }, b: { id: 'bob', name: 'bob', before: 1600, after: 1580, reward: 0 } }];
    rendered(fakeClient().client);
    expect(screen.getByTestId('arena-me').textContent).toContain('rating 1612');
    expect(screen.getByTestId('arena-me').textContent).toContain('wins paid today 2/8');
    expect(screen.getByTestId('arena-ladder').textContent).toContain('1. [ROOT] <i>bob</i>');
    expect(screen.getByTestId('arena-ladder').querySelector('i')).toBeNull();
    expect(screen.getByTestId('arena-history').textContent).toContain('1500 → 1532');
    expect(screen.getByTestId('arena-history').textContent).toContain('win');
  });
});

describe('ArenaPanel last result, reconciled with the match list', () => {
  const last: ArenaResultInfo = { id: 'm1', mode: 'ranked', outcome: 'win', reason: 'wipeout', ratingBefore: 1500, ratingAfter: 1500, reward: 0, counted: false };
  const row = (counted: boolean) => ({ id: 'm1', season: '2026-10', mode: 'ranked', reason: 'wipeout', counted, durationMs: 1, endedAt: '2026-10-02T00:00:00Z', winnerId: 'me', a: { id: 'me', name: 'me', before: 1500, after: counted ? 1532 : 1500, reward: 0 }, b: { id: 'bob', name: 'bob', before: 1, after: 1, reward: 0 } });

  it('says the result is pending until the match shows up', () => {
    q.matches = [];
    rendered(fakeClient().client);
    act(() => arenaStore.onResult(last));
    expect(screen.getByTestId('arena-last').textContent).toContain('result pending');
    expect(screen.getByTestId('arena-last').textContent).not.toContain('not counted');
  });

  it('a row that counted settles at the row ratings; a row that did not count is not counted', () => {
    q.matches = [row(true)];
    const a = rendered(fakeClient().client);
    act(() => arenaStore.onResult({ ...last, ratingAfter: 1532, counted: true, reward: 16 }));
    expect(screen.getByTestId('arena-last').textContent).toContain('1500 → 1532');
    expect(screen.getByTestId('arena-last').textContent).not.toContain('pending');
    a.unmount();
    arenaStore.clear();
    q.matches = [row(false)];
    rendered(fakeClient().client);
    act(() => arenaStore.onResult(last));
    expect(screen.getByTestId('arena-last').textContent).toContain('not counted · rating unchanged');
    expect(screen.getByTestId('arena-last').textContent).not.toContain('pending');
  });

  it('a counted event with no row yet is already settled; an unranked one is never pending', () => {
    q.matches = [];
    rendered(fakeClient().client);
    act(() => arenaStore.onResult({ ...last, ratingAfter: 1532, counted: true }));
    expect(screen.getByTestId('arena-last').textContent).toContain('1500 → 1532');
    act(() => arenaStore.onMatch());
    act(() => arenaStore.onResult({ ...last, id: 'm2', mode: 'unranked' }));
    expect(screen.getByTestId('arena-last').textContent).not.toContain('pending');
  });

  it('polls the match list while a ranked result is pending', () => {
    vi.useFakeTimers();
    q.matches = [];
    q.refetchMatches.mockClear();
    rendered(fakeClient().client);
    act(() => arenaStore.onResult(last));
    act(() => void vi.advanceTimersByTime(31_000));
    expect(q.refetchMatches).toHaveBeenCalled();
  });

  it('stops polling once the row appears', async () => {
    vi.useFakeTimers();
    q.matches = [];
    q.refetchMatches.mockClear();
    const view = rendered(fakeClient().client);
    act(() => arenaStore.onResult(last));
    await act(async () => void (await vi.advanceTimersByTimeAsync(11_000)));
    expect(q.refetchMatches).toHaveBeenCalledTimes(1);
    q.matches = [row(true)];
    view.rerender(<ArenaPanel client={fakeClient().client} />);
    expect(screen.getByTestId('arena-last').textContent).not.toContain('pending');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300_000)));
    expect(q.refetchMatches).toHaveBeenCalledTimes(1);
  });

  it('gives up at the cap: not counted, rating unchanged (could not be recorded)', async () => {
    vi.useFakeTimers();
    q.matches = [];
    q.refetchMatches.mockClear();
    rendered(fakeClient().client);
    act(() => arenaStore.onResult(last));
    await act(async () => void (await vi.advanceTimersByTimeAsync(PENDING_POLL_DELAYS_MS.reduce((a, b) => a + b, 0) + 1000)));
    expect(q.refetchMatches).toHaveBeenCalledTimes(PENDING_POLL_DELAYS_MS.length);
    expect(screen.getByTestId('arena-last').textContent).toContain('not counted · rating unchanged (could not be recorded)');
    expect(screen.getByTestId('arena-last').textContent).not.toContain('pending');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300_000)));
    expect(q.refetchMatches).toHaveBeenCalledTimes(PENDING_POLL_DELAYS_MS.length);
  });
});

describe('RamPanel in a match', () => {
  it('gives a reason and disables store, decompile, evolve and held items; run stays', () => {
    const { client } = fakeClient({ arena: { id: 'm', phase: 'live' }, ram: [dm('a', { slot: 0 })] });
    render(<RamPanel client={client} />);
    expect(screen.getByText(/in an arena match/)).toBeTruthy();
    expect((screen.getByText('store') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('decompile-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('run-0') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the sandbox map', () => {
  it('draws no host marker in the arena sandbox, and still draws the host elsewhere', () => {
    const texts: string[] = [];
    const ctx = new Proxy({}, { get: (t: Record<string, unknown>, p: string) => (p === 'fillText' ? (s: string) => texts.push(s) : p in t ? t[p] : () => {}), set: (t: Record<string, unknown>, p: string, v: unknown) => ((t[p] = v), true) }) as unknown as CanvasRenderingContext2D;
    const controls = { zoom: 1 as const, actor: 'self', targetId: null, tool: 'sniff' as const };
    for (const [subnet, host] of [['sandbox', false], ['lo', true]] as const) {
      texts.length = 0;
      const def = getSubnet(subnet);
      const c = { subnet, role: 'controller', tick: 1, self: { x: def.host.x, y: def.host.y, running: [], capture: null, ram: [], inventory: {}, bits: 0 }, world: { gateways: def.gateways }, entities: new Map() } as unknown as GameClient;
      drawWorld({ ctx, cam: { cx: def.host.x, cy: def.host.y, zoom: 1, width: 400, height: 300 }, client: c, controls: controls as never, hover: null });
      expect(texts.includes('host')).toBe(host);
    }
  });
});
