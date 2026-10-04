import { LISTING_TTL_MS, MAX_ACTIVE_LISTINGS, MAX_PRICE, RAM_SLOTS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useRef, useState } from 'react';
import { describeListingError, useDiskQuery, useListDaemonMutation, useMyListingsQuery, useUnlistMutation } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { listingNet } from '../game/exchange.ts';
import { log } from '../game/log.ts';
import { HistoryLines } from './ListingsPanel.tsx';
import { nearHost, SpriteImg } from './RamPanel.tsx';

const LISTING_LOCK = 'listing:';
const TRADE_LOCK = 'trade:';
const LISTING_DAYS = Math.round(LISTING_TTL_MS / 86_400_000);
const PRICE_RANGE = `price must be a whole number from 1 to ${MAX_PRICE}`;

/** The price typed into the form: a whole number from 1 to MAX_PRICE, else null. */
const parsePrice = (text: string): number | null => {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_PRICE ? n : null;
};

export function DiskPanel({ client }: { client: GameClient }) {
  const disk = useDiskQuery();
  const mine = useMyListingsQuery(undefined, { pollingInterval: 30_000 });
  const [list] = useListDaemonMutation();
  const [unlist] = useUnlistMutation();
  const me = client.self;
  const atHost = nearHost(client.subnet, me);
  const manual = client.role === 'controller';
  const rows = disk.data ?? [];
  // the api's cap counts ACTIVE listings that have not expired yet
  const now = Date.now();
  const active = (mine.data ?? []).filter((l) => l.status === 'ACTIVE' && Date.parse(l.expiresAt) > now).length;
  const capReached = active >= MAX_ACTIVE_LISTINGS;
  /** the daemon whose price form is open, and the price typed into it */
  const [pricing, setPricing] = useState<{ id: string; text: string } | null>(null);
  const [listing, setListing] = useState(false);
  const listBusy = useRef(false);
  const [listError, setListError] = useState<string | null>(null);
  const [unlisting, setUnlisting] = useState<ReadonlySet<string>>(new Set());
  const unlistBusy = useRef(new Set<string>());
  const [unlistError, setUnlistError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);

  const confirmList = async (id: string, species: string, price: number) => {
    if (listBusy.current) return;
    listBusy.current = true;
    setListing(true);
    setListError(null);
    try {
      await list({ daemonId: id, price }).unwrap();
      log.push('event', `listed ${species} for ${price} bits`);
      setPricing(null);
    } catch (err) {
      const message = describeListingError(err, 'list');
      setListError(message);
      log.push('reject', `list: ${message}`);
    } finally {
      listBusy.current = false;
      setListing(false);
    }
  };

  const unlistOne = async (listingId: string) => {
    if (unlistBusy.current.has(listingId)) return;
    unlistBusy.current.add(listingId);
    setUnlisting(new Set(unlistBusy.current));
    setUnlistError(null);
    try {
      await unlist(listingId).unwrap();
    } catch (err) {
      const message = describeListingError(err, 'unlist');
      setUnlistError(message);
      log.push('reject', `unlist: ${message}`);
    } finally {
      unlistBusy.current.delete(listingId);
      setUnlisting(new Set(unlistBusy.current));
    }
  };

  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        Disk {rows.length}/{me.diskCapacity} · <button className="underline" onClick={() => disk.refetch()}>refresh</button>
      </p>
      {unlistError && (
        <p className="text-xs text-red-400" data-testid="unlist-error">
          {unlistError}
        </p>
      )}
      {rows.length === 0 && <p className="text-neutral-500">nothing on Disk</p>}
      {rows.map((d) => {
        const sp = getSpecies(d.species);
        const listingId = d.lockedBy?.startsWith(LISTING_LOCK) ? d.lockedBy.slice(LISTING_LOCK.length) : null;
        const inTrade = !!d.lockedBy?.startsWith(TRADE_LOCK);
        const price = pricing?.id === d.id ? parsePrice(pricing.text) : null;
        return (
          <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2">
            <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
            <div className="flex-1">
              <div>
                <span className="font-medium">{sp.name}</span> <span className="text-neutral-500">L{d.level} · slot {d.slot}</span>
                {d.clean && <span className="ml-1 text-white">clean</span>}
                {d.signature > 0 && <span className="ml-1 text-fuchsia-300">T{d.signature}</span>}
                {d.patched && <span className="ml-1 text-amber-300">patched</span>}
                {!!d.lockedBy && (
                  <span className="ml-1 text-sky-300" data-testid={`lock-${d.id}`}>
                    {inTrade ? 'in a trade' : 'on the Exchange'}
                  </span>
                )}
                {d.heldItem && <span className="mono ml-1 text-xs text-neutral-400">holds {d.heldItem}</span>}
              </div>
              <div className="mono text-xs text-neutral-500">
                captured {new Date(d.log.capturedAt).toLocaleString()} in {d.log.subnet} with {d.log.tool}
              </div>
              <button
                className="mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40"
                disabled={!manual || !atHost || me.ram.length >= RAM_SLOTS || !!d.lockedBy}
                title={d.lockedBy ? (inTrade ? 'in a trade: cancel the trade or take it off the table first' : listingId ? 'locked on the Exchange: unlist it first' : 'locked on the Exchange: cancel the order first') : undefined}
                onClick={() => run(client.operator.load(d.id).then(() => disk.refetch()), 'load')}
              >
                load into RAM
              </button>
              {listingId !== null && (
                <button className="ml-3 mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40" disabled={unlisting.has(listingId)} onClick={() => void unlistOne(listingId)} data-testid={`unlist-${d.id}`}>
                  unlist
                </button>
              )}
              {inTrade && (
                <button className="ml-3 mt-1 text-xs text-neutral-300 disabled:opacity-40" disabled title="in a trade: cancel the trade or take it off the table first" data-testid={`list-${d.id}`}>
                  list
                </button>
              )}
              {!d.lockedBy && pricing?.id !== d.id && (
                <button
                  className="ml-3 mt-1 text-xs text-neutral-300 hover:text-white disabled:opacity-40"
                  disabled={capReached}
                  title={capReached ? `at most ${MAX_ACTIVE_LISTINGS} active listings: unlist one first` : undefined}
                  onClick={() => (setPricing({ id: d.id, text: '256' }), setListError(null))}
                  data-testid={`list-${d.id}`}
                >
                  list
                </button>
              )}
              <button className="ml-3 mt-1 text-xs text-neutral-500 hover:text-white" onClick={() => setHistoryOpen(historyOpen === d.id ? null : d.id)} data-testid={`history-toggle-${d.id}`}>
                {historyOpen === d.id ? 'hide history' : 'history'}
              </button>
              {pricing?.id === d.id && (
                <div className="mt-1 space-y-1 text-xs text-neutral-400">
                  <div>
                    <label>
                      price
                      <input className="ml-1 w-24 rounded bg-neutral-900 px-1" type="number" min={1} max={MAX_PRICE} value={pricing.text} onChange={(e) => setPricing({ id: d.id, text: e.target.value })} data-testid="list-price" />
                    </label>
                    <button
                      className="ml-1 rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40"
                      disabled={price === null || listing}
                      onClick={() => price !== null && void confirmList(d.id, sp.name, price)}
                      data-testid="list-confirm"
                    >
                      list for {price ?? '…'} bits
                    </button>
                    <button className="ml-1 hover:text-white disabled:opacity-40" disabled={listing} onClick={() => (setPricing(null), setListError(null))}>
                      cancel
                    </button>
                  </div>
                  {price === null ? (
                    <p className="text-neutral-500" data-testid="list-why">
                      {PRICE_RANGE}
                    </p>
                  ) : (
                    <p className="mono text-neutral-500" data-testid="list-preview">
                      you get {listingNet(price)} after the 1/16 fee · open {LISTING_DAYS} days · the daemon is locked (it cannot be loaded) until it sells or you unlist it
                    </p>
                  )}
                  {listError && (
                    <p className="text-red-400" data-testid="list-error">
                      {listError}
                    </p>
                  )}
                </div>
              )}
              {historyOpen === d.id && <HistoryLines history={d.history ?? []} testId={`history-${d.id}`} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
