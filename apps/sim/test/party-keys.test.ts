import type { PublicChallenge } from '@daemonet/rules';
import { OperatorSelf, type GameEvent } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { PARTY_RADIUS, entitiesNear, partyKey, toDaemonEntity, toSelf, type ClusterView, type World } from '../src/core/index.js';
import { partyPresent, partyRecipients } from '../src/core/systems/progress.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

const CLUSTER = 'k1';
const KEY = `cluster:${CLUSTER}`;

/** alice, bob and carol each running a level-20 Pingling at (5.5, 5.5); alice and bob share cluster k1. */
function party(): World {
  const world = makeWorld('party');
  for (const id of ['alice', 'bob', 'carol']) {
    world.addOperator(operatorRecord(id, { ram: [ownedRecord('pingling', 20, 0, `${id}-d0`)] }));
    step(world, input(id, { cmd: 'run', actor: self, args: { daemonId: `${id}-d0` } }));
  }
  const view: ClusterView = {
    id: CLUSTER,
    code: 'ABC234',
    leaderId: 'alice',
    members: [
      { id: 'alice', name: 'alice', subnet: 'test', away: false },
      { id: 'bob', name: 'bob', subnet: 'test', away: false },
    ],
  };
  world.operators.get('alice')!.cluster = view;
  world.operators.get('bob')!.cluster = view;
  return world;
}

const hit = (world: World, who: string, targetId: string) =>
  step(world, input(who, { cmd: 'use', actor: `${who}-d0`, args: { move: 'ping', targetId } })).replies[0];
const capture = (world: World, who: string, targetId: string) =>
  step(world, input(who, { cmd: 'capture', actor: self, args: { targetId, tool: 'sniff' } }));

