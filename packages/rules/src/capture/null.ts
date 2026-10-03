import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Null: chase pointers through a memory dump.
 * memory is an array of cells; a node is two consecutive cells [value, next] at an even address >= 2.
 * next is the address of the following node, or 0 (null) at the end. Cells 0 and 1 are always 0.
 * Start at params.head and follow `next` until 0. Values are 0-255.
 * With noise, an unreachable decoy chain is also present (noise 1: floor(n/4) nodes, noise 2: floor(n/2)).
 * Answer: the sum of the values of the reachable chain (`size` nodes).
 */
export interface NullParams {
  head: number;
  cellsPerNode: 2;
}
export interface NullPayload {
  memory: number[];
}
export interface NullAnswer {
  sum: number;
}

export const nullFamily: ChallengeFamily<NullParams, NullPayload, NullAnswer> = {
  type: 'null',
  answerSchema: z.object({ sum: z.number().int().nonnegative() }),
  generate(size, noise, rng) {
    const decoys = [0, Math.floor(size / 4), Math.floor(size / 2)][noise]!;
    const total = size + decoys;
    const memory = new Array<number>(2 + 2 * total).fill(0);
    const addresses = rng.shuffle(Array.from({ length: total }, (_, i) => 2 + 2 * i));
    const link = (chain: number[]): number => {
      let sum = 0;
      chain.forEach((addr, i) => {
        const value = rng.int(0, 255);
        sum += value;
        memory[addr] = value;
        memory[addr + 1] = chain[i + 1] ?? 0;
      });
      return sum;
    };
    const realChain = addresses.slice(0, size);
    const sum = link(realChain);
    link(addresses.slice(size));
    return { params: { head: realChain[0]!, cellsPerNode: 2 }, payload: { memory }, answer: { sum } };
  },
  check: (expected, submitted) => expected.sum === submitted.sum,
};
