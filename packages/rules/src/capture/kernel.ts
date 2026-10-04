import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Kernel: round-robin scheduling.
 *
 * Input: `processes` (each `{ pid, arrival, burst }`, pids unique, any array order) and `quantum`.
 * Time starts at 0 and the CPU runs one process at a time.
 * - Processes with `burst` 0 are noise: they never run and never appear in the answer.
 * - The ready queue is FIFO. A process is admitted to the queue once its `arrival` is at or before the
 *   current time; processes that become admissible at the same moment are admitted in ascending
 *   `arrival`, then ascending `pid`.
 * - Take the process at the front of the queue and run it for min(`quantum`, remaining burst) ticks;
 *   the clock advances by that amount.
 * - Admission is checked again at the new time, BEFORE the process just run is handled: every process
 *   with `arrival` <= the new time joins the back of the queue first. Only then does the process just
 *   run either finish (its remaining burst is 0) or go to the back of the queue behind them.
 * - If the queue is empty while processes are still waiting to arrive, the CPU idles and the clock jumps
 *   to the earliest remaining arrival (ties as above).
 * Answer: `{ order }`, the pids in the order they finish.
 */
export interface KernelProcess {
  pid: number;
  arrival: number;
  burst: number;
}
export interface KernelParams {
  quantum: number;
}
export interface KernelPayload {
  processes: KernelProcess[];
}
export interface KernelAnswer {
  order: number[];
}

export function roundRobin(processes: readonly KernelProcess[], quantum: number): number[] {
  const live = processes.filter((p) => p.burst > 0).map((p) => ({ ...p, left: p.burst }));
  const pending = [...live].sort((a, b) => a.arrival - b.arrival || a.pid - b.pid);
  const queue: typeof live = [];
  const order: number[] = [];
  let t = 0;
  const admit = () => {
    while (pending.length && pending[0]!.arrival <= t) queue.push(pending.shift()!);
  };
  while (pending.length || queue.length) {
    admit();
    if (queue.length === 0) {
      t = pending[0]!.arrival;
      continue;
    }
    const p = queue.shift()!;
    const run = Math.min(quantum, p.left);
    t += run;
    p.left -= run;
    admit();
    if (p.left === 0) order.push(p.pid);
    else queue.push(p);
  }
  return order;
}

export const kernelFamily: ChallengeFamily<KernelParams, KernelPayload, KernelAnswer> = {
  type: 'kernel',
  rules: [
    'Kernel: round-robin scheduling.',
    '',
    'Input: `processes` (each `{ pid, arrival, burst }`, pids unique, any array order) and `quantum`.',
    'Time starts at 0 and the CPU runs one process at a time.',
    '- Processes with `burst` 0 are noise: they never run and never appear in the answer.',
    '- The ready queue is FIFO. A process is admitted to the queue once its `arrival` is at or before the',
    '  current time; processes that become admissible at the same moment are admitted in ascending',
    '  `arrival`, then ascending `pid`.',
    '- Take the process at the front of the queue and run it for min(`quantum`, remaining burst) ticks;',
    '  the clock advances by that amount.',
    '- Admission is checked again at the new time, BEFORE the process just run is handled: every process',
    '  with `arrival` <= the new time joins the back of the queue first. Only then does the process just',
    '  run either finish (its remaining burst is 0) or go to the back of the queue behind them.',
    '- If the queue is empty while processes are still waiting to arrive, the CPU idles and the clock jumps',
    '  to the earliest remaining arrival (ties as above).',
    'Answer: `{ order }`, the pids in the order they finish.',
  ].join('\n'),
  answerSchema: z.object({ order: z.array(z.number().int()).max(8192) }),
  generate(size, noise, rng) {
    const processes: KernelProcess[] = [];
    for (let pid = 1; pid <= size; pid++) processes.push({ pid, arrival: rng.int(0, size * 2), burst: rng.int(1, 8) });
    const decoys = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < decoys; i++) processes.push({ pid: size + 1 + i, arrival: rng.int(0, size * 2), burst: 0 });
    rng.shuffle(processes);
    const quantum = rng.int(1, 4);
    return { params: { quantum }, payload: { processes }, answer: { order: roundRobin(processes, quantum) } };
  },
  check: (e, s) => e.order.length === s.order.length && e.order.every((v, i) => v === s.order[i]),
};
