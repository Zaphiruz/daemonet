import { GameClient, type ConnectOptions, type TokenSource } from '@daemonet/sdk';
import { useSyncExternalStore } from 'react';
import { fetchTicket as fetchTicketFromApi, TicketError } from '../api.ts';
import { log as appLog, type Log } from './log.ts';
import { stop as stopSandbox } from './sandbox.ts';

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
  /** Ends the sandboxed script (its bridge is tied to the client being replaced or lost). */
  stopSandbox(): void;
}

/** Backoff for a first connection that failed: doubles from RETRY_MIN_MS up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/**
 * Kicks before the first snapshot after which another attempt (with a new ticket) can succeed. The
 * SDK's own TRANSIENT_KICKS plus `unavailable` (the store was down) and `unauthorized` (e.g. a ticket
 * that expired in flight; a gone session shows up as a 401 from the ticket endpoint instead).
 */
const RETRYABLE_KICKS: ReadonlySet<string> = new Set(['idle', 'auth timeout', 'server shutting down', 'unavailable', 'unauthorized']);
/** Kicks after which the SDK reconnects an established connection by itself (its TRANSIENT_KICKS). */
const TRANSIENT_KICKS: ReadonlySet<string> = new Set(['idle', 'auth timeout', 'server shutting down']);
const SIGNED_OUT = 'session expired: sign in again';

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
    client.close();
    set({ status, kickReason: reason });
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
    on('tick', () => set({ version: state.version + 1 }));
    on('disconnect', () => {
      if (state.status === 'online') set({ status: 'reconnecting' });
    });
    on('reconnect', () => {
      set({ status: 'online' });
      deps.log.push('system', 'reconnected');
    });
    on('error', (e) => deps.log.push('reject', e.message));
    on('scriptError', (e) => deps.log.push('error', String((e as Error)?.message ?? e)));
    on('levelUp', (e) => deps.log.push('event', `${e.daemon} reached level ${e.level}`));
    on('captureResult', (e) => deps.log.push('event', e.ok ? `captured ${e.daemon?.species ?? 'to Disk'}` : `capture failed: ${e.reason}`));
    on('signatureSpawn', (e) => deps.log.push('event', `${e.clean ? 'clean' : ''}${e.signature ? ` T${e.signature}` : ''} ${e.species} spawned somewhere in the subnet`));
    on('crash', (e) => deps.log.push('event', `${e.daemon} crashed`));

    try {
      await c.start();
    } catch (err) {
      c.close();
      if (gen !== generation) return { kind: 'cancelled' };
      if (isSignedOut(ticketError)) return { kind: 'terminal', status: 'failed', reason: SIGNED_OUT };
      if (kick !== null && !RETRYABLE_KICKS.has(kick)) return { kind: 'terminal', status: 'kicked', reason: kick };
      return { kind: 'retry', reason: kick ?? (err instanceof Error ? err.message : String(err)) };
    }
    if (gen !== generation) {
      c.close();
      return { kind: 'cancelled' };
    }
    set({ status: 'online', client: c, role, kickReason: null });
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
    deps.stopSandbox();
    state.client?.close();
    set({ status: 'connecting', role, client: null, kickReason: null });
    for (let retries = 0; ; retries++) {
      const r = await attempt(gen, role);
      if (r.kind === 'online' || r.kind === 'cancelled') return;
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
    deps.stopSandbox();
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
  stopSandbox,
});

export const open = (role: Role): Promise<void> => connection.open(role);
export const close = (): void => connection.close();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.get, connection.get);
}

/** The live client, re-rendering on every tick. Components read `client.self` / `client.world` directly. */
export function useGame(): GameClient | null {
  return useConnection().client;
}
