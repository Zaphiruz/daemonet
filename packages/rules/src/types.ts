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

/**
 * Attacker -> the two types it hits for x2. Every type is a strength of exactly two attackers,
 * so no type is left without weaknesses. The SP1 corner (packet/crypto/glitch) is preserved.
 */
export const BEATS: Readonly<Record<TypeId, readonly [TypeId, TypeId]>> = deepFreeze({
  kernel: ['signal', 'thread'],
  packet: ['glitch', 'socket'],
  crypto: ['packet', 'root'],
  cache: ['thread', 'heap'],
  thread: ['socket', 'cloud'],
  signal: ['kernel', 'shell'],
  socket: ['proxy', 'cloud'],
  buffer: ['stack', 'heap'],
  shell: ['root', 'cache'],
  root: ['shell', 'null'],
  null: ['buffer', 'proxy'],
  glitch: ['crypto', 'cache'],
  proxy: ['signal', 'packet'],
  cloud: ['buffer', 'stack'],
  stack: ['null', 'kernel'],
  heap: ['glitch', 'crypto'],
} as const);

/** Attacker -> the two defenders that resist it (x0.5): itself, and the first type that beats it without being one of its own strengths. */
export const RESISTED_BY: Readonly<Record<TypeId, readonly [TypeId, TypeId]>> = deepFreeze({
  kernel: ['kernel', 'stack'],
  packet: ['packet', 'crypto'],
  crypto: ['crypto', 'glitch'],
  cache: ['cache', 'shell'],
  thread: ['thread', 'kernel'],
  signal: ['signal', 'proxy'],
  socket: ['socket', 'packet'],
  buffer: ['buffer', 'null'],
  shell: ['shell', 'signal'],
  root: ['root', 'crypto'],
  null: ['null', 'root'],
  glitch: ['glitch', 'packet'],
  proxy: ['proxy', 'socket'],
  cloud: ['cloud', 'thread'],
  stack: ['stack', 'buffer'],
  heap: ['heap', 'cache'],
} as const);

/** Attacker -> defender it cannot damage at all. */
export const IMMUNE: Readonly<Partial<Record<TypeId, TypeId>>> = deepFreeze({
  glitch: 'null',
} as const);

export function isTypeId(value: string): value is TypeId {
  return (TYPES as readonly string[]).includes(value);
}

export function singleMultiplier(attack: TypeId, defender: TypeId): number {
  if (IMMUNE[attack] === defender) return 0;
  if (BEATS[attack].includes(defender)) return 2;
  if (RESISTED_BY[attack].includes(defender)) return 0.5;
  return 1;
}

/** Multipliers stack across a dual-typed defender. */
export function typeMultiplier(attack: TypeId, defender: readonly TypeId[]): number {
  return defender.reduce((m, d) => m * singleMultiplier(attack, d), 1);
}
