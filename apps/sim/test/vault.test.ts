import { MemoryBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { VAULT_MAX_QTY } from '@daemonet/rules';
import { parseClientMessage, type Command, type ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type Intent, type OperatorRecord } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn, type GameOptions } from '../src/runtime/game.js';
import { PrismaStore } from '../src/runtime/prisma-store.js';
import { DEPOSIT_NOT_SAVED, MemoryStore, type IntentContext } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const HOST = TEST_SUBNET.host;

function setup() {
  const world = makeWorld('vault');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y, inventory: { 'frag:packet': 10, tap: 2 } }));
  return world;
}

async function seeded(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  store.operators.set('alice', { ...mem, id: 'alice', inventory: { ...world.checkpoint('alice').inventory } });
  return store;
}

async function through(world: ReturnType<typeof setup>, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null as Intent | null };
  const intent = r.intents[0]!;
  world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
  return { reply: step(world).replies[0]!, intent };
}

describe('Exchange vault', () => {
  it('deposits leave the inventory at once and land in the vault; withdrawals come back on commit', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const dep = await through(world, store, { cmd: 'deposit', actor: self, args: { item: 'frag:packet', qty: 6 } });
    expect(dep.intent).toMatchObject({ kind: 'vault', item: 'frag:packet', qty: 6 });
    expect(dep.reply).toMatchObject({ ok: true, result: { item: 'frag:packet', inventory: 4 } });
    expect(op.inventory['frag:packet']).toBe(4);
    expect(store.vault.get('alice:frag:packet')).toBe(6);
    expect(store.operators.get('alice')!.inventory['frag:packet']).toBe(4);
    const wd = await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'frag:packet', qty: 5 } });
    expect(wd.intent).toMatchObject({ qty: -5 });
    expect(op.inventory['frag:packet']).toBe(9);
    expect(store.vault.get('alice:frag:packet')).toBe(1);
    await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'frag:packet', qty: 1 } });
    expect(store.vault.has('alice:frag:packet')).toBe(false);
    expect(op.inventory['frag:packet']).toBe(10);
  });

  it('guards: at the host, tradable items, enough in the inventory / vault; a refused intent reverts', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const cmd = (c: 'deposit' | 'withdraw', item: string, qty: number) => step(world, input('alice', { cmd: c, actor: self, args: { item, qty } })).replies[0];
    expect(cmd('deposit', 'nonsense', 1)).toMatchObject({ code: 'E_INVALID' });
    expect(cmd('deposit', 'tap', 3)).toMatchObject({ code: 'E_STATE', message: 'need 3 tap, have 2' });
    op.x += 5;
    expect(cmd('deposit', 'tap', 1)).toMatchObject({ code: 'E_RANGE' });
    op.x -= 5;
    const wd = await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'tap', qty: 1 } });
    expect(wd.reply).toMatchObject({ ok: false, message: 'not enough in the vault' });
    expect(op.inventory.tap).toBe(2);
    const r = step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'tap', qty: 2 } }));
    expect(op.inventory.tap).toBeUndefined();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(op.inventory.tap).toBe(2);
  });

  it('a daemon locked on the Exchange cannot be loaded into RAM', async () => {
    const world = setup();
    const store = await seeded(world);
    store.daemons.set('disk-1', { ...ownedRecord('pingling', 8, 0, 'disk-1'), operatorId: 'alice', location: 'DISK', lockedBy: 'listing:l1' });
    world.operators.get('alice')!.diskSlots.add(0);
    const locked = await through(world, store, { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } });
    expect(locked.reply).toMatchObject({ ok: false, message: 'locked on the Exchange' });
    store.daemons.get('disk-1')!.lockedBy = null;
    const ok = await through(world, store, { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } });
    expect(ok.reply).toMatchObject({ ok: true });
  });

  it('refuses bad quantities and non-tradable ids in the world (whatever reaches it past the protocol)', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const cmd = (c: 'deposit' | 'withdraw', item: string, qty: number) => step(world, input('alice', { cmd: c, actor: self, args: { item, qty } }));
    for (const qty of [0, -1, -5, 1.5, VAULT_MAX_QTY + 1, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity]) {
      for (const c of ['deposit', 'withdraw'] as const) {
        const r = cmd(c, 'frag:packet', qty);
        expect(r.replies[0], `${c} ${qty}`).toMatchObject({ ok: false, code: 'E_INVALID' });
        expect(r.intents).toEqual([]);
      }
    }
    for (const item of ['__proto__', 'constructor', 'diskExpansion', 'frag:nothing', '']) {
      expect(cmd('withdraw', item, 1).replies[0], item).toMatchObject({ ok: false, code: 'E_INVALID' });
    }
    expect(op.inventory).toEqual({ 'frag:packet': 10, tap: 2 });
  });

  it('a deposit and a craft in one tick cannot spend the same items; a held item is not in the inventory', () => {
    const world = makeWorld('vault');
    world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y, bits: 1000, inventory: { 'frag:packet': 4, 'frag:socket': 4, amplifier: 1 } }));
    const op = world.operators.get('alice')!;
    const r = step(
      world,
      input('alice', { cmd: 'deposit', actor: self, args: { item: 'frag:packet', qty: 4 } }),
      input('alice', { cmd: 'craft', actor: self, args: { recipeId: 'tap', qty: 1 } }),
    );
    expect(r.intents.map((i) => i.kind)).toEqual(['vault']);
    expect(r.replies).toEqual([expect.objectContaining({ ok: false, code: 'E_STATE', message: 'need 4 frag:packet, have 0' })]);
    expect(op).toMatchObject({ bits: 1000, inventory: { 'frag:socket': 4, amplifier: 1 } });
    // a second deposit of the same items in a later tick finds them gone too
    expect(step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'frag:packet', qty: 1 } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'amplifier' } }));
    expect(step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'amplifier', qty: 1 } })).replies[0]).toMatchObject({
      code: 'E_STATE',
      message: 'need 1 amplifier, have 0',
    });
  });

  it('a pending vault move is an inventory intent: checkpoints leave the inventory alone, a leave waits, travel waits', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const r = step(world, input('alice', { cmd: 'withdraw', actor: self, args: { item: 'tap', qty: 3 } }));
    const intent = r.intents[0]!;
    expect(world.inventoryInFlight('alice')).toBe(true);
    expect(world.economyInFlight('alice')).toBe(true);
    expect(world.checkpoint('alice')).toMatchObject({ inventoryInFlight: true });
    // nothing withdrawn is spendable before the commit
    expect(op.inventory.tap).toBe(2);
    expect(step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'tap', qty: 3 } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'need 3 tap, have 2' });
    op.x = TEST_SUBNET.gateways[0]!.at.x;
    op.y = TEST_SUBNET.gateways[0]!.at.y;
    expect(step(world, input('alice', { cmd: 'travel', actor: self, args: { gatewayId: 'test-testb' } })).replies[0]).toMatchObject({
      code: 'E_STATE',
      message: 'wait for pending actions',
    });
    world.completeIntent(intent.id, { ok: true });
    expect(world.inventoryInFlight('alice')).toBe(false);
    expect(world.economyInFlight('alice')).toBe(false);
    expect(op.inventory.tap).toBe(5);
    // while travelling, nothing moves
    op.x = HOST.x;
    op.y = HOST.y;
    op.travelling = true;
    const replies = step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'tap', qty: 1 } })).replies;
    expect(replies[0]).toMatchObject({ ok: true, result: { item: 'tap', inventory: 5 } }); // the withdrawal's ack
    expect(replies[1]).toMatchObject({ code: 'E_STATE', message: 'travelling' });
    expect(op.inventory.tap).toBe(5);
  });

  it('the protocol bounds the quantity to 1-1024 (whole numbers) and the SDK defaults it to 1', () => {
    const parse = (d: Record<string, unknown>) => parseClientMessage(JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: 'r1', ...d } })).ok;
    for (const c of ['deposit', 'withdraw']) {
      expect(parse({ cmd: c, actor: 'self', args: { item: 'tap', qty: 1 } })).toBe(true);
      expect(parse({ cmd: c, actor: 'self', args: { item: 'tap', qty: VAULT_MAX_QTY } })).toBe(true);
      for (const qty of [0, -1, VAULT_MAX_QTY + 1, 1.5, '3', null]) expect(parse({ cmd: c, actor: 'self', args: { item: 'tap', qty } }), `${c} ${String(qty)}`).toBe(false);
      expect(parse({ cmd: c, actor: 'self', args: { item: 'tap' } })).toBe(false);
      expect(parse({ cmd: c, actor: 'other', args: { item: 'tap', qty: 1 } })).toBe(false);
      expect(parse({ cmd: c, actor: 'self', args: { item: '', qty: 1 } })).toBe(false);
    }
  });
});

