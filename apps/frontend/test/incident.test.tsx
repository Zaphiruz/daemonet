// @vitest-environment jsdom
import { getSubnet } from '@daemonet/rules';
import type { ConnectOptions, GameClient } from '@daemonet/sdk';
import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentList } from '../src/api.ts';
import { createCaptureStore } from '../src/game/capture.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createIncidentStore, incidentStore, type IncidentEvent } from '../src/game/incident.ts';
import { createLog } from '../src/game/log.ts';
import { scale } from '../src/render/camera.ts';

const mocks = vi.hoisted(() => ({
  list: { data: undefined as unknown, error: undefined as unknown, isLoading: false, fulfilledTimeStamp: 1, refetch: vi.fn() },
  start: vi.fn(),
  startState: { isLoading: false },
}));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useIncidentsQuery: () => mocks.list,
  useStartIncidentMutation: () => [mocks.start, mocks.startState],
  useLogoutMutation: () => [vi.fn()],
  useAdminReportsQuery: () => ({ data: [], error: undefined }),
  useResolveReportMutation: () => [vi.fn()],
}));

const { api, describeApiError } = await import('../src/api.ts');
const { TopBar } = await import('../src/components/TopBar.tsx');
const { AdminPanel } = await import('../src/panels/AdminPanel.tsx');
const { IncidentsPanel } = await import('../src/panels/IncidentsPanel.tsx');
const { GatewaySection } = await import('../src/panels/PlayPanel.tsx');
const { drawWorld } = await import('../src/render/draw.ts');

const ends = (ms: number) => new Date(Date.now() + ms).toISOString();
const ev = (phase: IncidentEvent['phase'], over: Partial<IncidentEvent> = {}): IncidentEvent => ({ phase, id: 'i1', species: 'pidzero', endsAt: ends(600_000), bossId: null, ...over });

