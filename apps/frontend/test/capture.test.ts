import { describe, expect, it } from 'vitest';
import { createCaptureStore } from '../src/game/capture.ts';

const ev = (captureId: string) => ({ captureId, challenge: { kind: 'single', families: ['packet'], params: { count: 2 }, payload: {} } });

describe('capture store', () => {
  it('keeps a challenge that arrived before any panel existed', () => {
    const s = createCaptureStore();
    s.start(ev('c1'));
    expect(s.get()).toMatchObject({ captureId: 'c1', kind: 'single', families: ['packet'] });
  });
  it('notifies subscribers and a result clears the challenge', () => {
    const s = createCaptureStore();
    let n = 0;
    s.subscribe(() => n++);
    s.start(ev('c1'));
    s.result({ captureId: 'other' });
    expect(s.get()?.captureId).toBe('c1');
    s.result({ captureId: 'c1' });
    expect(s.get()).toBeNull();
    expect(n).toBe(2);
  });
  it('clear drops it and a newer start replaces it', () => {
    const s = createCaptureStore();
    s.start(ev('c1'));
    s.start(ev('c2'));
    expect(s.get()?.captureId).toBe('c2');
    s.clear();
    expect(s.get()).toBeNull();
  });
});
