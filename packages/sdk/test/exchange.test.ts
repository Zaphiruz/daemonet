import { describe, expect, expectTypeOf, it } from 'vitest';
import { devToken, type TokenSource } from '../src/auth.js';
import {
  ExchangeClient,
  ExchangeError,
  type ExchangeDaemon,
  type ExchangeListing,
  type ExchangeListingStatus,
  type ExchangeMyListing,
  type ExchangeOrder,
  type ExchangeOrderStatus,
  type ExchangeTrade,
  type ExchangeTradeStatus,
} from '../src/exchange.js';

type Answer = { status?: number; body: unknown; headers?: Record<string, string> } | Error;

/** A fetch that records requests and answers from a queue. */
function fakeFetch(answers: Answer[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown; credentials: string | undefined; signal: AbortSignal | null | undefined }> = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      credentials: init.credentials,
      signal: init.signal,
    });
    const a = answers.shift() ?? { body: null };
    if (a instanceof Error) throw a;
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: a.headers });
  }) as typeof fetch;
  return { fn, calls };
}

describe('ExchangeClient', () => {
  it('sends bearer requests to /api/exchange and returns the JSON', async () => {
    const f = fakeFetch([{ body: { 'frag:packet': 3 } }, { body: { order: { id: 'o1', status: 'OPEN', remaining: 2 }, fills: [] } }, { body: { page: 0, more: false, listings: [] } }, { body: { id: 't1', version: 0 } }]);
    const ex = new ExchangeClient({ baseUrl: 'https://daemonet.test/', auth: devToken('bot'), fetch: f.fn });
    expect(await ex.vault()).toEqual({ 'frag:packet': 3 });
    expect((await ex.placeOrder({ item: 'frag:packet', side: 'SELL', price: 20, qty: 2 })).order.id).toBe('o1');
    await ex.listings({ species: 'pingling', clean: true, maxPrice: 500 });
    await ex.openTrade({ name: 'alice' });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://daemonet.test/api/exchange/vault',
      'POST https://daemonet.test/api/exchange/orders',
      'GET https://daemonet.test/api/exchange/listings?species=pingling&clean=true&maxPrice=500',
      'POST https://daemonet.test/api/exchange/trades',
    ]);
    expect(f.calls[0]!.headers).toEqual({ authorization: 'Bearer dev:bot' });
    expect(f.calls[1]).toMatchObject({ headers: { authorization: 'Bearer dev:bot', 'content-type': 'application/json' }, body: { item: 'frag:packet', side: 'SELL', price: 20, qty: 2 } });
    expect(f.calls[3]!.body).toEqual({ withName: 'alice' });
  });

  it('uses the session cookie and the CSRF header in a page', async () => {
    const f = fakeFetch([{ body: [] }, { body: { id: 't1' } }, { body: { ok: true } }]);
    const ex = new ExchangeClient({ baseUrl: '', auth: 'cookie', fetch: f.fn });
    await ex.trades();
    await ex.confirm('t 1', 4);
    await ex.cancelOrder('o1');
    expect(f.calls[0]).toMatchObject({ url: '/api/exchange/trades', credentials: 'include', headers: { 'x-requested-with': 'daemonet' } });
    // mutations carry the CSRF header the api requires of cookie sessions, and never a bearer token
    expect(f.calls[1]).toMatchObject({ url: '/api/exchange/trades/t%201/confirm', method: 'POST', credentials: 'include', body: { version: 4 } });
    expect(f.calls[1]!.headers).toEqual({ 'x-requested-with': 'daemonet', 'content-type': 'application/json' });
    expect(f.calls[2]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(f.calls[2]!.headers).toEqual({ 'x-requested-with': 'daemonet' });
  });

  it('types every field the api returns, with statuses as the api`s enums', () => {
    const log = { originalOperatorId: 'op', capturedAt: '2026-10-01T00:00:00.000Z', subnet: 'lo', tool: 'sniff', spawnIndex: null };
    const daemon: ExchangeDaemon = {
      id: 'd1', species: 'pingling', level: 8, xp: 0, nature: 0, traitSlot: 0, ivs: [1], bonus: [0], clean: false, signature: 0,
      moves: ['ping'], heldItem: null, patched: false, crashes: 0, arenaWins: 0, history: [{ at: '2026-10-01T00:00:00.000Z', kind: 'captured', detail: 'x' }], log,
    };
    const order: ExchangeOrder = { id: 'o1', item: 'frag:packet', side: 'BUY', price: 5, qty: 2, remaining: 2, status: 'OPEN', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z' };
    type Placed = Awaited<ReturnType<ExchangeClient['placeOrder']>>;
    const placed: Placed = { order: { id: 'o1', item: 'frag:packet', side: 'SELL', price: 5, qty: 2, remaining: 0, status: 'FILLED', expiresAt: '2026-10-02T00:00:00.000Z' }, fills: [{ price: 5, qty: 2, fee: 0 }] };
    const listing: ExchangeListing = { id: 'l1', price: 90, sellerId: 'op', sellerName: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', daemon };
    const mine: ExchangeMyListing = { id: 'l1', price: 90, status: 'SOLD', species: 'pingling', level: 8, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', soldAt: null, daemon: null };
    const trade: ExchangeTrade = {
      id: 't1', status: 'DONE', version: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      me: { id: 'a', name: 'alice', confirmed: true, offer: { bits: 5, items: {}, daemons: [daemon] } },
      them: { id: 'b', name: null, confirmed: true, offer: { bits: 0, items: { 'frag:packet': 1 }, daemons: [{ id: 'd2', species: 'pingling', level: 3 }] } },
    };
    expectTypeOf<Awaited<ReturnType<ExchangeClient['orders']>>>().toEqualTypeOf<ExchangeOrder[]>();
    expectTypeOf<Awaited<ReturnType<ExchangeClient['listings']>>['listings']>().toEqualTypeOf<ExchangeListing[]>();
    expectTypeOf<Awaited<ReturnType<ExchangeClient['myListings']>>>().toEqualTypeOf<ExchangeMyListing[]>();
    expectTypeOf<ExchangeOrder['status']>().toEqualTypeOf<ExchangeOrderStatus>();
    expectTypeOf<ExchangeOrderStatus>().toEqualTypeOf<'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED'>();
    expectTypeOf<Placed['order']['status']>().toEqualTypeOf<ExchangeOrderStatus>();
    expectTypeOf<ExchangeMyListing['status']>().toEqualTypeOf<ExchangeListingStatus>();
    expectTypeOf<ExchangeListingStatus>().toEqualTypeOf<'ACTIVE' | 'SOLD' | 'CANCELLED' | 'EXPIRED'>();
    expectTypeOf<ExchangeTrade['status']>().toEqualTypeOf<ExchangeTradeStatus>();
    expectTypeOf<ExchangeTradeStatus>().toEqualTypeOf<'OPEN' | 'DONE' | 'CANCELLED'>();
    expect([order, placed, listing, mine, trade].length).toBe(5);
  });

  it('throws ExchangeError with the api code, or http_error for non-JSON failures', async () => {
    const f = fakeFetch([{ status: 402, body: { error: 'insufficient_bits', message: 'costs 160 bits' } }, { status: 502, body: '<html>bad gateway</html>' }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    const e1 = await ex.buy('l1').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ExchangeError);
    expect(e1).toMatchObject({ status: 402, code: 'insufficient_bits', message: 'insufficient_bits: costs 160 bits' });
    expect(await ex.vault().catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'http_error' });
  });

  it('maps every route to its method, path and body', async () => {
    const f = fakeFetch([]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    await ex.items();
    await ex.book('frag:packet');
    await ex.orders();
    await ex.cancelOrder('o 1');
    await ex.myListings();
    await ex.list('d1', 90);
    await ex.unlist('l1');
    await ex.buy('l1');
    await ex.openTrade({ id: 'op1' });
    await ex.offer('t1', { bits: 5, items: { 'frag:packet': 2 }, daemonIds: ['d1'] });
    await ex.cancelTrade('t1');
    expect(f.calls.map((c) => `${c.method} ${c.url.slice('http://x/api/exchange'.length)}`)).toEqual([
      'GET /items',
      'GET /book/frag%3Apacket',
      'GET /orders',
      'DELETE /orders/o%201',
      'GET /listings/mine',
      'POST /listings',
      'DELETE /listings/l1',
      'POST /listings/l1/buy',
      'POST /trades',
      'PUT /trades/t1/offer',
      'POST /trades/t1/cancel',
    ]);
    expect(f.calls[5]!.body).toEqual({ daemonId: 'd1', price: 90 });
    expect(f.calls[8]!.body).toEqual({ withId: 'op1' });
    expect(f.calls[9]!.body).toEqual({ bits: 5, items: { 'frag:packet': 2 }, daemonIds: ['d1'] });
    expect(f.calls[3]!.headers['content-type']).toBeUndefined();
  });

  it('refreshes the token once on a 401 and retries; a second 401 is an error', async () => {
    let n = 0;
    const auth: TokenSource = { getToken: async () => `tok${n++ === 0 ? 'A' : 'B'}` };
    const f = fakeFetch([{ status: 401, body: { error: 'unauthorized', message: 'bad token' } }, { body: { x: 1 } }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth, fetch: f.fn });
    expect(await ex.vault()).toEqual({ x: 1 });
    expect(f.calls.map((c) => c.headers.authorization)).toEqual(['Bearer tokA', 'Bearer tokB']);

    const g = fakeFetch([{ status: 401, body: { error: 'unauthorized', message: 'no' } }, { status: 401, body: { error: 'unauthorized', message: 'still no' } }, { body: {} }]);
    const ex2 = new ExchangeClient({ baseUrl: 'http://x', auth: { getToken: async () => `t${n++}` }, fetch: g.fn });
    expect(await ex2.vault().catch((e: unknown) => e)).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(g.calls).toHaveLength(2);
  });

  it('does not retry an unchanged token on 401, and never puts the token in an error', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'unauthorized', message: 'bad token' } }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: { getToken: async () => 'secret-token-123' }, fetch: f.fn });
    const e = (await ex.vault().catch((x: unknown) => x)) as ExchangeError;
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify({ m: e.message, s: e.stack?.split('\n')[0], e: Object.entries(e) })).not.toContain('secret-token-123');
  });

  it('a cookie page does not retry on 401', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'unauthorized', message: 'no session' } }, { body: {} }]);
    const ex = new ExchangeClient({ baseUrl: '', auth: 'cookie', fetch: f.fn });
    await expect(ex.vault()).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(1);
  });

  it('429 carries retry-after and is not retried by default', async () => {
    const f = fakeFetch([{ status: 429, body: { error: 'rate_limited', message: 'rate limit exceeded' }, headers: { 'retry-after': '7' } }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    const e = (await ex.vault().catch((x: unknown) => x)) as ExchangeError;
    expect(e).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 7 });
    expect(f.calls).toHaveLength(1);
  });

  it('retries a 429 after retry-after when enabled, within the cap', async () => {
    const slept: number[] = [];
    const rl = { status: 429, body: { error: 'rate_limited', message: 'x' }, headers: { 'retry-after': '2' } };
    const f = fakeFetch([rl, rl, { body: { ok: 1 } }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn, retryRateLimited: { maxRetries: 2, maxWaitMs: 5000 }, sleep: async (ms) => void slept.push(ms) });
    expect(await ex.vault()).toEqual({ ok: 1 });
    expect(slept).toEqual([2000, 2000]);

    const g = fakeFetch([rl, rl, rl, { body: {} }]);
    const ex2 = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: g.fn, retryRateLimited: { maxRetries: 2 }, sleep: async () => {} });
    await expect(ex2.vault()).rejects.toMatchObject({ status: 429 });
    expect(g.calls).toHaveLength(3);

    const long = fakeFetch([{ ...rl, headers: { 'retry-after': '60' } }, { body: {} }]);
    const ex3 = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: long.fn, retryRateLimited: { maxRetries: 2, maxWaitMs: 5000 }, sleep: async () => {} });
    await expect(ex3.vault()).rejects.toMatchObject({ status: 429, retryAfter: 60 });
    expect(long.calls).toHaveLength(1);
  });

  it('passes an abort signal and reports a timeout as ExchangeError', async () => {
    const f = fakeFetch([{ body: {} }]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    await ex.vault();
    expect(f.calls[0]!.signal).toBeInstanceOf(AbortSignal);

    const hang = ((_: unknown, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const slow = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: hang, timeoutMs: 20 });
    expect(await slow.vault().catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('reports a network failure as ExchangeError network_error', async () => {
    const f = fakeFetch([new TypeError('fetch failed')]);
    const ex = new ExchangeClient({ baseUrl: 'http://x', auth: devToken('bot'), fetch: f.fn });
    expect(await ex.vault().catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'network_error' });
  });
});
