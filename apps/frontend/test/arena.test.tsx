// @vitest-environment jsdom
import { TICK_HZ } from '@daemonet/rules';
import type { OperatorSelf } from '@daemonet/sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaHud } from '../src/components/ArenaHud.tsx';
import { arenaClock, clockText, createArenaStore, createForfeit, hpPercent, resultText, type ArenaResultInfo } from '../src/game/arena.ts';

afterEach(cleanup);

const result: ArenaResultInfo = { id: 'm1', mode: 'ranked', outcome: 'win', reason: 'wipeout', ratingBefore: 1500, ratingAfter: 1662.3, reward: 32, counted: true };
/** A definitive ranked ending that did not count (countdown forfeit, pair cap, closed season): nothing moved. */
const uncounted: ArenaResultInfo = { ...result, ratingAfter: 1500, reward: 0, counted: false };

describe('arena helpers', () => {
  it('reads the clock from the match world tick', () => {
    const arena = { phase: 'countdown' as const, liveAtTick: 3 * TICK_HZ, endsAtTick: 243 * TICK_HZ };
    expect(arenaClock(arena, 1)).toEqual({ label: 'starts in', seconds: 3 });
    expect(arenaClock({ ...arena, phase: 'live' }, 3 * TICK_HZ)).toEqual({ label: 'time left', seconds: 240 });
    expect(arenaClock({ ...arena, phase: 'live' }, 5000 * TICK_HZ)).toEqual({ label: 'time left', seconds: 0 });
    expect(arenaClock({ ...arena, phase: 'over' }, 100)).toEqual({ label: 'over', seconds: 0 });
    expect([clockText(240), clockText(61), clockText(5)]).toEqual(['4:00', '1:01', '0:05']);
    expect([hpPercent({ hp: 50, maxHp: 200, crashed: false }), hpPercent({ hp: 50, maxHp: 200, crashed: true }), hpPercent({ hp: 0.2, maxHp: 200, crashed: false })]).toEqual([25, 0, 0]);
  });

  it('words results', () => {
    expect(resultText(result)).toBe('you won by wipe-out · 1500 → 1662 · +32 bits');
    expect(resultText({ ...result, outcome: 'loss', reason: 'forfeit', ratingAfter: 1340, reward: 0 })).toBe('you lost by forfeit · 1500 → 1340');
    expect(resultText({ ...uncounted, outcome: 'draw', reason: 'timeout' })).toBe('draw on time · not counted · rating unchanged');
    expect(resultText({ ...result, mode: 'unranked', counted: false, reward: 0 })).toBe('you won by wipe-out');
  });

  it('says an uncounted ranked result was not counted and the rating unchanged', () => {
    expect(resultText(uncounted)).toBe('you won by wipe-out · not counted · rating unchanged');
    expect(resultText({ ...uncounted, mode: 'unranked' })).toBe('you won by wipe-out');
  });

  it('tracks the queue, challenges and the last result', () => {
    const s = createArenaStore();
    s.onQueued('ranked', undefined, 1000);
    expect(s.get().queued).toEqual({ mode: 'ranked', since: 1000 });
    s.onQueued(null, 'recall running daemons first', 2000);
    expect(s.get()).toMatchObject({ queued: null, note: 'recall running daemons first' });
    s.onChallenge({ challengeId: 'c1', from: 'bob', name: 'bob', mode: 'unranked', expiresAt: new Date(60_000).toISOString() });
    s.onChallenge({ challengeId: 'c2', from: 'bob', name: 'bob', mode: 'ranked', expiresAt: new Date(90_000).toISOString() });
    s.onChallenge({ challengeId: 'c3', from: 'eve', name: 'eve', mode: 'ranked', expiresAt: new Date(30_000).toISOString() });
    expect(s.get().challenges.map((c) => c.challengeId)).toEqual(['c2', 'c3']); // one per challenger
    s.prune(45_000);
    expect(s.get().challenges.map((c) => c.challengeId)).toEqual(['c2']);
    s.onQueued('unranked', undefined, 3000);
    s.onMatch('m1');
    expect(s.get()).toMatchObject({ queued: null, challenges: [] });
    s.onResult(result);
    expect(s.get().lastResult).toBe(result);
  });

  it('keeps the result past the match, takes the next match result, and clears on logout', () => {
    const s = createArenaStore();
    s.onMatch('m1');
    s.onResult(uncounted);
    s.onQueued('ranked', undefined, 10); // back home, queueing again
    expect(s.get().lastResult).toBe(uncounted);
    s.onResult({ ...result, id: 'stray' }); // another match's result without a new match: ignored
    expect(s.get().lastResult).toBe(uncounted);
    s.onResult({ ...uncounted, counted: true }); // same match: replaced
    expect(s.get().lastResult?.counted).toBe(true);
    s.onMatch('m2'); // the next match starting does not wipe it...
    expect(s.get().lastResult?.id).toBe('m1');
    s.onResult({ ...result, id: 'm2' }); // ...but its own result replaces it
    expect(s.get().lastResult?.id).toBe('m2');
    const listener = vi.fn();
    s.subscribe(listener);
    s.clear();
    expect(s.get()).toEqual({ queued: null, note: null, challenges: [], lastResult: null });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the current match result when an older match result arrives late during it', () => {
    const s = createArenaStore();
    s.onMatch('m1'); // m1 ends; its ranked result is still being recorded
    s.onMatch('m2'); // queued again, m2 starts
    s.onResult(uncounted); // m1's result lands ~minutes later, during m2: older than the match in progress
    expect(s.get().lastResult).toBeNull();
    s.onResult({ ...result, id: 'm2' }); // m2's own result is kept
    expect(s.get().lastResult?.id).toBe('m2');
    s.onResult(uncounted); // and a late m1 result after it does not replace it
    expect(s.get().lastResult?.id).toBe('m2');
  });

  it('takes any result when no match was seen since a clear or a reconnect', () => {
    const s = createArenaStore();
    s.onMatch('m1');
    s.onReconnect(); // a match may have started while we were away
    s.onResult({ ...result, id: 'm2' });
    expect(s.get().lastResult?.id).toBe('m2');
    s.onMatch('m3');
    s.clear();
    s.onResult(uncounted);
    expect(s.get().lastResult?.id).toBe('m1');
  });

  it('treats a malformed expiry as expired', () => {
    const s = createArenaStore();
    s.onChallenge({ challengeId: 'x', from: 'bob', name: null, mode: 'ranked', expiresAt: 'garbage' });
    s.prune(1);
    expect(s.get().challenges).toEqual([]);
  });

  it('does not notify when prune has nothing to drop', () => {
    const s = createArenaStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.prune(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

function selfInMatch(phase: 'countdown' | 'live' | 'over'): OperatorSelf {
  const ram = [
    { id: 'a0', species: 'pingling', level: 64, hp: 120, maxHp: 240, crashed: false, slot: 0 },
    { id: 'a1', species: 'glitchmite', level: 64, hp: 0, maxHp: 200, crashed: true, slot: 1 },
  ];
  return {
    id: 'me', name: 'alice', running: ['a0'], ram,
    arena: {
      id: 'm1', mode: 'ranked', phase, liveAtTick: 3 * TICK_HZ, endsAtTick: 243 * TICK_HZ,
      opponent: { id: 'bob', name: 'bob', tag: 'ROOT', rating: 1612.4, team: [{ id: 'b0', species: 'pingling', level: 64, hp: 240, maxHp: 240, crashed: false, running: true }] },
      result: phase === 'over' ? { winner: 'me', reason: 'wipeout' } : null,
    },
  } as unknown as OperatorSelf;
}

describe('ArenaHud', () => {
  it('shows the clock, both teams and a forfeit button while the match runs', () => {
    const forfeit = vi.fn();
    render(<ArenaHud self={selfInMatch('live')} tick={3 * TICK_HZ + TICK_HZ * 60} result={null} onForfeit={forfeit} />);
    expect(screen.getByTestId('arena-clock').textContent).toBe('3:00');
    expect(screen.getByTestId('arena-mine-a0').textContent).toContain('▶ Pingling L64');
    expect(screen.getByTestId('arena-mine-a0').textContent).toContain('50%');
    expect(screen.getByTestId('arena-mine-a1').textContent).toContain('crashed');
    expect(screen.getByTestId('arena-theirs').textContent).toContain('[ROOT] bob · 1612');
    fireEvent.click(screen.getByTestId('arena-forfeit'));
    expect(forfeit).toHaveBeenCalledOnce();
  });

  it('forfeits once at a time, logs refusals, and asks first in a ranked match', async () => {
    let reject!: (e: Error) => void;
    const forfeit = vi.fn(() => new Promise((_, rej) => (reject = rej)));
    const run = vi.fn((p: Promise<unknown>) => void p.catch(() => {}));
    const confirmFn = vi.fn(() => false);
    const go = createForfeit(run, confirmFn);
    const unranked = { self: { arena: { mode: 'unranked' as const } }, arena: { forfeit } };
    go(unranked);
    go(unranked);
    expect(forfeit).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), 'arena forfeit');
    expect(confirmFn).not.toHaveBeenCalled();
    reject(new Error('no'));
    await new Promise((r) => setTimeout(r, 0));
    const ranked = { self: { arena: { mode: 'ranked' as const } }, arena: { forfeit } };
    go(ranked);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(forfeit).toHaveBeenCalledTimes(1); // declined
    confirmFn.mockReturnValue(true);
    go(ranked);
    expect(forfeit).toHaveBeenCalledTimes(2);
  });

  it('shows the settled result when the match is over, and nothing outside a match', () => {
    const { rerender } = render(<ArenaHud self={selfInMatch('over')} tick={900} result={null} onForfeit={() => {}} />);
    expect(screen.getByTestId('arena-result').textContent).toBe('you won');
    expect(screen.queryByTestId('arena-forfeit')).toBeNull();
    rerender(<ArenaHud self={selfInMatch('over')} tick={900} result={result} onForfeit={() => {}} />);
    expect(screen.getByTestId('arena-result').textContent).toBe('you won by wipe-out · 1500 → 1662 · +32 bits');
    rerender(<ArenaHud self={{ ...selfInMatch('over'), arena: null }} tick={900} result={result} onForfeit={() => {}} />);
    expect(screen.queryByTestId('arena-hud')).toBeNull();
  });

  it('words an uncounted result and ignores a result of another match', () => {
    const { rerender } = render(<ArenaHud self={selfInMatch('over')} tick={900} result={uncounted} onForfeit={null} />);
    expect(screen.getByTestId('arena-result').textContent).toBe('you won by wipe-out · not counted · rating unchanged');
    rerender(<ArenaHud self={selfInMatch('over')} tick={900} result={{ ...result, id: 'older' }} onForfeit={null} />);
    expect(screen.getByTestId('arena-result').textContent).toBe('you won');
    expect(screen.queryByTestId('arena-forfeit')).toBeNull();
  });
});
