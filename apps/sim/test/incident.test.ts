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

describe('Incident abuse cases', () => {
  const use = (world: World, who: string, targetId: string, at: { x: number; y: number }) => {
    const d = world.daemons.get(`${who}-d0`)!;
    Object.assign(d, { cooldowns: {}, energy: 128, x: at.x + 1, y: at.y });
    return world.step([input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId } })]);
  };

  it('only HP actually removed from the boss counts: hits on adds, shielded hits and overkill add nothing; adds are immune to capture', () => {
    const { world, hitBoss } = setup(['alice']);
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    boss.trait = ''; // no bitshield / nullsafe surprises
    hitBoss('alice', boss);
    expect(inc.damage.get('alice')).toBe(boss.stats.hp - boss.hp);
    boss.hp = Math.floor(boss.stats.hp * 0.75);
    world.step([]);
    const before = inc.damage.get('alice')!;
    const add = world.daemons.get(inc.adds[0]!)!;
    expect(add.wild).toMatchObject({ open: true, tagOwner: null });
    expect(use(world, 'alice', add.id, add).replies[0]).toMatchObject({ ok: true });
    expect(add.wild!.tagOwner).toBeNull();
    hitBoss('alice', boss);
    expect(inc.damage.get('alice')).toBe(before);
    Object.assign(world.operators.get('alice')!, { x: add.x, y: add.y });
    expect(world.step([input('alice', { cmd: 'capture', actor: self, args: { targetId: add.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'immune to capture' });
    for (const id of inc.adds) world.daemons.get(id)!.hp = 0;
    world.step([]);
    inc.nextPhase = 3;
    boss.hp = 1;
    hitBoss('alice', boss);
    expect(inc.damage.get('alice')).toBe(before + 1);
  });

  it('one copy per contributor (none for bystanders); it despawns after four minutes or when its owner leaves kernelspace', () => {
    const { world, hitBoss } = setup(['alice', 'bob', 'carol']);
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    inc.damage.set('bob', 100);
    inc.nextPhase = 3;
    boss.hp = 0;
    world.step([]);
    const copies = () => [...world.daemons.values()].filter((d) => d.wild?.personal).map((d) => d.wild!.personal).sort();
    expect(copies()).toEqual(['alice', 'bob']);
    for (const d of world.daemons.values()) if (d.wild?.personal) expect(d.wild.despawnAtTick! - world.tick).toBe(world.ticks(COPY_TTL_MS));
    world.removeOperator('bob');
    expect(copies()).toEqual(['alice']);
    for (let i = 0; i < 4; i++) world.step([]);
    expect(copies()).toEqual(['alice']);
  });

  it('a cluster mate can neither hit nor capture a personal copy, sees it as someone else’s, and cluster changes never release it', () => {
    const { world, hitBoss } = setup(['alice', 'bob']);
    const cluster = { id: 'c1', code: 'ABCDEF', leaderId: 'alice', members: [] };
    for (const id of ['alice', 'bob']) world.operators.get(id)!.cluster = { ...cluster };
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    hitBoss('bob', boss);
    inc.nextPhase = 3;
    boss.hp = 0;
    world.step([]);
    const mine = [...world.daemons.values()].find((d) => d.wild?.personal === 'alice')!;
    expect(use(world, 'bob', mine.id, mine).replies[0]).toMatchObject({ code: 'E_STATE', message: 'not a valid target' });
    Object.assign(world.operators.get('bob')!, { x: mine.x, y: mine.y });
    expect(world.step([input('bob', { cmd: 'capture', actor: self, args: { targetId: mine.id, tool: 'sniff' } })]).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    const seen = (viewer: string) => (entitiesNear(world, mine.x, mine.y, 4, world.operators.get(viewer)).find((e) => e.id === mine.id) as { taggedBy: string | null }).taggedBy;
    expect(seen('alice')).toBe('alice');
    expect(seen('bob')).not.toBe('bob');
    world.releaseOrphanTags('cluster:c1');
    world.releaseOrphanTags('alice');
    world.rekeyTags('alice', 'cluster:c1');
    expect(mine.wild!.tagOwner).toBe('personal:alice');
    expect(use(world, 'alice', mine.id, mine).replies[0]).toMatchObject({ ok: true });
  });

  it('a contributor who left kernelspace before the clear gets no copy and is never credited by kernelspace (even if back)', async () => {
    const { world, hitBoss } = setup(['alice', 'bob']);
    const store = new MemoryStore();
    for (const id of ['alice', 'bob']) store.operators.set(id, { id, sub: id, name: id, starterClaimed: true, subnet: 'kernelspace', bits: 0, diskCapacity: 256, x: 0, y: 0, inventory: {} });
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    hitBoss('alice', boss);
    hitBoss('bob', boss);
    world.removeOperator('bob');
    inc.nextPhase = 3;
    boss.hp = 0;
    const r = world.step([]);
    const rewards = r.intents.filter((i) => i.kind === 'incidentReward');
    expect(rewards.map((i) => i.operatorId).sort()).toEqual(['alice', 'bob']);
    const bobs = rewards.find((i) => i.operatorId === 'bob')!;
    expect(world.isRewardElsewhere(bobs.id)).toBe(true);
    expect([...world.daemons.values()].filter((d) => d.wild?.personal).map((d) => d.wild!.personal)).toEqual(['alice']);
    // bob reconnects into kernelspace with a balance loaded before the commit: the runtime (not this world) decides
    world.addOperator(operatorRecord('bob', { subnet: 'kernelspace', x: ARENA.x, y: ARENA.y + 3, ram: [ownedRecord('pingling', 64, 0, 'bob-d0')] }));
    for (const i of rewards) world.completeIntent(i.id, await store.applyIntent(i, { seedId: 'seed0009' }));
    world.step([]);
    expect(world.operators.get('bob')!.bits).toBe(0);
    expect(world.operators.get('alice')!.bits).toBe((rewards.find((i) => i.operatorId === 'alice') as { reward: number }).reward);
    expect(world.isRewardElsewhere(bobs.id)).toBe(false);
  });

  it('a blast lands where and when it was telegraphed whatever scripts send meanwhile; a daemon moved out is spared', () => {
    const { world, events, hitBoss } = setup(['alice']);
    const inc = world.incident!;
    const boss = world.daemons.get(inc.bossId)!;
    boss.statuses.stalled = 1_000_000;
    boss.moves = [];
    hitBoss('alice', boss);
    let warn: Extract<GameEvent, { e: 'telegraph' }> | undefined;
    for (let i = 0; i < 300 && !warn; i++) warn = events(world.step([])).find((e): e is Extract<GameEvent, { e: 'telegraph' }> => e.e === 'telegraph');
    const d = world.daemons.get('alice-d0')!;
    Object.assign(d, { x: warn!.x + 7, y: warn!.y, path: [] });
    Object.assign(world.operators.get('alice')!, { x: warn!.x + 7, y: warn!.y, path: [] });
    let hits = 0;
    while (world.tick < warn!.atTick) {
      const spam = Array.from({ length: 8 }, () => input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: boss.id } }));
      const r = world.step(spam);
      expect(events(r).filter((e) => e.e === 'telegraph')).toEqual([]);
      hits += events(r).filter((e) => e.e === 'hit' && e.move === 'telegraph').length;
      if (world.tick < warn!.atTick) expect(inc.telegraph).toEqual({ x: warn!.x, y: warn!.y, radius: warn!.radius, atTick: warn!.atTick });
    }
    expect(inc.telegraph).toBeNull();
    expect(hits).toBe(0);
  });

  it('a failed eviction is raised again only after a grace period', () => {
    const { world, advance } = setup(['alice']);
    advance(INCIDENT_WINDOW_MS);
    world.step([]);
    advance(COPY_TTL_MS + 6_000);
    const first = world.step([]).intents[0]!;
    world.completeIntent(first.id, { ok: false, reason: 'db down' });
    expect(world.operators.get('alice')!.travelling).toBe(false);
    let again;
    let waited = 0;
    while (!again) {
      again = world.step([]).intents.find((i) => i.kind === 'travel');
      waited++;
    }
    expect(waited).toBeGreaterThanOrEqual(world.ticks(5_000) - 1);
  });
});

