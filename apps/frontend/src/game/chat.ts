import { useSyncExternalStore } from 'react';

export interface ChatLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}

const LIMIT = 256;

/** The connected operator's id, set by the connection so DM threads land under the other side. */
export let me = '';
export function setMe(id: string): void {
  me = id;
}

/** Chat lines per channel, fed by the connection (live) and the API (history). */
export function createChatStore() {
  let lines = new Map<string, ChatLine[]>();
  let unread = new Map<string, number>();
  let active = '';
  let mutedUntil: string | null = null;
  const listeners = new Set<() => void>();
  let version = 0;
  // useSyncExternalStore needs a stable snapshot between changes: rebuilt only in notify()
  let snapshot: { lines: Map<string, ChatLine[]>; unread: Map<string, number>; active: string; mutedUntil: string | null; version: number } = { lines, unread, active, mutedUntil, version };
  const notify = () => {
    version++;
    snapshot = { lines, unread, active, mutedUntil, version };
    listeners.forEach((l) => l());
  };
  /** Merges lines into a channel (time order, no duplicate ids); returns how many were new. */
  const put = (channel: string, incoming: ChatLine[]): number => {
    const cur = lines.get(channel) ?? [];
    const seen = new Set(cur.map((l) => l.id));
    const fresh = incoming.filter((l) => !seen.has(l.id));
    if (fresh.length === 0) return 0;
    const merged = [...cur, ...fresh].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    lines = new Map(lines).set(channel, merged.slice(-LIMIT));
    return fresh.length;
  };
  return {
    push(line: ChatLine) {
      // a DM shows under the *other* side's id on both ends
      const channel = line.channel.startsWith('dm:') && line.channel !== `dm:${line.from}` && line.from !== me ? `dm:${line.from}` : line.channel;
      const added = put(channel, [line]);
      // your own lines and replays of a line already held are not "unread"
      if (added > 0 && channel !== active && line.from !== me) unread = new Map(unread).set(channel, (unread.get(channel) ?? 0) + 1);
      notify();
    },
    history(channel: string, incoming: ChatLine[]) {
      put(channel, incoming);
      notify();
    },
    remove(id: string) {
      lines = new Map([...lines].map(([c, ls]) => [c, ls.filter((l) => l.id !== id)]));
      notify();
    },
    setActive(channel: string) {
      if (active === channel && !unread.has(channel)) return;
      active = channel;
      if (unread.has(channel)) {
        unread = new Map(unread);
        unread.delete(channel);
      }
      notify();
    },
    setMuted(until: string | null) {
      mutedUntil = until;
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Forgets everything of the session (the connection ended or the operator logged out). */
    clear() {
      lines = new Map();
      unread = new Map();
      mutedUntil = null;
      notify();
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
export const chatStore = createChatStore();

export function useChat() {
  return useSyncExternalStore(chatStore.subscribe, chatStore.get, chatStore.get);
}
