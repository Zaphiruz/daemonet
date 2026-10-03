import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toHex, utf8 } from '../src/capture/common.js';
import { canonicalAnswer, sealStage, sha256, unsealStage } from '../src/capture/index.js';

describe('sha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('hashes %j to the standard vector', (input, expected) => {
    expect(toHex(sha256(utf8(input)))).toBe(expected);
  });

  it('hashes one million "a" to the standard vector', () => {
    expect(toHex(sha256(utf8('a'.repeat(1_000_000))))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('returns 32 bytes', () => {
    expect(sha256(new Uint8Array(100))).toHaveLength(32);
  });
});

describe('sealStage / unsealStage', () => {
  it('canonicalAnswer is compact JSON in the answer object key order', () => {
    expect(canonicalAnswer({ checksum: '0a1b2c3d' })).toBe('{"checksum":"0a1b2c3d"}');
  });

  it('round-trips arbitrary strings and answers', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), fc.jsonValue(), (plaintext, answer) => {
        const sealed = sealStage(plaintext, answer);
        expect(sealed).toMatch(/^(?:[0-9a-f]{2})*$/);
        expect(unsealStage(sealed, answer)).toBe(plaintext);
      }),
      { numRuns: 128 },
    );
  });

  it('round-trips non-ASCII text longer than one keystream block', () => {
    const plaintext = 'daemonet ✓ — ünïcödé 🐛 '.repeat(8);
    expect(unsealStage(sealStage(plaintext, { plaintext: 'k' }), { plaintext: 'k' })).toBe(plaintext);
  });

  it('a different first answer does not unseal', () => {
    const plaintext = '{"params":{},"payload":{}}';
    expect(unsealStage(sealStage(plaintext, { sum: 1 }), { sum: 2 })).not.toBe(plaintext);
  });
});
