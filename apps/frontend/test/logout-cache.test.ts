import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { clusterStore } from '../src/game/clusters.ts';
import { exchangeStore, listingStore, tradeStore } from '../src/game/exchange.ts';
import { configureStore } from '@reduxjs/toolkit';

afterEach(() => vi.unstubAllGlobals());

describe('session change', () => {
  it('drops every cached query (codex research and hints, tickets) when logout succeeds, and keeps them when it fails', async () => {
    let logoutOk = true;
    // fetchBaseQuery builds a Request from the relative '/api/...' URL, which Node rejects: resolve it against a dummy origin
    const NodeRequest = Request;
    vi.stubGlobal('Request', class extends NodeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = url.includes('/codex') ? { research: { '5': 256 }, hints: [{ formId: 'x', kind: 'k' }] } : url.includes('/auth/logout') ? { ok: true, endSessionUrl: null } : url.includes('/exchange/trades') ? [{ id: 'T1' }] : url.includes('/exchange/vault') ? { 'frag:signal': 2 } : url.includes('/exchange/book/') ? { item: 'frag:heap', bids: [{ price: 9, qty: 1 }], asks: [], fills: [] } : url.includes('/exchange/orders') ? [{ id: 'o1' }] : url.includes('/exchange/listings/mine') ? [{ id: 'L1' }] : url.includes('/exchange/listings') ? { page: 0, more: false, listings: [{ id: 'L1' }] } : url.includes('/exchange/items') ? [{ id: 'frag:heap' }] : url.includes('/orgs/mine') ? { org: null, rank: null, invites: [], prices: { create: 1, tag: 1, rename: 1 } } : [];
      const status = url.includes('/auth/logout') && !logoutOk ? 500 : 200;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }));
    const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (d) => d().concat(api.middleware) });
    await store.dispatch(api.endpoints.codex.initiate());
    await store.dispatch(api.endpoints.ticketHistory.initiate());
    await store.dispatch(api.endpoints.orgMine.initiate());
    await store.dispatch(api.endpoints.vault.initiate());
    await store.dispatch(api.endpoints.book.initiate('frag:heap'));
    await store.dispatch(api.endpoints.myOrders.initiate());
    await store.dispatch(api.endpoints.exchangeItems.initiate());
    await store.dispatch(api.endpoints.listings.initiate({ sort: 'price', page: 0 }));
    await store.dispatch(api.endpoints.myListings.initiate());
    await store.dispatch(api.endpoints.trades.initiate());
    exchangeStore.push({ item: 'frag:heap', price: 9, qty: 1, side: 'buy' });
    listingStore.push({ listingId: 'L1', species: 'pingling', price: 9, fee: 0, role: 'seller' });
    tradeStore.push({ tradeId: 'T1', status: 'OPEN' });
    expect(api.endpoints.vault.select()(store.getState()).data).toEqual({ 'frag:signal': 2 });
    expect(api.endpoints.book.select('frag:heap')(store.getState()).data).toBeDefined();
    expect(api.endpoints.codex.select()(store.getState()).data).toBeDefined();
    logoutOk = false;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(api.endpoints.codex.select()(store.getState()).data).toBeDefined();
    clusterStore.push({ clusterId: 'c1', from: 'bob', name: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(clusterStore.get().invites).toHaveLength(1); // a failed logout keeps them
    expect(exchangeStore.get().fills).toHaveLength(1);
    expect(listingStore.get().sales).toHaveLength(1);
    expect(tradeStore.get().notes).toHaveLength(1);
    expect(api.endpoints.trades.select()(store.getState()).data).toBeDefined();
    expect(api.endpoints.listings.select({ sort: 'price', page: 0 })(store.getState()).data).toBeDefined();
    logoutOk = true;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(clusterStore.get().invites).toEqual([]); // pending invites belong to the operator who just left
    expect(api.endpoints.codex.select()(store.getState()).data).toBeUndefined();
    expect(api.endpoints.ticketHistory.select()(store.getState()).data).toBeUndefined();
    expect(api.endpoints.vault.select()(store.getState()).data).toBeUndefined(); // the previous operator's vault
    expect(api.endpoints.myOrders.select()(store.getState()).data).toBeUndefined(); // their orders
    expect(api.endpoints.book.select('frag:heap')(store.getState()).data).toBeUndefined();
    expect(api.endpoints.exchangeItems.select()(store.getState()).data).toBeUndefined();
    expect(exchangeStore.get().fills).toEqual([]); // and their fills
    expect(listingStore.get().sales).toEqual([]); // their sales
    expect(tradeStore.get().notes).toEqual([]); // their trade changes
    expect(api.endpoints.trades.select()(store.getState()).data).toBeUndefined(); // and their open trades
    expect(api.endpoints.listings.select({ sort: 'price', page: 0 })(store.getState()).data).toBeUndefined(); // the listings browser
    expect(api.endpoints.myListings.select()(store.getState()).data).toBeUndefined(); // and their own listings
    expect(api.endpoints.orgMine.select()(store.getState()).data).toBeUndefined(); // the previous operator's org, invites and prices
  });
});
