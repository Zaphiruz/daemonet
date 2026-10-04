import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Cache: count the hits of an LRU cache.
 *
 * Input: `capacity` (number of keys the cache holds; capacity >= 1) and `trace`, a list of accesses processed in array
 * order. The cache starts empty.
 * - A trace entry whose first character is '#' is a comment (noise): skip it entirely; it is not an
 *   access and changes nothing.
 * - Every other entry is an access to that exact key (case-sensitive string comparison).
 * - Hit: the key is already in the cache. Count one hit; the key becomes the most recently used.
 * - Miss: the key is not in the cache. If the cache already holds `capacity` keys, first evict the least
 *   recently used key (the one whose latest access, hit or insert, is oldest); then insert the key as the
 *   most recently used. Misses are not counted.
 * Answer: `{ hits }`, the total number of hits.
 */
export interface CacheParams {
  capacity: number;
}
export interface CachePayload {
  trace: string[];
}
export interface CacheAnswer {
  hits: number;
}

export function lruHits(capacity: number, trace: readonly string[]): number {
  const order: string[] = [];
  let hits = 0;
  for (const key of trace) {
    if (key.startsWith('#')) continue;
    const i = order.indexOf(key);
    if (i >= 0) {
      hits++;
      order.splice(i, 1);
    } else if (order.length >= capacity) order.shift();
    order.push(key);
  }
  return hits;
}

export const cacheFamily: ChallengeFamily<CacheParams, CachePayload, CacheAnswer> = {
  type: 'cache',
  rules: [
    'Cache: count the hits of an LRU cache.',
    '',
    'Input: `capacity` (number of keys the cache holds; capacity >= 1) and `trace`, a list of accesses processed in array',
    'order. The cache starts empty.',
    '- A trace entry whose first character is \'#\' is a comment (noise): skip it entirely; it is not an',
    '  access and changes nothing.',
    '- Every other entry is an access to that exact key (case-sensitive string comparison).',
    '- Hit: the key is already in the cache. Count one hit; the key becomes the most recently used.',
    '- Miss: the key is not in the cache. If the cache already holds `capacity` keys, first evict the least',
    '  recently used key (the one whose latest access, hit or insert, is oldest); then insert the key as the',
    '  most recently used. Misses are not counted.',
    'Answer: `{ hits }`, the total number of hits.',
  ].join('\n'),
  answerSchema: z.object({ hits: z.number().int().nonnegative() }),
  generate(size, noise, rng) {
    const capacity = Math.max(2, Math.floor(size / 4));
    const alphabet = Math.max(3, capacity * 2);
    const trace: string[] = [];
    for (let i = 0; i < size; i++) trace.push(`k${rng.int(0, alphabet - 1)}`);
    const decoys = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < decoys; i++) trace.splice(rng.int(0, trace.length), 0, `#k${rng.int(0, alphabet - 1)}`);
    return { params: { capacity }, payload: { trace }, answer: { hits: lruHits(capacity, trace) } };
  },
  check: (e, s) => e.hits === s.hits,
};
