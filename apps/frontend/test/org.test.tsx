// @vitest-environment jsdom
import type { GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatStore, setMe, type ChatLine } from '../src/game/chat.ts';
import { log } from '../src/game/log.ts';
import type { OrgLeaderRow, OrgMine, OrgRank, OrgView } from '../src/api.ts';

const mocks = vi.hoisted(() => ({
  mine: { data: undefined as unknown, refetch: vi.fn() },
  board: { data: undefined as unknown },
  act: vi.fn(),
  rename: vi.fn(),
  history: vi.fn(),
  boardSkip: undefined as unknown,
  mineArgs: [] as unknown[],
}));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useOrgMineQuery: (...args: unknown[]) => {
    mocks.mineArgs = args;
    return mocks.mine;
  },
  useOrgLeaderboardQuery: (_id: string, opts?: { skip?: boolean }) => {
    mocks.boardSkip = opts?.skip;
    return mocks.board;
  },
  useOrgActionMutation: () => [mocks.act, { isLoading: false }],
  useRenameMutation: () => [mocks.rename, { isLoading: false }],
  useLazyChatHistoryQuery: () => [mocks.history],
  useReportMutation: () => [vi.fn(), { isLoading: false }],
  useAdminDeleteMessageMutation: () => [vi.fn()],
  useAdminMuteMutation: () => [vi.fn()],
}));

const { OrgPanel } = await import('../src/panels/OrgPanel.tsx');
const { ChatPanel } = await import('../src/panels/ChatPanel.tsx');
const { describeOrgError } = await import('../src/api.ts');
const { taggedName } = await import('../src/game/names.ts');

// prices deliberately differ from the spec numbers: the panel must show what the api says
const prices = { create: 111, tag: 222, rename: 333 };

function member(operatorId: string, name: string | null, rank: OrgRank) {
  return { operatorId, name, rank, joinedAt: '2026-10-04T00:00:00.000Z' };
}
function orgView(over: Partial<OrgView> = {}): OrgView {
  return { id: 'o1', name: 'Red Team', tag: 'RED1', ownerId: 'me', members: [member('me', 'alice', 'OWNER'), member('off', 'olly', 'OFFICER'), member('mem', 'mia', 'MEMBER')], ...over };
}
function setMine(over: Partial<OrgMine> = {}) {
  mocks.mine.data = { org: null, rank: null, invites: [], prices, ...over } satisfies OrgMine;
}
function setBoard(rows: OrgLeaderRow[]) {
  mocks.board.data = rows;
}
const row = (operatorId: string, name: string | null, rank: OrgRank, captures: number, highestSignature = 0, evolutions = 0, ticketsDone = 0): OrgLeaderRow => ({ operatorId, name, rank, captures, highestSignature, evolutions, ticketsDone });

function fakeClient(over: { bits?: number; org?: { id: string; name: string; tag: string; rank: OrgRank } | null } = {}) {
  const client = {
    operatorId: 'me',
    role: 'controller',
    subnet: 'lo',
    self: { bits: over.bits ?? 10_000, org: over.org ?? null, cluster: null },
    world: { operators: { all: () => [] } },
    chat: {
      get channels() {
        return ['subnet:lo', ...(client.self.org ? [`org:${client.self.org.id}`] : [])];
      },
    },
  };
  return { client: client as unknown as GameClient, raw: client };
}

const ok = () => ({ unwrap: () => Promise.resolve({ ok: true }) });
const fail = (status: number, data: object) => ({ unwrap: () => Promise.reject({ status, data }) });
const flush = () => act(async () => {});

beforeEach(() => {
  setMe('me');
  chatStore.clear();
  chatStore.setActive('');
  log.clear();
  setMine();
  mocks.board.data = undefined;
  mocks.act.mockReset().mockImplementation(ok);
  mocks.rename.mockReset().mockImplementation(ok);
  mocks.mine.refetch.mockReset();
  mocks.history.mockReset().mockImplementation(() => ({ unwrap: () => Promise.resolve([]) }));
});
afterEach(cleanup);

