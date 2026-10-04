// @vitest-environment jsdom
import { DaemonetError, type GameClient } from '@daemonet/sdk';
import type { ConnectOptions } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureStore } from '../src/game/capture.ts';
import { chatStore, setMe, type ChatLine } from '../src/game/chat.ts';
import { clusterStore, createClusterStore, describeClusterError } from '../src/game/clusters.ts';
import { createConnection, type ConnectionDeps } from '../src/game/connection.ts';
import { createLog, log } from '../src/game/log.ts';

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useLazyChatHistoryQuery: () => [mocks.history],
  useReportMutation: () => [vi.fn(), { isLoading: false }],
  useAdminDeleteMessageMutation: () => [vi.fn()],
  useAdminMuteMutation: () => [vi.fn()],
}));

const { ClusterPanel } = await import('../src/panels/ClusterPanel.tsx');
const { ChatPanel } = await import('../src/panels/ChatPanel.tsx');
const { ErrorBoundary } = await import('../src/components/ErrorBoundary.tsx');

interface Member {
  id: string;
  name: string | null;
  subnet: string | null;
  away: boolean;
}
type ClusterView = { id: string; code: string; leaderId: string; members: Member[] } | null;

const ok = () => Promise.resolve({ ok: true });
const members: Member[] = [
  { id: 'me', name: 'alice', subnet: 'lo', away: false },
  { id: 'bob', name: 'bob', subnet: 'lan', away: true },
];

function fakeClient(over: { cluster?: ClusterView; role?: 'controller' | 'spectator'; nearby?: { id: string; name: string | null }[] } = {}) {
  const api = { create: vi.fn(ok), invite: vi.fn(ok), accept: vi.fn(ok), join: vi.fn(ok), leave: vi.fn(ok), kick: vi.fn(ok) };
  const operators = [{ id: 'me', name: 'alice' }, ...(over.nearby ?? [])];
  const client = {
    operatorId: 'me',
    role: over.role ?? 'controller',
    subnet: 'lo',
    self: { cluster: over.cluster ?? null },
    world: { operators: { all: () => operators } },
    cluster: api,
    chat: {
      get channels() {
        return ['subnet:lo', ...(client.self.cluster ? [`cluster:${client.self.cluster.id}`] : [])];
      },
    },
  };
  return { client: client as unknown as GameClient, api, raw: client };
}

const cluster = (leaderId = 'me'): ClusterView => ({ id: 'c1', code: 'ABCD23', leaderId, members });

