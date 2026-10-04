import { getItem, type Requirement } from '@daemonet/rules';

/** An item's display name (the raw id for an unknown item). */
export function itemName(id: string): string {
  try {
    return getItem(id).name;
  } catch {
    return id;
  }
}

/** One requirement as the Codex and the RAM card show it. */
export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case 'heldItem':
      return `hold ${itemName(r.item)}`;
    case 'dominantIV':
      return `highest IV: ${r.stat}`;
    case 'moveTypeUses':
      return `${r.count} ${r.type} move uses`;
    case 'subnet':
      return `evolve in ${r.subnet}`;
    case 'clean':
      return 'clean image';
    case 'signature':
      return `signature T${r.min}+`;
    case 'originalOperator':
      return 'with its original operator';
    case 'crashes':
      return r.op === 'max' ? `at most ${r.count} crashes` : `at least ${r.count} crashes`;
    case 'arenaWins':
      return `${r.count} arena wins`;
    case 'unobserved':
      return 'with no other operator nearby';
  }
}

/**
 * `L16 · hold Jumbo Frame` — the level, then each requirement; `???` while a hidden requirement is
 * undiscovered (`requirement === null` with `hidden`). Level-only branches read just `L16`.
 * The wire carries requirements as `unknown[]`; this is the one place they are typed as `Requirement`.
 */
export function describeBranch(level: number, requirement: readonly Requirement[] | readonly unknown[] | null, hidden: boolean): string {
  const parts = [`L${level}`];
  if (requirement === null) {
    if (hidden) parts.push('???');
  } else parts.push(...(requirement as readonly Requirement[]).map(describeRequirement));
  return parts.join(' · ');
}
