import { MemoryBus } from '@daemonet/bus';
import type { PublicChallenge } from '@daemonet/rules';
import { parseClientMessage, type GameEvent, type ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, partyKey } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { CLUSTER_MAX, CREATES_PER_WINDOW, ClusterService, INVITE_TTL_MS, INVITES_PER_WINDOW, JOIN_ATTEMPTS, MAX_PENDING_INVITES } from '../src/runtime/clusters.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

/** Two operators in one world, each running a level-20 Pingling, wired to a ClusterService. */
function party(random: () => number = () => 0.5) {
  const world = makeWorld('party');
  for (const id of ['alice', 'bob', 'carol']) {
    world.addOperator(operatorRecord(id, { ram: [ownedRecord('pingling', 20, 0, `${id}-d0`)] }));
    step(world, input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } }));
  }
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  let now = 1_000_000;
  const clusters = new ClusterService({
    operator: (id) => {
      const op = world.operators.get(id);
      return op ? { op, subnet: world.subnet.id } : undefined;
    },
    send: (to, msg) => sent.push({ to, msg }),
    releaseTags: (key) => world.releaseOrphanTags(key),
    rekeyTags: (from, to) => world.rekeyTags(from, to),
    now: () => now,
    random,
  });
  return { world, clusters, sent, tick: (ms: number) => (now += ms) };
}

describe('ClusterService', () => {
  it('invites nearby operators, accepts within 60 s, joins by code, caps at four, and maintains views', () => {
    const { world, clusters, sent, tick } = party();
    const alice = world.operators.get('alice')!;
    const bob = world.operators.get('bob')!;
    expect(clusters.invite('alice', 'alice')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.invite('alice', 'nobody')).toMatchObject({ code: 'E_STATE' });
    bob.x += 40;
    expect(clusters.invite('alice', 'bob')).toMatchObject({ code: 'E_RANGE' });
    bob.x -= 40;
    const inv = clusters.invite('alice', 'bob') as { clusterId: string };
    expect(sent.at(-1)).toMatchObject({ to: 'bob', msg: { t: 'clusterInvite', d: { clusterId: inv.clusterId, from: 'alice', name: 'alice' } } });
    expect(alice.cluster).toMatchObject({ leaderId: 'alice', members: [{ id: 'alice', away: false }] });
    expect(alice.cluster!.code).toMatch(/^[A-Z2-9]{6}$/);
    tick(61_000);
    expect(clusters.accept('bob', inv.clusterId)).toMatchObject({ code: 'E_STATE', message: 'that invite has expired' });
    clusters.invite('alice', 'bob');
    expect(clusters.accept('bob', inv.clusterId)).toEqual({ clusterId: inv.clusterId });
    expect(bob.cluster!.members.map((m) => m.id)).toEqual(['alice', 'bob']);
    expect(partyKey(alice)).toBe(partyKey(bob));
    expect(partyKey(alice)).toBe(`cluster:${inv.clusterId}`);
    expect(clusters.invite('bob', 'carol')).toMatchObject({ code: 'E_STATE', message: 'only the cluster leader invites' });
    expect(clusters.join('carol', 'zzzzzz')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.join('carol', alice.cluster!.code.toLowerCase())).toEqual({ clusterId: inv.clusterId });
    expect(clusters.join('carol', alice.cluster!.code)).toMatchObject({ code: 'E_STATE', message: 'leave your cluster first' });
    world.addOperator(operatorRecord('dave'));
    world.addOperator(operatorRecord('erin'));
    expect(clusters.join('dave', alice.cluster!.code)).toEqual({ clusterId: inv.clusterId });
    expect(clusters.join('erin', alice.cluster!.code)).toMatchObject({ code: 'E_STATE', message: 'that cluster is full' });
    expect(clusters.of('dave')).toEqual({ id: inv.clusterId, members: ['alice', 'bob', 'carol', 'dave'] });
  });

  it('kicks, hands leadership to the oldest member, and dissolves when empty', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    clusters.join('carol', world.operators.get('alice')!.cluster!.code);
    expect(clusters.kick('bob', 'carol')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.kick('alice', 'carol')).toEqual({ ok: true });
    expect(world.operators.get('carol')!.cluster).toBeNull();
    expect(clusters.leave('alice')).toEqual({ ok: true });
    expect(world.operators.get('alice')!.cluster).toBeNull();
    expect(world.operators.get('bob')!.cluster).toMatchObject({ leaderId: 'bob', members: [{ id: 'bob' }] });
    expect(clusters.leave('bob')).toEqual({ ok: true });
    expect(clusters.of('bob')).toBeUndefined();
    expect(clusters.leave('bob')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.ensure('bob')).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) });
  });

  it('a non-leader cannot kick, the leader cannot kick itself or outsiders; clusterCreate is idempotent', () => {
    const { clusters } = party();
    const made = clusters.ensure('alice') as { clusterId: string; code: string };
    expect(clusters.ensure('alice')).toEqual(made);
    clusters.join('bob', made.code);
    expect(clusters.kick('alice', 'alice')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.kick('alice', 'carol')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.kick('carol', 'bob')).toMatchObject({ code: 'E_STATE', message: 'not in a cluster' });
    expect(clusters.ensure('nobody')).toMatchObject({ code: 'E_STATE' });
  });

  it('cluster ids keep the party key / channel `cluster:<id>` within the protocol Id limit', () => {
    const { clusters, tick } = party(Math.random);
    tick(1e15);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = clusters.ensure('alice') as { clusterId: string };
      ids.add(r.clusterId);
      expect(`cluster:${r.clusterId}`.length).toBeLessThanOrEqual(64);
      expect(r.clusterId).not.toContain(':');
      clusters.leave('alice');
      tick(60_000);
    }
    expect(ids.size).toBe(50);
    expect(parseClientMessage(JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: 'r', cmd: 'chat', actor: 'self', args: { channel: `cluster:${[...ids][0]}`, text: 'hi' } } })).ok).toBe(true);
  });

  it('never loops forever when the code space looks exhausted', () => {
    const { clusters } = party(() => 0);
    expect(clusters.ensure('alice')).toMatchObject({ code: 'AAAAAA' });
    expect(clusters.ensure('bob')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.invite('bob', 'carol')).toMatchObject({ code: 'E_STATE' });
    expect(clusters.of('bob')).toBeUndefined();
  });
});

