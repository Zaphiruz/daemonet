import { RAM_SLOTS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useDiskQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { nearHost, SpriteImg } from './RamPanel.tsx';

export function DiskPanel({ client }: { client: GameClient }) {
  const disk = useDiskQuery();
  const me = client.self;
  const atHost = nearHost(client.subnet, me);
  const manual = client.role === 'controller';
  const rows = disk.data ?? [];
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        Disk {rows.length}/{me.diskCapacity} · <button className="underline" onClick={() => disk.refetch()}>refresh</button>
      </p>
      {rows.length === 0 && <p className="text-neutral-500">nothing on Disk</p>}
      {rows.map((d) => {
        const sp = getSpecies(d.species);
        return (
          <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
            <div className="flex-1">
              <div>
                <span className="font-medium">{sp.name}</span> <span className="text-neutral-500">L{d.level} · slot {d.slot}</span>
                {d.clean && <span className="ml-1 text-white">clean</span>}
                {d.signature > 0 && <span className="ml-1 text-fuchsia-300">T{d.signature}</span>}
                {d.patched && <span className="ml-1 text-amber-300">patched</span>}
                {d.lockedBy && <span className="ml-1 text-sky-300">on the Exchange</span>}
                {d.heldItem && <span className="mono ml-1 text-xs text-neutral-400">holds {d.heldItem}</span>}
              </div>
              <div className="mono text-xs text-neutral-500">
                captured {new Date(d.log.capturedAt).toLocaleString()} in {d.log.subnet} with {d.log.tool}
              </div>
              <button
                className="mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40"
                disabled={!manual || !atHost || me.ram.length >= RAM_SLOTS || d.lockedBy !== null}
                title={d.lockedBy ? 'locked on the Exchange: cancel the order first' : undefined}
                onClick={() => run(client.operator.load(d.id).then(() => disk.refetch()), 'load')}
              >
                load into RAM
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