describe('MemoryStore vault intent', () => {
  it('re-validates the move against the rules and the stored inventory', async () => {
    const world = setup();
    const store = await seeded(world);
    const vault = (id: string, item: string, qty: number): Intent => ({ id, kind: 'vault', operatorId: 'alice', reqId: 'r', item, qty });
    const ctx = { seedId: 'seed0001' };
    for (const [i, [item, qty]] of ([['frag:packet', 0], ['frag:packet', 1.5], ['frag:packet', VAULT_MAX_QTY + 1], ['frag:packet', -(VAULT_MAX_QTY + 1)], ['nonsense', 1], ['__proto__', 1], ['frag:packet', Number.NaN]] as const).entries()) {
      expect(await store.applyIntent(vault(`bad-${i}`, item, qty), ctx), `${item} ${qty}`).toEqual({ ok: false, reason: 'invalid vault move' });
    }
    // more than the stored inventory holds (a forged or desynced deposit mints nothing)
    expect(await store.applyIntent(vault('over', 'tap', 3), ctx)).toEqual({ ok: false, reason: DEPOSIT_NOT_SAVED });
    expect(store.vault.size).toBe(0);
    expect(store.operators.get('alice')!.inventory).toEqual({ 'frag:packet': 10, tap: 2 });
  });
});