describe('describeOrgError', () => {
  it('maps 402, filter refusal, name taken and permission errors to readable text, never raw bodies', () => {
    expect(describeOrgError({ status: 402, data: { error: 'insufficient_bits', message: 'costs 8192 bits' } })).toBe('not enough bits: costs 8192 bits');
    expect(describeOrgError({ status: 400, data: { error: 'validation_error', message: 'that name or tag is not allowed' } })).toBe('that name or tag is not allowed');
    expect(describeOrgError({ status: 400, data: { error: 'validation_error', message: 'that name is taken' } })).toBe('that name is taken');
    expect(describeOrgError({ status: 403, data: { error: 'forbidden', message: 'requires owner' } })).toBe('not allowed: requires owner');
    expect(describeOrgError({ status: 403, data: { error: 'forbidden' } })).toMatch(/not allowed/);
    expect(describeOrgError({ status: 'FETCH_ERROR' })).toMatch(/network/);
    expect(describeOrgError({ status: 500, data: { error: 'internal_error', message: 'stack trace' } })).not.toContain('stack');
    expect(describeOrgError(null)).toBe('request failed');
  });
  it('taggedName prefixes the tag as plain text', () => {
    expect(taggedName('RED1', 'alice')).toBe('[RED1] alice');
    expect(taggedName(null, 'alice')).toBe('alice');
    expect(taggedName(undefined, null)).toBe('?');
  });
});

