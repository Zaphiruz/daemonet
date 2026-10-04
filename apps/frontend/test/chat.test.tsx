// @vitest-environment jsdom
import type { GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatStore, createChatStore, setMe, type ChatLine } from '../src/game/chat.ts';
import { log } from '../src/game/log.ts';

const ok = (v: unknown) => ({ unwrap: () => Promise.resolve(v) });
const fail = (e: unknown) => ({ unwrap: () => Promise.reject(e) });

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  report: vi.fn(),
  reports: { data: undefined as unknown, error: undefined as unknown, refetch: vi.fn() },
  resolve: vi.fn(),
  terms: { data: undefined as unknown, error: undefined as unknown },
  addTerm: vi.fn(),
  deleteTerm: vi.fn(),
  economy: { data: undefined as unknown, error: undefined as unknown },
  adminDelete: vi.fn(),
  adminMute: vi.fn(),
}));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useLazyChatHistoryQuery: () => [mocks.history],
  useReportMutation: () => [mocks.report, { isLoading: false }],
  useAdminReportsQuery: () => mocks.reports,
  useResolveReportMutation: () => [mocks.resolve],
  useFilterTermsQuery: () => mocks.terms,
  useAddFilterTermMutation: () => [mocks.addTerm],
  useDeleteFilterTermMutation: () => [mocks.deleteTerm],
  useAdminEconomyQuery: () => mocks.economy,
  useAdminDeleteMessageMutation: () => [mocks.adminDelete],
  useAdminMuteMutation: () => [mocks.adminMute],
}));

const { ChatPanel } = await import('../src/panels/ChatPanel.tsx');
const apiModule = await import('../src/api.ts');
const { AdminPanel } = await import('../src/panels/AdminPanel.tsx');

const line = (over: Partial<ChatLine>): ChatLine => ({ id: 'm1', channel: 'subnet:lo', from: 'a', name: 'alice', tag: null, text: 'hi', at: '2026-09-30T00:00:00.000Z', ...over });

describe('chat store', () => {
  it('keeps lines per channel in time order without duplicates, counts unread off the active channel, and files DMs under the other side', () => {
    setMe('me');
    const s = createChatStore();
    s.setActive('subnet:lo');
    s.push(line({ id: 'm2', at: '2026-09-30T00:00:02.000Z', text: 'second' }));
    s.push(line({ id: 'm1', at: '2026-09-30T00:00:01.000Z', text: 'first' }));
    s.history('subnet:lo', [line({ id: 'm0', at: '2026-09-30T00:00:00.000Z', text: 'zero' }), line({ id: 'm1', at: '2026-09-30T00:00:01.000Z', text: 'first' })]);
    expect(s.get().lines.get('subnet:lo')!.map((l) => l.text)).toEqual(['zero', 'first', 'second']);
    expect(s.get().unread.get('subnet:lo')).toBeUndefined();
    s.push(line({ id: 'd1', channel: 'dm:me', from: 'bob', text: 'psst' }));
    expect(s.get().lines.get('dm:bob')!.map((l) => l.text)).toEqual(['psst']);
    expect(s.get().unread.get('dm:bob')).toBe(1);
    s.push(line({ id: 'd2', channel: 'dm:bob', from: 'me', text: 'yes?' }));
    expect(s.get().lines.get('dm:bob')!.map((l) => l.text)).toEqual(['psst', 'yes?']);
    s.setActive('dm:bob');
    expect(s.get().unread.get('dm:bob')).toBeUndefined();
    s.remove('m1');
    expect(s.get().lines.get('subnet:lo')!.map((l) => l.id)).toEqual(['m0', 'm2']);
    const snap = s.get();
    expect(s.get()).toBe(snap); // stable between changes (useSyncExternalStore requires it)
    s.setMuted('2026-10-01T00:00:00.000Z');
    expect(s.get().mutedUntil).toBe('2026-10-01T00:00:00.000Z');
  });

  it('orders lines of the same millisecond by id, like the API', () => {
    const s = createChatStore();
    s.history('subnet:lo', [line({ id: 'sc', text: 'c' }), line({ id: 'sa', text: 'a' })]);
    s.push(line({ id: 'sb', text: 'b' }));
    expect(s.get().lines.get('subnet:lo')!.map((l) => l.id)).toEqual(['sa', 'sb', 'sc']);
  });

  it('does not count your own lines or a replayed line as unread, and clear() forgets lines, unread and the mute', () => {
    setMe('me');
    const s = createChatStore();
    s.setActive('subnet:lo');
    s.push(line({ id: 'x1', channel: 'dm:bob', from: 'me' }));
    expect(s.get().unread.size).toBe(0);
    s.push(line({ id: 'x2', channel: 'dm:bob', from: 'bob' }));
    s.push(line({ id: 'x2', channel: 'dm:bob', from: 'bob' }));
    expect(s.get().unread.get('dm:bob')).toBe(1);
    s.setMuted('2026-10-01T00:00:00.000Z');
    s.clear();
    expect(s.get().lines.size).toBe(0);
    expect(s.get().unread.size).toBe(0);
    expect(s.get().mutedUntil).toBeNull();
  });
});