describe('cluster abuse limits', () => {
  it('rate-limits join attempts per operator (brute-forcing codes), counting failures', () => {
    const { clusters, tick } = party(Math.random);
    const { code } = clusters.ensure('alice') as { code: string };
    for (let i = 0; i < JOIN_ATTEMPTS; i++) expect(clusters.join('bob', 'ZZZZZ2')).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.join('bob', code)).toMatchObject({ code: 'E_RATE' });
    tick(60_000);
    expect(clusters.join('bob', code)).toMatchObject({ clusterId: expect.any(String) });
  });

  it('refuses a join by code to a full cluster', () => {
    const { world, clusters } = party(Math.random);
    const { code } = clusters.ensure('alice') as { code: string };
    for (const id of ['dave', 'erin']) world.addOperator(operatorRecord(id));
    for (const id of ['bob', 'carol', 'dave']) expect(clusters.join(id, code)).toMatchObject({ clusterId: expect.any(String) });
    expect(clusters.of('alice')!.members).toHaveLength(CLUSTER_MAX);
    expect(clusters.join('erin', code)).toMatchObject({ code: 'E_STATE', message: 'that cluster is full' });
    expect(clusters.of('erin')).toBeUndefined();
  });

  it('one pending invite per cluster and target; invites expire; a sender is rate limited; a target holds a bounded number', () => {
    const { world, clusters, sent, tick } = party(Math.random);
    expect(clusters.invite('alice', 'bob')).toMatchObject({ clusterId: expect.any(String) });
    expect(clusters.invite('alice', 'bob')).toMatchObject({ code: 'E_STATE', message: 'that operator already has your invite' });
    expect(sent.filter((s) => s.to === 'bob')).toHaveLength(1);
    tick(INVITE_TTL_MS + 1);
    expect(clusters.pendingInvites).toBe(1);
    expect(clusters.invite('alice', 'bob')).toMatchObject({ clusterId: expect.any(String) });
    // the expired invite was swept; the new one replaces it
    expect(clusters.pendingInvites).toBe(1);
    // the sender's budget
    for (let i = 0; i < 6; i++) world.addOperator(operatorRecord(`t${i}`));
    let ok = 1;
    let limited = 0;
    for (let i = 0; i < 6; i++) {
      const r = clusters.invite('alice', `t${i}`);
      if ('clusterId' in r) ok++;
      else if (r.code === 'E_RATE') limited++;
    }
    expect(ok).toBe(INVITES_PER_WINDOW);
    expect(limited).toBe(7 - INVITES_PER_WINDOW);
    // the target's inbox: at most MAX_PENDING_INVITES leaders (other clusters) at once
    for (let i = 0; i < MAX_PENDING_INVITES + 1; i++) world.addOperator(operatorRecord(`l${i}`));
    const results = Array.from({ length: MAX_PENDING_INVITES + 1 }, (_, i) => clusters.invite(`l${i}`, 'carol'));
    expect(results.filter((r) => 'clusterId' in r)).toHaveLength(MAX_PENDING_INVITES);
    expect(results.at(-1)).toMatchObject({ code: 'E_STATE', message: 'that operator has too many pending invites' });
    // a refused invite creates no cluster for the inviter
    expect(clusters.of(`l${MAX_PENDING_INVITES}`)).toBeUndefined();
  });

  it('a kick sticks: the code rotates for the members, and the kicked operator cannot rejoin by old code, new code or invite', () => {
    const { world, clusters, tick } = party(Math.random);
    const { clusterId, code: oldCode } = clusters.ensure('alice') as { clusterId: string; code: string };
    clusters.join('bob', oldCode);
    clusters.join('carol', oldCode);
    expect(clusters.kick('alice', 'bob')).toEqual({ ok: true });
    const newCode = world.operators.get('alice')!.cluster!.code;
    expect(newCode).not.toBe(oldCode);
    expect(world.operators.get('carol')!.cluster!.code).toBe(newCode);
    expect(clusters.join('bob', oldCode)).toMatchObject({ code: 'E_INVALID' });
    expect(clusters.join('bob', newCode)).toMatchObject({ code: 'E_STATE', message: 'you were removed from that cluster' });
    tick(1000);
    expect(clusters.invite('alice', 'bob')).toEqual({ clusterId });
    expect(clusters.accept('bob', clusterId)).toMatchObject({ code: 'E_STATE', message: 'you were removed from that cluster' });
    expect(clusters.of('bob')).toBeUndefined();
    // someone else still joins with the new code
    world.addOperator(operatorRecord('dave'));
    expect(clusters.join('dave', newCode)).toEqual({ clusterId });
  });

  it('rate-limits creating clusters', () => {
    const { clusters } = party(Math.random);
    for (let i = 0; i < CREATES_PER_WINDOW; i++) {
      expect(clusters.ensure('alice')).toMatchObject({ clusterId: expect.any(String) });
      clusters.leave('alice');
    }
    expect(clusters.ensure('alice')).toMatchObject({ code: 'E_RATE' });
  });

  it('a leader leaving hands over leadership and withdraws its pending invites; joining drops invites to the joiner', () => {
    const { clusters } = party(Math.random);
    const { clusterId, code } = clusters.ensure('alice') as { clusterId: string; code: string };
    clusters.join('bob', code);
    clusters.invite('alice', 'carol');
    clusters.leave('alice');
    expect(clusters.of('bob')).toEqual({ id: clusterId, members: ['bob'] });
    expect(clusters.accept('carol', clusterId)).toMatchObject({ code: 'E_STATE', message: 'that invite has expired' });
    const other = clusters.invite('alice', 'carol') as { clusterId: string };
    expect(clusters.join('carol', code)).toEqual({ clusterId });
    expect(clusters.pendingInvites).toBe(0);
    expect(clusters.accept('carol', other.clusterId)).toMatchObject({ code: 'E_STATE' });
  });
});