beforeEach(() => {
  incidentStore.reset();
  mocks.list.data = undefined;
  mocks.list.error = undefined;
  mocks.list.fulfilledTimeStamp = 1;
  mocks.list.refetch.mockReset();
  mocks.start.mockReset();
  mocks.startState.isLoading = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('incident store', () => {
  it('follows the phases, drops the Incident and its blasts when it ends, and prunes landed blasts', () => {
    const s = createIncidentStore();
    s.onEvent(ev('open'));
    expect(s.get().current).toMatchObject({ id: 'i1', phase: 'open', species: 'pidzero' });
    s.onEvent(ev('shield', { bossId: 'b1' }));
    expect(s.get().current).toMatchObject({ phase: 'shield', bossId: 'b1' });
    s.onTelegraph({ x: 1, y: 2, radius: 6, atTick: 10 });
    s.onTelegraph({ x: 3, y: 4, radius: 6, atTick: 20 });
    s.prune(10); // a blast lands on its own tick: still drawn
    expect(s.get().telegraphs).toHaveLength(2);
    s.prune(11);
    expect(s.get().telegraphs.map((t) => t.atTick)).toEqual([20]);
    s.onEvent(ev('cleared'));
    expect(s.get()).toEqual({ current: null, telegraphs: [] });
  });

  it('seeds from the API only when nothing newer is known, never revives an ended or past Incident, and notifies', () => {
    const s = createIncidentStore();
    const seen = vi.fn();
    s.subscribe(seen);
    s.seed({ id: 'old', species: 'pidzero', endsAt: new Date(Date.now() - 1000).toISOString() });
    expect(s.get().current).toBeNull();
    s.seed({ id: 'i1', species: 'pidzero', endsAt: ends(60_000) });
    expect(s.get().current).toMatchObject({ id: 'i1', phase: 'open' });
    s.onEvent(ev('fighting'));
    s.seed({ id: 'i1', species: 'pidzero', endsAt: ends(60_000) }); // a stale cached answer never rewinds the phase
    expect(s.get().current!.phase).toBe('fighting');
    s.onEvent(ev('expired'));
    s.seed({ id: 'i1', species: 'pidzero', endsAt: ends(60_000) }); // a cached answer from before it ended
    expect(s.get().current).toBeNull();
    s.seed(null);
    expect(seen).toHaveBeenCalled();
  });

  it('keeps one snapshot between changes (useSyncExternalStore) and resets completely', () => {
    const s = createIncidentStore();
    const a = s.get();
    expect(s.get()).toBe(a);
    s.onEvent(ev('open'));
    s.onEvent(ev('expired'));
    s.reset();
    s.seed({ id: 'i1', species: 'pidzero', endsAt: ends(60_000) });
    expect(s.get().current).not.toBeNull();
  });
});

type Handler = (v: unknown) => void;
class FakeClient {
  readonly handlers = new Map<string, Set<Handler>>();
  subnet = 'lo';
  operatorId = 'me';
  self = { ram: [] };
  constructor(readonly opts: ConnectOptions) {}
  on(name: string, h: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }
  emit(name: string, value?: unknown): void {
    for (const h of this.handlers.get(name) ?? []) h(value);
  }
  async start(): Promise<void> {
    await this.opts.auth.getToken();
  }
  close(): void {}
}

function setup() {
  const clients: FakeClient[] = [];
  const incident = createIncidentStore();
  const log = createLog(100);
  const invalidateIncidents = vi.fn();
  const deps: ConnectionDeps = {
    fetchTicket: async () => 'ticket:t',
    createClient: (opts) => {
      const c = new FakeClient(opts);
      clients.push(c);
      return c as unknown as GameClient;
    },
    url: () => 'ws://test/ws',
    log,
    capture: createCaptureStore(),
    stopSandbox: vi.fn(),
    invalidateCodex: vi.fn(),
    incident,
    invalidateIncidents,
  };
  return { conn: createConnection(deps), clients, incident, log, invalidateIncidents };
}

describe('Incident events in the connection (captured before any panel mounts)', () => {
  it('stores incident phases and telegraphs, prunes on ticks, and logs each phase and the reward in plain words', async () => {
    const { conn, clients, incident, log } = setup();
    await conn.open('controller');
    const c = clients[0]!;
    c.emit('incident', { e: 'incident', ...ev('open', { n: 4 }) });
    expect(incident.get().current).toMatchObject({ id: 'i1', phase: 'open' });
    c.emit('incident', { e: 'incident', ...ev('shield', { n: 4, bossId: 'b' }) });
    c.emit('telegraph', { e: 'telegraph', x: 5, y: 6, radius: 6, atTick: 30 });
    expect(incident.get().telegraphs).toEqual([{ x: 5, y: 6, radius: 6, atTick: 30 }]);
    c.emit('tick', 31);
    expect(incident.get().telegraphs).toEqual([]);
    c.emit('incidentReward', { e: 'incidentReward', incidentId: 'i1', reward: 512, share: 0.254 });
    c.emit('incident', { e: 'incident', ...ev('cleared', { n: 4 }), participants: [{ operatorId: 'a', name: 'ann', damage: 10, share: 0.75, reward: 6144 }, { operatorId: 'b', name: null, damage: 3, share: 0.25, reward: 2048 }] });
    expect(incident.get().current).toBeNull();
    const text = log.get().map((e) => e.text);
    expect(text.some((t) => t.includes('INCIDENT') && t.includes('pidzero'))).toBe(true);
    expect(text.some((t) => t.includes('raised its shield'))).toBe(true);
    expect(text).toContain('Incident reward: 512 bits for 25% of the damage');
    expect(text.some((t) => t.includes('ann 75% → 6144 bits') && t.includes('? 25% → 2048 bits'))).toBe(true);
    c.emit('incident', { e: 'incident', ...ev('expired') });
    expect(log.get().at(-1)!.text).toContain('got away');
  });

  it('ignores a replaced client, forgets everything on close and kick, and resyncs from the API after a reconnect', async () => {
    const { conn, clients, incident, invalidateIncidents } = setup();
    await conn.open('controller');
    const old = clients[0]!;
    await conn.open('spectator');
    old.emit('incident', { e: 'incident', ...ev('open') });
    old.emit('telegraph', { e: 'telegraph', x: 1, y: 1, radius: 6, atTick: 5 });
    expect(incident.get()).toEqual({ current: null, telegraphs: [] });
    const c = clients[1]!;
    expect(invalidateIncidents).toHaveBeenCalled(); // online: ask the API what is running now
    invalidateIncidents.mockClear();
    c.emit('incident', { e: 'incident', ...ev('open') });
    c.emit('disconnect');
    c.emit('reconnect');
    expect(incident.get().current).toBeNull(); // the end may have been missed while away
    expect(invalidateIncidents).toHaveBeenCalledTimes(1);
    c.emit('incident', { e: 'incident', ...ev('open', { id: 'i2' }) });
    c.emit('telegraph', { e: 'telegraph', x: 1, y: 1, radius: 6, atTick: 5 });
    c.emit('kick', 'banned');
    expect(incident.get()).toEqual({ current: null, telegraphs: [] });
    await conn.open('controller');
    clients[2]!.emit('incident', { e: 'incident', ...ev('open', { id: 'i3' }) });
    conn.close();
    expect(incident.get().current).toBeNull();
  });

  it('drops the old subnet blasts when a snapshot swaps the world', async () => {
    const { conn, clients, incident } = setup();
    await conn.open('controller');
    const c = clients[0]!;
    c.emit('telegraph', { e: 'telegraph', x: 1, y: 1, radius: 6, atTick: 500 });
    c.subnet = 'kernelspace';
    c.emit('ready');
    expect(incident.get().telegraphs).toEqual([]);
  });
});

describe('RTK reset on logout also drops the Incident', () => {
  it('clears the store when logout succeeds and keeps it when it fails', async () => {
    let ok = true;
    const NodeRequest = Request;
    vi.stubGlobal('Request', class extends NodeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      const logout = url.includes('/auth/logout');
      const body = logout ? { ok: true, endSessionUrl: null } : { next: { at: '2026-10-04T08:00:00.000Z', species: 'pidzero', periodMs: 1, windowMs: 1 }, current: null, recent: [] };
      return new Response(JSON.stringify(body), { status: logout && !ok ? 500 : 200, headers: { 'content-type': 'application/json' } });
    }));
    const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (d) => d().concat(api.middleware) });
    await store.dispatch(api.endpoints.incidents.initiate());
    expect(api.endpoints.incidents.select()(store.getState()).data).toBeDefined();
    incidentStore.onEvent(ev('open'));
    ok = false;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(incidentStore.get().current).not.toBeNull();
    ok = true;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(incidentStore.get().current).toBeNull();
    expect(api.endpoints.incidents.select()(store.getState()).data).toBeUndefined();
  });

  it('describes a conflict (an Incident is already running) in plain words', () => {
    expect(describeApiError({ status: 409, data: { error: 'conflict', message: 'an Incident is already running' } })).toBe('an Incident is already running');
  });
});

