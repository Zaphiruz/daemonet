import type { PacketAnswer, PacketParams, PacketPayload } from '@daemonet/sdk';

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fnv1a32Hex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Packet family: keep fragments whose crc = (seq + sum of data bytes) mod 256, drop duplicates and decoys,
 * reassemble by seq, and return the FNV-1a checksum of the message.
 */
export function solvePacket(params: PacketParams, payload: PacketPayload): PacketAnswer {
  const chunks = new Map<number, Uint8Array>();
  for (const f of payload.fragments) {
    const data = fromHex(f.data);
    const crc = (f.seq + data.reduce((s, b) => s + b, 0)) & 0xff;
    if (crc === f.crc) chunks.set(f.seq, data);
  }
  const message = new Uint8Array(params.count * 4);
  for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq)!, seq * 4);
  return { checksum: fnv1a32Hex(message) };
}
