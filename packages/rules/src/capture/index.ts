import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import type { ChallengeFamily } from './common.js';
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

/** Wire shape of a challenge (what the operator receives). */
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

/** Types are the target daemon's types. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length !== 1) throw new RangeError('a daemon has 1 or 2 types');
  const stage = getFamily(types[0]!).generate(size, noise, rng);
  return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
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
