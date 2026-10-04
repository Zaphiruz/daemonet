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
 * A generated challenge has 1 to 6 layers, at most 3 of them `hex`/`xor` (which double the length), so the payload
 * stays under about 20x the inner text. The inner text is UTF-8 and may be empty. Answer: the inner text, exactly (no trimming).
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

const MAX_DOUBLING_LAYERS = 3;

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
  rules: [
    'Proxy: unwrap nested encapsulation.',
    '`layers[0]` was applied to the inner text first and the last layer was applied last, so `payload` is the',
    'output of the LAST layer: unwrap from the last layer back to the first. Each layer maps text to text:',
    '- `hex`: lowercase hex of the text\'s UTF-8 bytes.',
    '- `base64`: standard base64 (RFC 4648 alphabet, `=` padding) of the text\'s UTF-8 bytes.',
    '- `xor:<n>` (n in 1..255): every UTF-8 byte XOR n, then lowercase hex (so the result is always printable).',
    '- `lenprefix`: `<L>:` followed by the text, where L is the text\'s length in UTF-8 BYTES written in decimal',
    '  (so the first \':\' always ends the prefix, even when the text itself contains \':\').',
    'A generated challenge has 1 to 6 layers, at most 3 of them `hex`/`xor` (which double the length), so the payload',
    'stays under about 20x the inner text. The inner text is UTF-8 and may be empty. Answer: the inner text, exactly (no trimming).',
  ].join('\n'),
  answerSchema: z.object({ inner: z.string().max(65536) }),
  generate(size, _noise, rng) {
    let inner = '';
    while (inner.length < size) inner += (inner ? ' ' : '') + rng.pick(WORDS);
    inner = fromUtf8(utf8(inner.slice(0, size)));
    const count = Math.max(1, Math.min(6, Math.floor(size / 16)));
    const layers: string[] = [];
    let doublings = 0; // hex and xor double the length; at most MAX_DOUBLING_LAYERS per challenge bounds the payload size
    for (let i = 0; i < count; i++) {
      const layer = rng.pick(['hex', 'base64', 'lenprefix', `xor:${rng.int(1, 255)}`]);
      const doubles = layer === 'hex' || layer.startsWith('xor:');
      if (doubles && doublings >= MAX_DOUBLING_LAYERS) layers.push(rng.pick(['base64', 'lenprefix']));
      else {
        if (doubles) doublings++;
        layers.push(layer);
      }
    }
    let payload = inner;
    for (const layer of layers) payload = wrap(layer, payload);
    return { params: { layers }, payload: { payload }, answer: { inner } };
  },
  check: (e, s) => e.inner === s.inner,
};
