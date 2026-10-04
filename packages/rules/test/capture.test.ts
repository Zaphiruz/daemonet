import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromHex, fromUtf8, utf8 } from '../src/capture/common.js';
import { hammingEncode } from '../src/capture/glitch.js';
import {
  checkAnswer,
  generateChallenge,
  getFamily,
  hasFamily,
  publicChallenge,
  type ChainPayload,
} from '../src/capture/index.js';
import { challengeSize, type ChallengeTarget } from '../src/capture/size.js';
import { getTool, type Noise } from '../src/content/items.js';
import { createRng } from '../src/rng.js';
import { TYPES, type TypeId } from '../src/types.js';
import { solve } from './solvers.js';

const FAMILIES: TypeId[] = ['packet', 'crypto', 'glitch', 'null', 'kernel', 'cache', 'thread', 'signal'];

/** Change the answer so it is still schema-valid but wrong (every family's answer shape is covered). */
function mutate(answer: Record<string, unknown>): Record<string, unknown> {
  const [key, value] = Object.entries(answer)[0]!;
  if (typeof value === 'number') return { [key]: value + 1 };
  if (typeof value === 'string') {
    if (key === 'checksum' || key === 'hex' || key === 'contents') return { [key]: value === '' ? '00' : (value[0] === '0' ? '1' : '0') + value.slice(1) };
    if (key === 'allowed') return { [key]: (value[0] === '1' ? '0' : '1') + value.slice(1) };
    return { [key]: value + 'x' };
  }
  if (Array.isArray(value)) {
    if (key === 'race') return { [key]: [value[0] === -1 ? 0 : -1, value[1]] };
    return { [key]: [...value, typeof value[0] === 'number' ? 1 : 'x'] };
  }
  const entries = Object.entries(value as Record<string, string>);
  if (entries.length === 0) return { [key]: { extra: 'CLOSED' } };
  const [k, v] = entries[0]!;
  return { [key]: { ...(value as Record<string, string>), [k]: v === 'CLOSED' ? 'ESTABLISHED' : 'CLOSED' } };
}

describe('challengeSize', () => {
  const base: ChallengeTarget = { stage: 0, hpFraction: 1, clean: false, signature: 0, hardened: false, statused: false };
  const sniff = getTool('sniff');

  it('follows 16 * 2^stage * (1 + hp) with multipliers', () => {
    expect(challengeSize(base, sniff)).toBe(32);
    expect(challengeSize({ ...base, hpFraction: 0 }, sniff)).toBe(16);
    expect(challengeSize({ ...base, stage: 2 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, clean: true, signature: 3 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, hardened: true }, sniff)).toBe(64);
    expect(challengeSize({ ...base, statused: true }, sniff)).toBe(16);
    expect(challengeSize({ ...base, hpFraction: 0.25 }, getTool('dump'))).toBe(10);
  });

  it('never goes below 8 and clamps hp', () => {
    expect(challengeSize({ ...base, hpFraction: 0, statused: true }, getTool('dump'))).toBe(8);
    expect(challengeSize({ ...base, hpFraction: 5 }, sniff)).toBe(32);
  });
});

describe('hammingEncode', () => {
  it('encodes known nibbles', () => {
    expect(hammingEncode(0b0000)).toBe(0);
    // d1..d4 = 1011 -> p1=0, p2=1, p3=0 -> bits p1 p2 d1 p3 d2 d3 d4 = 0 1 1 0 0 1 1
    expect(hammingEncode(0b1011)).toBe(0b1100110);
  });
});

describe.each(FAMILIES)('%s family', (type) => {
  it('is registered', () => {
    expect(TYPES).toContain(type);
    expect(hasFamily(type)).toBe(true);
  });

  it('the reference solver passes and a mutated answer fails', () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 300 }), fc.constantFrom<Noise>(0, 1, 2), fc.integer(), (size, noise, seed) => {
        const challenge = generateChallenge([type], size, noise, createRng(seed));
        const answer = solve(publicChallenge(challenge)) as Record<string, unknown>;
        expect(checkAnswer(challenge, answer)).toBe('correct');
        expect(checkAnswer(challenge, mutate(answer))).toBe('wrong');
      }),
      { numRuns: 64 },
    );
  });

  it('is deterministic per seed', () => {
    const a = generateChallenge([type], 64, 2, createRng('same'));
    const b = generateChallenge([type], 64, 2, createRng('same'));
    expect(a).toEqual(b);
  });

  it('stays under 64 KiB at the largest SP1 size', () => {
    // stage 0, full HP, clean, signature, hardened: 16 * 2 * 2 * 2 * 2 = 256; allow 4x headroom.
    const challenge = generateChallenge([type], 1024, 2, createRng('big'));
    expect(JSON.stringify(publicChallenge(challenge)).length).toBeLessThan(65536);
  });

  it('rejects malformed answers as invalid', () => {
    const challenge = generateChallenge([type], 16, 0, createRng(1));
    expect(checkAnswer(challenge, { nope: true })).toBe('invalid');
    expect(checkAnswer(challenge, null)).toBe('invalid');
  });
});

describe('chained challenges', () => {
  it('solving stage one unseals stage two', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FAMILIES), fc.constantFrom(...FAMILIES), fc.integer(), (a, b, seed) => {
        const challenge = generateChallenge([a, b], 24, 1, createRng(seed));
        expect(challenge.kind).toBe('chain');
        expect(challenge.families).toEqual([a, b]);
        const answer = solve(publicChallenge(challenge));
        expect(checkAnswer(challenge, answer)).toBe('correct');
      }),
      { numRuns: 48 },
    );
  });

  it('resists a known-prefix repeating-XOR attack on packet -> glitch chains', () => {
    for (let seed = 0; seed < 32; seed++) {
      const challenge = generateChallenge(['packet', 'glitch'], 24, 1, createRng(seed));
      const chain = challenge.payload as ChainPayload;
      const cipher = fromHex(chain.sealed);

      // Rebuild the real stage two from the same seed to know the plaintext and first answer.
      const rng = createRng(seed);
      const first = getFamily('packet').generate(24, 1, rng);
      const second = getFamily('glitch').generate(24, 1, rng);
      expect(second.answer).toEqual(challenge.answer);
      const plaintext = JSON.stringify({ params: second.params, payload: second.payload });
      const prefix = '{"params":{"encoding":"hamming74","bytes":24},"payload":{"blocks":[';
      expect(plaintext.startsWith(prefix)).toBe(true);

      // A repeating-XOR attacker assumes the key period is the length of the canonical first answer.
      const period = JSON.stringify(first.answer).length;
      expect(period).toBe(23);
      const known = utf8(prefix);
      const key = Array.from({ length: period }, (_, i) => cipher[i]! ^ known[i]!);
      const guess = fromUtf8(cipher.map((b, i) => b ^ key[i % period]!));
      expect(guess).not.toBe(plaintext);
      expect(guess.slice(prefix.length)).not.toBe(plaintext.slice(prefix.length));
    }
  });

  it('never exposes the answer publicly', () => {
    const challenge = generateChallenge(['packet', 'glitch'], 16, 0, createRng(2));
    expect(publicChallenge(challenge)).not.toHaveProperty('answer');
  });

  it('rejects bad type counts', () => {
    expect(() => generateChallenge([], 16, 0, createRng(3))).toThrow(RangeError);
    expect(() => generateChallenge(['kernel', 'heap', 'null'], 16, 0, createRng(3))).toThrow(RangeError);
  });
});
