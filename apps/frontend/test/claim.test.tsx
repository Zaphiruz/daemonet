// @vitest-environment jsdom
import type { GameClient } from '@daemonet/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useMeQuery: () => ({ data: { id: 'op', name: 'alice', bits: 0, isAdmin: false }, isLoading: false, isError: false }),
  useLogoutMutation: () => [vi.fn()],
  useIncidentsQuery: () => ({ data: undefined }),
}));
vi.mock('../src/game/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/game/connection.ts')>()),
  useConnection: () => ({ status: 'online', role: (q.client as { role: string } | null)?.role ?? 'controller', client: q.client, kickReason: null }),
  open: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/components/WorldCanvas.tsx', () => ({
  WorldCanvas: () => <canvas data-testid="world" />,
  run: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
}));

import { App } from '../src/App.tsx';
import { ClaimStarter, defaultOperatorName } from '../src/panels/ClaimStarter.tsx';

afterEach(cleanup);

function fakeClient(over: { claimed: boolean; role?: 'controller' | 'spectator'; claimStarter?: () => Promise<unknown> }) {
  const claimStarter = vi.fn(over.claimStarter ?? (() => Promise.resolve({ ok: true })));
  const client = {
    role: over.role ?? 'controller',
    tick: 1,
    subnet: 'lo',
    self: { starterClaimed: over.claimed, name: over.claimed ? 'alice' : null, x: 0, y: 0, running: [], ram: [], inventory: {}, bits: 0, capture: null },
    world: { gateways: [] },
    operator: { claimStarter },
    entities: new Map(),
  };
  return { client: client as unknown as GameClient, claimStarter };
}

describe('defaultOperatorName', () => {
  it('is the starter plus four characters the name filter accepts', () => {
    expect(defaultOperatorName('pingling', () => 0)).toBe('pingling-aaaa');
    expect(defaultOperatorName('nullpup')).toMatch(/^nullpup-[a-z0-9]{4}$/);
  });
});

describe('ClaimStarter', () => {
  it('prefills a name that follows the starter pick until the player types', () => {
    const { client, claimStarter } = fakeClient({ claimed: false });
    render(<ClaimStarter client={client} />);
    const input = screen.getByTestId('name-input') as HTMLInputElement;
    expect(input.value).toMatch(/^pingling-[a-z0-9]{4}$/);
    fireEvent.change(screen.getByTestId('starter-select'), { target: { value: 'hashling' } });
    expect(input.value).toMatch(/^hashling-[a-z0-9]{4}$/);
    fireEvent.click(screen.getByTestId('claim'));
    expect(claimStarter).toHaveBeenCalledWith('hashling', input.value);
  });

  it('uses the typed name, and falls back to the suggestion when the field is emptied', async () => {
    const { client, claimStarter } = fakeClient({ claimed: false });
    render(<ClaimStarter client={client} />);
    const input = screen.getByTestId('name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bob' } });
    fireEvent.change(screen.getByTestId('starter-select'), { target: { value: 'nullpup' } });
    expect(input.value).toBe('bob');
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim'));
    });
    expect(claimStarter).toHaveBeenLastCalledWith('nullpup', 'bob');
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim'));
    });
    const [, fallback] = claimStarter.mock.calls.at(-1) as unknown as [string, string];
    expect(fallback).toMatch(/^[a-z]+-[a-z0-9]{4}$/);
  });

  it('shows the refusal under the button and in the log', async () => {
    const { client } = fakeClient({ claimed: false, claimStarter: () => Promise.reject(new Error('that name is not allowed')) });
    render(<ClaimStarter client={client} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('claim'));
    });
    expect(screen.getByTestId('claim-refusal').textContent).toBe('that name is not allowed');
    expect((screen.getByTestId('claim') as HTMLButtonElement).disabled).toBe(false);
  });

  it('is disabled for a spectator', () => {
    const { client } = fakeClient({ claimed: false, role: 'spectator' });
    render(<ClaimStarter client={client} />);
    expect((screen.getByTestId('claim') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('App claim gate', () => {
  it('shows only the claim screen to an unclaimed controller', () => {
    q.client = fakeClient({ claimed: false }).client;
    render(<App />);
    expect(screen.getByTestId('claim')).toBeTruthy();
    expect(screen.queryByTestId('tab-play')).toBeNull();
    expect(screen.queryByTestId('tab-script')).toBeNull();
    expect(screen.getByTestId('world')).toBeTruthy();
  });

  it('shows the tabs once the starter is claimed', () => {
    q.client = fakeClient({ claimed: true }).client;
    render(<App />);
    expect(screen.queryByTestId('claim')).toBeNull();
    expect(screen.getByTestId('tab-play')).toBeTruthy();
    expect(screen.getByTestId('tab-script')).toBeTruthy();
  });

  it('tells a spectator the operator has not claimed yet', () => {
    q.client = fakeClient({ claimed: false, role: 'spectator' }).client;
    render(<App />);
    expect(screen.getByTestId('unclaimed-note')).toBeTruthy();
    expect(screen.queryByTestId('tab-play')).toBeNull();
  });
});
