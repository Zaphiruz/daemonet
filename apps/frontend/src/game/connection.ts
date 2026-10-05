import { GameClient, TRANSIENT_KICKS, type ConnectOptions, type TokenSource } from '@daemonet/sdk';
import { useSyncExternalStore } from 'react';
import { api, fetchTicket as fetchTicketFromApi, TicketError } from '../api.ts';
import { store } from '../store.ts';
import { arenaStore, resultText, type ArenaStore } from './arena.ts';
import { capture as appCapture, type CaptureStore } from './capture.ts';
import { chatStore, setMe, type ChatStore } from './chat.ts';
import { clusterStore, type ClusterStore } from './clusters.ts';
import { getControls, setControls } from './controls.ts';
import { describeFill, exchangeStore, listingStore, tradeStore, parseFill, parseSale, parseTradeNote, type ExchangeStore, type ListingStore, type TradeStore } from './exchange.ts';
import { describeIncidentEvent, incidentStore, type IncidentStore } from './incident.ts';
import { log as appLog, type Log } from './log.ts';
import { setConnectionProbe, stop as stopSandbox } from './sandbox.ts';

export type Role = 'controller' | 'spectator';
/**
 * `connecting` covers the first connection including its retries; `reconnecting` an established
 * connection the SDK is resuming; `kicked` a terminal server kick; `failed` the web session is gone
 * (the ticket endpoint refused: sign in again). `kickReason` carries the reason for both.
 */
export type Status = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'kicked' | 'failed';

export interface ConnectionState {
  status: Status;
  role: Role;
  client: GameClient | null;
  /** Bumped on every tick so subscribers re-render. */
  version: number;
  kickReason: string | null;
}

export interface ConnectionDeps {
  /** Mints a fresh single-use WebSocket ticket. */
  fetchTicket(): Promise<string>;
  /** Builds a client that is not started yet (so listeners see events from the very first attempt). */
  createClient(opts: ConnectOptions): GameClient;
  url(): string;
  log: Log;
  /** Holds the current capture challenge (it arrives before any panel mounts). */
  capture: CaptureStore;
  /** Ends the sandboxed script (its bridge is tied to the client being replaced or lost). */
  stopSandbox(): void;
  /** Holds chat lines and the mute state (they arrive before any panel mounts). Optional: tests may omit it. */
  chat?: ChatStore;
  /** Holds pending cluster invites (they arrive before any panel mounts). Optional: tests may omit it. */
  clusters?: ClusterStore;
  /** Drops the cached Codex so an open panel refetches (a live discovery reveals a hidden requirement). */
  invalidateCodex(): void;
  /** Drops the cached ticket board and history (a ticket finished or moved). Optional: tests may omit it. */
  invalidateTickets?(): void;
  /** Holds the running Incident and its telegraphs (events arrive before any panel mounts). Optional: tests may omit it. */
  incident?: IncidentStore;
  /** Holds the player's latest Exchange fills (they arrive before any panel mounts). Optional: tests may omit it. */
  exchange?: ExchangeStore;
  /** Refetches the orders, book and vault queries (a fill moved items and bits; also after a reconnect). Optional. */
  invalidateExchange?(): void;
  /** Holds the operator's latest daemon sales and purchases (`listingSold` arrives before any panel mounts). Optional. */
  listings?: ListingStore;
  /** Refetches the listings, Disk and ledger queries (a daemon changed hands; also after a reconnect). Optional. */
  invalidateListings?(): void;
  /** Holds the operator's latest direct-trade changes (they arrive before any panel mounts). Optional. */
  trades?: TradeStore;
  /** Refetches the trades, Disk, vault and ledger queries (a trade changed; also after a reconnect). Optional. */
  invalidateTrades?(): void;
  /** Refetches /api/incidents (after a reconnect, when an Incident ended): the API re-seeds the store. Optional. */
  invalidateIncidents?(): void;
  /** Holds the arena queue, incoming challenges and the last result (events arrive before any panel mounts). Optional. */
  arena?: ArenaStore;
  /** Refetches the standing, ladder and match-history queries (a match finished; also after a reconnect). Optional. */
  invalidateArena?(): void;
}

