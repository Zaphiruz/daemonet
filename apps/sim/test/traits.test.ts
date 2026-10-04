import { TICK_HZ, getMove } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { cooldownMs, energyCost, scaleDamage } from '../src/core/systems/combat.js';
import { LEAK_PER_SECOND } from '../src/core/systems/upkeep.js';
import { idle, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

/** Alice with a level-20 Pingling running, a level-20 wild Bitrot two tiles away (survives a ping); both traits overridable. */
function duel(myTrait: string, wildTrait = 'lowlatency') {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice', { ram: [ownedRecord('pingling', 20, 0, 'alice-d0')] }));
  step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
  const mine = world.daemons.get('alice-d0')!;
  mine.trait = myTrait;
  const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
  wild.trait = wildTrait;
  const use = (move: string, aim: { targetId?: string; x?: number; y?: number } = { targetId: wild.id }) =>
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move, ...aim } }));
  /** Hits landed on the wild daemon this step (it fights back, so events also carry its own hits). */
  const hits = (r: ReturnType<typeof step>) =>
    r.events.map((e) => e.event as { e: string; amount: number; target: string }).filter((e) => e.e === 'hit' && e.target === wild.id);
  return { world, mine, wild, use, hits };
}

const ping = getMove('ping');
const traceroute = getMove('traceroute');
const synflood = getMove('synflood');

