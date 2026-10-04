import { MAX_IV, SIGNATURE_MAX, STAT_KEYS, type StatBlock } from './constants.js';
import { type Requirement } from './content/bestiary.js';
import { dominantStat, evolutionsOf, getSpecies, movesAtLevel, type SpeciesDef } from './content/species.js';
import type { Rng } from './rng.js';
import { computeStats } from './stats.js';
import { TYPES, type TypeId } from './types.js';

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

export function requirementMet(req: Requirement, d: EvolvableDaemon, ctx: EvolutionContext): boolean {
  switch (req.kind) {
    case 'heldItem':
      return d.heldItem === req.item;
    case 'dominantIV':
      return dominantStat(d.ivs) === req.stat;
    case 'moveTypeUses':
      return (d.moveTypeUses[TYPES.indexOf(req.type)] ?? 0) >= req.count;
    case 'subnet':
      return ctx.subnet === req.subnet;
    case 'clean':
      return d.clean;
    case 'signature':
      return d.signature >= req.min;
    case 'originalOperator':
      return ctx.originalOperator;
    case 'crashes':
      return req.op === 'max' ? d.crashes <= req.count : d.crashes >= req.count;
    case 'arenaWins':
      return d.arenaWins >= req.count;
    case 'unobserved':
      return ctx.unobserved;
  }
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

/** Every form the daemon's species can evolve into, with requirement status. */
export function evolutionOptions(d: EvolvableDaemon, ctx: EvolutionContext): EvolutionOption[] {
  return evolutionsOf(d.species).map((form) => {
    const reqs = form.requirement ?? [];
    const revealed = !form.hidden || ctx.discovered.has(form.id);
    const met = d.level >= (form.evolvesAt ?? Infinity) && reqs.every((r) => requirementMet(r, d, ctx));
    return { form: form.id, name: form.name, level: form.evolvesAt ?? 0, hidden: form.hidden, revealed, met, requirement: revealed ? reqs : null };
  });
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

/**
 * Game design §7.1, in order: IV growth (each IV below 31 gains +1 with p = ½), the clean check (all 31
 * and not patched → clean, entering at T0), the signature upgrade (clean → 1/256 chance of +1 tier with
 * +1 bonus on a random stat), then the species change. Consumes a held evolution item the branch requires.
 *
 * Does not check eligibility: the caller must verify the option's `met` (via `evolutionOptions`) first.
 */
export function applyEvolution(d: EvolvableDaemon, formId: string, rng: Rng, chances = { iv: 0.5, signature: SIGNATURE_UPGRADE_CHANCE }): EvolutionResult {
  const form: SpeciesDef = getSpecies(formId);
  if (form.evolvesFrom !== d.species) throw new RangeError(`${formId} does not evolve from ${d.species}`);
  const changes: EvolutionChange[] = [];
  const ivs = { ...d.ivs };
  for (const k of STAT_KEYS) {
    if (ivs[k] < MAX_IV && rng.chance(chances.iv)) {
      changes.push({ kind: 'iv', stat: k, from: ivs[k], to: ivs[k] + 1 });
      ivs[k]++;
    }
  }
  let clean = d.clean;
  if (!clean && !d.patched && STAT_KEYS.every((k) => ivs[k] === MAX_IV)) {
    clean = true;
    changes.push({ kind: 'clean' });
  }
  let signature = d.signature;
  const bonus = { ...d.bonus };
  if (clean && signature < SIGNATURE_MAX && rng.chance(chances.signature)) {
    const bonusStat = rng.pick(STAT_KEYS);
    bonus[bonusStat]++;
    changes.push({ kind: 'signature', from: signature, to: signature + 1, bonusStat });
    signature++;
  }
  let heldItem = d.heldItem;
  const consumed = (form.requirement ?? []).find((r) => r.kind === 'heldItem');
  if (consumed && consumed.kind === 'heldItem' && heldItem === consumed.item) {
    heldItem = null;
    changes.push({ kind: 'consumed', item: consumed.item });
  }
  const maxHp = computeStats({ base: form.base, ivs, bonus, level: d.level, nature: d.nature }).hp;
  return { species: form.id, ivs, bonus, clean, signature, heldItem, moves: movesAtLevel(form, d.level), maxHp, changes };
}

export function emptyMoveTypeUses(): number[] {
  return TYPES.map(() => 0);
}

export function typeIndex(type: TypeId): number {
  return TYPES.indexOf(type);
}
