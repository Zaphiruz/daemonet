import { createPrisma, type PrismaClient } from '@daemonet/db';
import { decompileYield, fragmentId, getSpecies } from '@daemonet/rules';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Intent, OwnedDaemonRecord } from '../src/core/index.js';
import { PrismaStore } from '../src/runtime/prisma-store.js';
import { MemoryStore, type Store } from '../src/runtime/store.js';
import { ownedRecord } from './helpers.js';

const SPAWN = { x: 18.5, y: 16.5 };
const log = { originalOperatorId: 'x', capturedAtTick: 1, subnet: 'lo', tool: 'starter' as const, seedId: 'abcd1234', spawnIndex: null };

function claim(operatorId: string, name: string, daemon: OwnedDaemonRecord, id = `i-claim-${name}`): Intent {
  return { id, kind: 'claimStarter', operatorId, reqId: 'r', name, daemon, inventory: { sniff: 8, restore: 2 }, log: { ...log, originalOperatorId: operatorId } };
}

/** The rules' decompile yield for a daemon (plus its held item). */
function yieldOf(species: string, level: number, heldItem: string | null = null): Record<string, number> {
  const sp = getSpecies(species);
  const out: Record<string, number> = {};
  for (const t of sp.types) out[fragmentId(t)] = decompileYield(sp.stage, level);
  if (heldItem) out[heldItem] = 1;
  return out;
}

const EVOLVED_HISTORY = [{ at: '2026-09-30T00:00:00.000Z', kind: 'evolved' as const, detail: 'echolet -> tracerat at level 16' }];

function evolve(id: string, operatorId: string, daemonId: string): Intent {
  return {
    id, kind: 'evolve', operatorId, reqId: 'r', daemonId, level: 16, from: 'echolet', to: 'tracerat', ivs: [21, 20, 20, 21, 20, 20, 20, 20], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
    clean: false, signature: 0, heldItem: null, moves: ['ping', 'traceroute', 'sigstop', 'synflood'], hp: 40, changes: [{ kind: 'iv', stat: 'hp', from: 20, to: 21 }], history: EVOLVED_HISTORY,
  };
}