const me = { operatorId: 'me', name: 'alice', starterClaimed: true, bits: 0, isAdmin: false };

describe('top bar banner', () => {
  it('shows species, phase and a live countdown while an Incident runs, and nothing otherwise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    render(<TopBar me={me} />);
    expect(screen.queryByTestId('incident-banner')).toBeNull();
    act(() => incidentStore.onEvent(ev('open', { endsAt: '2026-10-04T00:20:00.000Z' })));
    const banner = () => screen.getByTestId('incident-banner').textContent!;
    expect(banner()).toContain('INCIDENT');
    expect(banner()).toContain('pidzero');
    expect(banner()).toContain('20:00');
    expect(banner()).toContain('kernelspace');
    act(() => void vi.advanceTimersByTime(65_000));
    expect(banner()).toContain('18:55');
    act(() => incidentStore.onEvent(ev('shield', { endsAt: '2026-10-04T00:20:00.000Z' })));
    expect(banner()).toContain('shielded');
    act(() => incidentStore.onEvent(ev('cleared')));
    expect(screen.queryByTestId('incident-banner')).toBeNull();
  });

  it('seeds the banner from the API when the page loads mid-Incident, and hides one whose end passed unannounced', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    mocks.list.data = { next: { at: 'x', species: 'pidzero', periodMs: 1, windowMs: 1 }, current: { id: 'i9', n: 1, species: 'pingodeth', openedAt: '2026-10-03T23:50:00.000Z', endsAt: '2026-10-04T00:05:00.000Z' }, recent: [] } satisfies Partial<IncidentList>;
    render(<TopBar me={me} />);
    expect(screen.getByTestId('incident-banner').textContent).toContain('pingodeth');
    expect(screen.getByTestId('incident-banner').textContent).toContain('5:00');
    act(() => void vi.advanceTimersByTime(5 * 60_000 + 11_000)); // the end event was lost
    expect(screen.queryByTestId('incident-banner')).toBeNull();
  });
});