// ---- the runtime: a lost acknowledgement, checkpoints and leaves ----

class FakeConn implements Conn {
  static n = 0;
  readonly id = `vault-conn-${++FakeConn.n}`;
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

function game(store: MemoryStore | PrismaStore, extra: Partial<GameOptions> = {}) {
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

/** An operator in the store with a claimed starter and `inventory`, standing at the host. */
async function trader(store: MemoryStore, name: string, inventory: Record<string, number>, vault: Record<string, number> = {}) {
  const rec = await store.loadOrCreateOperator(`dev-${name}`, 'test', TEST_SUBNET.spawn);
  Object.assign(store.operators.get(rec.id)!, { name, starterClaimed: true, inventory, x: HOST.x, y: HOST.y });
  store.daemons.set(`${name}-d0`, { ...ownedRecord('tracerat', 20, 0, `${name}-d0`), operatorId: rec.id, location: 'RAM' });
  for (const [item, qty] of Object.entries(vault)) store.vault.set(`${rec.id}:${item}`, qty);
  return rec.id;
}

let req = 0;
const cmd = (c: Command) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `v${++req}`, ...c } });
const tick = (g: Game, n = 1) => {
  for (let i = 0; i < n; i++) g.tick();
};
const settle = () => new Promise((r) => setTimeout(r, 5));
/**
 * Tests that keep a vault intent failing across `settle()`s must not reach the until-known retry cap: with 1 ms retry
 * delays, 32 attempts take ~35 ms on Linux (1 ms timers) but ~500 ms on Windows (~15 ms timers), so the cap path (reload
 * required) would depend on the platform's timer resolution. The cap itself is tested in economy.test.ts.
 */
const UNCAPPED = { unknownRetryLimit: Number.MAX_SAFE_INTEGER } as const;

