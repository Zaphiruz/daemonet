import { z } from 'zod';
import { randomBytes, toHex, utf8, xorRepeating, type ChallengeFamily } from './common.js';

/**
 * Crypto: recover a repeating-XOR key from known plaintext, then decrypt.
 * Plaintext is `size` characters of lowercase words and single spaces (ASCII).
 * Key length k = min(16, 2 + floor(size / 32)); key bytes are 1-255.
 * ciphertext[i] = plaintext[i] XOR key[i mod k], sent as hex.
 * params.known gives k consecutive plaintext characters starting at `offset`
 * (offset 0 with noise 0; a random offset otherwise).
 * Answer: the full plaintext.
 */
export interface CryptoParams {
  keyLength: number;
  known: { offset: number; text: string };
}
export interface CryptoPayload {
  ciphertext: string;
}
export interface CryptoAnswer {
  plaintext: string;
}

export const WORDS = [
  'packet', 'daemon', 'kernel', 'socket', 'buffer', 'signal', 'thread', 'cache',
  'proxy', 'cloud', 'stack', 'heap', 'root', 'shell', 'null', 'glitch',
  'route', 'frame', 'queue', 'mutex', 'fork', 'exec', 'pipe', 'port',
  'bind', 'listen', 'accept', 'hash', 'salt', 'nonce', 'cipher', 'key',
  'byte', 'nibble', 'word', 'page', 'fault', 'trap', 'tick', 'jiffy',
  'mask', 'tunnel', 'relay', 'hop', 'ping', 'echo', 'trace', 'flood',
  'sniff', 'tap', 'mirror', 'dump', 'image', 'clean', 'patch', 'bit',
  'flip', 'parity', 'check', 'sum', 'loop', 'node', 'link', 'wire',
] as const;

export const cryptoFamily: ChallengeFamily<CryptoParams, CryptoPayload, CryptoAnswer> = {
  type: 'crypto',
  answerSchema: z.object({ plaintext: z.string().max(65536) }),
  generate(size, noise, rng) {
    let text = '';
    while (text.length < size) text += (text ? ' ' : '') + rng.pick(WORDS);
    const plaintext = text.slice(0, size);
    const keyLength = Math.min(16, 2 + Math.floor(size / 32), size);
    const key = randomBytes(rng, keyLength, 1, 255);
    const ciphertext = xorRepeating(utf8(plaintext), key);
    const offset = noise === 0 ? 0 : rng.int(0, size - keyLength);
    return {
      params: { keyLength, known: { offset, text: plaintext.slice(offset, offset + keyLength) } },
      payload: { ciphertext: toHex(ciphertext) },
      answer: { plaintext },
    };
  },
  check: (expected, submitted) => expected.plaintext === submitted.plaintext,
};
