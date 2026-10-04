import { useEffect, useState } from 'react';
import { describeApiError, useAddFilterTermMutation, useAdminEconomyQuery, useAdminReportsQuery, useDeleteFilterTermMutation, useFilterTermsQuery, useIncidentsQuery, useResolveReportMutation, useStartIncidentMutation } from '../api.ts';
import { useLiveIncident, useNow, useSeedIncident } from '../game/incident.ts';

const VIEWS = ['reports', 'filter', 'economy', 'incidents'] as const;
type View = (typeof VIEWS)[number];

/** Shows the readable form of an API failure (every admin error code goes through `describeApiError`). */
function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded border border-red-900 bg-red-950 px-2 py-1 text-xs text-red-300">
      {describeApiError(error)}
    </p>
  );
}

/** Runs a mutation and keeps its failure for display; a later success clears it. */
function useAction() {
  const [error, setError] = useState<unknown>(null);
  const act = async (call: () => { unwrap(): Promise<unknown> }): Promise<boolean> => {
    try {
      await call().unwrap();
      setError(null);
      return true;
    } catch (err) {
      setError(err);
      return false;
    }
  };
  return { error, act };
}

/** Admin tools (daemonet-admins only): the report queue, chat filter terms, and the SP3b economy view. */
export function AdminPanel() {
  const [view, setView] = useState<View>('reports');
  return (
    <div className="space-y-3 p-3 text-sm">
      <nav className="flex gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`admin-view-${v}`}>
            {v}
          </button>
        ))}
      </nav>
      {view === 'reports' && <Reports />}
      {view === 'filter' && <Filter />}
      {view === 'economy' && <Economy />}
      {view === 'incidents' && <Incidents />}
    </div>
  );
}

/** How long a start may wait for the sim's `open` event before the panel says the request was probably lost. */
const START_WAIT_MS = 30_000;

/**
 * Start an Incident now (the sim refuses while one runs; the API answers 409 then), next schedule and recent outcomes.
 * "Running" is the live Incident (events; the list only seeds it). The API answers 200 even when the bus is down, so a
 * start is shown as "requested" until the `open` event arrives, and as probably lost if none came in time.
 */
function Incidents() {
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const waiting = requestedAt !== null;
  // while a start waits for the sim, poll the list too: an admin page without a game connection gets no events
  const list = useIncidentsQuery(undefined, waiting ? { pollingInterval: 2_000 } : undefined);
  useSeedIncident(list.data?.current, list.fulfilledTimeStamp);
  const { incident } = useLiveIncident();
  const now = useNow(waiting);
  const [start, state] = useStartIncidentMutation();
  const { error, act } = useAction();
  useEffect(() => {
    if (incident && requestedAt !== null) setRequestedAt(null); // the open event arrived
  }, [incident, requestedAt]);
  const pending = !incident && requestedAt !== null && now - requestedAt < START_WAIT_MS;
  const lost = !incident && requestedAt !== null && !pending;
  return (
    <section className="space-y-1 text-xs" data-testid="admin-incidents">
      <ErrorNote error={list.error ?? error} />
      <button
        className="rounded bg-red-900 px-2 py-0.5 hover:bg-red-800 disabled:opacity-40"
        disabled={state.isLoading || incident !== null || pending}
        onClick={() =>
          void act(() => start()).then((ok) => {
            if (ok) setRequestedAt(Date.now());
            return list.refetch();
          })
        }
        data-testid="incident-start"
      >
        start an Incident now
      </button>
      {pending && (
        <p className="text-amber-300" data-testid="incident-requested">
          requested: waiting for the sim to open it…
        </p>
      )}
      {lost && (
        <p className="text-amber-300" data-testid="incident-requested">
          no Incident opened: the request was probably lost (message bus down?); try again
        </p>
      )}
      {incident && (
        <p className="text-red-300">
          running: {incident.species} until {new Date(incident.endsAt).toLocaleString()}
        </p>
      )}
      {list.data && (
        <p className="text-neutral-500">
          next scheduled: {new Date(list.data.next.at).toLocaleString()} ({list.data.next.species})
        </p>
      )}
      {list.data?.recent.map((r) => (
        <div key={r.id} className="mono flex justify-between border-b border-neutral-900 py-0.5">
          <span className="text-neutral-500">{new Date(r.openedAt).toLocaleString()}</span>
          <span>{r.species}</span>
          <span className={r.outcome === 'CLEARED' ? 'text-emerald-300' : 'text-neutral-400'}>
            {r.outcome.toLowerCase()} · {r.participants.length} operators
          </span>
        </div>
      ))}
    </section>
  );
}

