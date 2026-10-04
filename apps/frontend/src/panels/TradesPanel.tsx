import { MAX_OPEN_TRADES, MAX_TRADE_BITS, MAX_TRADE_DAEMONS, MAX_TRADE_ITEMS, TRADE_IDLE_MS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useRef, useState } from 'react';
import {
  describeTradeError,
  type Trade,
  type TradeOfferBody,
  type TradeSide,
  useCancelTradeMutation,
  useConfirmTradeMutation,
  useDiskQuery,
  useOpenTradeMutation,
  useSetOfferMutation,
  useTradesQuery,
  useVaultQuery,
} from '../api.ts';
import { ivTotal, listingNet } from '../game/exchange.ts';
import { log } from '../game/log.ts';

/**
 * Background refresh only: every trade change reaches the player as a sim `exchange` event (the connection invalidates
 * the trades, Disk, vault and ledger queries at once) and every own action invalidates them too.
 */
const POLL_MS = 15_000;
const IDLE_MINUTES = Math.round(TRADE_IDLE_MS / 60_000);

type Items = Record<string, number>;
const sameItems = (a: Items, b: Items): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));
const sameOffer = (a: TradeSide, b: TradeSide): boolean =>
  a.offer.bits === b.offer.bits && sameItems(a.offer.items, b.offer.items) && sameIds(a.offer.daemons.map((d) => d.id), b.offer.daemons.map((d) => d.id));
const nothing = (side: TradeSide): boolean => side.offer.bits === 0 && Object.keys(side.offer.items).length === 0 && side.offer.daemons.length === 0;

/** Direct trades (SP5): open one with an operator by name, put bits / vault items / Disk daemons on the table, both confirm. */
export function TradesPanel({ client }: { client?: GameClient }) {
  const trades = useTradesQuery(undefined, { pollingInterval: POLL_MS });
  const [open] = useOpenTradeMutation();
  const [name, setName] = useState('');
  const [opening, setOpening] = useState(false);
  const openBusy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const rows = trades.data ?? [];
  const live = rows.filter((t) => t.status === 'OPEN');
  const typed = name.trim();
  const why: string | null = opening
    ? 'opening the trade…'
    : !typed
      ? 'type an operator name'
      : live.length >= MAX_OPEN_TRADES
        ? `at most ${MAX_OPEN_TRADES} open trades: cancel one first`
        : live.some((t) => t.them.name?.toLowerCase() === typed.toLowerCase())
          ? 'you already have an open trade with that operator'
          : null;

  const submit = async () => {
    if (openBusy.current || why !== null) return;
    openBusy.current = true;
    setOpening(true);
    setError(null);
    try {
      await open({ withName: typed }).unwrap();
      setName('');
    } catch (err) {
      const message = describeTradeError(err, 'open');
      setError(message);
      log.push('reject', `trade: ${message}`);
    } finally {
      openBusy.current = false;
      setOpening(false);
    }
  };

  return (
    <div className="space-y-3 text-sm" data-testid="trades">
      <div className="flex gap-1 text-xs">
        <input className="min-w-0 flex-1 rounded bg-neutral-900 px-1" placeholder="operator name" value={name} onChange={(e) => setName(e.target.value)} data-testid="trade-with" />
        <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={why !== null} title={why ?? undefined} onClick={() => void submit()} data-testid="trade-open">
          open trade
        </button>
      </div>
      {typed !== '' && why !== null && !opening && (
        <p className="text-xs text-neutral-500" data-testid="trade-open-why">
          {why}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-400" data-testid="trade-open-error">
          {error}
        </p>
      )}
      {trades.error !== undefined && (
        <p className="text-xs text-red-400" data-testid="trades-error">
          trades unavailable: {describeTradeError(trades.error, 'open')}
        </p>
      )}
      {rows.length === 0 && trades.error === undefined && <p className="text-xs text-neutral-600">no trades</p>}
      {live.map((t) => (
        <TradeCard key={t.id} trade={t} client={client} />
      ))}
      <section className="text-xs">
        {rows
          .filter((t) => t.status !== 'OPEN')
          .map((t) => (
            <div key={t.id} className="mono flex justify-between gap-2 border-b border-neutral-900 py-0.5 text-neutral-500" data-testid={`trade-closed-${t.them.name ?? t.them.id}`}>
              <span className="min-w-0 truncate">with {t.them.name ?? 'an operator'}</span>
              <span>{t.status.toLowerCase()}</span>
              <span>{new Date(t.updatedAt).toLocaleString()}</span>
            </div>
          ))}
      </section>
    </div>
  );
}

function OfferView({ side }: { side: TradeSide }) {
  const { offer } = side;
  return (
    <div className="mono text-xs text-neutral-300">
      {nothing(side) && <span className="text-neutral-600">nothing</span>}
      {offer.bits > 0 && <div>{offer.bits} bits</div>}
      {Object.entries(offer.items).map(([item, qty]) => (
        <div key={item}>
          {item} ×{qty}
        </div>
      ))}
      {offer.daemons.map((d) => (
        <div key={d.id}>
          {getSpecies(d.species).name} L{d.level} · ivs {ivTotal(d.ivs)}
          {d.clean ? ' · clean' : ''}
          {d.signature > 0 ? ` · T${d.signature}` : ''}
        </div>
      ))}
    </div>
  );
}