beforeEach(() => {
  setMe('me');
  clusterStore.clear();
  chatStore.clear();
  chatStore.setActive('');
  mocks.history.mockReset().mockImplementation(() => ({ unwrap: () => Promise.resolve([]) }));
  log.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('describeClusterError', () => {
  it('maps every protocol error code to a readable message, E_RATE included', () => {
    for (const code of ['E_COOLDOWN', 'E_RANGE', 'E_ENERGY', 'E_RATE', 'E_STATE', 'E_AUTH', 'E_INVALID'] as const) {
      const text = describeClusterError(new DaemonetError(code, 'server detail'));
      expect(text).not.toContain(code);
      expect(text).toContain('server detail');
    }
    expect(describeClusterError(new DaemonetError('E_RATE', 'at most 6 invites a minute'))).toMatch(/too fast|slow down/i);
    expect(describeClusterError(new Error('boom'))).toContain('boom');
  });
});

describe('cluster store', () => {
  it('keeps one invite per cluster and drops it client-side when it expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    const s = createClusterStore();
    s.push({ clusterId: 'c1', from: 'bob', name: 'bob', expiresAt: '2026-10-04T00:01:00.000Z' });
    s.push({ clusterId: 'c1', from: 'bob', name: 'bob', expiresAt: '2026-10-04T00:01:30.000Z' });
    s.push({ clusterId: 'c2', from: 'cy', name: null, expiresAt: '2026-10-04T00:00:10.000Z' });
    s.push({ clusterId: 'c3', from: 'dee', name: null, expiresAt: '2026-10-03T00:00:00.000Z' }); // already expired
    expect(s.get().invites.map((i) => i.clusterId)).toEqual(['c1', 'c2']);
    const snap = s.get();
    expect(s.get()).toBe(snap);
    vi.advanceTimersByTime(10_001);
    expect(s.get().invites.map((i) => i.clusterId)).toEqual(['c1']);
    vi.advanceTimersByTime(80_000);
    expect(s.get().invites).toEqual([]);
    s.push({ clusterId: 'c4', from: 'x', name: null, expiresAt: '2026-10-04T01:00:00.000Z' });
    s.clear();
    expect(s.get().invites).toEqual([]);
    vi.advanceTimersByTime(3_600_000); // no stray timer fires after clear
    expect(s.get().invites).toEqual([]);
  });
});

describe('connection wiring (captured before any panel mounts)', () => {
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
    const clusters = createClusterStore();
    const l = createLog(50);
    const deps: ConnectionDeps = {
      fetchTicket: async () => 't',
      createClient: (opts) => {
        const c = new FakeClient(opts);
        clients.push(c);
        return c as unknown as GameClient;
      },
      url: () => 'ws://x',
      log: l,
      capture: createCaptureStore(),
      stopSandbox: vi.fn(),
      invalidateCodex: vi.fn(),
      clusters,
    };
    return { conn: createConnection(deps), clients, clusters, log: l };
  }

  it('stores an invite that arrives with no panel mounted, logs it, and forgets invites when the connection closes', async () => {
    const { conn, clients, clusters, log: l } = setup();
    await conn.open('controller');
    clients[0]!.emit('clusterInvite', { clusterId: 'c1', from: 'bob', name: 'bob', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(clusters.get().invites.map((i) => i.clusterId)).toEqual(['c1']);
    expect(l.get().some((e) => e.text.includes('bob invites you to a cluster'))).toBe(true);
    conn.close();
    expect(clusters.get().invites).toEqual([]);
  });

  it('forgets invites on a terminal kick and when a new open() replaces the client', async () => {
    const { conn, clients, clusters } = setup();
    await conn.open('controller');
    const soon = () => new Date(Date.now() + 60_000).toISOString();
    clients[0]!.emit('clusterInvite', { clusterId: 'c1', from: 'bob', name: null, expiresAt: soon() });
    clients[0]!.emit('kick', 'banned');
    expect(clusters.get().invites).toEqual([]);
    await conn.open('controller');
    clients[1]!.emit('clusterInvite', { clusterId: 'c2', from: 'bob', name: null, expiresAt: soon() });
    await conn.open('spectator');
    expect(clusters.get().invites).toEqual([]);
  });
});

describe('ClusterPanel', () => {
  it('without a cluster: creates one, joins by (upper-cased) code, and keeps join disabled until 6 characters', () => {
    const { client, api } = fakeClient();
    render(<ClusterPanel client={client} />);
    expect(screen.queryByTestId('cluster-code')).toBeNull();
    fireEvent.click(screen.getByTestId('cluster-create'));
    expect(api.create).toHaveBeenCalled();
    const join = screen.getByTestId('cluster-join') as HTMLButtonElement;
    const input = screen.getByTestId('cluster-code-input');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(join.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'abcd23' } });
    expect(join.disabled).toBe(false);
    fireEvent.click(join);
    expect(api.join).toHaveBeenCalledWith('ABCD23');
  });

  it('as a member: shows the code with a copy button, members with away flags, leave; kick only for the leader', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const leader = fakeClient({ cluster: cluster('me') });
    const { unmount } = render(<ClusterPanel client={leader.client} />);
    expect(screen.getByTestId('cluster-code').textContent).toBe('ABCD23');
    const rows = screen.getByTestId('cluster-members').querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain('away');
    expect(rows[0]!.textContent).not.toContain('away');
    await act(async () => fireEvent.click(screen.getByTestId('cluster-copy')));
    expect(writeText).toHaveBeenCalledWith('ABCD23');
    const kicks = screen.getAllByRole('button', { name: 'kick' });
    expect(kicks).toHaveLength(1); // not on yourself
    fireEvent.click(kicks[0]!);
    expect(leader.api.kick).toHaveBeenCalledWith('bob');
    fireEvent.click(screen.getByTestId('cluster-leave'));
    expect(leader.api.leave).toHaveBeenCalled();
    unmount();

    const member = fakeClient({ cluster: cluster('bob') });
    render(<ClusterPanel client={member.client} />);
    expect(screen.queryByRole('button', { name: 'kick' })).toBeNull();
    expect(screen.queryByTestId('cluster-invite-nearby')).toBeNull(); // only the leader invites
  });

  it('invites a nearby operator and logs a rejected command with a readable (E_RATE) message', async () => {
    const { client, api } = fakeClient({ nearby: [{ id: 'cy', name: 'cy' }] });
    api.invite.mockImplementationOnce(() => Promise.reject(new DaemonetError('E_RATE', 'at most 6 invites a minute')));
    render(<ClusterPanel client={client} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'cy' })));
    expect(api.invite).toHaveBeenCalledWith('cy');
    const text = log.get().map((e) => e.text).join('\n');
    expect(text).toContain('at most 6 invites a minute');
    expect(text).not.toContain('E_RATE');
  });

  it('shows a pending invite from the store, accepts it, and the invite vanishes at expiry; spectators cannot act', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    const { client, api } = fakeClient();
    render(<ClusterPanel client={client} />);
    act(() => clusterStore.push({ clusterId: 'c9', from: 'bob', name: 'bob', expiresAt: '2026-10-04T00:01:00.000Z' }));
    expect(screen.getByText(/bob invites you to a cluster/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'accept' })));
    expect(api.accept).toHaveBeenCalledWith('c9');
    expect(screen.queryByText(/bob invites you/)).toBeNull(); // consumed
    act(() => clusterStore.push({ clusterId: 'c10', from: 'bob', name: 'bob', expiresAt: '2026-10-04T00:01:00.000Z' }));
    expect(screen.getByText(/bob invites you/)).toBeTruthy();
    act(() => void vi.advanceTimersByTime(61_000));
    expect(screen.queryByText(/bob invites you/)).toBeNull();
    cleanup();
    const spec = fakeClient({ role: 'spectator', nearby: [{ id: 'cy', name: 'cy' }] });
    render(<ClusterPanel client={spec.client} />);
    expect((screen.getByTestId('cluster-create') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'cy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a crash inside the panel is contained by the chat panel boundary instead of unmounting the app', () => {
    const { client } = fakeClient();
    (client as unknown as { self: unknown }).self = null; // render throws
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="chat panel">
        <ChatPanel client={client} isAdmin={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('panel-crashed')).toBeTruthy();
  });
});

