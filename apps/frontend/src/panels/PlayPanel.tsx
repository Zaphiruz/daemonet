import { GATEWAY_RADIUS, getMove, getSpecies, NATURES, STAT_KEYS, TICK_HZ, type ToolId } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { run } from '../components/WorldCanvas.tsx';
import { useCaptureChallenge } from '../game/capture.ts';
import { parseAnswer, setControls, useControls } from '../game/controls.ts';

const TOOLS: ToolId[] = ['sniff', 'tap', 'mirror', 'dump'];

export function PlayPanel({ client }: { client: GameClient }) {
  const controls = useControls();
  const me = client.self;
  const manual = client.role === 'controller';
  const target = controls.targetId ? client.entities.get(controls.targetId) : undefined;
  const starters = ['pingling', 'hashling', 'glitchmite', 'nullpup'];
  const [starter, setStarter] = useState(starters[0]!);
  const [name, setName] = useState('');

  if (!me.starterClaimed) {
    return (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-neutral-300">Claim a starter to enter the network.</p>
        <input className="w-full rounded bg-neutral-800 px-2 py-1" placeholder="operator name (a-z 0-9 _ -)" value={name} onChange={(e) => setName(e.target.value)} data-testid="name-input" />
        <select className="w-full rounded bg-neutral-800 px-2 py-1" value={starter} onChange={(e) => setStarter(e.target.value)} data-testid="starter-select">
          {starters.map((s) => (
            <option key={s} value={s}>
              {getSpecies(s).name}
            </option>
          ))}
        </select>
        <button className="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600 disabled:opacity-50" disabled={!manual} onClick={() => run(client.operator.claimStarter(starter, name), 'claimStarter')} data-testid="claim">
          claim
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-sm">
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">running</h3>
        {me.running.length === 0 && <p className="text-neutral-500">nothing running — press R or use the RAM tab</p>}
        {me.running.map((id) => {
          const d = me.ram.find((r) => r.id === id)!;
          const handle = client.daemons.get(id);
          return (
            <div key={id} className={`mb-2 rounded border p-2 ${controls.actor === id ? 'border-sky-500' : 'border-neutral-800'}`}>
              <div className="flex items-center justify-between">
                <button className="font-medium" onClick={() => setControls({ actor: id })}>
                  {getSpecies(d.species).name} <span className="text-neutral-500">L{d.level}</span>
                </button>
                <span className="mono text-neutral-400">
                  {Math.round(d.hp)}/{d.maxHp} hp · {Math.floor(d.energy)} en
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {d.moves.map((m, i) => {
                  const def = getMove(m);
                  const ready = (d.cooldowns[m] ?? 0) <= client.tick && d.energy >= def.energyCost;
                  return (
                    <button
                      key={m}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-left hover:bg-neutral-700 disabled:opacity-40"
                      disabled={!manual || !ready || !target}
                      title={`${def.type} ${def.category} · power ${def.power} · ${def.energyCost} energy · ${def.cooldownMs} ms · range ${def.range}`}
                      onClick={() => target && run(handle.use(m, def.shape.kind === 'single' ? { id: target.id, x: target.x, y: target.y } : { x: target.x, y: target.y }), m)}
                    >
                      <span className="text-neutral-500">{i + 1}</span> {def.name}
                    </button>
                  );
                })}
              </div>
              <button className="mt-1 text-xs text-neutral-400 hover:text-neutral-200" disabled={!manual} onClick={() => run(client.operator.recall(id), 'recall')}>
                recall
              </button>
            </div>
          );
        })}
      </section>

      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">target</h3>
        {target?.kind === 'daemon' ? (
          <div className="rounded border border-neutral-800 p-2">
            <div>
              {getSpecies(target.species).name} <span className="text-neutral-500">L{target.level}</span>{' '}
              {target.clean && <span className="text-white">clean</span>} {target.signature > 0 && <span className="text-fuchsia-300">T{target.signature}</span>}
            </div>
            <div className="mono text-neutral-400">
              {Math.round(target.hp)}/{target.maxHp} hp · {target.taggedBy ? (target.taggedBy === client.operatorId ? 'tagged by you' : 'tagged by another operator') : 'untagged'}
              {target.hardened ? ' · hardened' : ''}
            </div>
            {target.scan && (
              <div className="mono text-xs text-sky-300" data-testid="scan">
                {target.scan.nature !== undefined && <span>nature {NATURES[target.scan.nature]?.id ?? target.scan.nature} </span>}
                {target.scan.ivs
                  ? STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${target.scan!.ivs![i]}`).join(' ')
                  : target.scan.ivBuckets && STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${['0-7', '8-15', '16-23', '24-31'][target.scan!.ivBuckets![i]!]}`).join(' ')}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <select className="rounded bg-neutral-800 px-1" value={controls.tool} onChange={(e) => setControls({ tool: e.target.value as ToolId })} data-testid="tool-select">
                {TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {t} ×{me.inventory[t] ?? 0}
                  </option>
                ))}
              </select>
              <button
                className="rounded bg-violet-700 px-2 py-0.5 hover:bg-violet-600 disabled:opacity-40"
                disabled={!manual || !!me.capture || (me.inventory[controls.tool] ?? 0) === 0}
                onClick={() => run(client.operator.capture(target.id, controls.tool), 'capture')}
                data-testid="capture"
              >
                capture (C)
              </button>
            </div>
          </div>
        ) : (
          <p className="text-neutral-500">click a wild daemon on the map</p>
        )}
      </section>

      {me.capture && <CapturePanel client={client} />}

      <GatewaySection client={client} me={me} manual={manual} />

      <section className="flex flex-wrap gap-2">
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual} onClick={() => run(client.operator.restoreAll(), 'restoreAll')}>
          restore all (at host)
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual} onClick={() => run(client.operator.stop(), 'stop')}>
          stop
        </button>
      </section>
    </div>
  );
}