function contract(name: string, make: () => Promise<Store>, reset: () => Promise<void>) {
  describe(`${name} contract`, () => {
    let store: Store;
    beforeEach(async () => {
      await reset();
      store = await make();
    });

    it('creates a seed with an 8-hex id', async () => {
      const seed = await store.createSeed('lo');
      expect(seed.id).toMatch(/^[0-9a-f]{8}$/);
      expect(seed.seed).toMatch(/^[0-9a-f]{32}$/);
    });

    it('creates an operator once, at the spawn point, with nothing claimed', async () => {
      const a = await store.loadOrCreateOperator('sub-1', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-1', 'lo', SPAWN);
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ name: null, starterClaimed: false, x: 18.5, y: 16.5, bits: 0, inventory: {}, ram: [], diskSlots: [] });
    });

    it('claims a starter once; a second operator cannot take the same name', async () => {
      const a = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-b', 'lo', SPAWN);
      const d = ownedRecord('pingling', 5, 0, 'abcd1234-d1');
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true });
      const taken = await store.applyIntent(claim(b.id, 'alice', ownedRecord('nullpup', 5, 0, 'abcd1234-d2'), 'i-claim-b'), { seedId: 'abcd1234' });
      expect(taken).toEqual({ ok: false, reason: 'name taken' });
      const reloaded = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      expect(reloaded).toMatchObject({ name: 'alice', starterClaimed: true, inventory: { sniff: 8, restore: 2 } });
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d1']);
    });

    it('persists captures idempotently, to RAM or Disk', async () => {
      const a = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      const intent = (id: string, daemon: OwnedDaemonRecord, location: 'RAM' | 'DISK'): Intent => ({
        id, kind: 'capture', operatorId: a.id, captureId: 'c1', daemon, location, tool: 'sniff', log: { ...log, tool: 'sniff', spawnIndex: 7 },
      });
      const ram = ownedRecord('bitrot', 6, 1, 'abcd1234-d3');
      const disk = ownedRecord('voidlet', 9, 0, 'abcd1234-d4');
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(intent('i-cap-2', disk, 'DISK'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      const reloaded = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d3']);
      expect(reloaded.diskSlots).toEqual([0]);
    });

    it('stores to Disk with the latest state and loads back into a RAM slot', async () => {
      const a = await store.loadOrCreateOperator('sub-d', 'lo', SPAWN);
      const d = ownedRecord('pingling', 5, 0, 'abcd1234-d5');
      await store.applyIntent(claim(a.id, 'dora', d), { seedId: 'abcd1234' });
      const stored = await store.applyIntent(
        { id: 'i-store', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: d.id, diskSlot: 3 },
        { seedId: 'abcd1234', storedDaemon: { ...d, level: 9, xp: 5832 } },
      );
      expect(stored).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-d', 'lo', SPAWN)).diskSlots).toEqual([3]);
      const loaded = await store.applyIntent({ id: 'i-load', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d.id, ramSlot: 2 }, { seedId: 'abcd1234' });
      expect(loaded).toMatchObject({ ok: true, daemon: { id: d.id, level: 9, slot: 2 } });
      const again = await store.applyIntent({ id: 'i-load', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d.id, ramSlot: 2 }, { seedId: 'abcd1234' });
      expect(again).toMatchObject({ ok: true, daemon: { id: d.id } });
      const missing = await store.applyIntent({ id: 'i-load-2', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: 'nope', ramSlot: 3 }, { seedId: 'abcd1234' });
      expect(missing).toEqual({ ok: false, reason: 'not on Disk' });
    });

    it('checkpoints position, inventory and RAM daemon state (never bits)', async () => {
      const a = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      const d = ownedRecord('hashling', 5, 0, 'abcd1234-d6');
      await store.applyIntent(claim(a.id, 'erin', d), { seedId: 'abcd1234' });
      const rec = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, x: 40.25, y: 12.5, bits: 64, inventory: { sniff: 3 }, ram: [{ ...rec.ram[0]!, level: 7, hp: 3, crashed: true }] }]);
      const after = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      expect(after).toMatchObject({ x: 40.25, y: 12.5, bits: 0, inventory: { sniff: 3 } });
      expect(after.ram[0]).toMatchObject({ level: 7, hp: 3, crashed: true });
    });

    it('does not let a stale RAM checkpoint clobber a daemon already stored to Disk', async () => {
      const a = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      const d = ownedRecord('hashling', 5, 0, 'abcd1234-d7');
      await store.applyIntent(claim(a.id, 'finn', d), { seedId: 'abcd1234' });
      const stale = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      await store.applyIntent(
        { id: 'i-store-f', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: d.id, diskSlot: 1 },
        { seedId: 'abcd1234', storedDaemon: { ...d, hp: 11 } },
      );
      await store.checkpoint([{ ...stale, ram: [{ ...stale.ram[0]!, hp: 2, level: 8 }] }]);
      const after = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      expect(after.ram).toEqual([]);
      expect(after.diskSlots).toEqual([1]);
      const back = await store.applyIntent({ id: 'i-load-f', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d.id, ramSlot: 0 }, { seedId: 'abcd1234' });
      expect(back).toMatchObject({ ok: true, daemon: { id: d.id, hp: 11, level: 5 } });
    });

    it('checkpoints IVs, patched, held item, counters and history', async () => {
      const a = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      const d = ownedRecord('echolet', 16, 0, 'abcd1234-d7');
      await store.applyIntent(claim(a.id, 'finn', d), { seedId: 'abcd1234' });
      const rec = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      const uses = rec.ram[0]!.moveTypeUses.map((_, i) => i);
      const history = [{ at: '2026-09-30T00:00:00.000Z', kind: 'patched' as const, detail: 'attack +1 (bitflipper)' }];
      await store.checkpoint([{ ...rec, ram: [{ ...rec.ram[0]!, ivs: [21, 20, 20, 20, 20, 20, 20, 20], patched: true, heldItem: 'jumboframe', moveTypeUses: uses, crashes: 2, history }] }]);
      const after = await store.loadOrCreateOperator('sub-f', 'lo', SPAWN);
      expect(after.ram[0]).toMatchObject({ ivs: [21, 20, 20, 20, 20, 20, 20, 20], patched: true, heldItem: 'jumboframe', moveTypeUses: uses, crashes: 2, history, originalOperatorId: a.id });
    });

    it('records travel (subnet and position) and reloads it', async () => {
      const a = await store.loadOrCreateOperator('sub-t', 'lo', SPAWN);
      expect(a.subnet).toBe('lo');
      const intent: Intent = { id: 'i-travel', kind: 'travel', operatorId: a.id, reqId: 'r', gatewayId: 'lo-lan', from: 'lo', to: 'lan', x: 5.5, y: 5.5 };
      expect(await store.applyIntent(intent, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.loadOrCreateOperator('sub-t', 'lo', SPAWN)).toMatchObject({ subnet: 'lan', x: 5.5, y: 5.5 });
      const rec = await store.loadOrCreateOperator('sub-t', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, subnet: 'dmz', x: 9, y: 9 }]);
      expect(await store.loadOrCreateOperator('sub-t', 'lo', SPAWN)).toMatchObject({ subnet: 'dmz', x: 9, y: 9 });
    });

    it('replays a travel intent without moving the operator again', async () => {
      const a = await store.loadOrCreateOperator('sub-t2', 'lo', SPAWN);
      const intent: Intent = { id: 'i-travel-2', kind: 'travel', operatorId: a.id, reqId: 'r', gatewayId: 'lo-lan', from: 'lo', to: 'lan', x: 5.5, y: 5.5 };
      expect(await store.applyIntent(intent, { seedId: 'abcd1234' })).toEqual({ ok: true });
      const rec = await store.loadOrCreateOperator('sub-t2', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, x: 7, y: 8 }]);
      expect(await store.applyIntent(intent, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.loadOrCreateOperator('sub-t2', 'lo', SPAWN)).toMatchObject({ subnet: 'lan', x: 7, y: 8 });
    });

    it('buys, expands Disk, crafts and decompiles through the ledger, refusing what the operator cannot afford', async () => {
      const a = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'ezra', ownedRecord('tracerat', 20, 0, 'abcd1234-e1')), { seedId: 'abcd1234' });
      const buy = (id: string, itemId: string, qty: number, price: number): Intent => ({ id, kind: 'buy', operatorId: a.id, reqId: 'r', itemId, qty, price });
      expect(await store.applyIntent(buy('i-buy-0', 'sniff', 1, 32), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough bits' });
      await store.grantBits(a.id, 10_000, 'admin');
      expect(await store.applyIntent(buy('i-buy-1', 'sniff', 3, 96), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(buy('i-buy-1', 'sniff', 3, 96), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(buy('i-buy-2', 'diskExpansion', 1, 8192), { seedId: 'abcd1234' })).toEqual({ ok: true });
      let rec = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      expect(rec).toMatchObject({ bits: 10_000 - 96 - 8192, diskCapacity: 288, inventory: { sniff: 11, restore: 2 } });
      const craft: Intent = {
        id: 'i-craft-1', kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'restore', qty: 1, using: 'packet', bits: 16, fragments: { 'frag:packet': 2 }, output: { item: 'restore', qty: 1 },
      };
      expect(await store.applyIntent(craft, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough frag:packet' });
      const decompile: Intent = {
        id: 'i-dec-1', kind: 'decompile', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-e1', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 },
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      };
      expect(await store.applyIntent(decompile, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(decompile, { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent({ ...decompile, id: 'i-dec-2' }, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.applyIntent(craft, { seedId: 'abcd1234' })).toEqual({ ok: true });
      rec = await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN);
      expect(rec.ram).toEqual([]);
      expect(rec).toMatchObject({ bits: 10_000 - 96 - 8192 - 16, inventory: { sniff: 11, restore: 3, 'frag:packet': 7, 'frag:signal': 9 } });
      const ledger = await store.ledgerFor(a.id);
      expect(ledger.map((l) => [l.delta, l.reason])).toEqual([
        [10_000, 'admin'],
        [-96, 'shop'],
        [-8192, 'disk'],
        [-16, 'craft'],
      ]);
      // checkpoints never write bits
      await store.checkpoint([{ ...rec, bits: 1 }]);
      expect((await store.loadOrCreateOperator('sub-e1', 'lo', SPAWN)).bits).toBe(10_000 - 96 - 8192 - 16);
    });

    it('the balance always equals the sum of the ledger, and a replayed intent writes no second row', async () => {
      const a = await store.loadOrCreateOperator('sub-l1', 'lo', SPAWN);
      await store.grantBits(a.id, 1000, 'admin', 'grant-1');
      const buy: Intent = { id: 'i-l-buy', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'tap', qty: 2, price: 256 };
      for (let i = 0; i < 3; i++) expect(await store.applyIntent(buy, { seedId: 'abcd1234' })).toEqual({ ok: true });
      await store.grantBits(a.id, -100, 'admin');
      const rec = await store.loadOrCreateOperator('sub-l1', 'lo', SPAWN);
      const ledger = await store.ledgerFor(a.id);
      expect(ledger).toEqual([
        { operatorId: a.id, delta: 1000, reason: 'admin', ref: 'grant-1', at: expect.any(String) },
        { operatorId: a.id, delta: -256, reason: 'shop', ref: 'i-l-buy', at: expect.any(String) },
        { operatorId: a.id, delta: -100, reason: 'admin', ref: null, at: expect.any(String) },
      ]);
      expect(rec.bits).toBe(ledger.reduce((sum, l) => sum + l.delta, 0));
      expect(rec.inventory).toEqual({ tap: 2 });
      expect((await store.ledgerFor(a.id, 2)).map((l) => l.delta)).toEqual([-256, -100]);
    });

    it('grantBits refuses zero, fractional and overdrawing deltas and unknown operators', async () => {
      const a = await store.loadOrCreateOperator('sub-l2', 'lo', SPAWN);
      await store.grantBits(a.id, 50, 'admin');
      await expect(store.grantBits(a.id, 0, 'admin')).rejects.toThrow();
      await expect(store.grantBits(a.id, 1.5, 'admin')).rejects.toThrow();
      await expect(store.grantBits(a.id, Number.MAX_SAFE_INTEGER + 2, 'admin')).rejects.toThrow();
      await expect(store.grantBits(a.id, -51, 'admin')).rejects.toThrow('not enough bits');
      await expect(store.grantBits('00000000-0000-0000-0000-000000000000', 5, 'admin')).rejects.toThrow();
      expect((await store.loadOrCreateOperator('sub-l2', 'lo', SPAWN)).bits).toBe(50);
      expect(await store.ledgerFor(a.id)).toHaveLength(1);
    });

    it('refuses economy intents that do not match the rules (no bits or items can be minted)', async () => {
      const a = await store.loadOrCreateOperator('sub-l3', 'lo', SPAWN);
      await store.grantBits(a.id, 1_000_000, 'admin');
      const buy = (id: string, itemId: string, qty: number, price: number): Intent => ({ id, kind: 'buy', operatorId: a.id, reqId: 'r', itemId, qty, price });
      const ctx = { seedId: 'abcd1234' };
      expect(await store.applyIntent(buy('i-x1', 'sniff', 1, -32), ctx)).toEqual({ ok: false, reason: 'invalid purchase' });
      expect(await store.applyIntent(buy('i-x2', 'sniff', 0, 0), ctx)).toEqual({ ok: false, reason: 'invalid purchase' });
      expect(await store.applyIntent(buy('i-x3', 'sniff', 1.5, 48), ctx)).toEqual({ ok: false, reason: 'invalid purchase' });
      expect(await store.applyIntent(buy('i-x4', 'sniff', 4, 32), ctx)).toEqual({ ok: false, reason: 'price changed' });
      expect(await store.applyIntent(buy('i-x5', 'jumboframe', 1, 0), ctx)).toEqual({ ok: false, reason: 'not for sale' });
      expect(await store.applyIntent(buy('i-x6', 'constructor', 1, 0), ctx)).toEqual({ ok: false, reason: 'not for sale' });
      expect(await store.applyIntent(buy('i-x7', 'diskExpansion', 2, 8192), ctx)).toEqual({ ok: false, reason: 'price changed' });
      const craft = (id: string, over: Partial<Extract<Intent, { kind: 'craft' }>>): Intent => ({
        id, kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'restore', qty: 1, using: 'packet', bits: 16, fragments: { 'frag:packet': 2 }, output: { item: 'restore', qty: 1 }, ...over,
      });
      expect(await store.applyIntent(craft('i-x8', { output: { item: 'restore', qty: 64 } }), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-x9', { bits: 0 }), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-x10', { fragments: { 'frag:packet': -2 } }), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-x11', { recipeId: 'nope' }), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      const rec = await store.loadOrCreateOperator('sub-l3', 'lo', SPAWN);
      expect(rec).toMatchObject({ bits: 1_000_000, inventory: {}, diskCapacity: 256 });
      expect(await store.ledgerFor(a.id)).toHaveLength(1);
    });

    it('Disk expansions double in price and stop at the cap; checkpoints never write the capacity', async () => {
      const a = await store.loadOrCreateOperator('sub-l4', 'lo', SPAWN);
      await store.grantBits(a.id, 8192 * 2 ** 8, 'admin');
      const ctx = { seedId: 'abcd1234' };
      let price = 8192;
      for (let i = 0; i < 8; i++, price *= 2) {
        expect(await store.applyIntent({ id: `i-d${i}`, kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'diskExpansion', qty: 1, price }, ctx)).toEqual({ ok: true });
      }
      expect(await store.applyIntent({ id: 'i-d8', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'diskExpansion', qty: 1, price }, ctx)).toEqual({
        ok: false,
        reason: 'Disk is already at its maximum',
      });
      const rec = await store.loadOrCreateOperator('sub-l4', 'lo', SPAWN);
      expect(rec).toMatchObject({ diskCapacity: 512, bits: 8192 * 2 ** 8 - 8192 * (2 ** 8 - 1) });
      await store.checkpoint([{ ...rec, diskCapacity: 1024 }]);
      expect((await store.loadOrCreateOperator('sub-l4', 'lo', SPAWN)).diskCapacity).toBe(512);
    });

    it('a checkpoint marked inventoryInFlight leaves the inventory to the intent', async () => {
      const a = await store.loadOrCreateOperator('sub-l5', 'lo', SPAWN);
      await store.grantBits(a.id, 1000, 'admin');
      const before = await store.loadOrCreateOperator('sub-l5', 'lo', SPAWN); // taken while the buy is "pending"
      expect(await store.applyIntent({ id: 'i-f1', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'tap', qty: 1, price: 128 }, { seedId: 'abcd1234' })).toEqual({ ok: true });
      await store.checkpoint([{ ...before, x: 7, inventory: {}, inventoryInFlight: true }]);
      expect(await store.loadOrCreateOperator('sub-l5', 'lo', SPAWN)).toMatchObject({ x: 7, bits: 872, inventory: { tap: 1 } });
      await store.checkpoint([{ ...before, x: 8, inventory: { tap: 1, sniff: 2 } }]);
      expect(await store.loadOrCreateOperator('sub-l5', 'lo', SPAWN)).toMatchObject({ x: 8, bits: 872, inventory: { tap: 1, sniff: 2 } });
    });

    it('an inventoryInFlight checkpoint never writes a held item (it moves only together with the inventory)', async () => {
      const ctx = { seedId: 'abcd1234' };
      // hold during a pending craft: the world moved jumboframe from the inventory onto the daemon
      const a = await store.loadOrCreateOperator('sub-hf1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'hf1', ownedRecord('tracerat', 20, 0, 'abcd1234-n1'), 'i-n-claim1'), ctx);
      await store.grantBits(a.id, 1000, 'admin');
      await store.checkpoint([{ ...(await store.loadOrCreateOperator('sub-hf1', 'lo', SPAWN)), inventory: { jumboframe: 1, 'frag:packet': 4, 'frag:socket': 4 } }]);
      const recA = await store.loadOrCreateOperator('sub-hf1', 'lo', SPAWN);
      const craft: Intent = {
        id: 'i-n-craft', kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'tap', qty: 1, bits: 64, fragments: { 'frag:packet': 4, 'frag:socket': 4 }, output: { item: 'tap', qty: 1 },
      };
      const heldA = { ...recA.ram[0]!, heldItem: 'jumboframe', xp: recA.ram[0]!.xp + 5 };
      await store.checkpoint([{ ...recA, inventory: {}, ram: [heldA], inventoryInFlight: true }]); // taken while the craft is pending
      expect(await store.applyIntent(craft, ctx)).toEqual({ ok: true });
      await store.checkpoint([{ ...recA, inventory: {}, ram: [heldA], inventoryInFlight: true }]); // a stale in-flight record after the commit
      const reA = await store.loadOrCreateOperator('sub-hf1', 'lo', SPAWN);
      expect(reA.inventory).toEqual({ jumboframe: 1, tap: 1 });
      expect(reA.ram[0]).toMatchObject({ heldItem: null, xp: heldA.xp }); // other state is still written; no duplicate
      // unhold during a pending craft: the world moved jumboframe from the daemon into the inventory
      const b = await store.loadOrCreateOperator('sub-hf2', 'lo', SPAWN);
      await store.applyIntent(claim(b.id, 'hf2', { ...ownedRecord('tracerat', 20, 0, 'abcd1234-n2'), heldItem: 'jumboframe' }, 'i-n-claim2'), ctx);
      const recB = await store.loadOrCreateOperator('sub-hf2', 'lo', SPAWN);
      await store.checkpoint([{ ...recB, inventory: { ...recB.inventory, jumboframe: 1 }, ram: [{ ...recB.ram[0]!, heldItem: null }], inventoryInFlight: true }]);
      const reB = await store.loadOrCreateOperator('sub-hf2', 'lo', SPAWN);
      expect(reB.inventory).toEqual({ sniff: 8, restore: 2 });
      expect(reB.ram[0]!.heldItem).toBe('jumboframe'); // no loss
    });

    it('decompile refuses a daemon on Disk, of another operator, or whose species changed, and archives once', async () => {
      const a = await store.loadOrCreateOperator('sub-l6', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-l7', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'lena', ownedRecord('echolet', 16, 0, 'abcd1234-f1')), { seedId: 'abcd1234' });
      const dec = (id: string, operatorId: string, species = 'echolet'): Intent => ({
        id, kind: 'decompile', operatorId, reqId: 'r', daemonId: 'abcd1234-f1', species, fragments: yieldOf('echolet', 16),
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      });
      const ctx = { seedId: 'abcd1234' };
      expect(await store.applyIntent(dec('i-g1', b.id), ctx)).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.applyIntent(dec('i-g2', a.id, 'tracerat'), ctx)).toEqual({ ok: false, reason: 'daemon not found' });
      await store.applyIntent({ id: 'i-g3', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-f1', diskSlot: 0 }, ctx);
      expect(await store.applyIntent(dec('i-g4', a.id), ctx)).toEqual({ ok: false, reason: 'daemon not found' });
      await store.applyIntent({ id: 'i-g5', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-f1', ramSlot: 0 }, ctx);
      expect(await store.applyIntent(dec('i-g6', a.id), ctx)).toEqual({ ok: true });
      expect(await store.applyIntent({ id: 'i-g7', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-f1', ramSlot: 0 }, ctx)).toEqual({ ok: false, reason: 'not on Disk' });
      const rec = await store.loadOrCreateOperator('sub-l6', 'lo', SPAWN);
      expect(rec).toMatchObject({ ram: [], diskSlots: [], inventory: { sniff: 8, restore: 2, ...yieldOf('echolet', 16) } });
      // a stale checkpoint naming the decompiled daemon cannot bring it back
      await store.checkpoint([{ ...rec, ram: [ownedRecord('echolet', 16, 0, 'abcd1234-f1')] }]);
      expect((await store.loadOrCreateOperator('sub-l6', 'lo', SPAWN)).ram).toEqual([]);
    });

    it('validates decompile and craft fragments against the rules, archiving the latest daemon state', async () => {
      const a = await store.loadOrCreateOperator('sub-l8', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'vera', ownedRecord('tracerat', 20, 0, 'abcd1234-f2')), { seedId: 'abcd1234' });
      await store.grantBits(a.id, 1000, 'admin');
      const ctx = { seedId: 'abcd1234' };
      const dec = (id: string, fragments: Record<string, number>): Intent => ({
        id, kind: 'decompile', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-f2', species: 'tracerat', fragments,
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      });
      // inflated, a wrong type, a held item the daemon does not hold
      expect(await store.applyIntent(dec('i-v1', { 'frag:packet': 99, 'frag:signal': 9 }), ctx)).toEqual({ ok: false, reason: 'invalid decompile' });
      expect(await store.applyIntent(dec('i-v2', { 'frag:glitch': 9, 'frag:signal': 9 }), ctx)).toEqual({ ok: false, reason: 'invalid decompile' });
      expect(await store.applyIntent(dec('i-v3', { ...yieldOf('tracerat', 20), jumboframe: 1 }), ctx)).toEqual({ ok: false, reason: 'invalid decompile' });
      // the world's latest state (a level and a held item since the last checkpoint) decides the yield
      const latest = { ...ownedRecord('tracerat', 40, 0, 'abcd1234-f2'), heldItem: 'jumboframe', history: [{ at: '2026-09-30T00:00:00.000Z', kind: 'patched' as const, detail: 'x' }] };
      expect(await store.applyIntent(dec('i-v4', yieldOf('tracerat', 20)), { ...ctx, storedDaemon: latest })).toEqual({ ok: false, reason: 'invalid decompile' });
      expect(await store.applyIntent(dec('i-v5', yieldOf('tracerat', 40, 'jumboframe')), { ...ctx, storedDaemon: { ...latest, level: 19 } })).toEqual({
        ok: false,
        reason: 'invalid decompile',
      });
      expect(await store.applyIntent(dec('i-v6', yieldOf('tracerat', 40, 'jumboframe')), { ...ctx, storedDaemon: latest })).toEqual({ ok: true });
      const rec = await store.loadOrCreateOperator('sub-l8', 'lo', SPAWN);
      // The stored daemon holds nothing, so the store adds no held item: the world's hold since the last checkpoint took
      // the item from an inventory the store has not seen yet (see 'decompile returns the held item the store knows of').
      expect(rec.inventory).toEqual({ sniff: 8, restore: 2, ...yieldOf('tracerat', 40) });
      if (store instanceof MemoryStore) {
        expect(store.archive.get('abcd1234-f2')).toMatchObject({ level: 40, heldItem: 'jumboframe' });
        expect(store.archive.get('abcd1234-f2')!.history.map((h) => h.kind)).toEqual(['patched', 'decompiled']);
      }
      // craft: fragments must be the recipe's for the chosen type
      const craft = (id: string, fragments: Record<string, number>, using?: 'packet' | 'signal'): Intent => ({
        id, kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'restore', qty: 1, ...(using ? { using } : {}), bits: 16, fragments, output: { item: 'restore', qty: 1 },
      });
      expect(await store.applyIntent(craft('i-c1', { 'frag:packet': 1 }, 'packet'), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-c2', { 'frag:packet': 2 }, 'signal'), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-c3', { 'frag:packet': 2 }), ctx)).toEqual({ ok: false, reason: 'invalid recipe' });
      expect(await store.applyIntent(craft('i-c4', { 'frag:signal': 2 }, 'signal'), ctx)).toEqual({ ok: true });
    });

    it('decompile returns the held item the store knows of, whatever the world did since the last checkpoint', async () => {
      const ctx = { seedId: 'abcd1234' };
      const dec = (id: string, operatorId: string, daemonId: string, fragments: Record<string, number>): Intent => ({
        id, kind: 'decompile', operatorId, reqId: 'r', daemonId, species: 'tracerat', fragments,
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      });
      // 1. held after the last checkpoint: the store still has the item in the inventory and nothing on the daemon
      const a = await store.loadOrCreateOperator('sub-h1', 'lo', SPAWN);
      const da = ownedRecord('tracerat', 20, 0, 'abcd1234-m1');
      await store.applyIntent(claim(a.id, 'hal', da, 'i-m-claim1'), ctx);
      await store.checkpoint([{ ...(await store.loadOrCreateOperator('sub-h1', 'lo', SPAWN)), inventory: { sniff: 8, restore: 2, jumboframe: 1 } }]);
      const held = { ...da, heldItem: 'jumboframe' };
      expect(await store.applyIntent(dec('i-m-dec1', a.id, 'abcd1234-m1', yieldOf('tracerat', 20, 'jumboframe')), { ...ctx, storedDaemon: held })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-h1', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2, jumboframe: 1, ...yieldOf('tracerat', 20) });
      // 2. unheld after the last checkpoint: the store has the item on the daemon and not in the inventory
      const b = await store.loadOrCreateOperator('sub-h2', 'lo', SPAWN);
      const db = { ...ownedRecord('tracerat', 20, 0, 'abcd1234-m2'), heldItem: 'jumboframe' };
      await store.applyIntent(claim(b.id, 'ida', db, 'i-m-claim2'), ctx);
      const unheld = { ...db, heldItem: null };
      expect(await store.applyIntent(dec('i-m-dec2', b.id, 'abcd1234-m2', yieldOf('tracerat', 20)), { ...ctx, storedDaemon: unheld })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-h2', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2, jumboframe: 1, ...yieldOf('tracerat', 20) });
      // a held item neither side knows of is still refused
      const c = await store.loadOrCreateOperator('sub-h3', 'lo', SPAWN);
      const dc = ownedRecord('tracerat', 20, 0, 'abcd1234-m3');
      await store.applyIntent(claim(c.id, 'ivo', dc, 'i-m-claim3'), ctx);
      expect(await store.applyIntent(dec('i-m-dec3', c.id, 'abcd1234-m3', yieldOf('tracerat', 20, 'amplifier')), { ...ctx, storedDaemon: { ...dc, heldItem: 'jumboframe' } })).toEqual({
        ok: false,
        reason: 'invalid decompile',
      });
    });

    it('a capture or a second starter into an occupied slot is a domain failure, not an error', async () => {
      const a = await store.loadOrCreateOperator('sub-s1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'sly', ownedRecord('pingling', 5, 0, 'abcd1234-h1')), { seedId: 'abcd1234' });
      const capture: Intent = {
        id: 'i-s-cap', kind: 'capture', operatorId: a.id, captureId: 'c1', daemon: ownedRecord('bitrot', 6, 0, 'abcd1234-h2'), location: 'RAM', tool: 'sniff',
        log: { ...log, tool: 'sniff', spawnIndex: 1 },
      };
      expect(await store.applyIntent(capture, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'slot taken' });
      expect(await store.applyIntent(claim(a.id, 'sly', ownedRecord('pingling', 5, 0, 'abcd1234-h3'), 'i-s-claim2'), { seedId: 'abcd1234' })).toEqual({
        ok: false,
        reason: 'starter already claimed',
      });
      expect((await store.loadOrCreateOperator('sub-s1', 'lo', SPAWN)).ram.map((d) => d.id)).toEqual(['abcd1234-h1']);
    });

    it('a second claim is refused once a starter is claimed, even with the starter slot free: no second starter, no inventory overwrite', async () => {
      const a = await store.loadOrCreateOperator('sub-s2', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      expect(await store.applyIntent(claim(a.id, 'sol', ownedRecord('pingling', 5, 0, 'abcd1234-k1'), 'i-k-claim1'), ctx)).toEqual({ ok: true });
      // the starter goes to Disk (its RAM slot is free again) and the inventory moves on
      expect(await store.applyIntent({ id: 'i-k-store', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-k1', diskSlot: 0 }, ctx)).toEqual({ ok: true });
      const rec = await store.loadOrCreateOperator('sub-s2', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, inventory: { tap: 3 } }]);
      // a stale claim (e.g. a retry of an earlier one whose outcome was unknown) arrives now
      expect(await store.applyIntent(claim(a.id, 'sol2', ownedRecord('nullpup', 5, 0, 'abcd1234-k2'), 'i-k-claim2'), ctx)).toEqual({ ok: false, reason: 'starter already claimed' });
      const after = await store.loadOrCreateOperator('sub-s2', 'lo', SPAWN);
      expect(after).toMatchObject({ name: 'sol', starterClaimed: true, inventory: { tap: 3 }, ram: [], diskSlots: [0] });
    });

    it('applies evolve intents idempotently and records the first discovery of each form', async () => {
      const a = await store.loadOrCreateOperator('sub-g', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-h', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'gail', ownedRecord('echolet', 16, 0, 'abcd1234-d8')), { seedId: 'abcd1234' });
      await store.applyIntent(claim(b.id, 'hugo', ownedRecord('echolet', 16, 0, 'abcd1234-d9')), { seedId: 'abcd1234' });
      const history = EVOLVED_HISTORY;
      expect(await store.listDiscoveries()).toEqual([]);
      expect(await store.applyIntent(evolve('i-evo-1', a.id, 'abcd1234-d8'), { seedId: 'abcd1234' })).toEqual({ ok: true, discovered: true });
      expect(await store.applyIntent(evolve('i-evo-1', a.id, 'abcd1234-d8'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(evolve('i-evo-2', b.id, 'abcd1234-d9'), { seedId: 'abcd1234' })).toEqual({ ok: true, discovered: false });
      expect(await store.applyIntent(evolve('i-evo-3', b.id, 'abcd1234-d9'), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.listDiscoveries()).toEqual(['tracerat']);
      const after = await store.loadOrCreateOperator('sub-g', 'lo', SPAWN);
      expect(after.ram[0]).toMatchObject({ species: 'tracerat', ivs: [21, 20, 20, 21, 20, 20, 20, 20], hp: 40, moves: ['ping', 'traceroute', 'sigstop', 'synflood'], history });
    });

    it("refuses an evolve for another operator's daemon or a daemon on Disk", async () => {
      const a = await store.loadOrCreateOperator('sub-j', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-k', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'jade', ownedRecord('echolet', 16, 0, 'abcd1234-d11')), { seedId: 'abcd1234' });
      expect(await store.applyIntent(evolve('i-evo-b', b.id, 'abcd1234-d11'), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      await store.applyIntent({ id: 'i-store-j', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-d11', diskSlot: 0 }, { seedId: 'abcd1234' });
      expect(await store.applyIntent(evolve('i-evo-j', a.id, 'abcd1234-d11'), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'daemon not found' });
      expect(await store.listDiscoveries()).toEqual([]);
    });

    it('a checkpoint taken before an evolve committed does not roll the evolved daemon back', async () => {
      const a = await store.loadOrCreateOperator('sub-i', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'iris', ownedRecord('echolet', 16, 0, 'abcd1234-d10')), { seedId: 'abcd1234' });
      const stale = await store.loadOrCreateOperator('sub-i', 'lo', SPAWN);
      await store.applyIntent(evolve('i-evo-i', a.id, 'abcd1234-d10'), { seedId: 'abcd1234' });
      await store.checkpoint([{ ...stale, x: 3.5, ram: [{ ...stale.ram[0]!, hp: 1, history: [] }] }]);
      const after = await store.loadOrCreateOperator('sub-i', 'lo', SPAWN);
      expect(after.x).toBe(3.5);
      expect(after.ram[0]).toMatchObject({ species: 'tracerat', ivs: [21, 20, 20, 21, 20, 20, 20, 20], hp: 40, moves: ['ping', 'traceroute', 'sigstop', 'synflood'], history: EVOLVED_HISTORY });
    });
  });
}

contract('MemoryStore', async () => new MemoryStore(), async () => {});

describe('PrismaStore.loadOrCreateOperator unique races', () => {
  const uniqueViolation = () => Object.assign(new Error('Unique constraint failed on the fields: (`sub`)'), { code: 'P2002' });
  const row = { id: 'op-1', sub: 's', name: null, starterClaimed: false, x: 1, y: 2, bits: 0n, inventory: {}, daemons: [] };
  const storeWith = (upsert: () => Promise<unknown>) => new PrismaStore({ operator: { upsert } } as unknown as PrismaClient);

  it('retries once when a simultaneous first login for the same sub wins the insert', async () => {
    let calls = 0;
    const store = storeWith(async () => {
      if (++calls === 1) throw uniqueViolation();
      return row;
    });
    await expect(store.loadOrCreateOperator('s', 'lo', SPAWN)).resolves.toMatchObject({ id: 'op-1', x: 1, y: 2 });
    expect(calls).toBe(2);
  });

  it('does not retry more than once', async () => {
    let calls = 0;
    const store = storeWith(async () => {
      calls++;
      throw uniqueViolation();
    });
    await expect(store.loadOrCreateOperator('s', 'lo', SPAWN)).rejects.toMatchObject({ code: 'P2002' });
    expect(calls).toBe(2);
  });
});

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;
describe.skipIf(!url)('PrismaStore (needs DATABASE_URL)', () => {
  afterAll(async () => prisma?.$disconnect());
  contract(
    'PrismaStore',
    async () => new PrismaStore(prisma!),
    async () => {
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    },
  );

  it('treats a concurrent duplicate of the same claim as applied, not as a name clash', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race', 'lo', SPAWN);
    const d = ownedRecord('pingling', 5, 0, 'abcd1234-d8');
    const results = await Promise.all([
      store.applyIntent(claim(a.id, 'rae', d), { seedId: 'abcd1234' }),
      store.applyIntent(claim(a.id, 'rae', d), { seedId: 'abcd1234' }),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await prisma!.daemon.count({ where: { operatorId: a.id } })).toBe(1);
  });

  it('concurrent first evolutions into one form: both apply, exactly one is the discoverer', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-ra', 'lo', SPAWN);
    const b = await store.loadOrCreateOperator('sub-rb', 'lo', SPAWN);
    await store.applyIntent(claim(a.id, 'ria', ownedRecord('echolet', 16, 0, 'abcd1234-e1')), { seedId: 'abcd1234' });
    await store.applyIntent(claim(b.id, 'rib', ownedRecord('echolet', 16, 0, 'abcd1234-e2')), { seedId: 'abcd1234' });
    const results = await Promise.all([
      store.applyIntent(evolve('i-race-a', a.id, 'abcd1234-e1'), { seedId: 'abcd1234' }),
      store.applyIntent(evolve('i-race-b', b.id, 'abcd1234-e2'), { seedId: 'abcd1234' }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.discovered)).toHaveLength(1);
    expect(await prisma!.discovery.count()).toBe(1);
    expect(await prisma!.daemon.count({ where: { species: 'tracerat' } })).toBe(2);
  });

  it('a concurrent duplicate of one evolve intent applies it once', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-rc', 'lo', SPAWN);
    await store.applyIntent(claim(a.id, 'ric', ownedRecord('echolet', 16, 0, 'abcd1234-e3')), { seedId: 'abcd1234' });
    const results = await Promise.all([0, 1].map(() => store.applyIntent(evolve('i-dup', a.id, 'abcd1234-e3'), { seedId: 'abcd1234' })));
    expect(results.every((r) => r.ok)).toBe(true);
    const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: 'abcd1234-e3' } });
    expect(row.history).toEqual(EVOLVED_HISTORY);
  });

  it('concurrent purchases cannot overdraw: the operator row lock serializes the balance check', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race-buy', 'lo', SPAWN);
    await store.grantBits(a.id, 2048 * 3, 'admin');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.applyIntent({ id: `i-rb-${i}`, kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'dump', qty: 1, price: 2048 }, { seedId: 'abcd1234' })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 3 }, () => ({ ok: false, reason: 'not enough bits' })));
    const rec = await store.loadOrCreateOperator('sub-race-buy', 'lo', SPAWN);
    expect(rec).toMatchObject({ bits: 0, inventory: { dump: 3 } });
    expect(await prisma!.bitsLedger.count({ where: { operatorId: a.id } })).toBe(4);
  });

  it('a concurrent duplicate of one buy applies it (and its ledger row) once', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race-dup', 'lo', SPAWN);
    await store.grantBits(a.id, 1000, 'admin');
    const buy: Intent = { id: 'i-dup-buy', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'tap', qty: 1, price: 128 };
    const results = await Promise.all([0, 1, 2].map(() => store.applyIntent(buy, { seedId: 'abcd1234' })));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(await store.loadOrCreateOperator('sub-race-dup', 'lo', SPAWN)).toMatchObject({ bits: 872, inventory: { tap: 1 } });
    expect(await prisma!.bitsLedger.count({ where: { operatorId: a.id } })).toBe(2);
  });

  it('two decompiles of one daemon: one archives it, the other finds nothing (no duplicate fragments)', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race-dec', 'lo', SPAWN);
    await store.applyIntent(claim(a.id, 'rdec', { ...ownedRecord('pingling', 5, 0, 'abcd1234-e5'), heldItem: 'jumboframe' }), { seedId: 'abcd1234' });
    const dec = (id: string): Intent => ({
      id, kind: 'decompile', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-e5', species: 'pingling', fragments: { 'frag:packet': 1, jumboframe: 1 },
      history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
    });
    const results = await Promise.all([store.applyIntent(dec('i-rd-1'), { seedId: 'abcd1234' }), store.applyIntent(dec('i-rd-2'), { seedId: 'abcd1234' })]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ ok: false, reason: 'daemon not found' });
    expect(await store.loadOrCreateOperator('sub-race-dec', 'lo', SPAWN)).toMatchObject({ ram: [], inventory: { sniff: 8, restore: 2, 'frag:packet': 1, jumboframe: 1 } });
    const archived = await prisma!.daemonArchive.findUniqueOrThrow({ where: { id: 'abcd1234-e5' } });
    expect(archived).toMatchObject({ operatorId: a.id, species: 'pingling', heldItem: 'jumboframe', reason: 'decompiled', captureTool: 'starter', spawnSeedId: 'abcd1234' });
    expect((archived.history as Array<{ kind: string }>).at(-1)).toMatchObject({ kind: 'decompiled' });
  });

  it('simultaneous first logins for one sub all get the same operator', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const recs = await Promise.all(Array.from({ length: 8 }, () => store.loadOrCreateOperator('sub-first', 'lo', SPAWN)));
    expect(new Set(recs.map((r) => r.id)).size).toBe(1);
    expect(await prisma!.operator.count({ where: { sub: 'sub-first' } })).toBe(1);
  });
});
