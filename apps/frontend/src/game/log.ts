import { useSyncExternalStore } from 'react';

export type LogKind = 'event' | 'script' | 'error' | 'reject' | 'system';

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  text: string;
}

export const LOG_LIMIT = 512;

/** A tiny append-only log store shared by the connection, the sandbox and the UI. */
export function createLog(limit = LOG_LIMIT) {
  let entries: LogEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    push(kind: LogKind, text: string, at = Date.now()) {
      entries = [...entries, { id: nextId++, at, kind, text }];
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      notify();
    },
    clear() {
      entries = [];
      notify();
    },
    get: () => entries,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Log = ReturnType<typeof createLog>;
export const log = createLog();

export function useLog(): LogEntry[] {
  return useSyncExternalStore(log.subscribe, log.get, log.get);
}
