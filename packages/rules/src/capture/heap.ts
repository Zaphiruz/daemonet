import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Heap: find the leaked allocations.
 * Replay `alloc` / `free` events in order. `alloc` marks its id allocated (the `size` is irrelevant; allocating an
 * id that is already allocated changes nothing). `free` of an id that is not currently allocated (never allocated,
 * or already freed) is ignored (noise); an id that was freed may be allocated again. Answer: the ids still
 * allocated at the end, ascending numerically, each once.
 */
export type HeapEvent = { op: 'alloc'; id: number; size: number } | { op: 'free'; id: number };
export interface HeapParams {
  events: number;
}
export interface HeapPayload {
  events: HeapEvent[];
}
export interface HeapAnswer {
  leaked: number[];
}

export function leaked(events: readonly HeapEvent[]): number[] {
  const live = new Set<number>();
  for (const e of events) {
    if (e.op === 'alloc') live.add(e.id);
    else live.delete(e.id);
  }
  return [...live].sort((a, b) => a - b);
}

export const heapFamily: ChallengeFamily<HeapParams, HeapPayload, HeapAnswer> = {
  type: 'heap',
  rules: [
    'Heap: find the leaked allocations.',
    'Replay `alloc` / `free` events in order. `alloc` marks its id allocated (the `size` is irrelevant; allocating an',
    'id that is already allocated changes nothing). `free` of an id that is not currently allocated (never allocated,',
    'or already freed) is ignored (noise); an id that was freed may be allocated again. Answer: the ids still',
    'allocated at the end, ascending numerically, each once.',
  ].join('\n'),
  answerSchema: z.object({ leaked: z.array(z.number().int()).max(16384) }),
  generate(size, noise, rng) {
    const events: HeapEvent[] = [];
    const live: number[] = [];
    let next = 1;
    for (let i = 0; i < size; i++) {
      if (live.length > 0 && rng.chance(0.4)) {
        const idx = rng.int(0, live.length - 1);
        events.push({ op: 'free', id: live[idx]! });
        live.splice(idx, 1);
      } else {
        const id = next++;
        live.push(id);
        events.push({ op: 'alloc', id, size: 2 ** rng.int(3, 12) });
      }
    }
    const bad = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < bad; i++) events.splice(rng.int(0, events.length), 0, { op: 'free', id: rng.chance(0.5) ? next + i : rng.int(1, next) });
    return { params: { events: events.length }, payload: { events }, answer: { leaked: leaked(events) } };
  },
  check: (e, s) => e.leaked.length === s.leaked.length && e.leaked.every((v, i) => v === s.leaked[i]),
};
