/**
 * Reference solvers — TEST ONLY. Never import these from src/ (they must not ship in any package).
 * Each takes the public (params, payload) and returns the answer object.
 */
import { fnv1a32Hex, fromHex, fromUtf8, utf8, xorRepeating } from '../src/capture/common.js';
import type { CryptoParams, CryptoPayload } from '../src/capture/crypto.js';
import type { GlitchPayload } from '../src/capture/glitch.js';
import type { NullParams, NullPayload } from '../src/capture/null.js';
import { packetCrc, type PacketParams, type PacketPayload } from '../src/capture/packet.js';
import type { PublicChallenge } from '../src/capture/index.js';
import type { TypeId } from '../src/types.js';

export function solvePacket(params: PacketParams, payload: PacketPayload): { checksum: string } {
  const chunks = new Map<number, Uint8Array>();
  for (const f of payload.fragments) {
    const data = fromHex(f.data);
    if (packetCrc(f.seq, data) === f.crc) chunks.set(f.seq, data);
  }
  const message = new Uint8Array(params.count * 4);
  for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq)!, seq * 4);
  return { checksum: fnv1a32Hex(message) };
}

export function solveCrypto(params: CryptoParams, payload: CryptoPayload): { plaintext: string } {
  const cipher = fromHex(payload.ciphertext);
  const k = params.keyLength;
  const key = new Uint8Array(k);
  const known = utf8(params.known.text);
  for (let j = 0; j < k; j++) {
    const i = params.known.offset + j;
    key[i % k] = cipher[i]! ^ known[j]!;
  }
  return { plaintext: fromUtf8(xorRepeating(cipher, key)) };
}

export function solveGlitch(_params: unknown, payload: GlitchPayload): { hex: string } {
  const nibbles = payload.blocks.map((block) => {
    const b = (pos: number) => (block >> (pos - 1)) & 1;
    const syndrome = (b(1) ^ b(3) ^ b(5) ^ b(7)) | ((b(2) ^ b(3) ^ b(6) ^ b(7)) << 1) | ((b(4) ^ b(5) ^ b(6) ^ b(7)) << 2);
    const fixed = syndrome ? block ^ (1 << (syndrome - 1)) : block;
    const f = (pos: number) => (fixed >> (pos - 1)) & 1;
    return (f(3) << 3) | (f(5) << 2) | (f(6) << 1) | f(7);
  });
  let hex = '';
  for (let i = 0; i < nibbles.length; i += 2) hex += ((nibbles[i]! << 4) | nibbles[i + 1]!).toString(16).padStart(2, '0');
  return { hex };
}

export function solveNull(params: NullParams, payload: NullPayload): { sum: number } {
  let sum = 0;
  for (let addr = params.head; addr !== 0; addr = payload.memory[addr + 1]!) sum += payload.memory[addr]!;
  return { sum };
}

const SOLVERS: Partial<Record<TypeId, (params: never, payload: never) => unknown>> = {
  packet: solvePacket,
  crypto: solveCrypto,
  glitch: solveGlitch,
  null: solveNull,
};

export function solve(challenge: PublicChallenge): unknown {
  const solveStage = (type: TypeId, params: unknown, payload: unknown) =>
    (SOLVERS[type] as (p: unknown, y: unknown) => unknown)(params, payload);
  return solveStage(challenge.families[0]!, challenge.params, challenge.payload);
}
