import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, type Intent, type IntentResult, type OperatorRecord } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn, type GameOptions } from '../src/runtime/game.js';
import { MemoryStore, type IntentContext } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const GATE = TEST_SUBNET.gateways[0]!;

describe('travel command', () => {
  function ready() {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: GATE.at.x, y: GATE.at.y }));
    return world;
  }
  const travel = (world: World, gatewayId = GATE.id) => step(world, input('alice', { cmd: 'travel', actor: self, args: { gatewayId } }));

  it('checks the gateway, the distance, running daemons, the level gate and pending work', () => {
    const world = ready();
    const op = world.operators.get('alice')!;
    expect(travel(world, 'nope').replies[0]).toMatchObject({ code: 'E_INVALID' });
    op.x = GATE.at.x - 3;
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_RANGE' });
    op.x = GATE.at.x;
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'recall running daemons first' });
    world.deactivate(world.daemons.get('alice-d0')!);
    for (const id of op.ram) world.daemons.get(id)!.level = 9;
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'testb needs a level 10 daemon' });
    world.daemons.get('alice-d0')!.level = 10;
    op.captureId = 'c1';
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'a capture is in progress' });
    op.captureId = null;
    const r = travel(world);
    expect(r.replies).toEqual([]);
    expect(r.intents[0]).toMatchObject({ kind: 'travel', operatorId: 'alice', gatewayId: GATE.id, from: 'test', to: 'testb', x: 3.5, y: 3.5 });
    expect(op.travelling).toBe(true);
    // locked while the intent is pending; a second travel is refused as pending work once unlocked
    expect(step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 10, y: 10 } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'travelling' });
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'db down' });
    expect(op.travelling).toBe(false);
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'db down' });
    const r2 = travel(world);
    expect(world.hasPendingFor('alice')).toBe(true);
    world.completeIntent(r2.intents[0]!.id, { ok: true });
    expect(step(world).replies[0]).toMatchObject({ ok: true, result: { subnet: 'testb' } });
  });

  it('refuses while another action of the operator is still pending', () => {
    const world = ready();
    const op = world.operators.get('alice')!;
    const ev = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId: 'echolet' } }));
    expect(ev.intents[0]).toMatchObject({ kind: 'evolve' });
    expect(world.hasPendingFor('alice')).toBe(true);
    expect(travel(world).replies[0]).toMatchObject({ code: 'E_STATE', message: 'wait for pending actions' });
    expect(op.travelling).toBe(false);
  });

  it('every command is refused while travelling', () => {
    const world = ready();
    const r = travel(world);
    expect(r.intents).toHaveLength(1);
    for (const command of [
      { cmd: 'travel', actor: self, args: { gatewayId: GATE.id } },
      { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } },
      { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId: 'echolet' } },
      { cmd: 'restoreAll', actor: self, args: {} },
    ] as const) {
      expect(step(world, input('alice', command)).replies[0]).toMatchObject({ code: 'E_STATE', message: 'travelling' });
    }
  });

  it('checkpoints carry the subnet', () => {
    expect(ready().checkpoint('alice').subnet).toBe('test');
  });
});

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
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

function setup(store = new MemoryStore(), extra: Partial<GameOptions> = {}) {
  const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
  const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false, clock: () => FIXED_CLOCK });
  const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4, ...extra });
  return { a, b, game, store };
}

async function join(game: Game, name: string, extra: Record<string, unknown> = {}) {
  const conn = new FakeConn();
  game.connect(conn);
  await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...extra } }));
  return conn;
}

let req = 0;
const cmd = (c: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `q${++req}`, ...c } });
const travelCmd = () => cmd({ cmd: 'travel', actor: 'self', args: { gatewayId: GATE.id } });

/** alice joins world `a`, claims a starter and stands on the gateway with a level 10 daemon. */
async function atGate(game: Game, a: World, name = 'alice') {
  const conn = await join(game, name);
  await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: name } }));
  game.tick();
  await game.flush();
  game.tick();
  const op = a.operators.get(conn.of('authOk')[0]!.d.operatorId)!;
  op.x = GATE.at.x;
  op.y = GATE.at.y;
  a.daemons.get(op.ram[0]!)!.level = 10;
  return { conn, op };
}

