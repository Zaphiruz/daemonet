import { MemoryBus } from '@daemonet/bus';
import { VAULT_MAX_QTY } from '@daemonet/rules';
import { parseClientMessage, type Command, type ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type Intent, type OperatorRecord } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn, type GameOptions } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
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
    expect(await store.applyIntent(vault('over', 'tap', 3), ctx)).toEqual({ ok: false, reason: 'not enough tap' });
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
    const { a, game: g } = game(store, { checkpointEveryTicks: 1 });
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
    expect(checkpoints.every((r) => r.inventoryInFlight)).toBe(true);
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