describe('vault intents in the runtime', () => {
  it('a withdrawal the store committed but did not acknowledge is replayed: the items arrive once', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let dropped = 0;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'vault' && dropped++ < 2) throw new Error('connection reset after commit');
      return result;
    };
    const { a, game: g } = game(store);
    const id = await trader(store, 'una', { sniff: 1 }, { tap: 5 });
    const conn = await join(g, 'una');
    await g.message(conn, cmd({ cmd: 'withdraw', actor: self, args: { item: 'tap', qty: 3 } }));
    tick(g);
    await g.flush();
    tick(g);
    expect(dropped).toBe(3);
    expect(conn.of('err')).toEqual([]);
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { item: 'tap', inventory: 3 } });
    expect(a.operators.get(id)!.inventory).toEqual({ sniff: 1, tap: 3 });
    expect(store.operators.get(id)!.inventory).toEqual({ sniff: 1, tap: 3 });
    expect(store.vault.get(`${id}:tap`)).toBe(2);
    await g.shutdown();
    expect(store.operators.get(id)!.inventory).toEqual({ sniff: 1, tap: 3 });
  });

  it('an unknown deposit outcome is retried, never refunded, and checkpoints meanwhile leave the inventory to the store', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let healthy = false;
    let lost = 0;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'vault' && !healthy) {
        lost++;
        throw new Error('connection reset after commit');
      }
      return result;
    };
    const { a, game: g } = game(store, { checkpointEveryTicks: 1, ...UNCAPPED });
    const id = await trader(store, 'vic', { tap: 4, restore: 1 });
    const conn = await join(g, 'vic');
    const checkpoints: OperatorRecord[] = [];
    const write = store.checkpoint.bind(store);
    store.checkpoint = async (records) => {
      checkpoints.push(...records.filter((r) => r.id === id).map((r) => ({ ...r, inventory: { ...r.inventory } })));
      return write(records);
    };
    await g.message(conn, cmd({ cmd: 'deposit', actor: self, args: { item: 'tap', qty: 4 } }));
    for (let i = 0; i < 12; i++) {
      tick(g);
      await settle();
    }
    expect(lost).toBeGreaterThan(4);
    expect(a.inventoryInFlight(id)).toBe(true);
    expect(conn.of('err')).toEqual([]);
    expect(a.operators.get(id)!.inventory).toEqual({ restore: 1 });
    expect(checkpoints.length).toBeGreaterThan(4);
    // the one save queued ahead of the deposit (pre-deposit inventory), then only checkpoints that leave it alone
    const flagged = checkpoints.findIndex((r) => r.inventoryInFlight);
    expect(flagged).toBeGreaterThan(0);
    for (const r of checkpoints.slice(0, flagged)) expect(r.inventory).toEqual({ tap: 4, restore: 1 });
    expect(checkpoints.slice(flagged).every((r) => r.inventoryInFlight)).toBe(true);
    // the leave waits for the deposit
    g.disconnect(conn);
    tick(g, 8);
    expect(g.worldOf(id)).toBe(a);
    healthy = true;
    await g.flush();
    tick(g);
    await g.flush();
    tick(g);
    await g.flush();
    expect(g.worldOf(id)).toBeUndefined();
    expect(store.operators.get(id)!.inventory).toEqual({ restore: 1 });
    expect(store.vault.get(`${id}:tap`)).toBe(4);
    await g.shutdown();
    expect(store.operators.get(id)!.inventory).toEqual({ restore: 1 });
    expect(store.vault.get(`${id}:tap`)).toBe(4);
  });
});

// ---- items gained world-side since the last checkpoint (unhold, hold swap, ...) can be deposited at once ----

/** A store with a trader `hal` at the host: `sniff: 1` in the inventory, an amplifier held by `hal-d0`, nothing vaulted. */
interface Fixture {
  store: MemoryStore | PrismaStore;
  id: string;
  inventory(): Promise<Record<string, number>>;
  vault(): Promise<Record<string, number>>;
  heldItem(): Promise<string | null>;
  close(): Promise<void>;
}

async function memoryFixture(store = new MemoryStore()): Promise<Fixture> {
  const id = await trader(store, 'hal', { sniff: 1 });
  store.daemons.get('hal-d0')!.heldItem = 'amplifier';
  const prefix = `${id}:`;
  return {
    store,
    id,
    inventory: async () => ({ ...store.operators.get(id)!.inventory }),
    vault: async () => Object.fromEntries([...store.vault].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])),
    heldItem: async () => store.daemons.get('hal-d0')!.heldItem,
    close: async () => {},
  };
}

const url = process.env.DATABASE_URL;

