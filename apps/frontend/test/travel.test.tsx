// @vitest-environment jsdom
import { getSubnet } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubnetStat } from '../src/components/TopBar.tsx';
import { drawWorld } from '../src/render/draw.ts';
import { GatewaySection } from '../src/panels/PlayPanel.tsx';
import { nearHost } from '../src/panels/RamPanel.tsx';

afterEach(cleanup);

const gw = getSubnet('lo').gateways[0]!;

function fakeClient(over: { x: number; y: number; running?: string[]; capture?: unknown; role?: 'controller' | 'spectator'; subnet?: string }) {
  const travel = vi.fn(() => Promise.resolve({ ok: true }));
  const subnet = over.subnet ?? 'lo';
  const gateways = getSubnet(subnet).gateways.map((g) => ({ ...g }));
  const client = {
    subnet,
    role: over.role ?? 'controller',
    tick: 1,
    self: { x: over.x, y: over.y, running: over.running ?? [], capture: over.capture ?? null, ram: [], inventory: {}, bits: 0 },
    world: { gateways },
    operator: { travel },
    entities: new Map(),
  };
  return { client: client as unknown as GameClient, travel };
}

describe('nearHost', () => {
  it('is true within 2 tiles of the subnet host, false elsewhere or for an unknown subnet', () => {
    const h = getSubnet('lo').host;
    expect(nearHost('lo', { x: h.x + 1, y: h.y })).toBe(true);
    expect(nearHost('lo', { x: h.x + 5, y: h.y })).toBe(false);
    const lan = getSubnet('lan').host;
    expect(nearHost('lan', lan)).toBe(true);
    expect(nearHost('nowhere', h)).toBe(false);
  });
});

describe('GatewaySection', () => {
  it('shows only gateways within reach, with the level requirement, and travels on click', () => {
    const { client, travel } = fakeClient({ x: gw.at.x, y: gw.at.y });
    render(<GatewaySection client={client} me={client.self} manual />);
    expect(screen.getByTestId(`gateway-${gw.id}`).textContent).toContain(gw.to);
    expect(screen.getByTestId(`gateway-${gw.id}`).textContent).toContain(`level ${gw.requires.level}`);
    const btn = screen.getByTestId(`travel-${gw.id}`) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(travel).toHaveBeenCalledWith(gw.id);
  });

  it('renders nothing away from every gateway', () => {
    const { client } = fakeClient({ x: 5, y: 5 });
    render(<GatewaySection client={client} me={client.self} manual />);
    expect(screen.queryByTestId(`gateway-${gw.id}`)).toBeNull();
  });

  it('disables travel for spectators, with daemons running, or mid-capture', () => {
    for (const over of [{ role: 'spectator' as const }, { running: ['d1'] }, { capture: { captureId: 'c' } }]) {
      const { client } = fakeClient({ x: gw.at.x, y: gw.at.y, ...over });
      const { unmount } = render(<GatewaySection client={client} me={client.self} manual={client.role === 'controller'} />);
      expect((screen.getByTestId(`travel-${gw.id}`) as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }
  });
});

describe('top bar subnet', () => {
  it('shows the client subnet, and the new one after a mid-session snapshot', () => {
    const { client } = fakeClient({ x: 5, y: 5 });
    const { rerender } = render(<SubnetStat client={client} />);
    expect(screen.getByTestId('subnet').textContent).toBe('lo');
    (client as { subnet: string }).subnet = 'lan';
    rerender(<SubnetStat client={client} />);
    expect(screen.getByTestId('subnet').textContent).toBe('lan');
    rerender(<SubnetStat client={null} />);
    expect(screen.getByTestId('subnet').textContent).toBe('—');
  });
});

/** A 2D context that records the text it is asked to draw. */
function recordingCtx() {
  const texts: string[] = [];
  const arcs: number[][] = [];
  const noop = () => {};
  const ctx = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, prop: string) {
        if (prop === 'fillText') return (t: string) => texts.push(t);
        if (prop === 'arc') return (...a: number[]) => arcs.push(a);
        return prop in target ? target[prop] : noop;
      },
      set(target: Record<string, unknown>, prop: string, v: unknown) {
        target[prop] = v;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, texts, arcs };
}

describe('drawWorld', () => {
  const controls = { zoom: 1 as const, actor: 'self', targetId: null, tool: 'sniff' as const };
  it("draws the current subnet's gateways with their destination and level, and redraws the new map after a snapshot", () => {
    const { client } = fakeClient({ x: gw.at.x, y: gw.at.y });
    const cam = { cx: gw.at.x, cy: gw.at.y, zoom: 1 as const, width: 400, height: 300 };
    const a = recordingCtx();
    drawWorld({ ctx: a.ctx, cam, client, controls: controls as never, hover: null });
    expect(a.texts).toContain(`→ ${gw.to} L${gw.requires.level}`);
    expect(a.arcs.length).toBeGreaterThan(0);

    // travel: the client is reset to the destination subnet; the same draw call follows it
    const lan = getSubnet('lan');
    const back = lan.gateways[0]!;
    const c2 = fakeClient({ x: back.at.x, y: back.at.y, subnet: 'lan' }).client;
    const b = recordingCtx();
    drawWorld({ ctx: b.ctx, cam: { ...cam, cx: back.at.x, cy: back.at.y }, client: c2, controls: controls as never, hover: null });
    for (const g of lan.gateways) if (Math.hypot(g.at.x - back.at.x, g.at.y - back.at.y) < 6) expect(b.texts).toContain(`→ ${g.to}${g.requires.level ? ` L${g.requires.level}` : ''}`);
    expect(b.texts).not.toContain(`→ ${gw.to} L${gw.requires.level}`);
  });
});