describe('ChatPanel with clusters', () => {
  const clusterLine = (id: string, text: string): ChatLine => ({ id, channel: 'cluster:c1', from: 'bob', name: 'bob', tag: null, text, at: '2026-10-04T00:00:00.000Z' });

  it('renders the cluster panel first and shows the cluster channel only while a member', () => {
    const f = fakeClient({ cluster: cluster() });
    chatStore.push(clusterLine('l1', 'hi cluster'));
    const view = render(<ChatPanel client={f.client} isAdmin={false} />);
    expect(screen.getByTestId('cluster')).toBeTruthy();
    expect(screen.getByTestId('channel-cluster:c1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('channel-cluster:c1'));
    expect(screen.getByTestId('chat-lines').textContent).toContain('hi cluster');
    // leave: the lines stay in the store but the channel and the selection go away
    f.raw.self.cluster = null;
    view.rerender(<ChatPanel client={f.client} isAdmin={false} />);
    expect(screen.queryByTestId('channel-cluster:c1')).toBeNull();
    expect(screen.getByTestId('chat-lines').textContent).not.toContain('hi cluster');
    expect(screen.getByTestId('chat-input').getAttribute('placeholder')).toBe('message subnet:lo');
  });

  it('keeps a lingering channel of a cluster you left out of the tabs even for another cluster id', () => {
    const f = fakeClient({ cluster: { ...cluster()!, id: 'c2' } });
    chatStore.push(clusterLine('l1', 'old cluster'));
    render(<ChatPanel client={f.client} isAdmin={false} />);
    expect(screen.queryByTestId('channel-cluster:c1')).toBeNull();
    expect(screen.getByTestId('channel-cluster:c2')).toBeTruthy();
  });
});