function Reports() {
  const reports = useAdminReportsQuery('OPEN', { pollingInterval: 15_000 });
  const [resolve] = useResolveReportMutation();
  const { error, act } = useAction();
  const rows = reports.data ?? [];
  return (
    <section className="space-y-1" data-testid="admin-reports">
      <ErrorNote error={reports.error ?? error} />
      <p className="text-xs text-neutral-500">
        {rows.length} open ·{' '}
        <button className="underline" onClick={() => void reports.refetch()}>
          refresh
        </button>
      </p>
      {rows.map((r) => (
        <div key={r.id} className="rounded border border-neutral-800 p-2">
          <div className="text-xs">
            <span className="text-neutral-400">{r.reporterName ?? r.reporterId.slice(0, 8)}</span> reported <span className="text-neutral-200">{r.targetName ?? r.targetId.slice(0, 8)}</span> · {r.reason.toLowerCase()}
            {r.note ? ` · “${r.note}”` : ''}
          </div>
          {r.message && <div className="mono mt-1 break-words rounded bg-neutral-900 p-1 text-xs text-neutral-300">{r.message.text}</div>}
          {(r.recent?.length ?? 0) > 0 && (
            <details className="mt-1 text-[11px] text-neutral-500">
              <summary>their recent lines ({r.recent.length})</summary>
              {r.recent.map((m) => (
                <div key={m.id} className="mono break-words">
                  <span className="text-neutral-600">{m.channel}</span> {m.text}
                </div>
              ))}
            </details>
          )}
          {(r.hits?.length ?? 0) > 0 && (
            <details className="mt-1 text-[11px] text-neutral-500">
              <summary>filter hits ({r.hits.length})</summary>
              {r.hits.map((h) => (
                <div key={h.id} className="mono break-words">
                  <span className="text-amber-500">{h.term}</span> {h.text}
                </div>
              ))}
            </details>
          )}
          <div className="mt-1 flex gap-2 text-xs">
            <button className="rounded bg-neutral-800 px-2 py-0.5" onClick={() => void act(() => resolve({ id: r.id, action: 'DISMISS' }))}>
              dismiss
            </button>
            {r.messageId && (
              <button className="rounded bg-amber-900 px-2 py-0.5" onClick={() => void act(() => resolve({ id: r.id, action: 'DELETE' }))}>
                delete message
              </button>
            )}
            <button className="rounded bg-red-900 px-2 py-0.5" onClick={() => void act(() => resolve({ id: r.id, action: 'MUTE', minutes: 60 }))}>
              mute 1h
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function Filter() {
  const terms = useFilterTermsQuery();
  const [add] = useAddFilterTermMutation();
  const [remove] = useDeleteFilterTermMutation();
  const { error, act } = useAction();
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'WORD' | 'REGEX'>('WORD');
  const [action, setAction] = useState<'BLOCK' | 'MASK'>('BLOCK');
  return (
    <section className="space-y-1 text-xs" data-testid="admin-filter">
      <ErrorNote error={terms.error ?? error} />
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const p = pattern.trim();
          if (!p) return;
          void act(() => add({ pattern: p, kind, action })).then((done) => done && setPattern(''));
        }}
      >
        <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="term or regex" value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="filter-pattern" />
        <select className="rounded bg-neutral-800 px-1" value={kind} onChange={(e) => setKind(e.target.value as 'WORD' | 'REGEX')} aria-label="term kind">
          <option>WORD</option>
          <option>REGEX</option>
        </select>
        <select className="rounded bg-neutral-800 px-1" value={action} onChange={(e) => setAction(e.target.value as 'BLOCK' | 'MASK')} aria-label="term action">
          <option>BLOCK</option>
          <option>MASK</option>
        </select>
        <button className="rounded bg-sky-800 px-2">add</button>
      </form>
      <p className="text-neutral-500">the default list ships with the game; these are your additions</p>
      {terms.data?.map((t) => (
        <div key={t.id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
          <span>
            {t.pattern}{' '}
            <span className="text-neutral-500">
              {t.kind.toLowerCase()} · {t.action.toLowerCase()}
            </span>
          </span>
          <button className="text-neutral-500 hover:text-red-300" onClick={() => void act(() => remove(t.id))}>
            remove
          </button>
        </div>
      ))}
    </section>
  );
}

function Economy() {
  const eco = useAdminEconomyQuery();
  if (eco.error) return <ErrorNote error={eco.error} />;
  if (!eco.data) return <p className="text-xs text-neutral-500">loading…</p>;
  return (
    <section className="mono text-xs" data-testid="admin-economy">
      <p>
        supply {eco.data.supply} bits across {eco.data.operators} operators
      </p>
      {eco.data.days.map((d) => (
        <div key={d.day} className="flex justify-between border-b border-neutral-900 py-0.5">
          <span className="text-neutral-500">{d.day}</span>
          <span className="text-emerald-300">+{d.created}</span>
          <span className="text-red-300">-{d.destroyed}</span>
          <span className="text-neutral-400">
            {Object.entries(d.byReason)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </span>
        </div>
      ))}
    </section>
  );
}
