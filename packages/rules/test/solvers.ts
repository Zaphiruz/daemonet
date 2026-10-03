/**
 * Reference solvers — TEST ONLY. Never import these from src/ (they must not ship in any package).
 * Each takes the public (params, payload) and returns the answer object.
 */
import { fnv1a32Hex, fromHex } from '../src/capture/common.js';
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

const SOLVERS: Partial<Record<TypeId, (params: never, payload: never) => unknown>> = {
  packet: solvePacket,
};

export function solve(challenge: PublicChallenge): unknown {
  const solveStage = (type: TypeId, params: unknown, payload: unknown) =>
    (SOLVERS[type] as (p: unknown, y: unknown) => unknown)(params, payload);
  return solveStage(challenge.families[0]!, challenge.params, challenge.payload);
}
