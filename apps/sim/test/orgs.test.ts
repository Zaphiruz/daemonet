import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { OrgMembershipPush, OrgViewSchema } from '../src/runtime/pushes.js';
import { MemoryStore, type LiveOperatorState } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

const ROOT = { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' } as const;

function setup<S extends MemoryStore = MemoryStore>(store: S = new MemoryStore() as S) {
  const bus = new MemoryBus();
  const world = new World({ subnet: TEST_SUBNET, seed: 'o', seedId: 'aaaa0001', spawner: false });
  const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
  const join = async (name: string) => {
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
    return conn;
  };
  return { store, bus, world, game, join };
}

/** The api's push for a ledger row it wrote (task 2 publishes exactly this shape). */
const bitsPush = (operatorId: string, row: { id: string; seq: number; balance: number }, delta: number, reason: string) => ({
  kind: 'bits',
  operatorId,
  ledgerId: row.id,
  seq: row.seq,
  delta,
  reason,
  balance: row.balance,
  origin: 'api',
});

const bitsEvents = (conn: FakeConn) => conn.of('delta').flatMap((m) => m.d.events.filter((e) => e.e === 'bits'));

describe('org membership, balance and rename pushes from the api', () => {
  it('loads the org with the record, shows the tag on entities and chat, and follows bus updates', async () => {
    const { store, bus, world, game, join } = setup();
    const recA = await store.loadOrCreateOperator('dev-alice', 'test', world.subnet.spawn);
    store.orgs.set(recA.id, { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' });
    const alice = await join('alice');
    const bob = await join('bob');
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    expect(alice.of('snapshot')[0]!.d.self.org).toEqual({ id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' });
    expect(bob.of('snapshot')[0]!.d.self.org).toBeNull();
    expect(bob.of('snapshot')[0]!.d.entities.find((e) => e.id === recA.id)).toMatchObject({ kind: 'operator', tag: 'ROOT' });

    // bob joins the org through the api
    await bus.publish('org', { kind: 'membership', operatorId: bobId, org: { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'MEMBER' } });
    game.tick();
    expect(bob.of('delta').at(-1)!.d.self!.org).toMatchObject({ tag: 'ROOT', rank: 'MEMBER' });
    // everyone nearby sees bob's tag appear
    expect(alice.of('delta').at(-1)!.d.upserts).toContainEqual(expect.objectContaining({ id: bobId, tag: 'ROOT' }));
    await game.message(alice, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c1', cmd: 'chat', actor: 'self', args: { channel: 'org:o1', text: 'welcome' } } }));
    await game.flush();
    expect(bob.of('chat').at(-1)!.d).toMatchObject({ channel: 'org:o1', tag: 'ROOT', text: 'welcome' });

    // bits spent in the api and a rename reach the live operator
    const row = await store.grantBits(bobId, 500, 'admin');
    await bus.publish('admin', bitsPush(bobId, row, 500, 'admin'));
    await bus.publish('admin', { kind: 'rename', operatorId: bobId, name: 'robert', origin: 'api' });
    game.tick();
    const d = bob.of('delta').at(-1)!.d;
    expect(d.self).toMatchObject({ bits: 500, name: 'robert' });
    expect(d.events).toContainEqual({ e: 'bits', delta: 500, reason: 'admin', balance: 500 });

    // kicked: the tag and the channel go away
    await bus.publish('org', { kind: 'membership', operatorId: bobId, org: null });
    game.tick();
    expect(bob.of('delta').at(-1)!.d.self!.org).toBeNull();
    await new Promise((r) => setTimeout(r, 2100));
    await game.message(bob, JSON.stringify({ t: 'cmd', seq: 3, d: { reqId: 'c2', cmd: 'chat', actor: 'self', args: { channel: 'org:o1', text: 'still here?' } } }));
    await game.flush();
    expect(bob.of('err').at(-1)!.d).toMatchObject({ reqId: 'c2', code: 'E_STATE' });
    await game.shutdown();
  });

  it('a bits push is a delta applied once per ledger row; rows already in the loaded balance, echoes, malformed pushes and offline operators are ignored', async () => {
    const { store, bus, world, game, join } = setup();
    const rec = await store.loadOrCreateOperator('dev-alice', 'test', world.subnet.spawn);
    const before = await store.grantBits(rec.id, 100, 'admin');
    const alice = await join('alice');
    const op = world.operators.get(rec.id)!;
    expect(op.bits).toBe(100);

    // a row the loaded balance already reflects (committed before the load) is not applied again
    await bus.publish('admin', bitsPush(rec.id, before, 100, 'admin'));
    game.tick();
    expect(op.bits).toBe(100);

    // a new row: applied once, however often it is delivered
    const spend = await store.grantBits(rec.id, -30, 'org');
    for (let i = 0; i < 3; i++) await bus.publish('admin', bitsPush(rec.id, spend, -30, 'org'));
    game.tick();
    expect(op.bits).toBe(70);
    expect(bitsEvents(alice)).toEqual([{ e: 'bits', delta: -30, reason: 'org', balance: 70 }]);

    // untrusted input: wrong types, missing ledger id, the sim's own echo, unknown operators
    const next = await store.grantBits(rec.id, 5, 'admin');
    await bus.publish('admin', { ...bitsPush(rec.id, next, 5, 'admin'), delta: '5' });
    await bus.publish('admin', { ...bitsPush(rec.id, next, 5, 'admin'), delta: 1.5 });
    await bus.publish('admin', { kind: 'bits', operatorId: rec.id, delta: 5, reason: 'admin', balance: 75 });
    await bus.publish('admin', { ...bitsPush(rec.id, next, 5, 'admin'), origin: 'sim' });
    await bus.publish('admin', bitsPush('nobody', next, 5, 'admin'));
    await bus.publish('admin', null);
    await bus.publish('org', { kind: 'membership', operatorId: rec.id, org: { id: 'o1', name: 'x', tag: 'ROOT', rank: 'KING' } });
    await bus.publish('admin', { kind: 'rename', operatorId: rec.id, name: 'NOT A NAME' });
    game.tick();
    expect(op.bits).toBe(70);
    expect(op.org).toBeNull();
    expect(op.name).toBeNull();

    // an operator not loaded in any world ignores pushes and loads the stored balance when it connects
    const carol = await store.loadOrCreateOperator('dev-carol', 'test', world.subnet.spawn);
    const gift = await store.grantBits(carol.id, 40, 'admin');
    await bus.publish('admin', bitsPush(carol.id, gift, 40, 'admin'));
    await join('carol');
    expect(world.operators.get(carol.id)!.bits).toBe(40);
    await bus.publish('admin', bitsPush(carol.id, gift, 40, 'admin'));
    game.tick();
    expect(world.operators.get(carol.id)!.bits).toBe(40);
    await game.shutdown();
  });

  it('org membership, names and balances changed while the bus was down are re-read from the store on resync', async () => {
    const { store, bus, world, game, join } = setup();
    const alice = await join('alice');
    const id = alice.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    await store.grantBits(id, 1000, 'admin'); // after the load: a pushed message that was lost
    // the bus was down: the api wrote these and its pushes were lost
    store.orgs.set(id, ROOT);
    store.operators.get(id)!.name = 'alicia';
    const lost = await store.grantBits(id, -300, 'rename');
    expect(op).toMatchObject({ org: null, name: null, bits: 0 });

    await game.chat.resync();
    game.tick();
    expect(op).toMatchObject({ org: ROOT, name: 'alicia', bits: 700 });
    expect(bitsEvents(alice)).toEqual([
      { e: 'bits', delta: 1000, reason: 'admin', balance: 1000 },
      { e: 'bits', delta: -300, reason: 'rename', balance: 700 },
    ]);
    // a second resync and a late delivery of a row the resync applied change nothing
    await game.chat.resync();
    await bus.publish('admin', bitsPush(id, lost, -300, 'rename'));
    game.tick();
    expect(op.bits).toBe(700);
    expect(bitsEvents(alice)).toHaveLength(2);
    // a row the resync applied, delivered once it is below the advanced watermark, is ignored too
    const more = await store.grantBits(id, 11, 'admin');
    await game.chat.resync();
    expect(op.bits).toBe(711);
    await bus.publish('admin', bitsPush(id, more, 11, 'admin'));
    expect(op.bits).toBe(711);
    await game.shutdown();
  });

  it('a push that lands while a resync read is in flight wins over what the read returned', async () => {
    class GatedLive extends MemoryStore {
      gate: Promise<void> | null = null;
      override async liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>> {
        const state = await super.liveState(after);
        if (this.gate) await this.gate;
        return state;
      }
    }
    const { store, bus, world, game, join } = setup(new GatedLive());
    const alice = await join('alice');
    const id = alice.of('authOk')[0]!.d.operatorId;
    const op = world.operators.get(id)!;
    store.orgs.set(id, ROOT);
    store.operators.get(id)!.name = 'alicia';
    const row = await store.grantBits(id, 50, 'admin');
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    const resync = game.chat.resync();
    await new Promise((r) => setTimeout(r, 5));
    // meanwhile the api kicks alice, renames her again and its bits push arrives first
    store.orgs.delete(id);
    await bus.publish('org', { kind: 'membership', operatorId: id, org: null });
    await bus.publish('admin', { kind: 'rename', operatorId: id, name: 'ally', origin: 'api' });
    await bus.publish('admin', bitsPush(id, row, 50, 'admin'));
    expect(op.bits).toBe(50);
    open();
    await resync;
    expect(op).toMatchObject({ org: null, name: 'ally', bits: 50 });
    await game.shutdown();
  });

  it('pushes dropped while the operator was loading are recovered as soon as the session exists (no wait for the periodic resync)', async () => {
    class GatedLoad extends MemoryStore {
      gate: Promise<void> | null = null;
      loading: (() => void) | null = null;
      override async loadOrCreateOperator(...args: Parameters<MemoryStore['loadOrCreateOperator']>) {
        const rec = await super.loadOrCreateOperator(...args);
        this.loading?.();
        if (this.gate) await this.gate;
        return rec;
      }
    }
    const { store, bus, world, game, join } = setup(new GatedLoad());
    const pre = await store.loadOrCreateOperator('dev-alice', 'test', world.subnet.spawn);
    let open!: () => void;
    store.gate = new Promise<void>((r) => (open = r));
    const loaded = new Promise<void>((r) => (store.loading = r));
    const joining = join('alice');
    await loaded;
    // the load has read the row; the api commits and pushes now, before the session exists (the pushes are dropped)
    store.orgs.set(pre.id, ROOT);
    store.operators.get(pre.id)!.name = 'alicia';
    const row = await store.grantBits(pre.id, 250, 'admin');
    await bus.publish('org', { kind: 'membership', operatorId: pre.id, org: ROOT, origin: 'api' });
    await bus.publish('admin', { kind: 'rename', operatorId: pre.id, name: 'alicia', origin: 'api' });
    await bus.publish('admin', bitsPush(pre.id, row, 250, 'admin'));
    open();
    const alice = await joining;
    await new Promise((r) => setTimeout(r, 5));
    const op = world.operators.get(pre.id)!;
    expect(op).toMatchObject({ org: ROOT, name: 'alicia', bits: 250 });
    game.tick();
    expect(bitsEvents(alice)).toEqual([{ e: 'bits', delta: 250, reason: 'admin', balance: 250 }]);
    // a late redelivery of the recovered row is not applied twice
    await bus.publish('admin', bitsPush(pre.id, row, 250, 'admin'));
    expect(op.bits).toBe(250);
    await game.shutdown();
  });

  it('a rename refreshes the cluster views of every member', async () => {
    const { bus, world, game, join } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    const made = game.clusters.ensure(aliceId) as { clusterId: string; code: string };
    expect(game.clusters.join(bobId, made.code)).toEqual({ clusterId: made.clusterId });
    await bus.publish('admin', { kind: 'rename', operatorId: bobId, name: 'robert', origin: 'api' });
    expect(world.operators.get(aliceId)!.cluster!.members).toContainEqual(expect.objectContaining({ id: bobId, name: 'robert' }));
    await game.shutdown();
  });
});

describe('OrgViewSchema', () => {
  it("accepts exactly the api's tag rule: 4 upper-case letters or digits", () => {
    const view = (tag: string) => ({ id: 'o1', name: 'Root Access', tag, rank: 'MEMBER' });
    for (const tag of ['ROOT', 'A1B2', '0000']) expect(OrgViewSchema.safeParse(view(tag)).success).toBe(true);
    for (const tag of ['', 'R', 'ROO', 'ROOTS', 'ROOTROOT', 'root', 'R T1', 'RO-T', '[R]1']) expect(OrgViewSchema.safeParse(view(tag)).success, tag).toBe(false);
    expect(OrgMembershipPush.safeParse({ kind: 'membership', operatorId: 'x', org: view('ROOTROOT') }).success).toBe(false);
  });
});
