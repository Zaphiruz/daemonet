import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Stack: run a tiny stack machine and report the top of the stack.
 * The stack starts empty and execution starts at index 0 of `program`; every executed op (including `nop`,
 * `jz` and `jmp`) is one step and execution ends after `maxSteps` steps (always 4096).
 * Ops (`n`, `k` are decimal integers):
 * - `push n`: push n reduced to a 32-bit signed integer.
 * - `add`, `sub`, `mul`: pop b (the top), pop a, push a+b, a-b or a*b wrapped to 32-bit signed (`mul` is the
 *   low 32 bits of the product).
 * - `dup`: pop a, push a, a.   `swap`: pop b, pop a, push b, a (exchanging the top two).   `drop`: pop and discard.
 * - `jz k`: pop; if the value is 0 continue at index k, otherwise at the next index (the value is popped either way).
 * - `jmp k`: continue at index k.   `nop`: nothing.
 * Popping an empty stack yields 0 (nothing is removed). Execution also ends when the next index is outside
 * 0..length-1 (past the last op, or a jump target that is negative or too large).
 * Answer: the top of the stack when execution ends (0 when the stack is empty).
 */
export interface StackParams {
  maxSteps: number;
}
export interface StackPayload {
  program: string[];
}
export interface StackAnswer {
  top: number;
}

export const STACK_MAX_STEPS = 4096;

export function runStack(program: readonly string[], maxSteps = STACK_MAX_STEPS): number {
  const st: number[] = [];
  const pop = () => st.pop() ?? 0;
  let pc = 0;
  for (let steps = 0; pc >= 0 && pc < program.length && steps < maxSteps; steps++) {
    const [op, arg] = program[pc]!.split(' ');
    const k = Number(arg);
    pc++;
    switch (op) {
      case 'push':
        st.push(k | 0);
        break;
      case 'add': {
        const b = pop();
        st.push((pop() + b) | 0);
        break;
      }
      case 'sub': {
        const b = pop();
        st.push((pop() - b) | 0);
        break;
      }
      case 'mul': {
        const b = pop();
        st.push(Math.imul(pop(), b));
        break;
      }
      case 'dup': {
        const a = pop();
        st.push(a, a);
        break;
      }
      case 'swap': {
        const b = pop();
        const a = pop();
        st.push(b, a);
        break;
      }
      case 'drop':
        pop();
        break;
      case 'jz':
        if (pop() === 0) pc = k;
        break;
      case 'jmp':
        pc = k;
        break;
      case 'nop':
        break;
    }
  }
  return st[st.length - 1] ?? 0;
}

export const stackFamily: ChallengeFamily<StackParams, StackPayload, StackAnswer> = {
  type: 'stack',
  answerSchema: z.object({ top: z.number().int().min(-2147483648).max(2147483647) }),
  generate(size, noise, rng) {
    const program: string[] = [];
    for (let i = 0; i < size; i++) {
      const r = rng.float();
      if (r < 0.4) program.push(`push ${rng.int(-50, 50)}`);
      else if (r < 0.75) program.push(rng.pick(['add', 'sub', 'mul', 'dup', 'swap', 'drop']));
      else if (r < 0.85) program.push(`jz ${rng.int(i + 1, size)}`); // forward jumps only: always terminates
      else if (r < 0.9) program.push(`jmp ${rng.int(i + 1, size)}`);
      else program.push(`push ${rng.int(1, 9)}`);
    }
    const nops = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < nops; i++) {
      // inserting shifts jump targets, so append nops at the end instead
      program.push('nop');
    }
    return { params: { maxSteps: STACK_MAX_STEPS }, payload: { program }, answer: { top: runStack(program) } };
  },
  check: (e, s) => e.top === s.top,
};
