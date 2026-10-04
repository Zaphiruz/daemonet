import { deepFreeze } from '../freeze.js';
import { TYPES, type TypeId } from '../types.js';
import { EVOLUTION_ITEMS, getItem, type FragmentId, type ItemId } from './items.js';

/** NPC shop prices in bits (SP3b spec §5). Higher tools cost exponentially more. */
export const SHOP: Readonly<Partial<Record<ItemId, number>>> = deepFreeze({
  sniff: 32,
  tap: 128,
  mirror: 512,
  dump: 2048,
  restore: 64,
  bitflipper: 4096,
});

export const BUY_MAX_QTY = 64;
export const CRAFT_MAX_QTY = 16;

/** Largest quantity one deposit / withdraw (and one Exchange order) moves. */
export const VAULT_MAX_QTY = 1024;

/** Items the Exchange trades (SP5): everything an inventory can hold. */
export function isTradable(id: string): boolean {
  try {
    getItem(id);
    return true;
  } catch {
    return false;
  }
}

/** Disk expansion: +32 slots per purchase from 256 up to 512; the price doubles each time. */
export const DISK_BASE = 256;
export const DISK_STEP = 32;
export const DISK_MAX = 512;
export const DISK_EXPANSION_ITEM = 'diskExpansion';
const DISK_EXPANSION_BASE_PRICE = 8192;

export function diskExpansionPrice(capacity: number): number | null {
  if (capacity >= DISK_MAX) return null;
  const purchases = Math.max(0, Math.round((capacity - DISK_BASE) / DISK_STEP));
  return DISK_EXPANSION_BASE_PRICE * 2 ** purchases;
}

export const fragmentId = (type: TypeId): FragmentId => `frag:${type}`;
export const FRAGMENT_IDS: readonly FragmentId[] = deepFreeze(TYPES.map(fragmentId));

export function isFragmentId(id: string): id is FragmentId {
  return id.startsWith('frag:') && (TYPES as readonly string[]).includes(id.slice(5));
}

/** Fragments of each of the daemon's types when it is decompiled (design §7.3). */
export function decompileYield(stage: number, level: number): number {
  return Math.floor(2 ** stage * (1 + level / 16));
}

export interface RecipeDef {
  id: string;
  output: { item: ItemId; qty: number };
  bits: number;
  /** Fragments per craft; `any` = the caller picks one type (`using`). */
  fragments: Readonly<Partial<Record<TypeId | 'any', number>>>;
}

const recipe = (id: string, item: ItemId, bits: number, fragments: RecipeDef['fragments'], qty = 1): RecipeDef => ({ id, output: { item, qty }, bits, fragments });

export const RECIPES: readonly RecipeDef[] = deepFreeze([
  recipe('tap', 'tap', 64, { packet: 4, socket: 4 }),
  recipe('mirror', 'mirror', 256, { packet: 8, proxy: 8 }),
  recipe('dump', 'dump', 1024, { buffer: 16, heap: 16 }),
  recipe('restore', 'restore', 16, { any: 2 }),
  ...EVOLUTION_ITEMS.map((e) => recipe(e.id, e.id, 512, { [e.type]: 16 })),
  recipe('amplifier', 'amplifier', 1024, { root: 12, thread: 12 }),
  recipe('heatsink', 'heatsink', 1024, { cache: 12, kernel: 12 }),
  recipe('battery', 'battery', 1024, { stack: 12, signal: 12 }),
  recipe('firewall', 'firewall', 1024, { shell: 12, crypto: 12 }),
  recipe('bitflipper', 'bitflipper', 2048, { glitch: 8, null: 8, crypto: 8, kernel: 8 }),
]);

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): RecipeDef {
  const r = BY_ID.get(id);
  if (!r) throw new RangeError(`unknown recipe ${id}`);
  return r;
}

/**
 * Fragment items a craft consumes: `frag:<type> → count · qty`, with `any` resolved to `using`.
 * Throws RangeError when the recipe needs a choice and none (or an unknown type) was given.
 */
export function recipeFragments(r: RecipeDef, qty: number, using?: TypeId): Partial<Record<FragmentId, number>> {
  const out: Partial<Record<FragmentId, number>> = {};
  for (const [key, n] of Object.entries(r.fragments) as Array<[TypeId | 'any', number]>) {
    const type = key === 'any' ? using : key;
    if (!type || !(TYPES as readonly string[]).includes(type)) throw new RangeError('this recipe needs a fragment type (using)');
    const id = fragmentId(type);
    out[id] = (out[id] ?? 0) + n * qty;
  }
  return out;
}

/** Sanity used by tests and the API: every recipe output is a real item. */
export function recipeOutputItem(r: RecipeDef) {
  return getItem(r.output.item);
}
