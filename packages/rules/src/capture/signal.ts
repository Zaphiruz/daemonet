import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Signal: delivery order with a mask.
 *
 * Input: `signals` (each `{ t, sig }`), `masked` (a list of signal numbers) and `unmaskAt`.
 * 1. Handle the signals in ascending `t`; signals with equal `t` are handled in their array order.
 * 2. Before the mask is lifted, a signal whose number is in `masked` is not delivered: it becomes
 *    pending. Pending signals coalesce: the pending set holds each number at most once, however many
 *    times it arrived. A signal not in `masked` is delivered immediately (appended to the answer), even
 *    if the same number is delivered many times.
 * 3. The mask is lifted exactly once, at time `unmaskAt`: before handling the first signal with
 *    `t` >= `unmaskAt` (so before any signal arriving at `unmaskAt`), all pending signals are delivered
 *    in ascending signal number and the pending set is emptied. If no signal has `t` >= `unmaskAt`, this
 *    happens after the last signal. From then on nothing is masked: every signal is delivered as it is
 *    handled.
 * Answer: `{ order }`, the signal numbers in delivery order.
 */
export interface SignalEvent {
  t: number;
  sig: number;
}
export interface SignalParams {
  masked: number[];
  unmaskAt: number;
}
export interface SignalPayload {
  signals: SignalEvent[];
}
export interface SignalAnswer {
  order: number[];
}

export function deliveryOrder(params: SignalParams, signals: readonly SignalEvent[]): number[] {
  const masked = new Set(params.masked);
  const pending = new Set<number>();
  const order: number[] = [];
  let lifted = false;
  const sorted = signals.map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const flush = () => {
    for (const sig of [...pending].sort((a, b) => a - b)) order.push(sig);
    pending.clear();
    lifted = true;
  };
  for (const s of sorted) {
    if (!lifted && s.t >= params.unmaskAt) flush();
    if (!lifted && masked.has(s.sig)) pending.add(s.sig);
    else order.push(s.sig);
  }
  if (!lifted) flush();
  return order;
}

export const signalFamily: ChallengeFamily<SignalParams, SignalPayload, SignalAnswer> = {
  type: 'signal',
  answerSchema: z.object({ order: z.array(z.number().int()).max(16384) }),
  generate(size, noise, rng) {
    const masked = [...new Set(Array.from({ length: rng.int(2, 6) }, () => rng.int(1, 31)))];
    const signals: SignalEvent[] = [];
    for (let i = 0; i < size; i++) signals.push({ t: rng.int(0, size * 2), sig: rng.chance(0.5) ? rng.pick(masked) : rng.int(1, 31) });
    const dup = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < dup; i++) signals.push({ ...rng.pick(signals) });
    const params = { masked, unmaskAt: rng.int(1, size * 2) };
    return { params, payload: { signals }, answer: { order: deliveryOrder(params, signals) } };
  },
  check: (e, s) => e.order.length === s.order.length && e.order.every((v, i) => v === s.order[i]),
};
