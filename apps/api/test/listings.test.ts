import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaStore } from '../../sim/src/runtime/prisma-store.js';
import { BitsPush } from '../../sim/src/runtime/pushes.js';
import { SIM_LEDGER_REASONS } from '../../sim/src/runtime/store.js';
import { buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { LISTING_TTL_MS, MAX_ACTIVE_LISTINGS, buyListing, expireListings } from '../src/exchange/listings.js';
import { MAX_PRICE } from '../src/exchange/orders.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Exchange daemon listings (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();

  beforeAll(async () => {
    app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: null, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
      bearer: createDevBearerVerifier('daemonet-users'),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Listing", "Order", "Fill", "ExchangeVault", "BitsLedger", "Session", "Daemon", "Operator", "AppliedAction" CASCADE');
    bus.log.length = 0;
  });

  let seq = 0;
  /** An operator driving the api with a dev bearer token; `seed` puts a daemon straight onto their Disk. */
  async function trader(name: string, bits = 0) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/exchange/vault', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    if (bits) await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits) } });
    const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      seed: async (species = 'initling', over: { level?: number; clean?: boolean; signature?: number; location?: 'DISK' | 'RAM'; lockedBy?: string } = {}) => {
        const id = `t-${name}-${seq++}`;
        const used = await prisma!.daemon.count({ where: { operatorId: op.id, location: over.location ?? 'DISK' } });
        await prisma!.daemon.create({
          data: {
            id, operatorId: op.id, species, level: over.level ?? 5, xp: 0, nature: 0, traitSlot: 0, ivs: [1, 2, 3, 4, 5, 6, 7, 8], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: over.clean ?? false, signature: over.signature ?? 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: over.location ?? 'DISK', slot: used,
            moveTypeUses: new Array(16).fill(0), history: [{ at: new Date().toISOString(), kind: 'captured', detail: 'test' }],
            originalOperatorId: op.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
            ...(over.lockedBy ? { lockedBy: over.lockedBy } : {}),
          },
        });
        return id;
      },
      list: (daemonId: string, price: number) => call('POST', '/listings', { daemonId, price }),
      unlist: (id: string) => call('DELETE', `/listings/${id}`),
      buy: (id: string) => call('POST', `/listings/${id}/buy`),
      get: (path: string) => call('GET', path),
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
    };
  }

  const daemonRow = (id: string) => prisma!.daemon.findUniqueOrThrow({ where: { id } });
  const historyKinds = async (id: string) => ((await daemonRow(id)).history as Array<{ kind: string }>).map((h) => h.kind);

  /** Every `admin` bits push is a valid sim BitsPush carrying exactly one ledger row, and every ledger row was pushed once. */
  async function pushesMatchLedger() {
    const rows = await prisma!.bitsLedger.findMany();
    const pushes = bus.log.filter((m) => m.channel === 'admin' && (m.message as { kind: string }).kind === 'bits').map((m) => BitsPush.parse(m.message));
    expect(pushes.map((p) => p.ledgerId).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const p of pushes) {
      const row = rows.find((r) => r.id === p.ledgerId)!;
      expect(p.origin).toBe('api');
      expect({ operatorId: p.operatorId, seq: p.seq, delta: p.delta, reason: p.reason }).toEqual({ operatorId: row.operatorId, seq: Number(row.seq), delta: Number(row.delta), reason: row.reason });
    }
  }

  it('lists a Disk daemon, locks it, and shows it to browsers with its log', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy');
    const d = await seller.seed('initling', { level: 9 });
    const made = await seller.list(d, 500);
    expect(made.status).toBe(200);
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBe(`listing:${made.body.id}`);
    expect((await seller.list(d, 600)).status).toBe(400); // already on the Exchange
    const ram = await seller.seed('initling', { location: 'RAM' });
    expect((await seller.list(ram, 100)).status).toBe(400); // only from Disk
    expect((await seller.list(await seller.seed('initling', { lockedBy: 'trade:x' }), 100)).status).toBe(400); // offered in a trade
    expect((await buyer.list(d, 100)).status).toBe(400); // not yours
    expect((await seller.list(await seller.seed(), 0)).status).toBe(400);
    expect((await seller.list(await seller.seed(), MAX_PRICE + 1)).status).toBe(400);
    expect((await seller.list(await seller.seed(), 1.5)).status).toBe(400);
    expect((await seller.list(await seller.seed(), MAX_PRICE)).status).toBe(200);

    const seen = (await buyer.get('/listings')).body;
    expect(seen.listings).toHaveLength(2);
    expect(seen.listings[0]).toMatchObject({ id: made.body.id, price: 500, sellerId: seller.id, daemon: { id: d, species: 'initling', level: 9, ivs: [1, 2, 3, 4, 5, 6, 7, 8], log: { tool: 'test' } } });
    expect(seen.listings[0].daemon.history).toHaveLength(1);
    expect((await seller.get('/listings/mine')).body.find((l: { id: string }) => l.id === made.body.id)).toMatchObject({ id: made.body.id, status: 'ACTIVE', price: 500 });
  });

  it('my listings: every ACTIVE one, however old, plus the 64 most recent closed ones', async () => {
    const seller = await trader('sel');
    const d = await seller.seed();
    const old = await seller.list(await seller.seed(), 99);
    // the active listing is older than every closed one below (it would fall off a plain "newest 64")
    await prisma!.listing.update({ where: { id: old.body.id }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    for (let i = 0; i < 70; i++) {
      const { body } = await seller.list(d, 10 + i);
      expect((await seller.unlist(body.id)).status).toBe(200);
    }
    const mine = (await seller.get('/listings/mine')).body as Array<{ id: string; status: string; price: number }>;
    expect(mine.filter((l) => l.status === 'ACTIVE').map((l) => l.id)).toEqual([old.body.id]);
    expect(mine.filter((l) => l.status === 'CANCELLED')).toHaveLength(64);
    expect(mine).toHaveLength(65);
    expect(new Set(mine.map((l) => l.id)).size).toBe(65);
    // closed ones are the most recent, newest first; the old active one sorts last
    expect(mine[0]!.price).toBe(79);
    expect(mine.at(-1)!.id).toBe(old.body.id);
  });

  it('browse refuses out-of-range numeric filters with a 400 (never a 500)', async () => {
    const seller = await trader('sel');
    for (const q of [`maxPrice=${MAX_PRICE + 1}`, 'maxPrice=1e30', 'maxPrice=99999999999999999999', 'maxPrice=0', 'minSignature=16', 'line=51', 'page=1001', 'page=-1']) {
      expect((await seller.get(`/listings?${q}`)).status, q).toBe(400);
    }
    expect((await seller.get(`/listings?maxPrice=${MAX_PRICE}`)).status).toBe(200);
  });

  it('a listing whose daemon is no longer held by it fails the buy, charges nothing and logs the listing and daemon ids', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 500);
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 100);
    await prisma!.daemon.update({ where: { id: d }, data: { lockedBy: null } }); // broken behind the listing's back
    const logged: Array<{ obj: object; msg: string }> = [];
    const log = { warn: (obj: object, msg: string) => logged.push({ obj, msg }), error: (obj: object, msg: string) => logged.push({ obj, msg }) };
    await expect(buyListing(prisma!, bus, buyer.id, made.id, undefined, log)).rejects.toThrow();
    expect(logged).toEqual([{ obj: { listingId: made.id, daemonId: d }, msg: expect.stringContaining('no longer held') }]);
    expect(await buyer.bits()).toBe(500);
    expect(await prisma!.bitsLedger.count()).toBe(0);
  });

  it('lists the same daemon only once when two listings race', async () => {
    const seller = await trader('sel');
    const d = await seller.seed();
    const results = await Promise.all([seller.list(d, 100), seller.list(d, 200)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await prisma!.listing.count()).toBe(1);
  });

  it('a listed daemon cannot be loaded into RAM; a load racing the listing leaves exactly one of them', async () => {
    const store = new PrismaStore(prisma!);
    const seller = await trader('sel');
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 100);
    const refused = await store.applyIntent({ id: 'i-load-0', kind: 'load', operatorId: seller.id, reqId: 'r', daemonId: d, ramSlot: 0 }, { seedId: 'abcd1234' });
    expect(refused).toEqual({ ok: false, reason: 'locked on the Exchange' });
    await seller.unlist(made.id);
    // loaded first: the listing is refused (it is in RAM now)
    expect(await store.applyIntent({ id: 'i-load-x', kind: 'load', operatorId: seller.id, reqId: 'r', daemonId: d, ramSlot: 0 }, { seedId: 'abcd1234' })).toMatchObject({ ok: true });
    expect((await seller.list(d, 100)).status).toBe(400);

    for (let i = 1; i <= 8; i++) {
      const x = await seller.seed();
      const [load, listed] = await Promise.all([
        store.applyIntent({ id: `i-load-${i}`, kind: 'load', operatorId: seller.id, reqId: 'r', daemonId: x, ramSlot: i }, { seedId: 'abcd1234' }),
        seller.list(x, 100),
      ]);
      const row = await daemonRow(x);
      if (load.ok) {
        expect(listed.status).toBe(400);
        expect(row).toMatchObject({ location: 'RAM', lockedBy: null });
      } else {
        expect(listed.status).toBe(200);
        expect(row).toMatchObject({ location: 'DISK', lockedBy: `listing:${listed.body.id}` });
      }
    }
  });

  it('filters and sorts', async () => {
    const seller = await trader('sel');
    await seller.list(await seller.seed('initling', { clean: true }), 300);
    await seller.list(await seller.seed('initling', { signature: 3 }), 100);
    await seller.list(await seller.seed('bootlet', { level: 20 }), 200);
    const ids = async (q: string) => (await seller.get(`/listings${q}`)).body.listings.map((l: { price: number }) => l.price);
    expect(await ids('')).toEqual([100, 200, 300]);
    expect(await ids('?sort=new')).toEqual([200, 100, 300]);
    expect(await ids('?species=initling')).toEqual([100, 300]);
    expect(await ids('?species=bootlet')).toEqual([200]);
    expect(await ids('?line=1')).toEqual([100, 200, 300]);
    expect(await ids('?clean=true')).toEqual([300]);
    expect(await ids('?minSignature=2')).toEqual([100]);
    expect(await ids('?maxPrice=200')).toEqual([100, 200]);
    expect(await ids('?type=kernel')).toEqual([100, 200, 300]);
    expect(await ids('?type=shell')).toEqual([]);
    expect((await seller.get('/listings?clean=maybe')).status).toBe(400);
  });

  it('sells: bits minus the fee, ownership, slot, history, lock, notifications', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 1000);
    await buyer.seed(); // occupies the buyer's Disk slot 0
    const d = await seller.seed('initling');
    const { body: made } = await seller.list(d, 160);
    expect((await seller.buy(made.id)).status).toBe(400); // own listing
    const poor = await trader('poor', 159);
    expect((await poor.buy(made.id)).body).toMatchObject({ error: 'insufficient_bits' });
    expect(await poor.bits()).toBe(159);

    const bought = await buyer.buy(made.id);
    expect(bought).toMatchObject({ status: 200, body: { daemonId: d, slot: 1, price: 160, fee: 10 } });
    expect(await buyer.bits()).toBe(840);
    expect(await seller.bits()).toBe(150);
    const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: d } });
    expect(row).toMatchObject({ operatorId: buyer.id, location: 'DISK', slot: 1, lockedBy: null, originalOperatorId: seller.id });
    expect((row.history as Array<{ kind: string }>).map((h) => h.kind)).toEqual(['captured', 'traded']);
    expect(await prisma!.bitsLedger.findMany({ where: { ref: made.id }, orderBy: { delta: 'asc' }, select: { operatorId: true, delta: true, reason: true } })).toEqual([
      { operatorId: buyer.id, delta: -160n, reason: 'exchange:buy' },
      { operatorId: seller.id, delta: 150n, reason: 'exchange:sale' },
    ]);
    for (const reason of ['exchange:buy', 'exchange:sale']) expect(SIM_LEDGER_REASONS.has(reason)).toBe(false);
    expect(
      bus.log
        .filter((m) => m.channel === 'admin')
        .map((m) => {
          const { ledgerId: _l, seq: _s, ...rest } = m.message as { ledgerId?: string; seq?: number };
          return rest;
        }),
    ).toEqual([
      { kind: 'bits', operatorId: buyer.id, delta: -160, reason: 'exchange:buy', balance: 840, origin: 'api' },
      { kind: 'bits', operatorId: seller.id, delta: 150, reason: 'exchange:sale', balance: 150, origin: 'api' },
      { kind: 'disk', operatorId: buyer.id, add: 1, origin: 'api' },
      { kind: 'disk', operatorId: seller.id, remove: 0, origin: 'api' },
    ]);
    await pushesMatchLedger();
    expect(bus.log.filter((m) => m.channel === 'exchange').map((m) => m.message)).toEqual([
      { kind: 'listingSold', operators: [buyer.id, seller.id], detail: { listingId: made.id, daemonId: d, species: 'initling', price: 160, fee: 10, buyerId: buyer.id, sellerId: seller.id } },
    ]);

    expect((await buyer.get('/listings')).body.listings).toEqual([]);
    expect((await seller.get('/listings/mine')).body[0]).toMatchObject({ status: 'SOLD', daemon: null });
    expect((await poor.buy(made.id)).status).toBe(400); // gone
    expect((await seller.unlist(made.id)).status).toBe(400); // sold: nothing to cancel
    expect(await expireListings(prisma!, new Date(Date.now() + 2 * LISTING_TTL_MS))).toBe(0);
    expect(await daemonRow(d)).toMatchObject({ operatorId: buyer.id, lockedBy: null });
    expect((await buyer.buy('no-such-listing')).status).toBe(404);
    // the new owner can sell it on
    expect((await buyer.list(d, 200)).status).toBe(200);
  });

  it('sells to exactly one of two simultaneous buyers; the other pays nothing', async () => {
    const seller = await trader('sel');
    const a = await trader('a', 500);
    const b = await trader('b', 500);
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 320);
    const results = await Promise.all([a.buy(made.id), b.buy(made.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)!.body.message).toMatch(/no longer available/);
    expect((await a.bits()) + (await b.bits())).toBe(680);
    expect(await seller.bits()).toBe(300);
    expect(await historyKinds(d)).toEqual(['captured', 'traded']);
    expect(await prisma!.bitsLedger.count()).toBe(2);
    await pushesMatchLedger();
    expect(bus.log.filter((m) => m.channel === 'exchange')).toHaveLength(1);
  });

  it('refuses a buyer whose Disk is full', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 500);
    await prisma!.operator.update({ where: { id: buyer.id }, data: { diskCapacity: 1 } });
    await buyer.seed();
    await buyer.seed('initling', { location: 'RAM' }); // RAM does not count against the Disk
    const { body: made } = await seller.list(await seller.seed(), 100);
    const r = await buyer.buy(made.id);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Disk is full/);
    expect(await buyer.bits()).toBe(500);
    expect(await prisma!.bitsLedger.count()).toBe(0);
    expect((await prisma!.listing.findUniqueOrThrow({ where: { id: made.id } })).status).toBe('ACTIVE');
  });

  it('a sale racing a store into the buyer\'s Disk never shares a slot and never charges a refused buy', async () => {
    const store = new PrismaStore(prisma!);
    const seller = await trader('sel');
    const buyer = await trader('buy', 100_000);
    for (let i = 0; i < 8; i++) {
      const ram = await buyer.seed('initling', { location: 'RAM' });
      const slot = await prisma!.daemon.count({ where: { operatorId: buyer.id, location: 'DISK' } });
      const { body: made } = await seller.list(await seller.seed(), 10);
      const before = await buyer.bits();
      const [stored, bought] = await Promise.allSettled([
        store.applyIntent({ id: `i-store-${i}`, kind: 'store', operatorId: buyer.id, reqId: 'r', daemonId: ram, diskSlot: slot }, { seedId: 'abcd1234' }),
        buyer.buy(made.id),
      ]);
      const buy = bought.status === 'fulfilled' ? bought.value : null;
      expect(buy).not.toBeNull();
      if (buy!.status === 200) expect(await buyer.bits()).toBe(before - 10);
      else {
        expect(buy!.status).toBe(409);
        expect(await buyer.bits()).toBe(before);
      }
      // whatever won, the DB never has two daemons in one Disk slot (the unique index), and the store's daemon is where it says
      const disk = await prisma!.daemon.findMany({ where: { operatorId: buyer.id, location: 'DISK' }, select: { slot: true } });
      expect(new Set(disk.map((r) => r.slot)).size).toBe(disk.length);
      const storeOk = stored.status === 'fulfilled' && stored.value.ok;
      expect((await daemonRow(ram)).location).toBe(storeOk ? 'DISK' : 'RAM');
    }
  });

  it('a slot taken by a concurrent writer between the buyer\'s slot read and the move is a 409 with nothing charged', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 500);
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 100);
    // a sim capture to the buyer's Disk slot 0, uncommitted while the buy reads the free slots
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let created!: () => void;
    const inserted = new Promise<void>((r) => (created = r));
    const capture = prisma!.$transaction(
      async (tx) => {
        await tx.daemon.create({
          data: {
            id: 'held-capture', operatorId: buyer.id, species: 'initling', level: 1, xp: 0, nature: 0, traitSlot: 0, ivs: [0, 0, 0, 0, 0, 0, 0, 0], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: false, signature: 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: 'DISK', slot: 0, moveTypeUses: new Array(16).fill(0), history: [],
            originalOperatorId: buyer.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
          },
        });
        created();
        await gate;
      },
      { timeout: 20_000 },
    );
    await inserted;
    const buying = buyer.buy(made.id);
    // wait until the buy blocks on the slot's unique index entry, then let the capture commit
    for (let i = 0; i < 200; i++) {
      const { n } = (await prisma!.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`)[0]!;
      if (n > 0n) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    commit();
    await capture;
    const r = await buying;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict' });
    expect(await buyer.bits()).toBe(500);
    expect(await seller.bits()).toBe(0);
    expect(await prisma!.bitsLedger.count()).toBe(0);
    expect(await daemonRow(d)).toMatchObject({ operatorId: seller.id, lockedBy: `listing:${made.id}` });
    expect(bus.log.filter((m) => m.channel === 'admin' || m.channel === 'exchange')).toEqual([]);
    // the retry takes the next free slot
    expect((await buyer.buy(made.id)).body).toMatchObject({ slot: 1 });
  });

  it('cancels, expires and caps active listings', async () => {
    const seller = await trader('sel');
    const other = await trader('oth');
    const d = await seller.seed();
    const { body: made } = await seller.list(d, 100);
    expect((await other.unlist(made.id)).status).toBe(403);
    expect((await seller.unlist('no-such-listing')).status).toBe(404);
    expect((await seller.unlist(made.id)).status).toBe(200);
    expect((await seller.unlist(made.id)).status).toBe(400);
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBeNull();

    const { body: again } = await seller.list(d, 120); // the same daemon can be listed again
    expect(await expireListings(prisma!, new Date(Date.now() + LISTING_TTL_MS - 1000))).toBe(0);
    expect(await expireListings(prisma!, new Date(Date.now() + LISTING_TTL_MS + 1000))).toBe(1);
    expect((await prisma!.listing.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('EXPIRED');
    expect((await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).lockedBy).toBeNull();
    expect((await other.buy(again.id)).status).toBe(400);

    for (let i = 0; i < MAX_ACTIVE_LISTINGS; i++) expect((await seller.list(await seller.seed(), 10 + i)).status).toBe(200);
    expect((await seller.list(await seller.seed(), 10)).body.message).toMatch(/at most 16/);
    // a listing past its expiry no longer counts, even before the sweep reaches it
    const first = await prisma!.listing.findFirstOrThrow({ where: { sellerId: seller.id, status: 'ACTIVE' } });
    await prisma!.listing.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await seller.list(await seller.seed(), 10)).status).toBe(200);
  });

  it('a listing past its expiry cannot be bought even before the sweep', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 500);
    const { body: made } = await seller.list(await seller.seed(), 100);
    await expect(buyListing(prisma!, bus, buyer.id, made.id, new Date(Date.now() + LISTING_TTL_MS + 1000))).rejects.toMatchObject({ status: 400 });
    expect(await buyer.bits()).toBe(500);
  });

  it('a cancel or an expiry racing a buy: exactly one wins, and a refused buyer pays nothing', async () => {
    const seller = await trader('sel');
    const buyer = await trader('buy', 100_000);
    for (let i = 0; i < 6; i++) {
      const d = await seller.seed();
      const { body: made } = await seller.list(d, 50);
      const before = await buyer.bits();
      const [closed, bought] =
        i % 2 === 0
          ? await Promise.all([seller.unlist(made.id).then((r) => r.status === 200), buyer.buy(made.id)])
          : await Promise.all([expireListings(prisma!, new Date(Date.now() + LISTING_TTL_MS + 1000)).then((n) => n === 1), buyer.buy(made.id)]);
      const listing = await prisma!.listing.findUniqueOrThrow({ where: { id: made.id } });
      const row = await daemonRow(d);
      if (bought.status === 200) {
        expect(closed).toBe(false);
        expect(listing.status).toBe('SOLD');
        expect(row).toMatchObject({ operatorId: buyer.id, lockedBy: null });
        expect(await buyer.bits()).toBe(before - 50);
      } else {
        expect(bought.status).toBe(400);
        expect(closed).toBe(true);
        expect(listing.status).toBe(i % 2 === 0 ? 'CANCELLED' : 'EXPIRED');
        expect(row).toMatchObject({ operatorId: seller.id, lockedBy: null });
        expect(await buyer.bits()).toBe(before);
      }
    }
    await pushesMatchLedger();
  });
});
