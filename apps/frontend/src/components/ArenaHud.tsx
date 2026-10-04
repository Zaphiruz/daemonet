import { getSpecies } from '@daemonet/rules';
import type { OperatorSelf } from '@daemonet/sdk';
import { arenaClock, clockText, hpPercent, resultText, type ArenaResultInfo } from '../game/arena.ts';

interface Copy {
  id: string;
  species: string;
  level: number;
  hp: number;
  maxHp: number;
  crashed: boolean;
  running: boolean;
}

function Team({ title, copies, testid }: { title: string; copies: Copy[]; testid: string }) {
  return (
    <div className="w-44 rounded bg-neutral-950/85 p-2" data-testid={testid}>
      <div className="mb-1 truncate text-xs text-neutral-300">{title}</div>
      {copies.map((d) => (
        <div key={d.id} className={`mb-0.5 ${d.crashed ? 'opacity-40' : ''}`} data-testid={`${testid}-${d.id}`}>
          <div className="mono flex justify-between text-[10px] text-neutral-400">
            <span>
              {d.running ? '▶ ' : ''}
              {getSpecies(d.species).name} L{d.level}
            </span>
            <span>{d.crashed ? 'crashed' : `${hpPercent(d)}%`}</span>
          </div>
          <div className="h-1 rounded bg-neutral-800">
            <div className={`h-1 rounded ${hpPercent(d) > 50 ? 'bg-emerald-500' : hpPercent(d) > 20 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${hpPercent(d)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Match HUD over the map (SP6 spec §7): the clock, both sides' copies, the result, a forfeit button. Names are plain text. */
export function ArenaHud({ self, tick, result, onForfeit }: { self: OperatorSelf; tick: number; result: ArenaResultInfo | null; onForfeit: (() => void) | null }) {
  const arena = self.arena;
  if (!arena) return null;
  const clock = arenaClock(arena, tick);
  const mine: Copy[] = self.ram.map((d) => ({ id: d.id, species: d.species, level: d.level, hp: d.hp, maxHp: d.maxHp, crashed: d.crashed, running: self.running.includes(d.id) }));
  const opponent = arena.opponent;
  const over = arena.phase === 'over';
  // Only this match's result: an older one (or a late one for a previous match) never words this match.
  const shown = over && result?.id === arena.id ? result : null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2" data-testid="arena-hud">
      <Team title={`you${self.name ? ` · ${self.name}` : ''}`} copies={mine} testid="arena-mine" />
      <div className="rounded bg-neutral-950/85 px-3 py-1 text-center">
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
          {arena.mode} · {clock.label}
        </div>
        {!over && (
          <div className="mono text-lg text-sky-300" data-testid="arena-clock">
            {clockText(clock.seconds)}
          </div>
        )}
        {over && (
          <div className="mono text-sm text-amber-200" data-testid="arena-result">
            {shown ? resultText(shown) : arena.result?.winner === null ? 'draw' : arena.result?.winner === self.id ? 'you won' : 'you lost'}
          </div>
        )}
        {!over && onForfeit && (
          <button className="pointer-events-auto mt-1 rounded bg-neutral-800 px-2 text-xs text-neutral-300 hover:bg-red-900" onClick={onForfeit} data-testid="arena-forfeit">
            forfeit
          </button>
        )}
      </div>
      <Team title={`${opponent.tag ? `[${opponent.tag}] ` : ''}${opponent.name ?? 'opponent'} · ${Math.round(opponent.rating)}`} copies={opponent.team} testid="arena-theirs" />
    </div>
  );
}
