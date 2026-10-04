import type { GameClient } from '@daemonet/sdk';
import { useEffect, useRef, useState } from 'react';
import { describeOrgError, useMeQuery, useOrgActionMutation, useOrgLeaderboardQuery, useOrgMineQuery, useRenameMutation, type OrgLeaderRow, type OrgMemberRow } from '../api.ts';
import { log } from '../game/log.ts';

/** Same rules the api enforces (`OrgName`, `OrgTag`, `OperatorName`); the api stays the authority. */
const ORG_NAME = /^[A-Za-z0-9 _-]{3,24}$/;
const ORG_TAG = /^[A-Z0-9]{4}$/;
const OPERATOR_NAME = /^[a-z0-9_-]{3,16}$/;
const MAX_MEMBERS = 64;

type SortKey = 'name' | 'rank' | 'captures' | 'highestSignature' | 'evolutions' | 'ticketsDone';
const COLUMNS: Array<{ key: SortKey; label: string; title: string }> = [
  { key: 'name', label: 'name', title: 'operator name' },
  { key: 'rank', label: 'rank', title: 'rank in the org' },
  { key: 'captures', label: 'cap', title: 'captures' },
  { key: 'highestSignature', label: 'sig', title: 'highest signature' },
  { key: 'evolutions', label: 'evo', title: 'evolutions' },
  { key: 'ticketsDone', label: 'tix', title: 'tickets done' },
];
const RANK_ORDER = { OWNER: 0, OFFICER: 1, MEMBER: 2 } as const;

/**
 * 400s the api answers when the change is already in place: a retry after the first request committed but its response
 * was lost. The panel then refetches, so it shows the committed state instead of the stale one.
 */
const ALREADY_DONE = new Set(['leave your org first', 'that is already your name', 'that is already your tag']);
function alreadyDone(err: unknown): string | null {
  const e = err as { status?: unknown; data?: { message?: unknown } } | null;
  const message = e?.data?.message;
  return e?.status === 400 && typeof message === 'string' && ALREADY_DONE.has(message) ? message : null;
}

type Row = OrgLeaderRow | (OrgMemberRow & { captures?: undefined; highestSignature?: undefined; evolutions?: undefined; ticketsDone?: undefined });

function compare(a: Row, b: Row, key: SortKey): number {
  if (key === 'name') return (a.name ?? a.operatorId).localeCompare(b.name ?? b.operatorId);
  if (key === 'rank') return RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  return (a[key] ?? 0) - (b[key] ?? 0);
}

/** A paid or destructive action waiting for the player's confirmation. */
interface Pending {
  label: string;
  text: string;
  run: () => Promise<unknown>;
  done?: () => void;
}

