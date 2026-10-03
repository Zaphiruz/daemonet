import type { ToolId } from '@daemonet/rules';
import { useSyncExternalStore } from 'react';

/** Manual-play selection: which actor a map click moves, which daemon is targeted, which tool captures. */
export interface Controls {
  actor: 'self' | string;
  targetId: string | null;
  tool: ToolId;
  zoom: 1 | 2 | 3 | 4;
}

let controls: Controls = { actor: 'self', targetId: null, tool: 'sniff', zoom: 2 };
const listeners = new Set<() => void>();

export function setControls(patch: Partial<Controls>): void {
  controls = { ...controls, ...patch };
  listeners.forEach((l) => l());
}

export function getControls(): Controls {
  return controls;
}

export function useControls(): Controls {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => controls,
    () => controls,
  );
}

/** Parses a typed capture answer: must be a JSON object. */
export function parseAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'the answer must be a JSON object, e.g. {"checksum":"0a1b2c3d"}' };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}
