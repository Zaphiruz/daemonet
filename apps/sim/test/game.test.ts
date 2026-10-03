import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { CLOSE, Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

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
  last<T extends ServerMessage['t']>(t: T) {
    return this.of(t).at(-1);
  }
}

function setup(store = new MemoryStore(), seedId = 'abcd1234') {
  const world = new World({ subnet: TEST_SUBNET, seed: 'game', seedId, spawner: false });
  const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId, retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4 });
  return { world, game, store };
}

async function join(game: Game, name: string, extra: Record<string, unknown> = {}) {
  const conn = new FakeConn();
  game.connect(conn);
  await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...extra } }));
  return conn;
}

let req = 0;
const cmd = (c: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `q${++req}`, ...c } });

async function claim(game: Game, conn: FakeConn, name: string, species = 'pingling') {
  await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species, operatorName: name } }));
  game.tick();
  await game.flush();
  game.tick();
}

describe('Game connections', () => {
  it('authenticates with a dev token and sends authOk + snapshot', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    expect(conn.sent.map((m) => m.t)).toEqual(['authOk', 'snapshot']);
    const snap = conn.last('snapshot')!;
    expect(snap.d.self).toMatchObject({ starterClaimed: false, name: null });
    expect(conn.sent.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('rejects bad tokens and anything before auth', async () => {
    const { game } = setup();
    const bad = await join(game, 'Not Valid');
    expect(bad.last('err')!.d.code).toBe('E_AUTH');
    expect(bad.closed?.code).toBe(CLOSE.auth);
    const early = new FakeConn();
    game.connect(early);
    await game.message(early, JSON.stringify({ t: 'ping', seq: 1, d: {} }));
    expect(early.closed?.code).toBe(CLOSE.auth);
  });

  it('times out connections that never authenticate', () => {
    const { game } = setup();
    const conn = new FakeConn();
    game.connect(conn);
    for (let i = 0; i < 82; i++) game.tick();
    expect(conn.closed?.code).toBe(CLOSE.timeout);
  });

  it('claims a starter through the store and persists it', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    const ack = conn.of('ack').at(-1)!;
    expect(ack.d.result).toMatchObject({ daemonId: expect.any(String) });
    const row = [...store.operators.values()][0]!;
    expect(row).toMatchObject({ name: 'alice', starterClaimed: true });
    expect(store.daemons.size).toBe(1);
  });

  it('sends a delta every tick with only changed fields', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    const daemonId = (conn.of('ack').at(-1)!.d.result as { daemonId: string }).daemonId;
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    game.tick();
    game.tick();
    const delta = conn.last('delta')!;
    const me = delta.d.upserts.find((u) => u.kind === 'operator');
    expect(me).toBeDefined();
    expect(Object.keys(me!).sort()).toEqual(['id', 'kind', 'x']);
    expect(daemonId).toBeTruthy();
  });

  it('enforces 8 commands per tick with E_RATE', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    for (let i = 0; i < 10; i++) await game.message(conn, cmd({ cmd: 'stop', actor: 'self', args: {} }));
    expect(conn.of('err').filter((e) => e.d.code === 'E_RATE')).toHaveLength(2);
    game.tick();
    expect(conn.of('ack')).toHaveLength(8);
  });

  it('a second controller takes over; spectators watch but cannot command', async () => {
    const { game } = setup();
    const first = await join(game, 'alice');
    const second = await join(game, 'alice');
    expect(first.closed?.code).toBe(CLOSE.takeover);
    expect(first.last('kick')!.d.reason).toBe('takeover');
    const watcher = await join(game, 'alice', { role: 'spectator' });
    await game.message(watcher, cmd({ cmd: 'stop', actor: 'self', args: {} }));
    expect(watcher.last('err')!.d.code).toBe('E_STATE');
    game.tick();
    expect(second.last('delta')).toBeDefined();
    expect(watcher.last('delta')).toBeDefined();
  });

  it('resumes within 64 ticks by replaying buffered deltas, otherwise snapshots', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    for (let i = 0; i < 5; i++) game.tick();
    const auth = conn.last('authOk')!;
    const seenTick = conn.of('delta')[2]!.d.tick;
    game.disconnect(conn);
    const back = await join(game, 'alice', { resumeToken: auth.d.resumeToken, lastTick: seenTick });
    expect(back.sent.map((m) => m.t)).toEqual(['authOk', 'delta', 'delta']);
    expect(back.of('delta').map((d) => d.d.tick)).toEqual([seenTick + 1, seenTick + 2]);

    game.disconnect(back);
    const stale = await join(game, 'alice', { resumeToken: 'wrong', lastTick: seenTick });
    expect(stale.sent.map((m) => m.t)).toEqual(['authOk', 'snapshot']);
  });

  it('checkpoints and removes the operator after the controller has been gone long enough', async () => {
    const { game, world, store } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    for (let i = 0; i < 40; i++) game.tick();
    game.disconnect(conn);
    for (let i = 0; i < 5; i++) game.tick();
    await game.flush();
    expect(world.operators.size).toBe(0);
    const row = [...store.operators.values()][0]!;
    expect(row.x).toBeCloseTo(9.5);
  });

  it('retries failed intent persistence, then succeeds', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    store.failNext = 2;
    await claim(game, conn, 'alice');
    expect(conn.of('ack').at(-1)!.d.result).toMatchObject({ daemonId: expect.any(String) });
  });

  it('reports persist failure after all retries', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    store.failNext = 10;
    await claim(game, conn, 'alice');
    expect(conn.last('err')!.d).toMatchObject({ code: 'E_STATE', message: 'persist failed' });
  });
});