describe('OrgPanel without an org', () => {
  it('shows the api prices, asks for confirmation before spending, and submits once', async () => {
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org').textContent).toContain('111 bits');
    expect(screen.getByTestId('org').textContent).toContain('333 bits');
    const create = screen.getByTestId('org-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: 'Red Team' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'red1' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(mocks.act).not.toHaveBeenCalled(); // nothing is spent before the confirmation
    expect(screen.getByTestId('org-confirm-text').textContent).toContain('111 bits');
    fireEvent.click(screen.getByTestId('org-cancel'));
    expect(mocks.act).not.toHaveBeenCalled();
    fireEvent.click(create);
    let release!: () => void;
    mocks.act.mockImplementationOnce(() => ({ unwrap: () => new Promise((r) => (release = () => r({}))) }));
    const confirm = screen.getByTestId('org-confirm') as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm); // double submit while in flight
    expect(mocks.act).toHaveBeenCalledTimes(1);
    expect(mocks.act).toHaveBeenCalledWith({ path: '', body: { name: 'Red Team', tag: 'RED1' } });
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect(screen.queryByTestId('org-error')).toBeNull();
  });

  it('disables create without enough bits (with the reason), and for an invalid name or tag', () => {
    const { client } = fakeClient({ bits: 110 });
    render(<OrgPanel client={client} />);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: 'Red Team' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'RED1' } });
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('org').textContent).toMatch(/need 111 bits/);
    cleanup();
    const rich = fakeClient();
    render(<OrgPanel client={rich.client} />);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: ' Red  Team ' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'RED1' } });
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: 'Red Team' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'RE' } });
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables paid actions until the prices have loaded (no hard-coded fallback)', () => {
    mocks.mine.data = undefined;
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: 'Red Team' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'RED1' } });
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('org').textContent).not.toMatch(/8192|4096|2048/);
  });

  it.each([
    [402, { error: 'insufficient_bits', message: 'costs 111 bits' }, 'not enough bits: costs 111 bits'],
    [400, { error: 'validation_error', message: 'that name or tag is not allowed' }, 'that name or tag is not allowed'],
    [400, { error: 'validation_error', message: 'that name is taken' }, 'that name is taken'],
  ])('shows a readable message for a %i refusal and re-enables the form', async (status, data, text) => {
    mocks.act.mockImplementation(() => fail(status, data));
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    fireEvent.change(screen.getByTestId('org-name'), { target: { value: 'Red Team' } });
    fireEvent.change(screen.getByTestId('org-tag'), { target: { value: 'RED1' } });
    fireEvent.click(screen.getByTestId('org-create'));
    await act(async () => fireEvent.click(screen.getByTestId('org-confirm')));
    expect(screen.getByTestId('org-error').textContent).toContain(text);
    expect(log.get().map((e) => e.text).join('\n')).toContain(text);
    expect((screen.getByTestId('org-create') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists invites with accept and decline', async () => {
    setMine({ invites: [{ orgId: 'o9', name: '<b>Evil</b>', tag: 'EVL9', byId: 'x', at: '2026-10-04T00:00:00.000Z' }] });
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org').textContent).toContain('<b>Evil</b>'); // text, not markup
    expect(screen.getByTestId('org').querySelector('b')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'accept' })));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/o9/accept', body: {} });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'decline' })));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/o9/decline', body: {} });
  });

  it('renames the operator after a confirmation that shows the price; the name rules gate the button', async () => {
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    const btn = screen.getByTestId('org-rename') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('org-rename-input'), { target: { value: 'Bad Name' } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('org-rename-input'), { target: { value: 'new_name' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-confirm-text').textContent).toContain('333 bits');
    await act(async () => fireEvent.click(screen.getByTestId('org-confirm')));
    expect(mocks.rename).toHaveBeenCalledWith({ name: 'new_name' });
    expect((screen.getByTestId('org-rename-input') as HTMLInputElement).value).toBe('');
  });

  it('shows a rename refusal readably', async () => {
    mocks.rename.mockImplementation(() => fail(400, { error: 'validation_error', message: 'that name is taken' }));
    const { client } = fakeClient();
    render(<OrgPanel client={client} />);
    fireEvent.change(screen.getByTestId('org-rename-input'), { target: { value: 'taken_one' } });
    fireEvent.click(screen.getByTestId('org-rename'));
    await act(async () => fireEvent.click(screen.getByTestId('org-confirm')));
    expect(screen.getByTestId('org-error').textContent).toContain('that name is taken');
  });
});

describe('OrgPanel as a member', () => {
  const asRank = (rank: OrgRank) => {
    const org = orgView({ ownerId: 'me', members: [member('me', 'alice', 'OWNER'), member('off', 'olly', 'OFFICER'), member('mem', 'mia', 'MEMBER')] });
    org.members = org.members.map((m) => (m.operatorId === 'me' ? { ...m, rank } : m));
    setMine({ org, rank });
    setBoard([row('me', 'alice', rank, 5, 3, 1, 2), row('off', 'olly', 'OFFICER', 9, 1), row('mem', 'mia', 'MEMBER', 2, 7, 4, 1)]);
    return fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank } });
  };

  it('owner: sees promote / make owner / kick, invite and tag change with the api price; actions post the right bodies', async () => {
    const { client } = asRank('OWNER');
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org-current-tag').textContent).toBe('[RED1]');
    expect(screen.getByTestId('org').textContent).toContain('222 bits');
    const members = screen.getByTestId('org-members');
    expect(within(members).getAllByRole('button', { name: 'kick' })).toHaveLength(2); // not on yourself
    await act(async () => fireEvent.click(within(members).getByRole('button', { name: 'promote' })));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/rank', body: { operatorId: 'mem', rank: 'OFFICER' } });
    await act(async () => fireEvent.click(within(members).getByRole('button', { name: 'demote' })));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/rank', body: { operatorId: 'off', rank: 'MEMBER' } });
    await act(async () => fireEvent.click(within(members).getAllByRole('button', { name: 'kick' })[1]!));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/kick', body: { operatorId: 'mem' } });
    fireEvent.change(screen.getByPlaceholderText('operator id to invite'), { target: { value: ' op-77 ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'invite' })));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/invite', body: { operatorId: 'op-77' } });
  });

  it('owner: ownership transfer and the paid tag change are confirmed first; tag change is disabled while in flight', async () => {
    const { client } = asRank('OWNER');
    render(<OrgPanel client={client} />);
    mocks.act.mockClear();
    fireEvent.click(within(screen.getByTestId('org-members')).getAllByRole('button', { name: 'make owner' })[0]!);
    expect(mocks.act).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('org-confirm')));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/transfer', body: { operatorId: 'off' } });

    const input = screen.getByTestId('org-newtag');
    const change = screen.getByTestId('org-change-tag') as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'blu2' } });
    fireEvent.click(change);
    expect(screen.getByTestId('org-confirm-text').textContent).toContain('222 bits');
    let release!: () => void;
    mocks.act.mockImplementationOnce(() => ({ unwrap: () => new Promise((r) => (release = () => r({}))) }));
    const confirm = screen.getByTestId('org-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.act.mock.calls.filter(([a]) => (a as { path: string }).path === '/tag')).toHaveLength(1);
    expect(mocks.act).toHaveBeenLastCalledWith({ path: '/tag', body: { tag: 'BLU2' } });
    expect((screen.getByTestId('org-change-tag') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
  });

  it('owner of a one-member org disbands (after a confirmation)', async () => {
    const org = orgView({ members: [member('me', 'alice', 'OWNER')] });
    setMine({ org, rank: 'OWNER' });
    setBoard([row('me', 'alice', 'OWNER', 0)]);
    const { client } = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OWNER' } });
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org-leave').textContent).toBe('disband');
    fireEvent.click(screen.getByTestId('org-leave'));
    expect(mocks.act).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('org-confirm')));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/leave', body: {} });
  });

  it('officer: can invite and kick plain members only; no promote, transfer or tag change', () => {
    const { client } = asRank('OFFICER');
    render(<OrgPanel client={client} />);
    const members = screen.getByTestId('org-members');
    expect(within(members).getAllByRole('button', { name: 'kick' })).toHaveLength(1);
    expect(within(members).queryByRole('button', { name: /promote|demote|make owner/ })).toBeNull();
    expect(screen.getByPlaceholderText('operator id to invite')).toBeTruthy();
    expect(screen.queryByTestId('org-change-tag')).toBeNull();
    expect(screen.getByTestId('org-leave').textContent).toBe('leave');
  });

  it('plain member: no management controls at all, just leave', async () => {
    const { client } = asRank('MEMBER');
    render(<OrgPanel client={client} />);
    expect(within(screen.getByTestId('org-members')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByPlaceholderText('operator id to invite')).toBeNull();
    expect(screen.queryByTestId('org-change-tag')).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('org-leave')));
    expect(mocks.act).toHaveBeenCalledWith({ path: '/leave', body: {} });
  });

  it('a permission error from the api (rank changed meanwhile) is shown readably', async () => {
    mocks.act.mockImplementation(() => fail(403, { error: 'forbidden', message: 'requires owner' }));
    const { client } = asRank('OWNER');
    render(<OrgPanel client={client} />);
    await act(async () => fireEvent.click(within(screen.getByTestId('org-members')).getByRole('button', { name: 'promote' })));
    expect(screen.getByTestId('org-error').textContent).toContain('requires owner');
  });

  it('leaderboard rows sort by the clicked column (descending, a second click ascends)', () => {
    const { client } = asRank('OWNER');
    render(<OrgPanel client={client} />);
    const names = () => [...screen.getByTestId('org-members').querySelectorAll('tbody tr')].map((r) => r.querySelector('td')!.textContent);
    expect(names()).toEqual(['olly', 'alice', 'mia']); // captures 9, 5, 2
    fireEvent.click(screen.getByTestId('org-sort-highestSignature'));
    expect(names()).toEqual(['mia', 'alice', 'olly']);
    fireEvent.click(screen.getByTestId('org-sort-highestSignature'));
    expect(names()).toEqual(['olly', 'alice', 'mia']);
    fireEvent.click(screen.getByTestId('org-sort-ticketsDone'));
    expect(names()).toEqual(['alice', 'mia', 'olly']);
    fireEvent.click(screen.getByTestId('org-sort-name'));
    expect(names()).toEqual(['alice', 'mia', 'olly']); // name ascends first
  });

  it('member and org names render as text only', () => {
    const org = orgView({ name: '<img src=x onerror=alert(1)>', members: [member('me', '<script>x</script>', 'OWNER')] });
    setMine({ org, rank: 'OWNER' });
    setBoard([row('me', '<script>x</script>', 'OWNER', 1)]);
    const { client } = fakeClient({ org: { id: 'o1', name: org.name, tag: 'RED1', rank: 'OWNER' } });
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org').querySelector('img,script')).toBeNull();
    expect(screen.getByTestId('org').textContent).toContain('<script>x</script>');
  });

  it('falls back to the member list while the leaderboard loads, and queries the board only while in an org', () => {
    const org = orgView();
    setMine({ org, rank: 'OWNER' });
    mocks.board.data = undefined;
    const { client } = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OWNER' } });
    render(<OrgPanel client={client} />);
    expect(screen.getByTestId('org-members').textContent).toContain('mia');
    expect(mocks.boardSkip).toBe(false);
    cleanup();
    setMine();
    render(<OrgPanel client={fakeClient().client} />);
    expect(mocks.boardSkip).toBe(true);
  });

  it('refetches the membership when the live self.org changes (kick, promotion, tag change pushed by the bus)', () => {
    const org = orgView();
    setMine({ org, rank: 'OWNER' });
    const f = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OWNER' } });
    const view = render(<OrgPanel client={f.client} />);
    expect(mocks.mine.refetch).not.toHaveBeenCalled();
    f.raw.self.org = { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OFFICER' };
    view.rerender(<OrgPanel client={f.client} />);
    expect(mocks.mine.refetch).toHaveBeenCalledTimes(1);
    view.rerender(<OrgPanel client={f.client} />);
    expect(mocks.mine.refetch).toHaveBeenCalledTimes(1);
    f.raw.self.org = null;
    view.rerender(<OrgPanel client={f.client} />);
    expect(mocks.mine.refetch).toHaveBeenCalledTimes(2);
  });
});

