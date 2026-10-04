import { z } from 'zod';
import { fnv1a32Hex, utf8, type ChallengeFamily } from './common.js';

/**
 * Cloud: consistent hashing with virtual nodes (`nodes` >= 1, `vnodes` >= 1).
 * Ring points: for each node and each i in [0, vnodes): position = FNV-1a-32 (as an unsigned integer) of the
 * UTF-8 string "<node>#<i>". The ring is sorted by position ascending; points with equal positions are ordered
 * by node name ascending (code-unit order), whatever the order of `nodes`.
 * A key maps to the node of the first ring point (in that order) whose position is >= FNV-1a-32(UTF-8 key)
 * (equal counts), and when the key's hash is above every point it wraps to the first point of the ring.
 * Keys starting with '#' are comments to ignore (noise). A key listed twice is one entry.
 * A generated challenge has at most {@link CLOUD_MAX_KEYS} real keys (so the answer stays small enough to submit);
 * larger sizes add nodes to the ring instead (3-8 nodes, plus one per 128 of size).
 * Answer: key -> node for every real key.
 */
export interface CloudParams {
  nodes: string[];
  vnodes: number;
}
export interface CloudPayload {
  keys: string[];
}
export interface CloudAnswer {
  placement: Record<string, string>;
}

const h = (s: string) => parseInt(fnv1a32Hex(utf8(s)), 16);

export function placeKeys(params: CloudParams, keys: readonly string[]): Record<string, string> {
  const ring: Array<{ pos: number; node: string }> = [];
  for (const node of params.nodes) for (let i = 0; i < params.vnodes; i++) ring.push({ pos: h(`${node}#${i}`), node });
  ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key.startsWith('#')) continue;
    const pos = h(key);
    const hit = ring.find((r) => r.pos >= pos) ?? ring[0]!;
    out[key] = hit.node;
  }
  return out;
}

/** Most real keys (and so answer entries) a generated cloud challenge has. */
export const CLOUD_MAX_KEYS = 256;

export const cloudFamily: ChallengeFamily<CloudParams, CloudPayload, CloudAnswer> = {
  type: 'cloud',
  answerSchema: z.object({
    placement: z
      .record(z.string().max(256), z.string().max(256))
      .refine((p) => Object.keys(p).length <= CLOUD_MAX_KEYS, { message: 'too many entries' }),
  }),
  generate(size, noise, rng) {
    const nodes = Array.from({ length: rng.int(3, 8) + Math.floor(size / 128) }, (_, i) => `node-${i}`);
    const vnodes = 2 ** rng.int(3, 6);
    const count = Math.min(size, CLOUD_MAX_KEYS);
    const keys: string[] = [];
    for (let i = 0; i < count; i++) keys.push(`key-${rng.int(0, 1_000_000)}`);
    const decoys = [0, Math.floor(count / 8), Math.floor(count / 4)][noise]!;
    for (let i = 0; i < decoys; i++) keys.splice(rng.int(0, keys.length), 0, `#key-${rng.int(0, 1_000_000)}`);
    const params = { nodes, vnodes };
    return { params, payload: { keys }, answer: { placement: placeKeys(params, keys) } };
  },
  check: (e, s) =>
    Object.keys(e.placement).length === Object.keys(s.placement).length && Object.entries(e.placement).every(([k, v]) => s.placement[k] === v),
};