describe('Incidents through the Game: payouts, gateways, admin', () => {
  function game(start = '2026-10-01T05:00:00.000Z') {
    let now = Date.parse(start);
    const clock = () => new Date(now).toISOString();
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const backbone = new World({ subnet: getSubnet('backbone'), seed: 'b', seedId: 'bbbb0001', spawner: false, clock });
    const ks = new World({ subnet: KS, seed: 'k', seedId: 'kkkk0002', spawner: false, clock });
    const g = new Game({ worlds: [backbone, ks], store, verify: createDevVerifier('daemonet-users'), bus });
    return { g, store, bus, backbone, ks, advance: (ms: number) => (now += ms) };
  }

  it('pays a contributor who is in another world when the boss falls, exactly once, with the event in its world', async () => {
    const { g, store, backbone, ks } = game();
    const conn = new FakeConn();
    g.connect(conn);
    await g.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice' } }));
    const alice = conn.of('authOk')[0]!.d.operatorId;
    expect(g.startIncident()).toBe(true);
    g.tick();
    const inc = ks.incident!;
    inc.damage.set(alice, 500);
    ks.daemons.get(inc.bossId)!.hp = 0;
    g.tick();
    await g.flush();
    g.tick();
    g.tick();
    await g.flush();
    expect(backbone.operators.get(alice)!.bits).toBe(8192);
    expect(store.ledger.filter((l) => l.reason === 'incident')).toEqual([expect.objectContaining({ operatorId: alice, delta: 8192, ref: inc.id })]);
    const events = conn.of('delta').flatMap((d) => d.d.events);
    expect(events.filter((e) => e.e === 'incidentReward')).toEqual([{ e: 'incidentReward', incidentId: inc.id, reward: 8192, share: 1 }]);
    expect(events.filter((e) => e.e === 'incident').map((e) => (e as { phase: string }).phase)).toEqual(['open', 'cleared']);
    expect(store.incidents.get(inc.id)).toMatchObject({ outcome: 'CLEARED', participants: [{ operatorId: alice, reward: 8192 }] });
    await g.shutdown();
  });

  it('the gateway admits sixteen: a 17th travel in the same tick and a travel after the Incident closed are refused', () => {
    const { g, backbone, ks, advance } = game();
    g.startIncident();
    g.tick();
    g.tick();
    for (let i = 0; i < 14; i++) ks.addOperator(operatorRecord(`k${i}`, { subnet: 'kernelspace', x: KS.spawn.x, y: KS.spawn.y }));
    const gate = backbone.subnet.gateways.find((x) => x.incidentOnly)!;
    for (const p of ['p15', 'p16', 'p17']) backbone.addOperator(operatorRecord(p, { subnet: 'backbone', x: gate.at.x, y: gate.at.y, ram: [ownedRecord('pingling', 40, 0, `${p}-d0`)] }));
    const travel = (p: string) => input(p, { cmd: 'travel', actor: self, args: { gatewayId: gate.id } });
    const r = backbone.step([travel('p15'), travel('p16'), travel('p17')]);
    expect(r.intents.map((i) => i.operatorId)).toEqual(['p15', 'p16']);
    expect(r.replies).toMatchObject([{ operatorId: 'p17', ok: false, code: 'E_STATE', message: 'no Incident is open (or kernelspace is full)' }]);
    g.tick();
    expect(backbone.closedGateways.has(gate.id)).toBe(true);
    // p15's travel fails: the place is free again
    backbone.completeIntent(r.intents[0]!.id, { ok: false, reason: 'db down' });
    g.tick();
    expect(backbone.closedGateways.has(gate.id)).toBe(false);
    // the Incident ends; a travel queued in the same tick (before the gateways are recomputed) is still refused
    advance(INCIDENT_WINDOW_MS);
    ks.step([]);
    expect(ks.incident).toBeNull();
    expect(backbone.closedGateways.has(gate.id)).toBe(false);
    expect(backbone.step([travel('p15')]).replies).toMatchObject([{ operatorId: 'p15', code: 'E_STATE', message: 'no Incident is open (or kernelspace is full)' }]);
  });

  it('an operator whose record names a full kernelspace comes back at backbone', async () => {
    const { g, store, backbone, ks } = game();
    g.startIncident();
    g.tick();
    for (let i = 0; i < 16; i++) ks.addOperator(operatorRecord(`k${i}`, { subnet: 'kernelspace', x: KS.spawn.x, y: KS.spawn.y }));
    store.operators.set('ally', { id: 'ally', sub: 'dev-ally', name: 'ally', starterClaimed: true, subnet: 'kernelspace', bits: 0, diskCapacity: 256, x: ARENA.x, y: ARENA.y, inventory: {} });
    const conn = new FakeConn();
    g.connect(conn);
    await g.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:ally' } }));
    expect(g.worldOf('ally')).toBe(backbone);
    expect(backbone.operators.get('ally')).toMatchObject({ x: backbone.subnet.spawn.x, y: backbone.subnet.spawn.y });
    await g.shutdown();
  });

  it('an admin start while one runs is ignored; malformed and echoed starts are dropped', async () => {
    const { g, bus, ks, advance } = game();
    await bus.publish('admin', { kind: 'incident:start' });
    g.tick();
    const id = ks.incident!.id;
    expect(g.startIncident()).toBe(false);
    await bus.publish('admin', { kind: 'incident:start', origin: 'api' });
    g.tick();
    expect(ks.incident!.id).toBe(id);
    advance(INCIDENT_WINDOW_MS);
    g.tick();
    expect(ks.incident).toBeNull();
    await bus.publish('admin', { kind: 'incident:start', origin: 'sim' });
    await bus.publish('admin', { kind: 'incident:start', origin: 'elsewhere' });
    g.tick();
    expect(ks.incident).toBeNull();
    await bus.publish('admin', { kind: 'incident:start', origin: 'api' });
    g.tick();
    expect(ks.incident!.id).not.toBe(id);
    await g.shutdown();
  });
});
