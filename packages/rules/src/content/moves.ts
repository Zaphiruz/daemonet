import { deepFreeze } from '../freeze.js';
import type { TypeId } from '../types.js';

export type Shape =
  | { kind: 'single' }
  | { kind: 'cone'; length: number; angleDeg: number }
  | { kind: 'circle'; radius: number };

export type StatusId = 'throttled' | 'stalled';

export interface MoveDef {
  id: string;
  name: string;
  type: TypeId;
  category: 'physical' | 'special';
  power: number;
  energyCost: number;
  cooldownMs: number;
  /** single: max distance to target; cone: cone length from self; circle: max distance to the circle's centre. */
  range: number;
  shape: Shape;
  status?: { id: StatusId; chance: number; durationMs: number };
}

const single = { kind: 'single' } as const;

export const MOVES: readonly MoveDef[] = deepFreeze([
  // Packet
  { id: 'ping', name: 'Ping', type: 'packet', category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'traceroute', name: 'Traceroute', type: 'packet', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'broadcast', name: 'Broadcast', type: 'packet', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 } },
  { id: 'synflood', name: 'SYN Flood', type: 'packet', category: 'physical', power: 90, energyCost: 48, cooldownMs: 4096, range: 2, shape: single },
  // Crypto
  { id: 'hash', name: 'Hash', type: 'crypto', category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'encrypt', name: 'Encrypt', type: 'crypto', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single, status: { id: 'throttled', chance: 0.5, durationMs: 4096 } },
  { id: 'keyspray', name: 'Key Spray', type: 'crypto', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 4, shape: { kind: 'cone', length: 4, angleDeg: 60 } },
  { id: 'bruteforce', name: 'Brute Force', type: 'crypto', category: 'special', power: 100, energyCost: 56, cooldownMs: 8192, range: 6, shape: single },
  // Glitch
  { id: 'bitflip', name: 'Bit Flip', type: 'glitch', category: 'physical', power: 22, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  { id: 'corrupt', name: 'Corrupt', type: 'glitch', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'static', name: 'Static', type: 'glitch', category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 }, status: { id: 'stalled', chance: 0.5, durationMs: 2048 } },
  { id: 'cosmicray', name: 'Cosmic Ray', type: 'glitch', category: 'physical', power: 95, energyCost: 48, cooldownMs: 4096, range: 3, shape: single },
  // Null
  { id: 'nullref', name: 'Null Ref', type: 'null', category: 'physical', power: 20, energyCost: 4, cooldownMs: 512, range: 2, shape: single },
  { id: 'voidbolt', name: 'Void Bolt', type: 'null', category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  { id: 'blackhole', name: 'Black Hole', type: 'null', category: 'special', power: 35, energyCost: 24, cooldownMs: 2048, range: 6, shape: { kind: 'circle', radius: 2 } },
  { id: 'dereference', name: 'Dereference', type: 'null', category: 'physical', power: 100, energyCost: 56, cooldownMs: 8192, range: 2, shape: single },
]);

const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function getMove(id: string): MoveDef {
  const m = BY_ID.get(id);
  if (!m) throw new RangeError(`unknown move ${id}`);
  return m;
}
