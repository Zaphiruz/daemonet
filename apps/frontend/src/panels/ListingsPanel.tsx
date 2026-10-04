import { MAX_PRICE, TYPES, getSpecies, type SpeciesDef } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useRef, useState } from 'react';
import { describeApiError, describeListingError, type ListedDaemon, type ListingQuery, useBuyListingMutation, useListingsQuery, useMyListingsQuery, useUnlistMutation } from '../api.ts';
import { ivTotal, listingNet, useListingSales } from '../game/exchange.ts';
import { log } from '../game/log.ts';
import { SpriteImg } from './RamPanel.tsx';

/** Background refresh only: a sale reaches the player as a sim `listingSold` event (the connection invalidates the listing queries at once). */
const POLL_MS = 8000;
/** Filters are applied this long after the last change, so typing does not spend the per-operator request budget. */
const FILTER_DELAY_MS = 400;
const HISTORY_SHOWN = 20;

const clamp = (raw: string, min: number, max: number): number | undefined => {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : undefined;
};

/** The species definition, or null for an id this client does not know (shown by id, never a crash). */
export function knownSpecies(id: string): SpeciesDef | null {
  try {
    return getSpecies(id);
  } catch {
    return null;
  }
}
export const speciesName = (id: string): string => knownSpecies(id)?.name ?? id;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A daemon's history, newest last: kind and detail as plain text (a `traded` entry says what it sold for). */
export function HistoryLines({ history, testId }: { history: ListedDaemon['history']; testId?: string }) {
  const shown = history.slice(-HISTORY_SHOWN);
  return (
    <div className="mono space-y-0.5 text-xs text-neutral-500" data-testid={testId}>
      {history.length === 0 && <div>no history yet</div>}
      {history.length > shown.length && <div>… {history.length - shown.length} earlier</div>}
      {shown.map((h, i) => (
        <div key={i}>
          {new Date(h.at).toLocaleDateString()} {h.kind}: {h.detail}
        </div>
      ))}
    </div>
  );
}

