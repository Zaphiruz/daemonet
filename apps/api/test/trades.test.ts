import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaStore } from '../../sim/src/runtime/prisma-store.js';
import { BitsPush, DiskPush, ExchangePush, exchangeView } from '../../sim/src/runtime/pushes.js';
import { SIM_LEDGER_REASONS } from '../../sim/src/runtime/store.js';
import { COOKIE_NAME, buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { MAX_OPEN_TRADES, TRADE_IDLE_MS, TRADE_LEDGER_REASON, expireTrades } from '../src/exchange/trades.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

describe.skipIf(!url)('Exchange direct trades (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();
  const dev = createDevBearerVerifier('daemonet-users');

  beforeAll(async () => {
    app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: null, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
      // `dev:root` is an admin
      bearer: async (token) => {
        const claims = await dev(token);
        return token === 'dev:root' ? { ...claims, groups: [...claims.groups, 'daemonet-admins'] } : claims;
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Trade", "Listing", "Order", "Fill", "ExchangeVault", "ChatBlock", "BitsLedger", "Session", "Daemon", "Operator", "AppliedAction" CASCADE');
    bus.log.length = 0;
  });

  let seq = 0;
  async function trader(name: string, bits = 0, vault: Record<string, number> = {}) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/exchange/vault', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits), name } });
    for (const [item, qty] of Object.entries(vault)) await prisma!.exchangeVault.create({ data: { operatorId: op.id, item, qty } });
    const call = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      seed: async (slot: number, over: { location?: 'DISK' | 'RAM'; history?: object[] } = {}) => {
        const id = `t-${name}-${seq++}`;
        await prisma!.daemon.create({
          data: {
            id, operatorId: op.id, species: 'initling', level: 5, xp: 0, nature: 0, traitSlot: 0, ivs: [1, 2, 3, 4, 5, 6, 7, 8], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: false, signature: 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: over.location ?? 'DISK', slot,
            moveTypeUses: new Array(16).fill(0), history: over.history ?? [], originalOperatorId: op.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
          },
        });
        return id;
      },
      open: (withId: string) => call('POST', '/trades', { withId }),
      offer: (id: string, o: { bits?: number; items?: Record<string, number>; daemonIds?: string[] }) => call('PUT', `/trades/${id}/offer`, { bits: 0, items: {}, daemonIds: [], ...o }),
      confirm: (id: string, version: number) => call('POST', `/trades/${id}/confirm`, { version }),
      cancel: (id: string) => call('POST', `/trades/${id}/cancel`),
      list: () => call('GET', '/trades'),
      call,
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
      vault: async () => Object.fromEntries((await prisma!.exchangeVault.findMany({ where: { operatorId: op.id } })).map((v) => [v.item, v.qty])),
      disk: async () => (await prisma!.daemon.findMany({ where: { operatorId: op.id, location: 'DISK' }, orderBy: { slot: 'asc' } })).map((d) => `${d.slot}:${d.id}`),
    };
  }
  const lockOf = async (id: string) => (await prisma!.daemon.findUniqueOrThrow({ where: { id } })).lockedBy;
  const tradeRow = (id: string) => prisma!.trade.findUniqueOrThrow({ where: { id } });
  const busOf = (channel: string) => bus.log.filter((m) => m.channel === channel).map((m) => m.message as Record<string, unknown>);

  /** Every `admin` bits push is a valid sim BitsPush carrying exactly one ledger row, and every ledger row was pushed once. */
  async function pushesMatchLedger() {
    const rows = await prisma!.bitsLedger.findMany();
    const pushes = busOf('admin').filter((m) => m.kind === 'bits').map((m) => BitsPush.parse(m));
    expect(pushes.map((p) => p.ledgerId).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const p of pushes) {
      const row = rows.find((r) => r.id === p.ledgerId)!;
      expect(p.origin).toBe('api');
      expect({ operatorId: p.operatorId, seq: p.seq, delta: p.delta, reason: p.reason }).toEqual({ operatorId: row.operatorId, seq: Number(row.seq), delta: Number(row.delta), reason: row.reason });
    }
  }

  it('opens trades by id or name, one per pair, respecting blocks and the cap', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    expect((await a.open(a.id)).status).toBe(400);
    expect((await a.open('nobody')).status).toBe(404);
    expect((await a.call('POST', '/trades', { withName: 'nobody' })).status).toBe(404);
    expect((await a.call('POST', '/trades', { withId: b.id, withName: 'bob' })).status).toBe(400);
    const made = await a.call('POST', '/trades', { withName: 'bob' });
    expect(made).toMatchObject({ status: 200, body: { status: 'OPEN', version: 0, me: { id: a.id, confirmed: false, offer: { bits: 0, items: {}, daemons: [] } }, them: { id: b.id, name: 'bob' } } });
    expect((await b.open(a.id)).body.message).toMatch(/already have an open trade/);
    expect((await b.list()).body[0]).toMatchObject({ id: made.body.id, me: { id: b.id }, them: { id: a.id } });
    expect(bus.log.at(-1)).toMatchObject({ channel: 'exchange', message: { kind: 'trade', operators: [a.id, b.id], detail: { tradeId: made.body.id, status: 'OPEN' } } });

    const c = await trader('carol');
    await prisma!.chatBlock.create({ data: { blockerId: c.id, blockedId: a.id } });
    expect((await a.open(c.id)).status).toBe(403);
    expect((await a.call('POST', '/trades', { withName: 'carol' })).status).toBe(403);
    expect((await c.open(a.id)).status).toBe(200); // the blocker may still start one
    for (let i = 0; i < MAX_OPEN_TRADES - 2; i++) expect((await a.open((await trader(`x${i}`)).id)).status).toBe(200);
    expect((await a.open((await trader('y')).id)).body.message).toMatch(/at most 4/);
    expect((await (await trader('z')).open(a.id)).body.message).toMatch(/too many open trades/);
    // a cancelled trade frees its place
    await a.cancel(made.body.id);
    expect((await a.open((await trader('w')).id)).status).toBe(200);
  });

  it('holds the caps and one-trade-per-pair under concurrent opens', async () => {
    const a = await trader('alice');
    const others = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => trader(`p${i}`)));
    const opened = await Promise.all(others.map((o) => a.open(o.id)));
    expect(opened.filter((r) => r.status === 200)).toHaveLength(MAX_OPEN_TRADES);
    expect(await prisma!.trade.count({ where: { status: 'OPEN' } })).toBe(MAX_OPEN_TRADES);

    const b = await trader('bob');
    const c = await trader('carol');
    const pair = await Promise.all([b.open(c.id), c.open(b.id), b.open(c.id)]);
    expect(pair.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(await prisma!.trade.count({ where: { status: 'OPEN', OR: [{ aId: b.id }, { bId: b.id }] } })).toBe(1);
  });

  it('validates offers, locks offered daemons and clears confirmations on any change', async () => {
    const a = await trader('alice', 100, { 'frag:packet': 5 });
    const b = await trader('bob', 50);
    const d1 = await a.seed(0);
    const d2 = await a.seed(1);
    const ram = await a.seed(0, { location: 'RAM' });
    const { body: t } = await a.open(b.id);
    expect((await a.offer(t.id, { bits: 101 })).status).toBe(402);
    expect((await a.offer(t.id, { bits: 101 })).body).toMatchObject({ error: 'insufficient_bits' });
    expect((await a.offer(t.id, { items: { 'frag:packet': 6 } })).status).toBe(400);
    expect((await a.offer(t.id, { items: { tap: 1 } })).status).toBe(400); // not tradable
    expect((await a.offer(t.id, { daemonIds: [d1, d1] })).status).toBe(400);
    expect((await a.offer(t.id, { daemonIds: [ram] })).status).toBe(400); // in RAM
    expect((await b.offer(t.id, { daemonIds: [d1] })).status).toBe(400); // not bob's
    expect((await a.offer(t.id, { daemonIds: new Array(9).fill(d1) })).status).toBe(400);
    expect((await a.offer(t.id, { bits: -1 })).status).toBe(400);
    expect((await a.offer(t.id, { bits: 1.5 })).status).toBe(400);
    expect((await (await trader('eve')).offer(t.id, { bits: 0 })).status).toBe(403);
    expect((await a.offer('no-such-trade', { bits: 0 })).status).toBe(404);
    expect((await a.offer('x'.repeat(65), { bits: 0 })).status).toBe(404);
    expect((await tradeRow(t.id)).version).toBe(0); // refused offers change nothing

    const o1 = await a.offer(t.id, { bits: 40, items: { 'frag:packet': 2 }, daemonIds: [d1, d2] });
    expect(o1.body).toMatchObject({ version: 1, me: { offer: { bits: 40, items: { 'frag:packet': 2 }, daemons: [{ id: d1, species: 'initling' }, { id: d2 }] } } });
    expect(await lockOf(d1)).toBe(`trade:${t.id}`);
    // bob sees alice's daemons in full, for inspection
    expect((await b.list()).body[0]).toMatchObject({ them: { offer: { daemons: [{ id: d1, log: { originalOperatorId: a.id } }, { id: d2 }] } } });
    // offered bits and items stay where they are until the trade executes
    expect(await a.bits()).toBe(100);
    expect(await a.vault()).toEqual({ 'frag:packet': 5 });
    expect((await b.confirm(t.id, 0)).body).toMatchObject({ error: 'stale_offer' });
    expect((await b.confirm(t.id, 0)).status).toBe(409);
    expect((await b.confirm(t.id, 1)).body).toMatchObject({ status: 'OPEN', me: { confirmed: true }, them: { confirmed: false } });
    // alice takes a daemon back: bob's confirmation is void, the daemon is free again
    const o2 = await a.offer(t.id, { bits: 40, items: { 'frag:packet': 2 }, daemonIds: [d1] });
    expect(o2.body).toMatchObject({ version: 2, me: { confirmed: false }, them: { confirmed: false } });
    expect(await lockOf(d2)).toBeNull();
    // a locked daemon cannot also be listed, offered in another trade, or loaded
    expect((await a.call('POST', '/listings', { daemonId: d1, price: 10 })).status).toBe(400);
    const c = await trader('carol');
    const { body: t2 } = await a.open(c.id);
    expect((await a.offer(t2.id, { daemonIds: [d1] })).status).toBe(400);
    const store = new PrismaStore(prisma!);
    expect(await store.applyIntent({ id: 'i-load-locked', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d1, ramSlot: 1 }, { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'locked on the Exchange' });
    // a listed daemon cannot be offered
    const { body: listing } = await a.call('POST', '/listings', { daemonId: d2, price: 10 });
    expect((await a.offer(t2.id, { daemonIds: [d2] })).status).toBe(400);
    expect(await lockOf(d2)).toBe(`listing:${listing.id}`);
    // a refused offer change keeps the previous offer and its locks
    expect((await a.offer(t.id, { daemonIds: [d2] })).status).toBe(400);
    expect(await lockOf(d1)).toBe(`trade:${t.id}`);
    expect((await tradeRow(t.id)).version).toBe(2);

    expect((await a.cancel(t.id)).body.status).toBe('CANCELLED');
    expect(await lockOf(d1)).toBeNull();
    expect(await lockOf(d2)).toBe(`listing:${listing.id}`); // only this trade's locks are cleared
    expect((await a.offer(t.id, { bits: 1 })).status).toBe(400);
    expect((await a.cancel(t.id)).status).toBe(400);
    expect(await a.bits()).toBe(100);
    expect(await prisma!.bitsLedger.count()).toBe(0);
  });

  it('swaps bits (fee on each side), items and daemons atomically when both confirm', async () => {
    const a = await trader('alice', 1000, { 'frag:packet': 5 });
    const b = await trader('bob', 320, { 'frag:heap': 2 });
    const a0 = await a.seed(0);
    const a1 = await a.seed(1);
    const b0 = await b.seed(0);
    await b.seed(1);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { bits: 160, items: { 'frag:packet': 3 }, daemonIds: [a0, a1] });
    const { body: offered } = await b.offer(t.id, { bits: 32, items: { 'frag:heap': 2 }, daemonIds: [b0] });
    expect((await a.confirm(t.id, offered.version)).body.status).toBe('OPEN');
    bus.log.length = 0;
    const done = await b.confirm(t.id, offered.version);
    expect(done.body).toMatchObject({ status: 'DONE', me: { confirmed: true }, them: { confirmed: true } });

    expect(await a.bits()).toBe(1000 - 160 + 30);
    expect(await b.bits()).toBe(320 - 32 + 150);
    expect(await a.vault()).toEqual({ 'frag:packet': 2, 'frag:heap': 2 });
    expect(await b.vault()).toEqual({ 'frag:packet': 3 });
    expect(await a.disk()).toEqual([`0:${b0}`]);
    expect(await b.disk()).toEqual([`0:${a0}`, expect.stringMatching(/^1:t-bob/), `2:${a1}`]);
    // nothing is left parked: every Disk slot is a valid one
    for (const d of await prisma!.daemon.findMany()) {
      const { diskCapacity } = await prisma!.operator.findUniqueOrThrow({ where: { id: d.operatorId } });
      expect(d.slot >= 0 && d.slot < diskCapacity).toBe(true);
    }
    const moved = await prisma!.daemon.findUniqueOrThrow({ where: { id: a0 } });
    expect(moved).toMatchObject({ lockedBy: null, originalOperatorId: a.id, operatorId: b.id });
    expect(moved.history).toMatchObject([{ kind: 'traded' }]);
    expect((await prisma!.bitsLedger.findMany({ where: { ref: t.id }, orderBy: { delta: 'asc' } })).map((l) => [l.operatorId === a.id ? 'a' : 'b', Number(l.delta), l.reason])).toEqual([
      ['a', -160, 'exchange:trade'],
      ['b', -32, 'exchange:trade'],
      ['a', 30, 'exchange:trade'],
      ['b', 150, 'exchange:trade'],
    ]);
    expect(TRADE_LEDGER_REASON).toBe('exchange:trade');
    expect(SIM_LEDGER_REASONS.has(TRADE_LEDGER_REASON)).toBe(false);
    await pushesMatchLedger();
    const admin = busOf('admin');
    const bitsPushes = admin.filter((m) => m.kind === 'bits').map(({ ledgerId: _l, seq: _s, ...rest }) => rest);
    expect(bitsPushes).toEqual(
      expect.arrayContaining([
        { kind: 'bits', operatorId: a.id, delta: -160, reason: 'exchange:trade', balance: 840, origin: 'api' },
        { kind: 'bits', operatorId: b.id, delta: 150, reason: 'exchange:trade', balance: 470, origin: 'api' },
        { kind: 'bits', operatorId: b.id, delta: -32, reason: 'exchange:trade', balance: 438, origin: 'api' },
        { kind: 'bits', operatorId: a.id, delta: 30, reason: 'exchange:trade', balance: 870, origin: 'api' },
      ]),
    );
    expect(bitsPushes).toHaveLength(4);
    const disk = admin.filter((m) => m.kind === 'disk');
    for (const m of disk) DiskPush.parse(m);
    // removes first: bob's slot 0 is freed before alice's daemon arrives in it
    expect(disk).toEqual([
      { kind: 'disk', operatorId: a.id, remove: 0, origin: 'api' },
      { kind: 'disk', operatorId: a.id, remove: 1, origin: 'api' },
      { kind: 'disk', operatorId: b.id, remove: 0, origin: 'api' },
      { kind: 'disk', operatorId: b.id, add: 0, origin: 'api' },
      { kind: 'disk', operatorId: b.id, add: 2, origin: 'api' },
      { kind: 'disk', operatorId: a.id, add: 0, origin: 'api' },
    ]);
    expect(admin).toHaveLength(10);
    const note = bus.log.at(-1)!;
    expect(note).toMatchObject({ channel: 'exchange', message: { kind: 'trade', operators: [a.id, b.id], detail: { tradeId: t.id, status: 'DONE' } } });
    // the sim shows each side the notification as is: it names no counterparty
    const push = ExchangePush.parse(note.message);
    expect(exchangeView(push.detail!, a.id)).toEqual({ tradeId: t.id, status: 'DONE' });
    expect(exchangeView(push.detail!, b.id)).toEqual({ tradeId: t.id, status: 'DONE' });
    expect((await a.confirm(t.id, offered.version)).status).toBe(400); // done is done
    expect((await a.cancel(t.id)).status).toBe(400);
    // a closed trade shows only the daemons the viewer owns now (no peeking at the other side's Disk afterwards)
    const [seen] = (await a.list()).body;
    expect(seen).toMatchObject({ status: 'DONE', me: { offer: { bits: 160, daemons: [] } }, them: { offer: { daemons: [{ id: b0 }] } } });
    // the new owners can trade them on
    const c = await trader('carol');
    const { body: t2 } = await b.open(c.id);
    expect((await b.offer(t2.id, { daemonIds: [a0] })).status).toBe(200);
  });

  it('rolls everything back when a side can no longer deliver', async () => {
    const a = await trader('alice', 100, { 'frag:packet': 2 });
    const b = await trader('bob', 0);
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    const { body: o } = await a.offer(t.id, { bits: 100, items: { 'frag:packet': 2 }, daemonIds: [d] });
    await b.confirm(t.id, o.version);
    bus.log.length = 0;
    await prisma!.operator.update({ where: { id: a.id }, data: { bits: 99n } }); // spent a bit elsewhere
    expect((await a.confirm(t.id, o.version)).status).toBe(402);
    await prisma!.operator.update({ where: { id: a.id }, data: { bits: 100n } });
    await prisma!.exchangeVault.updateMany({ where: { operatorId: a.id }, data: { qty: 1 } });
    expect((await a.confirm(t.id, o.version)).status).toBe(400);
    expect(await a.bits()).toBe(100);
    expect(await b.bits()).toBe(0);
    expect(await a.vault()).toEqual({ 'frag:packet': 1 });
    expect(await b.vault()).toEqual({});
    expect(await a.disk()).toEqual([`0:${d}`]);
    expect(await lockOf(d)).toBe(`trade:${t.id}`);
    expect(await prisma!.bitsLedger.count()).toBe(0);
    expect(bus.log).toEqual([]);
    expect((await a.list()).body[0]).toMatchObject({ status: 'OPEN', me: { confirmed: false }, them: { confirmed: true } });
    // nothing on the table is not a trade
    const c = await trader('carol');
    const { body: empty } = await b.open(c.id);
    await b.confirm(empty.id, 0);
    expect((await c.confirm(empty.id, 0)).body.message).toMatch(/nothing on the table/);
    // a receiver without Disk space
    await prisma!.exchangeVault.updateMany({ where: { operatorId: a.id }, data: { qty: 2 } });
    await prisma!.operator.update({ where: { id: b.id }, data: { diskCapacity: 0 } });
    expect((await a.confirm(t.id, o.version)).body.message).toMatch(/too full/);
    expect(await a.bits()).toBe(100);
    expect(await a.disk()).toEqual([`0:${d}`]);
    // room again: the same confirmation goes through
    await prisma!.operator.update({ where: { id: b.id }, data: { diskCapacity: 8 } });
    expect((await a.confirm(t.id, o.version)).body.status).toBe('DONE');
    expect(await b.disk()).toEqual([`0:${d}`]);
    expect(await b.bits()).toBe(100 - 6);
  });

  it('a daemon that left the Disk meanwhile fails the trade without charging anyone', async () => {
    const a = await trader('alice', 0);
    const b = await trader('bob', 64);
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { daemonIds: [d] });
    const { body: o } = await b.offer(t.id, { bits: 64 });
    await a.confirm(t.id, o.version);
    // the lock is gone (a hand edit or a bug): the trade must not move a daemon it no longer holds
    await prisma!.daemon.update({ where: { id: d }, data: { lockedBy: null } });
    expect((await b.confirm(t.id, o.version)).body.message).toMatch(/no longer available/);
    expect(await b.bits()).toBe(64);
    expect(await a.disk()).toEqual([`0:${d}`]);
  });

  it('trading with yourself is refused', async () => {
    const a = await trader('alice');
    expect((await a.call('POST', '/trades', { withName: 'alice' })).body.message).toMatch(/yourself/);
  });

  it('exactly one execution when both confirm at once, and whatever races it', async () => {
    for (let round = 0; round < 6; round++) {
      await prisma!.$executeRawUnsafe('TRUNCATE "Trade", "ExchangeVault", "BitsLedger", "Daemon", "Operator", "Session" CASCADE');
      bus.log.length = 0;
      const a = await trader(`a${round}`, 0, { 'frag:packet': 4 });
      const b = await trader(`b${round}`, 1000);
      const d = await a.seed(0);
      const { body: t } = await a.open(b.id);
      await a.offer(t.id, { items: { 'frag:packet': 4 }, daemonIds: [d] });
      const { body: o } = await b.offer(t.id, { bits: 320 });
      const kind = round % 3;
      if (kind === 0) {
        // both confirm simultaneously: one records, the other executes
        const rs = await Promise.all([a.confirm(t.id, o.version), b.confirm(t.id, o.version)]);
        expect(rs.map((r) => r.status)).toEqual([200, 200]);
        expect(rs.filter((r) => r.body.status === 'DONE')).toHaveLength(1);
      } else if (kind === 1) {
        // alice already confirmed; she re-confirms while bob confirms: one executes, the other finds it done
        await a.confirm(t.id, o.version);
        const rs = await Promise.all([a.confirm(t.id, o.version), b.confirm(t.id, o.version)]);
        expect(rs.filter((r) => r.status === 200 && r.body.status === 'DONE')).toHaveLength(1);
      } else {
        // a cancel racing the confirmation that would execute: exactly one wins
        await a.confirm(t.id, o.version);
        const [cancel, confirm] = await Promise.all([a.cancel(t.id), b.confirm(t.id, o.version)]);
        expect([cancel.status, confirm.status].sort()).toEqual([200, 400]);
      }
      const row = await tradeRow(t.id);
      const done = row.status === 'DONE';
      expect(await prisma!.bitsLedger.count()).toBe(done ? 2 : 0);
      expect(await b.bits()).toBe(done ? 680 : 1000);
      expect(await a.bits()).toBe(done ? 300 : 0);
      expect(await a.vault()).toEqual(done ? {} : { 'frag:packet': 4 });
      expect(await b.vault()).toEqual(done ? { 'frag:packet': 4 } : {});
      expect(await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).toMatchObject({ operatorId: done ? b.id : a.id, lockedBy: null, slot: 0 });
      expect(busOf('admin').filter((m) => m.kind === 'disk')).toHaveLength(done ? 2 : 0);
      if (done) await pushesMatchLedger();
    }
  });

  it('an offer change racing a confirmation never executes an offer the confirmer did not see', async () => {
    for (let round = 0; round < 6; round++) {
      await prisma!.$executeRawUnsafe('TRUNCATE "Trade", "ExchangeVault", "BitsLedger", "Daemon", "Operator", "Session" CASCADE');
      const a = await trader(`a${round}`, 1000);
      const b = await trader(`b${round}`, 1000);
      const { body: t } = await a.open(b.id);
      await a.offer(t.id, { bits: 500 });
      const { body: o } = await b.offer(t.id, { bits: 10 });
      await b.confirm(t.id, o.version);
      // alice confirms what she saw while bob lowers his side
      const [confirm, change] = await Promise.all([a.confirm(t.id, o.version), b.offer(t.id, { bits: 1 })]);
      const row = await tradeRow(t.id);
      if (confirm.status === 200) {
        // the confirmation came first: the offers both saw were swapped, and the late change found the trade closed
        expect(confirm.body.status).toBe('DONE');
        expect(change.status).toBe(400);
        expect(row.status).toBe('DONE');
        expect(await a.bits()).toBe(1000 - 500 + 10);
        expect(await b.bits()).toBe(1000 - 10 + 500 - 31);
      } else {
        // the change came first: the confirmation quoted the old version and nothing moved
        expect(confirm.body).toMatchObject({ error: 'stale_offer' });
        expect(change.status).toBe(200);
        expect(row).toMatchObject({ status: 'OPEN', aConfirmed: false, bConfirmed: false });
        expect(await a.bits()).toBe(1000);
        expect(await b.bits()).toBe(1000);
      }
    }
  });

  it('an offered daemon being loaded into RAM: exactly one of them wins', async () => {
    const store = new PrismaStore(prisma!);
    const a = await trader('alice');
    const b = await trader('bob');
    const { body: t } = await a.open(b.id);
    for (let i = 0; i < 8; i++) {
      const x = await a.seed(i);
      const [load, offered] = await Promise.all([
        store.applyIntent({ id: `i-load-${i}`, kind: 'load', operatorId: a.id, reqId: 'r', daemonId: x, ramSlot: i }, { seedId: 'abcd1234' }),
        a.offer(t.id, { daemonIds: [x] }),
      ]);
      const row = await prisma!.daemon.findUniqueOrThrow({ where: { id: x } });
      if (load.ok) {
        expect(offered.status).toBe(400);
        expect(row).toMatchObject({ location: 'RAM', lockedBy: null });
      } else {
        expect(offered.status).toBe(200);
        expect(row).toMatchObject({ location: 'DISK', lockedBy: `trade:${t.id}` });
      }
    }
  });

  it('a Disk slot taken by a concurrent sim write during the swap is a retryable 409 with nothing moved or published', async () => {
    const a = await trader('alice', 0);
    const b = await trader('bob', 64);
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { daemonIds: [d] });
    const { body: o } = await b.offer(t.id, { bits: 64 });
    await a.confirm(t.id, o.version);
    bus.log.length = 0;
    // a sim capture to bob's Disk slot 0, uncommitted while the swap reads bob's free slots
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let created!: () => void;
    const inserted = new Promise<void>((r) => (created = r));
    const capture = prisma!.$transaction(
      async (tx) => {
        await tx.daemon.create({
          data: {
            id: 'held-capture', operatorId: b.id, species: 'initling', level: 1, xp: 0, nature: 0, traitSlot: 0, ivs: [0, 0, 0, 0, 0, 0, 0, 0], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
            clean: false, signature: 0, hp: 20, energy: 128, moves: ['ping'], crashed: false, location: 'DISK', slot: 0, moveTypeUses: new Array(16).fill(0), history: [],
            originalOperatorId: b.id, capturedAt: new Date(), captureSubnet: 'lo', captureTool: 'test', spawnSeedId: 'test', spawnIndex: null,
          },
        });
        created();
        await gate;
      },
      { timeout: 20_000 },
    );
    await inserted;
    const confirming = b.confirm(t.id, o.version);
    for (let i = 0; i < 200; i++) {
      const { n } = (await prisma!.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`)[0]!;
      if (n > 0n) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    commit();
    await capture;
    const r = await confirming;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict' });
    expect(await b.bits()).toBe(64);
    expect(await prisma!.bitsLedger.count()).toBe(0);
    expect(await prisma!.daemon.findUniqueOrThrow({ where: { id: d } })).toMatchObject({ operatorId: a.id, slot: 0, lockedBy: `trade:${t.id}` });
    expect(bus.log).toEqual([]);
    expect(await tradeRow(t.id)).toMatchObject({ status: 'OPEN', aConfirmed: true, bConfirmed: false });
    // the retry takes the next free slot
    expect((await b.confirm(t.id, o.version)).body.status).toBe('DONE');
    expect(await b.disk()).toEqual(['0:held-capture', `1:${d}`]);
  });

  it('cancels trades idle for an hour and frees their daemons', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    const d = await a.seed(0);
    const { body: t } = await a.open(b.id);
    await a.offer(t.id, { daemonIds: [d] });
    bus.log.length = 0;
    expect(await expireTrades(prisma!, bus, new Date(Date.now() + TRADE_IDLE_MS - 60_000))).toBe(0);
    expect(await expireTrades(prisma!, bus, new Date(Date.now() + TRADE_IDLE_MS + 60_000))).toBe(1);
    expect(await lockOf(d)).toBeNull();
    expect((await a.list()).body[0]).toMatchObject({ id: t.id, status: 'CANCELLED' });
    expect(busOf('exchange')).toEqual([{ kind: 'trade', operators: [a.id, b.id], detail: { tradeId: t.id, status: 'CANCELLED' } }]);
    // exactly once
    expect(await expireTrades(prisma!, bus, new Date(Date.now() + 2 * TRADE_IDLE_MS))).toBe(0);
  });

  it('an idle trade cannot be offered on or confirmed before the sweep reaches it; an expiry racing a confirmation: one wins', async () => {
    const a = await trader('alice', 0, { 'frag:packet': 1 });
    const b = await trader('bob');
    const { body: t } = await a.open(b.id);
    const { body: o } = await a.offer(t.id, { items: { 'frag:packet': 1 } });
    await prisma!.trade.update({ where: { id: t.id }, data: { updatedAt: new Date(Date.now() - TRADE_IDLE_MS - 1000) } });
    expect((await b.confirm(t.id, o.version)).body.message).toMatch(/expired/);
    expect((await b.offer(t.id, { bits: 0 })).body.message).toMatch(/expired/);
    expect((await a.cancel(t.id)).body.status).toBe('CANCELLED'); // cancelling is always allowed

    for (let round = 0; round < 6; round++) {
      const c = await trader(`c${round}`);
      const { body: t2 } = await b.open(c.id);
      const { body: o2 } = await b.offer(t2.id, { daemonIds: [await b.seed(round)] });
      await b.confirm(t2.id, o2.version);
      const [expired, confirm] = await Promise.all([expireTrades(prisma!, bus, new Date(Date.now() + TRADE_IDLE_MS + 60_000)), c.confirm(t2.id, o2.version)]);
      const row = await tradeRow(t2.id);
      expect(expired + (confirm.status === 200 ? 1 : 0)).toBe(1);
      expect(row.status).toBe(expired ? 'CANCELLED' : 'DONE');
      expect(await prisma!.daemon.count({ where: { lockedBy: `trade:${t2.id}` } })).toBe(0);
    }
  });

  it('shows admins the market: open counts, 24 h volume and destroyed fees', async () => {
    const a = await trader('alice', 1000, { 'frag:packet': 4 });
    const b = await trader('bob', 1000);
    await a.call('POST', '/orders', { item: 'frag:packet', side: 'SELL', price: 50, qty: 4 });
    await b.call('POST', '/orders', { item: 'frag:packet', side: 'BUY', price: 50, qty: 3 });
    const { body: listing } = await a.call('POST', '/listings', { daemonId: await a.seed(0), price: 160 });
    await b.call('POST', `/listings/${listing.id}/buy`);
    await a.open(b.id);
    // Browser sessions only: admin rights come from Operator.isAdmin, and a bearer token (even root's) never carries them.
    const session = async (name: string, admin: boolean) => {
      const dev = await app.inject({ method: 'GET', url: `/api/auth/dev?name=${name}${admin ? '&admin=true' : ''}` });
      return { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    };
    const get = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/admin/market', cookies });
    expect((await get(await session('alice', false))).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/market', headers: { authorization: 'Bearer dev:root' } })).statusCode).toBe(401);
    const r = await get(await session('root', true));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.json()).toMatchObject({
      openOrders: 1, activeListings: 0, openTrades: 1,
      day: { items: [{ item: 'frag:packet', qty: 3, bits: 150, fees: 9, last: 50 }], salesCount: 1, sales: [{ species: 'initling', price: 160 }], trades: 0, feesDestroyed: 19 },
    });
    // Rights are re-read from the operator row on every request.
    const cookies = await session('root', true);
    await prisma!.operator.updateMany({ where: { sub: 'dev-root' }, data: { isAdmin: false } });
    expect((await get(cookies)).statusCode).toBe(403);
  });
});
