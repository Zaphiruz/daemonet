import { createPrisma, type PrismaClient } from '@daemonet/db';
import { KERNEL_DAEMONS, TICKETS_PER_DAY, dayKey, decompileYield, fragmentId, getSpecies, ticketBoard } from '@daemonet/rules';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DISK_SLOT_TAKEN, incidentParticipants, incidentRewardId, type Intent, type OwnedDaemonRecord } from '../src/core/index.js';
import { PrismaStore } from '../src/runtime/prisma-store.js';
import { DEPOSIT_NOT_SAVED, MemoryStore, SIM_INTENT_LEDGER_REASONS, SIM_LEDGER_REASONS, type LiveOperatorState, type Store } from '../src/runtime/store.js';
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

/** A real accept of today's (UTC) `lo` board entry `index` (the stores check the day against their clock). */
function acceptLo(operatorId: string, index: number, id = `i-acc-${index}`, ticketId = `abcd1234-t${index}`, day = dayKey(new Date().toISOString())): Extract<Intent, { kind: 'acceptTicket' }> {
  const def = ticketBoard('lo', day)[index]!;
  return { id, kind: 'acceptTicket', operatorId, reqId: 'r', ticketId, day, subnet: 'lo', index, ticketKind: def.kind, params: def.params, target: def.target, reward: def.reward };
}

type RewardIntent = Extract<Intent, { kind: 'incidentReward' }>;