/** Orgs (SP4 spec §7): create, invites, members by rank, sortable leaderboard, tag change and operator rename; prices come from the api. */
export function OrgPanel({ client }: { client: GameClient }) {
  const mine = useOrgMineQuery(undefined, { refetchOnMountOrArgChange: true });
  const meQuery = useMeQuery();
  const [act] = useOrgActionMutation();
  const [rename] = useRenameMutation();
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [newTag, setNewTag] = useState('');
  const [invitee, setInvitee] = useState('');
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'captures', dir: -1 });
  const inFlight = useRef(false);
  const me = client.self;
  const live = me.org;
  const org = mine.data?.org ?? null;
  const rank = mine.data?.rank ?? null;
  const prices = mine.data?.prices ?? null;
  const board = useOrgLeaderboardQuery(org?.id ?? '', { skip: !org });

  // Membership changes the sim pushes (kicked, promoted, tag changed, joined elsewhere) refresh what the api holds.
  const liveKey = live ? `${live.id}:${live.rank}:${live.tag}:${live.name}` : '';
  const seen = useRef(liveKey);
  useEffect(() => {
    if (seen.current === liveKey) return;
    seen.current = liveKey;
    setPending(null); // a confirmation was asked under the old membership
    void mine.refetch();
  }, [liveKey, mine]);

  /** Runs one request at a time; failures become readable text in the panel and the Log. */
  const run = async (label: string, request: () => Promise<unknown>, onOk?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await request();
      onOk?.();
    } catch (err) {
      const text = describeOrgError(err);
      setError(text);
      log.push('reject', `${label}: ${text}`);
      const done = alreadyDone(err);
      if (done) {
        void mine.refetch();
        if (done === 'that is already your name') void meQuery.refetch();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const go = (label: string, path: string, body: object = {}, onOk?: () => void) => run(label, () => act({ path, body }).unwrap(), onOk);
  /** Asks first; nothing is sent (or spent) until the confirm button is pressed. */
  const ask = (text: string, request: Pending['run'], label: string, done?: () => void) => setPending({ label, text, run: request, ...(done ? { done } : {}) });
  const confirm = () => {
    const p = pending;
    if (!p || inFlight.current) return;
    setPending(null);
    void run(p.label, p.run, p.done);
  };

  const short = (price: number) => me.bits < price;
  const nameOk = ORG_NAME.test(name) && name.trim() === name && !name.includes('  ');
  const tagOk = ORG_TAG.test(tag.trim().toUpperCase());
  const newTagOk = ORG_TAG.test(newTag.trim().toUpperCase()) && newTag.trim().toUpperCase() !== org?.tag;
  const renameOk = OPERATOR_NAME.test(newName.trim());

  const rows: Row[] = [...(board.data ?? org?.members ?? [])].sort((a, b) => sort.dir * compare(a, b, sort.key) || (a.name ?? a.operatorId).localeCompare(b.name ?? b.operatorId));
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'rank' ? 1 : -1 }));
  const canKick = (m: Row) => m.operatorId !== client.operatorId && (rank === 'OWNER' ? m.rank !== 'OWNER' : rank === 'OFFICER' && m.rank === 'MEMBER');

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="org">
      {pending && (
        <div className="flex items-center gap-2 rounded border border-amber-700 px-2 py-1 text-xs" role="alertdialog" data-testid="org-confirmation">
          <span data-testid="org-confirm-text">{pending.text}</span>
          <button className="ml-auto rounded bg-amber-800 px-2 hover:bg-amber-700 disabled:opacity-40" disabled={busy} onClick={confirm} data-testid="org-confirm">
            confirm
          </button>
          <button className="text-neutral-400 hover:text-white" onClick={() => setPending(null)} data-testid="org-cancel">
            cancel
          </button>
        </div>
      )}
      {error && (
        <p className="rounded border border-red-900 px-2 py-1 text-xs text-red-300" role="alert" data-testid="org-error">
          {error}
        </p>
      )}

      {!org && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">
            create an org · {prices ? `${prices.create} bits` : '…'} (you have {me.bits})
          </h3>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!prices || busy || !nameOk || !tagOk || short(prices.create)) return;
              const body = { name, tag: tag.trim().toUpperCase() };
              ask(`Create [${body.tag}] ${body.name} for ${prices.create} bits?`, () => act({ path: '', body }).unwrap(), 'create', () => {
                setName('');
                setTag('');
              });
            }}
          >
            <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="name (3–24)" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} data-testid="org-name" />
            <input className="mono w-16 rounded bg-neutral-900 px-2 py-1 uppercase" placeholder="TAG" maxLength={4} value={tag} onChange={(e) => setTag(e.target.value)} data-testid="org-tag" />
            <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={busy || !prices || !nameOk || !tagOk || short(prices.create)} data-testid="org-create">
              create
            </button>
          </form>
          {prices && short(prices.create) && <p className="text-xs text-neutral-500">need {prices.create} bits (you have {me.bits})</p>}
          {mine.data?.invites.map((i) => (
            <div key={i.orgId} className="flex items-center gap-2 rounded border border-sky-800 px-2 py-1 text-xs">
              <span>
                invited to [{i.tag}] {i.name}
              </span>
              <button className="ml-auto rounded bg-sky-800 px-2 disabled:opacity-40" disabled={busy} onClick={() => void go('accept', `/${encodeURIComponent(i.orgId)}/accept`)}>
                accept
              </button>
              <button className="text-neutral-500 disabled:opacity-40" disabled={busy} onClick={() => void go('decline', `/${encodeURIComponent(i.orgId)}/decline`)}>
                decline
              </button>
            </div>
          ))}
        </section>
      )}

      {org && (
        <section className="space-y-2">
          <h3 className="text-base">
            <span className="mono text-sky-300" data-testid="org-current-tag">
              [{org.tag}]
            </span>{' '}
            {org.name}{' '}
            <span className="text-xs text-neutral-500">
              {org.members.length}/{MAX_MEMBERS} · you are {rank?.toLowerCase()}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500" data-testid="org-sort">
            sort:
            {COLUMNS.map((c) => (
              <button key={c.key} className={`rounded px-1 ${sort.key === c.key ? 'bg-neutral-800 text-sky-300' : 'hover:text-neutral-200'}`} title={c.title} onClick={() => sortBy(c.key)} data-testid={`org-sort-${c.key}`}>
                {c.label}
                {sort.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>
          <table className="mono w-full text-xs" data-testid="org-members">
            <tbody>
              {rows.map((m) => (
                <tr key={m.operatorId} className="border-b border-neutral-900">
                  <td className="py-0.5">{m.name ?? m.operatorId.slice(0, 8)}</td>
                  <td className="text-neutral-500">{m.rank.toLowerCase()}</td>
                  <td className="text-right" title="captures">
                    {m.captures ?? '–'} cap
                  </td>
                  <td className="text-right" title="highest signature">
                    {m.highestSignature === undefined ? '–' : `T${m.highestSignature}`}
                  </td>
                  <td className="text-right" title="evolutions">
                    {m.evolutions ?? '–'} evo
                  </td>
                  <td className="text-right" title="tickets done">
                    {m.ticketsDone ?? '–'} tix
                  </td>
                  <td className="text-right">
                    {rank === 'OWNER' && m.rank !== 'OWNER' && (
                      <>
                        <button
                          className="text-neutral-500 hover:text-white disabled:opacity-40"
                          disabled={busy}
                          onClick={() => void go('rank', '/rank', { operatorId: m.operatorId, rank: m.rank === 'OFFICER' ? 'MEMBER' : 'OFFICER' })}
                        >
                          {m.rank === 'OFFICER' ? 'demote' : 'promote'}
                        </button>{' '}
                        <button
                          className="text-neutral-500 hover:text-white disabled:opacity-40"
                          disabled={busy}
                          onClick={() => ask(`Make ${m.name ?? m.operatorId.slice(0, 8)} the owner? You become an officer.`, () => act({ path: '/transfer', body: { operatorId: m.operatorId } }).unwrap(), 'transfer')}
                        >
                          make owner
                        </button>{' '}
                      </>
                    )}
                    {canKick(m) && (
                      <button className="text-neutral-500 hover:text-red-300 disabled:opacity-40" disabled={busy} onClick={() => void go('kick', '/kick', { operatorId: m.operatorId })}>
                        kick
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(rank === 'OWNER' || rank === 'OFFICER') && (
            <form
              className="flex gap-1 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                const id = invitee.trim();
                if (id && !busy) void go('invite', '/invite', { operatorId: id }, () => setInvitee(''));
              }}
            >
              <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="operator id to invite" value={invitee} onChange={(e) => setInvitee(e.target.value)} />
              <button className="rounded bg-neutral-800 px-2 disabled:opacity-40" disabled={busy || !invitee.trim()}>
                invite
              </button>
            </form>
          )}
          {rank === 'OWNER' && (
            <form
              className="flex gap-1 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                if (!prices || busy || !newTagOk || short(prices.tag)) return;
                const body = { tag: newTag.trim().toUpperCase() };
                ask(`Change the tag to [${body.tag}] for ${prices.tag} bits?`, () => act({ path: '/tag', body }).unwrap(), 'tag', () => setNewTag(''));
              }}
            >
              <input className="mono w-16 rounded bg-neutral-900 px-2 py-1 uppercase" placeholder="TAG" maxLength={4} value={newTag} onChange={(e) => setNewTag(e.target.value)} data-testid="org-newtag" />
              <button className="rounded bg-neutral-800 px-2 disabled:opacity-40" disabled={busy || !prices || !newTagOk || short(prices.tag)} data-testid="org-change-tag">
                change tag · {prices ? `${prices.tag} bits` : '…'}
              </button>
              {prices && short(prices.tag) && (
                <span className="self-center text-neutral-500">
                  need {prices.tag} bits (you have {me.bits})
                </span>
              )}
            </form>
          )}
          {rank === 'OWNER' && org.members.length === 1 ? (
            <button className="text-xs text-neutral-400 hover:text-red-300 disabled:opacity-40" disabled={busy} onClick={() => ask(`Disband [${org.tag}] ${org.name}? This cannot be undone.`, () => act({ path: '/leave', body: {} }).unwrap(), 'disband')} data-testid="org-leave">
              disband
            </button>
          ) : (
            <button className="text-xs text-neutral-400 hover:text-red-300 disabled:opacity-40" disabled={busy} onClick={() => void go('leave', '/leave')} data-testid="org-leave">
              leave
            </button>
          )}
        </section>
      )}

      <section className="space-y-1 border-t border-neutral-800 pt-2 text-xs">
        <h3 className="uppercase tracking-wide text-neutral-500">rename operator · {prices ? `${prices.rename} bits` : '…'}</h3>
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!prices || busy || !renameOk || short(prices.rename)) return;
            const next = newName.trim();
            ask(`Rename yourself to ${next} for ${prices.rename} bits?`, () => rename({ name: next }).unwrap(), 'rename', () => setNewName(''));
          }}
        >
          <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="new name (a-z 0-9 _ -)" maxLength={16} value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="org-rename-input" />
          <button className="rounded bg-neutral-800 px-2 disabled:opacity-40" disabled={busy || !prices || !renameOk || short(prices.rename)} data-testid="org-rename">
            rename
          </button>
        </form>
        {prices && short(prices.rename) && (
          <p className="text-neutral-500">
            need {prices.rename} bits (you have {me.bits})
          </p>
        )}
      </section>
    </div>
  );
}