describe('party keys', () => {
  it('partyKey is the operator id when solo and cluster:<id> in a cluster; addOperator starts solo', () => {
    const world = makeWorld();
    const op = world.addOperator(operatorRecord('dave'));
    expect(op.cluster).toBeNull();
    expect(partyKey(op)).toBe('dave');
    expect(partyKey(party().operators.get('bob')!)).toBe(KEY);
    expect(PARTY_RADIUS).toBe(32);
  });

  it('a tag is written as the party key; every member may hit and capture, outsiders may not', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    expect(hit(world, 'alice', wild.id)).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(KEY);
    expect(hit(world, 'bob', wild.id)).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(KEY);
    expect(hit(world, 'carol', wild.id)).toMatchObject({ ok: false, code: 'E_STATE' });
    expect(capture(world, 'carol', wild.id).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'tagged by another operator' });
    expect(capture(world, 'bob', wild.id).replies[0]).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(KEY);
  });

  it('a capture by an untagged member writes the party key', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    expect(capture(world, 'bob', wild.id).replies[0]).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe(KEY);
    expect(hit(world, 'alice', wild.id)).toMatchObject({ ok: true });
  });

  it('a bare operator id never matches a clustered operator (no bare-id comparison remains)', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.wild!.tagOwner = 'alice';
    wild.wild!.tagUntil = world.tick + 10_000;
    expect(hit(world, 'alice', wild.id)).toMatchObject({ ok: false, code: 'E_STATE' });
    expect(capture(world, 'alice', wild.id).replies[0]).toMatchObject({ ok: false, message: 'tagged by another operator' });
    // and a solo operator's tag is its own id, as before
    wild.wild!.tagOwner = 'carol';
    expect(hit(world, 'carol', wild.id)).toMatchObject({ ok: true });
    expect(wild.wild!.tagOwner).toBe('carol');
    expect(hit(world, 'bob', wild.id)).toMatchObject({ ok: false, code: 'E_STATE' });
  });

  it('taggedBy reads as the viewer id for its own party only; others see the raw key', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    hit(world, 'alice', wild.id);
    const seenBy = (id: string) => (entitiesNear(world, 7.5, 5.5, 8, world.operators.get(id)!).find((e) => e.id === wild.id) as { taggedBy: string }).taggedBy;
    expect(seenBy('alice')).toBe('alice');
    expect(seenBy('bob')).toBe('bob');
    expect(seenBy('carol')).toBe(KEY);
    expect(toDaemonEntity(world, wild)).toMatchObject({ taggedBy: KEY });
    // a solo tag shows the tagger's id to everyone (unchanged)
    const solo = placeWild(world, 'bitrot', 20, 5.5, 7.5);
    solo.wild!.tagOwner = 'carol';
    expect(toDaemonEntity(world, solo, world.operators.get('alice')!)).toMatchObject({ taggedBy: 'carol' });
    expect(toDaemonEntity(world, solo, world.operators.get('carol')!)).toMatchObject({ taggedBy: 'carol' });
  });

  it('splits defeat XP among the damaging daemons of present members and credits clear tickets to each', () => {
    const world = party();
    for (const id of ['alice', 'bob']) {
      world.operators.get(id)!.tickets.push({ id: `t-${id}`, day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    }
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    const xp = [a.xp, b.xp];
    expect(hit(world, 'alice', wild.id)).toMatchObject({ ok: true });
    wild.hp = 1;
    const r = step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } }));
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(a.xp - xp[0]!).toBeGreaterThan(0);
    expect(a.xp - xp[0]!).toBe(b.xp - xp[1]!);
    const progress = r.events.filter((e) => e.event.e === 'ticketProgress').map((e) => e.to);
    expect(progress.sort()).toEqual(['alice', 'bob']);
    // a member more than PARTY_RADIUS tiles from the defeated daemon gets neither XP nor ticket credit
    const far = placeWild(world, 'bitrot', 20, 2.5, 2.5);
    far.trait = 'echo';
    Object.assign(world.operators.get('alice')!, { x: 29.5, y: 29.5, path: [] });
    Object.assign(world.operators.get('bob')!, { x: 3.5, y: 3.5, path: [] });
    Object.assign(b, { x: 3.5, y: 2.5, path: [], cooldowns: {} });
    const before = a.xp;
    expect(hit(world, 'bob', far.id)).toMatchObject({ ok: true });
    far.hp = 1;
    far.wild!.damagedBy.add('alice-d0');
    Object.assign(b, { cooldowns: {} });
    expect(hit(world, 'bob', far.id)).toMatchObject({ ok: true });
    expect(world.daemons.has(far.id)).toBe(false);
    expect(a.xp).toBe(before);
    expect(world.operators.get('alice')!.tickets[0]!.progress).toBe(1);
    expect(world.operators.get('bob')!.tickets[0]!.progress).toBe(2);
  });

  it('a solo tag owner gets its XP and clear credit at any distance (no party radius when solo)', () => {
    const world = party();
    const carol = world.operators.get('carol')!;
    carol.tickets.push({ id: 't-carol', day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    const wild = placeWild(world, 'bitrot', 20, 2.5, 2.5);
    wild.wild!.tagOwner = 'carol';
    wild.wild!.tagUntil = world.tick + 10_000;
    wild.wild!.damagedBy.add('carol-d0');
    Object.assign(carol, { x: 29.5, y: 29.5, path: [] });
    expect(partyPresent(world, 'carol', wild).map((o) => o.id)).toEqual(['carol']);
    const c = world.daemons.get('carol-d0')!;
    const before = c.xp;
    wild.hp = 0;
    step(world);
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(c.xp).toBeGreaterThan(before);
    expect(carol.tickets[0]!.progress).toBe(1);
  });

  it('a member knocked out in the same tick as the defeat still counts as present (credit before the spawn teleport)', () => {
    const world = party();
    const alice = world.operators.get('alice')!;
    alice.tickets.push({ id: 't-alice', day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    // far from spawn (5.5, 4.5): the fight is > PARTY_RADIUS away from where a knocked-out operator lands
    const wild = placeWild(world, 'bitrot', 20, 30.5, 26.5);
    Object.assign(alice, { x: 30.5, y: 25.5, path: [] });
    Object.assign(world.operators.get('bob')!, { x: 29.5, y: 26.5, path: [] });
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    Object.assign(a, { x: 30.5, y: 24.5, path: [] });
    Object.assign(b, { x: 29.5, y: 25.5, path: [] });
    wild.wild!.tagOwner = KEY;
    wild.wild!.tagUntil = world.tick + 10_000;
    wild.wild!.damagedBy.add('alice-d0').add('bob-d0');
    const xp = [a.xp, b.xp];
    a.hp = 0;
    wild.hp = 0;
    step(world);
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(a.crashed).toBe(true);
    expect(alice).toMatchObject({ x: 5.5, y: 4.5 });
    expect(a.xp).toBe(xp[0]); // crashed daemons earn nothing
    expect(b.xp).toBeGreaterThan(xp[1]!);
    expect(alice.tickets[0]!.progress).toBe(1);
  });

  it('an outsider never gets XP or ticket credit from a party defeat', () => {
    const world = party();
    world.operators.get('carol')!.tickets.push({ id: 't-carol', day: '2026-09-30', subnet: 'test', index: 0, kind: 'clear', params: { kind: 'clear', type: 'glitch', count: 2 }, target: 2, reward: 64, progress: 0, pending: false, completing: false });
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    hit(world, 'alice', wild.id);
    wild.wild!.damagedBy.add('carol-d0');
    expect(partyPresent(world, KEY, wild).map((o) => o.id).sort()).toEqual(['alice', 'bob']);
    expect(partyRecipients(world, KEY, wild.wild!.damagedBy, wild)).toEqual(['alice-d0']);
    const c = world.daemons.get('carol-d0')!;
    const before = c.xp;
    wild.hp = 1;
    world.daemons.get('alice-d0')!.cooldowns = {};
    hit(world, 'alice', wild.id);
    expect(world.daemons.has(wild.id)).toBe(false);
    expect(c.xp).toBe(before);
    expect(world.operators.get('carol')!.tickets[0]!.progress).toBe(0);
  });

  it('a capture awards XP to every present member whose daemons damaged the target', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    const a = world.daemons.get('alice-d0')!;
    const b = world.daemons.get('bob-d0')!;
    const xp = [a.xp, b.xp];
    expect(hit(world, 'alice', wild.id)).toMatchObject({ ok: true });
    expect(hit(world, 'bob', wild.id)).toMatchObject({ ok: true });
    const r = capture(world, 'bob', wild.id);
    const start = r.events.map((e) => e.event).find((e): e is Extract<GameEvent, { e: 'captureStart' }> => e.e === 'captureStart')!;
    const done = step(world, input('bob', { cmd: 'submitCapture', actor: self, args: { captureId: start.captureId, answer: solve(start.challenge as PublicChallenge) } }));
    expect(done.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(a.xp).toBeGreaterThan(xp[0]!);
    expect(b.xp).toBeGreaterThan(xp[1]!);
  });

  it('a leaving member keeps the party tag while another member remains; the last one releases it', () => {
    const world = party();
    const wild = placeWild(world, 'bitrot', 20, 7.5, 5.5);
    wild.trait = 'echo';
    hit(world, 'alice', wild.id);
    const carols = placeWild(world, 'bitrot', 20, 5.5, 7.5);
    carols.trait = 'echo';
    hit(world, 'carol', carols.id);
    expect(carols.wild!.tagOwner).toBe('carol');
    world.removeOperator('alice');
    expect(wild.wild!.tagOwner).toBe(KEY);
    expect(wild.wild!.damagedBy.size).toBe(1);
    world.removeOperator('carol');
    expect(carols.wild).toMatchObject({ tagOwner: null, tagUntil: 0 });
    expect(wild.wild!.tagOwner).toBe(KEY);
    world.removeOperator('bob');
    expect(wild.wild).toMatchObject({ tagOwner: null, tagUntil: 0, aggro: null });
    expect(wild.hp).toBe(wild.stats.hp);
  });

  it('self.cluster carries the cluster view (null when solo) and validates on the wire', () => {
    const world = party();
    const alice = toSelf(world, world.operators.get('alice')!);
    expect(alice.cluster).toMatchObject({ id: CLUSTER, code: 'ABC234', leaderId: 'alice', members: [{ id: 'alice' }, { id: 'bob' }] });
    expect(OperatorSelf.parse(alice).cluster).toEqual(alice.cluster);
    expect(toSelf(world, world.operators.get('carol')!).cluster).toBeNull();
  });
});
