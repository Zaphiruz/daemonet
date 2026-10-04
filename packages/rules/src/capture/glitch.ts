import { z } from 'zod';
import { randomBytes, toHex, type ChallengeFamily } from './common.js';

/**
 * Glitch: correct Hamming(7,4) blocks.
 * Each data byte becomes two blocks: high nibble first, then low nibble.
 * Nibble bits d1..d4 = bits 3..0. Codeword positions 1..7 = p1 p2 d1 p3 d2 d3 d4, with
 *   p1 = d1^d2^d4, p2 = d1^d3^d4, p3 = d2^d3^d4.
 * A block is an integer 0-127 whose bit (pos - 1) holds position pos (position 1 = least significant bit).
 * Each block has at most one flipped bit; flip probability per block is 1/4, 1/2, 3/4 for noise 0, 1, 2.
 * Answer: the corrected data bytes as lowercase hex.
 */
export interface GlitchParams {
  encoding: 'hamming74';
  bytes: number;
}
export interface GlitchPayload {
  blocks: number[];
}
export interface GlitchAnswer {
  hex: string;
}

const bit = (value: number, index: number): number => (value >> index) & 1;

export function hammingEncode(nibble: number): number {
  const d1 = bit(nibble, 3);
  const d2 = bit(nibble, 2);
  const d3 = bit(nibble, 1);
  const d4 = bit(nibble, 0);
  const p1 = d1 ^ d2 ^ d4;
  const p2 = d1 ^ d3 ^ d4;
  const p3 = d2 ^ d3 ^ d4;
  return p1 | (p2 << 1) | (d1 << 2) | (p3 << 3) | (d2 << 4) | (d3 << 5) | (d4 << 6);
}

const FLIP_PROBABILITY = [0.25, 0.5, 0.75] as const;

export const glitchFamily: ChallengeFamily<GlitchParams, GlitchPayload, GlitchAnswer> = {
  type: 'glitch',
  rules: [
    'Glitch: correct Hamming(7,4) blocks.',
    'Each data byte becomes two blocks: high nibble first, then low nibble.',
    'Nibble bits d1..d4 = bits 3..0. Codeword positions 1..7 = p1 p2 d1 p3 d2 d3 d4, with',
    '  p1 = d1^d2^d4, p2 = d1^d3^d4, p3 = d2^d3^d4.',
    'A block is an integer 0-127 whose bit (pos - 1) holds position pos (position 1 = least significant bit).',
    'Each block has at most one flipped bit; flip probability per block is 1/4, 1/2, 3/4 for noise 0, 1, 2.',
    'Answer: the corrected data bytes as lowercase hex.',
  ].join('\n'),
  answerSchema: z.object({ hex: z.string().max(65536).regex(/^(?:[0-9a-f]{2})*$/) }),
  generate(size, noise, rng) {
    const data = randomBytes(rng, size);
    const blocks: number[] = [];
    for (const byte of data) {
      for (const nibble of [byte >> 4, byte & 0x0f]) {
        let block = hammingEncode(nibble);
        if (rng.chance(FLIP_PROBABILITY[noise])) block ^= 1 << rng.int(0, 6);
        blocks.push(block);
      }
    }
    return { params: { encoding: 'hamming74', bytes: size }, payload: { blocks }, answer: { hex: toHex(data) } };
  },
  check: (expected, submitted) => expected.hex === submitted.hex,
};
