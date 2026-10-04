import { isHoldable } from '@daemonet/rules';
import type { RamDaemon } from '@daemonet/shared';
import { describeBranch, itemName } from '../game/requirements.ts';

/** The RAM card's evolution list: every branch with its requirements; `evolve` enabled once met. */
export function EvolveSection({ daemon, disabled, onEvolve }: { daemon: RamDaemon; disabled: boolean; onEvolve: (formId: string) => void }) {
  if (daemon.evolutions.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs" data-testid={`evolve-${daemon.slot}`}>
      {daemon.evolutions.map((o) => (
        <div key={o.form} className="flex items-center gap-2">
          <span className={o.met ? 'text-emerald-300' : 'text-neutral-400'}>{o.name}</span>
          <span className="mono text-neutral-500">{describeBranch(o.level, o.requirement, o.hidden)}</span>
          <button
            className="ml-auto rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
            disabled={disabled || !o.met}
            onClick={() => onEvolve(o.form)}
            data-testid={`evolve-${daemon.slot}-${o.form}`}
          >
            evolve
          </button>
        </div>
      ))}
    </div>
  );
}

/** The held-item slot: what is held (with unhold) and a picker over the holdable items in the inventory. */
export function HeldSlot({
  daemon,
  inventory,
  disabled,
  onHold,
  onUnhold,
}: {
  daemon: RamDaemon;
  inventory: Record<string, number>;
  disabled: boolean;
  onHold: (itemId: string) => void;
  onUnhold: () => void;
}) {
  const holdable = Object.entries(inventory).filter(([id, n]) => n > 0 && isHoldable(id));
  return (
    <div className="mono mt-1 flex items-center gap-2 text-xs text-neutral-400" data-testid={`held-${daemon.slot}`}>
      <span>held: {daemon.heldItem ? itemName(daemon.heldItem) : '—'}</span>
      {daemon.heldItem && (
        <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={disabled} onClick={onUnhold}>
          unhold
        </button>
      )}
      {holdable.length > 0 && (
        <select
          className="rounded bg-neutral-800 px-1"
          value=""
          disabled={disabled}
          onChange={(e) => e.target.value && onHold(e.target.value)}
          data-testid={`hold-${daemon.slot}`}
        >
          <option value="">hold…</option>
          {holdable.map(([id, n]) => (
            <option key={id} value={id}>
              {itemName(id)} ×{n}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
