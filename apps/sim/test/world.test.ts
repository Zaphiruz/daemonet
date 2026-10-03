import { LO } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, type Input } from '../src/core/index.js';
import { input, operatorRecord, self } from './helpers.js';

function loWorld(seed: string, odds?: { clean: number; signatureStep: number }): World {
  return new World({ subnet: LO, seed, seedId: 'seed0001', ...(odds ? { odds } : {}) });
}

/** A scripted bot: runs its starter, then wanders between two points and attacks what it can reach. */
function botInputs(world: World, opId: string, tick: number): Input[] {
  const op = world.operators.get(opId)!;
  const inputs: Input[] = [];
  if (tick === 1) inputs.push(input(opId, { cmd: 'run', actor: self, args: { daemonId: `${opId}-d0` } }));
  if (op.path.length === 0) {
    const dest = tick % 400 < 200 ? { x: 40.5, y: 20.5 } : { x: 20.5, y: 20.5 };
    inputs.push(input(opId, { cmd: 'moveTo', actor: self, args: dest }));
  }
  const mine = world.daemons.get(`${opId}-d0`);
  if (mine?.active) {
    const near = [...world.daemons.values()].find((d) => d.wild && d.active && Math.hypot(d.x - mine.x, d.y - mine.y) <= 2);
    if (near) inputs.push(input(opId, { cmd: 'use', actor: mine.id, args: { move: 'ping', targetId: near.id } }));
  }
  return inputs;
}

function run(seed: string, ticks: number): string {
  const world = loWorld(seed);
  world.addOperator(operatorRecord('alice', { x: 20.5, y: 20.5 }));
  world.addOperator(operatorRecord('bob', { x: 22.5, y: 20.5 }));
  const log: unknown[] = [];
  for (let t = 1; t <= ticks; t++) {
    const r = world.step([...botInputs(world, 'alice', t), ...botInputs(world, 'bob', t)]);
    log.push(r.events.map((e) => e.event), r.replies.map((x) => (x.ok ? 'ok' : x.code)));
  }
  return JSON.stringify(log);
}

describe('World on lo', () => {
  it('fills all four regions to their cap at start', () => {
    const world = loWorld('fill');
    expect(world.regionCounts).toEqual([16, 16, 16, 16]);
    const wild = [...world.daemons.values()].filter((d) => d.wild);
    expect(wild).toHaveLength(64);
    for (const d of wild) {
      const region = LO.regions[d.wild!.region]!;
      expect(d.level).toBeGreaterThanOrEqual(region.levels[0]);
      expect(d.level).toBeLessThanOrEqual(region.levels[1]);
    }
  });

  it('announces clean and signature spawns server-wide', () => {
    const world = loWorld('shiny', { clean: 1, signatureStep: 0.5 });
    const first = world.step([]);
    const shiny = first.events.filter((e) => e.event.e === 'signatureSpawn');
    expect(shiny).toHaveLength(64);
    expect(shiny.every((e) => e.to === null && e.at === null)).toBe(true);
  });

  it('respawns one daemon per region every 4096 ms while below cap', () => {
    const world = loWorld('respawn');
    const victim = [...world.daemons.values()].find((d) => d.wild?.region === 0)!;
    world.removeDaemon(victim.id);
    expect(world.regionCounts[0]).toBe(15);
    for (let i = 0; i < 70; i++) world.step([]);
    expect(world.regionCounts[0]).toBe(16);
  });

  it('is deterministic: the same seed and inputs give the same event stream', () => {
    expect(run('replay', 600)).toEqual(run('replay', 600));
    expect(run('replay', 200)).not.toEqual(run('other', 200));
  });

  it('entitiesNear returns operators and active daemons within the radius', () => {
    const world = loWorld('near');
    world.addOperator(operatorRecord('alice', { x: 20.5, y: 20.5 }));
    const near = entitiesNear(world, 20.5, 20.5);
    expect(near.some((e) => e.kind === 'operator' && e.id === 'alice')).toBe(true);
    for (const e of near) expect(Math.hypot(e.x - 20.5, e.y - 20.5)).toBeLessThanOrEqual(32);
  });

  it('steps 64 operators with 2 running daemons each within budget', () => {
    const world = loWorld('load');
    for (let i = 0; i < 64; i++) {
      world.addOperator(operatorRecord(`op${i}`, { x: 20.5 + (i % 8) * 4, y: 12.5 + Math.floor(i / 8) * 4 }));
    }
    const durations: number[] = [];
    for (let t = 1; t <= 160; t++) {
      const inputs: Input[] = [];
      for (let i = 0; i < 64; i++) {
        const id = `op${i}`;
        if (t === 1) inputs.push(input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } }));
        if (t === 70) inputs.push(input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d1` } }));
        if (t % 32 === 2) inputs.push(input(id, { cmd: 'moveTo', actor: self, args: { x: 20.5 + ((i * 7 + t) % 36), y: 12.5 + ((i * 5 + t) % 36) } }));
      }
      const t0 = performance.now();
      world.step(inputs);
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)]!;
    expect(p99).toBeLessThan(32);
  });
});