/** Backoff for a first connection that failed: doubles from RETRY_MIN_MS up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/**
 * Kicks before the first snapshot after which another attempt (with a new ticket) can succeed. The
 * SDK's own TRANSIENT_KICKS plus `unavailable` (the store was down) and `unauthorized` (e.g. a ticket
 * that expired in flight; a gone session shows up as a 401 from the ticket endpoint instead).
 */
const RETRYABLE_KICKS: ReadonlySet<string> = new Set([...TRANSIENT_KICKS, 'unavailable', 'unauthorized']);
const SIGNED_OUT = 'session expired: sign in again';
/** Consecutive `unauthorized` kicks before the first snapshot after which the store gives up. */
export const MAX_UNAUTHORIZED_RETRIES = 5;
const REJECTED = 'the game server keeps rejecting this session (unauthorized): sign in again';

const isSignedOut = (err: unknown): boolean => err instanceof TicketError && err.signedOut;

type Attempt = { kind: 'online' } | { kind: 'cancelled' } | { kind: 'retry'; reason: string } | { kind: 'terminal'; status: 'kicked' | 'failed'; reason: string };

/**
 * The page's single game connection. Every connection attempt — the first, its retries and every
 * SDK reconnect — mints a new single-use ticket through `getToken`; the token source has no
 * `onRefresh`, so a ticket is never sent in `reauth`. The SDK rejects `connect` when the first
 * connection fails (carry-forward #11); this store then retries with backoff unless the failure is
 * terminal (a non-transient kick, or a signed-out session).
 */
