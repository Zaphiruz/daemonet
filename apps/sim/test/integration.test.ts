import { connect, devToken, type GameClient } from '@daemonet/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game } from '../src/runtime/game.js';
import { startLoop } from '../src/runtime/loop.js';
import { startServer, type RunningServer } from '../src/runtime/server.js';
import { gracefulShutdown } from '../src/runtime/shutdown.js';
import { MemoryStore } from '../src/runtime/store.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { TEST_SUBNET, placeWild } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };

interface Harness {
  world: World;
  game: Game;
  server: RunningServer;
  url: string;
  stop(): Promise<void>;
}

const running: Harness[] = [];
const clients: GameClient[] = [];

async function boot(store: MemoryStore, seedId: string): Promise<Harness> {
  const world = new World({ subnet: TEST_SUBNET, seed: seedId, seedId, spawner: false });
  const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId, retryDelaysMs: [1, 1, 1] });
  const server = await startServer({ game, store, port: 0, host: '127.0.0.1', trustProxyHops: 0, maxConnectionsPerIp: 16, log: silent });
  // 16 ms ticks: fast tests, while the 64-tick resume window (~1 s) still outlasts the SDK's first reconnect backoff.
  const stopLoop = startLoop(() => game.tick(), 16);
  const h: Harness = {
    world, game, server, url: `ws://127.0.0.1:${server.port}/ws`,
    stop: async () => {
      stopLoop();
      await gracefulShutdown({ server, game, store });
    },
  };
  running.push(h);
  return h;
}

async function bot(url: string, name: string): Promise<GameClient> {
  const c = await connect({ url, auth: devToken(name) });
  clients.push(c);
  return c;
}

function until(client: GameClient, pred: () => boolean, ticks = 400): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    let n = 0;
    const off = client.on('tick', () => {
      if (pred()) {
        off();
        resolve();
      } else if (++n > ticks) {
        off();
        reject(new Error('condition not met in time'));
      }
    });
  });
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of running.splice(0)) await h.stop();
});

describe('SDK against a live sim', () => {
  it('two bots claim starters and see each other', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0001');
    const alice = await bot(h.url, 'alice');
    const bob = await bot(h.url, 'bob');
    await alice.operator.claimStarter('pingling', 'alice');
    await bob.operator.claimStarter('nullpup', 'bob');
    await until(alice, () => alice.self.starterClaimed && alice.world.operators.all().some((o) => o.name === 'bob'));
    expect(alice.self.ram[0]!.species).toBe('pingling');
    expect(bob.world.operators.all().map((o) => o.name).sort()).toEqual(['alice', 'bob']);
  });

  it('a scripted bot weakens, captures with a solver, and keeps the daemon across a restart', async () => {
    const store = new MemoryStore();
    const h = await boot(store, 'aaaa0002');
    const alice = await bot(h.url, 'alice');
    // Hashling vs a wild Nullpup: neutral matchup, a wanderer that only fights back against the daemon,
    // and two Encrypt hits leave it under half HP without killing it.
    await alice.operator.claimStarter('hashling', 'alice');
    await until(alice, () => alice.self.ram.length === 1);
    await alice.operator.run(alice.self.ram[0]!.id);
    placeWild(h.world, 'nullpup', 5, 7.5, 5.5);

    alice.on('captureStart', (ev) => void alice.operator.submitCapture(ev.captureId, solve(ev.challenge as never)));
    alice.daemons.script(({ self, enemies }) => {
      const foe = enemies.nearest();
      if (!foe || foe.hpPct < 0.5) return;
      const move = self.bestMoveAgainst(foe);
      if (move) void self.use(move, foe);
    });
    let busy = false;
    alice.operator.script(({ me, world }) => {
      const target = world.wild.nearest();
      if (!target || me.capture || busy) return;
      if (Math.hypot(target.x - me.x, target.y - me.y) > 3) {
        void alice.operator.moveTo(target.x, target.y);
        return;
      }
      if (target.hpPct < 0.5) {
        busy = true;
        alice.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
      }
    });
    const result = new Promise((resolve) => alice.on('captureResult', (ev) => ev.ok && resolve(ev)));
    await expect(result).resolves.toMatchObject({ ok: true, daemon: { species: 'nullpup' } });

    await h.stop();
    running.splice(running.indexOf(h), 1);
    const h2 = await boot(store, 'bbbb0003');
    const back = await bot(h2.url, 'alice');
    expect(back.self.ram.map((d) => d.species).sort()).toEqual(['hashling', 'nullpup']);
  });

  it('another operator cannot capture a daemon tagged by someone else', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0004');
    const alice = await bot(h.url, 'alice');
    const bob = await bot(h.url, 'bob');
    await alice.operator.claimStarter('pingling', 'alice');
    await bob.operator.claimStarter('nullpup', 'bob');
    await until(bob, () => bob.self.starterClaimed);
    const wild = placeWild(h.world, 'bitrot', 5, 6.5, 5.5);
    wild.wild!.tagOwner = alice.operatorId;
    wild.wild!.tagUntil = h.world.tick + 10_000;
    await expect(bob.operator.capture(wild.id, 'sniff')).rejects.toMatchObject({ code: 'E_STATE' });
  });

  it('enforces the per-tick command budget locally', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0005');
    const alice = await bot(h.url, 'alice');
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => alice.operator.stop()));
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code: string }).code === 'E_RATE')).toHaveLength(1);
  });

  it('reconnects and resumes after a dropped connection', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0006');
    const alice = await bot(h.url, 'alice');
    let snapshots = 0;
    alice.on('ready', () => snapshots++);
    const reconnected = new Promise<void>((resolve) => alice.on('reconnect', () => resolve()));
    alice.dropConnection();
    await reconnected;
    const before = alice.tick;
    await until(alice, () => alice.tick > before + 3);
    expect(snapshots).toBe(0);
  });

  it('a graceful shutdown kicks connected clients with "server shutting down", and they try to reconnect', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0007');
    let tokenCalls = 0;
    const alice = await connect({ url: h.url, auth: { getToken: async () => (tokenCalls++, 'dev:alice') } });
    clients.push(alice);
    const kicks: string[] = [];
    alice.on('kick', (reason) => kicks.push(reason));
    await h.stop();
    running.splice(running.indexOf(h), 1);
    expect(kicks).toEqual(['server shutting down']);
    await expect.poll(() => tokenCalls, { timeout: 3000 }).toBeGreaterThan(1);
  });
});
