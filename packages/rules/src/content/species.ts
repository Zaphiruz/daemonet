import { MAX_MOVES, STAT_KEYS, statBlock, type StatBlock, type StatKey } from '../constants.js';
import { deepFreeze } from '../freeze.js';
import { createRng } from '../rng.js';
import type { TypeId } from '../types.js';
import { BESTIARY, type BestiaryRow, type Role } from './bestiary.js';
import { TYPE_MOVES } from './moves.js';
import { ROLE_TRAITS } from './traits.js';

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
  /** Depth in the evolution tree: 0 = base form, 1-3 = evolutions, 4 = a depth-4 capstone. */
  stage: number;
  types: readonly TypeId[];
  role: Role;
  base: StatBlock;
  traits: readonly [string, string];
  behaviour: Behaviour;
  baseYield: number;
  learnset: readonly LearnsetEntry[];
  starter: boolean;
  capstone: boolean;
  evolvesFrom: string | null;
  evolvesAt: number | null;
}

/** Base-stat totals by tree depth; capstones are 600; starter lines run 5% under at every stage. */
export const STAGE_BUDGETS = deepFreeze([300, 420, 500, 540] as const);
export const CAPSTONE_BUDGET = 600;

export const ROLE_WEIGHTS: Readonly<Record<Role, readonly number[]>> = deepFreeze({
  balanced: [1, 1, 1, 1, 1, 1, 1, 1],
  sweeper: [0.8, 1.4, 0.7, 0.8, 0.7, 1.5, 1.2, 0.9],
  nuker: [0.8, 0.7, 0.7, 1.5, 0.9, 1, 1.1, 1.3],
  tank: [1.5, 0.9, 1.4, 0.6, 1.2, 0.6, 0.7, 1.1],
  wall: [1.2, 0.6, 1, 0.8, 1.6, 0.6, 0.8, 1.4],
  striker: [0.9, 1.4, 0.8, 0.7, 0.7, 1, 1.4, 1.1],
  spammer: [0.9, 0.9, 0.8, 0.9, 0.8, 1, 1.6, 1.1],
  support: [1.1, 0.7, 1, 1.1, 1.2, 1, 1, 0.9],
  scout: [0.8, 0.9, 0.7, 0.8, 0.7, 1.7, 1.3, 1.1],
  bruiser: [1.3, 1.4, 1.1, 0.6, 0.8, 0.8, 0.9, 1.1],
  battery: [1, 0.7, 1, 0.9, 1, 0.8, 1, 1.6],
});

const ROLE_BEHAVIOUR: Record<Role, Behaviour> = {
  balanced: 'wanderer', sweeper: 'timid', nuker: 'wanderer', tank: 'territorial', wall: 'territorial', striker: 'territorial',
  spammer: 'timid', support: 'wanderer', scout: 'timid', bruiser: 'territorial', battery: 'wanderer',
};

const STARTER_LINES = new Set(BESTIARY.filter((r) => r.starter).map((r) => r.line));

/** Capstones (`capstone`, evolvesAt 64) get 600 whatever their depth; everything else follows its tree depth. */
export function budgetFor(row: BestiaryRow): number {
  const base = row.capstone ? CAPSTONE_BUDGET : STAGE_BUDGETS[Math.min(row.stage, 3)]!;
  return Math.round(STARTER_LINES.has(row.line) ? base * 0.95 : base);
}

/**
 * Hand tuning. A partial block replaces those stats and the largest remaining stat absorbs the
 * difference so the budget still holds; `total` overrides the budget itself.
 */
export const STAT_OVERRIDES: Readonly<Record<string, Partial<StatBlock> & { total?: number }>> = deepFreeze({
  // SP1's eight hand-authored base forms keep their exact stats.
  pingling: { hp: 34, attack: 36, defense: 28, focus: 34, resolve: 28, speed: 50, haste: 42, energy: 33 },
  floodhound: { hp: 36, attack: 48, defense: 30, focus: 30, resolve: 28, speed: 42, haste: 50, energy: 36 },
  hashling: { hp: 36, attack: 34, defense: 36, focus: 38, resolve: 38, speed: 34, haste: 34, energy: 35 },
  cipherbat: { hp: 32, attack: 26, defense: 30, focus: 52, resolve: 40, speed: 42, haste: 40, energy: 38 },
  glitchmite: { hp: 32, attack: 46, defense: 28, focus: 34, resolve: 26, speed: 40, haste: 46, energy: 33 },
  bitrot: { hp: 40, attack: 30, defense: 36, focus: 38, resolve: 40, speed: 30, haste: 40, energy: 46 },
  nullpup: { hp: 40, attack: 36, defense: 36, focus: 32, resolve: 36, speed: 34, haste: 34, energy: 37 },
  voidlet: { hp: 42, attack: 26, defense: 44, focus: 30, resolve: 54, speed: 28, haste: 32, energy: 44 },
});

