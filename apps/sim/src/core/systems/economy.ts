import {
  BUY_MAX_QTY,
  CRAFT_MAX_QTY,
  DISK_EXPANSION_ITEM,
  DISK_MAX,
  DISK_STEP,
  SHOP,
  decompileYield,
  diskExpansionPrice,
  fragmentId,
  getRecipe,
  getSpecies,
  recipeFragments,
  type RecipeDef,
  type TypeId,
} from '@daemonet/rules';
import { Rejection, type Daemon, type EconomyIntent, type Input, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/**
 * Shop, crafting and decompile (SP3b spec §5–§6).
 *
 * Costs (bits, consumed fragments) are taken from the operator when the command is accepted, so a second command in
 * the same tick sees the lower balance and nothing can be spent twice; a failed intent refunds them exactly. Gains
 * (items, Disk slots, decompile fragments) arrive only once the store has committed the intent, so nothing the
 * operator received can be spent before it is real. While such an intent is in flight, checkpoints leave the
 * inventory to the store (`OperatorRecord.inventoryInFlight`), and bits are never checkpointed at all.
 */

function addItems(op: Operator, items: Readonly<Record<string, number>>, sign: 1 | -1): void {
  for (const [id, n] of Object.entries(items)) {
    const next = (op.inventory[id] ?? 0) + sign * n;
    if (next <= 0) delete op.inventory[id];
    else op.inventory[id] = next;
  }
}

function requireItems(op: Operator, items: Readonly<Record<string, number>>): void {
  for (const [id, n] of Object.entries(items)) {
    if ((op.inventory[id] ?? 0) < n) throw new Rejection('E_STATE', `need ${n} ${id}, have ${op.inventory[id] ?? 0}`);
  }
}

function requireQty(qty: number, max: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > max) throw new Rejection('E_INVALID', `qty must be 1-${max}`);
}

/** Unit price of a shop item, or undefined (own keys only: `constructor` and friends are not for sale). */
export function shopPrice(itemId: string): number | undefined {
  return Object.hasOwn(SHOP, itemId) ? (SHOP as Readonly<Record<string, number>>)[itemId] : undefined;
}

export function buy(world: World, op: Operator, args: { itemId: string; qty: number }, input: Input, out: Out): void {
  const qty = args.qty;
  requireQty(qty, BUY_MAX_QTY);
  let price: number;
  if (args.itemId === DISK_EXPANSION_ITEM) {
    if (qty !== 1) throw new Rejection('E_INVALID', 'Disk expansions are bought one at a time');
    // The capacity only grows when the store commits: a second expansion now would be priced (and capped) on the old one.
    if (world.pendingIntents(op.id).some((i) => i.kind === 'buy' && i.itemId === DISK_EXPANSION_ITEM)) {
      throw new Rejection('E_STATE', 'a Disk expansion is already pending');
    }
    const p = diskExpansionPrice(op.diskCapacity);
    if (p === null) throw new Rejection('E_STATE', `Disk is already at its maximum of ${DISK_MAX} slots`);
    price = p;
  } else {
    const unit = shopPrice(args.itemId);
    if (unit === undefined) throw new Rejection('E_INVALID', `${args.itemId} is not for sale`);
    price = unit * qty;
  }
  if (op.bits < price) throw new Rejection('E_STATE', `costs ${price} bits, have ${op.bits}`);
  op.bits -= price;
  world.trackIntent({ id: world.newId('i'), kind: 'buy', operatorId: op.id, reqId: input.reqId, itemId: args.itemId, qty, price }, out);
}

export function craft(world: World, op: Operator, args: { recipeId: string; qty: number; using?: TypeId | undefined }, input: Input, out: Out): void {
  const qty = args.qty;
  requireQty(qty, CRAFT_MAX_QTY);
  let recipe: RecipeDef;
  try {
    recipe = getRecipe(args.recipeId);
  } catch {
    throw new Rejection('E_INVALID', `unknown recipe ${args.recipeId}`);
  }
  let fragments: Record<string, number>;
  try {
    fragments = recipeFragments(recipe, qty, args.using) as Record<string, number>;
  } catch (err) {
    throw new Rejection('E_INVALID', (err as Error).message);
  }
  const bits = recipe.bits * qty;
  requireItems(op, fragments);
  if (op.bits < bits) throw new Rejection('E_STATE', `costs ${bits} bits, have ${op.bits}`);
  op.bits -= bits;
  addItems(op, fragments, -1);
  const output = { item: recipe.output.item, qty: recipe.output.qty * qty };
  world.trackIntent({ id: world.newId('i'), kind: 'craft', operatorId: op.id, reqId: input.reqId, recipeId: recipe.id, qty, bits, fragments, output }, out);
}

export function decompile(world: World, op: Operator, d: Daemon, confirm: boolean, input: Input, out: Out): void {
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
  if ((d.clean || d.signature > 0) && !confirm) throw new Rejection('E_STATE', 'confirm required');
  const sp = getSpecies(d.species);
  const n = decompileYield(sp.stage, d.level);
  const fragments: Record<string, number> = {};
  for (const t of d.types) fragments[fragmentId(t)] = n;
  // The held item comes back with the fragments; the lock below keeps it on the daemon until the store commits.
  if (d.heldItem) fragments[d.heldItem] = (fragments[d.heldItem] ?? 0) + 1;
  d.pending = true;
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'decompile',
      operatorId: op.id,
      reqId: input.reqId,
      daemonId: d.id,
      species: d.species,
      fragments,
      history: {
        at: world.now(),
        kind: 'decompiled',
        detail: `at ${world.subnet.id} into ${Object.entries(fragments)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')}`,
      },
    },
    out,
  );
}

export function completeEconomyIntent(world: World, op: Operator, intent: EconomyIntent, result: IntentResult, out: Out): void {
  switch (intent.kind) {
    case 'buy': {
      const disk = intent.itemId === DISK_EXPANSION_ITEM;
      if (!result.ok) {
        op.bits += intent.price;
        return out.fail(intent, 'E_STATE', result.reason);
      }
      if (disk) op.diskCapacity = Math.min(DISK_MAX, op.diskCapacity + DISK_STEP);
      else addItems(op, { [intent.itemId]: intent.qty }, 1);
      out.emit({ e: 'bits', delta: -intent.price, reason: disk ? 'disk' : 'shop', balance: op.bits }, { to: op.id });
      return out.ok(intent, { bits: op.bits, diskCapacity: op.diskCapacity });
    }
    case 'craft': {
      if (!result.ok) {
        op.bits += intent.bits;
        addItems(op, intent.fragments, 1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      addItems(op, { [intent.output.item]: intent.output.qty }, 1);
      out.emit({ e: 'bits', delta: -intent.bits, reason: 'craft', balance: op.bits }, { to: op.id });
      return out.ok(intent, { bits: op.bits, output: intent.output });
    }
    case 'decompile': {
      const d = world.daemons.get(intent.daemonId);
      if (!result.ok) {
        if (d) d.pending = false;
        return out.fail(intent, 'E_STATE', result.reason);
      }
      if (d?.ownerId === op.id) world.removeDaemon(intent.daemonId);
      addItems(op, intent.fragments, 1);
      out.emit({ e: 'decompiled', daemon: intent.daemonId, species: intent.species, fragments: intent.fragments }, { to: op.id });
      return out.ok(intent, { fragments: intent.fragments });
    }
  }
}
