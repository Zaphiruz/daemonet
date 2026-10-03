# Daemonet SP6 · Plan 3 — Arena client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can use the Arena from the web client: an **Arena** tab to queue, challenge and accept, with their standing, the ladder and their match history; and a match HUD over the map with the clock, both teams and the result.

**Architecture:** Everything a match needs on screen is already in `client.self.arena` (plan 1), which the connection store re-renders every tick; the HUD is a pure component over `self`, the tick and the last result. What is *not* in `self` — the queue, incoming challenges, the settled result — arrives as events and lives in a small external store (`game/arena.ts`) like the chat and Incident stores. Standings, ladder and history are RTK Query endpoints refetched when a result arrives. The map already renders any subnet `getSubnet` knows, so the sandbox needs only one tweak (no host marker).

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP6 plans 1–2 merged.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp6-arena-design.md` §7, §8.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- The client never decides anything: buttons are disabled on the same conditions the server checks (two non-crashed daemons in RAM, nothing running, not in a match), and a refused command is logged.

## File map

```
apps/frontend/src/game/arena.ts             arena store, arenaClock, clockText, hpPercent, resultText
apps/frontend/src/components/ArenaHud.tsx   match HUD over the canvas
apps/frontend/src/panels/ArenaPanel.tsx     the Arena tab
apps/frontend/src/api.ts                    arenaMe, ladder, arenaMatches
apps/frontend/src/game/connection.ts        arena events → store and log
apps/frontend/src/render/draw.ts            no host marker in the sandbox
apps/frontend/src/App.tsx                   tab + HUD mount
apps/frontend/src/sdk-types.ts              editor typings for client.arena
apps/frontend/test/arena.test.tsx, apps/frontend/e2e/smoke.spec.ts
```

---

### Task 1: Arena store, helpers and the HUD

**Files:**
- Create: `apps/frontend/src/game/arena.ts`, `apps/frontend/src/components/ArenaHud.tsx`, `apps/frontend/test/arena.test.tsx`

**Interfaces:**
- `createArenaStore()` / `arenaStore` / `useArena() → { queued: { mode, since } | null, note, challenges, lastResult }` with `onQueued(mode, reason, now)`, `onMatch()`, `onResult(result)`, `onChallenge(c)`, `dismiss(challengeId)`, `prune(now)`.
- `arenaClock(arena, tick) → { label: 'starts in' | 'time left' | 'over', seconds }`, `clockText(seconds)`, `hpPercent(copy)`, `resultText(result)`.
- `<ArenaHud self tick result onForfeit />` — renders nothing when `self.arena` is null. Test ids: `arena-hud`, `arena-clock`, `arena-result`, `arena-forfeit`, `arena-mine`, `arena-theirs`, `arena-mine-<daemonId>`, `arena-theirs-<daemonId>`.

- [ ] **Step 1: Failing tests**

```tsx
// @vitest-environment jsdom
import type { OperatorSelf } from '@daemonet/sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaHud } from '../src/components/ArenaHud.tsx';
import { arenaClock, clockText, createArenaStore, hpPercent, resultText, type ArenaResultInfo } from '../src/game/arena.ts';

afterEach(cleanup);

const result: ArenaResultInfo = { id: 'm1', mode: 'ranked', outcome: 'win', reason: 'wipeout', ratingBefore: 1500, ratingAfter: 1662.3, reward: 32, counted: true };

