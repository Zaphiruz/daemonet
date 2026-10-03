import { MAX_MOVES, type StatBlock } from '../constants.js';
import { deepFreeze } from '../freeze.js';
import type { TypeId } from '../types.js';

export type Behaviour = 'timid' | 'territorial' | 'wanderer';

export interface LearnsetEntry {
  level: number;
  move: string;
}

export interface SpeciesDef {
  id: string;
  name: string;
  /** Bestiary line number (1-50). */
  line: number;
  /** 0 = base form. */
  stage: number;
  types: readonly TypeId[];
  base: StatBlock;
  traits: readonly [string, string];
  behaviour: Behaviour;
  baseYield: number;
  learnset: readonly LearnsetEntry[];
  starter: boolean;
}

const s = (hp: number, attack: number, defense: number, focus: number, resolve: number, speed: number, haste: number, energy: number): StatBlock => ({
  hp, attack, defense, focus, resolve, speed, haste, energy,
});

const learn = (filler: string, ranged: string, area: string, heavy: string): LearnsetEntry[] => [
  { level: 1, move: filler },
  { level: 1, move: ranged },
  { level: 8, move: area },
  { level: 16, move: heavy },
];

const PACKET = learn('ping', 'traceroute', 'broadcast', 'synflood');
const CRYPTO = learn('hash', 'encrypt', 'keyspray', 'bruteforce');
const GLITCH = learn('bitflip', 'corrupt', 'static', 'cosmicray');
const NULL = learn('nullref', 'voidbolt', 'blackhole', 'dereference');

/** SP1 content: the eight base forms of bestiary lines 05, 06, 08, 09, 32, 33, 36, 37. */
export const SPECIES: readonly SpeciesDef[] = deepFreeze([
  { id: 'pingling', name: 'Pingling', line: 5, stage: 0, types: ['packet'], base: s(34, 36, 28, 34, 28, 50, 42, 33), traits: ['echo', 'lowlatency'], behaviour: 'timid', baseYield: 32, learnset: PACKET, starter: true },
  { id: 'floodhound', name: 'Floodhound', line: 6, stage: 0, types: ['packet'], base: s(36, 48, 30, 30, 28, 42, 50, 36), traits: ['synburst', 'retransmit'], behaviour: 'territorial', baseYield: 36, learnset: PACKET, starter: false },
  { id: 'hashling', name: 'Hashling', line: 8, stage: 0, types: ['crypto'], base: s(36, 34, 36, 38, 38, 34, 34, 35), traits: ['salted', 'onewayfn'], behaviour: 'wanderer', baseYield: 32, learnset: CRYPTO, starter: true },
  { id: 'cipherbat', name: 'Cipherbat', line: 9, stage: 0, types: ['crypto'], base: s(32, 26, 30, 52, 40, 42, 40, 38), traits: ['darkmode', 'sonar'], behaviour: 'timid', baseYield: 36, learnset: CRYPTO, starter: false },
  { id: 'glitchmite', name: 'Glitchmite', line: 36, stage: 0, types: ['glitch'], base: s(32, 46, 28, 34, 26, 40, 46, 33), traits: ['overclock', 'bitshield'], behaviour: 'territorial', baseYield: 32, learnset: GLITCH, starter: true },
  { id: 'bitrot', name: 'Bitrot', line: 37, stage: 0, types: ['glitch'], base: s(40, 30, 36, 38, 40, 30, 40, 46), traits: ['entropy', 'decay'], behaviour: 'wanderer', baseYield: 36, learnset: GLITCH, starter: false },
  { id: 'nullpup', name: 'Nullpup', line: 32, stage: 0, types: ['null'], base: s(40, 36, 36, 32, 36, 34, 34, 37), traits: ['nullsafe', 'lazyeval'], behaviour: 'wanderer', baseYield: 32, learnset: NULL, starter: true },
  { id: 'voidlet', name: 'Voidlet', line: 33, stage: 0, types: ['null'], base: s(42, 26, 44, 30, 54, 28, 32, 44), traits: ['voidstep', 'absorb'], behaviour: 'territorial', baseYield: 36, learnset: NULL, starter: false },
]);

const BY_ID = new Map(SPECIES.map((sp) => [sp.id, sp]));

export function getSpecies(id: string): SpeciesDef {
  const sp = BY_ID.get(id);
  if (!sp) throw new RangeError(`unknown species ${id}`);
  return sp;
}

/** The (up to) 4 most recently learned moves at `level`, in learn order. */
export function movesAtLevel(species: SpeciesDef, level: number): string[] {
  const known = species.learnset.filter((e) => e.level <= level).map((e) => e.move);
  return known.slice(-MAX_MOVES);
}
