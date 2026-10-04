import {
  ARENA_CHALLENGE_TTL_MS,
  ARENA_COUNTDOWN_MS,
  ARENA_DISCONNECT_MS,
  ARENA_MATCH_MS,
  ARENA_MAX_MATCHES,
  ARENA_MIN_DAEMONS,
  ARENA_PAIR_DAILY_CAP,
  ARENA_QUEUE_WIDEN_MS,
  ARENA_QUEUE_WINDOW,
  ARENA_RETURN_MS,
  SANDBOX,
  msToTicks,
  type ArenaMode,
} from '@daemonet/rules';
import type { ErrorCode, GameEvent, ServerMessage } from '@daemonet/shared';
import { World, arenaRecord, concede, concedeBoth, type Operator, type OperatorRecord } from '../core/index.js';

export interface ArenaError {
  code: ErrorCode;
  message: string;
}
const fail = (message: string, code: ErrorCode = 'E_STATE'): ArenaError => ({ code, message });
export const isArenaError = (r: object): r is ArenaError => 'code' in r && 'message' in r;

/** What the service needs from the runtime (`Game`); tests pass fakes. */
export interface ArenaDeps {
  /** A connected operator that is in a persistent world (not in a match), with that world. */
  locate(id: string): { op: Operator; world: World } | undefined;
  /** True while a controller connection is attached to the operator's session. */
  connected(id: string): boolean;
  /** True while any intent of the operator is waiting for the store, in any persistent world. */
  busy(id: string): boolean;
  /**
   * Hands the operator from the world it is in to `to`, entering with `record`, and sends fresh snapshots. False when
   * it could not (no session, or the operator is not in its session's world): nothing changed.
   */
  transfer(id: string, to: World, record: OperatorRecord): boolean;
  /** Queues an event for the operator in whatever world it is in. */
  event(id: string, event: GameEvent): void;
  /** An out-of-tick message to every connection of the operator. */
  send(id: string, msg: ServerMessage): void;
  rating(id: string): number;
  now(): number;
  /** 32 hex characters. */
  newId(): string;
}

interface Side {
  id: string;
  home: World;
  /** The operator as it left its home world: what checkpoints write and what it returns with. */
  record: OperatorRecord;
  goneTicks: number;
  returned: boolean;
}

interface Match {
  id: string;
  mode: ArenaMode;
  world: World;
  sides: Side[];
  reported: boolean;
  returnAtTick: number;
}

interface Waiting {
  id: string;
  mode: ArenaMode;
  since: number;
}

interface Challenge {
  id: string;
  from: string;
  to: string;
  mode: ArenaMode;
  expiresAt: number;
}

const MATCHMAKING_EVERY_TICKS = 16;
/** Challenges an operator may send per minute (each one is a message to its target). */
const CHALLENGES_PER_MINUTE = 8;
const MINUTE_MS = 60_000;

/**
 * Arena matches (SP6 spec §5): the queue, direct challenges and the life of each match world. Runs outside the
 * worlds' ticks; the match rules themselves (targets, win conditions) live in the core.
 *
 * Isolation: a match world holds copies that keep their daemons' ids, and it is never one of the runtime's persistent
 * worlds. The service keeps each operator's home record: checkpoints write it (`homeRecord`) and the operator returns
 * with it, plus the bits, Disk slots, name and org the api pushed to the operator meanwhile (`merged`).
 */
export class ArenaService {
  private readonly matches = new Map<string, Match>();
  private readonly byOperator = new Map<string, Match>();
  private queue: Waiting[] = [];
  private readonly challenges = new Map<string, Challenge>();
  /** Challenger -> send times (ms) within the last minute. */
  private readonly sentChallenges = new Map<string, number[]>();
  /** `<a>|<b>:<utc day>` → ranked matches started that day between the two (in memory; plan 2 reads ArenaMatch rows). */
  private readonly pairCounts = new Map<string, number>();
  private ticks = 0;

  constructor(private readonly deps: ArenaDeps) {}

  /** Match worlds to step this tick. */
  worlds(): World[] {
    return [...this.matches.values()].map((m) => m.world);
  }

  inMatch(id: string): boolean {
    return this.byOperator.has(id);
  }

  /** The record to checkpoint for an operator that is in a match (its home-world state), if any. */
  homeRecord(id: string): OperatorRecord | undefined {
    const match = this.byOperator.get(id);
    const side = match?.sides.find((s) => s.id === id && !s.returned);
    return match && side ? this.merged(match, side) : undefined;
  }

