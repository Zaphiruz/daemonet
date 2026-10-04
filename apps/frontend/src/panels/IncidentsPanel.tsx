import { describeApiError, useIncidentsQuery, type IncidentRecord } from '../api.ts';

const pct = (share: number) => `${Math.round(share * 100)}%`;
const when = (iso: string) => new Date(iso).toLocaleString();

/** One finished (or running) Incident: outcome, and each operator's damage share and reward (names only, never ids). */
function Row({ r }: { r: IncidentRecord }) {
  return (
    <li className="space-y-0.5 rounded border border-neutral-800 px-2 py-1" data-testid="incident-row">
      <div className="mono flex justify-between gap-2">
        <span className="text-neutral-500">{when(r.openedAt)}</span>
        <span>{r.species}</span>
        <span className={r.outcome === 'CLEARED' ? 'text-emerald-300' : 'text-neutral-400'}>
          {r.outcome.toLowerCase()} · {r.participants.length} operators
        </span>
      </div>
      {r.participants.length > 0 && (
        <ul className="mono text-xs text-neutral-400">
          {r.participants.map((p, i) => (
            <li key={i} className="flex justify-between">
              <span className={p.you ? 'text-sky-300' : ''}>
                {p.name ?? 'unknown operator'}
                {p.you ? ' (you)' : ''}
              </span>
              <span>
                {pct(p.share)} · {p.reward} bits
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Incidents (SP4 spec §8): what is running, the next scheduled one and the last sixteen with who earned what. */
export function IncidentsPanel() {
  const list = useIncidentsQuery(undefined, { refetchOnMountOrArgChange: true });
  const data = list.data;
  return (
    <div className="space-y-2 p-3 text-sm" data-testid="incidents-panel">
      {list.error && (
        <p role="alert" className="rounded border border-red-900 bg-red-950 px-2 py-1 text-xs text-red-300">
          {describeApiError(list.error)}
        </p>
      )}
      {!data && !list.error && <p className="text-neutral-500">loading…</p>}
      {data?.current && (
        <p className="rounded bg-red-950 px-2 py-1 text-red-200" data-testid="incident-current">
          running now: a {data.current.species} kernel daemon in kernelspace until {when(data.current.endsAt)} (gateway in backbone, level 32 daemon, 16 operators at most)
        </p>
      )}
      {data && (
        <p className="text-neutral-400" data-testid="incident-next">
          next scheduled: {when(data.next.at)} · {data.next.species} · every {Math.round(data.next.periodMs / 3_600_000)} h, {Math.round(data.next.windowMs / 60_000)} minutes to clear it
        </p>
      )}
      {data && data.recent.length === 0 && <p className="text-neutral-500">no Incidents yet</p>}
      <ul className="space-y-1">{data?.recent.map((r) => <Row key={r.id} r={r} />)}</ul>
    </div>
  );
}
