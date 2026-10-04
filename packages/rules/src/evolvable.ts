import type { STAT_KEYS, StatBlock } from './constants.js';
import type { Requirement } from './content/bestiary.js';
import { TYPES, type TypeId } from './types.js';

/*
 * The public half of evolution: shapes and small helpers that carry no requirement data. The
 * requirement table and everything that reads it (`requirementMet`, `evolutionOptions`,
 * `applyEvolution`) live in the server-only subpath `@daemonet/rules/evolution`.
 */

/** What the requirement checks and the evolution itself need to know about a daemon. */
export interface EvolvableDaemon {
  species: string;
  level: number;
  nature: number;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  patched: boolean;
  heldItem: string | null;
  /** Lifetime uses per type, in TYPES order. */
  moveTypeUses: readonly number[];
  crashes: number;
  arenaWins: number;
}

export interface EvolutionContext {
  subnet: string;
  /** No other operator within the interest radius right now. */
  unobserved: boolean;
  /** The daemon is still with the operator in its capture log. */
  originalOperator: boolean;
  /** Form ids whose hidden requirement has been discovered server-wide. */
  discovered: ReadonlySet<string>;
}

export interface EvolutionOption {
  form: string;
  name: string;
  level: number;
  hidden: boolean;
  /** Hidden requirements become public once anyone has met them. */
  revealed: boolean;
  /** Level reached and every requirement satisfied. */
  met: boolean;
  /** Requirements to show (null while hidden and unrevealed). */
  requirement: readonly Requirement[] | null;
}

export type EvolutionChange =
  | { kind: 'iv'; stat: (typeof STAT_KEYS)[number]; from: number; to: number }
  | { kind: 'clean' }
  | { kind: 'signature'; from: number; to: number; bonusStat: (typeof STAT_KEYS)[number] }
  | { kind: 'consumed'; item: string };

export interface EvolutionResult {
  species: string;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  heldItem: string | null;
  moves: string[];
  /** New max HP; the caller scales current HP by the same fraction. */
  maxHp: number;
  changes: EvolutionChange[];
}

export const SIGNATURE_UPGRADE_CHANCE = 1 / 256;

export function emptyMoveTypeUses(): number[] {
  return TYPES.map(() => 0);
}

export function typeIndex(type: TypeId): number {
  return TYPES.indexOf(type);
}
