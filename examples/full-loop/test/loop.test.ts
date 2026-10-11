import { checkAnswer, createRng, generateChallenge, publicChallenge } from '@daemonet/rules';
import { describe, expect, it, vi } from 'vitest';
import main from '../full-loop.js';

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
    daemons: { script: () => () => {} },
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

  it('captures a weakened target in range with the best tool held', async () => {
    const target = wild('w1', 62, 60, 0.2);
    const game = fakeGame(
      { ram: [ramDaemon('a', 'pingling', 3), ramDaemon('b', 'hashling', 5)], running: ['a', 'b'], inventory: { sniff: 2, dump: 1 } },
      { wild: [target] },
    );
    await main(game as never);
    await game.step();
    expect(game.operator.capture).toHaveBeenCalledWith(target, 'dump');
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
