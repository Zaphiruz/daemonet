import { STAT_KEYS } from '@daemonet/rules';
import { useCodexQuery } from '../api.ts';
import { SpriteImg } from './RamPanel.tsx';

export function ItemsPanel({ inventory }: { inventory: Record<string, number> }) {
  const entries = Object.entries(inventory).filter(([, n]) => n > 0);
  return (
    <div className="p-3 text-sm">
      {entries.length === 0 && <p className="text-neutral-500">no items</p>}
      <ul className="space-y-1">
        {entries.map(([id, n]) => (
          <li key={id} className="mono flex justify-between rounded border border-neutral-800 px-2 py-1">
            <span>{id}</span>
            <span className="text-neutral-400">×{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CodexPanel() {
  const codex = useCodexQuery();
  if (!codex.data) return <p className="p-3 text-sm text-neutral-500">loading codex…</p>;
  const { species, moves, chart } = codex.data;
  return (
    <div className="space-y-4 p-3 text-sm">
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">species</h3>
        {species.map((s) => (
          <div key={s.id} className="mb-1 flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={s.id} types={s.types} clean={false} signature={0} />
            <div>
              <div>
                <span className="font-medium">{s.name}</span> <span className="text-neutral-500">{s.types.join('/')} · {s.behaviour}{s.starter ? ' · starter' : ''}</span>
              </div>
              <div className="mono text-xs text-neutral-500">{STAT_KEYS.map((k) => `${k.slice(0, 3)} ${s.base[k]}`).join(' · ')}</div>
              <div className="mono text-xs text-neutral-500">{s.learnset.map((l) => `L${l.level} ${l.move}`).join(', ')}</div>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">moves</h3>
        <table className="mono w-full text-xs">
          <tbody>
            {moves.map((m) => (
              <tr key={m.id} className="border-b border-neutral-900">
                <td className="py-0.5">{m.name}</td>
                <td className="text-neutral-500">{m.type}</td>
                <td className="text-neutral-500">{m.category}</td>
                <td className="text-right">{m.power}</td>
                <td className="text-right text-neutral-500">{m.energyCost}en</td>
                <td className="text-right text-neutral-500">{m.cooldownMs}ms</td>
                <td className="text-right text-neutral-500">r{m.range}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">type chart (attacker → defender, SP1 types)</h3>
        <table className="mono text-xs">
          <thead>
            <tr>
              <th />
              {['packet', 'crypto', 'glitch', 'null'].map((t) => (
                <th key={t} className="px-1 text-neutral-500">{t.slice(0, 3)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {['packet', 'crypto', 'glitch', 'null'].map((a) => (
              <tr key={a}>
                <td className="pr-1 text-neutral-500">{a}</td>
                {['packet', 'crypto', 'glitch', 'null'].map((d) => (
                  <td key={d} className="px-1 text-center">{(chart as Record<string, Record<string, number>>)[a]?.[d] ?? 1}×</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