  queued(id: string): ArenaMode | null {
    return this.queue.find((w) => w.id === id)?.mode ?? null;
  }

  // ---- entering ----

  private eligible(id: string): ArenaError | { op: Operator; world: World } {
    if (this.byOperator.has(id)) return fail('already in an arena match');
    const loc = this.deps.locate(id);
    if (!loc || !this.deps.connected(id)) return fail('not connected');
    const { op, world } = loc;
    if (!op.starterClaimed) return fail('claim a starter first');
    const ready = op.ram.filter((d) => world.daemons.get(d)?.crashed === false).length;
    if (ready < ARENA_MIN_DAEMONS) return fail(`the arena needs ${ARENA_MIN_DAEMONS} daemons in RAM that have not crashed`);
    if (op.running.length > 0) return fail('recall running daemons first');
    if (op.captureId) return fail('a capture is in progress');
    if (op.travelling || op.pendingClaim || world.hasPendingFor(id) || this.deps.busy(id)) return fail('wait for pending actions');
    return loc;
  }

  /** Joins the queue; queueing again in the same mode keeps the place (and the widened rating window). */
  queueUp(id: string, mode: ArenaMode): ArenaError | { queued: ArenaMode } {
    const ok = this.eligible(id);
    if (isArenaError(ok)) return ok;
    if (this.queued(id) === mode) return { queued: mode };
    this.queue = this.queue.filter((w) => w.id !== id);
    this.queue.push({ id, mode, since: this.deps.now() });
    this.deps.event(id, { e: 'arenaQueued', mode });
    return { queued: mode };
  }

  leaveQueue(id: string): { ok: true } {
    if (this.queue.some((w) => w.id === id)) {
      this.queue = this.queue.filter((w) => w.id !== id);
      this.deps.event(id, { e: 'arenaQueued', mode: null });
    }
    return { ok: true };
  }

  /** Challenges another online operator; a new challenge replaces the challenger's previous one. */
  challenge(id: string, targetId: string, mode: ArenaMode): ArenaError | { challengeId: string } {
    if (id === targetId) return fail('you cannot challenge yourself', 'E_INVALID');
    const ok = this.eligible(id);
    if (isArenaError(ok)) return ok;
    // every attempt counts before the target is looked at, so the replies are no free presence oracle
    const now = this.deps.now();
    const recent = (this.sentChallenges.get(id) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= CHALLENGES_PER_MINUTE) return fail('too many challenges; wait a moment', 'E_RATE');
    recent.push(now);
    this.sentChallenges.set(id, recent);
    if (this.byOperator.has(targetId)) return fail('that operator is in a match');
    if (!this.deps.locate(targetId) || !this.deps.connected(targetId)) return fail('that operator is not online');
    for (const c of [...this.challenges.values()]) if (c.from === id) this.challenges.delete(c.id);
    const c: Challenge = { id: this.deps.newId(), from: id, to: targetId, mode, expiresAt: now + ARENA_CHALLENGE_TTL_MS };
    this.challenges.set(c.id, c);
    this.deps.send(targetId, { t: 'arenaChallenge', seq: 0, d: { challengeId: c.id, from: id, name: ok.op.name, mode, expiresAt: new Date(c.expiresAt).toISOString() } });
    return { challengeId: c.id };
  }

  accept(id: string, challengeId: string): ArenaError | { matchId: string } {
    const c = this.challenges.get(challengeId);
    if (!c || c.to !== id) return fail('no such challenge', 'E_INVALID');
    if (c.expiresAt <= this.deps.now()) {
      this.challenges.delete(c.id);
      return fail('that challenge has expired');
    }
    const me = this.eligible(id);
    if (isArenaError(me)) return me;
    if (isArenaError(this.eligible(c.from))) {
      this.challenges.delete(c.id);
      return fail('the challenger is no longer available');
    }
    if (this.matches.size >= ARENA_MAX_MATCHES) return fail('the arena is full; try again shortly');
    this.challenges.delete(c.id);
    const match = this.start(c.from, id, c.mode);
    return match ? { matchId: match.id } : fail('the match could not start');
  }

  forfeit(id: string): ArenaError | { ok: true } {
    const match = this.byOperator.get(id);
    if (!match || match.world.arena!.phase === 'over') return fail('not in an arena match');
    concede(match.world, id, 'forfeit');
    return { ok: true };
  }