/** Deterministic stats: role weights with ±6% per-stat jitter seeded by the id, summing exactly to the budget. */
export function baseStatsFor(row: BestiaryRow): StatBlock {
  const override = STAT_OVERRIDES[row.id];
  const total = override?.total ?? budgetFor(row);
  const rng = createRng(`stats:${row.id}`);
  const weights = ROLE_WEIGHTS[row.role].map((w) => w * (0.94 + rng.float() * 0.12));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = statBlock(0);
  STAT_KEYS.forEach((k, i) => (out[k] = Math.min(256, Math.max(1, Math.round((total * weights[i]!) / sum)))));
  if (override) for (const k of STAT_KEYS) if (override[k] !== undefined) out[k] = override[k]!;
  // fix rounding (and override) drift on the largest non-overridden stat
  const free = STAT_KEYS.filter((k) => override?.[k] === undefined);
  const drift = total - STAT_KEYS.reduce((a, k) => a + out[k], 0);
  if (drift !== 0 && free.length > 0) {
    const target = free.reduce((best, k) => (out[k] > out[best] ? k : best), free[0]!);
    out[target] = Math.min(256, Math.max(1, out[target] + drift));
  }
  return out;
}

function learnsetFor(row: BestiaryRow): LearnsetEntry[] {
  const primary = TYPE_MOVES[row.types[0]!];
  const area = TYPE_MOVES[row.types[1] ?? row.types[0]!][2];
  return [
    { level: 1, move: primary[0] },
    { level: 1, move: primary[1] },
    { level: 8, move: area },
    { level: 16, move: primary[3] },
  ];
}

// Each species gets its own copies: BESTIARY and ROLE_TRAITS are already frozen and deepFreeze is shared-safe,
// but fresh arrays keep every SpeciesDef self-contained.
export const SPECIES: readonly SpeciesDef[] = deepFreeze(
  BESTIARY.map(
    (row): SpeciesDef => ({
      id: row.id,
      name: row.name,
      line: row.line,
      stage: row.stage,
      types: [...row.types],
      role: row.role,
      base: baseStatsFor(row),
      traits: [...ROLE_TRAITS[row.role]] as [string, string],
      behaviour: ROLE_BEHAVIOUR[row.role],
      baseYield: 32 + 8 * row.stage,
      learnset: learnsetFor(row),
      starter: row.starter,
      capstone: row.capstone,
      evolvesFrom: row.evolvesFrom,
      evolvesAt: row.evolvesAt,
    }),
  ),
);

const BY_ID = new Map(SPECIES.map((sp) => [sp.id, sp]));

export function getSpecies(id: string): SpeciesDef {
  const sp = BY_ID.get(id);
  if (!sp) throw new RangeError(`unknown species ${id}`);
  return sp;
}

/** Forms this species can evolve into (in bestiary order). */
export function evolutionsOf(id: string): SpeciesDef[] {
  return SPECIES.filter((s) => s.evolvesFrom === id);
}

/** The (up to) 4 most recently learned moves at `level`, in learn order. */
export function movesAtLevel(species: SpeciesDef, level: number): string[] {
  const known = species.learnset.filter((e) => e.level <= level).map((e) => e.move);
  return known.slice(-MAX_MOVES);
}

export function dominantStat(ivs: StatBlock): StatKey | null {
  let best: StatKey | null = null;
  let tie = false;
  for (const k of STAT_KEYS) {
    if (best === null || ivs[k] > ivs[best]) {
      best = k;
      tie = false;
    } else if (ivs[k] === ivs[best]) tie = true;
  }
  return tie ? null : best;
}