/** What this side of the table brings in, as the confirm line states it (bits arrive after the 1/16 fee). */
function describeReceived(side: TradeSide): string {
  const parts: string[] = [];
  if (side.offer.bits > 0) parts.push(`${listingNet(side.offer.bits)} bits (${side.offer.bits} less a fee of ${side.offer.bits - listingNet(side.offer.bits)})`);
  for (const [item, qty] of Object.entries(side.offer.items)) parts.push(`${item} ×${qty}`);
  for (const d of side.offer.daemons) parts.push(`${getSpecies(d.species).name} L${d.level}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

function describeGiven(side: TradeSide): string {
  const parts: string[] = [];
  if (side.offer.bits > 0) parts.push(`${side.offer.bits} bits`);
  for (const [item, qty] of Object.entries(side.offer.items)) parts.push(`${item} ×${qty}`);
  for (const d of side.offer.daemons) parts.push(`${getSpecies(d.species).name} L${d.level}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

function TradeCard({ trade, client }: { trade: Trade; client?: GameClient | undefined }) {
  const vault = useVaultQuery();
  const disk = useDiskQuery();
  const [setOffer] = useSetOfferMutation();
  const [confirm] = useConfirmTradeMutation();
  const [cancel] = useCancelTradeMutation();
  const [bits, setBits] = useState(trade.me.offer.bits);
  const [items, setItems] = useState<Items>(trade.me.offer.items);
  const [daemonIds, setDaemonIds] = useState<string[]>(trade.me.offer.daemons.map((d) => d.id));
  /** The version of the offers the player has looked at (and approved by opening or editing); a confirmation quotes it. */
  const [reviewed, setReviewed] = useState(trade.version);
  const [busy, setBusy] = useState<'offer' | 'confirm' | 'cancel' | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const lock = `trade:${trade.id}`;
  const offerable = (disk.data ?? []).filter((d) => !d.lockedBy || d.lockedBy === lock);
  const tag = trade.them.name ?? trade.them.id;
  const who = trade.them.name ?? 'an operator';

  const mine = trade.me.offer;
  const draftKinds = Object.keys(items).length;
  const dirty = bits !== mine.bits || !sameItems(items, mine.items) || !sameIds(daemonIds, mine.daemons.map((d) => d.id));
  const balance = client?.self.bits;

  const setQty = (item: string, qty: number) =>
    setItems((cur) => {
      const next = { ...cur };
      if (qty > 0) next[item] = qty;
      else delete next[item];
      return next;
    });
  const toggle = (id: string) => setDaemonIds((cur) => (cur.includes(id) ? cur.filter((d) => d !== id) : [...cur, id]));
  const resetDraft = () => {
    setBits(mine.bits);
    setItems(mine.items);
    setDaemonIds(mine.daemons.map((d) => d.id));
  };

  const offerWhy: string | null =
    busy !== null
      ? 'waiting for the previous request'
      : !dirty
        ? 'your offer is already set'
        : bits > MAX_TRADE_BITS
          ? `at most ${MAX_TRADE_BITS} bits`
          : balance !== undefined && bits > balance
            ? `you only have ${balance} bits`
            : draftKinds > MAX_TRADE_ITEMS
              ? `at most ${MAX_TRADE_ITEMS} kinds of item`
              : daemonIds.length > MAX_TRADE_DAEMONS
                ? `at most ${MAX_TRADE_DAEMONS} daemons`
                : null;
  const unreviewed = reviewed !== trade.version;
  const confirmWhy: string | null =
    busy !== null
      ? 'waiting for the previous request'
      : trade.me.confirmed
        ? 'you confirmed: waiting for them'
        : dirty
          ? 'you have unsent changes to your offer: set it first (or reset)'
          : unreviewed
            ? 'the offers changed: review them first'
            : nothing(trade.me) && nothing(trade.them)
              ? 'there is nothing on the table'
              : balance !== undefined && mine.bits > balance
                ? `you offer ${mine.bits} bits but have ${balance}`
                : null;

  /** One request at a time per trade card; the ref covers the gap before the re-render. */
  const run = async (kind: 'offer' | 'confirm' | 'cancel', what: string, request: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    setError(null);
    try {
      await request();
      return true;
    } catch (err) {
      const message = describeTradeError(err, kind);
      setError(message);
      log.push('reject', `${what}: ${message}`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const submitOffer = () => {
    if (offerWhy !== null) return;
    const offer: TradeOfferBody = { bits, items, daemonIds };
    // what the player was looking at when sending: their own change is the only one they have approved
    const seenVersion = reviewed;
    const seenThem = trade.them;
    void run('offer', 'offer', async () => {
      const t = await setOffer({ id: trade.id, offer }).unwrap();
      // Taken as reviewed only when nothing else changed meanwhile: exactly our own bump, and their side as it was on
      // screen. A counter-offer that landed first leaves the review step (and the "offers changed" banner) in place.
      if (t.version === seenVersion + 1 && sameOffer(t.them, seenThem)) setReviewed(t.version);
    });
  };
  const submitConfirm = () => {
    if (confirmWhy !== null) return;
    void run('confirm', 'confirm', () => confirm({ id: trade.id, version: reviewed }).unwrap());
  };
  const submitCancel = () => void run('cancel', 'cancel', () => cancel(trade.id).unwrap());

  return (
    <div className="space-y-2 rounded border border-neutral-800 p-2" data-testid={`trade-${tag}`}>
      <div className="flex items-center justify-between text-xs">
        <span>
          with <span className="text-neutral-200">{who}</span>
        </span>
        <span className="text-neutral-500" data-testid="trade-status">
          {trade.me.confirmed ? 'you confirmed' : 'you have not confirmed'} · {trade.them.confirmed ? 'they confirmed' : 'they have not confirmed'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <h4 className="text-xs uppercase tracking-wide text-neutral-500">they give</h4>
          <OfferView side={trade.them} />
          {trade.them.offer.bits > 0 && <p className="mono text-xs text-neutral-500">you receive {listingNet(trade.them.offer.bits)} after the fee</p>}
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-wide text-neutral-500">you give</h4>
          <OfferView side={trade.me} />
          {mine.bits > 0 && <p className="mono text-xs text-neutral-500">they receive {listingNet(mine.bits)} after the fee</p>}
        </div>
      </div>
      <div className="space-y-1 border-t border-neutral-900 pt-1 text-xs">
        <label className="text-neutral-500">
          bits
          <input
            className="ml-1 w-24 rounded bg-neutral-900 px-1"
            type="number"
            min={0}
            max={MAX_TRADE_BITS}
            value={bits}
            onChange={(e) => setBits(Math.max(0, Math.min(MAX_TRADE_BITS, Math.trunc(Number(e.target.value)) || 0)))}
            data-testid="trade-bits"
          />
        </label>
        {Object.entries(vault.data ?? {}).map(([item, have]) => (
          <label key={item} className="mono ml-2 text-neutral-500">
            {item}
            <input
              className="ml-1 w-12 rounded bg-neutral-900 px-1"
              type="number"
              min={0}
              max={have}
              value={items[item] ?? 0}
              onChange={(e) => setQty(item, Math.max(0, Math.min(have, Math.trunc(Number(e.target.value)) || 0)))}
              data-testid={`trade-item-${item}`}
            />
            <span className="text-neutral-600">/{have}</span>
          </label>
        ))}
        <div>
          {offerable.map((d) => (
            <label key={d.id} className="mono mr-2 text-neutral-400">
              <input type="checkbox" className="mr-1" checked={daemonIds.includes(d.id)} onChange={() => toggle(d.id)} data-testid={`trade-daemon-${d.id}`} />
              {getSpecies(d.species).name} L{d.level}
            </label>
          ))}
        </div>
        {offerWhy !== null && busy === null && dirty && (
          <p className="text-neutral-500" data-testid="trade-offer-why">
            {offerWhy}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={offerWhy !== null} title={offerWhy ?? undefined} onClick={submitOffer} data-testid="trade-offer">
            set my offer
          </button>
          {dirty && (
            <button className="text-neutral-500 hover:text-white disabled:opacity-40" disabled={busy !== null} onClick={resetDraft} data-testid="trade-reset">
              reset
            </button>
          )}
          {unreviewed && (
            <button className="rounded bg-amber-800 px-2 py-0.5 hover:bg-amber-700 disabled:opacity-40" disabled={busy !== null || dirty} title={dirty ? 'set or reset your offer first' : undefined} onClick={() => setReviewed(trade.version)} data-testid="trade-review">
              review changes
            </button>
          )}
          <button className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40" disabled={confirmWhy !== null} title={confirmWhy ?? undefined} onClick={submitConfirm} data-testid="trade-confirm">
            confirm
          </button>
          <button className="ml-auto text-neutral-500 hover:text-red-300 disabled:opacity-40" disabled={busy !== null} onClick={submitCancel} data-testid="trade-cancel">
            cancel trade
          </button>
        </div>
        {unreviewed && (
          <p className="text-amber-400" data-testid="trade-changed">
            the offers changed since you last looked: check both sides above, then review the changes.
          </p>
        )}
        <p className="mono text-neutral-400" data-testid="trade-summary">
          Confirming: you give {describeGiven(trade.me)}; you receive {describeReceived(trade.them)}.
        </p>
        {confirmWhy !== null && busy === null && !trade.me.confirmed && (
          <p className="text-neutral-500" data-testid="trade-confirm-why">
            {confirmWhy}
          </p>
        )}
        {error && (
          <p className="text-red-400" data-testid="trade-error">
            {error}
          </p>
        )}
        <p className="text-neutral-600">
          Changing either offer clears both confirmations. Bits you receive lose 1/16 to the fee. Offered daemons are locked until the trade ends. Idle trades close after {IDLE_MINUTES} minutes.
        </p>
      </div>
    </div>
  );
}