describe('OrgPanel freshness', () => {
  it('refetches /orgs/mine on every mount, so a remount after a live membership change is not served the cached org', () => {
    setMine({ org: orgView(), rank: 'OWNER' });
    const f = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OWNER' } });
    render(<OrgPanel client={f.client} />);
    expect(mocks.mineArgs[1]).toMatchObject({ refetchOnMountOrArgChange: true });
    cleanup();
    f.raw.self.org = null; // kicked while another tab was open
    mocks.mineArgs = [];
    render(<OrgPanel client={f.client} />);
    expect(mocks.mineArgs[1]).toMatchObject({ refetchOnMountOrArgChange: true });
  });

  it('drops a pending confirmation when the live membership changes under it', () => {
    setMine({ org: orgView(), rank: 'OWNER' });
    setBoard([row('me', 'alice', 'OWNER', 1), row('off', 'olly', 'OFFICER', 1)]);
    const f = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'OWNER' } });
    const view = render(<OrgPanel client={f.client} />);
    fireEvent.click(within(screen.getByTestId('org-members')).getAllByRole('button', { name: 'make owner' })[0]!);
    expect(screen.getByTestId('org-confirm')).toBeTruthy();
    f.raw.self.org = { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'MEMBER' };
    view.rerender(<OrgPanel client={f.client} />);
    expect(screen.queryByTestId('org-confirm')).toBeNull();
  });
});

