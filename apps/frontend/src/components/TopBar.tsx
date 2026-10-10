import type { GameClient } from '@daemonet/sdk';
import { useIncidentsQuery, useLogoutMutation, type Me } from '../api.ts';
import { open, useConnection, type Role } from '../game/connection.ts';
import { setControls, useControls } from '../game/controls.ts';
import { phaseLabel, useLiveIncident, useSeedIncident } from '../game/incident.ts';
import { log } from '../game/log.ts';
import { taggedName } from '../game/names.ts';
import { ReportBug } from './ReportBug.tsx';

const reconnect = (role: Role) => void open(role).catch(() => {});

/** The subnet of the latest snapshot (it changes on travel). */
export function SubnetStat({ client }: { client: GameClient | null }) {
  return <span data-testid="subnet">{client?.subnet || '—'}</span>;
}

/** Species, phase and time left of the running Incident (SP4 spec §8); nothing while none is live. */
function IncidentBanner() {
  const incidents = useIncidentsQuery();
  // a page loaded mid-Incident gets no event until the phase changes: the API seeds the store
  useSeedIncident(incidents.data?.current, incidents.fulfilledTimeStamp);
  const { incident, now } = useLiveIncident();
  if (!incident) return null;
  const left = Math.max(0, Date.parse(incident.endsAt) - now);
  return (
    <span className="mono rounded bg-red-900 px-2 text-red-100" data-testid="incident-banner">
      INCIDENT · {incident.species} · {phaseLabel(incident.phase)} · {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')} · kernelspace
    </span>
  );
}

export function TopBar({ me }: { me: Me }) {
  const conn = useConnection();
  const controls = useControls();
  const [logout] = useLogoutMutation();
  const client = conn.client;
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-3 py-1.5 text-sm">
      <span className="font-semibold tracking-wide text-sky-300">daemonet</span>
      <span className="mono text-neutral-300" data-testid="operator-name">
        {taggedName(client?.self?.org?.tag, client?.self?.name ?? me.name, 'unnamed operator')}
      </span>
      <span className="mono text-neutral-500">
        <SubnetStat client={client} /> · tick <span data-testid="tick">{client?.tick ?? 0}</span> · bits {client?.self?.bits ?? me.bits}
      </span>
      <span className={`mono ${conn.status === 'online' ? 'text-emerald-400' : 'text-amber-400'}`} data-testid="status">
        {conn.status}
        {conn.kickReason ? ` (${conn.kickReason})` : ''}
      </span>
      <IncidentBanner />
      <span className="ml-auto flex items-center gap-2">
        <ReportBug />
        <label className="text-neutral-400">
          zoom
          <select className="ml-1 rounded bg-neutral-800 px-1" value={controls.zoom} onChange={(e) => setControls({ zoom: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            {[1, 2, 3, 4].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={() => reconnect('controller')} disabled={conn.role === 'controller' && conn.status === 'online'}>
          control
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={() => reconnect('spectator')} disabled={conn.role === 'spectator' && conn.status === 'online'}>
          spectate
        </button>
        <button
          className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
          onClick={async () => {
            // the connection stays as it is: closing it here would let the app reopen it before the redirect
            try {
              const r = await logout().unwrap();
              location.href = r.endSessionUrl ?? '/';
            } catch (err) {
              log.push('error', `logout failed: ${err instanceof Error ? err.message : 'try again'}`);
            }
          }}
        >
          logout
        </button>
      </span>
    </header>
  );
}
