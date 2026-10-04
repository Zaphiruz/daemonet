import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { ITEMS, createRng } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaStore } from '../../sim/src/runtime/prisma-store.js';
import { BitsPush } from '../../sim/src/runtime/pushes.js';
import { SIM_LEDGER_REASONS } from '../../sim/src/runtime/store.js';
import { buildApp } from '../src/app.js';
import { createDevBearerVerifier } from '../src/auth/bearer.js';
import { MAX_OPEN_ORDERS, MAX_PRICE, MAX_QTY, ORDER_TTL_MS, expireOrders, feeOn } from '../src/exchange/orders.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

const appOptions = (bus: MemoryBus, disableRateLimit: boolean) => ({
  prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
  oidcClient: null, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit,
  bearer: createDevBearerVerifier('daemonet-users'),
});

const truncate = () => prisma!.$executeRawUnsafe('TRUNCATE "Order", "Fill", "ExchangeVault", "BitsLedger", "Session", "Daemon", "Operator", "AppliedAction" CASCADE');

describe.skipIf(!url)('Exchange order book (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  const bus = new MemoryBus();

  beforeAll(async () => {
    app = await buildApp(appOptions(bus, true));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await truncate();
    bus.log.length = 0;
  });

  /** A bot operator with bits and vault items, talking to the api with a dev bearer token. */
  async function trader(name: string, bits = 0, vault: Record<string, number> = {}) {
    const headers = { authorization: `Bearer dev:${name}` };
    await app.inject({ method: 'GET', url: '/api/me', headers });
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
    if (bits) await prisma!.operator.update({ where: { id: op.id }, data: { bits: BigInt(bits) } });
    for (const [item, qty] of Object.entries(vault)) await prisma!.exchangeVault.create({ data: { operatorId: op.id, item, qty } });
    const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) => {
      const r = await app.inject({ method, url: `/api/exchange${path}`, headers, ...(payload ? { payload } : {}) });
      return { status: r.statusCode, body: r.json() };
    };
    return {
      id: op.id,
      order: (side: 'BUY' | 'SELL', price: number, qty: number, item = 'frag:packet') => call('POST', '/orders', { item, side, price, qty }),
      cancel: (id: string) => call('DELETE', `/orders/${id}`),
      get: (path: string) => call('GET', path),
      bits: async () => Number((await prisma!.operator.findUniqueOrThrow({ where: { id: op.id } })).bits),
      vault: async () => Object.fromEntries((await prisma!.exchangeVault.findMany({ where: { operatorId: op.id } })).map((v) => [v.item, v.qty])),
    };
  }
  type Trader = Awaited<ReturnType<typeof trader>>;

  /** Bits and items held by the traders, their open orders' escrow, and the fees destroyed. */
  async function totals(traders: Trader[], item = 'frag:packet') {
    const orders = await prisma!.order.findMany({ where: { status: 'OPEN' } });
    const fees = (await prisma!.fill.findMany()).reduce((s, f) => s + f.fee, 0);
    let bits = 0;
    let items = 0;
    for (const t of traders) {
      bits += await t.bits();
      items += (await t.vault())[item] ?? 0;
    }
    bits += orders.filter((o) => o.side === 'BUY').reduce((s, o) => s + o.price * o.remaining, 0);
    items += orders.filter((o) => o.side === 'SELL' && o.item === item).reduce((s, o) => s + o.remaining, 0);
    return { bits, items, fees };
  }

  /** Every balance is its start plus the sum of its ledger rows, and every ledger row was announced exactly once. */
  async function ledgerMatches(t: Trader, start: number) {
    const ledger = await prisma!.bitsLedger.findMany({ where: { operatorId: t.id } });
    expect(start + ledger.reduce((s, l) => s + Number(l.delta), 0)).toBe(await t.bits());
    const pushes = bus.log.filter((l) => l.channel === 'admin' && (l.message as { operatorId?: string }).operatorId === t.id).map((l) => l.message as { ledgerId: string });
    expect(pushes.map((p) => p.ledgerId).sort()).toEqual(ledger.map((l) => l.id).sort());
  }

  it('escrows, rests, and shows the book', async () => {
    const seller = await trader('sel', 0, { 'frag:packet': 10 });
    const buyer = await trader('buy', 1000);
    expect((await seller.order('SELL', 50, 4)).body).toMatchObject({ order: { status: 'OPEN', remaining: 4 }, fills: [] });
    expect((await seller.order('SELL', 60, 2)).status).toBe(200);
    expect((await buyer.order('BUY', 40, 5)).body.order).toMatchObject({ status: 'OPEN', remaining: 5 });
    expect(await seller.vault()).toEqual({ 'frag:packet': 4 });
    expect(await buyer.bits()).toBe(800);
    const book = (await buyer.get('/book/frag:packet')).body;
    expect(book).toMatchObject({ bids: [{ price: 40, qty: 5 }], asks: [{ price: 50, qty: 4 }, { price: 60, qty: 2 }], fills: [] });
    const items = (await buyer.get('/items')).body as Array<{ id: string; bid: number | null; ask: number | null }>;
    expect(items.find((i) => i.id === 'frag:packet')).toMatchObject({ bid: 40, ask: 50 });
    expect((await buyer.get('/orders')).body).toHaveLength(1);
    expect((await buyer.get('/book/nonsense')).status).toBe(400);
    expect((await seller.order('SELL', 50, 99)).status).toBe(400);
    expect((await buyer.order('BUY', 1000, 5)).status).toBe(402);
    expect((await buyer.order('BUY', 0, 5)).status).toBe(400);
  });

  it('matches best price first, then oldest, at the resting price; refunds the difference; the seller pays 1/16', async () => {
    const a = await trader('a', 0, { 'frag:packet': 10 });
    const b = await trader('b', 0, { 'frag:packet': 10 });
    const buyer = await trader('c', 10_000);
    await a.order('SELL', 64, 3); // older at 64
    await b.order('SELL', 48, 2); // best price
    await b.order('SELL', 64, 3); // newer at 64
    const r = await buyer.order('BUY', 80, 6);
    expect(r.body.fills).toEqual([
      { price: 48, qty: 2, fee: feeOn(96) },
      { price: 64, qty: 3, fee: feeOn(192) },
      { price: 64, qty: 1, fee: feeOn(64) },
    ]);
    expect(r.body.order).toMatchObject({ status: 'FILLED', remaining: 0 });
    expect(await buyer.vault()).toEqual({ 'frag:packet': 6 });
    expect(await buyer.bits()).toBe(10_000 - (96 + 192 + 64));
    expect(await a.bits()).toBe(192 - 12);
    expect(await b.bits()).toBe(96 - 6 + (64 - 4));
    // fills of one placement share its timestamp; their ids keep the matching order
    const fills = await prisma!.fill.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(fills.map((f) => f.sellerId)).toEqual([b.id, a.id, b.id]);
    // everyone affected is told: balances over `admin` (one push per ledger row), fills over `exchange`
    expect(bus.log.filter((l) => l.channel === 'exchange')).toHaveLength(3);
    const pushes = bus.log.filter((l) => l.channel === 'admin' && (l.message as { kind: string }).kind === 'bits').map((l) => l.message);
    expect([...new Set(pushes.map((m) => (m as { operatorId: string }).operatorId))].sort()).toEqual([a.id, b.id, buyer.id].sort());
    // each push is a valid sim BitsPush (api reason, never one of the sim's) carrying its ledger row
    const rows = new Map((await prisma!.bitsLedger.findMany()).map((l) => [l.id, l]));
    expect(pushes).toHaveLength(rows.size);
    for (const m of pushes) {
      const p = BitsPush.parse(m);
      expect(p.origin).toBe('api');
      const row = rows.get(p.ledgerId)!;
      expect({ operatorId: row.operatorId, seq: Number(row.seq), delta: Number(row.delta), reason: row.reason }).toEqual({ operatorId: p.operatorId, seq: p.seq, delta: p.delta, reason: p.reason });
    }
    for (const reason of ['exchange:escrow', 'exchange:refund', 'exchange:sale']) expect(SIM_LEDGER_REASONS.has(reason)).toBe(false);
    const ledger = await prisma!.bitsLedger.findMany({ where: { operatorId: buyer.id } });
    expect(ledger.reduce((s, l) => s + Number(l.delta), 0)).toBe(-(96 + 192 + 64));
    // the last push of each operator carries its balance after the transaction
    const last = new Map(pushes.map((m) => [(m as { operatorId: string }).operatorId, (m as { balance: number }).balance]));
    expect(last.get(buyer.id)).toBe(await buyer.bits());
    expect(last.get(b.id)).toBe(await b.bits());
  });

  it('a SELL hits resting bids at their price; partial fills rest; own orders never match', async () => {
    const buyer = await trader('b1', 5000);
    const seller = await trader('s1', 500, { 'frag:packet': 10 });
    await buyer.order('BUY', 100, 2);
    await buyer.order('BUY', 90, 2);
    await seller.order('BUY', 95, 1); // the seller's own bid must be skipped
    const r = await seller.order('SELL', 85, 5);
    expect(r.body.fills.map((f: { price: number; qty: number }) => [f.price, f.qty])).toEqual([[100, 2], [90, 2]]);
    expect(r.body.order).toMatchObject({ status: 'OPEN', remaining: 1 });
    expect(await seller.bits()).toBe(500 - 95 + (200 - 12) + (180 - 11));
    expect(await buyer.vault()).toEqual({ 'frag:packet': 4 });
    expect((await buyer.get('/book/frag:packet')).body).toMatchObject({ bids: [{ price: 95, qty: 1 }], asks: [{ price: 85, qty: 1 }] });
  });

  it('cancel returns the unfilled escrow; only the owner may cancel; orders are capped at 16', async () => {
    const buyer = await trader('b2', 10_000);
    const seller = await trader('s2', 0, { 'frag:packet': 5 });
    const buy = (await buyer.order('BUY', 10, 10)).body.order;
    const sell = (await seller.order('SELL', 500, 5)).body.order;
    expect((await seller.cancel(buy.id)).status).toBe(403);
    expect((await buyer.cancel(buy.id)).body).toEqual({ ok: true });
    expect(await buyer.bits()).toBe(10_000);
    expect((await buyer.cancel(buy.id)).status).toBe(400);
    await seller.cancel(sell.id);
    expect(await seller.vault()).toEqual({ 'frag:packet': 5 });
    expect((await buyer.cancel('nope')).status).toBe(404);
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) expect((await buyer.order('BUY', 1, 1)).status).toBe(200);
    expect((await buyer.order('BUY', 1, 1)).status).toBe(400);
  });

  it('expires orders after seven days and returns their escrow', async () => {
    const buyer = await trader('b3', 1000);
    const seller = await trader('s3', 0, { 'frag:packet': 5 });
    await buyer.order('BUY', 10, 10);
    await seller.order('SELL', 500, 5);
    expect(await expireOrders(prisma!, bus, new Date(Date.now() + ORDER_TTL_MS - 60_000))).toBe(0);
    expect(await expireOrders(prisma!, bus, new Date(Date.now() + ORDER_TTL_MS + 60_000))).toBe(2);
    expect(await buyer.bits()).toBe(1000);
    expect(await seller.vault()).toEqual({ 'frag:packet': 5 });
    expect((await prisma!.order.findMany()).map((o) => o.status)).toEqual(['EXPIRED', 'EXPIRED']);
  });

  it('conserves bits and items over random order flow: only fees leave the system', async () => {
    const rng = createRng('exchange-conservation');
    const traders = [await trader('r0', 20_000, { 'frag:packet': 200 }), await trader('r1', 20_000, { 'frag:packet': 200 }), await trader('r2', 20_000, { 'frag:packet': 200 })];
    for (let i = 0; i < 60; i++) {
      const t = rng.pick(traders);
      if (rng.chance(0.15)) {
        const open = ((await t.get('/orders')).body as Array<{ id: string; status: string }>).filter((o) => o.status === 'OPEN');
        if (open.length) await t.cancel(rng.pick(open).id);
        continue;
      }
      await t.order(rng.chance(0.5) ? 'BUY' : 'SELL', rng.int(20, 40), rng.int(1, 8));
    }
    const { bits, items, fees } = await totals(traders);
    expect(fees).toBeGreaterThan(0);
    expect(bits + fees).toBe(60_000);
    expect(items).toBe(600);
    // and every balance equals the sum of its ledger rows
    for (const t of traders) await ledgerMatches(t, 20_000);
  });

  it('validates input: price and qty bounds, integers, tradable items; max price × max qty does not overflow', async () => {
    const buyer = await trader('ov-b', 2 ** 31, {});
    const seller = await trader('ov-s', 0, { 'frag:packet': MAX_QTY, sniff: 3 });
    for (const bad of [
      { item: 'frag:packet', side: 'BUY', price: MAX_PRICE + 1, qty: 1 },
      { item: 'frag:packet', side: 'BUY', price: 1, qty: MAX_QTY + 1 },
      { item: 'frag:packet', side: 'BUY', price: 1.5, qty: 1 },
      { item: 'frag:packet', side: 'BUY', price: 1, qty: 0 },
      { item: 'frag:packet', side: 'HOLD', price: 1, qty: 1 },
      { item: 'nonsense', side: 'BUY', price: 1, qty: 1 },
      { item: 'diskExpansion', side: 'BUY', price: 1, qty: 1 },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/exchange/orders', headers: { authorization: 'Bearer dev:ov-b' }, payload: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error).toBe('validation_error');
    }
    // an empty vault of a tradable item is a 400 too
    expect((await seller.order('SELL', 1, 1, 'tap')).status).toBe(400);
    expect((await buyer.order('BUY', MAX_PRICE, MAX_QTY)).status).toBe(200);
    expect(await buyer.bits()).toBe(2 ** 31 - 2 ** 30);
    const r = await seller.order('SELL', 1, MAX_QTY);
    expect(r.body.fills).toEqual([{ price: MAX_PRICE, qty: MAX_QTY, fee: 2 ** 26 }]);
    expect(await seller.bits()).toBe(2 ** 30 - 2 ** 26);
    expect(await buyer.vault()).toEqual({ 'frag:packet': MAX_QTY });
    expect(await seller.vault()).toEqual({ sniff: 3 });
    await ledgerMatches(buyer, 2 ** 31);
    await ledgerMatches(seller, 0);
  });

  it('two crossing placements at once on one item fill exactly once (the book lock)', async () => {
    const seller = await trader('x-s', 0, { 'frag:packet': 5 });
    const b1 = await trader('x-b1', 1000);
    const b2 = await trader('x-b2', 1000);
    await seller.order('SELL', 30, 5);
    for (let round = 0; round < 4; round++) {
      // racing buyers each want all of what is left; one gets it, the other rests
      const left = (await prisma!.order.findMany({ where: { side: 'SELL', status: 'OPEN' } })).reduce((s, o) => s + o.remaining, 0);
      if (left === 0) break;
      const rs = await Promise.all([b1.order('BUY', 30, left), b2.order('BUY', 30, left)]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      const filled = rs.reduce((s, r) => s + (r.body.fills as Array<{ qty: number }>).reduce((q, f) => q + f.qty, 0), 0);
      expect(filled).toBe(left);
      for (const t of [b1, b2]) for (const o of (await t.get('/orders')).body as Array<{ id: string; status: string }>) if (o.status === 'OPEN') await t.cancel(o.id);
    }
    const { bits, items, fees } = await totals([seller, b1, b2]);
    expect(bits + fees).toBe(2000);
    expect(items).toBe(5);
    expect(((await b1.vault())['frag:packet'] ?? 0) + ((await b2.vault())['frag:packet'] ?? 0)).toBe(5);
  });

  it('bits or items spent by a concurrent placement cannot be spent again', async () => {
    const buyer = await trader('ds-b', 1000);
    const seller = await trader('ds-s', 0, { 'frag:packet': 6 });
    // two BUYs on different items (different book locks), each needs 600 of the 1000 bits
    const buys = await Promise.all([buyer.order('BUY', 100, 6, 'frag:packet'), buyer.order('BUY', 100, 6, 'sniff')]);
    expect(buys.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(buys.find((r) => r.status === 402)!.body.error).toBe('insufficient_bits');
    expect(await buyer.bits()).toBe(400);
    // two SELLs each need 4 of the 6 items
    const sells = await Promise.all([seller.order('SELL', 500, 4), seller.order('SELL', 501, 4)]);
    expect(sells.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await seller.vault()).toEqual({ 'frag:packet': 2 });
    await ledgerMatches(buyer, 1000);
  });

  it('the open-order cap holds for concurrent placements on different items', async () => {
    const buyer = await trader('cap', 100_000);
    const items = ITEMS.map((i) => i.id).slice(0, MAX_OPEN_ORDERS + 4);
    const rs = await Promise.all(items.map((item) => buyer.order('BUY', 1, 1, item)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(MAX_OPEN_ORDERS);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(4);
    expect(await prisma!.order.count({ where: { operatorId: buyer.id, status: 'OPEN' } })).toBe(MAX_OPEN_ORDERS);
    expect(await buyer.bits()).toBe(100_000 - MAX_OPEN_ORDERS);
  });

  it('the open-order cap counts only orders that have not expired yet (unswept expired ones do not block)', async () => {
    const buyer = await trader('cx', 1000);
    const past = new Date(Date.now() - 60_000);
    await prisma!.order.createMany({
      data: Array.from({ length: MAX_OPEN_ORDERS }, (_, i) => ({
        id: `cx-${i}`, operatorId: buyer.id, item: 'frag:packet', side: 'BUY' as const, price: 1, qty: 1, remaining: 1, status: 'OPEN' as const,
        createdAt: new Date(past.getTime() - ORDER_TTL_MS), expiresAt: past,
      })),
    });
    expect((await buyer.order('BUY', 1, 1)).status).toBe(200);
  });

  it('time priority is the time an order reached the book (taken after the book lock), not when its request arrived', async () => {
    const early = await trader('tp-a', 0, { 'frag:packet': 1 });
    const holder = await trader('tp-b', 0);
    const buyer = await trader('tp-c', 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    // another placement holds the book: `early`'s request arrives now but must wait for it
    const holding = prisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(${0x45584348}::int4, hashtext(${'frag:packet'}))`;
      locked();
      await gate;
      // ...and puts its own SELL on the book while `early` is still waiting
      await tx.order.create({ data: { id: 'tp-held', operatorId: holder.id, item: 'frag:packet', side: 'SELL', price: 30, qty: 1, remaining: 1, status: 'OPEN', createdAt: new Date(), expiresAt: new Date(Date.now() + ORDER_TTL_MS) } });
    }, { timeout: 20_000 });
    await hasLock;
    const placing = early.order('SELL', 30, 1);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holding;
    expect((await placing).status).toBe(200);
    // the held order was on the book first, so it fills first
    const r = await buyer.order('BUY', 30, 1);
    expect(r.body.fills).toHaveLength(1);
    expect((await prisma!.fill.findFirstOrThrow()).sellerId).toBe(holder.id);
  });

  it('cancel racing a fill: the escrow is returned or traded, never both', async () => {
    const buyer = await trader('cf-b', 100_000);
    const seller = await trader('cf-s', 0, { 'frag:packet': 100 });
    for (let i = 0; i < 8; i++) {
      const sell = (await seller.order('SELL', 10, 4)).body.order as { id: string };
      const [cancel, buy] = await Promise.all([seller.cancel(sell.id), buyer.order('BUY', 10, 3)]);
      expect(buy.status).toBe(200);
      // the cancel either came first (the buy rests) or after a partial fill (it returns the last one)
      expect(cancel.status).toBe(200);
      const filled = (buy.body.fills as Array<{ qty: number }>).reduce((s, f) => s + f.qty, 0);
      expect([0, 3]).toContain(filled);
      if (buy.body.order.status === 'OPEN') await buyer.cancel(buy.body.order.id);
    }
    const { bits, items, fees } = await totals([buyer, seller]);
    expect(bits + fees).toBe(100_000);
    expect(items).toBe(100);
    await ledgerMatches(buyer, 100_000);
    await ledgerMatches(seller, 0);
  });

  it('expiry racing a fill: an order is expired or filled, never both', async () => {
    const buyer = await trader('ef-b', 100_000);
    const seller = await trader('ef-s', 0, { 'frag:packet': 100 });
    const later = () => new Date(Date.now() + ORDER_TTL_MS + 60_000);
    for (let i = 0; i < 8; i++) {
      await seller.order('SELL', 10, 4);
      const [expired, buy] = await Promise.all([expireOrders(prisma!, bus, later()), buyer.order('BUY', 10, 4)]);
      const filled = (buy.body.fills as Array<{ qty: number }>).reduce((s, f) => s + f.qty, 0);
      // whichever ran first: the expiry closed the SELL (the BUY rests) or the BUY filled it (nothing to expire)
      expect(expired + (filled === 4 ? 1 : 0)).toBe(1);
      if (buy.body.order.status === 'OPEN') await buyer.cancel(buy.body.order.id);
    }
    const { bits, items, fees } = await totals([buyer, seller]);
    expect(bits + fees).toBe(100_000);
    expect(items).toBe(100);
    expect(await prisma!.order.count({ where: { status: 'OPEN' } })).toBe(0);
  });

  it('a sim deposit (vault intent) racing a SELL placement of the same operator and item does not deadlock', async () => {
    const store = new PrismaStore(prisma!);
    const buyer = await trader('dl-b', 100_000);
    const seller = await trader('dl-s', 0, { 'frag:packet': 64 });
    await prisma!.operator.update({ where: { id: seller.id }, data: { inventory: { 'frag:packet': 64 } } });
    await buyer.order('BUY', 10, 1000); // every SELL below fills against it: seller credit + buyer vault inside the sweep
    for (let i = 0; i < 24; i++) {
      const [deposit, sell] = await Promise.all([
        store.applyIntent({ id: `i-dl-${i}`, kind: 'vault', operatorId: seller.id, reqId: 'r', item: 'frag:packet', qty: 2 }, { seedId: 'abcd1234' }),
        seller.order('SELL', 10, 2),
      ]);
      expect(deposit).toEqual({ ok: true });
      expect(sell.status).toBe(200);
    }
    // 64 deposited (2 × 24 = 48 moved from inventory), 48 sold to the buyer
    expect(await buyer.vault()).toEqual({ 'frag:packet': 48 });
    expect(await seller.vault()).toEqual({ 'frag:packet': 64 });
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: seller.id } })).inventory).toEqual({ 'frag:packet': 16 });
    await ledgerMatches(seller, 0);
  });

  it('dev: POST /api/dev/vault seeds the caller\'s vault (tradable items only)', async () => {
    const t = await trader('dv');
    const headers = { authorization: 'Bearer dev:dv' };
    expect((await app.inject({ method: 'POST', url: '/api/dev/vault', headers, payload: { item: 'frag:packet', qty: 5 } })).json()).toEqual({ item: 'frag:packet', qty: 5 });
    expect((await app.inject({ method: 'POST', url: '/api/dev/vault', headers, payload: { item: 'frag:packet', qty: 3 } })).json()).toEqual({ item: 'frag:packet', qty: 8 });
    expect((await app.inject({ method: 'POST', url: '/api/dev/vault', headers, payload: { item: 'nonsense', qty: 3 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/dev/vault', headers, payload: { item: 'sniff', qty: 1025 } })).statusCode).toBe(400);
    expect(await t.vault()).toEqual({ 'frag:packet': 8 });
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: t.id } })).inventory).toEqual({});
  });

  it('my orders: every OPEN order however old, plus the 64 most recent closed ones; optional status filter', async () => {
    const t = await trader('mo', 100);
    const base = Date.now() - 86_400_000;
    const row = (i: number, status: 'OPEN' | 'FILLED' | 'CANCELLED') => ({
      id: `mo-${String(i).padStart(3, '0')}`, operatorId: t.id, item: 'frag:packet', side: 'BUY' as const, price: 1, qty: 1,
      remaining: status === 'OPEN' ? 1 : 0, status, createdAt: new Date(base + i * 1000), expiresAt: new Date(base + i * 1000 + ORDER_TTL_MS),
    });
    await prisma!.order.createMany({ data: [row(0, 'OPEN'), ...Array.from({ length: 70 }, (_, i) => row(i + 1, i % 10 === 0 ? 'CANCELLED' : 'FILLED'))] });
    const all = (await t.get('/orders')).body as Array<{ id: string; status: string }>;
    expect(all.filter((o) => o.status === 'OPEN').map((o) => o.id)).toEqual(['mo-000']);
    expect(all.filter((o) => o.status !== 'OPEN')).toHaveLength(64);
    expect(all.filter((o) => o.status !== 'OPEN').map((o) => o.id)).not.toContain('mo-001'); // the oldest closed fall off
    expect(((await t.get('/orders?status=OPEN')).body as Array<{ id: string }>).map((o) => o.id)).toEqual(['mo-000']);
    const cancelled = (await t.get('/orders?status=CANCELLED')).body as Array<{ status: string }>;
    expect(cancelled).toHaveLength(7);
    expect(new Set(cancelled.map((o) => o.status))).toEqual(new Set(['CANCELLED']));
    expect((await t.get('/orders?status=nonsense')).status).toBe(400);
  });

  it('every Exchange response is no-store', async () => {
    const t = await trader('ns', 100);
    for (const path of ['/items', '/book/frag:packet', '/orders', '/vault']) {
      const r = await app.inject({ method: 'GET', url: `/api/exchange${path}`, headers: { authorization: 'Bearer dev:ns' } });
      expect(r.headers['cache-control'], path).toBe('private, no-store');
    }
    expect(t.id).toBeTruthy();
  });
});

describe.skipIf(!url)('Exchange rate limits (needs DATABASE_URL)', () => {
  it('a bearer bot hammering the book and orders is limited per operator; one address shares one budget across every Exchange route', async () => {
    await truncate();
    const app = await buildApp(appOptions(new MemoryBus(), false));
    await app.ready();
    let n = 0;
    const ip = () => `10.1.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    const as = (token: string, method: 'GET' | 'POST', path: string, remoteAddress: string, payload?: object) =>
      app.inject({ method, url: `/api/exchange${path}`, remoteAddress, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    // per operator, whichever addresses and routes it uses (refused orders count too)
    for (let i = 0; i < 60; i++) expect([200, 402]).toContain((await as('dev:hammer', 'POST', '/orders', ip(), { item: 'frag:packet', side: 'BUY', price: 1, qty: 1 })).statusCode);
    for (let i = 0; i < 60; i++) expect((await as('dev:hammer', 'GET', '/book/frag:packet', ip())).statusCode).toBe(200);
    const limited = await as('dev:hammer', 'GET', '/orders', ip());
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect((await as('dev:other', 'GET', '/orders', ip())).statusCode).toBe(200);

    // per address, before authentication: refused tokens spread over the routes share one budget
    const E = '10.9.9.9';
    const paths = ['/items', '/book/frag:packet', '/orders', '/vault'];
    for (let i = 0; i < 120; i++) expect((await as('garbage', 'GET', paths[i % paths.length]!, E)).statusCode).toBe(401);
    expect((await as('dev:fresh', 'GET', '/items', E)).statusCode).toBe(429);
    expect((await as('dev:fresh', 'POST', '/orders', E, { item: 'frag:packet', side: 'BUY', price: 1, qty: 1 })).statusCode).toBe(429);
    await app.close();
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
});
