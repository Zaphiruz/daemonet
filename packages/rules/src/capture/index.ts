import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { toHex, utf8, xorRepeating, type ChallengeFamily } from './common.js';
import { cryptoFamily } from './crypto.js';
import { glitchFamily } from './glitch.js';
import { nullFamily } from './null.js';
import { packetFamily } from './packet.js';

const FAMILIES: Partial<Record<TypeId, ChallengeFamily>> = {
  packet: packetFamily as ChallengeFamily,
  crypto: cryptoFamily as ChallengeFamily,
  glitch: glitchFamily as ChallengeFamily,
  null: nullFamily as ChallengeFamily,
};

export function getFamily(type: TypeId): ChallengeFamily {
  const family = FAMILIES[type];
  if (!family) throw new RangeError(`no capture challenge family for type ${type}`);
  return family;
}

export function hasFamily(type: TypeId): boolean {
  return FAMILIES[type] !== undefined;
}

/**
 * Wire shape of a challenge (what the operator receives).
 * single: `params`/`payload` belong to families[0].
 * chain:  payload = { first: { params, payload }, sealed } where `sealed` is hex of
 *         UTF-8(JSON.stringify({ params, payload })) of the second stage, XORed with the repeating key
 *         UTF-8(JSON.stringify(firstStageAnswer)). The submitted answer is the second stage's answer.
 */
export interface PublicChallenge {
  kind: 'single' | 'chain';
  families: TypeId[];
  params: unknown;
  payload: unknown;
}

export interface Challenge extends PublicChallenge {
  /** Expected final answer. Server-side only. */
  answer: unknown;
}

export interface ChainPayload {
  first: { params: unknown; payload: unknown };
  sealed: string;
}

/** Types are the target daemon's types (1 or 2). Both stages of a chain use the same size and noise. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length === 1) {
    const stage = getFamily(types[0]!).generate(size, noise, rng);
    return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
  }
  if (types.length !== 2) throw new RangeError('a daemon has 1 or 2 types');
  const [a, b] = types as readonly [TypeId, TypeId];
  const first = getFamily(a).generate(size, noise, rng);
  const second = getFamily(b).generate(size, noise, rng);
  const key = utf8(JSON.stringify(first.answer));
  const sealed = toHex(xorRepeating(utf8(JSON.stringify({ params: second.params, payload: second.payload })), key));
  const payload: ChainPayload = { first: { params: first.params, payload: first.payload }, sealed };
  return { kind: 'chain', families: [a, b], params: {}, payload, answer: second.answer };
}

export function publicChallenge(challenge: Challenge): PublicChallenge {
  const { kind, families, params, payload } = challenge;
  return { kind, families, params, payload };
}

export type CheckResult = 'correct' | 'wrong' | 'invalid';

export function checkAnswer(challenge: Challenge, submitted: unknown): CheckResult {
  const family = getFamily(challenge.families[challenge.families.length - 1]!);
  const parsed = family.answerSchema.safeParse(submitted);
  if (!parsed.success) return 'invalid';
  return family.check(challenge.answer, parsed.data) ? 'correct' : 'wrong';
}
