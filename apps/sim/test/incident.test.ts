import { MemoryBus } from '@daemonet/bus';
import { BOSS_HP_MULTIPLIER, COPY_TTL_MS, INCIDENT_WINDOW_MS, KERNEL_DAEMONS, getSubnet, lineBase } from '@daemonet/rules';
import type { GameEvent, ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, type Daemon, type StepResult } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { input, operatorRecord, ownedRecord, self } from './helpers.js';

const KS = getSubnet('kernelspace');
const ARENA = KS.arena!;

/**
 * A kernelspace world on a hand-cranked clock: created one minute before a scheduled Incident, stepped onto the
 * four-hour mark (the Incident opens), and only then entered by the operators — anyone in kernelspace with no
 * Incident running is sent back to backbone.
 */
function setup(operators = ['alice', 'bob']) {
  let now = Date.parse('2026-10-01T03:59:00.000Z');
  const world = new World({ subnet: KS, seed: 'inc', seedId: 'seed0009', spawner: false, clock: () => new Date(now).toISOString() });
  const idle = world.step([]);
  now += 60_000;
  const opened = world.step([]);
  for (const id of operators) {
    world.addOperator(operatorRecord(id, { subnet: 'kernelspace', x: ARENA.x, y: ARENA.y + 3, ram: [ownedRecord('pingling', 64, 0, `${id}-d0`)] }));
    world.step([input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } })]);
  }
  const events = (r: StepResult) => r.events.map((e) => e.event);
  const incidentEvents = (r: StepResult) => events(r).filter((e): e is Extract<GameEvent, { e: 'incident' }> => e.e === 'incident');
  const hitBoss = (who: string, boss: Daemon) => {
    const d = world.daemons.get(`${who}-d0`)!;
    d.cooldowns = {};
    d.energy = 128;
    d.x = boss.x + 1;
    d.y = boss.y;
    return world.step([input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: boss.id } })]);
  };
  return { world, idle, opened, advance: (ms: number) => (now += ms), events, incidentEvents, hitBoss };
}

