import type { z } from 'zod';
import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';

/** One stage of a challenge. `answer` never leaves the server. */
export interface Stage<P = unknown, Y = unknown, A = unknown> {
  params: P;
  payload: Y;
  answer: A;
}

export interface ChallengeFamily<P = unknown, Y = unknown, A = unknown> {
  type: TypeId;
  /** Player-facing rule text (plain text), served by the Codex. */
  rules: string;
  answerSchema: z.ZodType<A>;
  generate(size: number, noise: Noise, rng: Rng): Stage<P, Y, A>;
  check(expected: A, submitted: A): boolean;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new RangeError('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomBytes(rng: Rng, length: number, min = 0, max = 255): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.int(min, max);
  return out;
}

/** 32-bit FNV-1a over bytes, as 8 lowercase hex chars. */
export function fnv1a32Hex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function xorRepeating(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new RangeError('empty key');
  return data.map((b, i) => b ^ key[i % key.length]!);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