describe('spectators', () => {
  it('a spectator alone does not keep an operator in the world', async () => {
    const { game, world } = setup();
    const watcher = await join(game, 'alice', { role: 'spectator' });
    expect(world.operators.size).toBe(1);
    game.disconnect(watcher);
    for (let i = 0; i < 6; i++) game.tick();
    await game.flush();
    expect(world.operators.size).toBe(0);
  });

  it('a spectator joining during the grace period does not extend it', async () => {
    const { game, world } = setup();
    const conn = await join(game, 'alice');
    game.disconnect(conn);
    game.tick();
    const watcher = await join(game, 'alice', { role: 'spectator' });
    for (let i = 0; i < 6; i++) game.tick();
    await game.flush();
    expect(world.operators.size).toBe(0);
    expect(watcher.closed?.reason).toBe('operator left');
  });

  it('drops a command reply when the sending connection was replaced', async () => {
    const { game } = setup();
    const first = await join(game, 'alice');
    await game.message(first, cmd({ cmd: 'stop', actor: 'self', args: {} }));
    const second = await join(game, 'alice');
    game.tick();
    expect(second.of('ack')).toHaveLength(0);
  });
});

/** A MemoryStore whose next loadOrCreateOperator reads immediately but answers only when released. */
class GatedLoadStore extends MemoryStore {
  private gate: { started: () => void; release: Promise<void> } | null = null;

  /** Arms the gate; returns a promise for "load started" and a function that lets the load answer. */
  holdNextLoad() {
    let release!: () => void;
    let started!: () => void;
    const loadStarted = new Promise<void>((r) => (started = r));
    this.gate = { started, release: new Promise<void>((r) => (release = r)) };
    return { loadStarted, release };
  }

  override async loadOrCreateOperator(...args: Parameters<MemoryStore['loadOrCreateOperator']>) {
    const rec = await super.loadOrCreateOperator(...args);
    const gate = this.gate;
    this.gate = null;
    if (gate) {
      gate.started();
      await gate.release;
    }
    return rec;
  }
}

