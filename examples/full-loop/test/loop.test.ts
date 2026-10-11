import { checkAnswer, createRng, generateChallenge, publicChallenge } from '@daemonet/rules';
import { describe, expect, it, vi } from 'vitest';
import main, { EVENT_LINES_PER_WINDOW, FAILED_CAPTURE_COOLDOWN_TICKS } from '../full-loop.js';

/** A tiny stand-in for the SDK's Query (origin = the operator). */
class FakeQuery<T extends { x: number; y: number }> {
  constructor(
    private readonly items: T[],
    private readonly origin: { x: number; y: number },
  ) {}
  get length() {
    return this.items.length;
  }
  all() {
    return [...this.items];
  }
  filter(pred: (t: T) => boolean) {
    return new FakeQuery(this.items.filter(pred), this.origin);
  }
  within(r: number) {
    return this.filter((t) => Math.hypot(t.x - this.origin.x, t.y - this.origin.y) <= r);
  }
  nearest(pred: (t: T) => boolean = () => true) {
    return [...this.items].filter(pred).sort((a, b) => Math.hypot(a.x - this.origin.x, a.y - this.origin.y) - Math.hypot(b.x - this.origin.x, b.y - this.origin.y))[0];
  }
}

const ramDaemon = (id: string, species: string, level: number, extra: Record<string, unknown> = {}) => ({
  id,
  species,
  level,
  xp: 0,
  hp: 10,
  maxHp: 10,
  crashed: false,
  evolutions: [],
  ...extra,
});

const wild = (id: string, x: number, y: number, hpPct: number, types = ['packet']) => ({
  kind: 'daemon',
  id,
  species: 'pingling',
  types,
  level: 3,
  hp: hpPct * 10,
  maxHp: 10,
  hpPct,
  x,
  y,
  owner: null,
  taggedBy: null,
});

