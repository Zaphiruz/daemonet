import { fragmentId, type RecipeDef, type TypeId } from '@daemonet/rules';

/** `have / need` per fragment for a craft; `ok` when the inventory and bits cover it. */
export interface CraftCheck {
  ok: boolean;
  bits: number;
  needs: Array<{ item: string; have: number; need: number }>;
  /** The recipe has an `any` slot and no type was chosen. */
  needsType: boolean;
}

export function craftCheck(recipe: RecipeDef, qty: number, inventory: Record<string, number>, bits: number, using?: TypeId): CraftCheck {
  const needs: CraftCheck['needs'] = [];
  let needsType = false;
  for (const [key, n] of Object.entries(recipe.fragments) as Array<[TypeId | 'any', number]>) {
    const type = key === 'any' ? using : key;
    if (!type) {
      needsType = true;
      continue;
    }
    const item = fragmentId(type);
    needs.push({ item, have: inventory[item] ?? 0, need: n * qty });
  }
  const cost = recipe.bits * qty;
  const ok = !needsType && bits >= cost && needs.every((x) => x.have >= x.need);
  return { ok, bits: cost, needs, needsType };
}

/** Fragment types the operator holds (for the `using` picker). */
export function fragmentTypes(inventory: Record<string, number>): TypeId[] {
  return Object.entries(inventory)
    .filter(([id, n]) => n > 0 && id.startsWith('frag:'))
    .map(([id]) => id.slice(5) as TypeId);
}

/** Bits shown in binary units: 8 bits = 1 byte, 1 KiB = 8192 bits (design §10). */
export function formatBits(bits: number): string {
  if (bits >= 8192 * 1024) return `${(bits / (8192 * 1024)).toFixed(2)} MiB`;
  if (bits >= 8192) return `${(bits / 8192).toFixed(2)} KiB`;
  if (bits >= 8) return `${(bits / 8).toFixed(bits % 8 === 0 ? 0 : 2)} B`;
  return `${bits} b`;
}