describe('trait effects', () => {
  it('sonar: +2 range on single-target moves', () => {
    const { mine, wild, use } = duel('sonar');
    wild.statuses.stalled = 10_000; // keep it from closing the distance
    wild.x = 9.5; // 4 tiles: ping range 2 (+2)
    expect(use('ping').replies[0]).toMatchObject({ ok: true });
    wild.x = 10.5;
    mine.cooldowns = {};
    expect(use('ping').replies[0]).toMatchObject({ code: 'E_RANGE' });
  });

  it('lowlatency: the first move after activation ignores the cooldown, then cooldowns apply', () => {
    const { mine, use } = duel('lowlatency');
    mine.cooldowns.ping = 10_000;
    expect(use('ping').replies[0]).toMatchObject({ ok: true });
    expect(use('ping').replies[0]).toMatchObject({ code: 'E_COOLDOWN' });
  });

  it('synburst and lazyeval change energy costs; retransmit refunds an empty area move', () => {
    const { world, mine, use } = duel('synburst');
    mine.hp = Math.floor(mine.stats.hp * 0.2);
    expect(energyCost(mine, ping)).toBe(0);
    expect(energyCost(mine, traceroute)).toBe(traceroute.energyCost);
    mine.trait = 'lazyeval';
    expect(energyCost(mine, synflood)).toBe(Math.floor(synflood.energyCost * 0.75));
    mine.trait = 'retransmit';
    mine.energy = 128;
    expect(use('broadcast', { x: 5.5, y: 10.5 }).replies[0]).toMatchObject({ ok: true });
    expect(mine.energy).toBe(128);
    mine.trait = 'echo';
    world.daemons.get('alice-d0')!.cooldowns = {};
    use('broadcast', { x: 5.5, y: 10.5 });
    expect(mine.energy).toBeCloseTo(128 - getMove('broadcast').energyCost, 0); // plus one tick of regen
  });

  it('overclock and heatsink shorten cooldowns', () => {
    const { mine } = duel('overclock');
    const base = cooldownMs(mine, ping, 0);
    mine.hp = 1;
    expect(cooldownMs(mine, ping, 0)).toBe(Math.floor(base * 0.875));
    mine.hp = mine.stats.hp;
    mine.heldItem = 'heatsink';
    expect(cooldownMs(mine, ping, 0)).toBe(Math.floor(base * 0.875));
  });

  it('damage multipliers: amplifier, firewall, exposed, darkmode, salted', () => {
    const { mine, wild } = duel('echo');
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(100);
    mine.heldItem = 'amplifier';
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(112);
    mine.heldItem = null;
    wild.heldItem = 'firewall';
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(87);
    wild.heldItem = null;
    wild.statuses.exposed = 100;
    expect(scaleDamage(100, mine, wild, ping, 0)).toBe(125);
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(100);
    wild.trait = 'darkmode';
    expect(scaleDamage(100, mine, wild, traceroute, 200)).toBe(75);
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(100);
    wild.trait = 'salted';
    wild.engagement.lastHitMove = 'ping';
    expect(scaleDamage(100, mine, wild, ping, 200)).toBe(75);
    expect(scaleDamage(100, mine, wild, traceroute, 200)).toBe(100);
    expect(scaleDamage(0, mine, wild, ping, 200)).toBe(0);
  });

  it('bitshield blocks the first hit of an engagement; nullsafe survives one lethal hit at 1 HP', () => {
    const a = duel('echo', 'bitshield');
    expect(a.hits(a.use('ping'))[0]!.amount).toBe(0);
    expect(a.wild.hp).toBe(a.wild.stats.hp);
    a.mine.cooldowns = {};
    expect(a.hits(a.use('ping'))[0]!.amount).toBeGreaterThan(0);

    const b = duel('echo', 'nullsafe');
    b.wild.hp = 1;
    b.wild.wild!.aggro = null;
    b.use('ping');
    expect(b.wild.hp).toBe(1);
    expect(b.world.daemons.has(b.wild.id)).toBe(true);
    b.mine.cooldowns = {};
    b.use('ping');
    expect(b.world.daemons.has(b.wild.id)).toBe(false);
  });

  it('decay drains 4 energy per hit; absorb regains 10% of damage taken', () => {
    const a = duel('decay');
    a.wild.energy = 100;
    a.use('ping');
    expect(a.wild.energy).toBeCloseTo(96, 0); // plus one tick of regen

    const b = duel('echo', 'absorb');
    b.wild.energy = 50;
    const dealt = b.hits(b.use('ping')).reduce((s, h) => s + h.amount, 0);
    expect(b.wild.energy).toBeCloseTo(50 + dealt * 0.1, 0);
  });

  it('echo hits again at half power about a quarter of the time', () => {
    let doubles = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const { world, use, hits } = duel('echo');
      for (let k = 0; k < i; k++) world.rng.float();
      const h = hits(use('ping'));
      if (h.length === 2) {
        doubles++;
        expect(h[1]!.amount).toBe(Math.max(1, Math.floor(h[0]!.amount / 2)));
      } else expect(h.length).toBe(1);
    }
    expect(doubles / N).toBeGreaterThan(0.15);
    expect(doubles / N).toBeLessThan(0.35);
  });

  it('onewayfn is immune to statuses; entropy makes inflicted statuses last +50%', () => {
    const immune = duel('echo', 'onewayfn');
    for (let i = 0; i < 12; i++) {
      immune.mine.cooldowns = {};
      immune.mine.energy = 128;
      immune.use('broadcast', { targetId: immune.wild.id });
    }
    expect(immune.wild.statuses.leaking).toBeUndefined();

    const e = duel('entropy');
    let status: { untilTick: number } | undefined;
    for (let i = 0; i < 12 && !status; i++) {
      e.mine.cooldowns = {};
      e.mine.energy = 128;
      status = e.use('broadcast', { targetId: e.wild.id }).events.find((ev) => ev.event.e === 'status')?.event as { untilTick: number } | undefined;
      if (status) expect(status.untilTick - e.world.tick).toBe(e.world.ticks(getMove('broadcast').status!.durationMs * 1.5));
    }
    expect(status).toBeDefined();
  });

  it('voidstep moves 50% faster with no hostile within 8 tiles', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice', { x: 5.5, y: 20.5, ram: [ownedRecord('pingling', 20, 0, 'alice-d0')] }));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const d = world.daemons.get('alice-d0')!;
    const run = (trait: string, wildAt: number | null) => {
      d.trait = trait;
      d.x = 5.5;
      d.y = 20.5;
      const w = wildAt === null ? null : placeWild(world, 'bitrot', 5, 5.5, wildAt);
      step(world, input('alice', { cmd: 'moveTo', actor: 'alice-d0', args: { x: 12.5, y: 20.5 } }));
      const moved = d.x - 5.5;
      if (w) world.removeDaemon(w.id);
      d.path = [];
      return moved;
    };
    const plain = run('echo', null);
    expect(run('voidstep', null)).toBeCloseTo(plain * 1.5, 5);
    expect(run('voidstep', 26.5)).toBeCloseTo(plain, 5);
  });
});