describe('leave vs connect', () => {
  it('a connection whose load raced the leave checkpoint gets the post-leave state', async () => {
    const store = new GatedLoadStore();
    const { game, world } = setup(store);
    const conn = await join(game, 'alice');
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    for (let i = 0; i < 40; i++) game.tick();
    const id = conn.last('authOk')!.d.operatorId;
    expect(world.operators.get(id)!.x).toBeCloseTo(9.5);
    game.disconnect(conn);

    // A new connection starts loading the (not yet checkpointed, spawn-position) row...
    const { loadStarted, release } = store.holdNextLoad();
    const back = new FakeConn();
    game.connect(back);
    const authed = game.message(back, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
    await loadStarted;
    // ...while the grace period expires and the leave checkpoint commits the moved position.
    for (let i = 0; i < 5; i++) game.tick();
    await game.flush();
    expect(world.operators.has(id)).toBe(false);
    expect([...store.operators.values()][0]!.x).toBeCloseTo(9.5);

    release();
    await authed;
    expect(back.last('authOk')).toBeDefined();
    expect(world.operators.get(id)!.x).toBeCloseTo(9.5);
    expect(back.last('snapshot')!.d.self).toMatchObject({ x: expect.closeTo(9.5) });
  });
});

const replyRoutes = (game: Game) => (game as unknown as { replyTo: Map<string, unknown> }).replyTo;

describe('reply routing across connections', () => {
  const withReq = (reqId: string, c: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId, ...c } });

  it('a reused reqId on a new connection never receives the old connection’s intent reply', async () => {
    const { game } = setup();
    const first = await join(game, 'alice');
    await game.message(first, withReq('same', { cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice' } }));
    game.tick(); // the claim becomes an intent; persistence starts
    const second = await join(game, 'alice'); // takeover; the SDK restarts reqIds per process
    await game.message(second, withReq('same', { cmd: 'stop', actor: 'self', args: {} }));
    await game.flush(); // the claim completes before the next tick
    game.tick();
    const acks = second.of('ack').filter((a) => a.d.reqId === 'same');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.d.result).toBeUndefined(); // the stop ack, not the claim's { daemonId }
    expect(first.of('ack')).toHaveLength(0);
    expect(replyRoutes(game).size).toBe(0);
  });

  it('holds no routes for an operator that left while its intent was pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    store.applyIntent = async (...args) => {
      await gate;
      return apply(...args);
    };
    const { game, world } = setup(store);
    const conn = await join(game, 'alice');
    await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice' } }));
    game.tick(); // the claim becomes an intent; its persistence waits on the gate
    expect(replyRoutes(game).size).toBe(1);
    game.disconnect(conn);
    for (let i = 0; i < 5; i++) game.tick();
    expect(world.operators.size).toBe(0);
    release();
    await game.flush();
    game.tick();
    expect(replyRoutes(game).size).toBe(0);
  });
});

/** A MemoryStore whose checkpoint writes wait until the test releases them (in any order). */
class HeldCheckpointStore extends MemoryStore {
  readonly held: Array<() => void> = [];
  override checkpoint(records: Parameters<MemoryStore['checkpoint']>[0]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.held.push(() => super.checkpoint(records).then(resolve, reject));
    });
  }
  /** Releases every held write newest-first (the worst case for ordering) until none are left. */
  async releaseNewestFirst(): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 0));
      if (this.held.length === 0) return;
      for (const release of this.held.splice(0).reverse()) release();
    }
  }
}

describe('checkpoint ordering', () => {
  it('the last checkpoint taken is the one that sticks, even when an older write would commit later', async () => {
    const store = new HeldCheckpointStore();
    const world = new World({ subnet: TEST_SUBNET, seed: 'game', seedId: 'abcd1234', spawner: false });
    const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId: 'abcd1234', checkpointEveryTicks: 8, leaveAfterTicks: 4 });
    const conn = await join(game, 'alice');
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    for (let i = 0; i < 40; i++) game.tick(); // periodic checkpoints along the way
    game.disconnect(conn);
    for (let i = 0; i < 5; i++) game.tick(); // the leave checkpoint, at 9.5
    expect(world.operators.size).toBe(0);
    await store.releaseNewestFirst();
    await game.flush();
    expect([...store.operators.values()][0]!.x).toBeCloseTo(9.5);
  });
});

describe('restart', () => {
  it('a captured daemon survives a restart with the same store', async () => {
    const store = new MemoryStore();
    const a = setup(store, 'aaaa0001');
    const conn = await join(a.game, 'alice');
    await claim(a.game, conn, 'alice');
    const daemonId = (conn.of('ack').at(-1)!.d.result as { daemonId: string }).daemonId;
    await a.game.shutdown();

    const b = setup(store, 'bbbb0002');
    const again = await join(b.game, 'alice');
    const snap = again.last('snapshot')!;
    expect(snap.d.self.ram.map((d) => d.id)).toEqual([daemonId]);
    expect(snap.d.self.starterClaimed).toBe(true);
  });
});