function fakeGame(self: Record<string, unknown>, opts: { subnet?: string; wild?: ReturnType<typeof wild>[]; gateways?: unknown[] } = {}) {
  const handlers = new Map<string, (v: unknown) => void>();
  const scripts: Array<() => void> = [];
  const daemonScripts: Array<(ctx: unknown) => void> = [];
  const ok = () => vi.fn(() => Promise.resolve({}));
  const operator = {
    moveTo: ok(),
    stop: ok(),
    run: ok(),
    recall: ok(),
    capture: ok(),
    submitCapture: ok(),
    useRestore: ok(),
    restoreAll: vi.fn(() => Promise.resolve({ untilTick: 40 })),
    store: ok(),
    buy: ok(),
    travel: ok(),
    evolve: ok(),
    acceptTicket: ok(),
    script: (fn: (ctx: unknown) => void) => scripts.push(() => fn({ me: game.self, world: game.world, tick: game.tick })),
  };
  const me = {
    id: 'me',
    name: 'tester',
    x: 60,
    y: 60,
    starterClaimed: true,
    bits: 0,
    diskCapacity: 32,
    ram: [],
    running: [],
    tickets: [],
    ticketsToday: 0,
    ticketsDay: '2026-10-11',
    inventory: {},
    swapReadyTick: 0,
    capture: null,
    arena: null,
    ...self,
  };
  const game = {
    tick: 10,
    operatorId: 'me',
    subnet: opts.subnet ?? 'lo',
    self: me as typeof me & Record<string, unknown>,
    world: {
      get wild() {
        return new FakeQuery(opts.wild ?? [], game.self as { x: number; y: number });
      },
      gateways: opts.gateways ?? [],
      tickets: [],
    },
    operator,
    daemons: {
      script: (fn: (ctx: unknown) => void) => {
        daemonScripts.push(fn);
        return () => {};
      },
    },
    /** Run the daemon script once for a fake running daemon next to the operator; returns its `use` mock. */
    runDaemon() {
      const use = vi.fn(() => Promise.resolve({}));
      const self = { id: 'a', x: game.self.x, y: game.self.y, bestMoveAgainst: () => 'zap', use, moveTo: vi.fn(() => Promise.resolve({})), distanceTo: () => 1 };
      for (const fn of daemonScripts) fn({ self, enemies: new FakeQuery(opts.wild ?? [], self), world: game.world, tick: game.tick });
      return use;
    },
    on: (name: string, h: (v: unknown) => void) => {
      handlers.set(name, h);
      return () => {};
    },
    emit: (name: string, v: unknown) => handlers.get(name)?.(v),
    async step() {
      game.tick++;
      for (const s of scripts) s();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  return game;
}

describe('the loop (fake client)', () => {
  it('runs the best healthy daemon when fewer than two are running', async () => {
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3), ramDaemon('b', 'hashling', 5)] });
    await main(game as never);
    await game.step();
    expect(game.operator.run).toHaveBeenCalledWith('b');
  });

  it('captures a weakened target with the cheapest tool whose range covers it', async () => {
    const target = wild('w1', 62, 60, 0.2);
    const game = fakeGame(
      { ram: [ramDaemon('a', 'pingling', 3), ramDaemon('b', 'hashling', 5)], running: ['a', 'b'], inventory: { sniff: 2, tap: 1, dump: 1 } },
      { wild: [target] },
    );
    await main(game as never);
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledWith(target, 'sniff');
    // the daemons hold fire on a capture-ready target
    expect(game.runDaemon()).not.toHaveBeenCalled();
  });

  it('uses tap when sniff does not reach, and walks closer when nothing held reaches', async () => {
    const target = wild('w1', 65, 60, 0.2);
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: ['a'], swapReadyTick: 999, inventory: { sniff: 2, tap: 1 } }, { wild: [target] });
    await main(game as never);
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledWith(target, 'tap');

    const far = wild('w2', 66, 60, 0.2);
    const game2 = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: ['a'], swapReadyTick: 999, inventory: { sniff: 2 } }, { wild: [far] });
    await main(game2 as never);
    await game2.step();
    expect(game2.operator.capture).not.toHaveBeenCalled();
    expect(game2.operator.moveTo).toHaveBeenCalledWith(66, 60);
  });

  it('leaves a target to the daemons until the hardening after a failed capture has passed', async () => {
    const target = wild('w1', 62, 60, 0.2);
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: ['a'], swapReadyTick: 999, inventory: { sniff: 5 } }, { wild: [target] });
    await main(game as never);
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledTimes(1);
    game.emit('captureResult', { captureId: 'c1', ok: false, reason: 'packet_loss' });
    for (let i = 0; i < 10; i++) await game.step();
    expect(game.operator.capture).toHaveBeenCalledTimes(1);
    // meanwhile the daemons keep attacking it
    expect(game.runDaemon()).toHaveBeenCalledWith('zap', target);
    game.tick += FAILED_CAPTURE_COOLDOWN_TICKS;
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledTimes(2);
  });

  it('turns captures off once RAM and Disk are full, and keeps fighting', async () => {
    const target = wild('w1', 62, 60, 0.2);
    const ram = Array.from({ length: 8 }, (_, i) => ramDaemon(`d${i}`, `s${i}`, i + 1));
    const game = fakeGame({ ram, running: ['d7', 'd6'], inventory: { sniff: 5 } }, { wild: [target] });
    game.operator.capture.mockImplementation(() => Promise.reject(Object.assign(new Error('RAM and Disk are full'), { code: 'E_STATE' })));
    await main(game as never);
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledTimes(1);
    game.tick += 10 * 16 * 60;
    for (let i = 0; i < 5; i++) await game.step();
    expect(game.operator.capture).toHaveBeenCalledTimes(1);
    expect(game.runDaemon()).toHaveBeenCalledWith('zap', target);
  });

  it('does not resend a refused store, nor walk back to the host while it cools down', async () => {
    const ram = [ramDaemon('d0', 'pingling', 1), ...Array.from({ length: 7 }, (_, i) => ramDaemon(`d${i + 1}`, i === 0 ? 'pingling' : `s${i}`, i + 2))];
    const game = fakeGame({ ram, running: ['d7', 'd6'], x: 16.5, y: 16.5 }, { wild: [wild('w1', 40, 40, 1)] });
    game.operator.store.mockImplementation(() => Promise.reject(Object.assign(new Error('daemon is busy'), { code: 'E_STATE' })));
    await main(game as never);
    await game.step();
    expect(game.operator.store).toHaveBeenCalledTimes(1);
    expect(game.operator.store).toHaveBeenCalledWith('d0');
    await game.step();
    expect(game.operator.store).toHaveBeenCalledTimes(1);
    // the operator leaves for the field and does not come back for the cooling store
    game.self.x = 40;
    game.self.y = 38;
    game.operator.moveTo.mockClear();
    for (let i = 0; i < 5; i++) await game.step();
    expect(game.operator.moveTo).not.toHaveBeenCalledWith(16.5, 16.5);
    // after the cooldown the store is tried again (and a second refusal doubles the wait)
    game.self.x = 16.5;
    game.self.y = 16.5;
    game.tick += 2 * 16;
    await game.step();
    expect(game.operator.store).toHaveBeenCalledTimes(2);
    game.tick += 2 * 16;
    await game.step();
    expect(game.operator.store).toHaveBeenCalledTimes(2);
    game.tick += 2 * 16;
    await game.step();
    expect(game.operator.store).toHaveBeenCalledTimes(3);
  });

  it('engages a healthy target by walking within 3 tiles', async () => {
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: ['a'], swapReadyTick: 999 }, { wild: [wild('w1', 70, 60, 1)] });
    await main(game as never);
    await game.step();
    expect(game.operator.moveTo).toHaveBeenCalledWith(70, 60);
    expect(game.operator.capture).not.toHaveBeenCalled();
  });

  it('walks to the host and stores duplicates when RAM is full', async () => {
    const ram = Array.from({ length: 8 }, (_, i) => ramDaemon(`d${i}`, i < 4 ? 'pingling' : `s${i}`, i + 1));
    const game = fakeGame({ ram, running: ['d7', 'd6'] }, { wild: [wild('w1', 62, 60, 1)] });
    await main(game as never);
    await game.step();
    expect(game.operator.moveTo).toHaveBeenCalledWith(16.5, 16.5);
    game.self.x = 16.5;
    game.self.y = 16.5;
    await game.step();
    expect(game.operator.store).toHaveBeenCalledWith('d0');
  });

  it('solves and submits on captureStart (a chain)', async () => {
    const game = fakeGame({ ram: [] });
    await main(game as never);
    const challenge = generateChallenge(['socket', 'proxy'], 200, 1, createRng('loop-chain'));
    game.emit('captureStart', { captureId: 'c1', targetId: 'w1', challenge: publicChallenge(challenge), deadlineTick: 99 });
    await vi.waitFor(() => expect(game.operator.submitCapture).toHaveBeenCalled());
    const [id, answer] = game.operator.submitCapture.mock.calls[0] as unknown as [string, unknown];
    expect(id).toBe('c1');
    expect(checkAnswer(challenge, answer)).toBe('correct');
  });

  it('recalls running daemons on the gateway, then travels', async () => {
    const gateway = { id: 'lo-lan', at: { x: 122.5, y: 122.5 }, to: 'lan', arrive: { x: 5.5, y: 5.5 }, requires: { level: 8 } };
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 9)], running: ['a'], x: 100, y: 100 }, { gateways: [gateway] });
    await main(game as never);
    await game.step();
    expect(game.operator.moveTo).toHaveBeenCalledWith(122.5, 122.5);
    game.self.x = 122;
    game.self.y = 122;
    await game.step();
    expect(game.operator.recall).toHaveBeenCalledWith('a');
    game.self.running = [];
    game.self.swapReadyTick = 999;
    await game.step();
    expect(game.operator.travel).toHaveBeenCalledWith('lo-lan');
    expect(game.operator.run).not.toHaveBeenCalled();
  });

  it('dodges a telegraphed blast before anything else', async () => {
    const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: [] });
    await main(game as never);
    game.emit('telegraph', { x: 60, y: 61, radius: 4, atTick: 50 });
    await game.step();
    expect(game.operator.moveTo).toHaveBeenCalledWith(60, 55);
    expect(game.operator.run).not.toHaveBeenCalled();
  });
});

describe('log budget', () => {
  it('stays within EVENT_LINES_PER_WINDOW event lines per status window however many refusals happen', async () => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const target = wild('w1', 62, 60, 0.2);
      const game = fakeGame({ ram: [ramDaemon('a', 'pingling', 3)], running: ['a'], swapReadyTick: 1e9, inventory: { sniff: 5 } }, { wild: [target] });
      game.operator.capture.mockImplementation(() => Promise.reject(Object.assign(new Error('not a wild daemon'), { code: 'E_STATE' })));
      await main(game as never);
      for (let i = 0; i < 200; i++) {
        game.tick += 64;
        await game.step();
      }
      expect(game.operator.capture.mock.calls.length).toBeGreaterThan(EVENT_LINES_PER_WINDOW);
      // the online line, one status line (the clock does not move in this test) and the capped event lines
      expect(lines.mock.calls.length).toBeLessThanOrEqual(2 + EVENT_LINES_PER_WINDOW);
    } finally {
      lines.mockRestore();
    }
  });
});