/** MemoryStore that can hold travel intents and checkpoint writes, and records every checkpoint batch. */
class GatedStore extends MemoryStore {
  readonly batches: OperatorRecord[][] = [];
  private travelGate: { promise: Promise<void>; open: () => void } | null = null;
  private checkpointGate: { promise: Promise<void>; open: () => void } | null = null;

  private static gate() {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  }
  holdTravel() {
    this.travelGate = GatedStore.gate();
  }
  releaseTravel() {
    this.travelGate?.open();
    this.travelGate = null;
  }
  holdCheckpoints() {
    this.checkpointGate = GatedStore.gate();
  }
  releaseCheckpoints() {
    this.checkpointGate?.open();
    this.checkpointGate = null;
  }
  override async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (intent.kind === 'travel' && this.travelGate) await this.travelGate.promise;
    return super.applyIntent(intent, ctx);
  }
  override async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    this.batches.push(records.map((r) => ({ ...r })));
    if (this.checkpointGate) await this.checkpointGate.promise;
    return super.checkpoint(records);
  }
}

describe('multi-world Game', () => {
  it('binds sessions to the operator’s subnet, falling back to the default world for unhosted subnets', async () => {
    const { a, b, game, store } = setup();
    const alice = await join(game, 'alice');
    expect(alice.of('snapshot')[0]!.d.subnet).toBe('test');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join(game, 'bob');
    expect(bob.of('snapshot')[0]!.d.subnet).toBe('testb');
    expect(b.operators.has(rec.id)).toBe(true);
    expect(a.operators.has(rec.id)).toBe(false);
    const rec2 = await store.loadOrCreateOperator('dev-carol', 'test', a.subnet.spawn);
    store.operators.get(rec2.id)!.subnet = 'nowhere';
    const carol = await join(game, 'carol');
    expect(carol.of('snapshot')[0]!.d.subnet).toBe('test');
    expect(carol.of('snapshot')[0]!.d.self).toMatchObject({ x: a.subnet.spawn.x, y: a.subnet.spawn.y });
    // every world ticks
    game.tick();
    expect([a.tick, b.tick]).toEqual([1, 1]);
    expect(alice.of('delta')).toHaveLength(1);
    expect(bob.of('delta')).toHaveLength(1);
  });

  it('hands a travelling operator over to the destination world with a fresh snapshot, and remembers it across a restart', async () => {
    const store = new MemoryStore();
    const { a, b, game } = setup(store);
    const conn = await join(game, 'alice');
    await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice' } }));
    game.tick();
    await game.flush();
    game.tick();
    const op = a.operators.get(conn.of('authOk')[0]!.d.operatorId)!;
    op.x = GATE.at.x;
    op.y = GATE.at.y;
    a.daemons.get(op.ram[0]!)!.level = 10;
    await game.message(conn, cmd({ cmd: 'travel', actor: 'self', args: { gatewayId: GATE.id } }));
    game.tick();
    await game.flush();
    expect(a.operators.has(op.id)).toBe(false);
    expect(b.operators.get(op.id)).toMatchObject({ x: 3.5, y: 3.5 });
    expect(b.operators.get(op.id)!.ram).toEqual(op.ram);
    const snap = conn.of('snapshot').at(-1)!;
    expect(snap.d.subnet).toBe('testb');
    expect(snap.d.self.ram.map((d) => d.id)).toEqual(op.ram);
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { subnet: 'testb' } });
    expect(conn.of('delta').at(-1)!.d.events).toContainEqual({ e: 'travelled', from: 'test', to: 'testb' });
    expect(game.worldOf(op.id)).toBe(b);
    // commands now run in the destination world
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 6, y: 6 } }));
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toEqual({ reqId: `q${req}` });
    expect(b.operators.get(op.id)!.path.length).toBeGreaterThan(0);
    await game.shutdown();

    const again = setup(store);
    const back = await join(again.game, 'alice');
    expect(back.of('snapshot')[0]!.d.subnet).toBe('testb');
    expect(again.b.operators.has(op.id)).toBe(true);
  });

  it('refuses a gateway to a subnet this process does not host', async () => {
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
    const game = new Game({ worlds: [a], store: new MemoryStore(), verify: createDevVerifier('daemonet-users'), retryDelaysMs: [1, 1, 1] });
    const { conn, op } = await atGate(game, a);
    await game.message(conn, travelCmd());
    game.tick();
    expect(conn.of('err').at(-1)!.d).toMatchObject({ reqId: `q${req}`, code: 'E_STATE', message: 'testb is not available' });
    expect(op.travelling).toBe(false);
    expect(a.operators.has(op.id)).toBe(true);
  });

  it('a travel the store failed to persist leaves the operator where it was', async () => {
    const { a, b, game, store } = setup();
    const { conn, op } = await atGate(game, a);
    store.failNext = 4;
    await game.message(conn, travelCmd());
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('err').at(-1)!.d).toMatchObject({ reqId: `q${req}`, code: 'E_STATE', message: 'persist failed' });
    expect(op.travelling).toBe(false);
    expect(a.operators.has(op.id)).toBe(true);
    expect(b.operators.has(op.id)).toBe(false);
    expect(store.operators.get(op.id)!.subnet).toBe('test');
  });

  it('a travel the store committed but did not acknowledge is replayed and hands over exactly once', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let dropped = false;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'travel' && !dropped) {
        dropped = true;
        throw new Error('connection reset after commit');
      }
      return result;
    };
    const { a, b, game } = setup(store);
    const { conn, op } = await atGate(game, a);
    await game.message(conn, travelCmd());
    game.tick();
    await game.flush();
    game.tick();
    expect(dropped).toBe(true);
    expect(b.operators.has(op.id)).toBe(true);
    expect(a.operators.has(op.id)).toBe(false);
    expect(conn.of('snapshot').filter((s) => s.d.subnet === 'testb')).toHaveLength(1);
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ reqId: `q${req}`, result: { subnet: 'testb' } });
    expect(conn.of('delta').flatMap((d) => d.d.events).filter((e) => e.e === 'travelled')).toHaveLength(1);
  });

  it('a leave due while travelling waits for the hand-off, and no checkpoint writes the source subnet back', async () => {
    const store = new GatedStore();
    const { a, b, game } = setup(store, { checkpointEveryTicks: 2 });
    const { conn, op } = await atGate(game, a);
    store.holdTravel();
    await game.message(conn, travelCmd());
    const mark = store.batches.length;
    game.tick(); // the intent is created (and persisting)
    game.disconnect(conn);
    for (let i = 0; i < 10; i++) game.tick(); // the leave is due after 4; periodic checkpoints every 2
    expect(a.operators.get(op.id)!.travelling).toBe(true);
    expect(game.worldOf(op.id)).toBe(a);
    store.releaseTravel();
    await game.flush();
    expect(b.operators.has(op.id)).toBe(true);
    game.tick(); // now it leaves, from the destination
    await game.flush();
    expect(game.worldOf(op.id)).toBeUndefined();
    expect(b.operators.has(op.id)).toBe(false);
    const written = store.batches.slice(mark).flat().filter((r) => r.id === op.id);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((r) => r.subnet === 'testb')).toBe(true);
    expect(store.operators.get(op.id)).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
  });

  it('a travel commits only after older checkpoint writes, so a slow checkpoint cannot move the operator back', async () => {
    const store = new GatedStore();
    const { a, b, game } = setup(store, { checkpointEveryTicks: 2 });
    const { conn, op } = await atGate(game, a);
    store.holdCheckpoints();
    game.tick();
    game.tick(); // a periodic checkpoint (subnet test, on the gateway) is now held
    await new Promise((r) => setTimeout(r, 0));
    expect(store.batches.at(-1)!.find((r) => r.id === op.id)).toMatchObject({ subnet: 'test', x: GATE.at.x });
    await game.message(conn, travelCmd());
    game.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(b.operators.has(op.id)).toBe(false); // the travel waits behind the held checkpoint
    store.releaseCheckpoints();
    await game.flush();
    expect(b.operators.has(op.id)).toBe(true);
    expect(store.operators.get(op.id)).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
  });

  it('a controller that reconnects during travel follows the operator to the destination', async () => {
    const store = new GatedStore();
    const { a, game } = setup(store);
    const { conn } = await atGate(game, a);
    store.holdTravel();
    await game.message(conn, travelCmd());
    game.tick();
    game.disconnect(conn);
    const again = await join(game, 'alice');
    expect(again.of('snapshot').at(-1)!.d.subnet).toBe('test');
    store.releaseTravel();
    await game.flush();
    expect(again.of('snapshot').at(-1)!.d.subnet).toBe('testb');
    game.tick();
    expect(again.of('delta').at(-1)!.d.events).toContainEqual({ e: 'travelled', from: 'test', to: 'testb' });
    // the travel reply belonged to the old connection and is dropped
    expect(again.of('ack')).toHaveLength(0);
    expect(conn.of('ack').filter((m) => m.d.reqId === `q${req}`)).toHaveLength(0);
  });

  it('a resume after the operator travelled gets a fresh snapshot of the destination', async () => {
    const store = new GatedStore();
    const { a, game } = setup(store);
    const { conn } = await atGate(game, a);
    const { resumeToken } = conn.of('authOk')[0]!.d;
    store.holdTravel();
    await game.message(conn, travelCmd());
    game.tick();
    const lastTick = conn.of('delta').at(-1)!.d.tick;
    game.disconnect(conn);
    store.releaseTravel();
    await game.flush();
    const again = await join(game, 'alice', { resumeToken, lastTick });
    expect(again.of('snapshot')).toHaveLength(1);
    expect(again.of('snapshot')[0]!.d.subnet).toBe('testb');
  });

  it('shutdown during a pending travel finishes the hand-off before the final checkpoint', async () => {
    const store = new GatedStore();
    const { a, game } = setup(store);
    const { conn, op } = await atGate(game, a);
    store.holdTravel();
    await game.message(conn, travelCmd());
    game.tick();
    const done = game.shutdown();
    store.releaseTravel();
    await done;
    expect(store.batches.at(-1)!.find((r) => r.id === op.id)).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
    expect(store.operators.get(op.id)).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
  });

  it('an evolve committed in one world is discovered in every hosted world', async () => {
    const store = new MemoryStore();
    const { a, b, game } = setup(store);
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join(game, 'bob');
    const { conn, op } = await atGate(game, a);
    const d = a.daemons.get(op.ram[0]!)!;
    d.level = 8;
    await game.message(conn, cmd({ cmd: 'evolve', actor: 'self', args: { daemonId: d.id, formId: 'echolet' } }));
    game.tick();
    await game.flush();
    game.tick();
    expect(conn.of('ack').at(-1)!.d).toMatchObject({ result: { species: 'echolet' } });
    expect(a.discovered.has('echolet')).toBe(true);
    expect(b.discovered.has('echolet')).toBe(true);
    expect(bob.of('delta').flatMap((m) => m.d.events)).toContainEqual({ e: 'discovery', form: 'echolet', operator: op.id, operatorName: 'alice' });
  });
});

describe('store contract: travel', () => {
  it('MemoryStore records the new subnet and position', async () => {
    const store = new MemoryStore();
    const rec = await store.loadOrCreateOperator('sub-t', 'test', { x: 5, y: 5 });
    const intent: Intent = { id: 'i-travel', kind: 'travel', operatorId: rec.id, reqId: 'r', gatewayId: 'g', from: 'test', to: 'testb', x: 3.5, y: 3.5 };
    expect(await store.applyIntent(intent, { seedId: 'aaaa0001' })).toEqual({ ok: true });
    expect(await store.applyIntent(intent, { seedId: 'aaaa0001' })).toEqual({ ok: true });
    expect(await store.loadOrCreateOperator('sub-t', 'test', { x: 5, y: 5 })).toMatchObject({ subnet: 'testb', x: 3.5, y: 3.5 });
    void ownedRecord;
  });
});
