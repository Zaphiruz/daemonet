import { MemoryBus } from '@daemonet/bus';
import { Command, type ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type Intent, type IntentResult, type OperatorRecord } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn, type GameOptions } from '../src/runtime/game.js';
import { MemoryStore, type IntentContext } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const HOST = TEST_SUBNET.host;

function setup(over: Partial<ReturnType<typeof operatorRecord>> = {}) {
  const world = makeWorld('econ');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y, bits: 1000, inventory: { restore: 1 }, ...over }));
  return world;
}

/** Runs one command through a MemoryStore seeded with the world's operator, completing the intent. */
async function through(world: ReturnType<typeof setup>, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null, result: null };
  const intent = r.intents[0]!;
  const result = await store.applyIntent(intent, { seedId: 'seed0001' });
  world.completeIntent(intent.id, result);
  const after = step(world);
  return { reply: after.replies[0]!, intent, result, events: after.events.map((e) => e.event) };
}

async function seeded(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  const cp = world.checkpoint('alice');
  store.operators.set('alice', { ...mem, id: 'alice', bits: cp.bits, inventory: { ...cp.inventory }, diskCapacity: cp.diskCapacity });
  for (const d of cp.ram) store.daemons.set(d.id, { ...d, operatorId: 'alice', location: 'RAM' });
  return store;
}

const buyCmd = (itemId: string, qty = 1): Command => ({ cmd: 'buy', actor: self, args: { itemId, qty } });
const craftCmd = (recipeId: string, qty = 1, using?: 'glitch' | 'packet'): Command => ({ cmd: 'craft', actor: self, args: using ? { recipeId, qty, using } : { recipeId, qty } });
const decompileCmd = (daemonId: string, confirm = false): Command => ({ cmd: 'decompile', actor: self, args: { daemonId, confirm } });

describe('shop', () => {
  it('sells at the host, applies bits and items optimistically, and commits through the ledger', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const { reply, intent, events } = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'tap', qty: 2 } });
    expect(intent).toMatchObject({ kind: 'buy', itemId: 'tap', qty: 2, price: 256 });
    expect(reply).toMatchObject({ ok: true, result: { bits: 744 } });
    expect(op.bits).toBe(744);
    expect(op.inventory.tap).toBe(2);
    expect(events).toContainEqual({ e: 'bits', delta: -256, reason: 'shop', balance: 744 });
    expect(store.ledger).toEqual([{ operatorId: 'alice', delta: -256, reason: 'shop', ref: intent!.id, at: expect.any(String) }]);
    expect(store.operators.get('alice')).toMatchObject({ bits: 744, inventory: { tap: 2 } });
  });

  it('refuses away from the host, unknown items, bad quantities and unaffordable purchases', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const buy = (args: { itemId: string; qty?: number }) => step(world, input('alice', { cmd: 'buy', actor: self, args: { qty: 1, ...args } })).replies[0];
    expect(buy({ itemId: 'jumboframe' })).toMatchObject({ code: 'E_INVALID' });
    expect(buy({ itemId: 'dump' })).toMatchObject({ code: 'E_STATE', message: 'costs 2048 bits, have 1000' });
    expect(buy({ itemId: 'sniff', qty: 65 })).toMatchObject({ code: 'E_INVALID' });
    op.x = HOST.x + 5;
    expect(buy({ itemId: 'sniff' })).toMatchObject({ code: 'E_RANGE' });
  });

  it('reverts an optimistic purchase the store rejects', async () => {
    const world = setup();
    const store = new MemoryStore(); // no such operator: the intent throws, the runtime reports a failure
    const r = step(world, input('alice', { cmd: 'buy', actor: self, args: { itemId: 'sniff', qty: 4 } }));
    const op = world.operators.get('alice')!;
    expect(op.bits).toBe(1000 - 128);
    // Deviation from the brief (which expected 4 here): the cost is taken at once, the items only arrive on commit,
    // so nothing bought can be spent before the purchase is real (see economy.ts).
    expect(op.inventory.sniff).toBeUndefined();
    await expect(store.applyIntent(r.intents[0]!, { seedId: 'seed0001' })).rejects.toThrow();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(op.bits).toBe(1000);
    expect(op.inventory.sniff).toBeUndefined();
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'persist failed' });
  });

  it('Disk expansion adds 32 slots at a doubling price, up to 512', async () => {
    const world = setup({ bits: 2_000_000, diskCapacity: 480 });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const first = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 1 } });
    expect(first.intent).toMatchObject({ price: 8192 * 2 ** 7 });
    expect(op.diskCapacity).toBe(512);
    expect(first.events).toContainEqual({ e: 'bits', delta: -8192 * 2 ** 7, reason: 'disk', balance: 2_000_000 - 8192 * 2 ** 7 });
    expect(store.operators.get('alice')!.diskCapacity).toBe(512);
    const again = await through(world, store, { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 1 } });
    expect(again.reply).toMatchObject({ code: 'E_STATE' });
    expect(step(world, input('alice', { cmd: 'buy', actor: self, args: { itemId: 'diskExpansion', qty: 2 } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
  });

  it('a bigger Disk is usable for storing (store and capture read the operator capacity)', () => {
    const world = setup({ diskCapacity: 288, diskSlots: Array.from({ length: 256 }, (_, i) => i) });
    const r = step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(r.intents[0]).toMatchObject({ kind: 'store', diskSlot: 256 });
    expect(world.checkpoint('alice').diskCapacity).toBe(288);
  });
});