describe('arena helpers', () => {
  it('reads the clock from the match world tick', () => {
    const arena = { phase: 'countdown' as const, liveAtTick: 48, endsAtTick: 3888 };
    expect(arenaClock(arena, 1)).toEqual({ label: 'starts in', seconds: 3 });
    expect(arenaClock({ ...arena, phase: 'live' }, 48)).toEqual({ label: 'time left', seconds: 240 });
    expect(arenaClock({ ...arena, phase: 'live' }, 5000)).toEqual({ label: 'time left', seconds: 0 });
    expect(arenaClock({ ...arena, phase: 'over' }, 100)).toEqual({ label: 'over', seconds: 0 });
    expect([clockText(240), clockText(61), clockText(5)]).toEqual(['4:00', '1:01', '0:05']);
    expect([hpPercent({ hp: 50, maxHp: 200, crashed: false }), hpPercent({ hp: 50, maxHp: 200, crashed: true }), hpPercent({ hp: 0.2, maxHp: 200, crashed: false })]).toEqual([25, 0, 0]);
  });

  it('words results', () => {
    expect(resultText(result)).toBe('you won by wipe-out · 1500 → 1662 · +32 bits');
    expect(resultText({ ...result, outcome: 'loss', reason: 'forfeit', ratingAfter: 1340, reward: 0 })).toBe('you lost by forfeit · 1500 → 1340');
    expect(resultText({ ...result, outcome: 'draw', reason: 'timeout', counted: false, reward: 0 })).toBe('draw on time · not counted');
    expect(resultText({ ...result, mode: 'unranked', counted: false, reward: 0 })).toBe('you won by wipe-out');
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
    s.onMatch();
    expect(s.get()).toMatchObject({ queued: null, challenges: [] });
    s.onResult(result);
    expect(s.get().lastResult).toBe(result);
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
      id: 'm1', mode: 'ranked', phase, liveAtTick: 48, endsAtTick: 3888,
      opponent: { id: 'bob', name: 'bob', tag: 'ROOT', rating: 1612.4, team: [{ id: 'b0', species: 'pingling', level: 64, hp: 240, maxHp: 240, crashed: false, running: true }] },
      result: phase === 'over' ? { winner: 'me', reason: 'wipeout' } : null,
    },
  } as unknown as OperatorSelf;
}

describe('ArenaHud', () => {
  it('shows the clock, both teams and a forfeit button while the match runs', () => {
    const forfeit = vi.fn();
    render(<ArenaHud self={selfInMatch('live')} tick={48 + 16 * 60} result={null} onForfeit={forfeit} />);
    expect(screen.getByTestId('arena-clock').textContent).toBe('3:00');
    expect(screen.getByTestId('arena-mine-a0').textContent).toContain('▶ Pingling L64');
    expect(screen.getByTestId('arena-mine-a0').textContent).toContain('50%');
    expect(screen.getByTestId('arena-mine-a1').textContent).toContain('crashed');
    expect(screen.getByTestId('arena-theirs').textContent).toContain('[ROOT] bob · 1612');
    fireEvent.click(screen.getByTestId('arena-forfeit'));
    expect(forfeit).toHaveBeenCalledOnce();
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
});
```

- [ ] **Step 2: Store and helpers**

```ts
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
  lastResult: ArenaResultInfo | null;
}

/** What the Arena tab and the HUD know beyond `self.arena`: the queue, incoming challenges, the last result. Fed by events. */
export function createArenaStore() {
  let snapshot: ArenaSnapshot = { queued: null, note: null, challenges: [], lastResult: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ArenaSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };
  return {
    onQueued(mode: ArenaMode | null, reason: string | undefined, now: number) {
      set({ queued: mode ? { mode, since: now } : null, note: mode ? null : (reason ?? null) });
    },
    /** A match started: no longer waiting, and every pending challenge is moot. */
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
    get: (): ArenaSnapshot => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

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
  const rating = r.counted ? ` · ${Math.round(r.ratingBefore)} → ${Math.round(r.ratingAfter)}` : r.mode === 'ranked' ? ' · not counted' : '';
  return `${head}${rating}${r.reward > 0 ? ` · +${r.reward} bits` : ''}`;
}
```

- [ ] **Step 3: HUD**

```tsx
import { getSpecies } from '@daemonet/rules';
import type { OperatorSelf } from '@daemonet/sdk';
import { arenaClock, clockText, hpPercent, resultText, type ArenaResultInfo } from '../game/arena.ts';

interface Copy {
  id: string;
  species: string;
  level: number;
  hp: number;
  maxHp: number;
  crashed: boolean;
  running: boolean;
}

function Team({ title, copies, testid }: { title: string; copies: Copy[]; testid: string }) {
  return (
    <div className="w-44 rounded bg-neutral-950/85 p-2" data-testid={testid}>
      <div className="mb-1 truncate text-xs text-neutral-300">{title}</div>
      {copies.map((d) => (
        <div key={d.id} className={`mb-0.5 ${d.crashed ? 'opacity-40' : ''}`} data-testid={`${testid}-${d.id}`}>
          <div className="mono flex justify-between text-[10px] text-neutral-400">
            <span>
              {d.running ? '▶ ' : ''}
              {getSpecies(d.species).name} L{d.level}
            </span>
            <span>{d.crashed ? 'crashed' : `${hpPercent(d)}%`}</span>
          </div>
          <div className="h-1 rounded bg-neutral-800">
            <div className={`h-1 rounded ${hpPercent(d) > 50 ? 'bg-emerald-500' : hpPercent(d) > 20 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${hpPercent(d)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Match HUD over the map (SP6 spec §7): the clock, both sides' copies, the result, a forfeit button. */
export function ArenaHud({ self, tick, result, onForfeit }: { self: OperatorSelf; tick: number; result: ArenaResultInfo | null; onForfeit: (() => void) | null }) {
  const arena = self.arena;
  if (!arena) return null;
  const clock = arenaClock(arena, tick);
  const mine: Copy[] = self.ram.map((d) => ({ id: d.id, species: d.species, level: d.level, hp: d.hp, maxHp: d.maxHp, crashed: d.crashed, running: self.running.includes(d.id) }));
  const opponent = arena.opponent;
  const over = arena.phase === 'over';
  const shown = over && result?.id === arena.id ? result : null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2" data-testid="arena-hud">
      <Team title={`you${self.name ? ` · ${self.name}` : ''}`} copies={mine} testid="arena-mine" />
      <div className="rounded bg-neutral-950/85 px-3 py-1 text-center">
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
          {arena.mode} · {clock.label}
        </div>
        {!over && (
          <div className="mono text-lg text-sky-300" data-testid="arena-clock">
            {clockText(clock.seconds)}
          </div>
        )}
        {over && (
          <div className="mono text-sm text-amber-200" data-testid="arena-result">
            {shown ? resultText(shown) : arena.result?.winner === null ? 'draw' : arena.result?.winner === self.id ? 'you won' : 'you lost'}
          </div>
        )}
        {!over && onForfeit && (
          <button className="pointer-events-auto mt-1 rounded bg-neutral-800 px-2 text-xs text-neutral-300 hover:bg-red-900" onClick={onForfeit} data-testid="arena-forfeit">
            forfeit
          </button>
        )}
      </div>
      <Team title={`${opponent.tag ? `[${opponent.tag}] ` : ''}${opponent.name ?? 'opponent'} · ${Math.round(opponent.rating)}`} copies={opponent.team} testid="arena-theirs" />
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

`pnpm exec vitest run apps/frontend/test/arena.test.tsx` — expected: 5 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): arena store, clock helpers and match HUD"
```

---

### Task 2: Arena tab and wiring

**Files:**
- Create: `apps/frontend/src/panels/ArenaPanel.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/render/draw.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/sdk-types.ts`

**Interfaces:**
- Hooks `useArenaMeQuery()`, `useLadderQuery({ season?, cursor? })`, `useArenaMatchesQuery()`.
- Test ids: `tab-arena`, `arena`, `arena-queue-ranked`, `arena-queue-unranked`, `arena-waiting`, `arena-leave`, `arena-challenge`, `arena-last`, `arena-me`, `arena-ladder`, `arena-history`.

- [ ] **Step 1: Api slice**

`apps/frontend/src/api.ts` — types

```ts
export interface ArenaMe {
  season: string;
  seasonEndsAt: string;
  rating: number;
  rd: number;
  wins: number;
  losses: number;
  draws: number;
  band: { min: number; payout: number };
  payoutEligible: boolean;
  matchesForPayout: number;
  rewardedWinsToday: number;
  dailyWins: number;
  winBits: number;
}
export interface LadderRow {
  rank: number;
  operatorId: string;
  name: string | null;
  tag: string | null;
  rating: number;
  rd: number;
  wins: number;
  losses: number;
  draws: number;
}
interface ArenaMatchSide {
  id: string;
  name: string | null;
  before: number;
  after: number;
  reward: number;
}
export interface ArenaMatchRow {
  id: string;
  season: string;
  mode: 'ranked' | 'unranked';
  reason: string;
  counted: boolean;
  durationMs: number;
  endedAt: string;
  winnerId: string | null;
  a: ArenaMatchSide;
  b: ArenaMatchSide;
}
```

endpoints

```ts
    arenaMe: b.query<ArenaMe, void>({ query: () => '/arena/me' }),
    ladder: b.query<{ season: string; rows: LadderRow[]; next: number | null }, { season?: string; cursor?: number }>({
      query: ({ season, cursor }) => `/arena/ladder?${new URLSearchParams({ ...(season ? { season } : {}), ...(cursor ? { cursor: String(cursor) } : {}) }).toString()}`,
    }),
    arenaMatches: b.query<ArenaMatchRow[], void>({ query: () => '/arena/matches?mine=1' }),
```

and the three hooks in the export list.

- [ ] **Step 2: Events**

`apps/frontend/src/game/connection.ts` (import `arenaStore, resultText` from `./arena.ts`):

```ts
    client.on('arenaQueued', (e) => {
      arenaStore.onQueued(e.mode, e.reason, Date.now());
      if (!e.mode && e.reason) log.push('event', `Arena: left the queue (${e.reason})`);
    });
    client.on('arenaMatch', (e) => {
      arenaStore.onMatch();
      log.push('event', `Arena: ${e.mode} match against ${e.opponent.name ?? 'an operator'} (${Math.round(e.opponent.rating)})`);
    });
    client.on('arenaResult', (e) => {
      arenaStore.onResult(e);
      log.push('event', `Arena: ${resultText(e)}`);
    });
    client.on('arenaChallenge', (c) => {
      arenaStore.onChallenge(c);
      log.push('event', `${c.name ?? 'an operator'} challenges you to a ${c.mode} match (arena tab)`);
    });
```

- [ ] **Step 3: The panel**

```tsx
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useState } from 'react';
import { useArenaMatchesQuery, useArenaMeQuery, useLadderQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { arenaStore, clockText, resultText, useArena, type ArenaMode } from '../game/arena.ts';

/** Arena (SP6): queue or challenge, your standing this season, the ladder and your match history. */
export function ArenaPanel({ client }: { client: GameClient }) {
  const arena = useArena();
  const me = useArenaMeQuery();
  const ladder = useLadderQuery({});
  const matches = useArenaMatchesQuery();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      arenaStore.prune(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // a finished match changes all three views
  const { refetch: refetchMe } = me;
  const { refetch: refetchLadder } = ladder;
  const { refetch: refetchMatches } = matches;
  const resultId = arena.lastResult?.id;
  useEffect(() => {
    if (!resultId) return;
    void refetchMe();
    void refetchLadder();
    void refetchMatches();
  }, [resultId, refetchMe, refetchLadder, refetchMatches]);

  const self = client.self;
  const manual = client.role === 'controller';
  const inMatch = !!self.arena;
  const ready = self.ram.filter((d) => !d.crashed).length;
  const blocked = inMatch ? 'you are in a match' : ready < 2 ? 'you need 2 daemons in RAM that have not crashed' : self.running.length > 0 ? 'recall your running daemons first' : null;
  const queue = (mode: ArenaMode) => run(client.arena.queue(mode), 'arena queue');
  const nearby = client.world.operators.all().filter((o) => o.id !== client.operatorId);

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="arena">
      <section className="space-y-1 rounded border border-neutral-800 p-2 text-xs">
        {arena.queued ? (
          <div className="flex items-center justify-between" data-testid="arena-waiting">
            <span>
              waiting for a {arena.queued.mode} match · <span className="mono">{clockText(Math.max(0, Math.floor((now - arena.queued.since) / 1000)))}</span>
            </span>
            <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={() => run(client.arena.leave(), 'arena leave')} data-testid="arena-leave">
              leave queue
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={!manual || !!blocked} onClick={() => queue('ranked')} data-testid="arena-queue-ranked">
              queue ranked
            </button>
            <button className="rounded bg-neutral-700 px-2 py-0.5 hover:bg-neutral-600 disabled:opacity-40" disabled={!manual || !!blocked} onClick={() => queue('unranked')} data-testid="arena-queue-unranked">
              queue unranked
            </button>
            <span className="text-neutral-500">{blocked ?? arena.note ?? 'ranked: level 64, rating on the line · unranked: as you are'}</span>
          </div>
        )}
        <p className="text-neutral-600">Your daemons fight as copies: no XP, no crashes, nothing lost. Two run at a time; four minutes on the clock.</p>
      </section>

      {arena.challenges.map((c) => (
        <div key={c.challengeId} className="flex items-center justify-between rounded border border-amber-900 p-2 text-xs" data-testid="arena-challenge">
          <span>
            {c.name ?? 'an operator'} challenges you ({c.mode})
          </span>
          <span className="flex gap-2">
            <button
              className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
              disabled={!manual || !!blocked}
              onClick={() => {
                run(client.arena.accept(c.challengeId), 'arena accept');
                arenaStore.dismiss(c.challengeId);
              }}
            >
              accept
            </button>
            <button className="text-neutral-500 hover:text-neutral-200" onClick={() => arenaStore.dismiss(c.challengeId)}>
              ignore
            </button>
          </span>
        </div>
      ))}

      {arena.lastResult && (
        <p className="mono text-xs text-amber-200" data-testid="arena-last">
          last match: {resultText(arena.lastResult)}
        </p>
      )}

      {me.data && (
        <section className="mono text-xs" data-testid="arena-me">
          <h3 className="mb-1 font-sans uppercase tracking-wide text-neutral-500">season {me.data.season}</h3>
          <p>
            rating <span className="text-sky-300">{Math.round(me.data.rating)}</span> ± {Math.round(me.data.rd)} · {me.data.wins}W {me.data.losses}L {me.data.draws}D
          </p>
          <p className="text-neutral-400">
            season payout {me.data.band.payout} bits{me.data.payoutEligible ? '' : ` (after ${me.data.matchesForPayout} ranked matches)`} · wins paid today {me.data.rewardedWinsToday}/{me.data.dailyWins} × {me.data.winBits} bits
          </p>
          <p className="text-neutral-600">ends {new Date(me.data.seasonEndsAt).toLocaleDateString()}; ratings then move halfway back to 1500</p>
        </section>
      )}

      {nearby.length > 0 && !inMatch && (
        <section className="text-xs">
          <h3 className="mb-1 uppercase tracking-wide text-neutral-500">challenge someone nearby</h3>
          {nearby.slice(0, 8).map((o) => (
            <div key={o.id} className="flex items-center justify-between border-b border-neutral-900 py-0.5">
              <span>{o.name ?? o.id.slice(0, 8)}</span>
              <span className="flex gap-2">
                {(['unranked', 'ranked'] as const).map((mode) => (
                  <button key={mode} className="text-neutral-400 hover:text-white disabled:opacity-40" disabled={!manual || !!blocked} onClick={() => run(client.arena.challenge(o.id, mode), 'arena challenge')}>
                    {mode}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="text-xs" data-testid="arena-ladder">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">ladder</h3>
        {ladder.data?.rows.length === 0 && <p className="text-neutral-600">nobody has played 8 ranked matches yet</p>}
        {ladder.data?.rows.map((r) => (
          <div key={r.operatorId} className={`mono flex justify-between border-b border-neutral-900 py-0.5 ${r.operatorId === client.operatorId ? 'text-sky-300' : ''}`}>
            <span>
              {r.rank}. {r.tag ? `[${r.tag}] ` : ''}
              {r.name ?? r.operatorId.slice(0, 8)}
            </span>
            <span>
              {Math.round(r.rating)} · {r.wins}W {r.losses}L {r.draws}D
            </span>
          </div>
        ))}
      </section>

      <section className="text-xs" data-testid="arena-history">
        <h3 className="mb-1 uppercase tracking-wide text-neutral-500">my matches</h3>
        {matches.data?.length === 0 && <p className="text-neutral-600">none yet</p>}
        {matches.data?.map((m) => {
          const mine = m.a.id === client.operatorId ? m.a : m.b;
          const theirs = m.a.id === client.operatorId ? m.b : m.a;
          const outcome = m.winnerId === null ? 'draw' : m.winnerId === client.operatorId ? 'win' : 'loss';
          return (
            <div key={m.id} className="mono flex justify-between border-b border-neutral-900 py-0.5">
              <span className={outcome === 'win' ? 'text-emerald-300' : outcome === 'loss' ? 'text-red-300' : 'text-neutral-300'}>{outcome}</span>
              <span>vs {theirs.name ?? theirs.id.slice(0, 8)}</span>
              <span className="text-neutral-500">
                {m.mode} · {m.reason}
              </span>
              <span>{m.counted ? `${Math.round(mine.before)} → ${Math.round(mine.after)}` : '—'}</span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Mount it**

`apps/frontend/src/App.tsx` — `'arena'` in `TABS` after `'exchange'`; `const arena = useArena();`; `{tab === 'arena' && client?.self && <ArenaPanel client={client} />}`; and the map column becomes a positioned container with the HUD on top:

```tsx
        <div className="relative min-w-0 flex-1">
          {client ? <WorldCanvas /> : <p className="p-4 text-neutral-500">{conn.status}…</p>}
          {client?.self?.arena && <ArenaHud self={client.self} tick={client.tick} result={arena.lastResult} onForfeit={client.role === 'controller' ? () => void client.arena.forfeit().catch(() => {}) : null} />}
        </div>
```

`apps/frontend/src/render/draw.ts` (import `ARENA_SUBNET`) — the host marker:

```ts
  // the sandbox has no host services: nothing to mark
  if (def.id !== ARENA_SUBNET) {
    const host = worldToScreen(cam, def.host.x, def.host.y);
    ctx.strokeStyle = COLORS.host;
    ctx.lineWidth = 2;
    ctx.strokeRect(host.sx - s, host.sy - s, 2 * s, 2 * s);
    ctx.fillStyle = COLORS.host;
    ctx.font = `${Math.max(10, s * 0.6)}px ui-monospace`;
    ctx.fillText('host', host.sx - s, host.sy - s - 4);
  }
```

`apps/frontend/src/sdk-types.ts` — the script editor's typings: `arena: ArenaMatch | null;` in `OperatorSelf`, `readonly arena: ArenaApi;` on `GameClient`, `on(...)` overloads for `arenaMatch`, `arenaResult`, `arenaQueued` and `arenaChallenge`, and

```ts
  export interface ArenaMatch {
    id: string; mode: 'ranked' | 'unranked'; phase: 'countdown' | 'live' | 'over'; liveAtTick: number; endsAtTick: number;
    opponent: { id: string; name: string | null; tag: string | null; rating: number; team: Array<{ id: string; species: string; level: number; hp: number; maxHp: number; crashed: boolean; running: boolean }> };
    result: { winner: string | null; reason: 'wipeout' | 'timeout' | 'forfeit' | 'disconnect' } | null;
  }
  /** instanced PvP: your RAM daemons fight as copies, nothing is lost; in a match a daemon script enemies are the opponent's running daemons */
  export class ArenaApi {
    readonly match: ArenaMatch | null;
    queue(mode: 'ranked' | 'unranked'): Promise<unknown>; leave(): Promise<unknown>; challenge(operatorId: string, mode?: 'ranked' | 'unranked'): Promise<unknown>;
    accept(challengeId: string): Promise<unknown>; forfeit(): Promise<unknown>;
  }
```

(That file is one template literal: no backticks inside the typings.)

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint .` — expected: clean.

```bash
git add apps/frontend
git commit -m "feat(frontend): Arena tab — queue, challenges, standing, ladder, history"
```

---

### Task 3: End-to-end

**Files:**
- Modify: `apps/frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: The scenario**

Append:

```ts
test('two operators queue unranked, fight in the sandbox, one forfeits, both come home with their daemons', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const headers = { 'x-requested-with': 'daemonet' };
  for (const [page, who] of [
    [pa, `${name}ra`],
    [pb, `${name}rb`],
  ] as const) {
    await login(page, who);
    // the arena needs two daemons in RAM: seed one on Disk and load it at the host (the spawn point is within reach)
    expect((await page.request.post('/api/dev/daemon', { data: { species: 'pingling', level: 8 }, headers })).ok()).toBeTruthy();
    await page.getByTestId('tab-disk').click();
    await page.getByRole('button', { name: 'refresh' }).click();
    await page.getByRole('button', { name: 'load into RAM' }).click();
    await page.getByTestId('tab-arena').click();
    await expect(page.getByTestId('arena-me')).toContainText('rating 1500', { timeout: 10_000 });
    await expect(page.getByTestId('arena-queue-unranked')).toBeEnabled({ timeout: 10_000 });
  }
  await pa.getByTestId('arena-queue-unranked').click();
  await expect(pa.getByTestId('arena-waiting')).toContainText('waiting for a unranked match', { timeout: 10_000 });
  await pb.getByTestId('arena-queue-unranked').click();

  // both are moved into a sandbox world; the HUD shows the clock and both teams
  await expect(pa.getByTestId('arena-hud')).toBeVisible({ timeout: 15_000 });
  await expect(pb.getByTestId('arena-hud')).toBeVisible({ timeout: 15_000 });
  await expect(pa.getByTestId('arena-theirs')).toContainText(`${name}rb`, { timeout: 10_000 });
  await expect(pa.getByTestId('arena-theirs')).toContainText('Pingling L8');
  await expect(pa.getByTestId('subnet')).toHaveText('sandbox');
  await expect(pa.getByTestId('arena-queue-unranked')).toBeDisabled();

  await pb.getByTestId('arena-forfeit').click();
  await expect(pa.getByTestId('arena-result')).toContainText('you won by forfeit', { timeout: 10_000 });
  await expect(pb.getByTestId('arena-result')).toContainText('you lost by forfeit', { timeout: 10_000 });

  // three seconds later both are home, with the daemons they brought
  await expect(pa.getByTestId('arena-hud')).toHaveCount(0, { timeout: 15_000 });
  await expect(pa.getByTestId('subnet')).toHaveText('lo');
  await expect(pb.getByTestId('subnet')).toHaveText('lo', { timeout: 15_000 });
  await expect(pa.getByTestId('arena-last')).toContainText('you won by forfeit');
  await expect(pa.getByTestId('arena-history')).toContainText(`vs ${name}rb`, { timeout: 10_000 });
  await pa.getByTestId('tab-ram').click();
  await expect(pa.getByTestId('ram-1-name')).toHaveText('Pingling');
  await expect(pa.getByTestId('ram-0')).toBeVisible();
  await a.close();
  await b.close();
});
```

- [ ] **Step 2: Verify and commit**

`DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 56 files, 432 tests. Build, start the stack (sim, api, `vite preview`), `playwright test` — 5 passed.

```bash
git add apps/frontend
git commit -m "test(e2e): two operators queue, fight in the sandbox and come home"
```

---

## Self-review

- **Spec coverage:** §7 Arena tab with queue buttons and the waiting time, rating / band / record, ladder, match history, incoming challenges (plus challenging operators in view); the match HUD with the timer and both sides' copies (HP bars, crashed marks, running marks), the result and a forfeit button; the script editor knows `client.arena`. §8 the HUD unit test and the e2e (two browser operators queue unranked, the match starts, one forfeits, both return to `lo` with their daemons). This completes SP6 and the plan set.
- **Type consistency:** `ArenaResultInfo` has the fields of the `arenaResult` event, so the event object is stored as is; `ArenaMe` / `LadderRow` / `ArenaMatchRow` mirror the api responses of plan 2; `ArenaHud` reads only `OperatorSelf`.
- **Placeholders:** none.
