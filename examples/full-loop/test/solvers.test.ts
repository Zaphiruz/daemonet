import {
  CHAIN_STAGE_MAX_SIZE,
  MAX_CHALLENGE_SIZE,
  GATEWAY_RADIUS as RULES_GATEWAY_RADIUS,
  HARDENED_MS,
  OPEN_TICKETS_MAX as RULES_OPEN_TICKETS_MAX,
  RAM_SLOTS as RULES_RAM_SLOTS,
  RUNNING_MAX as RULES_RUNNING_MAX,
  SHOP,
  TICKETS_PER_DAY as RULES_TICKETS_PER_DAY,
  TICK_HZ as RULES_TICK_HZ,
  TYPES,
  checkAnswer,
  createRng,
  generateChallenge,
  getSubnet,
  getTool,
  msToTicks,
  publicChallenge,
  type Noise,
  type ToolId,
  type TypeId,
} from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import {
  FAILED_CAPTURE_COOLDOWN_TICKS,
  GATEWAYS,
  GATEWAY_RADIUS,
  HOSTS,
  OPEN_TICKETS_MAX,
  RAM_SLOTS,
  ROUTE,
  RUNNING_MAX,
  TICKETS_PER_DAY,
  TICK_HZ,
  TOOLS,
  attackable,
  chooseTool,
  dangerAt,
  escapePoint,
  evolutionReady,
  nextGateway,
  nextToRun,
  solve,
  storeCandidates,
  ticketsToAccept,
  toolsToBuy,
} from '../full-loop.js';

/** Small to the largest sizes the sim uses: a single challenge up to MAX_CHALLENGE_SIZE, a chain stage up to CHAIN_STAGE_MAX_SIZE. */
const SIZES = [8, 9, 16, 31, 33, 64, 100, 128, 200, CHAIN_STAGE_MAX_SIZE, 300, 512, 777, MAX_CHALLENGE_SIZE];
const NOISES: readonly Noise[] = [0, 1, 2];
const SEEDS_PER_NOISE = 100;

async function verdict(types: readonly TypeId[], size: number, noise: Noise, seed: string) {
  const challenge = generateChallenge(types, size, noise, createRng(seed));
  const answer: unknown = await solve(publicChallenge(challenge));
  return checkAnswer(challenge, answer);
}

describe('single-type challenges', () => {
  for (const type of TYPES) {
    it(`${type}: every noise level, sizes 8-${MAX_CHALLENGE_SIZE}, ${SEEDS_PER_NOISE} seeds per noise`, async () => {
      const failures: string[] = [];
      let solved = 0;
      for (const noise of NOISES) {
        for (let i = 0; i < SEEDS_PER_NOISE; i++) {
          const size = SIZES[i % SIZES.length]!;
          const seed = `single:${type}:${noise}:${i}`;
          const result = await verdict([type], size, noise, seed);
          if (result === 'correct') solved++;
          else failures.push(`${seed} size ${size}: ${result}`);
        }
      }
      expect(failures).toEqual([]);
      expect(solved).toBe(NOISES.length * SEEDS_PER_NOISE);
    });
  }
});

