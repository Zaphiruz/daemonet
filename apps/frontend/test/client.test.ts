import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../src/game/controls.ts';
import { createLog } from '../src/game/log.ts';
import { screenToWorld, visibleTiles, worldToScreen, type Camera } from '../src/render/camera.ts';

describe('camera', () => {
  const cam: Camera = { cx: 10, cy: 10, zoom: 2, width: 640, height: 480 };

  it('round-trips world and screen coordinates', () => {
    const s = worldToScreen(cam, 12.5, 9);
    expect(s).toEqual({ sx: 320 + 2.5 * 32, sy: 240 - 32 });
    const w = screenToWorld(cam, s.sx, s.sy);
    expect(w.x).toBeCloseTo(12.5);
    expect(w.y).toBeCloseTo(9);
  });

  it('clamps the visible tile range to the map', () => {
    expect(visibleTiles({ ...cam, cx: 1, cy: 1 }, 128, 128)).toEqual({ x0: 0, y0: 0, x1: 11, y1: 9 });
    expect(visibleTiles({ ...cam, cx: 127, cy: 127 }, 128, 128).x1).toBe(127);
  });
});

describe('log', () => {
  it('keeps the newest entries within the limit and notifies subscribers', () => {
    const l = createLog(3);
    let notified = 0;
    l.subscribe(() => notified++);
    for (let i = 1; i <= 5; i++) l.push('event', `e${i}`);
    expect(l.get().map((e) => e.text)).toEqual(['e3', 'e4', 'e5']);
    expect(notified).toBe(5);
    l.clear();
    expect(l.get()).toEqual([]);
  });
});

describe('parseAnswer', () => {
  it('accepts JSON objects only', () => {
    expect(parseAnswer('{"checksum":"0a1b2c3d"}')).toEqual({ ok: true, value: { checksum: '0a1b2c3d' } });
    expect(parseAnswer('[1]').ok).toBe(false);
    expect(parseAnswer('42').ok).toBe(false);
    expect(parseAnswer('{oops').ok).toBe(false);
  });
});