describe('party tagging, XP and capture rights', () => {
  it('cluster members share a tag; outsiders are locked out; taggedBy reads as "mine" for every member', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const hit = (who: string) => step(world, input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId: wild.id } })).replies[0];
    expect(hit('alice')).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(`cluster:${clusterId}`);
    expect(hit('bob')).toMatchObject({ ok: true });
    expect(hit('carol')).toMatchObject({ code: 'E_STATE' });
    const seenBy = (id: string) => (entitiesNear(world, 7.5, 5.5, 8, world.operators.get(id)!).find((e) => e.id === wild.id) as { taggedBy: string }).taggedBy;
    expect(seenBy('alice')).toBe('alice');
    expect(seenBy('bob')).toBe('bob');
    expect(seenBy('carol')).toBe(`cluster:${clusterId}`);
    expect(step(world, input('carol', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    const cap = step(world, input('bob', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } }));
    expect(cap.replies[0]).toMatchObject({ ok: true });
  });

  it('splits XP among the damaging daemons of present members and credits clear tickets to each', () => {
    const { world, clusters } = party();
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    clusters.accept('bob', clusterId);
    for (const id of ['alice', 'bob']) {
      world.operators.get(id)!.tickets.push({ id: `t-${id}`, day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    }
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    const xp = [a.xp, b.xp];
    step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: wild.id } }));
    wild.hp = 1;
    const r = step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(a.xp - xp[0]!).toBeGreaterThan(0);
    expect(a.xp - xp[0]!).toBe(b.xp - xp[1]!);
    const progress = r.events.filter((e) => e.event.e === 'ticketProgress').map((e) => e.to);
    expect(progress.sort()).toEqual(['alice', 'bob']);
    // a member more than 32 tiles from the defeated daemon gets nothing
    const far = placeWild(world, 'bitrot', 20, 2.5, 2.5);
    far.trait = 'echo';
    Object.assign(world.operators.get('alice')!, { x: 29.5, y: 29.5, path: [] });
    Object.assign(world.operators.get('bob')!, { x: 3.5, y: 3.5, path: [] });
    Object.assign(b, { x: 3.5, y: 2.5, path: [], cooldowns: {} });
    const before = a.xp;
    far.hp = 1;
    far.wild!.damagedBy.add('alice-d0');
    step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: far.id } }));
    expect(world.daemons.has(far.id)).toBe(false);
    expect(a.xp).toBe(before);
    expect(world.operators.get('alice')!.tickets[0]!.progress).toBe(1);
    expect(world.operators.get('bob')!.tickets[0]!.progress).toBe(2);
  });
});

