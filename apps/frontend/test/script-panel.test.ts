// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Monaco needs a real browser: stand in a textarea that reports changes like the editor does.
vi.mock('@monaco-editor/react', () => ({
  loader: { config: () => {} },
  default: (props: { value: string; onChange: (v: string) => void }) =>
    createElement('textarea', { 'data-testid': 'ed', value: props.value, onChange: (e: { target: { value: string } }) => props.onChange(e.target.value) }),
}));
vi.mock('monaco-editor', () => ({
  typescript: {
    javascriptDefaults: { setCompilerOptions: () => {}, addExtraLib: () => {} },
    ScriptTarget: { ES2020: 7 },
    ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { NodeJs: 2 },
  },
}));
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/language/typescript/ts.worker.js?worker', () => ({ default: class {} }));

import { api } from '../src/api.ts';
import { log } from '../src/game/log.ts';
import { AUTOSAVE_MS, ScriptPanel } from '../src/panels/ScriptPanel.tsx';

type Reply = { status: number; body: unknown };
let putReplies: Reply[];
let puts: string[];
let server: { source: string; version: number };

const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  putReplies = [];
  puts = [];
  server = { source: 'start', version: 1 };
  // Node's Request rejects the relative URLs fetchBaseQuery builds from baseUrl '/api'
  const NodeRequest = Request;
  vi.stubGlobal(
    'Request',
    class extends NodeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(String(input));
      if (req.method === 'PUT') {
        const source = ((await req.json()) as { source: string }).source;
        puts.push(source);
        const reply = putReplies.shift();
        if (reply) return json(reply);
        server = { source, version: server.version + 1 };
        return json({ status: 200, body: { version: server.version, updatedAt: 'now' } });
      }
      if (req.url.endsWith('/scripts/main/versions')) return json({ status: 200, body: [] });
      return json({ status: 200, body: { ...server, updatedAt: null } });
    }),
  );
  log.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (gdm) => gdm().concat(api.middleware) });
  render(createElement(Provider, { store, children: createElement(ScriptPanel, { client: null }) }));
  await screen.findByTestId('ed');
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};
const status = () => screen.getByTestId('script-status').textContent ?? '';

describe('ScriptPanel autosave', () => {
  it('surfaces a failed save, keeps the text dirty, and a later save clears it', async () => {
    await mount();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    putReplies.push({ status: 413, body: { error: 'payload_too_large' } });

    fireEvent.change(screen.getByTestId('ed'), { target: { value: 'edited' } });
    expect(status()).toContain('unsaved');
    await act(async () => void (await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10)));
    await flush();

    expect(puts).toEqual(['edited']);
    expect(status()).toContain('save failed');
    expect(log.get().some((e) => e.kind === 'error' && e.text === 'autosave failed: script too large (max 256 KiB)')).toBe(true);
    expect((screen.getByTestId('ed') as HTMLTextAreaElement).value).toBe('edited');

    fireEvent.change(screen.getByTestId('ed'), { target: { value: 'edited again' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10)));
    await flush();

    expect(puts).toEqual(['edited', 'edited again']);
    expect(status()).toContain('· saved');
    expect(status()).not.toContain('failed');
    expect((screen.getByTestId('ed') as HTMLTextAreaElement).value).toBe('edited again');
  });

  it('reports a signed-out save as such', async () => {
    await mount();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    putReplies.push({ status: 401, body: {} });
    fireEvent.change(screen.getByTestId('ed'), { target: { value: 'x' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10)));
    await flush();
    expect(log.get().some((e) => e.text === 'autosave failed: signed out')).toBe(true);
  });
});
