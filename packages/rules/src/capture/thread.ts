import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Thread: find the first data race.
 *
 * Input: `events`, executed in array order; indices are 0-based positions in that array (lock and unlock
 * events count). Each event is `{ thread, op, obj }`.
 * - `lock` adds lock `obj` to the set of locks held by `thread`; `unlock` removes it. Held locks are a
 *   set per thread: locking a lock already held changes nothing, and one `unlock` releases it fully;
 *   unlocking a lock not held changes nothing.
 * - `read` / `write` access data `obj`. The lock set of an access is the set its thread holds at that
 *   moment, i.e. after applying all of that thread's earlier lock/unlock events.
 * - Two accesses at indices i < j race when they have the same `obj`, are from different threads, at
 *   least one is a `write`, and their lock sets share no lock.
 * Answer: `{ race: [i, j] }` for the race with the smallest i, and among those the smallest j;
 * `[-1, -1]` when no race exists.
 */
export interface ThreadEvent {
  thread: number;
  op: 'lock' | 'unlock' | 'read' | 'write';
  obj: string;
}
export interface ThreadParams {
  threads: number;
}
export interface ThreadPayload {
  events: ThreadEvent[];
}
export interface ThreadAnswer {
  race: [number, number];
}

export function firstRace(events: readonly ThreadEvent[]): [number, number] {
  const held = new Map<number, Set<string>>();
  const accesses: Array<{ i: number; thread: number; obj: string; write: boolean; locks: Set<string> }> = [];
  events.forEach((e, i) => {
    const locks = held.get(e.thread) ?? new Set<string>();
    held.set(e.thread, locks);
    if (e.op === 'lock') locks.add(e.obj);
    else if (e.op === 'unlock') locks.delete(e.obj);
    else accesses.push({ i, thread: e.thread, obj: e.obj, write: e.op === 'write', locks: new Set(locks) });
  });
  for (let a = 0; a < accesses.length; a++) {
    for (let b = a + 1; b < accesses.length; b++) {
      const x = accesses[a]!;
      const y = accesses[b]!;
      if (x.thread === y.thread || x.obj !== y.obj || !(x.write || y.write)) continue;
      if ([...x.locks].some((l) => y.locks.has(l))) continue;
      return [x.i, y.i];
    }
  }
  return [-1, -1];
}

export const threadFamily: ChallengeFamily<ThreadParams, ThreadPayload, ThreadAnswer> = {
  type: 'thread',
  rules: [
    'Thread: find the first data race.',
    '',
    'Input: `events`, executed in array order; indices are 0-based positions in that array (lock and unlock',
    'events count). Each event is `{ thread, op, obj }`.',
    '- `lock` adds lock `obj` to the set of locks held by `thread`; `unlock` removes it. Held locks are a',
    '  set per thread: locking a lock already held changes nothing, and one `unlock` releases it fully;',
    '  unlocking a lock not held changes nothing.',
    '- `read` / `write` access data `obj`. The lock set of an access is the set its thread holds at that',
    '  moment, i.e. after applying all of that thread\'s earlier lock/unlock events.',
    '- Two accesses at indices i < j race when they have the same `obj`, are from different threads, at',
    '  least one is a `write`, and their lock sets share no lock.',
    'Answer: `{ race: [i, j] }` for the race with the smallest i, and among those the smallest j;',
    '`[-1, -1]` when no race exists.',
  ].join('\n'),
  answerSchema: z.object({ race: z.tuple([z.number().int(), z.number().int()]) }),
  generate(size, _noise, rng) {
    const threads = rng.int(2, 4);
    const locks = ['m0', 'm1'];
    const data = ['x', 'y', 'z'];
    const events: ThreadEvent[] = [];
    const held: Set<string>[] = Array.from({ length: threads }, () => new Set());
    for (let i = 0; i < size; i++) {
      const thread = rng.int(0, threads - 1);
      const r = rng.float();
      if (r < 0.2) {
        const l = rng.pick(locks);
        if (held[thread]!.has(l)) {
          held[thread]!.delete(l);
          events.push({ thread, op: 'unlock', obj: l });
        } else {
          held[thread]!.add(l);
          events.push({ thread, op: 'lock', obj: l });
        }
      } else events.push({ thread, op: rng.chance(0.4) ? 'write' : 'read', obj: rng.pick(data) });
    }
    return { params: { threads }, payload: { events }, answer: { race: firstRace(events) } };
  },
  check: (e, s) => e.race[0] === s.race[0] && e.race[1] === s.race[1],
};
