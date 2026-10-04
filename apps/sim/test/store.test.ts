import { createPrisma, type PrismaClient } from '@daemonet/db';
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
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    },
  );

  it('treats a concurrent duplicate of the same claim as applied, not as a name clash', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
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
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const a = await store.loadOrCreateOperator('sub-rc', 'lo', SPAWN);
    await store.applyIntent(claim(a.id, 'ric', ownedRecord('echolet', 16, 0, 'abcd1234-e3')), { seedId: 'abcd1234' });
    const results = await Promise.all([0, 1].map(() => store.applyIntent(evolve('i-dup', a.id, 'abcd1234-e3'), { seedId: 'abcd1234' })));
    expect(results.every((r) => r.ok)).toBe(true);
    const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: 'abcd1234-e3' } });
    expect(row.history).toEqual(EVOLVED_HISTORY);
  });

  it('simultaneous first logins for one sub all get the same operator', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
    const store = new PrismaStore(prisma!);
    const recs = await Promise.all(Array.from({ length: 8 }, () => store.loadOrCreateOperator('sub-first', 'lo', SPAWN)));
    expect(new Set(recs.map((r) => r.id)).size).toBe(1);
    expect(await prisma!.operator.count({ where: { sub: 'sub-first' } })).toBe(1);
  });
});
