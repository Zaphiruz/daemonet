import type { GameClient } from '@daemonet/sdk';
import { useEffect, useRef, useState } from 'react';
import { useArenaMatchesQuery, useArenaMeQuery, useLadderQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { ARENA_LEVEL, ARENA_MATCH_MS, ARENA_MIN_DAEMONS, ARENA_SEASON_MIN_MATCHES, ARENA_START_RATING, RUNNING_MAX } from '@daemonet/rules';
import { arenaStore, challengeLive, clockText, reconcileResult, useArena, type ArenaMode } from '../game/arena.ts';

/** Waits before each re-read of the match list while a ranked result has not been settled yet (about 2 minutes in all). */
export const PENDING_POLL_DELAYS_MS = [10_000, 20_000, 30_000, 30_000, 30_000];

/** Arena (SP6): queue or challenge, your standing this season, the ladder and your match history. Names are plain text. */
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
  // A finished match refetches all three views from the connection store (it also does after a reconnect). Here only a
  // result the sim could not settle yet (pending) is polled for until the match list shows it.
  // After the last attempt the result is worded as not counted: the store failed and no match row will ever appear.
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  const lastId = arena.lastResult?.id ?? null;
  const last = arena.lastResult ? reconcileResult(arena.lastResult, matches.data, client.operatorId, gaveUpOn === lastId) : null;
  const pending = last?.pending === true;
  const { refetch: refetchMatches } = matches;
  useEffect(() => {
    if (!pending) return;
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    let live = true;
    const step = () => {
      t = setTimeout(() => {
        const read = Promise.resolve(refetchMatches()).catch(() => {});
        i += 1;
        if (i < PENDING_POLL_DELAYS_MS.length) step();
        else void read.then(() => live && setGaveUpOn(lastId));
      }, PENDING_POLL_DELAYS_MS[i]);
    };
    step();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pending, lastId, refetchMatches]);

  // One command at a time: the buttons stay disabled until the server answers (accepted or refused; refusals are logged).
  const [inFlight, setInFlight] = useState(false);
  const busy = useRef(false);
  const send = (p: () => Promise<unknown>, label: string, then?: () => void) => {
    if (busy.current) return;
    busy.current = true;
    setInFlight(true);
    const promise = p();
    run(promise, label);
    const done = () => {
      busy.current = false;
      setInFlight(false);
    };
    void promise.then(
      () => {
        done();
        then?.();
      },
      done,
    );
  };

  const self = client.self;
  const manual = client.role === 'controller';
  const inMatch = !!self.arena;
  const ready = self.ram.filter((d) => !d.crashed).length;
  // the reasons follow the checks the server makes before it queues, challenges or accepts (in its order)
  const blocked = !manual
    ? 'spectators cannot play'
    : inMatch
      ? 'you are in a match'
      : !self.starterClaimed
        ? 'claim a starter first'
        : ready < ARENA_MIN_DAEMONS
          ? `you need ${ARENA_MIN_DAEMONS} daemons in RAM that have not crashed`
          : self.running.length > 0
            ? 'recall your running daemons first'
            : self.capture
              ? 'a capture is in progress'
              : null;
  const disabled = !!blocked || inFlight;
  const blockedId = 'arena-blocked';
  const queue = (mode: ArenaMode) => send(() => client.arena.queue(mode), 'arena queue');
  const nearby = client.world.operators.all().filter((o) => o.id !== client.operatorId);

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="arena">
      <section className="space-y-1 rounded border border-neutral-800 p-2 text-xs">
        {arena.queued ? (
          <div className="flex items-center justify-between" data-testid="arena-waiting" role="status" aria-live="polite">
            <span>
              waiting for a {arena.queued.mode} match · <span className="mono">{clockText(Math.max(0, Math.floor((now - arena.queued.since) / 1000)))}</span>
            </span>
            <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40" disabled={!manual || inFlight} onClick={() => send(() => client.arena.leave(), 'arena leave')} data-testid="arena-leave">
              leave queue
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40" disabled={disabled} aria-describedby={blockedId} onClick={() => queue('ranked')} data-testid="arena-queue-ranked">
              queue ranked
            </button>
            <button className="rounded bg-neutral-700 px-2 py-0.5 hover:bg-neutral-600 disabled:opacity-40" disabled={disabled} aria-describedby={blockedId} onClick={() => queue('unranked')} data-testid="arena-queue-unranked">
              queue unranked
            </button>
            <span className="text-neutral-500" id={blockedId}>
              {blocked ?? arena.note ?? `ranked: level ${ARENA_LEVEL}, rating on the line · unranked: as you are`}
            </span>
          </div>
        )}
        <p className="text-neutral-600">Your daemons fight as copies: no XP, no crashes, nothing lost. {RUNNING_MAX} run at a time; {ARENA_MATCH_MS / 60_000} minutes on the clock.</p>
      </section>

      <div role="status" aria-live="polite" className="space-y-3" data-testid="arena-challenges">
      {arena.challenges.filter((c) => challengeLive(c, now)).map((c) => (
        <div key={c.challengeId} className="flex items-center justify-between rounded border border-amber-900 p-2 text-xs" data-testid="arena-challenge">
          <span>
            {c.name ?? 'an operator'} challenges you ({c.mode})
            {blocked && (
              <span className="ml-1 text-neutral-500" id={`${blockedId}-${c.challengeId}`}>
                · {blocked}
              </span>
            )}
          </span>
          <span className="flex gap-2">
            <button
              className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
              disabled={disabled}
              title={blocked ?? undefined}
              aria-describedby={blocked ? `${blockedId}-${c.challengeId}` : undefined}
              onClick={() => send(() => client.arena.accept(c.challengeId), 'arena accept', () => arenaStore.dismiss(c.challengeId))}
            >
              accept
            </button>
            <button className="text-neutral-500 hover:text-neutral-200" onClick={() => arenaStore.dismiss(c.challengeId)} data-testid={`arena-ignore-${c.challengeId}`}>
              ignore
            </button>
          </span>
        </div>
      ))}
      </div>

      {last && (
        <p className="mono text-xs text-amber-200" data-testid="arena-last">
          last match: {last.text}
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
          <p className="text-neutral-600">ends {new Date(me.data.seasonEndsAt).toLocaleString()}; ratings then move halfway back to {ARENA_START_RATING}</p>
        </section>
      )}

      {nearby.length > 0 && !inMatch && (
        <section className="text-xs">
          <h3 className="mb-1 uppercase tracking-wide text-neutral-500">
            challenge someone nearby
            {blocked && (
              <span className="ml-1 normal-case text-neutral-600" id={`${blockedId}-nearby`}>
                · {blocked}
              </span>
            )}
          </h3>
          {nearby.slice(0, 8).map((o) => (
            <div key={o.id} className="flex items-center justify-between border-b border-neutral-900 py-0.5">
              <span>{o.name ?? o.id.slice(0, 8)}</span>
              <span className="flex gap-2">
                {(['unranked', 'ranked'] as const).map((mode) => (
                  <button
                    key={mode}
                    className="text-neutral-400 hover:text-white disabled:opacity-40"
                    disabled={disabled}
                    title={blocked ?? undefined}
                    aria-describedby={blocked ? `${blockedId}-nearby` : undefined}
                    onClick={() => send(() => client.arena.challenge(o.id, mode), 'arena challenge')}
                    data-testid={`arena-challenge-${o.id}-${mode}`}
                  >
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
        {ladder.data?.rows.length === 0 && <p className="text-neutral-600">nobody has played {ARENA_SEASON_MIN_MATCHES} ranked matches yet</p>}
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
