import { useLogoutMutation, type Me } from '../api.ts';
import { close, open, useConnection, type Role } from '../game/connection.ts';
import { setControls, useControls } from '../game/controls.ts';

const reconnect = (role: Role) => void open(role).catch(() => {});

export function TopBar({ me }: { me: Me }) {
  const conn = useConnection();
  const controls = useControls();
  const [logout] = useLogoutMutation();
  const client = conn.client;
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-3 py-1.5 text-sm">
      <span className="font-semibold tracking-wide text-sky-300">daemonet</span>
      <span className="mono text-neutral-300" data-testid="operator-name">
        {client?.self?.name ?? me.name ?? 'unnamed operator'}
      </span>
      <span className="mono text-neutral-500">
        tick <span data-testid="tick">{client?.tick ?? 0}</span> · bits {client?.self?.bits ?? me.bits}
      </span>
      <span className={`mono ${conn.status === 'online' ? 'text-emerald-400' : 'text-amber-400'}`} data-testid="status">
        {conn.status}
        {conn.kickReason ? ` (${conn.kickReason})` : ''}
      </span>
      <span className="ml-auto flex items-center gap-2">
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
            close();
            const r = await logout().unwrap();
            location.href = r.endSessionUrl ?? '/';
          }}
        >
          logout
        </button>
      </span>
    </header>
  );
}