describe('travel into kernelspace', () => {
  const gate = getSubnet('backbone').gateways.find((g) => g.incidentOnly)!;
  function client() {
    const travel = vi.fn(() => Promise.resolve({ ok: true }));
    const c = { subnet: 'backbone', role: 'controller', tick: 1, self: { x: gate.at.x, y: gate.at.y, running: [], capture: null, ram: [], inventory: {}, bits: 0 }, world: { gateways: getSubnet('backbone').gateways.map((g) => ({ ...g })) }, operator: { travel }, entities: new Map() };
    return { c: c as unknown as GameClient, travel };
  }

  it('marks the Incident-only gateway closed (travel disabled) until an Incident is open, then notes the 16-operator cap', () => {
    const { c, travel } = client();
    render(<GatewaySection client={c} me={c.self} manual />);
    const btn = () => screen.getByTestId(`travel-${gate.id}`) as HTMLButtonElement;
    expect(screen.getByTestId(`gateway-${gate.id}`).textContent).toContain('closed');
    expect(btn().disabled).toBe(true);
    fireEvent.click(btn());
    expect(travel).not.toHaveBeenCalled();
    act(() => incidentStore.onEvent(ev('open')));
    expect(screen.getByTestId(`gateway-${gate.id}`).textContent).not.toContain('closed');
    expect(screen.getByTestId(`gateway-${gate.id}`).textContent).toContain('16');
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(travel).toHaveBeenCalledWith(gate.id);
    act(() => incidentStore.onEvent(ev('expired')));
    expect(btn().disabled).toBe(true);
  });

  it('leaves ordinary gateways alone', () => {
    const lo = getSubnet('lo').gateways[0]!;
    const travel = vi.fn(() => Promise.resolve({ ok: true }));
    const c = { subnet: 'lo', role: 'controller', tick: 1, self: { x: lo.at.x, y: lo.at.y, running: [], capture: null, ram: [], inventory: {}, bits: 0 }, world: { gateways: getSubnet('lo').gateways.map((g) => ({ ...g })) }, operator: { travel }, entities: new Map() };
    render(<GatewaySection client={c as unknown as GameClient} me={c.self as never} manual />);
    expect((screen.getByTestId(`travel-${lo.id}`) as HTMLButtonElement).disabled).toBe(false);
  });
});

function recordingCtx() {
  const texts: string[] = [];
  const arcs: Array<{ x: number; y: number; r: number }> = [];
  const fills: string[] = [];
  const strokes: string[] = [];
  const noop = () => {};
  const ctx = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, prop: string) {
        if (prop === 'fillText') return (t: string) => texts.push(t);
        if (prop === 'arc') return (x: number, y: number, r: number) => arcs.push({ x, y, r });
        if (prop === 'fill') return () => fills.push(String(target.fillStyle));
        if (prop === 'stroke') return () => strokes.push(String(target.strokeStyle));
        return prop in target ? target[prop] : noop;
      },
      set(target: Record<string, unknown>, prop: string, v: unknown) {
        target[prop] = v;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, texts, arcs, fills, strokes };
}

describe('map: boss ring and telegraph circles', () => {
  beforeEach(() => {
    // jsdom has no canvas: the sprite cache only needs something to paint into
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number) {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: () => {} } as never);
  });
  const controls = { zoom: 2 as const, actor: 'self', targetId: null, tool: 'sniff' as const };
  const cam = { cx: 64, cy: 100, zoom: 2 as const, width: 400, height: 300 };
  const s = scale(cam);
  const boss = (shielded: boolean) => ({ id: 'b1', kind: 'daemon', species: 'pidzero', types: ['kernel'], clean: false, signature: 0, x: 64, y: 100, hp: 50, maxHp: 100, statuses: [], hardened: false, taggedBy: null, boss: true, shielded });
  const client = (subnet: string, entities: object[]) =>
    ({ subnet, tick: 1, operatorId: 'me', self: { x: 64, y: 100, capture: null }, entities: new Map(entities.map((e) => [(e as { id: string }).id, e])) }) as unknown as GameClient;

  it('fills a circle of the blast radius for every telegraph and labels the boss, blue ring while shielded', () => {
    incidentStore.onTelegraph({ x: 64, y: 100, radius: 6, atTick: 40 });
    const a = recordingCtx();
    drawWorld({ ctx: a.ctx, cam, client: client('kernelspace', [boss(false)]), controls: controls as never, hover: null });
    expect(a.texts).toContain('KERNEL DAEMON');
    expect(a.fills).toContain('rgba(244, 63, 94, 0.35)');
    expect(a.arcs.some((c) => Math.abs(c.r - 6 * s) < 1e-6)).toBe(true);
    expect(a.arcs.some((c) => Math.abs(c.r - 1.4 * s) < 1e-6)).toBe(true);
    expect(a.strokes).toContain('#f43f5e');
    const b = recordingCtx();
    drawWorld({ ctx: b.ctx, cam, client: client('kernelspace', [boss(true)]), controls: controls as never, hover: null });
    expect(b.texts).toContain('KERNEL DAEMON · shielded');
    expect(b.strokes).toContain('#93c5fd');
    expect(b.strokes).not.toContain('#f43f5e');
  });

  it('draws no blast outside kernelspace and no boss label for an ordinary daemon', () => {
    incidentStore.onTelegraph({ x: 64, y: 100, radius: 6, atTick: 40 });
    const a = recordingCtx();
    drawWorld({ ctx: a.ctx, cam, client: client('lo', [{ ...boss(false), boss: undefined }]), controls: controls as never, hover: null });
    expect(a.fills).not.toContain('rgba(244, 63, 94, 0.35)');
    expect(a.texts.some((t) => t.startsWith('KERNEL DAEMON'))).toBe(false);
  });
});