function fakeClient(over: { subnet?: string; role?: 'controller' | 'spectator'; cluster?: string } = {}) {
  const send = vi.fn(() => Promise.resolve({ ok: true }));
  const client = {
    operatorId: 'me',
    role: over.role ?? 'controller',
    subnet: over.subnet ?? 'lo',
    chat: {
      send,
      get channels() {
        return [`subnet:${client.subnet}`, ...(over.cluster ? [`cluster:${over.cluster}`] : [])];
      },
    },
  };
  return { client: client as unknown as GameClient & { subnet: string }, send };
}

beforeEach(() => {
  setMe('me');
  chatStore.clear();
  chatStore.setActive('');
  mocks.history.mockReset().mockImplementation(() => ok([]));
  mocks.report.mockReset().mockImplementation(() => ok({ ok: true, id: 'r1' }));
  mocks.resolve.mockReset().mockImplementation(() => ok({ ok: true }));
  mocks.addTerm.mockReset().mockImplementation(() => ok({}));
  mocks.deleteTerm.mockReset().mockImplementation(() => ok({ ok: true }));
  mocks.adminDelete.mockReset().mockImplementation(() => ok({ ok: true }));
  mocks.adminMute.mockReset().mockImplementation(() => ok({ ok: true }));
  mocks.reports.data = undefined;
  mocks.reports.error = undefined;
  mocks.terms.data = undefined;
  mocks.terms.error = undefined;
  mocks.economy.data = undefined;
  mocks.economy.error = undefined;
  log.clear();
});
afterEach(cleanup);

const logText = () => {
  let t = '';
  log.get().forEach((e) => (t += `${e.kind}:${e.text}\n`));
  return t;
};

