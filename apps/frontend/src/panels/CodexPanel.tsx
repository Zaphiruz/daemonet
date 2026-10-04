import { STAT_KEYS } from '@daemonet/rules';
import { useState } from 'react';
import { useCodexQuery, type Codex } from '../api.ts';
import { describeBranch } from '../game/requirements.ts';
import type { CodexBestiaryRow } from '../types.ts';
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

const VIEWS = ['trees', 'species', 'moves', 'chart', 'traits', 'items', 'challenges'] as const;
type View = (typeof VIEWS)[number];

/** One evolution tree node: the form, its branch text, and a mark once anyone has evolved into it. */
function TreeNode({ row, rows, codex }: { row: CodexBestiaryRow; rows: CodexBestiaryRow[]; codex: Codex }) {
  const children = rows.filter((r) => r.evolvesFrom === row.id);
  const found = codex.discoveries.find((d) => d.formId === row.id);
  const discovered = row.evolvesFrom === null || found !== undefined;
  return (
    <li>
      <div className={`flex items-center gap-1 ${discovered ? '' : 'text-neutral-500'}`} data-testid={`tree-${row.id}`}>
        <SpriteImg species={row.id} types={row.types} clean={false} signature={0} size={16} />
        <span className={discovered ? 'font-medium' : ''}>{row.name}</span>
        {row.evolvesFrom !== null && <span className="mono text-xs text-neutral-500">{describeBranch(row.evolvesAt ?? 0, row.requirement, row.hidden)}</span>}
        {found && (
          <span className="text-emerald-400" title={`first evolved by ${found.operatorName ?? 'an operator'} on ${new Date(found.discoveredAt).toLocaleDateString()}`}>
            ✓
          </span>
        )}
        {row.capstone && <span className="text-fuchsia-300">capstone</span>}
      </div>
      {children.length > 0 && (
        <ul className="ml-4 border-l border-neutral-800 pl-2">
          {children.map((c) => (
            <TreeNode key={c.id} row={c} rows={rows} codex={codex} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CodexPanel() {
  const codex = useCodexQuery(undefined, { refetchOnMountOrArgChange: true });
  const [view, setView] = useState<View>('trees');
  if (!codex.data) return <p className="p-3 text-sm text-neutral-500">loading codex…</p>;
  const data = codex.data;
  const { species, moves, chart, types, traits, items, bestiary, challenges } = data;
  const lines = [...new Set(bestiary.map((r) => r.line))].sort((a, b) => a - b);
  return (
    <div className="space-y-3 p-3 text-sm">
      <nav className="flex flex-wrap gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`codex-${v}`}>
            {v}
          </button>
        ))}
        <button className="ml-auto text-neutral-500 underline" onClick={() => codex.refetch()}>
          refresh
        </button>
      </nav>

      {view === 'trees' && (
        <section className="space-y-2">
          <p className="text-xs text-neutral-500">
            {data.discovered.length} of {bestiary.filter((r) => r.evolvesFrom !== null).length} evolutions discovered · hidden requirements show as ??? until someone meets them
          </p>
          {lines.map((line) => {
            const rows = bestiary.filter((r) => r.line === line);
            const root = rows.find((r) => r.evolvesFrom === null)!;
            return (
              <ul key={line} className="rounded border border-neutral-800 p-2" data-testid={`line-${line}`}>
                <TreeNode row={root} rows={rows} codex={data} />
              </ul>
            );
          })}
        </section>
      )}

      {view === 'species' && (
        <section>
          {species.map((s) => (
            <div key={s.id} className="mb-1 flex gap-2 rounded border border-neutral-800 p-2">
              <SpriteImg species={s.id} types={s.types} clean={false} signature={0} />
              <div>
                <div>
                  <span className="font-medium">{s.name}</span>{' '}
                  <span className="text-neutral-500">
                    {s.types.join('/')} · {s.role} · {s.behaviour}
                    {s.starter ? ' · starter' : ''} · traits {s.traits.join(' / ')}
                  </span>
                </div>
                <div className="mono text-xs text-neutral-500">{STAT_KEYS.map((k) => `${k.slice(0, 3)} ${s.base[k]}`).join(' · ')}</div>
                <div className="mono text-xs text-neutral-500">{s.learnset.map((l) => `L${l.level} ${l.move}`).join(', ')}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      {view === 'moves' && (
        <section>
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
                  <td className="text-neutral-500">{m.status ? `${m.status.id} ${Math.round(m.status.chance * 100)}%` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'chart' && (
        <section>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">type chart (attacker ↓ · defender →)</h3>
          <table className="mono text-[10px]" data-testid="type-chart">
            <thead>
              <tr>
                <th />
                {types.map((t) => (
                  <th key={t} className="px-0.5 text-neutral-500">{t.slice(0, 3)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {types.map((a) => (
                <tr key={a}>
                  <td className="pr-1 text-neutral-500">{a}</td>
                  {types.map((d) => {
                    const m = chart[a]?.[d] ?? 1;
                    const tone = m === 0 ? 'text-neutral-600' : m > 1 ? 'text-emerald-300' : m < 1 ? 'text-red-300' : 'text-neutral-500';
                    return (
                      <td key={d} className={`px-0.5 text-center ${tone}`}>{m}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'traits' && (
        <section className="space-y-1">
          {traits.map((t) => (
            <div key={t.id} className="rounded border border-neutral-800 p-2">
              <span className="font-medium">{t.name}</span> <span className="mono text-xs text-neutral-500">{t.id}</span>
              <div className="text-xs text-neutral-400">{t.description}</div>
            </div>
          ))}
        </section>
      )}

      {view === 'items' && (
        <section className="space-y-1">
          {items.map((i) => (
            <div key={i.id} className="flex justify-between rounded border border-neutral-800 px-2 py-1">
              <span>
                {i.name} <span className="mono text-xs text-neutral-500">{i.id}</span>
              </span>
              <span className="text-xs text-neutral-400">
                {i.kind}
                {i.kind === 'held' ? ` · ${i.effect} ×${i.multiplier}` : ''}
                {i.kind === 'evolution' ? ` · ${i.type}` : ''}
                {i.kind === 'tool' ? ` · range ${i.range} · ${i.deadlineMs} ms` : ''}
              </span>
            </div>
          ))}
        </section>
      )}

      {view === 'challenges' && (
        <section className="space-y-2">
          <p className="text-xs text-neutral-500">what a capture challenge of each type asks of you</p>
          {challenges.map((c) => (
            <div key={c.type} className="rounded border border-neutral-800 p-2" data-testid={`challenge-${c.type}`}>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-sky-300">{c.type}</h3>
              <div className="mono whitespace-pre-wrap text-xs text-neutral-300" data-testid={`challenge-${c.type}-rules`}>
                {c.rules}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
