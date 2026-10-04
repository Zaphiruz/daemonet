import { MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useRef, useState } from 'react';
import { describeApiError, useBookQuery, useCancelOrderMutation, useExchangeItemsQuery, useMyOrdersQuery, usePlaceOrderMutation, useVaultQuery } from '../api.ts';
import { describeFill, orderPreview, simulateOrder, spread, useExchangeFills } from '../game/exchange.ts';
import { log } from '../game/log.ts';

/**
 * Background refresh only: a fill reaches the player as a sim `exchange` event (the connection invalidates the orders,
 * book and vault queries at once) and every placement or cancel invalidates them too, so polling only catches other
 * players' book changes. Well inside the per-operator Exchange budget.
 */
const POLL_MS = 16_000;
const ITEMS_POLL_MS = 60_000;
const clamp = (raw: string, max: number) => Math.max(1, Math.min(max, Math.trunc(Number(raw)) || 1));

/**
 * The Exchange (SP5): order book per item, an order form, and the operator's own orders. Trades from the vault (Host tab).
 * Everything shown before placing is a preview of what the api's engine will do; the api is authoritative.
 */
export function ExchangePanel({ client }: { client: GameClient }) {
  const items = useExchangeItemsQuery(undefined, { pollingInterval: ITEMS_POLL_MS });
  const [item, setItem] = useState('frag:packet');
  const book = useBookQuery(item, { pollingInterval: POLL_MS });
  const orders = useMyOrdersQuery(undefined, { pollingInterval: POLL_MS });
  const vault = useVaultQuery(undefined, { pollingInterval: POLL_MS });
  const [place] = usePlaceOrderMutation();
  const [cancel] = useCancelOrderMutation();
  const fills = useExchangeFills();
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [price, setPrice] = useState(32);
  const [qty, setQty] = useState(1);
  // one placement at a time and one cancel per order: the buttons stay disabled until the request settles (the refs also
  // cover the gap before the re-render)
  const [placing, setPlacing] = useState(false);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(false);
  const cancelBusy = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const me = client.self;
  const have = vault.data?.[item] ?? 0;
  const mine = orders.data ?? [];
  // the api's cap counts OPEN orders that have not expired yet (expired ones are swept within five minutes)
  const now = Date.now();
  const open = mine.filter((o) => o.status === 'OPEN' && Date.parse(o.expiresAt) > now).length;
  const sim = book.data ? simulateOrder(book.data, mine.filter((o) => o.item === item), side, price, qty) : null;
  const full = orderPreview(side, price, qty);
  const top = book.data ? spread(book.data) : { bid: null, ask: null, spread: null };
  const why: string | null = placing
    ? 'waiting for the previous order'
    : open >= MAX_OPEN_ORDERS
      ? `at most ${MAX_OPEN_ORDERS} open orders: cancel one first`
      : side === 'BUY' && me.bits < full.total
        ? `not enough bits: the order escrows ${full.total}`
        : side === 'SELL' && have < qty
          ? `only ${have} in your vault: deposit items at a host first (Host → vault)`
          : null;

  const pick = (next: string) => {
    setItem(next);
    setError(null);
    setResult(null);
  };

  const submit = async () => {
    if (busy.current || why !== null) return;
    busy.current = true;
    setPlacing(true);
    setError(null);
    setResult(null);
    try {
      const r = await place({ item, side, price, qty }).unwrap();
      const filled = r.fills.reduce((s, f) => s + f.qty, 0);
      const text = `${side.toLowerCase()} ${qty} ${item} @ ${price}: ${filled} filled, ${r.order.remaining} resting`;
      setResult(text);
      log.push('event', text);
    } catch (err) {
      const message = describeApiError(err);
      setError(message);
      log.push('reject', `order: ${message}`);
    } finally {
      busy.current = false;
      setPlacing(false);
    }
  };

  const cancelOrder = async (id: string) => {
    if (cancelBusy.current.has(id)) return;
    cancelBusy.current.add(id);
    setCancelling(new Set(cancelBusy.current));
    setError(null);
    try {
      await cancel(id).unwrap();
    } catch (err) {
      const message = describeApiError(err);
      setError(message);
      log.push('reject', `cancel: ${message}`);
    } finally {
      cancelBusy.current.delete(id);
      setCancelling(new Set(cancelBusy.current));
    }
  };

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="exchange">
      <div className="flex items-center gap-2 text-xs">
        <select className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5" value={item} onChange={(e) => pick(e.target.value)} data-testid="exchange-item">
          {(items.data ?? [{ id: item, name: item, bid: null, ask: null }]).map((i) => (
            <option key={i.id} value={i.id}>
              {i.id}
              {i.bid !== null || i.ask !== null ? ` · ${i.bid ?? '—'} / ${i.ask ?? '—'}` : ''}
            </option>
          ))}
        </select>
        <span className="mono text-neutral-500" data-testid="exchange-vault">
          vault ×{have} · {me.bits} bits
        </span>
      </div>

      <section className="grid grid-cols-2 gap-2 text-xs" data-testid="book">
        {book.error !== undefined && (
          <p className="col-span-2 text-red-400" data-testid="book-error">
            book unavailable: {describeApiError(book.error)}
          </p>
        )}
        <div>
          <h3 className="mb-1 uppercase tracking-wide text-emerald-400">bids</h3>
          {book.data?.bids.length === 0 && <p className="text-neutral-600">none</p>}
          {book.data?.bids.map((l) => (
            <button key={l.price} className="mono flex w-full justify-between text-emerald-300 hover:bg-neutral-900" onClick={() => (setSide('SELL'), setPrice(l.price))} data-testid={`bid-${l.price}`}>
              <span>{l.price}</span>
              <span className="text-neutral-400">×{l.qty}</span>
            </button>
          ))}
        </div>
        <div>
          <h3 className="mb-1 uppercase tracking-wide text-red-400">asks</h3>
          {book.data?.asks.length === 0 && <p className="text-neutral-600">none</p>}
          {book.data?.asks.map((l) => (
            <button key={l.price} className="mono flex w-full justify-between text-red-300 hover:bg-neutral-900" onClick={() => (setSide('BUY'), setPrice(l.price))} data-testid={`ask-${l.price}`}>
              <span>{l.price}</span>
              <span className="text-neutral-400">×{l.qty}</span>
            </button>
          ))}
        </div>
        <p className="mono col-span-2 text-neutral-500">
          spread {top.spread ?? '—'} · last {book.data?.fills[0] ? `${book.data.fills[0].price} ×${book.data.fills[0].qty}` : '—'}
        </p>
      </section>

      <section className="space-y-1 rounded border border-neutral-800 p-2 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button key={s} className={`rounded px-2 py-0.5 ${side === s ? (s === 'BUY' ? 'bg-emerald-800' : 'bg-red-900') : 'bg-neutral-800 text-neutral-400'}`} onClick={() => setSide(s)} data-testid={`side-${s}`}>
              {s.toLowerCase()}
            </button>
          ))}
          <label className="ml-2 text-neutral-500">
            price
            <input className="ml-1 w-20 rounded bg-neutral-900 px-1" type="number" min={1} max={MAX_PRICE} value={price} onChange={(e) => setPrice(clamp(e.target.value, MAX_PRICE))} data-testid="order-price" />
          </label>
          <label className="text-neutral-500">
            qty
            <input className="ml-1 w-14 rounded bg-neutral-900 px-1" type="number" min={1} max={MAX_QTY} value={qty} onChange={(e) => setQty(clamp(e.target.value, MAX_QTY))} data-testid="order-qty" />
          </label>
          <button className="ml-auto rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={why !== null} title={why ?? undefined} onClick={() => void submit()} data-testid="order-place">
            place
          </button>
        </div>
        <p className="mono text-neutral-500" data-testid="order-preview">
          {side === 'BUY' ? `escrows ${full.total} bits` : `holds ${qty} from your vault`}
          {sim && (
            <>
              {' · '}fills {sim.filled} now{sim.average !== null ? ` at ~${sim.average.toFixed(1)}` : ''}
              {side === 'BUY' && sim.filled > 0 ? ` · spend ${sim.spent} · refund ${sim.refund}` : ''}
              {side === 'SELL' && sim.filled > 0 ? ` · fee ${sim.fee} · receive ${sim.spent - sim.fee}` : ''}
              {sim.resting > 0 ? ` · ${sim.resting} rests${side === 'SELL' ? `, ${orderPreview('SELL', price, sim.resting).net} bits after the 1/16 fee if it fills` : ''}` : ''}
            </>
          )}
        </p>
        {sim !== null && sim.selfSkipped > 0 && (
          <p className="text-amber-400" data-testid="self-match">
            {sim.selfSkipped} of your own resting units at these prices would be skipped: orders never match your own.
          </p>
        )}
        {why !== null && !placing && (
          <p className="text-neutral-500" data-testid="order-why">
            {why}
          </p>
        )}
        {result && (
          <p className="mono text-emerald-300" data-testid="order-result">
            {result}
          </p>
        )}
        {error && (
          <p className="text-red-400" data-testid="order-error">
            {error}
          </p>
        )}
      </section>

      <section className="text-xs" data-testid="my-orders">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">
          my orders ({open}/{MAX_OPEN_ORDERS} open)
        </h3>
        {mine.length === 0 && <p className="text-neutral-600">none</p>}
        {mine.map((o) => (
          <div key={o.id} className="mono flex items-center justify-between gap-1 border-b border-neutral-900 py-0.5">
            <span className={o.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'}>{o.side.toLowerCase()}</span>
            <span className="min-w-0 truncate">{o.item}</span>
            <span>
              {o.qty - o.remaining}/{o.qty} @ {o.price}
            </span>
            <span className="text-neutral-500">{o.status.toLowerCase()}</span>
            {o.status === 'OPEN' ? (
              <button className="text-neutral-500 hover:text-red-300 disabled:opacity-40" disabled={cancelling.has(o.id)} onClick={() => void cancelOrder(o.id)}>
                cancel
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </section>

      <section className="text-xs" data-testid="my-fills">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">recent fills</h3>
        {fills.length === 0 && <p className="text-neutral-600">none this session</p>}
        {fills.slice(0, 8).map((f, i) => (
          <p key={i} className="mono text-neutral-400">
            {describeFill(f)}
          </p>
        ))}
      </section>
    </div>
  );
}
