// @vitest-environment jsdom
import { NATURES, SCAN_BUCKET_LABELS, STAT_KEYS } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setControls } from '../src/game/controls.ts';
import { PlayPanel } from '../src/panels/PlayPanel.tsx';

vi.mock('../src/render/draw.ts', () => ({ spriteCanvas: () => document.createElement('canvas') }));
afterEach(() => {
  cleanup();
  setControls({ targetId: null });
});

function renderTarget(scan: unknown) {
  const target = { kind: 'daemon', id: 'w1', species: 'pingling', types: ['packet'], level: 3, hp: 10, maxHp: 10, owner: null, taggedBy: null, clean: false, signature: 0, statuses: [], hardened: false, x: 1, y: 1, ...(scan ? { scan } : {}) };
  const client = {
    subnet: 'lo', role: 'controller', tick: 1, operatorId: 'me',
    self: { starterClaimed: true, x: 0, y: 0, running: [], capture: null, ram: [], inventory: {}, bits: 0 },
    world: { gateways: [] }, operator: {}, daemons: { get: () => ({}) }, entities: new Map([['w1', target]]),
  };
  setControls({ targetId: 'w1' });
  render(<PlayPanel client={client as unknown as GameClient} />);
}

describe('PlayPanel scan line', () => {
  it('shows nothing without a scan, the nature at 4, bucket labels at 16 and exact IVs at 64', () => {
    renderTarget(undefined);
    expect(screen.queryByTestId('scan')).toBeNull();
    cleanup();
    renderTarget({ nature: 2 });
    expect(screen.getByTestId('scan').textContent).toContain(`nature ${NATURES[2]!.id}`);
    expect(screen.getByTestId('scan').textContent).not.toContain('hp');
    cleanup();
    const buckets = [0, 1, 2, 3, 0, 1, 2, 3];
    renderTarget({ nature: 0, ivBuckets: buckets });
    const text = screen.getByTestId('scan').textContent!;
    STAT_KEYS.forEach((k, i) => expect(text).toContain(`${k.slice(0, 2)}${SCAN_BUCKET_LABELS[buckets[i]!]}`));
    cleanup();
    const ivs = [1, 9, 17, 25, 31, 0, 8, 16];
    renderTarget({ nature: 0, ivs });
    const exact = screen.getByTestId('scan').textContent!;
    STAT_KEYS.forEach((k, i) => expect(exact).toContain(`${k.slice(0, 2)}${ivs[i]}`));
  });
});