describe('tags across joins and leaves', () => {
  const hitBy = (world: World, who: string, targetId: string) =>
    step(world, input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId } })).replies[0];
  const tagged = (world: World, who: string, x: number, y: number) => {
    const wild = placeWild(world, 'bitrot', 20, x, y);
    wild.trait = 'echo';
    expect(hitBy(world, who, wild.id)).toMatchObject({ ok: true });
    world.daemons.get(`${who}-d0`)!.cooldowns = {};
    return wild;
  };

  it('joining gives up personal tags (released: untagged, healed, attackers forgotten), never leaving them locked to a key nobody holds', () => {
    const { world, clusters } = party();
    const mine = tagged(world, 'bob', 7.5, 5.5);
    const carols = tagged(world, 'carol', 5.5, 7.5);
    expect(mine.wild!.tagOwner).toBe('bob');
    expect(mine.hp).toBeLessThan(mine.stats.hp);
    const { code } = clusters.ensure('alice') as { code: string };
    clusters.join('bob', code);
    expect(mine.wild!.tagOwner).toBeNull();
    expect(mine.wild!.damagedBy.size).toBe(0);
    expect(mine.hp).toBe(mine.stats.hp);
    // somebody else's tag is untouched
    expect(carols.wild!.tagOwner).toBe('carol');
    // the released daemon can now be tagged for the cluster
    expect(hitBy(world, 'bob', mine.id)).toMatchObject({ ok: true });
    expect(mine.wild!.tagOwner).toBe(partyKey(world.operators.get('alice')!));
  });

  it('founding a cluster (create or first invite) carries the founder’s tags over to it; accepting an invite gives them up', () => {
    const { world, clusters } = party(Math.random);
    const alices = tagged(world, 'alice', 7.5, 5.5);
    const bobs = tagged(world, 'bob', 5.5, 7.5);
    const hp = alices.hp;
    const { clusterId } = clusters.invite('alice', 'bob') as { clusterId: string };
    expect(alices.wild!.tagOwner).toBe(`cluster:${clusterId}`);
    expect(alices.hp).toBe(hp);
    expect(alices.wild!.damagedBy.has('alice-d0')).toBe(true);
    expect(bobs.wild!.tagOwner).toBe('bob');
    clusters.accept('bob', clusterId);
    expect(bobs.wild!.tagOwner).toBeNull();
    // clusterCreate too
    const carols = tagged(world, 'carol', 6.5, 6.5);
    const made = clusters.ensure('carol') as { clusterId: string };
    expect(carols.wild!.tagOwner).toBe(`cluster:${made.clusterId}`);
    expect(hitBy(world, 'carol', carols.id)).toMatchObject({ ok: true });
  });

  it('a personal tag under an open capture is re-keyed to the new cluster (the capture keeps its target) and its XP goes to the party', () => {
    const { world, clusters } = party();
    const wild = tagged(world, 'bob', 7.5, 5.5);
    const r = step(world, input('bob', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } }));
    const start = r.events.map((e) => e.event).find((e): e is Extract<GameEvent, { e: 'captureStart' }> => e.e === 'captureStart')!;
    const { code } = clusters.ensure('alice') as { code: string };
    clusters.join('bob', code);
    const key = partyKey(world.operators.get('bob')!);
    expect(wild.wild!.tagOwner).toBe(key);
    const b = world.daemons.get('bob-d0')!;
    const before = b.xp;
    const done = step(world, input('bob', { cmd: 'submitCapture', actor: self, args: { captureId: start.captureId, answer: solve(start.challenge as PublicChallenge) } }));
    expect(done.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(b.xp).toBeGreaterThan(before);
  });

  it('a member leaving keeps the cluster tag with members still here, and is locked out of it', () => {
    const { world, clusters } = party();
    const { code } = clusters.ensure('alice') as { code: string };
    clusters.join('bob', code);
    const key = partyKey(world.operators.get('alice')!);
    const wild = tagged(world, 'alice', 7.5, 5.5);
    expect(hitBy(world, 'bob', wild.id)).toMatchObject({ ok: true });
    world.daemons.get('bob-d0')!.cooldowns = {};
    clusters.leave('bob');
    expect(wild.wild!.tagOwner).toBe(key);
    expect(hitBy(world, 'bob', wild.id)).toMatchObject({ ok: false, code: 'E_STATE' });
    expect(step(world, input('bob', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'tagged by another operator' });
    // the last member leaving (the cluster dissolves) releases it
    world.daemons.get('alice-d0')!.cooldowns = {};
    clusters.leave('alice');
    expect(wild.wild!.tagOwner).toBeNull();
    expect(hitBy(world, 'bob', wild.id)).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe('bob');
  });

  it('a kick lands between ticks: the kicked member’s queued hit is judged with its new key', () => {
    const { world, clusters } = party();
    const { code } = clusters.ensure('alice') as { code: string };
    clusters.join('bob', code);
    const wild = tagged(world, 'alice', 7.5, 5.5);
    // bob's command is queued for the next tick, the kick arrives before it runs
    const queued = input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } });
    clusters.kick('alice', 'bob');
    expect(step(world, queued).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
    expect(wild.wild!.damagedBy.has('bob-d0')).toBe(false);
  });

  it('a kicked member’s open capture of a cluster-tagged daemon still completes for them; XP goes to the tagging party present', () => {
    const { world, clusters } = party();
    const { code } = clusters.ensure('alice') as { code: string };
    clusters.join('bob', code);
    const key = partyKey(world.operators.get('alice')!);
    const wild = tagged(world, 'alice', 7.5, 5.5);
    expect(hitBy(world, 'bob', wild.id)).toMatchObject({ ok: true });
    const r = step(world, input('bob', { cmd: 'capture', actor: self, args: { targetId: wild.id, tool: 'sniff' } }));
    const start = r.events.map((e) => e.event).find((e): e is Extract<GameEvent, { e: 'captureStart' }> => e.e === 'captureStart')!;
    clusters.kick('alice', 'bob');
    expect(wild.wild!.tagOwner).toBe(key);
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    const xp = [a.xp, b.xp];
    const done = step(world, input('bob', { cmd: 'submitCapture', actor: self, args: { captureId: start.captureId, answer: solve(start.challenge as PublicChallenge) } }));
    expect(done.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(done.intents[0]).toMatchObject({ kind: 'capture', operatorId: 'bob' });
    expect(a.xp).toBeGreaterThan(xp[0]!);
    expect(b.xp).toBe(xp[1]);
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

describe('clusters through the Game', () => {
  function setup() {
    const store = new MemoryStore();
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false, clock: () => FIXED_CLOCK });
    const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), leaveAfterTicks: 2, retryDelaysMs: [1, 1, 1] });
    const join = async (name: string, extra: Record<string, unknown> = {}) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...extra } }));
      return conn;
    };
    let n = 0;
    const cmd = (conn: FakeConn, c: Record<string, unknown>) => game.message(conn, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: `k${++n}`, actor: 'self', ...c } }));
    return { store, a, b, game, join, cmd, lastReq: () => `k${n}` };
  }
  /** The latest `self` the connection received (a delta carries it only when it changed; a travel sends a snapshot). */
  const selfOf = (c: FakeConn) => {
    for (const m of [...c.sent].reverse()) {
      if (m.t === 'snapshot') return m.d.self;
      if (m.t === 'delta' && m.d.self) return m.d.self;
    }
    throw new Error('no self yet');
  };

  it('commands ack immediately, self.cluster arrives in the next delta, cluster chat reaches members across subnets, away flags follow travel, leaving the game leaves the cluster', async () => {
    const { store, a, game, join, cmd } = setup();
    const alice = await join('alice');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join('bob');
    await cmd(alice, { cmd: 'clusterCreate', args: {} });
    const created = alice.of('ack').at(-1)!.d.result as { clusterId: string; code: string };
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    await cmd(bob, { cmd: 'clusterJoin', args: { code: created.code } });
    expect(bob.of('ack').at(-1)!.d.result).toEqual({ clusterId: created.clusterId });
    game.tick();
    expect(selfOf(alice).cluster).toMatchObject({ id: created.clusterId, leaderId: selfOf(alice).id, members: [{ away: false }, { subnet: 'testb', away: true }] });
    expect(selfOf(bob).cluster!.members.map((m) => m.away)).toEqual([true, false]);
    await cmd(alice, { cmd: 'chat', args: { channel: `cluster:${created.clusterId}`, text: 'over here' } });
    await game.flush();
    expect(bob.of('chat').map((m) => m.d.text)).toEqual(['over here']);
    await cmd(bob, { cmd: 'clusterKick', args: { operatorId: selfOf(alice).id } });
    expect(bob.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE' });
    game.disconnect(bob);
    game.tick();
    game.tick();
    game.tick();
    expect(selfOf(alice).cluster!.members).toHaveLength(1);
    await game.shutdown();
  });

  it('replies go to the sending connection with its reqId; errors carry the cluster error code', async () => {
    const { game, join, cmd, lastReq } = setup();
    const alice = await join('alice');
    const spectator = await join('alice', { role: 'spectator' });
    await cmd(alice, { cmd: 'clusterJoin', args: { code: 'ABCDEF' } });
    expect(alice.of('err').at(-1)!.d).toEqual({ reqId: lastReq(), code: 'E_INVALID', message: 'no cluster with that code' });
    await cmd(spectator, { cmd: 'clusterCreate', args: {} });
    expect(spectator.of('err').at(-1)!.d).toMatchObject({ reqId: lastReq(), code: 'E_STATE', message: 'spectators cannot send commands' });
    await cmd(alice, { cmd: 'clusterLeave', args: {} });
    expect(alice.of('err').at(-1)!.d).toMatchObject({ reqId: lastReq(), code: 'E_STATE', message: 'not in a cluster' });
    expect(spectator.of('ack')).toHaveLength(0);
    await game.shutdown();
  });

  it('an invite reaches every connection of the target (also its spectators) as a clusterInvite message', async () => {
    const { a, game, join, cmd } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    const bobWatch = await join('bob', { role: 'spectator' });
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    Object.assign(a.operators.get(bobId)!, { x: a.operators.get(aliceId)!.x + 2 });
    await cmd(alice, { cmd: 'clusterInvite', args: { operatorId: bobId } });
    const { clusterId } = alice.of('ack').at(-1)!.d.result as { clusterId: string };
    for (const c of [bob, bobWatch]) expect(c.of('clusterInvite').at(-1)!.d).toMatchObject({ clusterId, from: aliceId, expiresAt: expect.any(String) });
    await cmd(bob, { cmd: 'clusterAccept', args: { clusterId } });
    expect(bob.of('ack').at(-1)!.d.result).toEqual({ clusterId });
    game.tick();
    expect(selfOf(bob).cluster!.members.map((m) => m.id)).toEqual([aliceId, bobId]);
    await game.shutdown();
  });

  it('a takeover or a transparent reconnect keeps membership while the session lives', async () => {
    const { game, join, cmd } = setup();
    const alice = await join('alice');
    await cmd(alice, { cmd: 'clusterCreate', args: {} });
    const { clusterId } = alice.of('ack').at(-1)!.d.result as { clusterId: string };
    game.tick();
    const again = await join('alice');
    expect(alice.closed).toMatchObject({ reason: 'takeover' });
    expect(again.of('snapshot').at(-1)!.d.self.cluster).toMatchObject({ id: clusterId });
    game.disconnect(again);
    game.tick();
    const third = await join('alice');
    expect(third.of('snapshot').at(-1)!.d.self.cluster).toMatchObject({ id: clusterId });
    expect(game.clusters.of(third.of('authOk')[0]!.d.operatorId)).toMatchObject({ id: clusterId });
    await game.shutdown();
  });

  it('travel keeps membership and flips away flags; the cluster tag stays with the member left behind', async () => {
    const { a, b, game, join, cmd } = setup();
    const GATE = TEST_SUBNET.gateways[0]!;
    const alice = await join('alice');
    const bob = await join('bob');
    await cmd(alice, { cmd: 'claimStarter', args: { species: 'pingling', operatorName: 'alice' } });
    game.tick();
    await game.flush();
    game.tick();
    const aliceId = alice.of('authOk')[0]!.d.operatorId;
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    await cmd(alice, { cmd: 'clusterCreate', args: {} });
    const { clusterId, code } = alice.of('ack').at(-1)!.d.result as { clusterId: string; code: string };
    await cmd(bob, { cmd: 'clusterJoin', args: { code } });
    const op = a.operators.get(aliceId)!;
    Object.assign(op, { x: GATE.at.x, y: GATE.at.y });
    a.daemons.get(op.ram[0]!)!.level = 10;
    // a wild tagged by the cluster in world a, with bob still there
    const wild = placeWild(a, 'bitrot', 20, a.operators.get(bobId)!.x + 1, a.operators.get(bobId)!.y);
    wild.wild!.tagOwner = `cluster:${clusterId}`;
    wild.wild!.tagUntil = a.tick + 10_000;
    await cmd(alice, { cmd: 'travel', args: { gatewayId: GATE.id } });
    game.tick();
    await game.flush();
    expect(b.operators.has(aliceId)).toBe(true);
    expect(b.operators.get(aliceId)!.cluster).toMatchObject({ id: clusterId });
    expect(wild.wild!.tagOwner).toBe(`cluster:${clusterId}`);
    game.tick();
    expect(selfOf(alice).cluster!.members).toEqual([
      { id: aliceId, name: 'alice', subnet: 'testb', away: false },
      { id: bobId, name: null, subnet: 'test', away: true },
    ]);
    expect(selfOf(bob).cluster!.members.map((m) => m.away)).toEqual([true, false]);
    // bob leaving the game: the cluster's tag in world a has nobody left there
    game.disconnect(bob);
    for (let i = 0; i < 4; i++) game.tick();
    expect(game.clusters.of(aliceId)).toEqual({ id: clusterId, members: [aliceId] });
    expect(wild.wild!.tagOwner).toBeNull();
    await game.shutdown();
  });

  it('a member’s name appears in every view once its starter claim commits', async () => {
    const { game, join, cmd } = setup();
    const alice = await join('alice');
    const bob = await join('bob');
    await cmd(alice, { cmd: 'clusterCreate', args: {} });
    const { code } = alice.of('ack').at(-1)!.d.result as { code: string };
    await cmd(bob, { cmd: 'clusterJoin', args: { code } });
    game.tick();
    expect(selfOf(alice).cluster!.members.map((m) => m.name)).toEqual([null, null]);
    await cmd(bob, { cmd: 'claimStarter', args: { species: 'pingling', operatorName: 'bobby' } });
    game.tick();
    await game.flush();
    game.tick();
    expect(selfOf(alice).cluster!.members.map((m) => m.name)).toEqual([null, 'bobby']);
    await game.shutdown();
  });

  it('cluster commands are rate limited by the service, not by the per-tick command budget', async () => {
    const { game, join, cmd } = setup();
    const alice = await join('alice');
    for (let i = 0; i < JOIN_ATTEMPTS + 1; i++) await cmd(alice, { cmd: 'clusterJoin', args: { code: 'ZZZZZ2' } });
    expect(alice.of('err').map((e) => e.d.code)).toEqual([...Array<string>(JOIN_ATTEMPTS).fill('E_INVALID'), 'E_RATE']);
    // the world never saw them
    game.tick();
    expect(alice.of('ack')).toHaveLength(0);
    await game.shutdown();
  });
});
