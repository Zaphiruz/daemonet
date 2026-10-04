import { TICK_HZ } from '@daemonet/rules';
import type { OperatorSelf } from '@daemonet/sdk';
import { useSyncExternalStore } from 'react';

export type ArenaMode = 'ranked' | 'unranked';
export type ArenaView = NonNullable<OperatorSelf['arena']>;

export interface ArenaChallenge {
  challengeId: string;
  from: string;
  name: string | null;
  mode: ArenaMode;
  expiresAt: string;
}

export interface ArenaResultInfo {
  id: string;
  mode: ArenaMode;
  outcome: 'win' | 'loss' | 'draw';
  reason: 'wipeout' | 'timeout' | 'forfeit' | 'disconnect';
  ratingBefore: number;
  ratingAfter: number;
  reward: number;
  counted: boolean;
}

export interface ArenaSnapshot {
  /** Waiting for an opponent since `since` (ms). */
  queued: { mode: ArenaMode; since: number } | null;
  /** Why the server took us out of the queue, if it did. */
  note: string | null;
  challenges: ArenaChallenge[];
  /**
   * The latest `arenaResult`. It lives outside the match HUD's lifetime: the event can arrive after the return home
   * (even ~10 minutes later, when the store was unreachable), and a later one for the same match replaces it.
   */
  lastResult: ArenaResultInfo | null;
}

const EMPTY: ArenaSnapshot = { queued: null, note: null, challenges: [], lastResult: null };

/** What the Arena tab and the HUD know beyond `self.arena`: the queue, incoming challenges, the last result. Fed by events. */
export function createArenaStore() {
  let snapshot: ArenaSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ArenaSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };
  return {
    onQueued(mode: ArenaMode | null, reason: string | undefined, now: number) {
      set({ queued: mode ? { mode, since: now } : null, note: mode ? null : (reason ?? null) });
    },
    /** A match started: no longer waiting, and every pending challenge is moot. The previous result stays. */
    onMatch() {
      set({ queued: null, note: null, challenges: [] });
    },
    onResult(result: ArenaResultInfo) {
      set({ lastResult: result });
    },
    onChallenge(c: ArenaChallenge) {
      set({ challenges: [...snapshot.challenges.filter((x) => x.from !== c.from), c] });
    },
    dismiss(challengeId: string) {
      set({ challenges: snapshot.challenges.filter((c) => c.challengeId !== challengeId) });
    },
    /** Drops challenges past their 60 seconds. */
    prune(now: number) {
      if (snapshot.challenges.some((c) => Date.parse(c.expiresAt) <= now)) set({ challenges: snapshot.challenges.filter((c) => Date.parse(c.expiresAt) > now) });
    },
    /** Logout, a failed or closed connection, a mid-session snapshot: forget everything. */
    clear() {
      set({ ...EMPTY });
    },
    get: (): ArenaSnapshot => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type ArenaStore = ReturnType<typeof createArenaStore>;

export const arenaStore = createArenaStore();
export function useArena(): ArenaSnapshot {
  return useSyncExternalStore(arenaStore.subscribe, arenaStore.get, arenaStore.get);
}

/** The match clock: seconds until it starts, seconds left, or over. `tick` is the match world's. */
export function arenaClock(arena: Pick<ArenaView, 'phase' | 'liveAtTick' | 'endsAtTick'>, tick: number): { label: 'starts in' | 'time left' | 'over'; seconds: number } {
  if (arena.phase === 'over') return { label: 'over', seconds: 0 };
  const until = arena.phase === 'countdown' ? arena.liveAtTick : arena.endsAtTick;
  return { label: arena.phase === 'countdown' ? 'starts in' : 'time left', seconds: Math.max(0, Math.ceil((until - tick) / TICK_HZ)) };
}

export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 0–100, for the HP bars. */
export function hpPercent(d: { hp: number; maxHp: number; crashed: boolean }): number {
  return d.crashed || d.maxHp <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((d.hp / d.maxHp) * 100)));
}

/**
 * A ranked result that carries no settlement: nothing counted and nothing moved. The sim announces exactly this when the
 * store was unreachable, so the outcome is unknown rather than "not counted"; the Arena tab reconciles from the match
 * history. (Win bits arrive as a normal bits event; the client never adds them.)
 */
export function resultPending(r: ArenaResultInfo): boolean {
  return r.mode === 'ranked' && !r.counted && r.reward === 0 && r.ratingBefore === r.ratingAfter;
}

/** "you won by wipe-out · 1500 → 1662 · +32 bits" */
export function resultText(r: ArenaResultInfo): string {
  const how = { wipeout: 'wipe-out', timeout: 'time', forfeit: 'forfeit', disconnect: 'disconnect' }[r.reason];
  const head = r.outcome === 'draw' ? `draw on ${how}` : `you ${r.outcome === 'win' ? 'won' : 'lost'} by ${how}`;
  const rating = r.counted ? ` · ${Math.round(r.ratingBefore)} → ${Math.round(r.ratingAfter)}` : resultPending(r) ? ' · rating pending' : r.mode === 'ranked' ? ' · not counted' : '';
  return `${head}${rating}${r.reward > 0 ? ` · +${r.reward} bits` : ''}`;
}