describe('Incident lifecycle', () => {
  it('opens on the four-hour mark with a capstone boss at eight times its HP, open to everyone and immune to capture', () => {
    const { world, idle, opened, incidentEvents, hitBoss } = setup();
    expect(incidentEvents(idle)).toEqual([]);
    const inc = world.incident!;
    expect(incidentEvents(opened)).toMatchObject([{ phase: 'open', id: inc.id, species: inc.species, bossId: inc.bossId, endsAt: '2026-10-01T04:20:00.000Z' }]);
    expect(KERNEL_DAEMONS).toContain(inc.species);
    const boss = world.daemons.get(inc.bossId)!;
    expect(boss.level).toBe(64);
    expect(boss.hp).toBe(boss.stats.hp);
    expect(boss.wild).toMatchObject({ boss: true, open: true, tagOwner: null });
    const base = new World({ subnet: KS, seed: 'x', seedId: 'seed000a', spawner: false }).spawnWild(inc.species, 64, { x: 5, y: 5 }, -1, { ...world.daemons.get('alice-d0')!, ivs: boss.ivs, bonus: boss.bonus, nature: boss.nature, traitSlot: boss.traitSlot, clean: false, signature: 0 });
    expect(boss.stats.hp).toBe(base.stats.hp * BOSS_HP_MULTIPLIER);
    expect((entitiesNear(world, boss.x, boss.y, 8).find((e) => e.id === boss.id) as { boss?: boolean; shielded?: boolean })).toMatchObject({ boss: true, shielded: false });

    const first = hitBoss('alice', boss);
    expect(incidentEvents(first)).toMatchObject([{ phase: 'fighting' }]);
    expect(boss.wild!.tagOwner).toBeNull();
    expect(hitBoss('bob', boss).replies[0]).toMatchObject({ ok: true });
    expect([...inc.damage.keys()].sort()).toEqual(['alice', 'bob']);
    expect(world.step([input('alice', { cmd: 'capture', actor: self, args: { targetId: boss.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'immune to capture' });
  });

  it('shields at 75% and calls four adds of the line’s base form; the shield drops when they are cleared', () => {
    const { world, incidentEvents, hitBoss } = setup();
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    boss.hp = Math.floor(boss.stats.hp * 0.75);
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'shield' }]);
    expect(inc.adds).toHaveLength(4);
    for (const id of inc.adds) expect(world.daemons.get(id)).toMatchObject({ species: lineBase(inc.species), level: 40 });
    const hp = boss.hp;
    const blocked = hitBoss('alice', boss);
    expect(boss.hp).toBe(hp);
    expect(blocked.events.map((e) => e.event).find((e) => e.e === 'hit' && e.target === boss.id)).toMatchObject({ amount: 0 });
    for (const id of inc.adds) world.daemons.get(id)!.hp = 0;
    const cleared = world.step([]);
    expect(incidentEvents(cleared)).toMatchObject([{ phase: 'unshield' }]);
    hitBoss('alice', boss);
    expect(boss.hp).toBeLessThan(hp);
    boss.hp = Math.floor(boss.stats.hp * 0.5);
    expect(incidentEvents(world.step([]))).toMatchObject([{ phase: 'shield' }]);
  });

  it('telegraphs a blast two seconds ahead that takes a quarter of max HP from running daemons in the circle', () => {
    const { world, events, hitBoss } = setup(['alice']);
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    boss.statuses.stalled = 1_000_000;
    boss.moves = [];
    hitBoss('alice', boss);
    let warn: Extract<GameEvent, { e: 'telegraph' }> | undefined;
    for (let i = 0; i < 300 && !warn; i++) warn = events(world.step([])).find((e): e is Extract<GameEvent, { e: 'telegraph' }> => e.e === 'telegraph');
    expect(warn).toMatchObject({ radius: 6 });
    expect(warn!.atTick - world.tick).toBe(world.ticks(2000));
    const d = world.daemons.get('alice-d0')!;
    d.x = warn!.x;
    d.y = warn!.y;
    d.path = [];
    d.hp = d.stats.hp;
    const op = world.operators.get('alice')!;
    Object.assign(op, { x: warn!.x, y: warn!.y, path: [] });
    let blast: StepResult | undefined;
    while (world.tick < warn!.atTick) blast = world.step([]);
    expect(events(blast!).find((e) => e.e === 'hit' && e.move === 'telegraph')).toMatchObject({ target: 'alice-d0', amount: Math.ceil(d.stats.hp * 0.25) });
    expect(d.hp).toBe(d.stats.hp - Math.ceil(d.stats.hp * 0.25));
    expect(op.hitTick).toBe(world.tick);
  });

  it('pays the pool by contribution when the boss falls and gives each contributor a personal copy only they can touch', async () => {
    const { world, events, incidentEvents, hitBoss } = setup();
    const store = new MemoryStore();
    for (const id of ['alice', 'bob']) store.operators.set(id, { id, sub: id, name: id, starterClaimed: true, subnet: 'kernelspace', bits: 0, diskCapacity: 256, x: 0, y: 0, inventory: {} });
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    hitBoss('bob', boss);
    inc.damage.set('alice', 7500);
    inc.damage.set('bob', 2500);
    inc.nextPhase = 3;
    boss.hp = 0;
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'cleared', bossId: null, participants: [{ operatorId: 'alice', name: 'alice', share: 0.75, reward: 6144 }, { operatorId: 'bob', reward: 2048 }] }]);
    expect(world.incident).toBeNull();
    expect(world.daemons.has(boss.id)).toBe(false);
    const rewards = r.intents.filter((i) => i.kind === 'incidentReward');
    expect(rewards).toHaveLength(2);
    for (const i of rewards) world.completeIntent(i.id, await store.applyIntent(i, { seedId: 'seed0009' }));
    const after = events(world.step([]));
    expect(after).toContainEqual({ e: 'incidentReward', incidentId: inc.id, reward: 6144, share: 0.75 });
    expect(after).toContainEqual({ e: 'bits', delta: 6144, reason: 'incident', balance: 6144 });
    expect(world.operators.get('bob')!.bits).toBe(2048);
    expect(store.ledger.map((l) => [l.operatorId, l.delta, l.reason])).toEqual([['alice', 6144, 'incident'], ['bob', 2048, 'incident']]);

    const copies = [...world.daemons.values()].filter((d) => d.wild?.personal);
    expect(copies.map((c) => [c.species, c.level, c.wild!.personal]).sort()).toEqual([[inc.species, 48, 'alice'], [inc.species, 48, 'bob']]);
    const mine = copies.find((c) => c.wild!.personal === 'alice')!;
    const use = (who: string) => {
      const d = world.daemons.get(`${who}-d0`)!;
      Object.assign(d, { cooldowns: {}, x: mine.x + 1, y: mine.y });
      return world.step([input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: mine.id } })]).replies[0];
    };
    expect(use('bob')).toMatchObject({ code: 'E_STATE' });
    expect(use('alice')).toMatchObject({ ok: true });
    const bobOp = world.operators.get('bob')!;
    Object.assign(bobOp, { x: mine.x, y: mine.y });
    expect(world.step([input('bob', { cmd: 'capture', actor: self, args: { targetId: mine.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    Object.assign(world.operators.get('alice')!, { x: mine.x, y: mine.y });
    expect(world.step([input('alice', { cmd: 'capture', actor: self, args: { targetId: mine.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ ok: true });
    // the other copy despawns after four minutes
    const other = copies.find((c) => c.wild!.personal === 'bob')!;
    other.wild!.despawnAtTick = world.tick + 1;
    world.step([]);
    world.step([]);
    expect(world.daemons.has(other.id)).toBe(false);
  });

  it('expires after twenty minutes, then sends everyone back to backbone', () => {
    const { world, advance, incidentEvents } = setup(['alice']);
    const inc = world.incident!;
    advance(INCIDENT_WINDOW_MS);
    const r = world.step([]);
    expect(incidentEvents(r)).toMatchObject([{ phase: 'expired', id: inc.id }]);
    expect(world.daemons.has(inc.bossId)).toBe(false);
    expect(world.step([]).intents).toEqual([]);
    advance(COPY_TTL_MS + 6_000);
    const evict = world.step([]);
    expect(evict.intents).toMatchObject([{ kind: 'travel', operatorId: 'alice', to: 'backbone', gatewayId: 'evict' }]);
    expect(world.operators.get('alice')!).toMatchObject({ travelling: true, running: [] });
  });
});

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

describe('Incidents through the Game', () => {
  it('admin start opens one, announces it in every world, opens the backbone gateway and records it; the gateway closes again afterwards', async () => {
    let now = Date.parse('2026-10-01T05:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const backbone = new World({ subnet: getSubnet('backbone'), seed: 'b', seedId: 'bbbb0001', spawner: false, clock });
    const ks = new World({ subnet: KS, seed: 'k', seedId: 'kkkk0002', spawner: false, clock });
    const game = new Game({ worlds: [backbone, ks], store, verify: createDevVerifier('daemonet-users'), bus });
    const conn = new FakeConn();
    game.connect(conn);
    await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
    game.tick();
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(true);
    await bus.publish('admin', { kind: 'incident:start' });
    game.tick();
    expect(ks.incident).not.toBeNull();
    game.tick();
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(false);
    const seen = conn.of('delta').flatMap((d) => d.d.events).filter((e) => e.e === 'incident');
    expect(seen).toMatchObject([{ phase: 'open', species: ks.incident!.species }]);
    await game.flush();
    expect([...store.incidents.values()]).toMatchObject([{ outcome: 'OPEN', species: ks.incident!.species }]);
    const id = ks.incident!.id;
    now += INCIDENT_WINDOW_MS;
    game.tick();
    game.tick();
    await game.flush();
    expect(store.incidents.get(id)).toMatchObject({ outcome: 'EXPIRED' });
    expect(backbone.closedGateways.has('backbone-kernelspace')).toBe(true);
    expect(game.startIncident()).toBe(true);
    await game.shutdown();
  });
});
