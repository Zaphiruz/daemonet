import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { clusterStore, describeClusterError, useClusterInvites } from '../game/clusters.ts';
import { log } from '../game/log.ts';

const MAX_MEMBERS = 4;

/** Sends a cluster command; a rejection goes to the Log with a readable message. */
function send(promise: Promise<unknown>, label: string, onOk?: () => void): void {
  promise.then(
    () => onOk?.(),
    (err: unknown) => log.push('reject', `${label}: ${describeClusterError(err)}`),
  );
}

/** Cluster controls (SP4 spec §6): create / join by code, invite nearby operators, members with away flags, leave / kick. */
export function ClusterPanel({ client }: { client: GameClient }) {
  const cluster = client.self.cluster;
  const manual = client.role === 'controller';
  const [code, setCode] = useState('');
  const invites = useClusterInvites();
  const live = cluster ? [] : invites;
  const nearby = client.world.operators.all().filter((o) => o.id !== client.operatorId && !(cluster?.members.some((m) => m.id === o.id) ?? false));
  const leader = cluster?.leaderId === client.operatorId;
  const full = (cluster?.members.length ?? 0) >= MAX_MEMBERS;

  return (
    <div className="space-y-2 border-b border-neutral-800 p-2 text-xs" data-testid="cluster">
      {cluster ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">cluster</span>
            <span className="mono rounded bg-neutral-800 px-1 text-sky-300" data-testid="cluster-code">
              {cluster.code}
            </span>
            <button
              className="text-neutral-400 hover:text-white"
              onClick={() => {
                const copied = navigator.clipboard?.writeText(cluster.code);
                copied?.catch(() => log.push('error', 'could not copy the code'));
              }}
              data-testid="cluster-copy"
            >
              copy
            </button>
            <span className="text-neutral-500">
              {cluster.members.length}/{MAX_MEMBERS}
            </span>
            <button className="ml-auto text-neutral-400 hover:text-white disabled:opacity-40" disabled={!manual} onClick={() => send(client.cluster.leave(), 'clusterLeave')} data-testid="cluster-leave">
              leave
            </button>
          </div>
          <ul className="mono" data-testid="cluster-members">
            {cluster.members.map((m) => (
              <li key={m.id} className={m.away ? 'text-neutral-500' : 'text-neutral-200'}>
                {m.id === cluster.leaderId ? '★ ' : '  '}
                {m.name ?? m.id.slice(0, 8)}{' '}
                <span className="text-neutral-500">
                  {m.subnet ?? 'offline'}
                  {m.away ? ' · away' : ''}
                </span>
                {leader && m.id !== client.operatorId && (
                  <button className="ml-2 text-neutral-500 hover:text-red-300 disabled:opacity-40" disabled={!manual} onClick={() => send(client.cluster.kick(m.id), 'clusterKick')}>
                    kick
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={!manual} onClick={() => send(client.cluster.create(), 'clusterCreate')} data-testid="cluster-create">
            new cluster
          </button>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (manual && code.trim().length === 6) send(client.cluster.join(code.trim().toUpperCase()), 'clusterJoin');
              setCode('');
            }}
          >
            <input className="mono w-20 rounded bg-neutral-900 px-1 uppercase" placeholder="code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} data-testid="cluster-code-input" />
            <button className="rounded bg-neutral-800 px-2 py-0.5 disabled:opacity-40" disabled={!manual || code.trim().length !== 6} data-testid="cluster-join">
              join
            </button>
          </form>
        </div>
      )}
      {live.map((i) => (
        <div key={i.clusterId} className="flex items-center gap-2 rounded border border-sky-800 px-2 py-1">
          <span>{i.name ?? i.from.slice(0, 8)} invites you to a cluster</span>
          <button className="ml-auto rounded bg-sky-800 px-2 disabled:opacity-40" disabled={!manual} onClick={() => send(client.cluster.accept(i.clusterId), 'clusterAccept', () => clusterStore.remove(i.clusterId))}>
            accept
          </button>
        </div>
      ))}
      {(!cluster || leader) && nearby.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="cluster-invite-nearby">
          <span className="text-neutral-500">invite nearby:</span>
          {nearby.slice(0, 6).map((o) => (
            <button key={o.id} className="rounded bg-neutral-800 px-1 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual || full} onClick={() => send(client.cluster.invite(o.id), 'clusterInvite')}>
              {o.name ?? o.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
