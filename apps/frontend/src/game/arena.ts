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
   * The latest `arenaResult`. The sim sends exactly one per match, possibly after the return home (or minutes later, while
   * a ranked result is still being recorded), so it lives outside the match HUD's lifetime. Only the current match's result
   * replaces it: a late result of an older match arriving during a newer one is dropped.
   */
  lastResult: ArenaResultInfo | null;
}

/** One predicate for pruning: a malformed `expiresAt` is not live. */
export function challengeLive(c: ArenaChallenge, now: number): boolean {
  return Date.parse(c.expiresAt) > now;
}

const EMPTY: ArenaSnapshot = { queued: null, note: null, challenges: [], lastResult: null };

/** What the Arena tab and the HUD know beyond `self.arena`: the queue, incoming challenges, the last result. Fed by events. */
export function createArenaStore() {
  let snapshot: ArenaSnapshot = EMPTY;
  /**
   * The id of the last `arenaMatch` seen, or null when none was seen since the last clear / reconnect (a match may have
   * started while we were away, so any result is taken then).
   */
  let currentMatch: string | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ArenaSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };
  return {
    onQueued(mode: ArenaMode | null, reason: string | undefined, now: number) {
      set({ queued: mode ? { mode, since: now } : null, note: mode ? null : (reason ?? null) });
    },
    /** Match `id` started: no longer waiting, and every pending challenge is moot. The previous result stays. */
    onMatch(id: string) {
      currentMatch = id;
      set({ queued: null, note: null, challenges: [] });
    },
    onResult(result: ArenaResultInfo) {
      const held = snapshot.lastResult;
      // the server decides the order: the current match's result, a newer copy of the held one, or anything when the
      // current match is unknown; everything else is an older match's late result
      if (currentMatch !== null && result.id !== currentMatch && result.id !== held?.id) return;
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
      const live = snapshot.challenges.filter((c) => challengeLive(c, now));
      if (live.length !== snapshot.challenges.length) set({ challenges: live });
    },
    /** The connection came back: a queue entry may not have survived and a challenge may have expired, so forget those (the last result stays). */
    onReconnect() {
      currentMatch = null;
      set({ queued: null, note: null, challenges: [] });
    },
    /** Logout, a kick or failed connection, close, a new open: forget everything. (Not called on the sandbox snapshot nor on a reconnect.) */
    clear() {
      currentMatch = null;
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

/** "you won by wipe-out · 1500 → 1662 · +32 bits" */
export function resultText(r: ArenaResultInfo): string {
  const how = { wipeout: 'wipe-out', timeout: 'time', forfeit: 'forfeit', disconnect: 'disconnect' }[r.reason];
  const head = r.outcome === 'draw' ? `draw on ${how}` : `you ${r.outcome === 'win' ? 'won' : 'lost'} by ${how}`;
  const rating = r.counted ? ` · ${Math.round(r.ratingBefore)} → ${Math.round(r.ratingAfter)}` : r.mode === 'ranked' ? ' · not counted · rating unchanged' : '';
  return `${head}${rating}${r.reward > 0 ? ` · +${r.reward} bits` : ''}`;
}

/**
 * The last result as the Arena tab words it. The `arenaResult` event of a ranked match that the store had not settled yet
 * (or could not) reads `counted: false` just like a definitive uncounted match; `/api/arena/matches` tells them apart by
 * match id: a row with `counted` is settled (at the row's ratings), a row without it was not counted, and no row yet
 * means the result is still pending.
 */
export function reconcileResult(
  last: ArenaResultInfo,
  rows: ReadonlyArray<{ id: string; counted: boolean; a: { id: string; before: number; after: number; reward: number }; b: { id: string; before: number; after: number; reward: number } }> | undefined,
  selfId: string,
  gaveUp = false,
): { text: string; pending: boolean } {
  const row = rows?.find((r) => r.id === last.id);
  if (row) {
    const mine = row.a.id === selfId ? row.a : row.b;
    return { text: resultText({ ...last, counted: row.counted, ratingBefore: row.counted ? mine.before : last.ratingBefore, ratingAfter: row.counted ? mine.after : last.ratingAfter, reward: mine.reward }), pending: false };
  }
  if (last.mode === 'ranked' && !last.counted && gaveUp) return { text: `${resultText({ ...last, mode: 'unranked' })} · not counted · rating unchanged (could not be recorded)`, pending: false };
  if (last.mode === 'ranked' && !last.counted) return { text: `${resultText({ ...last, mode: 'unranked' })} · result pending`, pending: true };
  return { text: resultText(last), pending: false };
}

/**
 * The HUD's forfeit button: one command at a time (a double click sends once), refusals are logged through `run`, and a
 * ranked match asks first. The server decides whether the forfeit is accepted; this only mirrors that it is possible.
 */
export function createForfeit(run: (p: Promise<unknown>, label: string) => void, confirmFn: (message: string) => boolean) {
  let busy = false;
  return (client: { self: { arena: { mode: ArenaMode } | null }; arena: { forfeit(): Promise<unknown> } }): void => {
    if (busy) return;
    if (client.self.arena?.mode === 'ranked' && !confirmFn('Forfeit this ranked match? It counts as a loss.')) return;
    busy = true;
    const p = client.arena.forfeit();
    run(p, 'arena forfeit');
    const done = () => {
      busy = false;
    };
    void p.then(done, done);
  };
}
