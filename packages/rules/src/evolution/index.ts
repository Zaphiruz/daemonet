import { MAX_IV, SIGNATURE_MAX, STAT_KEYS } from '../constants.js';
import { type Requirement } from '../content/bestiary.js';
import { dominantStat, evolutionsOf, getSpecies, movesAtLevel, type SpeciesDef } from '../content/species.js';
import {
  SIGNATURE_UPGRADE_CHANCE,
  type EvolutionChange,
  type EvolutionContext,
  type EvolutionOption,
  type EvolutionResult,
  type EvolvableDaemon,
} from '../evolvable.js';
import type { Rng } from '../rng.js';
import { computeStats } from '../stats.js';
import { TYPES } from '../types.js';
import { ruleFor } from './rules.js';

/*
 * SERVER-ONLY entry `@daemonet/rules/evolution` (package.json `exports["./evolution"]`): the requirement
 * table and the functions that read it. Players get requirements masked through `/api/codex` and
 * `RamDaemon.evolutions` instead.
 */

export { BESTIARY_WITH_RULES, EVOLUTION_RULES, EVOLUTION_RULES_TAG, ruleFor } from './rules.js';

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

/** Every form the daemon's species can evolve into, with requirement status. */
export function evolutionOptions(d: EvolvableDaemon, ctx: EvolutionContext): EvolutionOption[] {
  return evolutionsOf(d.species).map((form) => {
    const rule = ruleFor(form.id);
    const reqs = rule.requirement ?? [];
    const revealed = !rule.hidden || ctx.discovered.has(form.id);
    const met = d.level >= (form.evolvesAt ?? Infinity) && reqs.every((r) => requirementMet(r, d, ctx));
    return { form: form.id, name: form.name, level: form.evolvesAt ?? 0, hidden: rule.hidden, revealed, met, requirement: revealed ? reqs : null };
  });
}

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
  const consumed = (ruleFor(form.id).requirement ?? []).find((r) => r.kind === 'heldItem');
  if (consumed && consumed.kind === 'heldItem' && heldItem === consumed.item) {
    heldItem = null;
    changes.push({ kind: 'consumed', item: consumed.item });
  }
  const maxHp = computeStats({ base: form.base, ivs, bonus, level: d.level, nature: d.nature }).hp;
  return { species: form.id, ivs, bonus, clean, signature, heldItem, moves: movesAtLevel(form, d.level), maxHp, changes };
}