describe('crafting', () => {
  it('consumes fragments and bits, produces the output, and resolves "any" with using', async () => {
    const world = setup({ inventory: { 'frag:packet': 10, 'frag:socket': 4, 'frag:glitch': 2 } });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const tap = await through(world, store, { cmd: 'craft', actor: self, args: { recipeId: 'tap', qty: 1 } });
    expect(tap.intent).toMatchObject({ kind: 'craft', bits: 64, fragments: { 'frag:packet': 4, 'frag:socket': 4 }, output: { item: 'tap', qty: 1 } });
    expect(op.inventory).toEqual({ 'frag:packet': 6, 'frag:glitch': 2, tap: 1 });
    expect(op.bits).toBe(936);
    expect(store.operators.get('alice')).toMatchObject({ bits: 936, inventory: { 'frag:packet': 6, 'frag:glitch': 2, tap: 1 } });
    const restore = await through(world, store, { cmd: 'craft', actor: self, args: { recipeId: 'restore', qty: 1, using: 'glitch' } });
    expect(restore.reply).toMatchObject({ ok: true });
    expect(op.inventory.restore).toBe(1);
    expect(op.inventory['frag:glitch']).toBeUndefined();
  });

  it('refuses unknown recipes, missing fragments, missing "using" and bad quantities', () => {
    const world = setup({ inventory: { 'frag:packet': 4 } });
    const craft = (args: { recipeId: string; qty?: number; using?: 'glitch' }) => step(world, input('alice', { cmd: 'craft', actor: self, args: { qty: 1, ...args } })).replies[0];
    expect(craft({ recipeId: 'nope' })).toMatchObject({ code: 'E_INVALID' });
    expect(craft({ recipeId: 'tap' })).toMatchObject({ code: 'E_STATE', message: 'need 4 frag:socket, have 0' });
    expect(craft({ recipeId: 'restore' })).toMatchObject({ code: 'E_INVALID' });
    expect(craft({ recipeId: 'restore', qty: 17, using: 'glitch' })).toMatchObject({ code: 'E_INVALID' });
  });

  it('a failed craft refunds exactly the bits and fragments it took', () => {
    const world = setup({ inventory: { 'frag:packet': 9, restore: 1 } });
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', craftCmd('restore', 4, 'packet')));
    expect(op.inventory).toEqual({ 'frag:packet': 1, restore: 1 });
    expect(op.bits).toBe(1000 - 64);
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'not enough frag:packet' });
    expect(op.inventory).toEqual({ 'frag:packet': 9, restore: 1 });
    expect(op.bits).toBe(1000);
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'not enough frag:packet' });
  });
});

describe('decompile', () => {
  it('destroys a RAM daemon at the host for fragments of each type, archiving it in the store', async () => {
    const world = setup({ ram: [ownedRecord('tracerat', 20, 0, 'alice-d0')] });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const { reply, intent, events } = await through(world, store, { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: false } });
    expect(intent).toMatchObject({ kind: 'decompile', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 } });
    expect(intent).toMatchObject({ history: { at: FIXED_CLOCK, kind: 'decompiled' } });
    expect(reply).toMatchObject({ ok: true, result: { fragments: { 'frag:packet': 9, 'frag:signal': 9 } } });
    expect(events).toContainEqual({ e: 'decompiled', daemon: 'alice-d0', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 } });
    expect(world.daemons.has('alice-d0')).toBe(false);
    expect(op.ram).toEqual([]);
    expect(op.inventory).toMatchObject({ 'frag:packet': 9, 'frag:signal': 9 });
    expect(store.daemons.has('alice-d0')).toBe(false);
    expect(store.archive.get('alice-d0')).toMatchObject({ species: 'tracerat', reason: 'decompiled' });
    expect(store.archive.get('alice-d0')!.history.at(-1)).toMatchObject({ kind: 'decompiled' });
  });

  it('needs confirm for clean or signature daemons, refuses running ones, and returns a held item', async () => {
    const world = setup({ ram: [{ ...ownedRecord('pingling', 5, 0, 'alice-d0'), signature: 2, heldItem: 'jumboframe' }] });
    const store = await seeded(world);
    const attempt = (confirm: boolean) => step(world, input('alice', { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm } })).replies[0];
    expect(attempt(false)).toMatchObject({ code: 'E_STATE', message: 'confirm required' });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(attempt(true)).toMatchObject({ code: 'E_STATE', message: 'recall the daemon first' });
    world.deactivate(world.daemons.get('alice-d0')!);
    const { intent } = await through(world, store, { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: true } });
    expect(intent).toMatchObject({ fragments: { 'frag:packet': 1, jumboframe: 1 } });
    expect(world.operators.get('alice')!.inventory.jumboframe).toBe(1);
  });

  it('keeps the daemon when the store fails', async () => {
    const world = setup({ ram: [ownedRecord('pingling', 5, 0, 'alice-d0')] });
    const r = step(world, input('alice', { cmd: 'decompile', actor: self, args: { daemonId: 'alice-d0', confirm: false } }));
    const d = world.daemons.get('alice-d0')!;
    expect(d.pending).toBe(true);
    world.completeIntent((r.intents[0] as Intent).id, { ok: false, reason: 'db down' });
    expect(d.pending).toBe(false);
    expect(world.daemons.has('alice-d0')).toBe(true);
  });

  it('refuses wild daemons, daemons of others, and work away from the host', () => {
    const world = setup();
    world.addOperator(operatorRecord('bob', { x: HOST.x, y: HOST.y }));
    expect(step(world, input('alice', decompileCmd('bob-d0'))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'no daemon bob-d0 in RAM' });
    world.operators.get('alice')!.x = HOST.x + 5;
    expect(step(world, input('alice', decompileCmd('alice-d0'))).replies[0]).toMatchObject({ code: 'E_RANGE' });
    expect(world.daemons.has('bob-d0')).toBe(true);
  });
});

