import type { TokenSource } from './auth.js';

/**
 * A failed Exchange request: the HTTP status and the api's error code and message. `status` is 0 for failures without
 * a response (`code` `timeout` or `network_error`). `retryAfter` (seconds) is set on a 429 that sent the header.
 * It never carries credentials.
 */
export class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ExchangeError';
  }
}

export interface ExchangeClientOptions {
  /** Origin of the Daemonet api, e.g. `https://daemonet.example` (no trailing `/api`). */
  baseUrl: string;
  /** Bots: a token source (device login, `devToken`). Pages served by Daemonet itself: `'cookie'`. */
  auth: TokenSource | 'cookie';
  /** Defaults to the global `fetch` (Node 18+, browsers). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30 000); a timeout throws `ExchangeError` with code `timeout`. */
  timeoutMs?: number;
  /**
   * Off by default. When set, a 429 is retried after its `retry-after` (a request the limiter refused was not
   * processed, so this is safe for every call) up to `maxRetries` times (default 3), never waiting longer than
   * `maxWaitMs` (default 10 000) - a longer wait throws the 429 instead.
   */
  retryRateLimited?: { maxRetries?: number; maxWaitMs?: number };
  /** Test hook for the retry wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_MAX_WAIT_MS = 10_000;

/** `retry-after` in seconds (delta form); undefined when absent or unusable. */
function parseRetryAfter(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface ExchangeOffer {
  bits: number;
  items: Record<string, number>;
  daemonIds: string[];
}

export interface ExchangeListingQuery {
  species?: string;
  line?: number;
  type?: string;
  clean?: boolean;
  minSignature?: number;
  maxPrice?: number;
  sort?: 'price' | 'new';
  page?: number;
}

/**
 * REST client for the Exchange (order book, daemon listings, direct trades). Everything it trades lives in the
 * Exchange vault or on Disk; move items in and out at a host with `client.operator.deposit / withdraw`.
 * Responses are returned as the api sends them; failures throw `ExchangeError`.
 */
export class ExchangeClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ExchangeClientOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}/api/exchange`;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const bearer = this.opts.auth !== 'cookie';
    let token = bearer ? await (this.opts.auth as TokenSource).getToken() : '';
    let refreshed = false;
    let rateRetries = 0;
    for (;;) {
      const headers: Record<string, string> = {};
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) };
      if (!bearer) {
        init.credentials = 'include';
        headers['x-requested-with'] = 'daemonet';
      } else {
        headers.authorization = `Bearer ${token}`;
      }
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      let res: Response;
      let text: string;
      try {
        res = await this.doFetch(`${this.base}${path}`, init);
        text = await res.text();
      } catch (e) {
        if (init.signal?.aborted) throw new ExchangeError(0, 'timeout', 'request timed out');
        throw new ExchangeError(0, 'network_error', e instanceof Error ? e.message : 'request failed');
      }
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // not JSON: reported below with the status
      }
      if (res.ok) return data as T;
      const err = (data && typeof data === 'object' ? data : {}) as { error?: string; message?: string };
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 401 && bearer && !refreshed) {
        // the token source refreshes on demand; retry once, and only with a different token
        refreshed = true;
        const next = await (this.opts.auth as TokenSource).getToken();
        if (next !== token) {
          token = next;
          continue;
        }
      }
      if (res.status === 429 && this.opts.retryRateLimited && retryAfter !== undefined) {
        const { maxRetries = DEFAULT_RETRIES, maxWaitMs = DEFAULT_MAX_WAIT_MS } = this.opts.retryRateLimited;
        if (rateRetries < maxRetries && retryAfter * 1000 <= maxWaitMs) {
          rateRetries++;
          await (this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(retryAfter * 1000);
          continue;
        }
      }
      throw new ExchangeError(res.status, typeof err.error === 'string' ? err.error : 'http_error', typeof err.message === 'string' ? err.message : `HTTP ${res.status}`, retryAfter);
    }
  }

  // ---- vault and order book
  vault() {
    return this.call<Record<string, number>>('GET', '/vault');
  }
  items() {
    return this.call<Array<{ id: string; name: string; kind: string; bid: number | null; ask: number | null }>>('GET', '/items');
  }
  book(item: string) {
    return this.call<{ item: string; bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }>; fills: Array<{ price: number; qty: number; at: string }> }>('GET', `/book/${encodeURIComponent(item)}`);
  }
  orders() {
    return this.call<Array<{ id: string; item: string; side: 'BUY' | 'SELL'; price: number; qty: number; remaining: number; status: string }>>('GET', '/orders');
  }
  placeOrder(order: { item: string; side: 'BUY' | 'SELL'; price: number; qty: number }) {
    return this.call<{ order: { id: string; status: string; remaining: number }; fills: Array<{ price: number; qty: number; fee: number }> }>('POST', '/orders', order);
  }
  cancelOrder(id: string) {
    return this.call<{ ok: boolean }>('DELETE', `/orders/${encodeURIComponent(id)}`);
  }

  // ---- daemon listings
  listings(query: ExchangeListingQuery = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.call<{ page: number; more: boolean; listings: Array<{ id: string; price: number; sellerId: string; daemon: { id: string; species: string; level: number } & Record<string, unknown> }> }>('GET', `/listings${qs ? `?${qs}` : ''}`);
  }
  myListings() {
    return this.call<Array<{ id: string; price: number; status: string; species: string; level: number }>>('GET', '/listings/mine');
  }
  /** Lists a Disk daemon at a fixed price; it stays on your Disk, locked, until it sells, expires or you `unlist` it. */
  list(daemonId: string, price: number) {
    return this.call<{ id: string; price: number; expiresAt: string }>('POST', '/listings', { daemonId, price });
  }
  unlist(listingId: string) {
    return this.call<{ ok: boolean }>('DELETE', `/listings/${encodeURIComponent(listingId)}`);
  }
  buy(listingId: string) {
    return this.call<{ daemonId: string; slot: number; price: number; fee: number }>('POST', `/listings/${encodeURIComponent(listingId)}/buy`);
  }

  // ---- direct trades
  trades() {
    return this.call<ExchangeTrade[]>('GET', '/trades');
  }
  openTrade(target: { id: string } | { name: string }) {
    return this.call<ExchangeTrade>('POST', '/trades', 'id' in target ? { withId: target.id } : { withName: target.name });
  }
  /** Replaces your offer. Clears both confirmations. */
  offer(tradeId: string, offer: ExchangeOffer) {
    return this.call<ExchangeTrade>('PUT', `/trades/${encodeURIComponent(tradeId)}/offer`, offer);
  }
  /** Confirms the offers as of `version` (from the trade you last looked at); fails with `stale_offer` if they changed since. */
  confirm(tradeId: string, version: number) {
    return this.call<ExchangeTrade>('POST', `/trades/${encodeURIComponent(tradeId)}/confirm`, { version });
  }
  cancelTrade(tradeId: string) {
    return this.call<ExchangeTrade>('POST', `/trades/${encodeURIComponent(tradeId)}/cancel`);
  }
}

interface TradeSide {
  id: string;
  name: string | null;
  confirmed: boolean;
  offer: { bits: number; items: Record<string, number>; daemons: Array<{ id: string; species: string; level: number } & Record<string, unknown>> };
}
export interface ExchangeTrade {
  id: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  version: number;
  createdAt: string;
  updatedAt: string;
  me: TradeSide;
  them: TradeSide;
}
