import { describe, expect, it } from 'vitest';
import {
  BUY_MAX_QTY,
  CRAFT_MAX_QTY,
  DISK_BASE,
  DISK_EXPANSION_ITEM,
  DISK_MAX,
  DISK_STEP,
  FRAGMENT_IDS,
  RECIPES,
  SHOP,
  VAULT_MAX_QTY,
  decompileYield,
  diskExpansionPrice,
  fragmentId,
  getRecipe,
  isFragmentId,
  isTradable,
  recipeFragments,
  recipeOutputItem,
} from '../src/content/economy.js';
import { ITEMS, STARTING_INVENTORY, getItem } from '../src/content/items.js';
import { TYPES } from '../src/types.js';

describe('economy content', () => {
  it('shop prices are powers of two for real items', () => {
    for (const [id, price] of Object.entries(SHOP)) {
      expect(() => getItem(id)).not.toThrow();
      expect(Math.log2(price) % 1).toBe(0);
    }
    expect(SHOP.sniff).toBe(32);
    expect(SHOP.dump).toBe(2048);
    expect(Object.keys(SHOP)).toEqual(['sniff', 'tap', 'mirror', 'dump', 'restore', 'bitflipper']);
  });

  it('exposes the quantity caps and Disk constants', () => {
    expect([BUY_MAX_QTY, CRAFT_MAX_QTY, DISK_BASE, DISK_STEP, DISK_MAX, DISK_EXPANSION_ITEM]).toEqual([64, 16, 256, 32, 512, 'diskExpansion']);
  });

  it('the Exchange trades every inventory item, at most VAULT_MAX_QTY per move', () => {
    expect(VAULT_MAX_QTY).toBe(1024);
    for (const item of ITEMS) expect(isTradable(item.id), item.id).toBe(true);
    for (const id of ['nonsense', '', 'diskExpansion', 'frag:', 'frag:nothing', '__proto__', 'constructor', 'toString', 'SNIFF']) expect(isTradable(id), id).toBe(false);
  });

  it('disk expansion doubles from 8192 and stops at 512 slots', () => {
    expect(diskExpansionPrice(256)).toBe(8192);
    expect(diskExpansionPrice(288)).toBe(16384);
    expect(diskExpansionPrice(480)).toBe(8192 * 2 ** 7);
    expect(diskExpansionPrice(DISK_MAX)).toBeNull();
  });

  it('there is one fragment item per type', () => {
    const frags = ITEMS.filter((i) => i.kind === 'fragment');
    expect(frags).toHaveLength(16);
    expect(frags.map((f) => f.id)).toEqual(TYPES.map(fragmentId));
    expect(FRAGMENT_IDS).toEqual(TYPES.map(fragmentId));
    expect(isFragmentId('frag:packet')).toBe(true);
    expect(isFragmentId('frag:nope')).toBe(false);
    expect(isFragmentId('sniff')).toBe(false);
  });

  it('decompile yields floor(2^stage · (1 + level/16))', () => {
    expect(decompileYield(0, 5)).toBe(1);
    expect(decompileYield(1, 16)).toBe(4);
    expect(decompileYield(2, 32)).toBe(12);
    expect(decompileYield(3, 64)).toBe(40);
  });

  it('recipes produce real items from real fragment types', () => {
    expect(RECIPES.length).toBe(4 + 16 + 4 + 1);
    for (const r of RECIPES) {
      expect(recipeOutputItem(r).id).toBe(r.output.item);
      for (const key of Object.keys(r.fragments)) expect(key === 'any' || (TYPES as readonly string[]).includes(key)).toBe(true);
      expect(r.bits).toBeGreaterThan(0);
    }
    expect(getRecipe('jumboframe').fragments).toEqual({ packet: 16 });
    expect(() => getRecipe('nope')).toThrow(RangeError);
  });

  it('recipeFragments scales by quantity and resolves "any"', () => {
    expect(recipeFragments(getRecipe('tap'), 2)).toEqual({ 'frag:packet': 8, 'frag:socket': 8 });
    expect(recipeFragments(getRecipe('restore'), 3, 'glitch')).toEqual({ 'frag:glitch': 6 });
    expect(() => recipeFragments(getRecipe('restore'), 1)).toThrow(RangeError);
  });

  it('tables are deep-frozen and the starting inventory only holds real items', () => {
    expect(Object.isFrozen(SHOP)).toBe(true);
    expect(Object.isFrozen(RECIPES)).toBe(true);
    expect(Object.isFrozen(RECIPES[0])).toBe(true);
    expect(Object.isFrozen(RECIPES[0]!.fragments)).toBe(true);
    expect(Object.isFrozen(RECIPES[0]!.output)).toBe(true);
    expect(Object.isFrozen(FRAGMENT_IDS)).toBe(true);
    expect(Object.isFrozen(ITEMS.find((i) => i.kind === 'fragment'))).toBe(true);
    for (const id of Object.keys(STARTING_INVENTORY)) expect(() => getItem(id)).not.toThrow();
  });
});
