import { BUY_MAX_QTY, CRAFT_MAX_QTY, DISK_MAX, DISK_STEP, OPEN_TICKETS_MAX, RECIPES, SHOP, TICKETS_PER_DAY, diskExpansionPrice, getItem, isTradable, type TypeId } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useRef, useState } from 'react';
import { api, useBoardQuery, useLedgerQuery, useTicketHistoryQuery, useVaultQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { craftCheck, formatBits, fragmentTypes } from '../game/economy.ts';
import { store } from '../store.ts';
import { nearHost } from './RamPanel.tsx';

const VIEWS = ['tickets', 'shop', 'craft', 'vault', 'ledger'] as const;
type View = (typeof VIEWS)[number];

/** Everything that happens at a host node: the NPC shop, Disk expansion, crafting, the Exchange vault, tickets and the bits ledger. */
export function HostPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = nearHost(client.subnet, me);
  const [view, setView] = useState<View>('tickets');
  const [qty, setQty] = useState(1);
  const [using, setUsing] = useState<TypeId | ''>('');
  // one buy/craft at a time: the buttons stay disabled until the request settles (the ref also covers the gap before the re-render)
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const ledger = useLedgerQuery(undefined, { skip: view !== 'ledger', refetchOnMountOrArgChange: true });
  const vault = useVaultQuery(undefined, { skip: view !== 'vault', refetchOnMountOrArgChange: true });
  const board = useBoardQuery(client.subnet, { skip: view !== 'tickets', refetchOnMountOrArgChange: true });
  const history = useTicketHistoryQuery(undefined, { skip: view !== 'tickets', refetchOnMountOrArgChange: true });
  const diskPrice = diskExpansionPrice(me.diskCapacity);
  const can = manual && atHost && !inFlight;
  // a chosen type that is no longer held (spent in a craft, say) counts as unchosen
  const held = fragmentTypes(me.inventory);
  const usingType = using && held.includes(using) ? using : undefined;
  const why = (...reasons: Array<[boolean, string]>) => (!manual ? 'spectators cannot trade' : !atHost ? 'walk to the host node first' : inFlight ? 'waiting for the previous request' : reasons.find(([bad]) => bad)?.[1]);

  const submit = (request: () => Promise<unknown>, label: string) => {
    if (busy.current) return;
    busy.current = true;
    setInFlight(true);
    setError(null);
    const p = request();
    run(p, label);
    const done = () => {
      busy.current = false;
      setInFlight(false);
    };
    const fail = (err: unknown) => {
      setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      done();
    };
    void p.then(done, fail);
  };

  // the vault list refreshes once the sim answers, ok or not (a refused or unknown move may still have changed the
  // vault): invalidating the tag refetches the mounted query (and drops a stale cache)
  const move = (dir: 'deposit' | 'withdraw', item: string) => submit(() => client.operator[dir](item, qty).finally(() => store.dispatch(api.util.invalidateTags(['Vault']))), dir);

  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-neutral-500" data-testid="host-status">
        {atHost ? 'at the host' : 'walk to the host node to trade'} · {me.bits} bits ({formatBits(me.bits)}) · Disk {me.diskCapacity}
      </p>
      <nav className="flex gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`host-${v}`}>
            {v}
          </button>
        ))}
        <label className="ml-auto text-neutral-500">
          qty
          <input className="ml-1 w-12 rounded bg-neutral-800 px-1" type="number" min={1} max={BUY_MAX_QTY} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(BUY_MAX_QTY, Number(e.target.value) || 1)))} data-testid="qty" />
        </label>
      </nav>

      {error && (
        <p className="text-xs text-red-400" data-testid="host-error">
          {error}
        </p>
      )}

      {view === 'tickets' && (
        <section className="space-y-2" data-testid="tickets">
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
              open ({me.tickets.length}/{OPEN_TICKETS_MAX}) · accepted today {me.ticketsToday}/{TICKETS_PER_DAY}
            </h3>
            {me.tickets.length === 0 && <p className="text-xs text-neutral-500">no open tickets</p>}
            {me.tickets.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1" data-testid={`ticket-${t.id}`}>
                <span>
                  {t.title}{' '}
                  <span className="mono text-xs text-neutral-500">
                    {t.progress}/{t.target} · {t.reward} bits
                  </span>
                </span>
                <button
                  className="text-xs text-neutral-400 hover:text-white disabled:opacity-40"
                  disabled={!manual || inFlight}
                  title={manual ? undefined : 'spectators cannot abandon tickets'}
                  onClick={() => submit(() => client.operator.abandonTicket(t.id).then(() => Promise.all([board.refetch(), history.refetch()])), 'abandonTicket')}
                >
                  abandon
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
              board · {client.subnet} · {board.data?.day ?? '…'}{' '}
              <button className="underline" onClick={() => void board.refetch()}>
                refresh
              </button>
            </h3>
            {board.data?.tickets.map((t) => {
              const full = me.tickets.length >= OPEN_TICKETS_MAX || me.ticketsToday >= TICKETS_PER_DAY;
              return (
                <div key={t.index} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1" data-testid={`board-${t.index}`}>
                  <span className={t.status ? 'text-neutral-500' : ''}>
                    {t.title}{' '}
                    <span className="mono text-xs text-neutral-500">
                      {t.reward} bits{t.status ? ` · ${t.status.toLowerCase()}` : ''}
                    </span>
                  </span>
                  <button
                    className="rounded bg-amber-800 px-2 py-0.5 hover:bg-amber-700 disabled:opacity-40"
                    disabled={!can || t.status !== null || full}
                    title={why([t.status !== null, 'already accepted today'], [me.tickets.length >= OPEN_TICKETS_MAX, `at most ${OPEN_TICKETS_MAX} open tickets`], [me.ticketsToday >= TICKETS_PER_DAY, `${TICKETS_PER_DAY} tickets a day`])}
                    onClick={() => submit(() => client.operator.acceptTicket(t.index, client.subnet, board.data!.day).then(() => Promise.all([board.refetch(), history.refetch()])), 'acceptTicket')}
                    data-testid={`accept-${t.index}`}
                  >
                    accept
                  </button>
                </div>
              );
            })}
          </div>
          {history.data && history.data.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-neutral-500">history ({history.data.length})</summary>
              <div className="mono text-xs">
                {history.data.map((h) => (
                  <div key={h.id} className="flex justify-between border-b border-neutral-900 py-0.5">
                    <span className="text-neutral-500">{h.day}</span>
                    <span>
                      {h.subnet} #{h.index} {h.kind}
                    </span>
                    <span className={h.status === 'DONE' ? 'text-emerald-300' : 'text-neutral-400'}>
                      {h.status.toLowerCase()} {h.progress}/{h.target}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {view === 'shop' && (
        <section className="space-y-1" data-testid="shop">
          {Object.entries(SHOP).map(([id, price]) => (
            <div key={id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
              <span>
                {getItem(id).name} <span className="mono text-xs text-neutral-500">×{me.inventory[id] ?? 0}</span>
              </span>
              <button
                className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
                disabled={!can || me.bits < price * qty}
                title={why([me.bits < price * qty, 'not enough bits'])}
                onClick={() => submit(() => client.operator.buy(id, qty), 'buy')}
                data-testid={`buy-${id}`}
              >
                buy {qty > 1 ? `×${qty} ` : ''}for {price * qty}
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
            <span>
              Disk expansion <span className="mono text-xs text-neutral-500">+{DISK_STEP} slots (max {DISK_MAX})</span>
            </span>
            <button
              className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
              disabled={!can || diskPrice === null || me.bits < diskPrice}
              title={why([diskPrice === null, 'Disk is at its maximum'], [diskPrice !== null && me.bits < diskPrice, 'not enough bits'])}
              onClick={() => submit(() => client.operator.buy('diskExpansion', 1), 'buy')}
              data-testid="buy-diskExpansion"
            >
              {diskPrice === null ? 'maxed' : `buy for ${diskPrice}`}
            </button>
          </div>
        </section>
      )}

      {view === 'craft' && (
        <section className="space-y-1" data-testid="craft">
          <label className="text-xs text-neutral-500">
            fragment type for “any” recipes
            <select className="ml-1 rounded bg-neutral-800 px-1" value={usingType ?? ''} onChange={(e) => setUsing(e.target.value as TypeId | '')} data-testid="using">
              <option value="">—</option>
              {held.map((t) => (
                <option key={t} value={t}>
                  {t} ×{me.inventory[`frag:${t}`]}
                </option>
              ))}
            </select>
          </label>
          {RECIPES.map((r) => {
            const check = craftCheck(r, qty, me.inventory, me.bits, usingType);
            return (
              <div key={r.id} className="rounded border border-neutral-800 px-2 py-1" data-testid={`recipe-${r.id}`}>
                <div className="flex items-center justify-between">
                  <span>
                    {getItem(r.output.item).name}
                    {r.output.qty > 1 ? ` ×${r.output.qty}` : ''} <span className="mono text-xs text-neutral-500">×{me.inventory[r.output.item] ?? 0}</span>
                  </span>
                  <button
                    className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
                    disabled={!can || !check.ok || qty > CRAFT_MAX_QTY}
                    title={why([qty > CRAFT_MAX_QTY, `craft at most ${CRAFT_MAX_QTY} at a time`], [check.needsType, 'pick a fragment type'], [me.bits < check.bits, 'not enough bits'], [check.needs.some((n) => n.have < n.need), 'missing fragments'])}
                    onClick={() => submit(() => client.operator.craft(r.id, qty, usingType), 'craft')}
                    data-testid={`craft-${r.id}`}
                  >
                    craft for {check.bits}
                  </button>
                </div>
                <div className="mono text-xs text-neutral-500">
                  {check.needsType && 'pick a fragment type · '}
                  {check.needs.map((n) => (
                    <span key={n.item} className={n.have >= n.need ? 'text-neutral-400' : 'text-red-400'}>
                      {n.item.slice(5)} {n.have}/{n.need}{' '}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {view === 'vault' && (
        <section className="space-y-2" data-testid="vault">
          <p className="text-xs text-neutral-500">The Exchange trades what is in your vault. Deposits and withdrawals happen here at the host ({qty} at a time).</p>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">inventory</h3>
            {Object.entries(me.inventory)
              .filter(([id, n]) => n > 0 && isTradable(id))
              .map(([id, n]) => (
                <div key={id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-0.5 text-xs">
                  <span>
                    {id} ×{n}
                  </span>
                  <button
                    className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40"
                    disabled={!can || n < qty}
                    title={why([n < qty, 'not enough in your inventory'])}
                    onClick={() => move('deposit', id)}
                    data-testid={`deposit-${id}`}
                  >
                    deposit
                  </button>
                </div>
              ))}
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">vault</h3>
            {Object.keys(vault.data ?? {}).length === 0 && <p className="text-xs text-neutral-500">empty</p>}
            {Object.entries(vault.data ?? {}).map(([id, n]) => (
              <div key={id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-0.5 text-xs" data-testid={`vault-${id}`}>
                <span>
                  {id} ×{n}
                </span>
                <button
                  className="rounded bg-neutral-800 px-2 hover:bg-neutral-700 disabled:opacity-40"
                  disabled={!can || n < qty}
                  title={why([n < qty, 'not enough in your vault'])}
                  onClick={() => move('withdraw', id)}
                  data-testid={`withdraw-${id}`}
                >
                  withdraw
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {view === 'ledger' && (
        <section className="mono text-xs" data-testid="ledger">
          {ledger.data?.length === 0 && <p className="text-neutral-500">no bits have moved yet</p>}
          {ledger.data?.map((l, i) => (
            <div key={i} className="flex justify-between border-b border-neutral-900 py-0.5">
              <span className="text-neutral-500">{new Date(l.at).toLocaleString()}</span>
              <span>{l.reason}</span>
              <span className={l.delta >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                {l.delta >= 0 ? '+' : ''}
                {l.delta}
              </span>
            </div>
          ))}
          <button className="mt-1 text-neutral-500 underline" onClick={() => ledger.refetch()}>
            refresh
          </button>
        </section>
      )}
    </div>
  );
}
