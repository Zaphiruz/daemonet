import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
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
      const body = url.includes('/codex') ? { research: { '5': 256 }, hints: [{ formId: 'x', kind: 'k' }] } : url.includes('/auth/logout') ? { ok: true, endSessionUrl: null } : [];
      const status = url.includes('/auth/logout') && !logoutOk ? 500 : 200;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }));
    const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (d) => d().concat(api.middleware) });
    await store.dispatch(api.endpoints.codex.initiate());
    await store.dispatch(api.endpoints.ticketHistory.initiate());
    expect(api.endpoints.codex.select()(store.getState()).data).toBeDefined();
    logoutOk = false;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(api.endpoints.codex.select()(store.getState()).data).toBeDefined();
    logoutOk = true;
    await store.dispatch(api.endpoints.logout.initiate());
    expect(api.endpoints.codex.select()(store.getState()).data).toBeUndefined();
    expect(api.endpoints.ticketHistory.select()(store.getState()).data).toBeUndefined();
  });
});
