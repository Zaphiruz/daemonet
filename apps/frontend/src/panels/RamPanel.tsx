import { STAT_KEYS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useDiskQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { setControls } from '../game/controls.ts';
import { spriteCanvas } from '../render/draw.ts';
import { useEffect, useRef } from 'react';

export function SpriteImg({ species, types, clean, signature, size = 32 }: { species: string; types: readonly string[]; clean: boolean; signature: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const typeKey = types.join('/');
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(spriteCanvas(species, typeKey.split('/'), clean, signature), 0, 0, size, size);
  }, [species, typeKey, clean, signature, size]);
  return <canvas ref={ref} width={size} height={size} className="shrink-0" />;
}

export function RamPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = Math.hypot(me.x - 16.5, me.y - 16.5) <= 2;
  const disk = useDiskQuery();
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        RAM {me.ram.length}/8 · running {me.running.length}/2 · {atHost ? 'at the host: store/load enabled' : 'store/load only at the host'}
      </p>
      {me.ram
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((d) => {
          const sp = getSpecies(d.species);
          const running = me.running.includes(d.id);
          return (
            <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2" data-testid={`ram-${d.slot}`}>
              <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{sp.name}</span>
                  <span className="text-neutral-500">L{d.level}</span>
                  {d.clean && <span className="text-white">clean</span>}
                  {d.signature > 0 && <span className="text-fuchsia-300">T{d.signature}</span>}
                  {d.crashed && <span className="text-red-400">crashed</span>}
                  {running && <span className="text-emerald-400">running</span>}
                </div>
                <div className="mono text-xs text-neutral-400">
                  {Math.round(d.hp)}/{d.maxHp} hp · {Math.floor(d.energy)} en · xp {d.xp}
                </div>
                <div className="mono text-xs text-neutral-500">
                  IV {STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${d.ivs[i]}`).join(' ')}
                </div>
                <div className="mono text-xs text-neutral-500">moves {d.moves.join(', ')}</div>
                <div className="mt-1 flex gap-2 text-xs">
                  {running ? (
                    <button className="text-neutral-300 hover:text-white" disabled={!manual} onClick={() => run(client.operator.recall(d.id), 'recall')}>
                      recall
                    </button>
                  ) : (
                    <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed} onClick={() => run(client.operator.run(d.id), 'run')} data-testid={`run-${d.slot}`}>
                      run
                    </button>
                  )}
                  <button className="text-neutral-300 hover:text-white" onClick={() => setControls({ actor: d.id })}>
                    select
                  </button>
                  <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed || (me.inventory.restore ?? 0) === 0} onClick={() => run(client.operator.useRestore(d.id), 'restore')}>
                    restore ×{me.inventory.restore ?? 0}
                  </button>
                  <button
                    className="text-neutral-300 hover:text-white disabled:opacity-40"
                    disabled={!manual || running || !atHost}
                    onClick={() => run(client.operator.store(d.id).then(() => disk.refetch()), 'store')}
                  >
                    store
                  </button>
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