export function createConnection(deps: ConnectionDeps) {
  let state: ConnectionState = { status: 'idle', role: 'controller', client: null, version: 0, kickReason: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ConnectionState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  /** Bumped by every open/close; an attempt or client from an older generation is ignored. */
  let generation = 0;
  let wake: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The client of the attempt in flight (not online yet) and how to abandon it. */
  let pending: { client: GameClient; cancel: () => void } | null = null;

  /** Closes the in-flight attempt's client and makes that attempt resolve as cancelled. */
  const cancelPending = () => {
    const p = pending;
    pending = null;
    p?.cancel();
    p?.client.close();
  };

  const cancelRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    wake?.();
    wake = null;
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        wake = null;
        resolve();
      }, ms);
    });

  const current = (gen: number, client: GameClient) => gen === generation && state.client === client;

  /** Ends an established client for good (terminal kick or signed out). */
  const fail = (gen: number, client: GameClient, status: 'kicked' | 'failed', reason: string) => {
    if (!current(gen, client)) return;
    deps.stopSandbox();
    deps.capture.clear();
    deps.chat?.clear();
    deps.clusters?.clear();
    deps.exchange?.clear();
    deps.listings?.clear();
    deps.trades?.clear();
    deps.arena?.clear();
    deps.incident?.resync();
    client.close();
    set({ status, kickReason: reason, client: null });
  };

  async function attempt(gen: number, role: Role): Promise<Attempt> {
    let ticketError: unknown = null;
    let kick: string | null = null;
    const auth: TokenSource = {
      getToken: async () => {
        try {
          return await deps.fetchTicket();
        } catch (err) {
          ticketError = err;
          // once established, the SDK retries a failed getToken forever; a gone session cannot recover
          if (isSignedOut(err) && current(gen, c)) queueMicrotask(() => fail(gen, c, 'failed', SIGNED_OUT));
          throw err;
        }
      },
    };
    const c = deps.createClient({ url: deps.url(), auth, role });
    /** Registers a listener that only acts while `c` is this store's current client. */
    const on: GameClient['on'] = (name, handler) =>
      c.on(name, (value) => {
        if (current(gen, c)) handler(value);
      });
    c.on('kick', (reason) => {
      if (!current(gen, c)) {
        kick = reason;
        return;
      }
      if (TRANSIENT_KICKS.has(reason)) {
        deps.log.push('system', `disconnected (${reason}): reconnecting`);
        return;
      }
      deps.log.push('system', `kicked: ${reason}`);
      fail(gen, c, 'kicked', reason);
    });
    on('tick', (tick) => {
      deps.incident?.prune(tick);
      set({ version: state.version + 1 });
    });
    on('captureStart', (e) => deps.capture.start(e));
    on('captureResult', (e) => deps.capture.result(e));
    // chat goes into a store wired here, not into panel effects: lines arrive whether or not the Chat tab is open
    on('chat', (line) => deps.chat?.push(line));
    on('chatDeleted', (d) => deps.chat?.remove(d.id));
    on('muted', (d) => {
      deps.chat?.setMuted(d.until);
      deps.log.push('system', d.until ? `you are muted until ${new Date(d.until).toLocaleString()}` : 'your mute was lifted');
    });
    // invites are captured here, not in a panel effect: they arrive whether or not the Chat tab is open
    on('clusterInvite', (inv) => {
      deps.clusters?.push(inv);
      deps.log.push('event', `${inv.name ?? 'an operator'} invites you to a cluster (chat tab)`);
    });
    // Incidents are server-wide: the store is fed here, not by the banner, so the phase is known whichever tab is open
    on('incident', (e) => {
      deps.incident?.onEvent(e);
      deps.log.push('event', describeIncidentEvent(e));
      // open: the Incidents tab and the admin panel list the new row; cleared / expired: the outcome
      if (e.phase === 'open' || e.phase === 'cleared' || e.phase === 'expired') deps.invalidateIncidents?.();
    });
    on('telegraph', (t) => deps.incident?.onTelegraph({ x: t.x, y: t.y, radius: t.radius, atTick: t.atTick }));
    on('incidentReward', (e) => deps.log.push('event', `Incident reward: ${e.reward} bits for ${Math.round(e.share * 100)}% of the damage`));
    on('disconnect', () => {
      deps.capture.clear();
      if (state.status === 'online') set({ status: 'reconnecting' });
    });
    on('reconnect', () => {
      // before the snapshot and the server's re-sent mute: chat refetches the history it may have missed
      deps.chat?.reconnected();
      // the end of an Incident may have been missed while away: forget it and ask the API what is running
      deps.incident?.resync();
      deps.invalidateIncidents?.();
      deps.invalidateExchange?.();
      deps.invalidateListings?.();
      deps.invalidateTrades?.();
      // a queue entry may not have survived the outage; a result or challenge may have been missed
      deps.arena?.onReconnect();
      deps.invalidateArena?.();
      set({ status: 'online' });
      deps.log.push('system', 'reconnected');
    });
    on('error', (e) => deps.log.push('reject', e.message));
    on('scriptError', (e) => deps.log.push('error', String((e as Error)?.message ?? e)));
    on('levelUp', (e) => deps.log.push('event', `${e.daemon} reached level ${e.level}`));
    on('captureResult', (e) => deps.log.push('event', e.ok ? `captured ${e.daemon?.species ?? 'to Disk'}` : `capture failed: ${e.reason}`));
    on('signatureSpawn', (e) => deps.log.push('event', `${e.clean ? 'clean' : ''}${e.signature ? ` T${e.signature}` : ''} ${e.species} spawned somewhere in the subnet`));
    on('crash', (e) => deps.log.push('event', `${e.daemon} crashed`));
    on('evolved', (e) => deps.log.push('event', `${e.daemon} evolved: ${e.from} -> ${e.to}`));
    on('travelled', (e) => deps.log.push('event', `travelled ${e.from} -> ${e.to}`));
    on('bits', (e) => deps.log.push('event', `${e.delta >= 0 ? '+' : ''}${e.delta} bits (${e.reason}) → ${e.balance}`));
    on('decompiled', (e) => deps.log.push('event', `decompiled ${e.species} into ${Object.entries(e.fragments).map(([k, v]) => `${v} ${k}`).join(', ')}`));
    on('ticketProgress', (e) => deps.log.push('event', `ticket ${e.ticketId}: ${e.progress}/${e.target}`));
    // fills are captured here, not in the Exchange panel: they arrive whether or not that tab is open. Every exchange
    // event makes the orders, book and vault queries refetch (a fill moved items and bits).
    on('exchange', (e) => {
      if (e.kind === 'listingSold') {
        // captured here too: a sale arrives whether or not the Exchange or Disk tab is open
        const sale = parseSale(e.detail);
        if (sale) {
          deps.listings?.push(sale);
          // the buyer's own panel already logged the purchase
          if (sale.role === 'seller') deps.log.push('event', `Exchange: your ${sale.species} sold for ${sale.price} bits (${sale.price - sale.fee} after the fee)`);
        } else deps.log.push('event', `Exchange: ${e.kind}`);
        deps.invalidateListings?.();
        return;
      }
      if (e.kind === 'trade') {
        // captured here too: a trade changes whether or not the Exchange tab is open (every change refetches
        // trades, Disk, vault and ledger: offers lock daemons, a completed trade moves items, bits and daemons)
        const note = parseTradeNote(e.detail);
        if (note) {
          deps.trades?.push(note);
          if (note.status === 'DONE') deps.log.push('event', 'Exchange: trade completed');
          else if (note.status === 'CANCELLED') deps.log.push('event', 'Exchange: trade cancelled');
        } else deps.log.push('event', `Exchange: ${e.kind}`);
        deps.invalidateTrades?.();
        return;
      }
      const fill = e.kind === 'fill' ? parseFill(e.detail) : null;
      if (fill) {
        deps.exchange?.push(fill);
        deps.log.push('event', `Exchange: ${describeFill(fill)}`);
      } else deps.log.push('event', `Exchange: ${e.kind}`);
      deps.invalidateExchange?.();
    });
    // arena state is captured here, not in the Arena tab: queue changes, challenges and results arrive whether or not it is open
    on('arenaQueued', (e) => {
      deps.arena?.onQueued(e.mode, e.reason, Date.now());
      if (!e.mode && e.reason) deps.log.push('event', `Arena: left the queue (${e.reason})`);
    });
    on('arenaMatch', (e) => {
      deps.arena?.onMatch();
      deps.log.push('event', `Arena: ${e.mode} match against ${e.opponent.name ?? 'an operator'} (${Math.round(e.opponent.rating)})`);
    });
    on('arenaResult', (e) => {
      deps.arena?.onResult(e);
      deps.log.push('event', `Arena: ${resultText(e)}`);
      // the standing, ladder and history changed (the result may arrive after the return home, or long after the match)
      deps.invalidateArena?.();
    });
    on('arenaChallenge', (c) => {
      deps.arena?.onChallenge(c);
      deps.log.push('event', `${c.name ?? 'an operator'} challenges you to a ${c.mode} match (arena tab)`);
    });
    on('ticketDone', (e) => {
      deps.log.push('event', e.unpaid ? `ticket ${e.ticketId} closed without payout` : `ticket ${e.ticketId} done: +${e.reward} bits`);
      deps.invalidateTickets?.();
    });
    // a snapshot after the first one (travel) swaps the whole world: re-render without waiting for the next tick
    /** The subnet of the last snapshot this store saw (set when the client goes online). */
    let subnet: string | null = null;
    on('ready', () => {
      if (subnet !== null && c.subnet !== subnet) {
        // travelled: the target belonged to the old subnet, and a selected actor must still be in RAM
        const { actor } = getControls();
        const keep = actor === 'self' || c.self.ram.some((d) => d.id === actor);
        setControls({ targetId: null, actor: keep ? actor : 'self' });
        deps.incident?.clearTelegraphs();
      }
      subnet = c.subnet;
      set({ version: state.version + 1 });
    });
    on('discovery', (e) => {
      deps.log.push('event', `${e.operatorName ?? 'someone'} discovered ${e.form}`);
      deps.invalidateCodex();
    });

    // The SDK's start() does not settle when closed while it is still fetching the ticket, so a
    // cancelled attempt is settled through this race instead.
    let cancel!: () => void;
    const cancelled = new Promise<'cancelled'>((resolve) => (cancel = () => resolve('cancelled')));
    const mine = { client: c, cancel };
    pending = mine;
    try {
      const r = await Promise.race([c.start(), cancelled]);
      if (r === 'cancelled') return { kind: 'cancelled' };
    } catch (err) {
      c.close();
      if (gen !== generation) return { kind: 'cancelled' };
      if (isSignedOut(ticketError)) return { kind: 'terminal', status: 'failed', reason: SIGNED_OUT };
      if (kick !== null && !RETRYABLE_KICKS.has(kick)) return { kind: 'terminal', status: 'kicked', reason: kick };
      return { kind: 'retry', reason: kick ?? (err instanceof Error ? err.message : String(err)) };
    } finally {
      if (pending === mine) pending = null;
    }
    if (gen !== generation) {
      c.close();
      return { kind: 'cancelled' };
    }
    subnet = c.subnet;
    setMe(c.operatorId);
    set({ status: 'online', client: c, role, kickReason: null });
    deps.invalidateIncidents?.();
    deps.log.push('system', `connected as ${role}`);
    return { kind: 'online' };
  }

  /**
   * Connects as `role`, replacing any current connection. Resolves once online (or when a later
   * open/close supersedes it); rejects only on a terminal failure (status `kicked` / `failed`).
   */
  async function open(role: Role): Promise<void> {
    const gen = ++generation;
    cancelRetry();
    cancelPending();
    deps.stopSandbox();
    deps.capture.clear();
    deps.clusters?.clear();
    deps.arena?.clear();
    deps.incident?.resync();
    state.client?.close();
    set({ status: 'connecting', role, client: null, kickReason: null });
    let unauthorized = 0;
    for (let retries = 0; ; retries++) {
      const r = await attempt(gen, role);
      if (gen !== generation || r.kind === 'online' || r.kind === 'cancelled') return;
      if (r.kind === 'retry' && r.reason === 'unauthorized' && ++unauthorized >= MAX_UNAUTHORIZED_RETRIES) {
        set({ status: 'failed', kickReason: REJECTED });
        deps.log.push('error', `connect failed: ${REJECTED}`);
        throw new Error(REJECTED);
      }
      if (r.kind === 'retry' && r.reason !== 'unauthorized') unauthorized = 0;
      if (r.kind === 'terminal') {
        set({ status: r.status, kickReason: r.reason });
        deps.log.push('error', `connect failed: ${r.reason}`);
        throw new Error(r.reason);
      }
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retries);
      deps.log.push('error', `connect failed: ${r.reason}; retrying in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      if (gen !== generation) return;
    }
  }

  function close(): void {
    generation++;
    cancelRetry();
    cancelPending();
    deps.stopSandbox();
    deps.capture.clear();
    deps.chat?.clear();
    deps.clusters?.clear();
    deps.exchange?.clear();
    deps.listings?.clear();
    deps.trades?.clear();
    deps.arena?.clear();
    deps.incident?.resync();
    state.client?.close();
    set({ status: 'idle', client: null, kickReason: null });
  }

  return {
    open,
    close,
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const connection = createConnection({
  fetchTicket: fetchTicketFromApi,
  createClient: (opts) => new GameClient(opts),
  url: wsUrl,
  log: appLog,
  capture: appCapture,
  chat: chatStore,
  clusters: clusterStore,
  incident: incidentStore,
  exchange: exchangeStore,
  listings: listingStore,
  trades: tradeStore,
  arena: arenaStore,
  stopSandbox,
  invalidateCodex: () => store.dispatch(api.util.invalidateTags(['Codex'])),
  invalidateTickets: () => store.dispatch(api.util.invalidateTags(['Tickets'])),
  invalidateIncidents: () => store.dispatch(api.util.invalidateTags(['Incidents'])),
  invalidateExchange: () => store.dispatch(api.util.invalidateTags(['Orders', 'Book', 'Vault'])),
  invalidateListings: () => store.dispatch(api.util.invalidateTags(['Listings', 'Disk', 'Ledger'])),
  invalidateTrades: () => store.dispatch(api.util.invalidateTags(['Trades', 'Disk', 'Vault', 'Ledger'])),
  invalidateArena: () => store.dispatch(api.util.invalidateTags(['Arena'])),
});

// the sandbox only starts a script on a live socket
setConnectionProbe(() => connection.get().status === 'online');

export const open = (role: Role): Promise<void> => connection.open(role);
export const close = (): void => connection.close();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.get, connection.get);
}

/** The live client, re-rendering on every tick. Components read `client.self` / `client.world` directly. */
export function useGame(): GameClient | null {
  return useConnection().client;
}
