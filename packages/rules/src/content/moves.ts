import { deepFreeze } from '../freeze.js';
import { TYPES, type TypeId } from '../types.js';

export type Shape =
  | { kind: 'single' }
  | { kind: 'cone'; length: number; angleDeg: number }
  | { kind: 'circle'; radius: number };

/** throttled: +50% own cooldowns · stalled: cannot move · leaking: -2 energy/s · exposed: +25% damage taken */
export const STATUS_IDS = deepFreeze(['throttled', 'stalled', 'leaking', 'exposed'] as const);
export type StatusId = (typeof STATUS_IDS)[number];

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

export type MoveSlot = 'filler' | 'ranged' | 'area' | 'heavy';

const single = { kind: 'single' } as const;
const circle = { kind: 'circle', radius: 2 } as const;
const cone = { kind: 'cone', length: 4, angleDeg: 60 } as const;

/** Which status each type's area move inflicts (game design SP3a §3.3); crypto is the exception: its status sits on the ranged `encrypt` (SP1). */
export const TYPE_STATUS: Record<TypeId, StatusId> = deepFreeze({
  crypto: 'throttled', cache: 'throttled', proxy: 'throttled', cloud: 'throttled',
  glitch: 'stalled', thread: 'stalled', buffer: 'stalled', null: 'stalled',
  heap: 'leaking', packet: 'leaking', socket: 'leaking', stack: 'leaking',
  kernel: 'exposed', signal: 'exposed', shell: 'exposed', root: 'exposed',
});

/** Four move ids per type in slot order filler / ranged / area / heavy. */
export const TYPE_MOVES: Record<TypeId, readonly [string, string, string, string]> = deepFreeze({
  kernel: ['syscall', 'interrupt', 'panic', 'kexec'],
  packet: ['ping', 'traceroute', 'broadcast', 'synflood'],
  crypto: ['hash', 'encrypt', 'keyspray', 'bruteforce'],
  cache: ['hit', 'prefetch', 'flush', 'thrash'],
  thread: ['spin', 'fork', 'deadlock', 'join'],
  signal: ['kill', 'sighup', 'sigstop', 'sigkill'],
  socket: ['bind', 'connect', 'listen', 'handshake'],
  buffer: ['fill', 'overflow', 'wrap', 'smash'],
  shell: ['pipe', 'grep', 'glob', 'exec'],
  root: ['chmod', 'sudo', 'chown', 'rootkit'],
  null: ['nullref', 'voidbolt', 'blackhole', 'dereference'],
  glitch: ['bitflip', 'corrupt', 'static', 'cosmicray'],
  proxy: ['relay', 'tunnel', 'mask', 'onion'],
  cloud: ['burst', 'scale', 'storm', 'failover'],
  stack: ['push', 'pop', 'unwind', 'recurse'],
  heap: ['alloc', 'free', 'leak', 'compact'],
});

const NAMES: Record<string, string> = {
  syscall: 'Syscall', interrupt: 'Interrupt', panic: 'Kernel Panic', kexec: 'Kexec',
  ping: 'Ping', traceroute: 'Traceroute', broadcast: 'Broadcast', synflood: 'SYN Flood',
  hash: 'Hash', encrypt: 'Encrypt', keyspray: 'Key Spray', bruteforce: 'Brute Force',
  hit: 'Cache Hit', prefetch: 'Prefetch', flush: 'Flush', thrash: 'Thrash',
  spin: 'Spin', fork: 'Fork', deadlock: 'Deadlock', join: 'Join',
  kill: 'Kill', sighup: 'SIGHUP', sigstop: 'SIGSTOP', sigkill: 'SIGKILL',
  bind: 'Bind', connect: 'Connect', listen: 'Listen', handshake: 'Handshake',
  fill: 'Fill', overflow: 'Overflow', wrap: 'Wrap', smash: 'Stack Smash',
  pipe: 'Pipe', grep: 'Grep', glob: 'Glob', exec: 'Exec',
  chmod: 'Chmod', sudo: 'Sudo', chown: 'Chown', rootkit: 'Rootkit',
  nullref: 'Null Ref', voidbolt: 'Void Bolt', blackhole: 'Black Hole', dereference: 'Dereference',
  bitflip: 'Bit Flip', corrupt: 'Corrupt', static: 'Static', cosmicray: 'Cosmic Ray',
  relay: 'Relay', tunnel: 'Tunnel', mask: 'Mask', onion: 'Onion Route',
  burst: 'Burst', scale: 'Autoscale', storm: 'Storm', failover: 'Failover',
  push: 'Push', pop: 'Pop', unwind: 'Unwind', recurse: 'Recurse',
  alloc: 'Alloc', free: 'Free', leak: 'Leak', compact: 'Compact',
};

/** SP1's hand-tuned numbers stay as they were; other types follow the same four-slot pattern. */
const SLOT_DEFAULTS: Record<MoveSlot, Omit<MoveDef, 'id' | 'name' | 'type'>> = {
  filler: { category: 'physical', power: 20, energyCost: 4, cooldownMs: 256, range: 2, shape: single },
  ranged: { category: 'special', power: 40, energyCost: 12, cooldownMs: 1024, range: 8, shape: single },
  area: { category: 'special', power: 35, energyCost: 20, cooldownMs: 2048, range: 6, shape: circle },
  heavy: { category: 'physical', power: 90, energyCost: 48, cooldownMs: 4096, range: 2, shape: single },
};
const SP1_TUNING: Record<string, Partial<MoveDef>> = {
  keyspray: { range: 4, shape: cone },
  bruteforce: { category: 'special', power: 100, energyCost: 56, cooldownMs: 8192, range: 6 },
  bitflip: { power: 22 },
  cosmicray: { power: 95, range: 3 },
  nullref: { cooldownMs: 512 },
  blackhole: { energyCost: 24 },
  dereference: { power: 100, energyCost: 56, cooldownMs: 8192 },
  // cones for a few more types, so not every area move is a circle
  chown: { range: 4, shape: cone },
  unwind: { range: 4, shape: cone },
  storm: { range: 4, shape: cone },
  deadlock: { range: 4, shape: cone },
};
const STATUS_DURATION: Record<StatusId, number> = { throttled: 4096, stalled: 2048, leaking: 4096, exposed: 4096 };

export const MOVES: readonly MoveDef[] = deepFreeze(TYPES.flatMap((type) =>
  (['filler', 'ranged', 'area', 'heavy'] as const).map((slot, i) => {
    const id = TYPE_MOVES[type][i]!;
    // SP1's Crypto status lives on `encrypt` (ranged), not on the area move; every other type's is on its area move.
    const statusSlot: MoveSlot = type === 'crypto' ? 'ranged' : 'area';
    const status: MoveDef['status'] | undefined =
      slot === statusSlot
        ? { id: TYPE_STATUS[type], chance: 0.5, durationMs: STATUS_DURATION[TYPE_STATUS[type]] }
        : undefined;
    const move: MoveDef = { id, name: NAMES[id] ?? id, type, ...SLOT_DEFAULTS[slot], ...(status ? { status } : {}), ...SP1_TUNING[id] };
    return move;
  }),
));

const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function getMove(id: string): MoveDef {
  const m = BY_ID.get(id);
  if (!m) throw new RangeError(`unknown move ${id}`);
  return m;
}

export function moveSlot(id: string): MoveSlot {
  const m = getMove(id);
  return (['filler', 'ranged', 'area', 'heavy'] as const)[TYPE_MOVES[m.type].indexOf(id)]!;
}