/** The payout intents of a cleared Incident with this damage per operator, as the world raises them (rewarded only). */
function incidentRewards(incidentId: string, damage: Record<string, number>): RewardIntent[] {
  const participants = incidentParticipants(new Map(Object.entries(damage))).map((p) => ({ ...p, name: null }));
  return participants.filter((p) => p.reward > 0).map((p) => ({
    id: incidentRewardId(incidentId, p.operatorId), kind: 'incidentReward', operatorId: p.operatorId, incidentId, n: 7, species: KERNEL_DAEMONS[0]!,
    openedAt: '2026-10-01T04:00:00.000Z', endsAt: '2026-10-01T04:20:00.000Z', reward: p.reward, damage: p.damage, share: p.share, participants: participants.map((x) => ({ ...x })),
  }));
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

    it('reads the stored mutes of existing operators for a chat resync', async () => {
      const a = await store.loadOrCreateOperator('sub-m1', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-m2', 'lo', SPAWN);
      const until = '2030-01-01T00:00:00.000Z';
      await store.setMute(a.id, until);
      const got = await store.mutedUntil([a.id, b.id, '00000000-0000-4000-8000-000000000000']);
      expect([...got.entries()].sort()).toEqual([[a.id, until], [b.id, null]].sort());
      expect((await store.mutedUntil([])).size).toBe(0);
    });

    it('claims a starter once; a second operator cannot take the same name', async () => {
      const a = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-b', 'lo', SPAWN);
      const d = ownedRecord('pingling', 5, 0, 'abcd1234-d1');
      // a claim adds a Codex research point for the starter's line and reports the total (also on a replay)
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 1 });
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 1 });
      const taken = await store.applyIntent(claim(b.id, 'alice', ownedRecord('nullpup', 5, 0, 'abcd1234-d2'), 'i-claim-b'), { seedId: 'abcd1234' });
      expect(taken).toEqual({ ok: false, reason: 'name taken' });
      const reloaded = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      expect(reloaded).toMatchObject({ name: 'alice', starterClaimed: true, inventory: { sniff: 8, restore: 2 } });
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d1']);
      expect(reloaded.research).toEqual({ '5': 1 });
    });

    it('persists captures idempotently, to RAM or Disk', async () => {
      const a = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      const intent = (id: string, daemon: OwnedDaemonRecord, location: 'RAM' | 'DISK'): Intent => ({
        id, kind: 'capture', operatorId: a.id, captureId: 'c1', daemon, location, tool: 'sniff', log: { ...log, tool: 'sniff', spawnIndex: 7 },
      });
      const ram = ownedRecord('bitrot', 6, 1, 'abcd1234-d3');
      const disk = ownedRecord('voidlet', 9, 0, 'abcd1234-d4');
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 1 });
      // a replay reports the line's total without adding a second point
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 1 });
      expect(await store.applyIntent(intent('i-cap-2', disk, 'DISK'), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 1 });
      expect(await store.applyIntent(intent('i-cap-3', ownedRecord('rotgrub', 16, 2, 'abcd1234-d5'), 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 2 });
      const reloaded = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d3', 'abcd1234-d5']);
      expect(reloaded.diskSlots).toEqual([0]);
      expect(reloaded.research).toEqual({ '37': 2, [String(getSpecies('voidlet').line)]: 1 });
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

    it("grantBits refuses the sim's own ledger reasons (a resync would never apply such a row)", async () => {
      const a = await store.loadOrCreateOperator('sub-l2r', 'lo', SPAWN);
      await store.grantBits(a.id, 50, 'admin');
      for (const reason of SIM_LEDGER_REASONS) {
        await expect(store.grantBits(a.id, 5, reason)).rejects.toThrow(RangeError);
        await expect(store.grantBits(a.id, -5, reason)).rejects.toThrow(RangeError);
      }
      expect((await store.loadOrCreateOperator('sub-l2r', 'lo', SPAWN)).bits).toBe(50);
      expect(await store.ledgerFor(a.id)).toHaveLength(1);
    });

    it('every ledger row a store intent writes carries a reason listed for its kind in SIM_INTENT_LEDGER_REASONS', async () => {
      const a = await store.loadOrCreateOperator('sub-reasons', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      await store.applyIntent(claim(a.id, 'rory', ownedRecord('tracerat', 20, 0, 'abcd1234-rs1')), ctx);
      await store.grantBits(a.id, 100_000, 'admin');
      const seen = new Map<string, Set<string>>();
      const run = async (intent: Intent) => {
        const before = (await store.ledgerFor(a.id, 1000)).length;
        expect(await store.applyIntent(intent, ctx)).toMatchObject({ ok: true });
        const rows = (await store.ledgerFor(a.id, 1000)).slice(before);
        const reasons = seen.get(intent.kind) ?? new Set<string>();
        for (const r of rows) reasons.add(r.reason);
        seen.set(intent.kind, reasons);
      };
      await run({ id: 'i-rs-buy', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'sniff', qty: 1, price: 32 });
      await run({ id: 'i-rs-disk', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'diskExpansion', qty: 1, price: 8192 });
      await run({
        id: 'i-rs-dec', kind: 'decompile', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-rs1', species: 'tracerat', fragments: { 'frag:packet': 9, 'frag:signal': 9 },
        history: { at: '2026-09-30T00:00:00.000Z', kind: 'decompiled', detail: 'test' },
      });
      await run({ id: 'i-rs-craft', kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'restore', qty: 1, using: 'packet', bits: 16, fragments: { 'frag:packet': 2 }, output: { item: 'restore', qty: 1 } });
      const t = acceptLo(a.id, 0, 'i-rs-acc', 'abcd1234-rs-t0');
      await run(t);
      await run({ id: 'i-rs-done', kind: 'completeTicket', operatorId: a.id, ticketId: t.ticketId, reward: t.reward });
      await run(incidentRewards('abcd1234-inc-rs', { [a.id]: 100 })[0]!);
      // vault moves write no ledger rows (items only)
      await run({ id: 'i-rs-dep', kind: 'vault', operatorId: a.id, reqId: 'r', item: 'sniff', qty: 2 });
      await run({ id: 'i-rs-wd', kind: 'vault', operatorId: a.id, reqId: 'r', item: 'sniff', qty: -2 });
      expect(seen.get('vault')!.size).toBe(0);
      const writers = Object.fromEntries([...seen].filter(([, r]) => r.size > 0).map(([kind, r]) => [kind, [...r].sort()]));
      // Every kind listed in the map was exercised here (a new kind must add a scenario), and wrote only its listed reasons.
      expect(writers).toEqual(Object.fromEntries(Object.entries(SIM_INTENT_LEDGER_REASONS).map(([kind, r]) => [kind, [...r].sort()])));
      for (const reasons of Object.values(writers)) for (const r of reasons) expect(SIM_LEDGER_REASONS.has(r)).toBe(true);
    });

    it('pays each Incident contributor exactly once, re-derived from the rules, and records the CLEARED row with its participants', async () => {
      const a = await store.loadOrCreateOperator('sub-inc-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-inc-b', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      await store.recordIncident({ id: 'abcd1234-inc1', n: 7, species: KERNEL_DAEMONS[0]!, endsAt: '2026-10-01T04:20:00.000Z', outcome: 'OPEN', participants: [] });
      const [ra, rb] = incidentRewards('abcd1234-inc1', { [a.id]: 7500, [b.id]: 2500 });
      expect(ra).toMatchObject({ operatorId: a.id, reward: 6144 });
      // a forged amount, someone else's entry, or a list the rules do not derive are refused before anything is written
      expect(await store.applyIntent({ ...ra!, reward: 8192 }, ctx)).toEqual({ ok: false, reason: 'payouts do not match the rules' });
      expect(await store.applyIntent({ ...ra!, participants: ra!.participants.map((p) => ({ ...p, reward: p.reward * 2 })) }, ctx)).toEqual({ ok: false, reason: 'payouts do not match the rules' });
      expect(await store.applyIntent({ ...ra!, operatorId: b.id }, ctx)).toEqual({ ok: false, reason: 'invalid payout' });
      expect(await store.applyIntent({ ...ra!, id: 'another-id' }, ctx)).toEqual({ ok: false, reason: 'invalid payout' });
      const paid = await store.applyIntent(ra!, ctx);
      expect(paid).toEqual({ ok: true, ledgerSeq: expect.any(Number) });
      // a replay (retry, reconnect, restart) answers from the marker with the same row and pays nothing more
      expect(await store.applyIntent(ra!, ctx)).toEqual(paid);
      expect(await store.applyIntent(rb!, ctx)).toMatchObject({ ok: true });
      expect((await store.loadOrCreateOperator('sub-inc-a', 'lo', SPAWN)).bits).toBe(6144);
      expect((await store.loadOrCreateOperator('sub-inc-b', 'lo', SPAWN)).bits).toBe(2048);
      expect((await store.ledgerFor(a.id)).map((l) => [l.delta, l.reason, l.ref])).toEqual([[6144, 'incident', 'abcd1234-inc1']]);
      // the row is CLEARED with its participants; a late OPEN / EXPIRED record never reopens or overwrites it
      await store.recordIncident({ id: 'abcd1234-inc1', n: 7, species: KERNEL_DAEMONS[0]!, endsAt: '2026-10-01T04:20:00.000Z', outcome: 'EXPIRED', participants: [] });
      // another payout list for the same Incident (a world bug) cannot pay a third operator
      const c = await store.loadOrCreateOperator('sub-inc-c', 'lo', SPAWN);
      const [rc2] = incidentRewards('abcd1234-inc1', { [c.id]: 5000 });
      expect(await store.applyIntent(rc2!, ctx)).toEqual({ ok: false, reason: 'payouts do not match the Incident' });
      // an expired Incident pays nobody
      await store.recordIncident({ id: 'abcd1234-inc2', n: 8, species: KERNEL_DAEMONS[1]!, endsAt: '2026-10-01T08:20:00.000Z', outcome: 'EXPIRED', participants: [] });
      expect(await store.applyIntent(incidentRewards('abcd1234-inc2', { [c.id]: 10 })[0]!, ctx)).toEqual({ ok: false, reason: 'the Incident expired' });
      expect((await store.loadOrCreateOperator('sub-inc-c', 'lo', SPAWN)).bits).toBe(0);
    });

    it('a contributor under 1% is recorded but not paid; everyone else is paid from the full list', async () => {
      const a = await store.loadOrCreateOperator('sub-min-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-min-b', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      const rewards = incidentRewards('abcd1234-incM', { [a.id]: 9950, [b.id]: 50 });
      expect(rewards.map((r) => [r.operatorId, r.reward])).toEqual([[a.id, 8151]]);
      expect(rewards[0]!.participants.map((p) => [p.operatorId, p.reward])).toEqual([[a.id, 8151], [b.id, 0]]);
      expect(await store.applyIntent(rewards[0]!, ctx)).toMatchObject({ ok: true });
      // a forged payout of the sub-1% entry is refused
      const forged = { ...rewards[0]!, id: incidentRewardId('abcd1234-incM', b.id), operatorId: b.id, reward: 64, damage: 50 };
      expect(await store.applyIntent(forged, ctx)).toEqual({ ok: false, reason: 'payouts do not match the rules' });
      expect((await store.loadOrCreateOperator('sub-min-a', 'lo', SPAWN)).bits).toBe(8151);
      expect((await store.loadOrCreateOperator('sub-min-b', 'lo', SPAWN)).bits).toBe(0);
      // nothing is owed to the sub-1% contributor at boot
      expect(await store.recoverIncidents()).toEqual([]);
    });

    it('a payout marked refused is not raised again by boot recovery', async () => {
      const a = await store.loadOrCreateOperator('sub-ref-a', 'lo', SPAWN);
      const [ra] = incidentRewards('abcd1234-incR', { [a.id]: 10 });
      await store.recordIncident({ id: 'abcd1234-incR', n: ra!.n, species: ra!.species, endsAt: ra!.endsAt, outcome: 'CLEARED', participants: ra!.participants });
      expect(await store.recoverIncidents()).toEqual([ra]);
      await store.markIncidentPayoutRefused('abcd1234-incR', a.id);
      await store.markIncidentPayoutRefused('abcd1234-nope', a.id);
      expect(await store.recoverIncidents()).toEqual([]);
    });

    it('a payout that creates the Incident row records when the Incident opened (not when it was paid)', async () => {
      const a = await store.loadOrCreateOperator('sub-open-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-open-b', 'lo', SPAWN);
      const openedAt = '2026-10-01T04:00:07.000Z';
      const [ra, rb] = incidentRewards('abcd1234-incO', { [a.id]: 600, [b.id]: 400 }).map((r) => ({ ...r, openedAt }));
      // no record landed: a's payout creates the row; b's is interrupted
      expect(await store.applyIntent(ra!, { seedId: 'abcd1234' })).toMatchObject({ ok: true });
      expect(await store.applyIntent({ ...rb!, openedAt: 'not a date' }, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'invalid payout' });
      expect(await store.recoverIncidents()).toEqual([rb]);
    });

    it('boot recovery closes Incidents left OPEN and returns only the payouts a restart interrupted', async () => {
      const a = await store.loadOrCreateOperator('sub-rec-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-rec-b', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      await store.recordIncident({ id: 'abcd1234-incA', n: 1, species: KERNEL_DAEMONS[0]!, endsAt: '2026-10-01T04:20:00.000Z', outcome: 'OPEN', participants: [] });
      const [ra, rb] = incidentRewards('abcd1234-incB', { [a.id]: 600, [b.id]: 400 });
      // the CLEARED record lands, then only a's payout before the "crash"
      await store.recordIncident({ id: 'abcd1234-incB', n: ra!.n, species: ra!.species, endsAt: ra!.endsAt, outcome: 'CLEARED', participants: ra!.participants });
      expect(await store.applyIntent(ra!, ctx)).toMatchObject({ ok: true });
      const resumed = await store.recoverIncidents();
      expect(resumed).toEqual([rb]);
      expect(await store.applyIntent(resumed[0]!, ctx)).toMatchObject({ ok: true });
      expect(await store.recoverIncidents()).toEqual([]);
      expect((await store.loadOrCreateOperator('sub-rec-b', 'lo', SPAWN)).bits).toBe(rb!.reward);
      // the orphaned OPEN row is closed (expired) and pays nobody
      expect(await store.applyIntent(incidentRewards('abcd1234-incA', { [a.id]: 1 })[0]!, ctx)).toEqual({ ok: false, reason: 'the Incident expired' });
    });

    it('the load carries the org (none) and the ledger watermark of its balance; liveState lists rows written outside the sim above it', async () => {
      const a = await store.loadOrCreateOperator('sub-live', 'lo', SPAWN);
      expect(a).toMatchObject({ org: null, ledgerSeq: 0, bits: 0 });
      const g1 = await store.grantBits(a.id, 1000, 'admin', 'grant-1');
      expect(g1).toEqual({ id: expect.any(String), seq: expect.any(Number), balance: 1000 });
      const loaded = await store.loadOrCreateOperator('sub-live', 'lo', SPAWN);
      expect(loaded).toMatchObject({ bits: 1000, ledgerSeq: g1.seq });
      const buy: Intent = { id: 'i-live-buy', kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'tap', qty: 1, price: 128 };
      expect(await store.applyIntent(buy, { seedId: 'abcd1234' })).toEqual({ ok: true });
      const g2 = await store.grantBits(a.id, -100, 'rename', 'olga');
      expect(g2).toMatchObject({ balance: 1000 - 128 - 100 });
      expect(g2.seq).toBeGreaterThan(g1.seq);
      const live = await store.liveState(new Map([[a.id, loaded.ledgerSeq], ['00000000-0000-0000-0000-000000000000', 0]]));
      expect([...live.keys()]).toEqual([a.id]);
      // the shop row is the sim's own (applied by the world at accept): it only moves the watermark
      expect(live.get(a.id)).toEqual({ name: null, org: null, ledgerSeq: g2.seq, ledger: [{ id: g2.id, seq: g2.seq, delta: -100, reason: 'rename' }], diskSlots: [] });
      expect((await store.liveState(new Map([[a.id, g2.seq]]))).get(a.id)).toEqual({ name: null, org: null, ledgerSeq: g2.seq, ledger: [], diskSlots: [] });
      expect(await store.liveState(new Map())).toEqual(new Map());
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

    it('a store or capture into a Disk slot taken behind the sim (an Exchange purchase) is the domain failure DISK_SLOT_TAKEN; a replay still answers ok', async () => {
      const a = await store.loadOrCreateOperator('sub-ds1', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      await store.applyIntent(claim(a.id, 'dsa', ownedRecord('pingling', 5, 0, 'abcd1234-ds1')), ctx);
      const toDisk = (id: string, daemonId: string): Intent => ({
        id, kind: 'capture', operatorId: a.id, captureId: `c-${id}`, daemon: ownedRecord('bitrot', 6, 0, daemonId), location: 'DISK', tool: 'sniff',
        log: { ...log, tool: 'sniff', spawnIndex: 1 },
      });
      const first = toDisk('i-ds-cap1', 'abcd1234-ds2');
      expect(await store.applyIntent(first, ctx)).toEqual({ ok: true, research: 1 });
      expect(await store.applyIntent(toDisk('i-ds-cap2', 'abcd1234-ds3'), ctx)).toEqual({ ok: false, reason: DISK_SLOT_TAKEN });
      expect(await store.applyIntent({ id: 'i-ds-store', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-ds1', diskSlot: 0 }, ctx)).toEqual({ ok: false, reason: DISK_SLOT_TAKEN });
      // the until-known retry of the committed capture is answered from its marker, never as a slot clash
      expect(await store.applyIntent(first, ctx)).toEqual({ ok: true, research: 1 });
      const after = await store.loadOrCreateOperator('sub-ds1', 'lo', SPAWN);
      expect(after.ram.map((d) => d.id)).toEqual(['abcd1234-ds1']);
      expect(after.diskSlots).toEqual([0]);
      expect((await store.liveState(new Map([[a.id, 0]]))).get(a.id)!.diskSlots).toEqual([0]);
      // the refused intents left nothing behind: the slot-1 retry of the store goes through
      expect(await store.applyIntent({ id: 'i-ds-store2', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: 'abcd1234-ds1', diskSlot: 1 }, ctx)).toEqual({ ok: true });
      expect((await store.liveState(new Map([[a.id, 0]]))).get(a.id)!.diskSlots).toEqual([0, 1]);
    });

    it('a second claim is refused once a starter is claimed, even with the starter slot free: no second starter, no inventory overwrite', async () => {
      const a = await store.loadOrCreateOperator('sub-s2', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      expect(await store.applyIntent(claim(a.id, 'sol', ownedRecord('pingling', 5, 0, 'abcd1234-k1'), 'i-k-claim1'), ctx)).toEqual({ ok: true, research: 1 });
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

    it('clamps checkpointed ticket progress to the target', async () => {
      const a = await store.loadOrCreateOperator('sub-t9', 'lo', SPAWN);
      const t0 = acceptLo(a.id, 0);
      expect(await store.applyIntent(t0, { seedId: 'abcd1234' })).toEqual({ ok: true });
      const rec = await store.loadOrCreateOperator('sub-t9', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, tickets: [{ ...rec.tickets[0]!, progress: t0.target + 5 }] }]);
      expect((await store.loadOrCreateOperator('sub-t9', 'lo', SPAWN)).tickets[0]!.progress).toBe(t0.target);
    });

    it('accepts, abandons and pays tickets: one DONE row, one ledger row, and the load carries the day', async () => {
      const a = await store.loadOrCreateOperator('sub-t1', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      const day = dayKey(new Date().toISOString());
      const t0 = acceptLo(a.id, 0);
      expect(await store.applyIntent(t0, ctx)).toEqual({ ok: true });
      expect(await store.applyIntent(t0, ctx)).toEqual({ ok: true }); // replay
      expect(await store.applyIntent(acceptLo(a.id, 0, 'i-acc-0b', 'abcd1234-t0b'), ctx)).toEqual({ ok: false, reason: 'already accepted' });
      expect(await store.applyIntent(acceptLo(a.id, 1), ctx)).toEqual({ ok: true });
      expect(await store.applyIntent(acceptLo(a.id, 2), ctx)).toEqual({ ok: false, reason: 'at most 2 open tickets' });
      expect(await store.applyIntent({ id: 'i-ab-1', kind: 'abandonTicket', operatorId: a.id, reqId: 'r', ticketId: 'abcd1234-t1' }, ctx)).toEqual({ ok: true });
      expect(await store.applyIntent({ id: 'i-ab-1b', kind: 'abandonTicket', operatorId: a.id, reqId: 'r', ticketId: 'abcd1234-t1' }, ctx)).toEqual({ ok: false, reason: 'no open ticket' });
      // progress from a checkpoint; a lower one never rewinds it
      const rec = await store.loadOrCreateOperator('sub-t1', 'lo', SPAWN);
      expect(rec).toMatchObject({ ticketsToday: 2, ticketsDay: day, acceptedToday: [`${day}:lo:0`, `${day}:lo:1`], tickets: [{ id: 'abcd1234-t0', progress: 0, pending: false, completing: false }] });
      await store.checkpoint([{ ...rec, tickets: [{ ...rec.tickets[0]!, progress: 2 }] }]);
      await store.checkpoint([{ ...rec, tickets: [{ ...rec.tickets[0]!, progress: 1 }] }]);
      expect((await store.loadOrCreateOperator('sub-t1', 'lo', SPAWN)).tickets[0]!.progress).toBe(2);
      // the payout: refused for another operator, a wrong reward or an abandoned ticket; paid once
      const b = await store.loadOrCreateOperator('sub-t1b', 'lo', SPAWN);
      const reward = t0.reward;
      const complete = (id: string, over: Partial<Extract<Intent, { kind: 'completeTicket' }>> = {}): Intent => ({ id, kind: 'completeTicket', operatorId: a.id, ticketId: 'abcd1234-t0', reward, ...over });
      expect(await store.applyIntent(complete('i-c-b', { operatorId: b.id }), ctx)).toEqual({ ok: false, reason: 'no open ticket' });
      expect(await store.applyIntent(complete('i-c-r', { reward: reward + 1 }), ctx)).toEqual({ ok: false, reason: 'reward does not match the ticket' });
      expect(await store.applyIntent(complete('i-c-ab', { ticketId: 'abcd1234-t1' }), ctx)).toEqual({ ok: false, reason: 'no open ticket' });
      expect(await store.applyIntent(complete('i-c-1'), ctx)).toEqual({ ok: true });
      expect(await store.applyIntent(complete('i-c-1'), ctx)).toEqual({ ok: true }); // replay: no second payment
      expect(await store.applyIntent(complete('i-c-2'), ctx)).toEqual({ ok: false, reason: 'no open ticket' });
      // a checkpoint after the payout cannot touch the DONE row
      await store.checkpoint([{ ...rec, tickets: [{ ...rec.tickets[0]!, progress: 0 }] }]);
      const after = await store.loadOrCreateOperator('sub-t1', 'lo', SPAWN);
      expect(after).toMatchObject({ bits: reward, tickets: [], ticketsToday: 2 });
      expect(await store.ledgerFor(a.id)).toEqual([{ operatorId: a.id, delta: reward, reason: 'ticket', ref: 'abcd1234-t0', at: expect.any(String) }]);
      expect((await store.ledgerFor(b.id)).length).toBe(0);
      // the day still counts both: accepting either again is refused
      expect(await store.applyIntent(acceptLo(a.id, 1, 'i-acc-1b', 'abcd1234-t1b'), ctx)).toEqual({ ok: false, reason: 'already accepted' });
    });

    it('moves items between inventory and the Exchange vault; refuses overdrawn withdrawals', async () => {
      const a = await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'vera', ownedRecord('pingling', 5, 0, 'abcd1234-v1')), { seedId: 'abcd1234' });
      const vault = (id: string, item: string, qty: number): Intent => ({ id, kind: 'vault', operatorId: a.id, reqId: 'r', item, qty });
      expect(await store.applyIntent(vault('i-v1', 'sniff', 5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(vault('i-v1', 'sniff', 5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN)).inventory).toEqual({ sniff: 3, restore: 2 });
      expect(await store.applyIntent(vault('i-v2', 'sniff', -6), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough in the vault' });
      expect(await store.applyIntent(vault('i-v3', 'sniff', -5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2 });
    });

    it('vault moves are re-validated against the rules and the stored inventory; a refused one changes nothing', async () => {
      const a = await store.loadOrCreateOperator('sub-v2', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'vic', ownedRecord('pingling', 5, 0, 'abcd1234-v2')), { seedId: 'abcd1234' });
      const vault = (id: string, item: string, qty: number): Intent => ({ id, kind: 'vault', operatorId: a.id, reqId: 'r', item, qty });
      const ctx = { seedId: 'abcd1234' };
      const bad: Array<[string, number]> = [['sniff', 0], ['sniff', 2.5], ['sniff', 1025], ['sniff', -1025], ['nonsense', 1], ['__proto__', 1], ['diskExpansion', 1], ['sniff', Number.MAX_SAFE_INTEGER + 2]];
      for (const [i, [item, qty]] of bad.entries()) expect(await store.applyIntent(vault(`i-vb-${i}`, item, qty), ctx), `${item} ${qty}`).toEqual({ ok: false, reason: 'invalid vault move' });
      // more than the stored inventory holds: a forged or desynced deposit mints nothing
      expect(await store.applyIntent(vault('i-vb-over', 'sniff', 9), ctx)).toEqual({ ok: false, reason: DEPOSIT_NOT_SAVED });
      expect(await store.applyIntent(vault('i-vb-none', 'tap', 1), ctx)).toEqual({ ok: false, reason: DEPOSIT_NOT_SAVED });
      expect((await store.loadOrCreateOperator('sub-v2', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2 });
      // all of it, then the vault row is gone once emptied
      expect(await store.applyIntent(vault('i-vb-all', 'sniff', 8), ctx)).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-v2', 'lo', SPAWN)).inventory).toEqual({ restore: 2 });
      expect(await store.applyIntent(vault('i-vb-back', 'sniff', -8), ctx)).toEqual({ ok: true });
      expect(await store.applyIntent(vault('i-vb-again', 'sniff', -1), ctx)).toEqual({ ok: false, reason: 'not enough in the vault' });
      expect((await store.loadOrCreateOperator('sub-v2', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2 });
    });

    it('refuses vault moves of an operator without a row', async () => {
      await expect(store.applyIntent({ id: 'i-vx', kind: 'vault', operatorId: '00000000-0000-4000-8000-000000000000', reqId: 'r', item: 'sniff', qty: 1 }, { seedId: 'abcd1234' })).rejects.toThrow();
    });

    it('refuses accepts that do not match the board, of a stale day, or past the daily cap', async () => {
      const a = await store.loadOrCreateOperator('sub-t2', 'lo', SPAWN);
      const ctx = { seedId: 'abcd1234' };
      const t = acceptLo(a.id, 0);
      expect(await store.applyIntent({ ...t, id: 'i-f1', reward: t.reward * 8 }, ctx)).toEqual({ ok: false, reason: 'ticket does not match the board' });
      expect(await store.applyIntent({ ...t, id: 'i-f2', target: 0 }, ctx)).toEqual({ ok: false, reason: 'ticket does not match the board' });
      expect(await store.applyIntent({ ...t, id: 'i-f3', subnet: 'nowhere' }, ctx)).toEqual({ ok: false, reason: 'ticket does not match the board' });
      expect(await store.applyIntent({ ...t, id: 'i-f4', index: 8 }, ctx)).toEqual({ ok: false, reason: 'ticket does not match the board' });
      expect(await store.applyIntent(acceptLo(a.id, 0, 'i-f5', 'abcd1234-f5', '2026-01-01'), ctx)).toEqual({ ok: false, reason: 'the board for 2026-01-01 is gone' });
      for (let i = 0; i < TICKETS_PER_DAY; i++) {
        expect(await store.applyIntent(acceptLo(a.id, i, `i-d-${i}`, `abcd1234-d-${i}`), ctx)).toEqual({ ok: true });
        expect(await store.applyIntent({ id: `i-dab-${i}`, kind: 'abandonTicket', operatorId: a.id, reqId: 'r', ticketId: `abcd1234-d-${i}` }, ctx)).toEqual({ ok: true });
      }
      const day = dayKey(new Date().toISOString());
      const lan = ticketBoard('lan', day)[0]!;
      const ninth: Intent = { id: 'i-d-9', kind: 'acceptTicket', operatorId: a.id, reqId: 'r', ticketId: 'abcd1234-d-9', day, subnet: 'lan', index: 0, ticketKind: lan.kind, params: lan.params, target: lan.target, reward: lan.reward };
      expect(await store.applyIntent(ninth, ctx)).toEqual({ ok: false, reason: `at most ${TICKETS_PER_DAY} tickets per day` });
      expect(await store.loadOrCreateOperator('sub-t2', 'lo', SPAWN)).toMatchObject({ ticketsToday: TICKETS_PER_DAY, tickets: [] });
    });
  });
}

contract('MemoryStore', async () => new MemoryStore(), async () => {});

describe('SIM_LEDGER_REASONS', () => {
  it('is exactly the reasons the store intents write (one source of truth)', () => {
    expect([...SIM_LEDGER_REASONS].sort()).toEqual([...new Set(Object.values(SIM_INTENT_LEDGER_REASONS).flat())].sort());
    expect(Object.isFrozen(SIM_INTENT_LEDGER_REASONS)).toBe(true);
  });
});

describe('MemoryStore orgs', () => {
  it('loads and resyncs the org it holds for the operator (mirrors OrgMember)', async () => {
    const store = new MemoryStore();
    const a = await store.loadOrCreateOperator('sub-org', 'lo', SPAWN);
    const root = { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' } as const;
    store.orgs.set(a.id, root);
    expect((await store.loadOrCreateOperator('sub-org', 'lo', SPAWN)).org).toEqual(root);
    expect((await store.liveState(new Map([[a.id, 0]]))).get(a.id)!.org).toEqual(root);
  });
});

describe('PrismaStore.loadOrCreateOperator unique races', () => {
  const uniqueViolation = () => Object.assign(new Error('Unique constraint failed on the fields: (`sub`)'), { code: 'P2002' });
  const row = { id: 'op-1', sub: 's', name: null, starterClaimed: false, x: 1, y: 2, bits: 0n, inventory: {}, daemons: [] };
  const storeWith = (upsert: () => Promise<unknown>) =>
    new PrismaStore({
      operator: { upsert },
      ticket: { findMany: async () => [] },
      research: { findMany: async () => [] },
      orgMember: { findUnique: async () => null },
      $queryRaw: async () => [{ bits: 0n, seq: null }],
    } as unknown as PrismaClient);

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
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    },
  );

  it('treats a concurrent duplicate of the same claim as applied, not as a name clash', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race', 'lo', SPAWN);
    const d = ownedRecord('pingling', 5, 0, 'abcd1234-d8');
    const results = await Promise.all([
      store.applyIntent(claim(a.id, 'rae', d), { seedId: 'abcd1234' }),
      store.applyIntent(claim(a.id, 'rae', d), { seedId: 'abcd1234' }),
    ]);
    expect(results).toEqual([
      { ok: true, research: 1 },
      { ok: true, research: 1 },
    ]);
    expect(await prisma!.daemon.count({ where: { operatorId: a.id } })).toBe(1);
  });

  it('concurrent first evolutions into one form: both apply, exactly one is the discoverer', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-rc', 'lo', SPAWN);
    await store.applyIntent(claim(a.id, 'ric', ownedRecord('echolet', 16, 0, 'abcd1234-e3')), { seedId: 'abcd1234' });
    const results = await Promise.all([0, 1].map(() => store.applyIntent(evolve('i-dup', a.id, 'abcd1234-e3'), { seedId: 'abcd1234' })));
    expect(results.every((r) => r.ok)).toBe(true);
    const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: 'abcd1234-e3' } });
    expect(row.history).toEqual(EVOLVED_HISTORY);
  });

  it('concurrent purchases cannot overdraw: the operator row lock serializes the balance check', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
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

  it('concurrent payouts of one ticket (different intents): exactly one moves it to DONE and writes the one ledger row', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race-tk', 'lo', SPAWN);
    const t = acceptLo(a.id, 0);
    expect(await store.applyIntent(t, { seedId: 'abcd1234' })).toEqual({ ok: true });
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => store.applyIntent({ id: `i-rtk-${i}`, kind: 'completeTicket', operatorId: a.id, ticketId: t.ticketId, reward: t.reward }, { seedId: 'abcd1234' })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 3 }, () => ({ ok: false, reason: 'no open ticket' })));
    expect(await prisma!.bitsLedger.findMany({ where: { operatorId: a.id }, select: { delta: true, reason: true, ref: true } })).toEqual([{ delta: BigInt(t.reward), reason: 'ticket', ref: t.ticketId }]);
    expect((await store.loadOrCreateOperator('sub-race-tk', 'lo', SPAWN)).bits).toBe(t.reward);
    expect(await prisma!.ticket.findUniqueOrThrow({ where: { id: t.ticketId } })).toMatchObject({ status: 'DONE', progress: t.target });
  });

  it('concurrent accepts cannot pass the open cap, and a concurrent duplicate board entry is "already accepted"', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-race-acc', 'lo', SPAWN);
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => store.applyIntent(acceptLo(a.id, i), { seedId: 'abcd1234' })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 3 }, () => ({ ok: false, reason: 'at most 2 open tickets' })));
    const b = await store.loadOrCreateOperator('sub-race-acc2', 'lo', SPAWN);
    const dup = await Promise.all([0, 1, 2].map((i) => store.applyIntent(acceptLo(b.id, 5, `i-dupacc-${i}`, `abcd1234-dup-${i}`), { seedId: 'abcd1234' })));
    expect(dup.filter((r) => r.ok)).toHaveLength(1);
    expect(dup.filter((r) => !r.ok)).toEqual(Array.from({ length: 2 }, () => ({ ok: false, reason: 'already accepted' })));
    expect(await prisma!.ticket.count({ where: { operatorId: b.id } })).toBe(1);
  });

  it('the unique (operator, day, subnet, index) violation is a domain answer only for an accept; a duplicate ticket id rethrows', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-tk-pk', 'lo', SPAWN);
    const b = await store.loadOrCreateOperator('sub-tk-pk2', 'lo', SPAWN);
    expect(await store.applyIntent(acceptLo(a.id, 0, 'i-pk-1', 'abcd1234-same'), { seedId: 'abcd1234' })).toEqual({ ok: true });
    // another operator's accept forged with the same ticket id: Ticket_pkey, not a domain failure
    await expect(store.applyIntent(acceptLo(b.id, 0, 'i-pk-2', 'abcd1234-same'), { seedId: 'abcd1234' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('concurrent captures of one line add one research point each (no Research_pkey conflict)', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-research', 'lo', SPAWN);
    const cap = (i: number): Intent => ({
      id: `i-rcap-${i}`, kind: 'capture', operatorId: a.id, captureId: `c${i}`, daemon: ownedRecord('pingling', 5, i, `abcd1234-rc${i}`), location: 'DISK', tool: 'sniff',
      log: { ...log, tool: 'sniff', spawnIndex: i },
    });
    const results = await Promise.all([0, 1, 2, 3].map((i) => store.applyIntent(cap(i), { seedId: 'abcd1234' })));
    expect(results.map((r) => (r.ok ? r.research : null)).sort()).toEqual([1, 2, 3, 4]);
    expect(await store.applyIntent(cap(0), { seedId: 'abcd1234' })).toEqual({ ok: true, research: 4 });
    expect((await store.loadOrCreateOperator('sub-research', 'lo', SPAWN)).research).toEqual({ '5': 4 });
  });

  it('simultaneous first logins for one sub all get the same operator', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const recs = await Promise.all(Array.from({ length: 8 }, () => store.loadOrCreateOperator('sub-first', 'lo', SPAWN)));
    expect(new Set(recs.map((r) => r.id)).size).toBe(1);
    expect(await prisma!.operator.count({ where: { sub: 'sub-first' } })).toBe(1);
  });

  it('seq order is commit order: concurrent grants, in-flight buys and liveState reads always see a gap-free prefix of the ledger', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-seq', 'lo', SPAWN);
    const loaded = await store.loadOrCreateOperator('sub-seq', 'lo', SPAWN);
    await store.grantBits(a.id, 64 * 32, 'admin');
    let writing = true;
    const reads: LiveOperatorState[] = [];
    const reader = (async () => {
      while (writing) reads.push((await store.liveState(new Map([[a.id, loaded.ledgerSeq]]))).get(a.id)!);
    })();
    const writers = Promise.all([
      ...Array.from({ length: 48 }, (_, i) => store.grantBits(a.id, i + 1, i % 3 === 0 ? 'org' : 'admin')),
      ...Array.from({ length: 16 }, (_, i) => store.applyIntent({ id: `i-seq-buy-${i}`, kind: 'buy', operatorId: a.id, reqId: 'r', itemId: 'sniff', qty: 1, price: 32 }, { seedId: 'abcd1234' })),
    ]);
    await writers;
    writing = false;
    await reader;
    reads.push((await store.liveState(new Map([[a.id, loaded.ledgerSeq]]))).get(a.id)!);
    const all = (await prisma!.bitsLedger.findMany({ where: { operatorId: a.id }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, reason: true } })).map((r) => ({ ...r, seq: Number(r.seq) }));
    expect(all).toHaveLength(1 + 48 + 16);
    expect(reads.length).toBeGreaterThan(1);
    for (const read of reads) {
      // every committed row up to the read's watermark (and none above it) is in the read: no row with a lower seq can
      // commit after it, so advancing the watermark to ledgerSeq never skips a row
      const prefix = all.filter((r) => r.seq <= read.ledgerSeq && !SIM_LEDGER_REASONS.has(r.reason)).map((r) => r.id);
      expect(read.ledger.map((r) => r.id)).toEqual(prefix);
    }
    expect(reads.at(-1)!.ledgerSeq).toBe(all.at(-1)!.seq);
    // a cached sequence would hand each connection its own block of seqs (see LedgerWrite.seq)
    const [sequence] = await prisma!.$queryRaw<Array<{ cache_size: bigint }>>`SELECT cache_size FROM pg_sequences WHERE sequencename = 'BitsLedger_seq_seq'`;
    expect(Number(sequence!.cache_size)).toBe(1);
  });

  const truncate = () =>
    prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
  const vaultIntent = (id: string, operatorId: string, item: string, qty: number): Intent => ({ id, kind: 'vault', operatorId, reqId: 'r', item, qty });

  it('concurrent deposits and a craft cannot spend the same items: the operator lock serializes them', async () => {
    await truncate();
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-vault-race', 'lo', SPAWN);
    await prisma!.operator.update({ where: { id: a.id }, data: { inventory: { 'frag:packet': 4, 'frag:socket': 4 } } });
    await store.grantBits(a.id, 64, 'admin');
    const craft: Intent = { id: 'i-vr-craft', kind: 'craft', operatorId: a.id, reqId: 'r', recipeId: 'tap', qty: 1, bits: 64, fragments: { 'frag:packet': 4, 'frag:socket': 4 }, output: { item: 'tap', qty: 1 } };
    const results = await Promise.all([
      store.applyIntent(craft, { seedId: 'abcd1234' }),
      ...[0, 1, 2].map((i) => store.applyIntent(vaultIntent(`i-vr-${i}`, a.id, 'frag:packet', 4), { seedId: 'abcd1234' })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const inventory = (await store.loadOrCreateOperator('sub-vault-race', 'lo', SPAWN)).inventory;
    const vault = await prisma!.exchangeVault.findMany({ where: { operatorId: a.id } });
    if (results[0]!.ok) {
      expect(inventory).toEqual({ tap: 1 });
      expect(vault).toEqual([]);
    } else {
      expect(inventory).toEqual({ 'frag:socket': 4 });
      expect(vault).toEqual([{ operatorId: a.id, item: 'frag:packet', qty: 4 }]);
    }
  });

  it('a concurrent duplicate of one withdrawal applies it once (no duplicated items)', async () => {
    await truncate();
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-vault-dup', 'lo', SPAWN);
    await prisma!.exchangeVault.create({ data: { operatorId: a.id, item: 'mirror', qty: 5 } });
    const results = await Promise.all([0, 1, 2, 3].map(() => store.applyIntent(vaultIntent('i-vd', a.id, 'mirror', -3), { seedId: 'abcd1234' })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ ok: true })));
    expect((await store.loadOrCreateOperator('sub-vault-dup', 'lo', SPAWN)).inventory).toEqual({ mirror: 3 });
    expect(await prisma!.exchangeVault.findUniqueOrThrow({ where: { operatorId_item: { operatorId: a.id, item: 'mirror' } } })).toMatchObject({ qty: 2 });
    // distinct withdrawals racing for the rest: only what is there comes out
    const rest = await Promise.all([0, 1, 2].map((i) => store.applyIntent(vaultIntent(`i-vd-${i}`, a.id, 'mirror', -2), { seedId: 'abcd1234' })));
    expect(rest.filter((r) => r.ok)).toHaveLength(1);
    expect(rest.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'not enough in the vault' }, { ok: false, reason: 'not enough in the vault' }]);
    expect((await store.loadOrCreateOperator('sub-vault-dup', 'lo', SPAWN)).inventory).toEqual({ mirror: 5 });
    expect(await prisma!.exchangeVault.count({ where: { operatorId: a.id } })).toBe(0);
  });

  it('a vault row cannot go negative, whoever writes it', async () => {
    await truncate();
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-vault-neg', 'lo', SPAWN);
    await expect(prisma!.exchangeVault.create({ data: { operatorId: a.id, item: 'tap', qty: -1 } })).rejects.toThrow();
  });

  it('load refuses a daemon locked on the Exchange (and only the owner learns why)', async () => {
    await truncate();
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-lock-a', 'lo', SPAWN);
    const b = await store.loadOrCreateOperator('sub-lock-b', 'lo', SPAWN);
    const d = ownedRecord('pingling', 5, 0, 'abcd1234-lk');
    await store.applyIntent(claim(a.id, 'lola', d), { seedId: 'abcd1234' });
    expect(await store.applyIntent({ id: 'i-lk-store', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: d.id, diskSlot: 0 }, { seedId: 'abcd1234' })).toEqual({ ok: true });
    await prisma!.daemon.update({ where: { id: d.id }, data: { lockedBy: 'listing:l1' } });
    const load = (id: string, operatorId: string) => store.applyIntent({ id, kind: 'load', operatorId, reqId: 'r', daemonId: d.id, ramSlot: 1 }, { seedId: 'abcd1234' });
    expect(await load('i-lk-1', a.id)).toEqual({ ok: false, reason: 'locked on the Exchange' });
    expect(await load('i-lk-2', b.id)).toEqual({ ok: false, reason: 'not on Disk' });
    expect(await prisma!.daemon.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ location: 'DISK', slot: 0, lockedBy: 'listing:l1' });
    await prisma!.daemon.update({ where: { id: d.id }, data: { lockedBy: null } });
    expect(await load('i-lk-3', a.id)).toMatchObject({ ok: true, daemon: { id: d.id, slot: 1 } });
  });

  it('loads and resyncs the org from OrgMember; an api spend committed between loads moves balance and watermark together', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault", "Org", "OrgMember", "OrgInvite" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-org', 'lo', SPAWN);
    await prisma!.org.create({ data: { id: 'o1', name: 'Root Access', tag: 'ROOT', ownerId: a.id, members: { create: { operatorId: a.id, rank: 'OWNER' } } } });
    const root = { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' };
    await store.grantBits(a.id, 500, 'admin');
    const spend = await store.grantBits(a.id, -200, 'org', 'o1');
    const loaded = await store.loadOrCreateOperator('sub-org', 'lo', SPAWN);
    expect(loaded).toMatchObject({ org: root, bits: 300, ledgerSeq: spend.seq });
    expect((await store.liveState(new Map([[a.id, 0]]))).get(a.id)).toMatchObject({ org: root, ledgerSeq: spend.seq, ledger: [{ delta: 500 }, { id: spend.id, delta: -200, reason: 'org' }] });
    await prisma!.org.delete({ where: { id: 'o1' } });
    expect((await store.loadOrCreateOperator('sub-org', 'lo', SPAWN)).org).toBeNull();
  });
});