describe('economy exploits', () => {
  it('two purchases in one tick cannot spend the same bits', () => {
    const world = setup({ bits: 3000 });
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', buyCmd('dump')), input('alice', buyCmd('dump')));
    expect(r.intents).toHaveLength(1);
    expect(r.replies).toEqual([expect.objectContaining({ code: 'E_STATE', message: 'costs 2048 bits, have 952' })]);
    expect(op.bits).toBe(952);
    // what is bought cannot be used before the purchase commits (a failed purchase would otherwise leave it spent)
    step(world, input('alice', buyCmd('restore')));
    expect(step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'restore', daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ ok: true });
    expect(step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'restore', daemonId: 'alice-d1' } })).replies[0]).toMatchObject({ message: 'no restore left' });
  });

  it('two crafts in one tick cannot use the same fragments, and a third waits for nothing it does not own', () => {
    const world = setup({ inventory: { 'frag:packet': 4, 'frag:socket': 4 } });
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', craftCmd('tap')), input('alice', craftCmd('tap')));
    expect(r.intents).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ code: 'E_STATE', message: 'need 4 frag:packet, have 0' });
    expect(op.inventory).toEqual({});
    // the tap only exists once the craft commits: nothing to spend meanwhile
    expect(step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: 'w', tool: 'tap' } })).replies[0]).toMatchObject({ message: 'no tap left' });
  });

  it('fragments from a pending decompile cannot be crafted with until the decompile commits', async () => {
    const world = setup({ ram: [ownedRecord('tracerat', 20, 0, 'alice-d0'), ownedRecord('pingling', 5, 1, 'alice-d1')] });
    const store = await seeded(world);
    const r = step(world, input('alice', decompileCmd('alice-d0')));
    expect(step(world, input('alice', craftCmd('restore', 1, 'packet'))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'need 2 frag:packet, have 0' });
    world.completeIntent(r.intents[0]!.id, await store.applyIntent(r.intents[0]!, { seedId: 'seed0001' }));
    step(world);
    const craft = await through(world, store, craftCmd('restore', 1, 'packet'));
    expect(craft.reply).toMatchObject({ ok: true });
    expect(world.operators.get('alice')!.inventory).toMatchObject({ 'frag:packet': 7, 'frag:signal': 9, restore: 2 });
    expect(store.operators.get('alice')!.inventory).toMatchObject({ 'frag:packet': 7, 'frag:signal': 9, restore: 2 });
  });

  it('negative, zero, fractional and huge quantities are refused (world and wire)', () => {
    const world = setup({ bits: 1e9, inventory: { 'frag:packet': 1000 } });
    const op = world.operators.get('alice')!;
    for (const qty of [0, -1, -64, 1.5, 65, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(step(world, input('alice', buyCmd('sniff', qty))).replies[0]).toMatchObject({ code: 'E_INVALID' });
      expect(step(world, input('alice', craftCmd('restore', qty, 'packet'))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    }
    expect(op.bits).toBe(1e9);
    expect(op.inventory).toEqual({ 'frag:packet': 1000 });
    for (const qty of [0, -1, 1.5, 65, 1e9]) expect(Command.safeParse({ cmd: 'buy', actor: 'self', args: { itemId: 'sniff', qty } }).success).toBe(false);
    for (const qty of [0, 17]) expect(Command.safeParse({ cmd: 'craft', actor: 'self', args: { recipeId: 'tap', qty } }).success).toBe(false);
    expect(Command.parse({ cmd: 'buy', actor: 'self', args: { itemId: 'sniff' } })).toMatchObject({ args: { qty: 1 } });
    expect(Command.parse({ cmd: 'decompile', actor: 'self', args: { daemonId: 'd' } })).toMatchObject({ args: { confirm: false } });
  });

  it('prototype keys are not for sale', () => {
    const world = setup();
    for (const itemId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(step(world, input('alice', buyCmd(itemId))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    }
    expect(world.operators.get('alice')!.bits).toBe(1000);
  });

  it('a second Disk expansion waits for the first, so the cap cannot be passed', async () => {
    const world = setup({ bits: 4_000_000, diskCapacity: 480 });
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', buyCmd('diskExpansion')), input('alice', buyCmd('diskExpansion')));
    expect(r.intents).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ code: 'E_STATE', message: 'a Disk expansion is already pending' });
    world.completeIntent(r.intents[0]!.id, await store.applyIntent(r.intents[0]!, { seedId: 'seed0001' }));
    expect(op.diskCapacity).toBe(512);
    expect(step(world, input('alice', buyCmd('diskExpansion'))).replies.at(-1)).toMatchObject({ code: 'E_STATE', message: 'Disk is already at its maximum of 512 slots' });
    expect(store.operators.get('alice')).toMatchObject({ diskCapacity: 512, bits: 4_000_000 - 8192 * 2 ** 7 });
  });

  it('a committed intent completes once: a duplicate completion and a store replay change nothing', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', buyCmd('tap', 2)));
    const intent = r.intents[0]!;
    world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
    expect(() => world.completeIntent(intent.id, { ok: true })).toThrow(RangeError);
    expect(await store.applyIntent(intent, { seedId: 'seed0001' })).toEqual({ ok: true });
    expect(op.inventory.tap).toBe(2);
    expect(store.operators.get('alice')).toMatchObject({ bits: 744, inventory: { tap: 2 } });
    expect(store.ledger).toHaveLength(1);
  });

  it('a decompiling daemon is locked: no run, store, evolve, hold, unhold, item or second decompile', () => {
    const world = setup({ ram: [{ ...ownedRecord('pingling', 16, 0, 'alice-d0'), heldItem: 'jumboframe' }, ownedRecord('glitchmite', 20, 1, 'alice-d1')], inventory: { restore: 2, amplifier: 1 } });
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', decompileCmd('alice-d0')));
    expect(r.intents).toHaveLength(1);
    const d = world.daemons.get('alice-d0')!;
    const commands: Command[] = [
      decompileCmd('alice-d0', true),
      { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } },
      { cmd: 'store', actor: self, args: { daemonId: 'alice-d0' } },
      { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId: 'echolet' } },
      { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'amplifier' } },
      { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } },
      { cmd: 'useItem', actor: self, args: { item: 'restore', daemonId: 'alice-d0' } },
    ];
    for (const command of commands) expect(step(world, input('alice', command)).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
    expect(d).toMatchObject({ heldItem: 'jumboframe', active: false, pending: true });
    expect(op.inventory).toEqual({ restore: 2, amplifier: 1 });
    // restoreAll skips it too
    d.hp = 1;
    step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} }));
    for (let i = 0; i < 64; i++) step(world);
    expect(d.hp).toBe(1);
  });

  it('a held item is never duplicated: kept on the daemon until the decompile commits, never both', async () => {
    const world = setup({ ram: [{ ...ownedRecord('pingling', 5, 0, 'alice-d0'), heldItem: 'jumboframe' }] });
    const op = world.operators.get('alice')!;
    const failed = step(world, input('alice', decompileCmd('alice-d0')));
    expect(op.inventory.jumboframe).toBeUndefined();
    world.completeIntent(failed.intents[0]!.id, { ok: false, reason: 'db down' });
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'db down' });
    expect(world.daemons.get('alice-d0')!.heldItem).toBe('jumboframe');
    expect(op.inventory.jumboframe).toBeUndefined();
    const store = await seeded(world);
    const done = await through(world, store, decompileCmd('alice-d0'));
    expect(done.reply).toMatchObject({ ok: true });
    expect(op.inventory.jumboframe).toBe(1);
    expect(world.daemons.has('alice-d0')).toBe(false);
    expect(store.operators.get('alice')!.inventory.jumboframe).toBe(1);
    expect(store.archive.get('alice-d0')).toMatchObject({ heldItem: 'jumboframe' });
    expect([...store.daemons.values()].filter((x) => x.heldItem === 'jumboframe')).toEqual([]);
  });

  it('the last daemon can be decompiled once, and a reload during the decompile keeps it locked', async () => {
    const world = setup({ ram: [ownedRecord('pingling', 5, 0, 'alice-d0')] });
    const store = await seeded(world);
    const r = step(world, input('alice', decompileCmd('alice-d0')));
    // the operator is reloaded from a record taken before the intent committed (e.g. a world hand-off)
    const rec = world.checkpoint('alice');
    expect(rec.inventoryInFlight).toBe(true);
    world.removeOperator('alice');
    world.addOperator(rec);
    expect(world.daemons.get('alice-d0')!.pending).toBe(true);
    expect(step(world, input('alice', decompileCmd('alice-d0'))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    world.completeIntent(r.intents[0]!.id, await store.applyIntent(r.intents[0]!, { seedId: 'seed0001' }));
    const op = world.operators.get('alice')!;
    expect(op.ram).toEqual([]);
    expect(op.inventory).toEqual({ restore: 1, 'frag:packet': 1 });
    expect(store.daemons.size).toBe(0);
    expect(step(world, input('alice', decompileCmd('alice-d0'))).replies.at(-1)).toMatchObject({ code: 'E_STATE', message: 'no daemon alice-d0 in RAM' });
  });

  it('checkpoints leave the inventory to a pending economy intent (and never carry bits)', () => {
    const world = setup({ inventory: { 'frag:packet': 4, 'frag:socket': 4 } });
    expect(world.checkpoint('alice').inventoryInFlight).toBeUndefined();
    const r = step(world, input('alice', craftCmd('tap')));
    expect(world.checkpoint('alice')).toMatchObject({ inventoryInFlight: true, bits: 936 });
    world.completeIntent(r.intents[0]!.id, { ok: true });
    expect(world.checkpoint('alice').inventoryInFlight).toBeUndefined();
    expect(world.checkpoint('alice').inventory).toEqual({ tap: 1 });
  });

  it('travel and economy exclude each other', () => {
    const gate = TEST_SUBNET.gateways[0]!;
    const world = setup({ inventory: { 'frag:packet': 4, 'frag:socket': 4 } });
    const op = world.operators.get('alice')!;
    step(world, input('alice', buyCmd('sniff')));
    op.x = gate.at.x;
    op.y = gate.at.y;
    world.daemons.get('alice-d0')!.level = 20;
    expect(step(world, input('alice', { cmd: 'travel', actor: self, args: { gatewayId: gate.id } })).replies[0]).toMatchObject({ message: 'wait for pending actions' });
    const world2 = setup();
    const op2 = world2.operators.get('alice')!;
    op2.x = gate.at.x;
    op2.y = gate.at.y;
    expect(step(world2, input('alice', { cmd: 'travel', actor: self, args: { gatewayId: gate.id } })).intents).toHaveLength(1);
    op2.x = HOST.x;
    op2.y = HOST.y;
    for (const command of [buyCmd('sniff'), craftCmd('tap'), decompileCmd('alice-d0')]) {
      expect(step(world2, input('alice', command)).replies[0]).toMatchObject({ code: 'E_STATE', message: 'travelling' });
    }
    expect(op2.bits).toBe(1000);
  });
});

