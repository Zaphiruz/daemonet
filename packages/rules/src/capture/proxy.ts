import { z } from 'zod';
import { fromUtf8, toHex, utf8, type ChallengeFamily } from './common.js';
import { WORDS } from './crypto.js';

/**
 * Proxy: unwrap nested encapsulation.
 * `layers[0]` was applied to the inner text first and the last layer was applied last, so `payload` is the
 * output of the LAST layer: unwrap from the last layer back to the first. Each layer maps text to text:
 * - `hex`: lowercase hex of the text's UTF-8 bytes.
 * - `base64`: standard base64 (RFC 4648 alphabet, `=` padding) of the text's UTF-8 bytes.
 * - `xor:<n>` (n in 1..255): every UTF-8 byte XOR n, then lowercase hex (so the result is always printable).
 * - `lenprefix`: `<L>:` followed by the text, where L is the text's length in UTF-8 BYTES written in decimal
 *   (so the first ':' always ends the prefix, even when the text itself contains ':').
 * The inner text is UTF-8 and may be empty. Answer: the inner text, exactly (no trimming).
 */
export interface ProxyParams {
  layers: string[];
}
export interface ProxyPayload {
  payload: string;
}
export interface ProxyAnswer {
  inner: string;
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export function wrap(layer: string, text: string): string {
  const bytes = utf8(text);
  if (layer === 'hex') return toHex(bytes);
  if (layer === 'base64') return b64(bytes);
  if (layer === 'lenprefix') return `${bytes.length}:${text}`;
  if (layer.startsWith('xor:')) return toHex(bytes.map((b) => b ^ Number(layer.slice(4))));
  throw new RangeError(`unknown layer ${layer}`);
}

export const proxyFamily: ChallengeFamily<ProxyParams, ProxyPayload, ProxyAnswer> = {
  type: 'proxy',
  answerSchema: z.object({ inner: z.string().max(65536) }),
  generate(size, _noise, rng) {
    let inner = '';
    while (inner.length < size) inner += (inner ? ' ' : '') + rng.pick(WORDS);
    inner = fromUtf8(utf8(inner.slice(0, size)));
    const count = Math.max(1, Math.min(6, Math.floor(size / 16)));
    const layers: string[] = [];
    for (let i = 0; i < count; i++) layers.push(rng.pick(['hex', 'base64', 'lenprefix', `xor:${rng.int(1, 255)}`]));
    let payload = inner;
    for (const layer of layers) payload = wrap(layer, payload);
    return { params: { layers }, payload: { payload }, answer: { inner } };
  },
  check: (e, s) => e.inner === s.inner,
};