describe('ChatPanel', () => {
  it('renders lines as plain text: no HTML, no links', () => {
    chatStore.push(line({ id: 'm1', text: '<img src=x onerror=alert(1)> see https://evil.example/x and <b>bold</b>' }));
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    const lines = screen.getByTestId('chat-lines');
    expect(lines.textContent).toContain('<img src=x onerror=alert(1)> see https://evil.example/x and <b>bold</b>');
    expect(lines.querySelector('img, b, a')).toBeNull();
  });

  it('loads history for the subnet channel and shows it', async () => {
    mocks.history.mockImplementation(() => ok([line({ id: 'h1', text: 'older' })]));
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    await waitFor(() => expect(screen.getByTestId('chat-lines').textContent).toContain('older'));
    expect(mocks.history).toHaveBeenCalledWith({ channel: 'subnet:lo' });
  });

  it('loads older lines with the (at, id) cursor of the oldest line held, until a page comes back empty', async () => {
    chatStore.history('subnet:lo', [line({ id: 'sb', text: 'b' }), line({ id: 'sc', text: 'c' })]);
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(1));
    mocks.history.mockImplementation(() => ok([line({ id: 'sa', text: 'a' })]));
    fireEvent.click(screen.getByTestId('chat-older'));
    expect(mocks.history).toHaveBeenLastCalledWith({ channel: 'subnet:lo', before: '2026-09-30T00:00:00.000Z', beforeId: 'sb' });
    await waitFor(() => expect(chatStore.get().lines.get('subnet:lo')!.map((l) => l.id)).toEqual(['sa', 'sb', 'sc']));
    mocks.history.mockImplementation(() => ok([]));
    fireEvent.click(screen.getByTestId('chat-older'));
    expect(mocks.history).toHaveBeenLastCalledWith({ channel: 'subnet:lo', before: '2026-09-30T00:00:00.000Z', beforeId: 'sa' });
    await waitFor(() => expect(screen.queryByTestId('chat-older')).toBeNull());
  });

  it('builds the history URL with the composite cursor', () => {
    expect(apiModule.chatHistoryUrl({ channel: 'subnet:lo' })).toBe('/chat/subnet%3Alo');
    expect(apiModule.chatHistoryUrl({ channel: 'dm:x', before: '2026-09-30T00:00:00.000Z', beforeId: 'm1' })).toBe('/chat/dm%3Ax?before=2026-09-30T00%3A00%3A00.000Z&beforeId=m1');
  });

  it('sends through the SDK, clears the input and disables send during the interval; spectators cannot type', () => {
    const { client, send } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: ' hello ' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send).toHaveBeenCalledWith('subnet:lo', 'hello');
    expect((screen.getByTestId('chat-input') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'again' } });
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<ChatPanel client={fakeClient({ role: 'spectator' }).client} isAdmin={false} />);
    expect((screen.getByTestId('chat-input') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows a mute and blocks input until it passes', () => {
    chatStore.setMuted(new Date(Date.now() + 3_600_000).toISOString());
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toContain('muted until');
    act(() => chatStore.setMuted(null));
    expect(input.disabled).toBe(false);
  });

  it('counts unread lines on other channels and opens a DM thread under the other side', () => {
    const { client, send } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    act(() => chatStore.push(line({ id: 'd1', channel: 'dm:me', from: 'bob', name: 'bob', text: 'psst' })));
    expect(screen.getByTestId('channel-dm:bob').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('channel-dm:bob'));
    expect(screen.getByTestId('chat-lines').textContent).toContain('psst');
    expect(screen.getByTestId('channel-dm:bob').textContent).not.toContain('1');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'yes?' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send).toHaveBeenCalledWith('dm:bob', 'yes?');
  });

  it('counts lines as unread again once the panel is gone (the store tracks the active channel only while mounted)', () => {
    const { client } = fakeClient();
    const { unmount } = render(<ChatPanel client={client} isAdmin={false} />);
    unmount();
    chatStore.push(line({ id: 'u1', text: 'while away' }));
    expect(chatStore.get().unread.get('subnet:lo')).toBe(1);
  });

  it('follows travel: the subnet channel becomes the new subnet and sends go there', () => {
    const { client, send } = fakeClient();
    const { rerender } = render(<ChatPanel client={client} isAdmin={false} />);
    expect(screen.getByTestId('channel-subnet:lo')).toBeTruthy();
    chatStore.push(line({ id: 'old', text: 'old subnet line' }));
    client.subnet = 'lan';
    rerender(<ChatPanel client={client} isAdmin={false} />);
    expect(screen.queryByTestId('channel-subnet:lo')).toBeNull();
    expect(screen.getByTestId('channel-subnet:lan')).toBeTruthy();
    expect(screen.getByTestId('chat-lines').textContent).not.toContain('old subnet line');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hi lan' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send).toHaveBeenCalledWith('subnet:lan', 'hi lan');
    expect(mocks.history).toHaveBeenLastCalledWith({ channel: 'subnet:lan' });
  });

  it('reports a line: reason and note go to the API, the reporter only sees "report received"; own lines have no report button', async () => {
    chatStore.push(line({ id: 'm1', from: 'bob', name: 'bob', text: 'rude' }));
    chatStore.push(line({ id: 'm2', from: 'me', name: 'me', text: 'mine' }));
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    expect(screen.queryByTestId('report-m2')).toBeNull();
    fireEvent.click(screen.getByTestId('report-m1'));
    fireEvent.click(screen.getByTestId('report-send'));
    await waitFor(() => expect(logText()).toContain('report received'));
    expect(mocks.report).toHaveBeenCalledWith({ targetId: 'bob', messageId: 'm1', reason: 'SPAM', note: '' });
    expect(logText()).not.toMatch(/github/i);
    expect(screen.queryByTestId('report-send')).toBeNull();
  });

  it('answers a duplicate report with the same "report received" and shows the daily cap as an error', async () => {
    chatStore.push(line({ id: 'm1', from: 'bob', text: 'rude' }));
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    mocks.report.mockImplementation(() => ok({ ok: true, id: 'r1', duplicate: true }));
    fireEvent.click(screen.getByTestId('report-m1'));
    fireEvent.click(screen.getByTestId('report-send'));
    await waitFor(() => expect(logText()).toContain('report received'));
    mocks.report.mockImplementation(() => fail({ status: 400, data: { error: 'validation_error', message: 'at most 8 reports per day' } }));
    fireEvent.click(screen.getByTestId('report-m1'));
    fireEvent.click(screen.getByTestId('report-send'));
    await waitFor(() => expect(logText()).toContain('report not sent: at most 8 reports per day'));
  });

  it('shows delete and mute only to admins, through the API, and surfaces their errors', async () => {
    chatStore.push(line({ id: 'm1', from: 'bob', name: 'bob', text: 'rude' }));
    const { client } = fakeClient();
    render(<ChatPanel client={client} isAdmin={false} />);
    expect(screen.queryByTestId('admin-delete-m1')).toBeNull();
    cleanup();
    render(<ChatPanel client={client} isAdmin />);
    fireEvent.click(screen.getByTestId('admin-delete-m1'));
    expect(mocks.adminDelete).toHaveBeenCalledWith('m1');
    fireEvent.click(screen.getByTestId('admin-mute-m1'));
    expect(mocks.adminMute).toHaveBeenCalledWith({ operatorId: 'bob', minutes: 30 });
    mocks.adminMute.mockImplementation(() => fail({ status: 404, data: { error: 'not_found', message: 'no such operator' } }));
    fireEvent.click(screen.getByTestId('admin-mute-m1'));
    await waitFor(() => expect(logText()).toContain('no such operator'));
  });
});