describe('ChatPanel org channel', () => {
  const orgLine = (id: string, text: string): ChatLine => ({ id, channel: 'org:o1', from: 'mem', name: 'mia', tag: 'RED1', text, at: '2026-10-04T00:00:00.000Z' });

  it('shows the org channel (with history, tagged lines) only while a member', async () => {
    const f = fakeClient({ org: { id: 'o1', name: 'Red Team', tag: 'RED1', rank: 'MEMBER' } });
    mocks.history.mockImplementation(() => ({ unwrap: () => Promise.resolve([{ ...orgLine('h1', 'older org line'), id: 'h1' }]) }));
    chatStore.push(orgLine('l1', 'hi org'));
    const view = render(<ChatPanel client={f.client} isAdmin={false} />);
    await flush();
    fireEvent.click(screen.getByTestId('channel-org:o1'));
    await flush();
    expect(mocks.history).toHaveBeenCalledWith({ channel: 'org:o1' });
    expect(screen.getByTestId('chat-lines').textContent).toContain('[RED1] mia');
    expect(screen.getByTestId('chat-lines').textContent).toContain('hi org');
    expect(screen.getByTestId('chat-lines').textContent).toContain('older org line');
    expect(screen.getByTestId('chat-input').getAttribute('placeholder')).toBe('message org:o1');
    // leaving: the channel and the selection go away, the stored lines are hidden; the cluster panel is still there
    f.raw.self.org = null;
    view.rerender(<ChatPanel client={f.client} isAdmin={false} />);
    await flush();
    expect(screen.queryByTestId('channel-org:o1')).toBeNull();
    expect(screen.getByTestId('chat-lines').textContent).not.toContain('hi org');
    expect(screen.getByTestId('cluster')).toBeTruthy();
  });
});