  /**
   * The operator is leaving the server: out of the queue, challenges dropped, and out of its match (which it loses),
   * back in its home world so the leave checkpoint that follows sees the real operator.
   */
  drop(id: string): void {
    this.queue = this.queue.filter((w) => w.id !== id);
    this.sentChallenges.delete(id);
    for (const c of [...this.challenges.values()]) if (c.from === id || c.to === id) this.challenges.delete(c.id);
    const match = this.byOperator.get(id);
    if (!match) return;
    concede(match.world, id, 'disconnect');
    if (!match.reported) this.report(match);
    this.sendHome(match, match.sides.find((s) => s.id === id)!);
    this.closeIfEmpty(match);
  }

  /** Shutdown: every match ends without a result and everyone in one goes home (the final checkpoint follows). */
  endAll(): void {
    for (const match of [...this.matches.values()]) {
      for (const side of match.sides) this.sendHome(match, side);
      this.matches.delete(match.id);
    }
    this.queue = [];
    this.challenges.clear();
  }

  // ---- matches ----

  private static day(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  private pairKey(a: string, b: string): string {
    return `${[a, b].sort().join('|')}:${ArenaService.day(this.deps.now())}`;
  }

  /**
   * Builds the match world and hands both operators over. Null (and nobody moved) when a hand-over fails: the side
   * already moved goes straight back, so the core never resolves a match against a missing operator, and both are
   * told (out of the queue, with the reason).
   */
  private start(aId: string, bId: string, wanted: ArenaMode): Match | null {
    // win-trading guard: past the daily cap a ranked pairing is played as unranked
    const key = this.pairKey(aId, bId);
    const played = this.pairCounts.get(key) ?? 0;
    const mode: ArenaMode = wanted === 'ranked' && played >= ARENA_PAIR_DAILY_CAP ? 'unranked' : wanted;

    const id = this.deps.newId();
    const liveAtTick = msToTicks(ARENA_COUNTDOWN_MS);
    const endsAtTick = liveAtTick + msToTicks(ARENA_MATCH_MS);
    const ratings = { [aId]: this.deps.rating(aId), [bId]: this.deps.rating(bId) };
    const world = new World({ subnet: SANDBOX, seed: id, seedId: id.slice(0, 8), spawner: false });
    world.arena = { id, mode, a: aId, b: bId, phase: 'countdown', liveAtTick, endsAtTick, ratings, dealt: new Set(), result: null };

    this.queue = this.queue.filter((w) => w.id !== aId && w.id !== bId);
    for (const c of [...this.challenges.values()]) if ([aId, bId].includes(c.from) || [aId, bId].includes(c.to)) this.challenges.delete(c.id);
    const match: Match = { id, mode, world, sides: [], reported: false, returnAtTick: 0 };
    for (const [i, opId] of [aId, bId].entries()) {
      const loc = this.deps.locate(opId);
      const record = loc?.world.checkpoint(opId);
      if (!loc || !record || !this.deps.transfer(opId, world, arenaRecord(record, mode, SANDBOX.id, SANDBOX.arenaSpawns[i as 0 | 1]))) {
        for (const side of match.sides) this.sendHome(match, side);
        for (const who of [aId, bId]) this.deps.event(who, { e: 'arenaQueued', mode: null, reason: 'the match could not start' });
        return null;
      }
      for (const form of loc.world.discovered) world.discovered.add(form);
      match.sides.push({ id: opId, home: loc.world, record, goneTicks: 0, returned: false });
      this.byOperator.set(opId, match);
    }
    if (mode === 'ranked') this.pairCounts.set(key, played + 1);
    this.matches.set(id, match);
    for (const [me, other] of [
      [aId, bId],
      [bId, aId],
    ] as const) {
      const opp = world.operators.get(other)!;
      this.deps.event(me, { e: 'arenaMatch', id, mode, opponent: { id: other, name: opp.name, tag: opp.org?.tag ?? null, rating: ratings[other]! }, startsAtTick: liveAtTick, endsAtTick });
    }
    return match;
  }

  /** Tells both operators how it ended and schedules the way home. Ratings and rewards arrive with SP6 plan 2. */
  private report(match: Match): void {
    const arena = match.world.arena!;
    const result = arena.result!;
    match.reported = true;
    match.returnAtTick = match.world.tick + msToTicks(ARENA_RETURN_MS);
    for (const side of match.sides) {
      if (side.returned) continue;
      const rating = arena.ratings[side.id]!;
      const outcome = result.winner === null ? 'draw' : result.winner === side.id ? 'win' : 'loss';
      this.deps.event(side.id, { e: 'arenaResult', id: match.id, mode: match.mode, outcome, reason: result.reason, ratingBefore: rating, ratingAfter: rating, reward: 0, counted: false });
    }
  }

  /**
   * The home record with what the api pushed to the operator during the match (bits, Disk slots, name, org land on the
   * copy in the match world, which the client sees); nothing else the copy did comes home.
   */
  private merged(match: Match, side: Side): OperatorRecord {
    const live = match.world.operators.get(side.id);
    if (!live) return side.record;
    return { ...side.record, bits: live.bits, diskSlots: [...live.diskSlots].sort((x, y) => x - y), name: live.name, org: live.org ? { ...live.org } : null };
  }

  private sendHome(match: Match, side: Side): void {
    if (side.returned) return;
    side.returned = true;
    this.byOperator.delete(side.id);
    this.deps.transfer(side.id, side.home, this.merged(match, side));
  }

  private closeIfEmpty(match: Match): void {
    if (match.sides.every((s) => s.returned)) this.matches.delete(match.id);
  }

  /** Once per game tick, after the worlds have stepped. */
  tick(): void {
    this.ticks++;
    const goneLimit = msToTicks(ARENA_DISCONNECT_MS);
    for (const match of [...this.matches.values()]) {
      const arena = match.world.arena!;
      if (arena.phase !== 'over') {
        const gone: string[] = [];
        for (const side of match.sides) {
          if (side.returned) continue;
          side.goneTicks = this.deps.connected(side.id) ? 0 : side.goneTicks + 1;
          if (side.goneTicks >= goneLimit) gone.push(side.id);
        }
        if (gone.length === 2) concedeBoth(match.world);
        else if (gone.length === 1) concede(match.world, gone[0]!, 'disconnect');
      }
      if (arena.phase === 'over' && !match.reported) this.report(match);
      if (match.reported && match.world.tick >= match.returnAtTick) {
        for (const side of match.sides) this.sendHome(match, side);
        this.matches.delete(match.id);
      }
    }
    if (this.ticks % MATCHMAKING_EVERY_TICKS === 0) {
      const now = this.deps.now();
      for (const c of [...this.challenges.values()]) if (c.expiresAt <= now) this.challenges.delete(c.id);
      for (const [id, times] of this.sentChallenges) if (times.every((t) => now - t >= MINUTE_MS)) this.sentChallenges.delete(id);
      const today = `:${ArenaService.day(now)}`;
      for (const key of [...this.pairCounts.keys()]) if (!key.endsWith(today)) this.pairCounts.delete(key);
      this.matchmake(now);
    }
  }

  /** Unranked: first come, first served. Ranked: the closest pair whose rating windows overlap, again and again. */
  private matchmake(now: number): void {
    for (const w of [...this.queue]) {
      const ok = this.eligible(w.id);
      if (isArenaError(ok)) {
        this.queue = this.queue.filter((x) => x !== w);
        this.deps.event(w.id, { e: 'arenaQueued', mode: null, reason: ok.message });
      }
    }
    for (;;) {
      if (this.matches.size >= ARENA_MAX_MATCHES) return;
      const casual = this.queue.filter((w) => w.mode === 'unranked');
      if (casual.length >= 2) {
        // a failed start still takes both out of the queue, so this always makes progress
        this.start(casual[0]!.id, casual[1]!.id, 'unranked');
        continue;
      }
      const ranked = this.queue
        .filter((w) => w.mode === 'ranked')
        .map((w) => ({ w, rating: this.deps.rating(w.id), window: ARENA_QUEUE_WINDOW * (1 + Math.floor((now - w.since) / ARENA_QUEUE_WIDEN_MS)) }));
      let best: { a: string; b: string; gap: number } | null = null;
      for (let i = 0; i < ranked.length; i++) {
        for (let j = i + 1; j < ranked.length; j++) {
          const gap = Math.abs(ranked[i]!.rating - ranked[j]!.rating);
          if (gap <= ranked[i]!.window + ranked[j]!.window && (!best || gap < best.gap)) best = { a: ranked[i]!.w.id, b: ranked[j]!.w.id, gap };
        }
      }
      if (!best) return;
      this.start(best.a, best.b, 'ranked');
    }
  }
}