async function prismaFixture(): Promise<Fixture> {
  const prisma = createPrisma(url!);
  await prisma.$executeRawUnsafe('TRUNCATE "Daemon", "DaemonArchive", "BitsLedger", "Ticket", "Research", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "Incident", "ExchangeVault" CASCADE');
  const store = new PrismaStore(prisma);
  const rec = await store.loadOrCreateOperator('dev-hal', 'test', TEST_SUBNET.spawn);
  const claim: Intent = {
    id: 'i-hal-claim',
    kind: 'claimStarter',
    operatorId: rec.id,
    reqId: 'r',
    name: 'hal',
    daemon: { ...ownedRecord('tracerat', 20, 0, 'hal-d0'), heldItem: 'amplifier' },
    inventory: { sniff: 1 },
    log: { originalOperatorId: rec.id, capturedAtTick: 1, subnet: 'test', tool: 'starter', seedId: 'abcd1234', spawnIndex: null },
  };
  expect(await store.applyIntent(claim, { seedId: 'abcd1234' })).toMatchObject({ ok: true });
  await prisma.operator.update({ where: { id: rec.id }, data: { x: HOST.x, y: HOST.y } });
  return {
    store,
    id: rec.id,
    inventory: async () => (await prisma.operator.findUniqueOrThrow({ where: { id: rec.id } })).inventory as Record<string, number>,
    vault: async () => Object.fromEntries((await prisma.exchangeVault.findMany({ where: { operatorId: rec.id } })).map((v) => [v.item, v.qty])),
    heldItem: async () => (await prisma.daemon.findUniqueOrThrow({ where: { id: 'hal-d0' } })).heldItem,
    close: () => prisma.$disconnect(),
  };
}

const send = (g: Game, conn: FakeConn, c: Command) => g.message(conn, cmd(c));
const unhold: Command = { cmd: 'unhold', actor: self, args: { daemonId: 'hal-d0' } };
const hold: Command = { cmd: 'hold', actor: self, args: { daemonId: 'hal-d0', itemId: 'amplifier' } };
const deposit = (item: string, qty = 1): Command => ({ cmd: 'deposit', actor: self, args: { item, qty } });

function unholdThenDeposit(name: string, make: () => Promise<Fixture>) {
  describe(`deposits right after a world-side gain (${name})`, () => {
    it('unhold, then deposit at once: the store sees the saved inventory; nothing is refused or duplicated', async () => {
      const f = await make();
      // no periodic checkpoint can help: only the save queued ahead of the deposit writes the unheld amplifier
      const { a, game: g } = game(f.store, { checkpointEveryTicks: 100_000 });
      const conn = await join(g, 'hal');
      await send(g, conn, unhold);
      tick(g);
      await send(g, conn, deposit('amplifier'));
      tick(g);
      await g.flush();
      tick(g);
      expect(conn.of('err')).toEqual([]);
      expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { item: 'amplifier', inventory: 0 } });
      expect(a.operators.get(f.id)!.inventory).toEqual({ sniff: 1 });
      expect(await f.inventory()).toEqual({ sniff: 1 });
      expect(await f.vault()).toEqual({ amplifier: 1 });
      expect(await f.heldItem()).toBeNull();
      // withdraw and hold it again; then unhold and two deposits in one tick: one save covers both
      await send(g, conn, { cmd: 'withdraw', actor: self, args: { item: 'amplifier', qty: 1 } });
      tick(g);
      await g.flush();
      tick(g);
      await send(g, conn, hold);
      tick(g);
      await send(g, conn, unhold);
      await send(g, conn, deposit('amplifier'));
      await send(g, conn, deposit('sniff'));
      tick(g);
      await g.flush();
      tick(g);
      expect(conn.of('err')).toEqual([]);
      expect(a.operators.get(f.id)!.inventory).toEqual({});
      expect(await f.inventory()).toEqual({});
      expect(await f.vault()).toEqual({ amplifier: 1, sniff: 1 });
      await g.shutdown();
      expect(await f.inventory()).toEqual({});
      expect(await f.vault()).toEqual({ amplifier: 1, sniff: 1 });
      expect(await f.heldItem()).toBeNull();
      await f.close();
    });

    it('a crash between the save and the deposit loses nothing: the store keeps the saved inventory and no vault row', async () => {
      const f = await make();
      const apply = f.store.applyIntent.bind(f.store);
      // the deposit never reaches the store (its outcome stays unknown until shutdown abandons it)
      f.store.applyIntent = async (intent: Intent, ctx: IntentContext) => {
        if (intent.kind === 'vault') throw new Error('connection reset');
        return apply(intent, ctx);
      };
      const { game: g } = game(f.store, { checkpointEveryTicks: 100_000, ...UNCAPPED });
      const conn = await join(g, 'hal');
      await send(g, conn, unhold);
      tick(g);
      await send(g, conn, deposit('amplifier'));
      for (let i = 0; i < 4; i++) {
        tick(g);
        await settle();
      }
      await g.shutdown();
      expect(conn.of('err')).toEqual([]);
      expect(await f.inventory()).toEqual({ sniff: 1, amplifier: 1 });
      expect(await f.vault()).toEqual({});
      expect(await f.heldItem()).toBeNull();
      await f.close();
    });

    it('a deposit whose acknowledgement is lost commits once; the save is never replayed over it', async () => {
      const f = await make();
      const apply = f.store.applyIntent.bind(f.store);
      let lost = 0;
      f.store.applyIntent = async (intent: Intent, ctx: IntentContext) => {
        const result = await apply(intent, ctx);
        if (intent.kind === 'vault' && lost++ < 6) throw new Error('connection reset after commit');
        return result;
      };
      const { a, game: g } = game(f.store, { checkpointEveryTicks: 100_000 });
      const conn = await join(g, 'hal');
      await send(g, conn, unhold);
      tick(g);
      await send(g, conn, deposit('amplifier'));
      for (let i = 0; i < 12; i++) {
        tick(g);
        await settle();
      }
      await g.flush();
      tick(g);
      await g.flush();
      expect(lost).toBe(7);
      expect(conn.of('err')).toEqual([]);
      expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { item: 'amplifier', inventory: 0 } });
      expect(a.operators.get(f.id)!.inventory).toEqual({ sniff: 1 });
      await g.shutdown();
      expect(await f.inventory()).toEqual({ sniff: 1 });
      expect(await f.vault()).toEqual({ amplifier: 1 });
      await f.close();
    });
  });
}

