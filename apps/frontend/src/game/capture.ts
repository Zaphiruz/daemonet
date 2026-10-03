import { useSyncExternalStore } from 'react';

export interface CaptureChallenge {
  captureId: string;
  kind: string;
  families: string[];
  params: unknown;
  payload: unknown;
}

/**
 * The latest capture challenge. It lives outside the capture panel because `captureStart` arrives in
 * the same delta that makes the panel appear: a panel-local subscription would miss it.
 */
export function createCaptureStore() {
  let current: CaptureChallenge | null = null;
  const listeners = new Set<() => void>();
  const set = (next: CaptureChallenge | null) => {
    if (next === current) return;
    current = next;
    listeners.forEach((l) => l());
  };
  return {
    start(ev: { captureId: string; challenge: Omit<CaptureChallenge, 'captureId'> }) {
      set({ captureId: ev.captureId, ...ev.challenge });
    },
    /** A result for the held challenge (or any result when `captureId` is unknown) clears it. */
    result(ev: { captureId?: string }) {
      if (current && (ev.captureId === undefined || ev.captureId === current.captureId)) set(null);
    },
    clear: () => set(null),
    get: () => current,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type CaptureStore = ReturnType<typeof createCaptureStore>;
export const capture = createCaptureStore();

export function useCaptureChallenge(): CaptureChallenge | null {
  return useSyncExternalStore(capture.subscribe, capture.get, capture.get);
}