/** Daemon listings (SP5): browse with filters, buy to your Disk, and manage your own listings (made from the Disk tab). */
export function ListingsPanel({ client }: { client: GameClient }) {
  const [draft, setDraft] = useState<ListingQuery>({ sort: 'price', page: 0 });
  const query = useDebounced(draft, FILTER_DELAY_MS);
  const listings = useListingsQuery(query, { pollingInterval: POLL_MS });
  const mine = useMyListingsQuery(undefined, { pollingInterval: POLL_MS });
  const sales = useListingSales();
  const [buy] = useBuyListingMutation();
  const [unlist] = useUnlistMutation();
  const [open, setOpen] = useState<string | null>(null);
  // the listing whose purchase is waiting for confirmation, and the one being bought (one purchase at a time)
  const [confirming, setConfirming] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const buyBusy = useRef(false);
  const [unlisting, setUnlisting] = useState<ReadonlySet<string>>(new Set());
  const unlistBusy = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const me = client.self;
  const set = (patch: Partial<ListingQuery>) => setDraft((q) => ({ ...q, ...patch, page: patch.page ?? 0 }));

  const purchase = async (id: string, species: string) => {
    if (buyBusy.current) return;
    buyBusy.current = true;
    setBuying(id);
    setError(null);
    setResult(null);
    try {
      const r = await buy(id).unwrap();
      const text = `bought ${species} for ${r.price} bits`;
      setResult(text);
      log.push('event', `${text} (Disk slot ${r.slot})`);
    } catch (err) {
      const message = describeListingError(err);
      setError(message);
      log.push('reject', `buy: ${message}`);
    } finally {
      buyBusy.current = false;
      setBuying(null);
      setConfirming(null);
    }
  };

  const unlistOne = async (id: string) => {
    if (unlistBusy.current.has(id)) return;
    unlistBusy.current.add(id);
    setUnlisting(new Set(unlistBusy.current));
    setError(null);
    setResult(null);
    try {
      await unlist(id).unwrap();
    } catch (err) {
      const message = describeListingError(err);
      setError(message);
      log.push('reject', `unlist: ${message}`);
    } finally {
      unlistBusy.current.delete(id);
      setUnlisting(new Set(unlistBusy.current));
    }
  };

  const page = draft.page ?? 0;
  return (
    <div className="space-y-3 text-sm" data-testid="listings">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <input className="w-24 rounded bg-neutral-900 px-1" placeholder="species" value={draft.species ?? ''} onChange={(e) => set({ species: e.target.value.trim().toLowerCase() || undefined })} data-testid="listing-species" />
        <select className="rounded bg-neutral-800 px-1 py-0.5" value={draft.type ?? ''} onChange={(e) => set({ type: e.target.value || undefined })} data-testid="listing-type">
          <option value="">any type</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="text-neutral-500">
          <input type="checkbox" className="mr-1" checked={draft.clean === true} onChange={(e) => set({ clean: e.target.checked ? true : undefined })} data-testid="listing-clean" />
          clean
        </label>
        <label className="text-neutral-500">
          sig ≥
          <input className="ml-1 w-10 rounded bg-neutral-900 px-1" type="number" min={0} max={15} value={draft.minSignature ?? 0} onChange={(e) => set({ minSignature: clamp(e.target.value, 1, 15) })} data-testid="listing-sig" />
        </label>
        <label className="text-neutral-500">
          max
          <input className="ml-1 w-16 rounded bg-neutral-900 px-1" type="number" min={1} max={MAX_PRICE} value={draft.maxPrice ?? ''} onChange={(e) => set({ maxPrice: clamp(e.target.value, 1, MAX_PRICE) })} data-testid="listing-max" />
        </label>
        <select className="rounded bg-neutral-800 px-1 py-0.5" value={draft.sort ?? 'price'} onChange={(e) => set({ sort: e.target.value as 'price' | 'new' })} data-testid="listing-sort">
          <option value="price">cheapest</option>
          <option value="new">newest</option>
        </select>
        <span className="mono ml-auto text-neutral-500">{me.bits} bits</span>
      </div>

      {error && (
        <p className="text-xs text-red-400" data-testid="listings-error">
          {error}
        </p>
      )}
      {result && (
        <p className="mono text-xs text-emerald-300" data-testid="listings-result">
          {result}
        </p>
      )}

      <section className="space-y-1">
        {listings.error !== undefined && (
          <p className="text-xs text-red-400" data-testid="listings-load-error">
            listings unavailable: {describeApiError(listings.error)}
          </p>
        )}
        {listings.data === undefined && listings.error === undefined && <p className="text-xs text-neutral-600">loading…</p>}
        {listings.data?.listings.length === 0 && <p className="text-xs text-neutral-600">no listings match</p>}
        {listings.data?.listings.map((l) => {
          const sp = knownSpecies(l.daemon.species);
          const name = sp?.name ?? l.daemon.species;
          const own = l.sellerId === client.operatorId;
          const short = Math.max(0, l.price - me.bits);
          const why = buying !== null ? 'waiting for the previous purchase' : short > 0 ? `need ${short} more bits` : null;
          return (
            <div key={l.id} className="rounded border border-neutral-800 p-2" data-testid={`listing-${l.daemon.id}`}>
              <div className="flex gap-2">
                {sp && <SpriteImg species={l.daemon.species} types={sp.types} clean={l.daemon.clean} signature={l.daemon.signature} />}
                <div className="min-w-0 flex-1">
                  <div>
                    <span className="font-medium">{name}</span> <span className="text-neutral-500">L{l.daemon.level}</span>
                    {l.daemon.clean && <span className="ml-1 text-white">clean</span>}
                    {l.daemon.signature > 0 && <span className="ml-1 text-fuchsia-300">T{l.daemon.signature}</span>}
                    {l.daemon.patched && <span className="ml-1 text-amber-300">patched</span>}
                  </div>
                  <div className="mono text-xs text-neutral-500">
                    ivs {ivTotal(l.daemon.ivs)} · {own ? 'yours' : `from ${l.sellerName ?? 'an operator'}`} ·{' '}
                    <button className="underline" onClick={() => setOpen(open === l.id ? null : l.id)} data-testid={`details-${l.daemon.id}`}>
                      {open === l.id ? 'less' : 'details'}
                    </button>
                  </div>
                </div>
                <div className="text-right">
                  <div className="mono">{l.price} bits</div>
                  {!own && (
                    <button
                      className="rounded bg-sky-800 px-2 py-0.5 text-xs hover:bg-sky-700 disabled:opacity-40"
                      disabled={why !== null}
                      title={why ?? undefined}
                      onClick={() => (setConfirming(l.id), setError(null), setResult(null))}
                      data-testid={`buy-${l.daemon.id}`}
                    >
                      buy
                    </button>
                  )}
                </div>
              </div>
              {!own && why !== null && buying === null && <p className="mt-1 text-xs text-neutral-500">{why}</p>}
              {confirming === l.id && !own && (
                <p className="mono mt-1 text-xs text-neutral-300">
                  buy {name} L{l.daemon.level} for {l.price} bits? It goes to your lowest free Disk slot.{' '}
                  <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={buying !== null} onClick={() => void purchase(l.id, name)} data-testid={`buy-confirm-${l.daemon.id}`}>
                    confirm
                  </button>{' '}
                  <button className="hover:text-white disabled:opacity-40" disabled={buying !== null} onClick={() => setConfirming(null)} data-testid={`buy-cancel-${l.daemon.id}`}>
                    cancel
                  </button>
                </p>
              )}
              {open === l.id && (
                <div className="mono mt-1 space-y-0.5 text-xs text-neutral-400">
                  <div>
                    ivs {l.daemon.ivs.join(' ')} · moves {l.daemon.moves.join(', ')}
                  </div>
                  <div>
                    captured {new Date(l.daemon.log.capturedAt).toLocaleString()} in {l.daemon.log.subnet} with {l.daemon.log.tool} · crashes {l.daemon.crashes}
                    {l.daemon.heldItem ? ` · holds ${l.daemon.heldItem}` : ''}
                  </div>
                  <HistoryLines history={l.daemon.history} />
                </div>
              )}
            </div>
          );
        })}
        <div className="flex gap-2 text-xs text-neutral-500">
          {page > 0 && (
            <button className="underline" onClick={() => set({ page: page - 1 })} data-testid="listing-prev">
              previous
            </button>
          )}
          {listings.data?.more && (
            <button className="underline" onClick={() => set({ page: page + 1 })} data-testid="listing-next">
              next
            </button>
          )}
        </div>
      </section>

      <section className="text-xs" data-testid="my-listings">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">my listings</h3>
        {mine.data?.length === 0 && <p className="text-neutral-600">none: list a daemon from the Disk tab</p>}
        {mine.data?.map((l) => (
          <div key={l.id} className="mono flex items-center justify-between gap-1 border-b border-neutral-900 py-0.5">
            <span>
              {speciesName(l.species)} L{l.level}
            </span>
            <span>
              {l.price} bits{l.status === 'ACTIVE' ? ` (${listingNet(l.price)} after the fee)` : ''}
            </span>
            <span className="text-neutral-500">{l.status.toLowerCase()}</span>
            {l.status === 'ACTIVE' ? (
              <button className="text-neutral-500 hover:text-red-300 disabled:opacity-40" disabled={unlisting.has(l.id)} onClick={() => void unlistOne(l.id)}>
                unlist
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </section>

      <section className="text-xs" data-testid="my-sales">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">recent sales</h3>
        {sales.length === 0 && <p className="text-neutral-600">none this session</p>}
        {sales.slice(0, 8).map((s, i) => (
          <p key={i} className="mono text-neutral-400">
            {s.role === 'seller' ? `sold ${speciesName(s.species)} for ${s.price} bits (${s.price - s.fee} after the fee)` : `bought ${speciesName(s.species)} for ${s.price} bits`}
          </p>
        ))}
      </section>
    </div>
  );
}
