import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Buffer: an overwriting ring buffer of bytes.
 * `w:<hex byte>` appends (when full, the oldest byte is dropped first); `r` removes the oldest byte
 * (no-op when empty). Answer: the remaining bytes, oldest first, as lowercase hex.
 */
export interface BufferParams {
  capacity: number;
}
export interface BufferPayload {
  ops: string[];
}
export interface BufferAnswer {
  contents: string;
}

export function ringContents(capacity: number, ops: readonly string[]): string {
  const buf: string[] = [];
  for (const op of ops) {
    if (op === 'r') buf.shift();
    else if (op.startsWith('w:')) {
      if (buf.length >= capacity) buf.shift();
      buf.push(op.slice(2));
    }
  }
  return buf.join('');
}

export const bufferFamily: ChallengeFamily<BufferParams, BufferPayload, BufferAnswer> = {
  type: 'buffer',
  answerSchema: z.object({ contents: z.string().regex(/^(?:[0-9a-f]{2})*$/).max(65536) }),
  generate(size, _noise, rng) {
    const capacity = Math.max(2, Math.floor(size / 4));
    const ops: string[] = [];
    for (let i = 0; i < size; i++) ops.push(rng.chance(0.7) ? `w:${rng.int(0, 255).toString(16).padStart(2, '0')}` : 'r');
    return { params: { capacity }, payload: { ops }, answer: { contents: ringContents(capacity, ops) } };
  },
  check: (e, s) => e.contents === s.contents,
};