describe('statuses', () => {
  it('leaking drains 2 energy per second; battery raises regen by 50%', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    const d = world.daemons.get('alice-d0')!;
    d.energy = 64;
    const regen = (1 + d.stats.energy / 64) / TICK_HZ;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(64 + regen, 6);
    d.statuses.leaking = world.tick + 100;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(64 + 2 * regen - LEAK_PER_SECOND / TICK_HZ, 6);
    delete d.statuses.leaking;
    d.heldItem = 'battery';
    const before = d.energy;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(before + regen * 1.5, 6);
  });

  it('exposed raises damage taken by 25% until it expires', () => {
    const { mine, wild, use, hits } = duel('echo', 'onewayfn');
    wild.statuses.stalled = 10_000;
    const plain = hits(use('ping'))[0]!.amount;
    expect(plain).toBeGreaterThan(0);
    mine.cooldowns = {};
    wild.hp = wild.stats.hp;
    wild.statuses.exposed = 10_000;
    const exposed = hits(use('ping'))[0]!.amount;
    expect(exposed).toBeGreaterThan(plain);
  });

  it('throttled lengthens own cooldowns by 50%', () => {
    const { world, mine } = duel('echo');
    const base = cooldownMs(mine, ping, world.tick);
    mine.statuses.throttled = world.tick + 100;
    expect(cooldownMs(mine, ping, world.tick)).toBe(Math.floor(base * 1.5));
  });

  it('stalled daemons do not move; unstalled ones do', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const d = world.daemons.get('alice-d0')!;
    d.path = [{ x: 12.5, y: 5.5 }];
    d.statuses.stalled = world.tick + 100;
    const x0 = d.x;
    idle(world, 3);
    expect(d.x).toBe(x0);
    delete d.statuses.stalled;
    idle(world, 3);
    expect(d.x).toBeGreaterThan(x0);
  });

  it('leaking stops draining once it expires', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('alice'));
    const d = world.daemons.get('alice-d0')!;
    d.energy = 64;
    d.statuses.leaking = world.tick + 1;
    idle(world, 4);
    const regen = (1 + d.stats.energy / 64) / TICK_HZ;
    const e = d.energy;
    idle(world, 1);
    expect(d.energy).toBeCloseTo(e + regen, 6);
  });
});

describe('engagement state', () => {
  it('tagging a bitshield wild daemon spends its shield on the tagging hit; tag expiry restores it', () => {
    const { world, wild, use, hits } = duel('echo', 'bitshield');
    expect(hits(use('ping'))[0]!.amount).toBe(0);
    expect(wild.engagement.blocked).toBe(true);
    expect(wild.wild!.tagOwner).toBe('alice');
    for (let i = 0; i < 400 && wild.wild!.tagOwner !== null; i++) {
      wild.wild!.tagUntil = world.tick;
      idle(world, 1);
    }
    expect(wild.wild!.tagOwner).toBeNull();
    expect(wild.engagement).toMatchObject({ blocked: false, survived: false, lastHitMove: null });
  });
});


describe('trait edge cases', () => {
  /** Forces every chance roll to succeed so echo always rolls its second hit. */
  const rigEcho = (world: { rng: { chance: (p: number) => boolean } }) => {
    world.rng.chance = () => true;
  };

  it('echo does not repeat a bitshield-blocked hit', () => {
    const { world, use, hits } = duel('echo', 'bitshield');
    rigEcho(world);
    expect(hits(use('ping'))).toHaveLength(1);
  });

  it('echo does not finish a target nullsafe just saved', () => {
    const { world, wild, use, hits } = duel('echo', 'nullsafe');
    rigEcho(world);
    wild.hp = 1;
    wild.wild!.aggro = null;
    expect(hits(use('ping'))).toHaveLength(1);
    expect(wild.hp).toBe(1);
  });

  it('echo still repeats a damaging hit when rigged (control)', () => {
    const { world, use, hits } = duel('echo');
    rigEcho(world);
    expect(hits(use('ping'))).toHaveLength(2);
  });

  it('a lethal tagging hit spends nullsafe; the next lethal hit kills', () => {
    const { world, mine, wild, use } = duel('lowlatency', 'nullsafe');
    wild.hp = 1;
    wild.wild!.aggro = null;
    use('ping');
    expect(wild.hp).toBe(1);
    expect(wild.engagement.survived).toBe(true);
    mine.cooldowns = {};
    use('ping');
    expect(world.daemons.has(wild.id)).toBe(false);
  });

  it('synburst filler is free only below 25% HP; lazyeval discounts heavy moves only', () => {
    const { mine } = duel('synburst');
    mine.hp = mine.stats.hp;
    expect(energyCost(mine, ping)).toBe(ping.energyCost);
    mine.trait = 'lazyeval';
    expect(energyCost(mine, ping)).toBe(ping.energyCost);
  });

  it('absorb gives more energy than no trait for the same hit', () => {
    const a = duel('echo', 'absorb');
    const b = duel('echo', 'lowlatency');
    a.wild.energy = 50;
    b.wild.energy = 50;
    a.use('ping');
    b.use('ping');
    expect(a.wild.energy).toBeGreaterThan(b.wild.energy);
  });
});
