import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { fromHex, fromUtf8, toHex, utf8, type ChallengeFamily } from './common.js';
import { bufferFamily } from './buffer.js';
import { cacheFamily } from './cache.js';
import { cloudFamily } from './cloud.js';
import { cryptoFamily } from './crypto.js';
import { glitchFamily } from './glitch.js';
import { heapFamily } from './heap.js';
import { kernelFamily } from './kernel.js';
import { nullFamily } from './null.js';
import { packetFamily } from './packet.js';
import { proxyFamily } from './proxy.js';
import { sha256 } from './sha256.js';
import { rootFamily } from './root.js';
import { shellFamily } from './shell.js';
import { signalFamily } from './signal.js';
import { socketFamily } from './socket.js';
import { stackFamily } from './stack.js';
import { threadFamily } from './thread.js';

export { sha256 };

const FAMILIES: Record<TypeId, ChallengeFamily> = {
  packet: packetFamily as ChallengeFamily,
  crypto: cryptoFamily as ChallengeFamily,
  glitch: glitchFamily as ChallengeFamily,
  null: nullFamily as ChallengeFamily,
  kernel: kernelFamily as ChallengeFamily,
  cache: cacheFamily as ChallengeFamily,
  thread: threadFamily as ChallengeFamily,
  signal: signalFamily as ChallengeFamily,
  socket: socketFamily as ChallengeFamily,
  buffer: bufferFamily as ChallengeFamily,
  shell: shellFamily as ChallengeFamily,
  root: rootFamily as ChallengeFamily,
  proxy: proxyFamily as ChallengeFamily,
  cloud: cloudFamily as ChallengeFamily,
  stack: stackFamily as ChallengeFamily,
  heap: heapFamily as ChallengeFamily,
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
 * chain:  payload is a {@link ChainPayload}. The submitted answer is the second stage's answer.
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

/**
 * Payload of a chained (dual-type) challenge.
 *
 * `first` is stage one in the clear. `sealed` is stage two, `{ params, payload }`, sealed with a key derived from the
 * answer to stage one (see {@link sealStage}):
 *
 * - canonical answer: `JSON.stringify(firstAnswer)` — compact JSON (no whitespace) with the family's own key order,
 *   e.g. `{"checksum":"0a1b2c3d"}`. Players must reproduce it byte for byte.
 * - `key = SHA-256(UTF-8(canonicalAnswer))`.
 * - keystream block i (i = 0, 1, 2, ...) = `SHA-256(key ‖ u32be(i))`; the keystream is the blocks concatenated and cut
 *   to the plaintext length.
 * - `sealed = lowercase hex(UTF-8(JSON.stringify({ params, payload })) XOR keystream)`.
 */
export interface ChainPayload {
  first: { params: unknown; payload: unknown };
  sealed: string;
}

/** The canonical form of a stage answer used to derive the chain key: compact JSON in the family's key order. */
export function canonicalAnswer(answer: unknown): string {
  return JSON.stringify(answer);
}

function keystream(firstAnswer: unknown, length: number): Uint8Array {
  const key = sha256(utf8(canonicalAnswer(firstAnswer)));
  const out = new Uint8Array(length);
  const input = new Uint8Array(key.length + 4);
  input.set(key);
  const counter = new DataView(input.buffer, key.length, 4);
  for (let i = 0; i * 32 < length; i++) {
    counter.setUint32(0, i);
    const block = sha256(input);
    out.set(block.subarray(0, Math.min(32, length - i * 32)), i * 32);
  }
  return out;
}

function xorKeystream(data: Uint8Array, firstAnswer: unknown): Uint8Array {
  const ks = keystream(firstAnswer, data.length);
  return data.map((b, i) => b ^ ks[i]!);
}

/** Seal a stage-two plaintext with the SHA-256 keystream derived from the stage-one answer; returns lowercase hex. */
export function sealStage(plaintext: string, firstAnswer: unknown): string {
  return toHex(xorKeystream(utf8(plaintext), firstAnswer));
}

/** Inverse of {@link sealStage}. */
export function unsealStage(sealed: string, firstAnswer: unknown): string {
  return fromUtf8(xorKeystream(fromHex(sealed), firstAnswer));
}

/** Types are the target daemon's types (1 or 2). A chain splits the size budget: each stage is generated at
 * `max(8, round(size / 4))` with the same noise. Stage two is hex-sealed (doubling it), so a chain costs about
 * three stages of that size; at the maximum size 1024 the worst measured chain stays well under 64 KiB. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length === 1) {
    const stage = getFamily(types[0]!).generate(size, noise, rng);
    return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
  }
  if (types.length !== 2) throw new RangeError('a daemon has 1 or 2 types');
  const [a, b] = types as readonly [TypeId, TypeId];
  const half = Math.max(8, Math.round(size / 4));
  const first = getFamily(a).generate(half, noise, rng);
  const second = getFamily(b).generate(half, noise, rng);
  const sealed = sealStage(JSON.stringify({ params: second.params, payload: second.payload }), first.answer);
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