describe('AdminPanel', () => {
  const report = {
    id: 'r1', reporterId: 'rep', targetId: 'bob', messageId: 'm1', reason: 'SPAM', note: 'ads', status: 'OPEN', at: '2026-09-30T00:00:00.000Z',
    reporterName: 'rita', targetName: 'bob', message: { id: 'm1', text: '<b>buy</b>', channel: 'subnet:lo' },
    recent: [{ id: 'm0', channel: 'subnet:lo', text: 'earlier line', at: '2026-09-30T00:00:00.000Z' }],
    hits: [{ id: 'h1', channel: 'subnet:lo', text: 'blocked text', term: 'kys', at: '2026-09-30T00:00:00.000Z' }],
  };

  it('lists reports with the message, recent lines and hits, and resolves them', async () => {
    mocks.reports.data = [report];
    render(<AdminPanel />);
    const q = screen.getByTestId('admin-reports');
    expect(q.textContent).toContain('rita');
    expect(q.textContent).toContain('<b>buy</b>');
    expect(q.querySelector('b')).toBeNull();
    expect(q.textContent).toContain('earlier line');
    expect(q.textContent).toContain('kys');
    fireEvent.click(screen.getByText('delete message'));
    expect(mocks.resolve).toHaveBeenCalledWith({ id: 'r1', action: 'DELETE' });
    fireEvent.click(screen.getByText('mute 1h'));
    expect(mocks.resolve).toHaveBeenCalledWith({ id: 'r1', action: 'MUTE', minutes: 60 });
    fireEvent.click(screen.getByText('dismiss'));
    expect(mocks.resolve).toHaveBeenCalledWith({ id: 'r1', action: 'DISMISS' });
  });

  it('handles every admin error code with a readable message', async () => {
    mocks.reports.data = [report];
    render(<AdminPanel />);
    const cases: Array<[unknown, string]> = [
      [{ status: 400, data: { error: 'validation_error', message: 'already resolved' } }, 'already resolved'],
      [{ status: 400, data: { error: 'bad_request', message: 'body must be object' } }, 'body must be object'],
      [{ status: 401, data: { error: 'unauthorized', message: 'x' } }, 'sign in again'],
      [{ status: 403, data: { error: 'forbidden', message: 'x' } }, 'admin'],
      [{ status: 404, data: { error: 'not_found', message: 'no such report' } }, 'no such report'],
      [{ status: 413, data: { error: 'payload_too_large', message: 'x' } }, 'too large'],
      [{ status: 429, data: { error: 'rate_limited', message: 'x' } }, 'too many requests'],
      [{ status: 500, data: { error: 'internal_error', message: 'internal error' } }, 'server error'],
      [{ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' }, 'network'],
    ];
    for (const [err, text] of cases) {
      mocks.resolve.mockImplementation(() => fail(err));
      fireEvent.click(screen.getByText('dismiss'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(text));
    }
  });

  it('shows a failed query as an error with a retry', () => {
    mocks.reports.error = { status: 403, data: { error: 'forbidden', message: 'admin only' } };
    render(<AdminPanel />);
    expect(screen.getByRole('alert').textContent).toContain('admin');
  });

  it('adds filter terms (showing the server refusal reason) and removes them', async () => {
    mocks.terms.data = [{ id: 't1', pattern: 'spoon', kind: 'WORD', action: 'MASK' }];
    render(<AdminPanel />);
    fireEvent.click(screen.getByTestId('admin-view-filter'));
    fireEvent.change(screen.getByTestId('filter-pattern'), { target: { value: ' fork ' } });
    fireEvent.submit(screen.getByTestId('filter-pattern').closest('form')!);
    expect(mocks.addTerm).toHaveBeenCalledWith({ pattern: 'fork', kind: 'WORD', action: 'BLOCK' });
    mocks.addTerm.mockImplementation(() => fail({ status: 400, data: { error: 'validation_error', message: 'filter term refused: matches everything' } }));
    fireEvent.change(screen.getByTestId('filter-pattern'), { target: { value: '.*' } });
    fireEvent.submit(screen.getByTestId('filter-pattern').closest('form')!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('matches everything'));
    fireEvent.click(screen.getByText('remove'));
    expect(mocks.deleteTerm).toHaveBeenCalledWith('t1');
  });

  it('shows the economy view', () => {
    mocks.economy.data = { supply: 100, operators: 2, days: [{ day: '2026-09-30', created: 5, destroyed: 3, byReason: { buy: -3 } }] };
    render(<AdminPanel />);
    fireEvent.click(screen.getByTestId('admin-view-economy'));
    expect(screen.getByText(/supply 100 bits across 2 operators/)).toBeTruthy();
  });
});