unholdThenDeposit('MemoryStore', () => memoryFixture());
describe.skipIf(!url)('with DATABASE_URL', () => {
  unholdThenDeposit('PrismaStore', prismaFixture);
});

describe('a deposit while another inventory intent is in flight', () => {
  it('is refused with the retryable reason and refunded exactly; a retry once it settles succeeds', async () => {
    class GatedBuys extends MemoryStore {
      gate: Promise<void> | null = null;
      override async applyIntent(intent: Intent, ctx: IntentContext) {
        if (intent.kind === 'buy' && this.gate) await this.gate;
        return super.applyIntent(intent, ctx);
      }
    }
    const store = new GatedBuys();
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    const f = await memoryFixture(store);
    await store.grantBits(f.id, 1000, 'admin');
    const { a, game: g } = game(store, { checkpointEveryTicks: 100_000 });
    const conn = await join(g, 'hal');
    await send(g, conn, unhold);
    tick(g);
    await send(g, conn, { cmd: 'buy', actor: self, args: { itemId: 'sniff', qty: 1 } });
    tick(g);
    await send(g, conn, deposit('amplifier'));
    tick(g);
    expect(a.operators.get(f.id)!.inventory).toEqual({ sniff: 1 }); // the deposit was taken at accept
    open();
    await g.flush();
    tick(g);
    expect(conn.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: DEPOSIT_NOT_SAVED });
    expect(a.operators.get(f.id)!.inventory).toEqual({ sniff: 2, amplifier: 1 });
    expect(await f.vault()).toEqual({});
    expect(await f.inventory()).toEqual({ sniff: 2 });
    // nothing else in flight now: the retry saves first and goes through
    await send(g, conn, deposit('amplifier'));
    tick(g);
    await g.flush();
    tick(g);
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { item: 'amplifier', inventory: 0 } });
    expect(await f.inventory()).toEqual({ sniff: 2 });
    expect(await f.vault()).toEqual({ amplifier: 1 });
    await g.shutdown();
    expect(await f.inventory()).toEqual({ sniff: 2 });
  });
});