// ---- the runtime: ordering against checkpoints, reconnects, leaves ----

class FakeConn implements Conn {
  static n = 0;
  readonly id = `econ-conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** MemoryStore that can hold economy intents and checkpoint writes, and records every checkpoint batch. */
class GatedStore extends MemoryStore {
  readonly batches: OperatorRecord[][] = [];
  private intentGate: ReturnType<typeof gate> | null = null;
  private checkpointGate: ReturnType<typeof gate> | null = null;
  holdIntents() {
    this.intentGate = gate();
  }
  releaseIntents() {
    this.intentGate?.open();
    this.intentGate = null;
  }
  holdCheckpoints() {
    this.checkpointGate = gate();
  }
  releaseCheckpoints() {
    this.checkpointGate?.open();
    this.checkpointGate = null;
  }
  override async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (['buy', 'craft', 'decompile'].includes(intent.kind) && this.intentGate) await this.intentGate.promise;
    return super.applyIntent(intent, ctx);
  }
  override async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    this.batches.push(records.map((r) => ({ ...r, inventory: { ...r.inventory } })));
    if (this.checkpointGate) await this.checkpointGate.promise;
    return super.checkpoint(records);
  }
}

function game(store: MemoryStore, extra: Partial<GameOptions> = {}) {
  const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
  const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false, clock: () => FIXED_CLOCK });
  const g = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4, ...extra });
  return { a, game: g };
}

async function join(g: Game, name: string) {
  const conn = new FakeConn();
  g.connect(conn);
  await g.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
  return conn;
}

let req = 0;
const cmd = (c: Command) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `e${++req}`, ...c } });

/** An operator in the store with a claimed starter, `bits` from the ledger and `inventory`, standing at the host. */
async function shopper(store: MemoryStore, name: string, bits: number, inventory: Record<string, number> = {}) {
  const rec = await store.loadOrCreateOperator(`dev-${name}`, 'test', TEST_SUBNET.spawn);
  Object.assign(store.operators.get(rec.id)!, { name, starterClaimed: true, inventory });
  store.daemons.set(`${name}-d0`, { ...ownedRecord('tracerat', 20, 0, `${name}-d0`), operatorId: rec.id, location: 'RAM' });
  if (bits) await store.grantBits(rec.id, bits, 'admin');
  return rec.id;
}

const tick = (g: Game, n = 1) => {
  for (let i = 0; i < n; i++) g.tick();
};
const settle = () => new Promise((r) => setTimeout(r, 5));
/**
 * Tests that keep an until-known intent failing across `settle()`s must not reach the retry cap: with 1 ms retry delays,
 * 32 attempts take ~35 ms on Linux (1 ms timers) but ~500 ms on Windows (~15 ms timers), so the cap path (reload
 * required) would depend on the platform's timer resolution. The cap itself is tested on its own below.
 */
const UNCAPPED = { unknownRetryLimit: Number.MAX_SAFE_INTEGER } as const;

describe('economy in the runtime', () => {
  it('a checkpoint taken before a purchase cannot rewind it, and one taken while it is pending leaves the inventory alone', async () => {
    const store = new GatedStore();
    const { a, game: g } = game(store, { checkpointEveryTicks: 2 });
    const id = await shopper(store, 'alice', 1000, { sniff: 1 });
    const conn = await join(g, 'alice');
    const op = a.operators.get(id)!;
    // 1. a periodic checkpoint (no tap yet) is held in the store; the buy is queued behind it
    store.holdCheckpoints();
    tick(g, 2);
    await settle();
    const early = store.batches.at(-1)!.find((r) => r.id === id)!;
    expect(early).toMatchObject({ inventory: { sniff: 1 } });
    expect(early.inventoryInFlight).toBeUndefined();
    await g.message(conn, cmd(buyCmd('tap', 2)));
    tick(g);
    await settle();
    expect(store.operators.get(id)!.inventory).toEqual({ sniff: 1 }); // the buy waits behind the held checkpoint
    // 2. hold the buy itself; the next periodic checkpoint is taken while it is pending
    store.holdIntents();
    store.releaseCheckpoints();
    await settle();
    tick(g);
    await settle();
    expect(a.inventoryInFlight(id)).toBe(true);
    expect(store.batches).toHaveLength(1); // the new checkpoint waits on the chain behind the held buy
    store.releaseIntents();
    await g.flush();
    const during = store.batches[1]!.find((r) => r.id === id)!;
    expect(during).toMatchObject({ inventoryInFlight: true, inventory: { sniff: 1 } });
    tick(g);
    expect(op.inventory).toEqual({ sniff: 1, tap: 2 });
    expect(store.operators.get(id)).toMatchObject({ bits: 744, inventory: { sniff: 1, tap: 2 } });
    // 3. a checkpoint after the commit writes the full inventory, still never bits
    op.bits = 5;
    tick(g, 2);
    await g.flush();
    expect(store.batches.at(-1)!.find((r) => r.id === id)!.inventoryInFlight).toBeUndefined();
    expect(store.operators.get(id)).toMatchObject({ bits: 744, inventory: { sniff: 1, tap: 2 } });
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 744 } });
    expect(conn.of('delta').flatMap((m) => m.d.events)).toContainEqual({ e: 'bits', delta: -256, reason: 'shop', balance: 744 });
    await g.shutdown();
  });

  it('a checkpoint taken while a decompile is pending cannot erase its fragments or resurrect the daemon', async () => {
    const store = new GatedStore();
    const { a, game: g } = game(store, { checkpointEveryTicks: 2 });
    const id = await shopper(store, 'dina', 0, { restore: 1 });
    const conn = await join(g, 'dina');
    store.holdIntents();
    await g.message(conn, cmd(decompileCmd('dina-d0')));
    tick(g, 3); // the decompile is persisting; a periodic checkpoint is queued behind it
    store.releaseIntents();
    await g.flush();
    tick(g);
    const written = store.batches.flat().filter((r) => r.id === id);
    expect(written.some((r) => r.inventoryInFlight && r.ram.some((d) => d.id === 'dina-d0'))).toBe(true);
    expect(store.operators.get(id)!.inventory).toEqual({ restore: 1, 'frag:packet': 9, 'frag:signal': 9 });
    expect(store.daemons.has('dina-d0')).toBe(false);
    expect(a.operators.get(id)!.inventory).toEqual({ restore: 1, 'frag:packet': 9, 'frag:signal': 9 });
    await g.shutdown();
    expect(store.operators.get(id)!.inventory).toEqual({ restore: 1, 'frag:packet': 9, 'frag:signal': 9 });
    expect(store.daemons.has('dina-d0')).toBe(false);
  });

  it('no double spend across a reconnect: the session keeps the spent balance, and a leave waits for the purchase', async () => {
    const store = new GatedStore();
    const { a, game: g } = game(store);
    const id = await shopper(store, 'rex', 2048);
    const conn = await join(g, 'rex');
    store.holdIntents();
    await g.message(conn, cmd(buyCmd('dump')));
    tick(g);
    g.disconnect(conn);
    const again = await join(g, 'rex');
    expect(again.of('snapshot')[0]!.d.self.bits).toBe(0);
    await g.message(again, cmd(buyCmd('dump')));
    tick(g);
    expect(again.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'costs 2048 bits, have 0' });
    // the controller goes away; the leave is due but waits for the pending purchase
    g.disconnect(again);
    tick(g, 8);
    expect(g.worldOf(id)).toBe(a);
    store.releaseIntents();
    await g.flush();
    tick(g);
    await g.flush();
    expect(g.worldOf(id)).toBeUndefined();
    expect(store.operators.get(id)).toMatchObject({ bits: 0, inventory: { dump: 1 } });
    expect(store.ledger.filter((l) => l.operatorId === id)).toHaveLength(2);
    // a fresh session loads the committed state and cannot buy again
    const third = await join(g, 'rex');
    expect(third.of('snapshot')[0]!.d.self).toMatchObject({ bits: 0, inventory: { dump: 1 }, diskCapacity: 256 });
    await g.message(third, cmd(buyCmd('dump')));
    tick(g);
    expect(third.of('err').at(-1)!.d).toMatchObject({ message: 'costs 2048 bits, have 0' });
    await g.shutdown();
  });

  it('a purchase the store committed but did not acknowledge is replayed and applied once', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let dropped = 0;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'buy' && dropped++ === 0) throw new Error('connection reset after commit');
      return result;
    };
    const { a, game: g } = game(store);
    const id = await shopper(store, 'una', 1000);
    const conn = await join(g, 'una');
    await g.message(conn, cmd(buyCmd('tap', 3)));
    tick(g);
    await g.flush();
    tick(g);
    expect(dropped).toBe(2);
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 1000 - 384 } });
    expect(a.operators.get(id)).toMatchObject({ bits: 616, inventory: { tap: 3 } });
    expect(store.operators.get(id)).toMatchObject({ bits: 616, inventory: { tap: 3 } });
    expect(store.ledger.filter((l) => l.operatorId === id && l.reason === 'shop')).toHaveLength(1);
    await g.shutdown();
  });

  it('an unknown outcome is retried until the store answers: never refunded, never rewound by a checkpoint', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let healthy = false;
    let lost = 0;
    // Commits, then the acknowledgement is lost, for as long as the store is unhealthy (far beyond the retry schedule).
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'buy' && !healthy) {
        lost++;
        throw new Error('connection reset after commit');
      }
      return result;
    };
    const { a, game: g } = game(store, { checkpointEveryTicks: 1, ...UNCAPPED });
    const id = await shopper(store, 'vic', 1000, { restore: 1 });
    const conn = await join(g, 'vic');
    const checkpoints: OperatorRecord[] = [];
    const write = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(...records.filter((r) => r.id === id).map((r) => ({ ...r })));
      return write(records);
    };
    await g.message(conn, cmd(buyCmd('mirror')));
    for (let i = 0; i < 12; i++) {
      tick(g);
      await settle();
    }
    expect(lost).toBeGreaterThan(4); // past the bounded retries
    expect(a.inventoryInFlight(id)).toBe(true);
    expect(conn.of('err')).toEqual([]);
    expect(a.operators.get(id)).toMatchObject({ bits: 488, inventory: { restore: 1 } });
    expect(checkpoints.length).toBeGreaterThan(4);
    expect(checkpoints.every((r) => r.inventoryInFlight)).toBe(true);
    expect(store.operators.get(id)).toMatchObject({ bits: 488, inventory: { restore: 1, mirror: 1 } });
    healthy = true;
    await g.flush();
    tick(g);
    await g.flush();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 488 } });
    expect(a.operators.get(id)).toMatchObject({ bits: 488, inventory: { restore: 1, mirror: 1 } });
    expect(store.operators.get(id)).toMatchObject({ bits: 488, inventory: { restore: 1, mirror: 1 } });
    expect(store.ledger.filter((l) => l.operatorId === id && l.reason === 'shop')).toHaveLength(1);
    expect(checkpoints.at(-1)!.inventoryInFlight).toBeUndefined();
    await g.shutdown();
    expect(store.operators.get(id)).toMatchObject({ bits: 488, inventory: { restore: 1, mirror: 1 } });
  });

  it('a store that keeps failing before committing: the intent waits, then commits exactly once', async () => {
    const store = new MemoryStore();
    const { a, game: g } = game(store);
    const id = await shopper(store, 'xan', 1000, { 'frag:packet': 4, 'frag:socket': 4 });
    const conn = await join(g, 'xan');
    store.failNext = 9;
    await g.message(conn, cmd(craftCmd('tap')));
    tick(g);
    await g.flush();
    tick(g);
    expect(store.failNext).toBe(0);
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 936, output: { item: 'tap', qty: 1 } } });
    expect(a.operators.get(id)).toMatchObject({ bits: 936, inventory: { tap: 1 } });
    expect(store.operators.get(id)).toMatchObject({ bits: 936, inventory: { tap: 1 } });
    expect(store.ledger.filter((l) => l.operatorId === id && l.reason === 'craft')).toHaveLength(1);
    await g.shutdown();
  });

  it('shutdown with an outcome still unknown abandons the intent pending: the final checkpoint writes neither inventory nor bits', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'decompile') throw new Error('connection reset after commit');
      return result;
    };
    const { a, game: g } = game(store, UNCAPPED);
    const id = await shopper(store, 'yul', 0, { restore: 1 });
    const conn = await join(g, 'yul');
    const checkpoints: OperatorRecord[] = [];
    const write = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(...records.filter((r) => r.id === id).map((r) => ({ ...r })));
      return write(records);
    };
    await g.message(conn, cmd(decompileCmd('yul-d0')));
    tick(g);
    await settle();
    await g.shutdown();
    expect(a.inventoryInFlight(id)).toBe(true);
    expect(conn.of('err').filter((m) => m.d.message === 'persist failed')).toEqual([]);
    expect(checkpoints.at(-1)).toMatchObject({ inventoryInFlight: true, inventory: { restore: 1 } });
    // the store's committed decompile stands: fragments in the inventory, the daemon archived
    expect(store.operators.get(id)!.inventory).toEqual({ restore: 1, 'frag:packet': 9, 'frag:signal': 9 });
    expect(store.daemons.has('yul-d0')).toBe(false);
    expect(store.archive.has('yul-d0')).toBe(true);
  });

  it('a claim whose outcome is unknown holds the leave: a reconnect cannot claim again, and the old claim lands once', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let blocked: string | null = null;
    let healthy = false;
    // The first claim cannot reach the store (outcome unknown to the world) until the store recovers.
    store.applyIntent = async (intent, ctx) => {
      if (intent.kind === 'claimStarter' && (blocked ??= intent.id) === intent.id && !healthy) throw new Error('connection reset');
      return apply(intent, ctx);
    };
    const { a, game: g } = game(store, UNCAPPED);
    const conn = await join(g, 'zed');
    const id = conn.of('authOk')[0]!.d.operatorId;
    await g.message(conn, cmd({ cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName: 'zed' } }));
    tick(g);
    await settle();
    expect(a.inventoryInFlight(id)).toBe(true);
    g.disconnect(conn);
    tick(g, 8); // the leave is due, but waits for the claim
    expect(g.worldOf(id)).toBe(a);
    const again = await join(g, 'zed');
    await g.message(again, cmd({ cmd: 'claimStarter', actor: self, args: { species: 'nullpup', operatorName: 'zed2' } }));
    tick(g);
    expect(again.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'starter already claimed' });
    healthy = true;
    await g.flush();
    tick(g);
    await g.flush();
    const mine = [...store.daemons.values()].filter((d) => d.operatorId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.species).toBe('pingling');
    expect(store.operators.get(id)).toMatchObject({ name: 'zed', starterClaimed: true, inventory: { sniff: 8, restore: 2 } });
    expect(a.operators.get(id)).toMatchObject({ name: 'zed', starterClaimed: true, inventory: { sniff: 8, restore: 2 } });
    await g.shutdown();
    expect(store.operators.get(id)!.inventory).toEqual({ sniff: 8, restore: 2 });
  });

  it('an intent the store throws on deterministically: retries stop at the cap, the operator reloads from the store, others carry on', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let stuck: string | null = null;
    let attempts = 0;
    // A store bug: this one craft always throws (before committing anything).
    store.applyIntent = async (intent, ctx) => {
      if (intent.kind === 'craft' && (stuck ??= intent.id) === intent.id) {
        attempts++;
        throw new Error('store bug');
      }
      return apply(intent, ctx);
    };
    const logs: Array<{ level: string; obj: object; msg?: string }> = [];
    const log = {
      info: () => {},
      warn: (obj: object, msg?: string) => logs.push({ level: 'warn', obj, msg }),
      error: (obj: object, msg?: string) => logs.push({ level: 'error', obj, msg }),
    };
    const { a, game: g } = game(store, { log, checkpointEveryTicks: 1 });
    const ann = await shopper(store, 'ann', 1000, { 'frag:packet': 4, 'frag:socket': 4 });
    const bob = await shopper(store, 'bob', 1000);
    const annConn = await join(g, 'ann');
    const bobConn = await join(g, 'bob');
    const checkpoints: OperatorRecord[] = [];
    const write = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(...records.filter((r) => r.id === ann).map((r) => ({ ...r, inventory: { ...r.inventory } })));
      return write(records);
    };
    await g.message(annConn, cmd(craftCmd('tap')));
    tick(g);
    expect(a.operators.get(ann)).toMatchObject({ bits: 936, inventory: {} }); // costs taken at accept
    for (let i = 0; i < 400 && !annConn.closed; i++) {
      await settle();
      if (i === 2) {
        await g.message(bobConn, cmd(buyCmd('sniff')));
        tick(g);
      }
    }
    expect(attempts).toBe(32);
    await settle();
    expect(attempts).toBe(32); // no more retries
    // never failed, never refunded: the operator is kicked to reload instead
    expect(annConn.of('err')).toEqual([]);
    expect(annConn.of('kick').at(-1)!.d.reason).toBe('reload required');
    expect(annConn.closed).toMatchObject({ reason: 'reload required' });
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(1);
    expect(logs.filter((l) => l.level === 'warn').length).toBeLessThan(12);
    // a reconnect before the old session has left is turned away (transient: the client retries)
    const early = await join(g, 'ann');
    expect(early.closed).toMatchObject({ reason: 'reload required' });
    expect(early.of('snapshot')).toEqual([]);
    // the leave checkpoint leaves the inventory (and bits) to the store
    tick(g);
    await g.flush();
    expect(g.worldOf(ann)).toBeUndefined();
    expect(checkpoints.at(-1)).toMatchObject({ inventoryInFlight: true });
    expect(store.operators.get(ann)).toMatchObject({ bits: 1000, inventory: { 'frag:packet': 4, 'frag:socket': 4 } });
    // the reconnect loads the store's state and works normally
    const back = await join(g, 'ann');
    expect(back.of('snapshot')[0]!.d.self).toMatchObject({ bits: 1000, inventory: { 'frag:packet': 4, 'frag:socket': 4 } });
    expect(a.inventoryInFlight(ann)).toBe(false);
    await g.message(back, cmd(craftCmd('tap')));
    tick(g);
    await g.flush();
    tick(g);
    expect(back.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 936, output: { item: 'tap', qty: 1 } } });
    expect(store.operators.get(ann)).toMatchObject({ bits: 936, inventory: { tap: 1 } });
    // the other operator was never affected
    expect(bobConn.closed).toBeNull();
    expect(bobConn.of('ack').at(-1)!.d).toMatchObject({ result: { bits: 968 } });
    expect(store.operators.get(bob)).toMatchObject({ bits: 968, inventory: { sniff: 1 } });
    await g.shutdown();
  });

  it('bits granted while connected are seen on the next connection, never overwritten by a checkpoint', async () => {
    const store = new MemoryStore();
    const { a, game: g } = game(store, { checkpointEveryTicks: 1 });
    const id = await shopper(store, 'wes', 100);
    await join(g, 'wes');
    await store.grantBits(id, 900, 'admin');
    tick(g, 3);
    await g.flush();
    expect(a.operators.get(id)!.bits).toBe(100);
    expect(store.operators.get(id)!.bits).toBe(1000);
    await g.shutdown();
    expect(store.operators.get(id)!.bits).toBe(1000);
  });
});

describe('bits spent in the api while a shop intent is in flight (SP4 plan 3)', () => {
  /*
   * Ordering argument: the world took the buy's cost at accept and the store will take it at commit; the api's spend
   * commits in the DB and reaches the world as a delta. Deltas commute, so whichever of the two commits first, the
   * world ends at (start - cost - spend) = the DB balance. If the spend leaves too little for the buy, the store refuses
   * it and the world's refund brings it back to (start - spend), again the DB balance. Never setting an absolute balance
   * is what keeps the in-flight cost from being undone or counted twice.
   */
  const push = (operatorId: string, row: { id: string; seq: number; balance: number }, delta: number) => ({
    kind: 'bits', operatorId, ledgerId: row.id, seq: row.seq, delta, reason: 'org', balance: row.balance, origin: 'api',
  });

  it('the spend commits while the buy is pending: the world ends at the DB balance', async () => {
    const store = new GatedStore();
    const bus = new MemoryBus();
    const { a, game: g } = game(store, { bus });
    const id = await shopper(store, 'alice', 1000);
    const conn = await join(g, 'alice');
    const op = a.operators.get(id)!;
    store.holdIntents();
    await g.message(conn, cmd(buyCmd('tap', 2)));
    tick(g);
    await settle();
    expect(op.bits).toBe(744); // the cost is taken at accept
    const spend = await store.grantBits(id, -500, 'org');
    await bus.publish('admin', push(id, spend, -500));
    await bus.publish('admin', push(id, spend, -500)); // a duplicate delivery
    expect(op.bits).toBe(244);
    store.releaseIntents();
    await g.flush();
    tick(g);
    expect(store.operators.get(id)!.bits).toBe(244);
    expect(op.bits).toBe(244);
    // a resync never re-applies the sim's own (shop) rows nor the pushed one
    await g.chat.resync();
    expect(op.bits).toBe(244);
    await g.shutdown();
  });

  it('the spend leaves too little for the pending buy: the store refuses it and the refund lands on the DB balance', async () => {
    const store = new GatedStore();
    const bus = new MemoryBus();
    const { a, game: g } = game(store, { bus });
    const id = await shopper(store, 'bob', 1000);
    const conn = await join(g, 'bob');
    const op = a.operators.get(id)!;
    store.holdIntents();
    await g.message(conn, cmd(buyCmd('tap', 2)));
    tick(g);
    await settle();
    const spend = await store.grantBits(id, -900, 'org');
    await bus.publish('admin', push(id, spend, -900));
    expect(op.bits).toBe(-156); // transiently below zero: the buy has not been answered yet
    store.releaseIntents();
    await g.flush();
    tick(g);
    expect(conn.of('err').at(-1)!.d).toMatchObject({ message: 'not enough bits' });
    expect(store.operators.get(id)!.bits).toBe(100);
    expect(op.bits).toBe(100);
    await g.chat.resync();
    expect(op.bits).toBe(100);
    await g.shutdown();
  });
});
