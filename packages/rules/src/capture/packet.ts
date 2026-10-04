import { z } from 'zod';
import { fnv1a32Hex, randomBytes, toHex, type ChallengeFamily } from './common.js';

/**
 * Packet: reassemble fragments.
 * The message is `count` chunks of 4 bytes, chunk `seq` = bytes [4*seq, 4*seq+4).
 * Each fragment has crc = (seq + sum of its 4 data bytes) mod 256.
 * The payload also holds exact duplicates (floor(count/4)) and, with noise, decoys that reuse a real seq
 * but carry different data and a wrong crc (noise 1: floor(count/8), noise 2: floor(count/4)).
 * Answer: 32-bit FNV-1a of the reassembled message, 8 lowercase hex chars.
 */
export interface PacketParams {
  count: number;
}
export interface PacketFragment {
  seq: number;
  data: string;
  crc: number;
}
export interface PacketPayload {
  fragments: PacketFragment[];
}
export interface PacketAnswer {
  checksum: string;
}

export function packetCrc(seq: number, data: Uint8Array): number {
  let sum = seq;
  for (const b of data) sum += b;
  return sum & 0xff;
}

export const packetFamily: ChallengeFamily<PacketParams, PacketPayload, PacketAnswer> = {
  type: 'packet',
  rules: [
    'Packet: reassemble fragments.',
    'The message is `count` chunks of 4 bytes, chunk `seq` = bytes [4*seq, 4*seq+4).',
    'Each fragment has crc = (seq + sum of its 4 data bytes) mod 256.',
    'The payload also holds exact duplicates (floor(count/4)) and, with noise, decoys that reuse a real seq',
    'but carry different data and a wrong crc (noise 1: floor(count/8), noise 2: floor(count/4)).',
    'Answer: 32-bit FNV-1a of the reassembled message, 8 lowercase hex chars.',
  ].join('\n'),
  answerSchema: z.object({ checksum: z.string().regex(/^[0-9a-f]{8}$/) }),
  generate(size, noise, rng) {
    const count = size;
    const message = randomBytes(rng, count * 4);
    const real: PacketFragment[] = [];
    for (let seq = 0; seq < count; seq++) {
      const data = message.subarray(seq * 4, seq * 4 + 4);
      real.push({ seq, data: toHex(data), crc: packetCrc(seq, data) });
    }
    const fragments = [...real];
    for (let i = 0; i < Math.floor(count / 4); i++) fragments.push({ ...rng.pick(real) });
    const decoys = [0, Math.floor(count / 8), Math.floor(count / 4)][noise]!;
    for (let i = 0; i < decoys; i++) {
      const seq = rng.int(0, count - 1);
      const data = randomBytes(rng, 4);
      const wrongCrc = (packetCrc(seq, data) + rng.int(1, 255)) & 0xff;
      fragments.push({ seq, data: toHex(data), crc: wrongCrc });
    }
    rng.shuffle(fragments);
    return { params: { count }, payload: { fragments }, answer: { checksum: fnv1a32Hex(message) } };
  },
  check: (expected, submitted) => expected.checksum === submitted.checksum,
};
