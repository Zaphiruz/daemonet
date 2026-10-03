import { createPrisma } from '@daemonet/db';
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

    it('checkpoints position, inventory, bits and RAM daemon state', async () => {
      const a = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      const d = ownedRecord('hashling', 5, 0, 'abcd1234-d6');
      await store.applyIntent(claim(a.id, 'erin', d), { seedId: 'abcd1234' });
      const rec = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, x: 40.25, y: 12.5, bits: 64, inventory: { sniff: 3 }, ram: [{ ...rec.ram[0]!, level: 7, hp: 3, crashed: true }] }]);
      const after = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      expect(after).toMatchObject({ x: 40.25, y: 12.5, bits: 64, inventory: { sniff: 3 } });
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
  });
}

contract('MemoryStore', async () => new MemoryStore(), async () => {});

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;
describe.skipIf(!url)('PrismaStore (needs DATABASE_URL)', () => {
  afterAll(async () => prisma?.$disconnect());
  contract(
    'PrismaStore',
    async () => new PrismaStore(prisma!),
    async () => {
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction" CASCADE');
    },
  );

  it('treats a concurrent duplicate of the same claim as applied, not as a name clash', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction" CASCADE');
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
});