/** One card per gateway of the current subnet within reach; travel resets the connection's world (a new snapshot). */
export function GatewaySection({ client, me, manual }: { client: GameClient; me: GameClient['self']; manual: boolean }) {
  // one travel at a time: the button stays disabled until the request settles (the snapshot has arrived, or it failed)
  const [inFlight, setInFlight] = useState(false);
  const travel = (gatewayId: string) => {
    setInFlight(true);
    const p = client.operator.travel(gatewayId);
    run(p, 'travel');
    void p.then(
      () => setInFlight(false),
      () => setInFlight(false),
    );
  };
  return (
    <>
      {client.world.gateways
        .filter((g) => Math.hypot(g.at.x - me.x, g.at.y - me.y) <= GATEWAY_RADIUS)
        .map((g) => (
          <section key={g.id} className="rounded border border-sky-700 p-2" data-testid={`gateway-${g.id}`}>
            <div>
              gateway to <span className="font-medium">{g.to}</span>
              {g.requires.level > 0 && <span className="text-neutral-500"> · needs a level {g.requires.level} daemon</span>}
            </div>
            <button
              className="mt-1 rounded bg-sky-700 px-2 py-0.5 hover:bg-sky-600 disabled:opacity-40"
              disabled={!manual || inFlight || me.running.length > 0 || !!me.capture}
              onClick={() => travel(g.id)}
              data-testid={`travel-${g.id}`}
            >
              {inFlight ? 'travelling…' : `travel ${me.running.length > 0 ? '(recall first)' : ''}`}
            </button>
          </section>
        ))}
    </>
  );
}

export function CapturePanel({ client }: { client: GameClient }) {
  const challenge = useCaptureChallenge();
  const manual = client.role === 'controller';
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cap = client.self.capture;
  if (!cap) return null;
  const left = Math.max(0, cap.deadlineTick - client.tick) / TICK_HZ;
  const submit = () => {
    const parsed = parseAnswer(answer);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    run(client.operator.submitCapture(cap.captureId, parsed.value), 'submitCapture');
  };
  return (
    <section className="rounded border border-violet-700 p-2" data-testid="capture-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-violet-300">capture in progress</h3>
        <span className="mono text-violet-200">{left.toFixed(1)}s</span>
      </div>
      {challenge && challenge.captureId === cap.captureId ? (
        <>
          <div className="mono mt-1 text-xs text-neutral-400">
            {challenge.kind} · {challenge.families.join(' → ')}
          </div>
          <details className="mt-1" open>
            <summary className="cursor-pointer text-xs text-neutral-400">params</summary>
            <pre className="mono max-h-32 overflow-auto rounded bg-neutral-900 p-1 text-xs">{JSON.stringify(challenge.params, null, 1)}</pre>
          </details>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-neutral-400">payload</summary>
            <pre className="mono max-h-48 overflow-auto rounded bg-neutral-900 p-1 text-xs">{JSON.stringify(challenge.payload, null, 1)}</pre>
          </details>
          <button className="mt-1 text-xs text-neutral-400 hover:text-neutral-200" onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ params: challenge.params, payload: challenge.payload }))}>
            copy challenge
          </button>
        </>
      ) : (
        <p className="text-xs text-neutral-500">waiting for the challenge…</p>
      )}
      <textarea className="mono mt-2 h-20 w-full rounded bg-neutral-900 p-1 text-xs" placeholder='{"checksum":"…"}' value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="answer" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button className="mt-1 rounded bg-violet-700 px-2 py-0.5 hover:bg-violet-600 disabled:opacity-40" disabled={!manual} onClick={submit} data-testid="submit-answer">
        submit answer
      </button>
    </section>
  );
}
