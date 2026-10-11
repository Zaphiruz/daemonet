import {
  CHAIN_STAGE_MAX_SIZE,
  MAX_CHALLENGE_SIZE,
  TYPES,
  checkAnswer,
  createRng,
  generateChallenge,
  publicChallenge,
  type Noise,
  type TypeId,
} from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { solve } from '../full-loop.js';

/** Small to the largest sizes the sim uses: a single challenge up to MAX_CHALLENGE_SIZE, a chain stage up to CHAIN_STAGE_MAX_SIZE. */
const SIZES = [8, 9, 16, 31, 33, 64, 100, 128, 200, CHAIN_STAGE_MAX_SIZE, 300, 512, 777, MAX_CHALLENGE_SIZE];
const NOISES: readonly Noise[] = [0, 1, 2];
const SEEDS_PER_NOISE = 100;

async function verdict(types: readonly TypeId[], size: number, noise: Noise, seed: string) {
  const challenge = generateChallenge(types, size, noise, createRng(seed));
  const answer: unknown = await solve(publicChallenge(challenge));
  return checkAnswer(challenge, answer);
}

describe('single-type challenges', () => {
  for (const type of TYPES) {
    it(`${type}: every noise level, sizes 8-${MAX_CHALLENGE_SIZE}, ${SEEDS_PER_NOISE} seeds per noise`, async () => {
      const failures: string[] = [];
      let solved = 0;
      for (const noise of NOISES) {
        for (let i = 0; i < SEEDS_PER_NOISE; i++) {
          const size = SIZES[i % SIZES.length]!;
          const seed = `single:${type}:${noise}:${i}`;
          const result = await verdict([type], size, noise, seed);
          if (result === 'correct') solved++;
          else failures.push(`${seed} size ${size}: ${result}`);
        }
      }
      expect(failures).toEqual([]);
      expect(solved).toBe(NOISES.length * SEEDS_PER_NOISE);
    });
  }
});

describe('dual-type chains', () => {
  it(`every ordered pair of the ${TYPES.length} families, every noise level`, async () => {
    const failures: string[] = [];
    let solved = 0;
    for (const a of TYPES) {
      for (const b of TYPES) {
        if (a === b) continue;
        for (const noise of NOISES) {
          const size = SIZES[(solved + failures.length) % SIZES.length]!;
          const seed = `chain:${a}:${b}:${noise}`;
          const result = await verdict([a, b], size, noise, seed);
          if (result === 'correct') solved++;
          else failures.push(`${seed} size ${size}: ${result}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(solved).toBe(TYPES.length * (TYPES.length - 1) * NOISES.length);
  });

  it('100 seeds of a sample of pairs at the largest stage size', async () => {
    const pairs: Array<[TypeId, TypeId]> = [
      ['packet', 'crypto'],
      ['socket', 'cloud'],
      ['proxy', 'shell'],
      ['thread', 'heap'],
      ['cloud', 'socket'],
      ['glitch', 'null'],
    ];
    const failures: string[] = [];
    for (const [a, b] of pairs) {
      for (let i = 0; i < 100; i++) {
        const noise = NOISES[i % 3]!;
        const seed = `chain-max:${a}:${b}:${i}`;
        const result = await verdict([a, b], MAX_CHALLENGE_SIZE, noise, seed);
        if (result !== 'correct') failures.push(`${seed}: ${result}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('solver speed', () => {
  it('solves the largest challenge of every family well inside the sniff deadline (2048 ms)', async () => {
    for (const type of TYPES) {
      const challenge = generateChallenge([type], MAX_CHALLENGE_SIZE, 2, createRng(`speed:${type}`));
      const started = performance.now();
      const answer: unknown = await solve(publicChallenge(challenge));
      const elapsed = performance.now() - started;
      expect(checkAnswer(challenge, answer)).toBe('correct');
      expect(elapsed, `${type} took ${elapsed.toFixed(1)} ms`).toBeLessThan(250);
    }
  });
});

