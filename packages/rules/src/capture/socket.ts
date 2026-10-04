import { z } from 'zod';
import { deepFreeze } from '../freeze.js';
import type { ChallengeFamily } from './common.js';

/**
 * Socket: run a (server-side) TCP state machine per connection over a segment trace.
 *   CLOSED --SYN--> SYN_RCVD --ACK|SYNACK--> ESTABLISHED --FIN--> CLOSE_WAIT --FIN--> LAST_ACK --ACK--> CLOSED
 *   RST from any state -> CLOSED. Any other (state, flag) pair is ignored.
 * Every connection starts CLOSED. Answer: `states`, the final state of every id listed in `connections` (CLOSED if
 * no segment names it) plus every `conn` named by a segment, whether or not it is listed in `connections`.
 */
export type SocketState = 'CLOSED' | 'SYN_RCVD' | 'ESTABLISHED' | 'CLOSE_WAIT' | 'LAST_ACK';
export type SocketFlag = 'SYN' | 'SYNACK' | 'ACK' | 'FIN' | 'RST';
export interface Segment {
  conn: string;
  flag: SocketFlag;
}
export interface SocketParams {
  connections: string[];
}
export interface SocketPayload {
  segments: Segment[];
}
export interface SocketAnswer {
  states: Record<string, SocketState>;
}

export const TRANSITIONS: Readonly<Record<SocketState, Readonly<Partial<Record<SocketFlag, SocketState>>>>> = deepFreeze({
  CLOSED: { SYN: 'SYN_RCVD' },
  SYN_RCVD: { ACK: 'ESTABLISHED', SYNACK: 'ESTABLISHED' },
  ESTABLISHED: { FIN: 'CLOSE_WAIT' },
  CLOSE_WAIT: { FIN: 'LAST_ACK' },
  LAST_ACK: { ACK: 'CLOSED' },
});

export function finalStates(connections: readonly string[], segments: readonly Segment[]): Record<string, SocketState> {
  const states: Record<string, SocketState> = Object.fromEntries(connections.map((c) => [c, 'CLOSED' as const]));
  for (const s of segments) {
    const cur = states[s.conn] ?? 'CLOSED';
    states[s.conn] = s.flag === 'RST' ? 'CLOSED' : (TRANSITIONS[cur][s.flag] ?? cur);
  }
  return states;
}

export const FLAGS: readonly SocketFlag[] = deepFreeze(['SYN', 'SYNACK', 'ACK', 'FIN', 'RST']);

/** Most entries a submitted `states` answer may have (a generated challenge has at most 4). */
export const SOCKET_MAX_STATES = 256;

export const socketFamily: ChallengeFamily<SocketParams, SocketPayload, SocketAnswer> = {
  type: 'socket',
  answerSchema: z.object({
    states: z
      .record(z.string().max(256), z.enum(['CLOSED', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT', 'LAST_ACK']))
      .refine((s) => Object.keys(s).length <= SOCKET_MAX_STATES, { message: 'too many entries' }),
  }),
  generate(size, noise, rng) {
    const connections = Array.from({ length: rng.int(2, 4) }, (_, i) => `c${i}`);
    const segments: Segment[] = [];
    for (let i = 0; i < size; i++) segments.push({ conn: rng.pick(connections), flag: rng.chance(0.1) ? 'RST' : rng.pick(FLAGS.slice(0, 4)) });
    const dup = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < dup; i++) segments.splice(rng.int(0, segments.length), 0, { ...rng.pick(segments) });
    return { params: { connections }, payload: { segments }, answer: { states: finalStates(connections, segments) } };
  },
  check: (e, s) => Object.keys(e.states).length === Object.keys(s.states).length && Object.entries(e.states).every(([k, v]) => s.states[k] === v),
};
