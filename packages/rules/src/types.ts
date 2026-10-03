import { deepFreeze } from './freeze.js';

export const TYPES = deepFreeze([
  'kernel',
  'packet',
  'crypto',
  'cache',
  'thread',
  'signal',
  'socket',
  'buffer',
  'shell',
  'root',
  'null',
  'glitch',
  'proxy',
  'cloud',
  'stack',
  'heap',
] as const);
export type TypeId = (typeof TYPES)[number];

/** Attacker -> defender multipliers. Unlisted pairs are x1 (SP3 fills the full chart). */
const CHART: Partial<Record<TypeId, Partial<Record<TypeId, number>>>> = deepFreeze({
  packet: { packet: 0.5, crypto: 0.5, glitch: 2 },
  crypto: { packet: 2, crypto: 0.5, glitch: 0.5 },
  glitch: { packet: 0.5, crypto: 2, glitch: 0.5, null: 0 },
});

export function isTypeId(value: string): value is TypeId {
  return (TYPES as readonly string[]).includes(value);
}

export function typeMultiplier(attack: TypeId, defender: readonly TypeId[]): number {
  return defender.reduce((m, d) => m * (CHART[attack]?.[d] ?? 1), 1);
}