describe('dual-type chains', () => {
  it(`every ordered pair of the ${TYPES.length} families, every noise level`, async () => {
    const failures: string[] = [];
    let solved = 0;
    for (const a of TYPES) {
      for (const b of TYPES) {
        if (a === b) continue;
        for (const noise of NOISES) {
          const size = SIZES[(solved + failures.length) % SIZES.length]!;
          const seed = `chain:${a}:${b}:${noise}`;
          const result = await verdict([a, b], size, noise, seed);
          if (result === 'correct') solved++;
          else failures.push(`${seed} size ${size}: ${result}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(solved).toBe(TYPES.length * (TYPES.length - 1) * NOISES.length);
  });

  it('100 seeds of a sample of pairs at the largest stage size', async () => {
    const pairs: Array<[TypeId, TypeId]> = [
      ['packet', 'crypto'],
      ['socket', 'cloud'],
      ['proxy', 'shell'],
      ['thread', 'heap'],
      ['cloud', 'socket'],
      ['glitch', 'null'],
    ];
    const failures: string[] = [];
    for (const [a, b] of pairs) {
      for (let i = 0; i < 100; i++) {
        const noise = NOISES[i % 3]!;
        const seed = `chain-max:${a}:${b}:${i}`;
        const result = await verdict([a, b], MAX_CHALLENGE_SIZE, noise, seed);
        if (result !== 'correct') failures.push(`${seed}: ${result}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('solver speed', () => {
  it('solves the largest challenge of every family well inside the sniff deadline (2048 ms)', async () => {
    for (const type of TYPES) {
      const challenge = generateChallenge([type], MAX_CHALLENGE_SIZE, 2, createRng(`speed:${type}`));
      const started = performance.now();
      const answer: unknown = await solve(publicChallenge(challenge));
      const elapsed = performance.now() - started;
      expect(checkAnswer(challenge, answer)).toBe('correct');
      expect(elapsed, `${type} took ${elapsed.toFixed(1)} ms`).toBeLessThan(250);
    }
  });
});

describe('loop helpers', () => {
  it('chooseTool picks the cheapest tool held whose range covers the distance', () => {
    const all = { sniff: 3, tap: 1, mirror: 1, dump: 1 };
    expect(chooseTool(all)?.id).toBe('sniff');
    expect(chooseTool(all, 3)?.id).toBe('sniff');
    expect(chooseTool(all, 3.5)?.id).toBe('sniff');
    expect(chooseTool(all, 4.5)?.id).toBe('tap');
    expect(chooseTool(all, 6)?.id).toBe('mirror');
    expect(chooseTool({ dump: 1, mirror: 0 }, 7)?.id).toBe('dump');
    expect(chooseTool(all, 9)).toBeNull();
    expect(chooseTool({ tap: 2, dump: 1 }, 2)?.id).toBe('tap');
    expect(chooseTool({ restore: 4 })).toBeNull();
    expect(chooseTool({ sniff: 0, tap: 0 })).toBeNull();
  });

  it('storeCandidates keeps the best of each species and anything running, lowest level first', () => {
    const ram = [
      { id: 'a1', species: 'pingling', level: 9, xp: 0 },
      { id: 'a2', species: 'pingling', level: 4, xp: 0 },
      { id: 'a3', species: 'pingling', level: 6, xp: 0 },
      { id: 'b1', species: 'hashling', level: 3, xp: 0 },
      { id: 'c1', species: 'nullbit', level: 5, xp: 10 },
      { id: 'c2', species: 'nullbit', level: 5, xp: 20 },
    ];
    expect(storeCandidates(ram, [])).toEqual(['a2', 'c1', 'a3']);
    // a running duplicate stays in RAM
    expect(storeCandidates(ram, ['a2'])).toEqual(['c1', 'a3']);
    // singles are never stored
    expect(storeCandidates([{ id: 'x', species: 's', level: 1 }], [])).toEqual([]);
    // a crashed duplicate goes before a healthy lower-level one
    const crashed = [
      { id: 'p1', species: 'p', level: 9, crashed: false },
      { id: 'p2', species: 'p', level: 7, crashed: true },
      { id: 'p3', species: 'p', level: 3, crashed: false },
    ];
    expect(storeCandidates(crashed, [])).toEqual(['p2', 'p3']);
  });

  it('nextToRun picks the highest-level healthy daemon that is not running', () => {
    const ram = [
      { id: 'a', level: 10, crashed: true, hp: 0 },
      { id: 'b', level: 8, crashed: false, hp: 5 },
      { id: 'c', level: 9, crashed: false, hp: 5 },
    ];
    expect(nextToRun(ram, [])).toBe('c');
    expect(nextToRun(ram, ['c'])).toBe('b');
    expect(nextToRun(ram, ['b', 'c'])).toBeNull();
  });

  it('nextGateway climbs lo -> lan -> dmz -> backbone -> darknet -> cloudnet when the level allows', () => {
    expect(nextGateway('lo', 7, 0)).toBeNull();
    expect(nextGateway('lo', 8, 0)?.id).toBe('lo-lan');
    expect(nextGateway('lan', 15, 1)).toBeNull();
    expect(nextGateway('lan', 16, 1)?.id).toBe('lan-dmz');
    expect(nextGateway('dmz', 24, 2)?.id).toBe('dmz-backbone');
    expect(nextGateway('backbone', 32, 3)?.id).toBe('backbone-darknet');
    // after darknet the goal is cloudnet, through backbone; darknet is left only once level 40 is met
    expect(nextGateway('darknet', 39, 4)).toBeNull();
    expect(nextGateway('darknet', 40, 4)?.id).toBe('darknet-backbone');
    expect(nextGateway('backbone', 40, 4)?.id).toBe('backbone-cloudnet');
    // the end of the route, and never kernelspace
    expect(nextGateway('cloudnet', 64, 5)).toBeNull();
    expect(nextGateway('kernelspace', 64, 3)).toBeNull();
    // starting further along than `reached` aims past the current subnet
    expect(nextGateway('dmz', 30, 0)?.id).toBe('dmz-backbone');
  });

  it('the inlined constants match the rules content', () => {
    // HOST_RADIUS and LEASH_TILES live only in apps/sim, not in the public rules, so they are not pinned here.
    expect(RAM_SLOTS).toBe(RULES_RAM_SLOTS);
    expect(RUNNING_MAX).toBe(RULES_RUNNING_MAX);
    expect(TICK_HZ).toBe(RULES_TICK_HZ);
    expect(GATEWAY_RADIUS).toBe(RULES_GATEWAY_RADIUS);
    expect(OPEN_TICKETS_MAX).toBe(RULES_OPEN_TICKETS_MAX);
    expect(TICKETS_PER_DAY).toBe(RULES_TICKETS_PER_DAY);
    // a failed capture's cooldown outlasts the target's hardening
    expect(FAILED_CAPTURE_COOLDOWN_TICKS).toBeGreaterThanOrEqual(msToTicks(HARDENED_MS));
  });

  it('the inlined gateway, host and tool tables match the rules content', () => {
    for (const subnet of ROUTE) {
      const real = getSubnet(subnet).gateways.filter((g) => g.to !== 'kernelspace' && !g.incidentOnly);
      expect(GATEWAYS[subnet as keyof typeof GATEWAYS]).toEqual(real.map((g) => ({ id: g.id, to: g.to, level: g.requires.level })));
      expect(HOSTS[subnet as keyof typeof HOSTS]).toEqual(getSubnet(subnet).host);
    }
    for (const t of TOOLS) {
      expect(getTool(t.id as ToolId).range).toBe(t.range);
      expect(getTool(t.id as ToolId).deadlineMs).toBe(t.deadlineMs);
      expect(SHOP[t.id as ToolId]).toBe(t.price);
    }
  });

  it('attackable skips owned daemons, other tags and shielded bosses', () => {
    expect(attackable({ owner: null, taggedBy: null }, 'me')).toBe(true);
    expect(attackable({ owner: null, taggedBy: 'me' }, 'me')).toBe(true);
    expect(attackable({ owner: null, taggedBy: 'them' }, 'me')).toBe(false);
    expect(attackable({ owner: 'them', taggedBy: null }, 'me')).toBe(false);
    expect(attackable({ owner: null, taggedBy: null, boss: true, shielded: true }, 'me')).toBe(false);
  });

  it('escapePoint leaves the circle; dangerAt only counts blasts still to land', () => {
    const circle = { x: 50, y: 50, radius: 4, atTick: 100 };
    const out = escapePoint({ x: 51, y: 50 }, circle);
    expect(Math.hypot(out.x - 50, out.y - 50)).toBeGreaterThan(circle.radius);
    expect(escapePoint({ x: 50, y: 50 }, circle)).toEqual({ x: 56, y: 50 });
    expect(dangerAt({ x: 51, y: 50 }, [circle], 90)).toBe(circle);
    expect(dangerAt({ x: 51, y: 50 }, [circle], 101)).toBeNull();
    expect(dangerAt({ x: 60, y: 50 }, [circle], 90)).toBeNull();
  });

  it('ticketsToAccept takes untried clear/capture tickets while there is room', () => {
    const board = [
      { index: 0, kind: 'clear' },
      { index: 1, kind: 'deliver' },
      { index: 2, kind: 'capture' },
      { index: 3, kind: 'evolve' },
      { index: 4, kind: 'clear' },
    ];
    const me = { tickets: [{ index: 4, subnet: 'lo', day: 'd' }], ticketsToday: 1 };
    expect(ticketsToAccept(board, me, 'lo', 'd', new Set())).toEqual([0, 2]);
    expect(ticketsToAccept(board, me, 'lo', 'd', new Set(['d|lo|0']))).toEqual([2]);
    expect(ticketsToAccept(board, { tickets: [...me.tickets, ...me.tickets], ticketsToday: 2 }, 'lo', 'd', new Set())).toEqual([]);
    expect(ticketsToAccept(board, { tickets: [], ticketsToday: 8 }, 'lo', 'd', new Set())).toEqual([]);
  });

  it('toolsToBuy tops sniff and tap up to the floor as far as the bits go', () => {
    expect(toolsToBuy({ sniff: 1, tap: 3 }, 1000, 3)).toEqual([{ item: 'sniff', qty: 2 }]);
    expect(toolsToBuy({}, 32 * 3 + 128 * 2, 3)).toEqual([
      { item: 'sniff', qty: 3 },
      { item: 'tap', qty: 2 },
    ]);
    expect(toolsToBuy({}, 31, 3)).toEqual([]);
  });

  it('evolutionReady needs both the level and a met requirement', () => {
    const ram = [
      { id: 'a', level: 10, evolutions: [{ form: 'x', level: 16, met: true }] },
      {
        id: 'b',
        level: 20,
        evolutions: [
          { form: 'y', level: 16, met: false },
          { form: 'z', level: 18, met: true },
        ],
      },
    ];
    expect(evolutionReady(ram)).toEqual({ daemonId: 'b', form: 'z' });
    expect(evolutionReady([{ id: 'c', level: 5 }])).toBeNull();
    // a daemon whose evolve is cooling down does not block the next one
    const two = [
      { id: 'a', level: 20, evolutions: [{ form: 'x', level: 16, met: true }] },
      { id: 'b', level: 20, evolutions: [{ form: 'y', level: 16, met: true }] },
    ];
    expect(evolutionReady(two, (id) => id !== 'a')).toEqual({ daemonId: 'b', form: 'y' });
  });
});