const list = (over: Partial<IncidentList> = {}): IncidentList => ({
  next: { at: '2026-10-04T08:00:00.000Z', species: 'pingodeth', periodMs: 14_400_000, windowMs: 1_200_000 },
  current: null,
  recent: [
    { id: 'a', n: 1, species: 'pidzero', openedAt: '2026-10-04T00:00:00.000Z', endsAt: '2026-10-04T00:20:00.000Z', closedAt: '2026-10-04T00:12:00.000Z', outcome: 'CLEARED', participants: [{ name: 'ann', damage: 30, share: 0.75, reward: 6144, you: true }, { name: null, damage: 10, share: 0.25, reward: 2048, you: false }] },
    { id: 'b', n: 0, species: 'pingodeth', openedAt: '2026-10-03T20:00:00.000Z', endsAt: '2026-10-03T20:20:00.000Z', closedAt: '2026-10-03T20:20:00.000Z', outcome: 'EXPIRED', participants: [] },
  ],
  ...over,
});

describe('Incidents tab (history)', () => {
  it('lists the next scheduled Incident and the history with each operator share and reward', () => {
    mocks.list.data = list();
    render(<IncidentsPanel />);
    expect(screen.getByTestId('incident-next').textContent).toContain('pingodeth');
    const rows = screen.getAllByTestId('incident-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('pidzero');
    expect(rows[0]!.textContent).toContain('cleared');
    expect(rows[0]!.textContent).toContain('ann');
    expect(rows[0]!.textContent).toContain('75%');
    expect(rows[0]!.textContent).toContain('6144');
    expect(rows[0]!.textContent).toContain('unknown operator'); // an operator whose name is gone
    expect(rows[1]!.textContent).toContain('expired');
    expect(screen.queryByTestId('incident-start')).toBeNull(); // starting one is an admin tool
  });

  it('marks a running Incident and shows fetch failures in words', () => {
    mocks.list.data = list({ current: { id: 'c', n: 2, species: 'pidzero', openedAt: '2026-10-04T08:00:00.000Z', endsAt: ends(60_000) } });
    const { unmount } = render(<IncidentsPanel />);
    expect(screen.getByTestId('incident-current').textContent).toContain('running');
    unmount();
    mocks.list.data = undefined;
    mocks.list.error = { status: 500, data: { error: 'internal_error', message: 'x' } };
    render(<IncidentsPanel />);
    expect(screen.getByRole('alert').textContent).toContain('server error');
  });
});

describe('admin: start an Incident', () => {
  it('starts one, refetches, and is disabled while one is running', async () => {
    mocks.list.data = list();
    mocks.start.mockReturnValue({ unwrap: () => Promise.resolve({ ok: true }) });
    render(<AdminPanel />);
    fireEvent.click(screen.getByTestId('admin-view-incidents'));
    const btn = screen.getByTestId('incident-start') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => void fireEvent.click(btn));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.list.refetch).toHaveBeenCalled();
    expect(screen.getByTestId('admin-incidents').textContent).toContain('pingodeth');
    cleanup();
    mocks.list.data = list({ current: { id: 'c', n: 2, species: 'pidzero', openedAt: '2026-10-04T08:00:00.000Z', endsAt: ends(60_000) } });
    render(<AdminPanel />);
    fireEvent.click(screen.getByTestId('admin-view-incidents'));
    expect((screen.getByTestId('incident-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the API refusal in words (a 409 when another one started meanwhile)', async () => {
    mocks.list.data = list();
    mocks.start.mockReturnValue({ unwrap: () => Promise.reject({ status: 409, data: { error: 'conflict', message: 'an Incident is already running' } }) });
    render(<AdminPanel />);
    fireEvent.click(screen.getByTestId('admin-view-incidents'));
    await act(async () => void fireEvent.click(screen.getByTestId('incident-start')));
    expect(screen.getByRole('alert').textContent).toBe('an Incident is already running');
  });
});
