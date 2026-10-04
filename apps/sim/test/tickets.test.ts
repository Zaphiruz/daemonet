import { MemoryBus } from '@daemonet/bus';
import { TICKETS_PER_DAY, getSubnet, ticketBoard } from '@daemonet/rules';
import { Command, type ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, toSelf, type Intent, type IntentResult, type OpenTicket } from '../src/core/index.js';
import { Out } from '../src/core/out.js';
import { completeCaptureIntent } from '../src/core/systems/capture.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn, type GameOptions } from '../src/runtime/game.js';
import { MemoryStore, type IntentContext, type TicketRow } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

const DAY = '2026-09-30';
const HOST = TEST_SUBNET.host;

/** Alice at the host of the test subnet (no board of its own: tickets are placed on her directly). */
function setup() {
  const world = makeWorld('tix');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y }));
  return world;
}

/** Alice at lo's host, where the real board applies. */
function lo() {
  const subnet = getSubnet('lo');
  const world = new World({ subnet, seed: 'lo', seedId: 'seed0002', spawner: false, clock: () => FIXED_CLOCK });
  world.addOperator(operatorRecord('alice', { x: subnet.host.x, y: subnet.host.y }));
  return world;
}

async function through(world: World, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null as Intent | null, events: [] as unknown[] };
  const intent = r.intents[0]!;
  world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
  const after = step(world);
  return { reply: after.replies[0]!, intent, events: after.events.map((e) => e.event) };
}

async function seeded(world: World) {
  const store = new MemoryStore();
  store.now = () => FIXED_CLOCK;
  const rec = await store.loadOrCreateOperator('alice', world.subnet.id, HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  store.operators.set('alice', { ...mem, id: 'alice' });
  return store;
}

/** Puts an open ticket on the operator (and, when a store is given, its row) as if loaded. */
function give(world: World, store: MemoryStore | null, t: Pick<OpenTicket, 'kind' | 'params' | 'target' | 'reward'> & { subnet?: string; operator?: string }): OpenTicket {
  const op = world.operators.get(t.operator ?? 'alice')!;
  const ticket: OpenTicket = {
    id: `t-${op.id}-${op.tickets.length}`, day: DAY, subnet: t.subnet ?? world.subnet.id, index: op.tickets.length, kind: t.kind, params: t.params, target: t.target, reward: t.reward,
    progress: 0, pending: false, completing: false,
  };
  op.tickets.push(ticket);
  store?.tickets.set(ticket.id, { ...ticket, operatorId: op.id, status: 'OPEN', acceptedAt: FIXED_CLOCK, completedAt: null });
  return ticket;
}

const accept = (args: { day?: string; subnet?: string; index: number }) => ({ cmd: 'acceptTicket', actor: self, args: { day: DAY, subnet: 'lo', ...args } }) as const;

describe('accepting and abandoning', () => {
  it('enforces host, subnet, day, index, the open cap and duplicates, and persists through the store', async () => {
    const world = lo();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    expect(step(world, input('alice', accept({ subnet: 'lan', index: 0 }))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(step(world, input('alice', accept({ day: '2026-09-29', index: 0 }))).replies[0]).toMatchObject({ code: 'E_STATE' });
    expect(step(world, input('alice', accept({ index: 8 }))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    op.x += 5;
    expect(step(world, input('alice', accept({ index: 0 }))).replies[0]).toMatchObject({ code: 'E_RANGE' });
    op.x -= 5;
    const first = await through(world, store, accept({ index: 0 }));
    expect(first.intent).toMatchObject({ kind: 'acceptTicket', day: DAY, subnet: 'lo', index: 0, ticketKind: 'clear', reward: ticketBoard('lo', DAY)[0]!.reward });
    expect(first.reply).toMatchObject({ ok: true, result: { ticketId: expect.any(String) } });
    expect(op.tickets).toHaveLength(1);
    expect(op.tickets[0]).toMatchObject({ pending: false, progress: 0, kind: 'clear' });
    expect(op.ticketsToday).toBe(1);
    expect(step(world, input('alice', accept({ index: 0 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'already accepted' });
    await through(world, store, accept({ index: 1 }));
    expect(step(world, input('alice', accept({ index: 2 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'at most 2 open tickets' });
    // abandon frees a slot but still counts toward the day
    const abandon = await through(world, store, { cmd: 'abandonTicket', actor: self, args: { ticketId: op.tickets[1]!.id } });
    expect(abandon.reply).toMatchObject({ ok: true });
    expect(op.tickets).toHaveLength(1);
    expect(op.ticketsToday).toBe(2);
    expect([...store.tickets.values()].map((t) => t.status)).toEqual(['OPEN', 'ABANDONED']);
    const rec = await store.loadOrCreateOperator('alice', 'lo', HOST);
    expect(rec.tickets.map((t) => t.index)).toEqual([0]);
    expect(rec).toMatchObject({ ticketsToday: 2, ticketsDay: DAY, acceptedToday: [`${DAY}:lo:0`, `${DAY}:lo:1`] });
    // an abandoned ticket cannot be accepted again the same day
    expect(step(world, input('alice', accept({ index: 1 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'already accepted' });
    op.ticketsToday = 8;
    expect(step(world, input('alice', accept({ index: 3 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'at most 8 tickets per day' });
  });

  it('reverts an accept the store refuses, and rolls the daily count over at midnight', async () => {
    const world = lo();
    const op = world.operators.get('alice')!;
    op.ticketsDay = '2026-09-29';
    op.ticketsToday = 8;
    op.acceptedKeys.add('2026-09-29:lo:0');
    const r = step(world, input('alice', { cmd: 'acceptTicket', actor: self, args: { day: DAY, subnet: 'lo', index: 0 } }));
    expect(r.intents).toHaveLength(1);
    expect(op.tickets).toHaveLength(1);
    expect(op.ticketsToday).toBe(1);
    expect([...op.acceptedKeys]).toEqual([`${DAY}:lo:0`]);
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'already accepted' });
    expect(op.tickets).toHaveLength(0);
    expect(op.ticketsToday).toBe(0);
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'already accepted' });
  });

  it('a pending or completing ticket cannot be abandoned, and an unknown one is refused', () => {
    const world = setup();
    const t = give(world, null, { kind: 'evolve', params: { kind: 'evolve' }, target: 1, reward: 256 });
    const abandon = (ticketId: string) => step(world, input('alice', { cmd: 'abandonTicket', actor: self, args: { ticketId } })).replies[0];
    expect(abandon('nope')).toMatchObject({ code: 'E_INVALID' });
    t.completing = true;
    expect(abandon(t.id)).toMatchObject({ code: 'E_STATE', message: 'ticket is busy' });
  });
});

describe('progress and payout', () => {
  it('clear tickets count wild defeats of the type in this subnet and pay out through the store', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const t = give(world, store, { kind: 'clear', params: { kind: 'clear', type: 'null', count: 2 }, target: 2, reward: 64 });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const kill = (species: string) => {
      const w = placeWild(world, species, 3, op.x + 1.5, op.y);
      w.trait = 'echo'; // no Bitshield: the one-HP wild goes down to the first ping
      w.hp = 1;
      world.daemons.get('alice-d0')!.cooldowns = {};
      return step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: w.id } }));
    };
    expect(kill('bitrot').events.map((e) => e.event.e)).not.toContain('ticketProgress'); // glitch type: no progress
    expect(kill('nullpup').events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: t.id, progress: 1, target: 2 });
    expect(world.checkpoint('alice').tickets[0]).toMatchObject({ id: t.id, progress: 1 });
    const r = kill('nullpup');
    expect(t.completing).toBe(true);
    const complete = r.intents.find((i) => i.kind === 'completeTicket')!;
    expect(complete).toMatchObject({ ticketId: t.id, reward: 64 });
    world.completeIntent(complete.id, await store.applyIntent(complete, { seedId: 'seed0001' }));
    const after = step(world).events.map((e) => e.event);
    expect(after).toContainEqual({ e: 'ticketDone', ticketId: t.id, reward: 64 });
    expect(after).toContainEqual({ e: 'bits', delta: 64, reason: 'ticket', balance: 64 });
    expect(op.bits).toBe(64);
    expect(op.tickets).toEqual([]);
    expect(store.tickets.get(t.id)).toMatchObject({ status: 'DONE', progress: 2 });
    expect(store.ledger).toMatchObject([{ delta: 64, reason: 'ticket', ref: t.id }]);
  });

  it('capture tickets need the line at the minimum level in this subnet; research grows with every capture', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    give(world, null, { kind: 'capture', params: { kind: 'capture', line: 5, minLevel: 6 }, target: 1, reward: 128 });
    const captured = (species: string, level: number, id: string, slot = 2): Extract<Intent, { kind: 'capture' }> => ({
      id: `i-${id}`, kind: 'capture', operatorId: 'alice', captureId: `c-${id}`, location: 'RAM', tool: 'sniff',
      daemon: ownedRecord(species, level, slot, id), log: { originalOperatorId: 'alice', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 },
    });
    const out = new Out();
    completeCaptureIntent(world, op, captured('pingling', 5, 'w1'), { ok: true }, out); // line 5 but under level: research only
    expect(op.research).toEqual({ '5': 1 });
    expect(out.events.map((e) => e.event.e)).not.toContain('ticketProgress');
    completeCaptureIntent(world, op, captured('pingling', 6, 'w2', 3), { ok: true }, out);
    expect(op.research).toEqual({ '5': 2 });
    expect(out.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: 't-alice-0', progress: 1, target: 1 });
    expect(out.intents.at(-1)).toMatchObject({ kind: 'completeTicket', ticketId: 't-alice-0', reward: 128 });
  });

  it('deliver tickets complete at the destination host only; a refused completion closes the ticket unpaid', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    // accepted in testb for delivery to test: completes here
    const t = give(world, null, { kind: 'deliver', params: { kind: 'deliver', to: 'test' }, target: 1, reward: 128, subnet: 'testb' });
    // accepted here for delivery to testb: standing at this host does nothing (no completion without travelling)
    const away = give(world, null, { kind: 'deliver', params: { kind: 'deliver', to: 'testb' }, target: 1, reward: 128 });
    const r = step(world);
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: t.id, progress: 1, target: 1 });
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ kind: 'completeTicket', ticketId: t.id, reward: 128 });
    expect(away.progress).toBe(0);
    // the store answers definitively that the row is no longer open (already paid elsewhere): never paid again, never retried
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'no open ticket' });
    expect(step(world).events.map((e) => e.event)).toContainEqual({ e: 'ticketDone', ticketId: t.id, reward: 0, unpaid: true });
    expect(op.tickets.map((x) => x.id)).toEqual([away.id]);
    expect(op.bits).toBe(0);
    expect(step(world).intents).toEqual([]);
    expect(away.progress).toBe(0);
  });

  it('deliver needs the destination host itself, not just the destination subnet', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const t = give(world, null, { kind: 'deliver', params: { kind: 'deliver', to: 'test' }, target: 1, reward: 128, subnet: 'testb' });
    op.x = HOST.x + 6;
    expect(step(world).intents).toEqual([]);
    expect(t.progress).toBe(0);
  });

  it('evolve tickets complete on any evolution', async () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    op.ram = [];
    for (const id of [...world.daemons.keys()]) world.removeDaemon(id);
    world.addOwned(op, ownedRecord('echolet', 16, 0, 'alice-e0'));
    give(world, null, { kind: 'evolve', params: { kind: 'evolve' }, target: 1, reward: 256 });
    const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-e0', formId: 'tracerat' } }));
    world.completeIntent(r.intents[0]!.id, { ok: true, discovered: false });
    const after = step(world);
    expect(after.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: 't-alice-0', progress: 1, target: 1 });
    expect(after.intents[0]).toMatchObject({ kind: 'completeTicket', reward: 256 });
  });
});

describe('ticket exploits', () => {
  it("another operator's defeats and captures never count toward my tickets", () => {
    const world = setup();
    world.addOperator(operatorRecord('bob', { x: HOST.x, y: HOST.y + 1 }));
    const bob = world.operators.get('bob')!;
    const mine = give(world, null, { kind: 'clear', params: { kind: 'clear', type: 'null', count: 2 }, target: 2, reward: 64 });
    const cap = give(world, null, { kind: 'capture', params: { kind: 'capture', line: 32, minLevel: 1 }, target: 1, reward: 128 });
    step(world, input('bob', { cmd: 'run', actor: self, args: { daemonId: 'bob-d0' } }));
    const w = placeWild(world, 'nullpup', 3, bob.x + 1.5, bob.y);
    w.trait = 'echo';
    w.hp = 1;
    const r = step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: w.id } }));
    expect(world.daemons.has(w.id)).toBe(false);
    expect(r.events.map((e) => e.event.e)).not.toContain('ticketProgress');
    const out = new Out();
    completeCaptureIntent(
      world,
      bob,
      {
        id: 'i-bobcap', kind: 'capture', operatorId: 'bob', captureId: 'c-bob', location: 'RAM', tool: 'sniff', daemon: ownedRecord('nullpup', 5, 2, 'bob-cap'),
        log: { originalOperatorId: 'bob', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 },
      },
      { ok: true },
      out,
    );
    expect(out.events.map((e) => e.event.e)).not.toContain('ticketProgress');
    expect(mine.progress).toBe(0);
    expect(cap.progress).toBe(0);
    expect(world.operators.get('alice')!.research).toEqual({});
    expect(bob.research).toEqual({ '32': 1 });
  });

  it('a capture of the line in another subnet does not count toward a capture ticket from here', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const t = give(world, null, { kind: 'capture', params: { kind: 'capture', line: 5, minLevel: 1 }, target: 1, reward: 128, subnet: 'testb' });
    const out = new Out();
    completeCaptureIntent(
      world,
      op,
      { id: 'i-x', kind: 'capture', operatorId: 'alice', captureId: 'c-x', location: 'DISK', tool: 'sniff', daemon: ownedRecord('pingling', 9, 0, 'x'), log: { originalOperatorId: 'alice', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 } },
      { ok: true },
      out,
    );
    expect(t.progress).toBe(0);
    expect(op.research).toEqual({ '5': 1 });
  });

  it('research is not counted twice for one capture: a replay onto a reloaded operator, or the store-reported total', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const intent: Extract<Intent, { kind: 'capture' }> = {
      id: 'i-r', kind: 'capture', operatorId: 'alice', captureId: 'c-r', location: 'RAM', tool: 'sniff', daemon: ownedRecord('pingling', 5, 2, 'cap-r'),
      log: { originalOperatorId: 'alice', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 },
    };
    // reloaded from the store after the capture committed: the daemon and its research point are already loaded
    world.addOwned(op, intent.daemon);
    op.research['5'] = 3;
    completeCaptureIntent(world, op, intent, { ok: true }, new Out());
    expect(op.research['5']).toBe(3);
    // the store reports the line's committed total: it is taken as is (and never lowers what the world shows)
    completeCaptureIntent(world, op, { ...intent, id: 'i-r2', captureId: 'c-r2', daemon: ownedRecord('pingling', 5, 3, 'cap-r2') }, { ok: true, research: 4 }, new Out());
    expect(op.research['5']).toBe(4);
    completeCaptureIntent(world, op, { ...intent, id: 'i-r3', captureId: 'c-r3', daemon: { ...ownedRecord('pingling', 5, 4, 'cap-r3') } }, { ok: true, research: 4 }, new Out());
    expect(op.research['5']).toBe(4);
  });

  it('a completed ticket is gone from the world and the store: a duplicate completion or a store replay pays nothing more', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const t = give(world, store, { kind: 'evolve', params: { kind: 'evolve' }, target: 1, reward: 256 });
    t.progress = 1;
    const r = step(world);
    const intent = r.intents[0]!;
    expect(intent).toMatchObject({ kind: 'completeTicket', ticketId: t.id });
    const first = await store.applyIntent(intent, { seedId: 'seed0001' });
    // the same intent replayed (lost acknowledgement): answered from the marker, no second ledger row
    expect(await store.applyIntent(intent, { seedId: 'seed0001' })).toEqual({ ok: true });
    // a different completion intent for the same ticket (e.g. raised again after a reload): refused
    expect(await store.applyIntent({ ...intent, id: 'i-other' } as Intent, { seedId: 'seed0001' })).toEqual({ ok: false, reason: 'no open ticket' });
    world.completeIntent(intent.id, first);
    expect(() => world.completeIntent(intent.id, first)).toThrow(RangeError);
    expect(op.bits).toBe(256);
    expect(store.operators.get('alice')!.bits).toBe(256);
    expect(store.ledger).toHaveLength(1);
    // nothing left to complete
    expect(step(world).intents).toEqual([]);
  });

  it('the store refuses accepts past the open cap, past the daily cap, duplicates, and boards that do not match the rules', async () => {
    const world = lo();
    const store = await seeded(world);
    const board = ticketBoard('lo', DAY);
    const forge = (index: number, over: Partial<Extract<Intent, { kind: 'acceptTicket' }>> = {}): Intent => {
      const def = board[index]!;
      return { id: `i-acc-${index}-${Math.random()}`, kind: 'acceptTicket', operatorId: 'alice', reqId: 'r', ticketId: `t-forged-${index}-${Math.random()}`, day: DAY, subnet: 'lo', index, ticketKind: def.kind, params: def.params, target: def.target, reward: def.reward, ...over };
    };
    const apply = (i: Intent) => store.applyIntent(i, { seedId: 'seed0001' });
    expect(await apply(forge(0, { reward: 4096 }))).toEqual({ ok: false, reason: 'ticket does not match the board' });
    expect(await apply(forge(0, { target: 0 }))).toEqual({ ok: false, reason: 'ticket does not match the board' });
    expect(await apply(forge(0, { index: 9 }))).toEqual({ ok: false, reason: 'ticket does not match the board' });
    expect(await apply(forge(0, { day: '2026-09-20' }))).toEqual({ ok: false, reason: 'the board for 2026-09-20 is gone' });
    expect(await apply(forge(0))).toEqual({ ok: true });
    expect(await apply(forge(0))).toEqual({ ok: false, reason: 'already accepted' });
    expect(await apply(forge(1))).toEqual({ ok: true });
    expect(await apply(forge(2))).toEqual({ ok: false, reason: 'at most 2 open tickets' });
    // close the open ones and keep accepting: the day stops at TICKETS_PER_DAY
    for (let i = 2; i <= TICKETS_PER_DAY; i++) {
      for (const row of store.tickets.values()) row.status = 'DONE';
      const res = await apply(forge(i % 8));
      if (i < 8) expect(res).toEqual({ ok: true });
      else expect(res).toEqual({ ok: false, reason: 'already accepted' });
    }
    // all 8 indices of the day are used; a ninth (forged) row on another subnet's board is past the daily cap
    const lan = ticketBoard('lan', DAY)[0]!;
    for (const row of store.tickets.values()) row.status = 'DONE';
    expect(await apply(forge(0, { subnet: 'lan', ticketKind: lan.kind, params: lan.params, target: lan.target, reward: lan.reward }))).toEqual({ ok: false, reason: 'at most 8 tickets per day' });
    // the next UTC day starts a fresh count
    store.now = () => '2026-10-01T00:00:05.000Z';
    const next = ticketBoard('lo', '2026-10-01')[0]!;
    expect(await apply(forge(0, { day: '2026-10-01', ticketKind: next.kind, params: next.params, target: next.target, reward: next.reward }))).toEqual({ ok: true });
    const rec = await store.loadOrCreateOperator('alice', 'lo', HOST);
    expect(rec).toMatchObject({ ticketsToday: 1, ticketsDay: '2026-10-01' });
  });

  it('a reload carries the daily count and keys, so a reconnect cannot accept the same or more tickets', async () => {
    const world = lo();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    await through(world, store, accept({ index: 0 }));
    await through(world, store, { cmd: 'abandonTicket', actor: self, args: { ticketId: op.tickets[0]!.id } });
    // reconnect: a fresh world operator from the store
    world.removeOperator('alice');
    const rec = await store.loadOrCreateOperator('alice', 'lo', HOST);
    world.addOperator({ ...rec, starterClaimed: true, x: getSubnet('lo').host.x, y: getSubnet('lo').host.y });
    expect(world.operators.get('alice')!).toMatchObject({ ticketsToday: 1, ticketsDay: DAY, tickets: [] });
    expect(step(world, input('alice', accept({ index: 0 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'already accepted' });
    world.operators.get('alice')!.ticketsToday = TICKETS_PER_DAY;
    expect(step(world, input('alice', accept({ index: 1 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'at most 8 tickets per day' });
  });

  it('a travelling operator raises no completion; the destination world completes it exactly once', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    const t = give(world, null, { kind: 'evolve', params: { kind: 'evolve' }, target: 1, reward: 256 });
    t.progress = 1;
    op.travelling = true;
    expect(step(world).intents).toEqual([]);
    // the hand-off: the destination world starts from the source's checkpoint
    const rec = world.checkpoint('alice');
    expect(rec.tickets).toEqual([{ ...t }]);
    world.removeOperator('alice');
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'seedbbbb', spawner: false, clock: () => FIXED_CLOCK });
    b.addOperator({ ...rec, subnet: 'testb' });
    const r = step(b);
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ kind: 'completeTicket', ticketId: t.id });
    expect(step(b).intents).toEqual([]);
  });

  it('a ticket waiting for its accept is neither advanced, checkpointed nor shown', () => {
    const world = lo();
    const op = world.operators.get('alice')!;
    step(world, input('alice', accept({ index: 0 })));
    expect(op.tickets[0]!.pending).toBe(true);
    expect(world.checkpoint('alice').tickets).toEqual([]);
    expect(toSelf(world, op).tickets).toEqual([]);
    expect(toSelf(world, op).ticketsToday).toBe(1);
    expect(toSelf(world, op).ticketsDay).toBe(op.ticketsDay);
    expect(op.ticketsDay).toBe(DAY);
  });
});

describe('scans', () => {
  it('reveal nature, IV buckets and IVs as research on the line grows, for the viewer only', () => {
    const world = setup();
    const alice = world.operators.get('alice')!;
    world.addOperator(operatorRecord('bob'));
    const wild = placeWild(world, 'pingling', 5, 8.5, 5.5);
    const seen = (viewer = alice) => entitiesNear(world, 8.5, 5.5, 4, viewer).find((e) => e.id === wild.id) as { scan?: unknown };
    expect(seen().scan).toBeUndefined();
    alice.research['5'] = 3;
    expect(seen().scan).toBeUndefined();
    alice.research['5'] = 4;
    expect(seen().scan).toEqual({ nature: wild.nature });
    alice.research['5'] = 16;
    expect(seen().scan).toEqual({ nature: wild.nature, ivBuckets: [1, 1, 1, 1, 1, 1, 1, 1] });
    alice.research['5'] = 64;
    expect(seen().scan).toMatchObject({ ivs: [10, 10, 10, 10, 10, 10, 10, 10] });
    expect(seen(world.operators.get('bob')!).scan).toBeUndefined();
    expect((entitiesNear(world, 8.5, 5.5, 4).find((e) => e.id === wild.id) as { scan?: unknown }).scan).toBeUndefined();
    // owned daemons are never scanned
    world.activate(world.daemons.get('alice-d0')!, alice);
    const own = entitiesNear(world, alice.x, alice.y, 4, alice).find((e) => e.id === 'alice-d0') as { scan?: unknown };
    expect(own.scan).toBeUndefined();
  });
});

// ---- the runtime ----

class FakeConn implements Conn {
  static n = 0;
  readonly id = `tix-conn-${++FakeConn.n}`;
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

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** MemoryStore that can hold ticket intents. */
class GatedStore extends MemoryStore {
  private held: ReturnType<typeof gate> | null = null;
  hold() {
    this.held = gate();
  }
  release() {
    this.held?.open();
    this.held = null;
  }
  override async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (intent.kind.endsWith('Ticket') && this.held) await this.held.promise;
    return super.applyIntent(intent, ctx);
  }
}

function game(store: MemoryStore, extra: Partial<GameOptions> = {}) {
  store.now = () => FIXED_CLOCK;
  const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false, clock: () => FIXED_CLOCK });
  const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false, clock: () => FIXED_CLOCK });
  const g = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4, ...extra });
  return { a, b, game: g };
}

async function join(g: Game, name: string, role: 'controller' | 'spectator' = 'controller') {
  const conn = new FakeConn();
  g.connect(conn);
  await g.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, role } }));
  return conn;
}

let req = 0;
const cmd = (c: Command) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `t${++req}`, ...c } });

/** An operator in the store with a claimed starter, at `at` (default: next to the host). */
async function player(store: MemoryStore, name: string, at = TEST_SUBNET.spawn) {
  const rec = await store.loadOrCreateOperator(`dev-${name}`, 'test', at);
  Object.assign(store.operators.get(rec.id)!, { name, starterClaimed: true, x: at.x, y: at.y });
  store.daemons.set(`${name}-d0`, { ...ownedRecord('tracerat', 20, 0, `${name}-d0`), operatorId: rec.id, location: 'RAM' });
  return rec.id;
}

function row(operatorId: string, id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    id, operatorId, day: DAY, subnet: 'testb', index: 0, kind: 'deliver', params: { kind: 'deliver', to: 'test' }, target: 1, reward: 128, progress: 0, status: 'OPEN',
    acceptedAt: FIXED_CLOCK, completedAt: null, ...over,
  };
}

const tick = (g: Game, n = 1) => {
  for (let i = 0; i < n; i++) g.tick();
};
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('tickets in the runtime', () => {
  it('a payout whose acknowledgement is lost is retried with the same intent and paid exactly once', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let lost = 0;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'completeTicket' && lost < 5) {
        lost++;
        throw new Error('connection reset after commit');
      }
      return result;
    };
    const { a, game: g } = game(store);
    const id = await player(store, 'ann');
    store.tickets.set('tk-1', row(id, 'tk-1'));
    const conn = await join(g, 'ann');
    for (let i = 0; i < 10; i++) {
      tick(g);
      await settle();
    }
    await g.flush();
    tick(g);
    expect(lost).toBe(5);
    expect(a.operators.get(id)!.bits).toBe(128);
    expect(store.operators.get(id)!.bits).toBe(128);
    expect(store.ledger.filter((l) => l.operatorId === id)).toEqual([expect.objectContaining({ delta: 128, reason: 'ticket', ref: 'tk-1' })]);
    expect(store.tickets.get('tk-1')!.status).toBe('DONE');
    const events = conn.of('delta').flatMap((m) => m.d.events);
    expect(events.filter((e) => e.e === 'ticketDone')).toEqual([{ e: 'ticketDone', ticketId: 'tk-1', reward: 128 }]);
    expect(events).toContainEqual({ e: 'bits', delta: 128, reason: 'ticket', balance: 128 });
    await g.shutdown();
  });

  it('a refused payout is logged at warn and the operator is told the ticket closed unpaid', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    store.applyIntent = async (intent, ctx) => (intent.kind === 'completeTicket' ? { ok: false, reason: 'no open ticket' } : apply(intent, ctx));
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { info() {}, error() {}, warn: (obj: Record<string, unknown>, msg: string) => void warnings.push({ obj, msg }) };
    const { a, game: g } = game(store, { log });
    const id = await player(store, 'rex');
    store.tickets.set('tk-r', row(id, 'tk-r'));
    const conn = await join(g, 'rex');
    for (let i = 0; i < 4; i++) {
      tick(g);
      await settle();
    }
    await g.flush();
    tick(g);
    const refusal = warnings.find((w) => w.obj.reason === 'no open ticket');
    expect(refusal).toBeDefined();
    expect(refusal!.obj).toMatchObject({ operator: id, ticket: `${DAY}:testb:0`, reason: 'no open ticket' });
    expect(refusal!.obj.intent).toEqual(expect.any(String));
    const events = conn.of('delta').flatMap((m) => m.d.events);
    expect(events).toContainEqual({ e: 'ticketDone', ticketId: 'tk-r', reward: 0, unpaid: true });
    expect(a.operators.get(id)!.bits).toBe(0);
    expect(a.operators.get(id)!.tickets).toEqual([]);
    await g.shutdown();
  });

  it('a leave waits for a pending payout; a reconnect meanwhile resumes the session and cannot complete it again', async () => {
    const store = new GatedStore();
    const { a, game: g } = game(store);
    const id = await player(store, 'bea');
    store.tickets.set('tk-2', row(id, 'tk-2'));
    store.hold();
    const conn = await join(g, 'bea');
    tick(g);
    expect(a.economyInFlight(id)).toBe(true);
    expect(a.inventoryInFlight(id)).toBe(false); // a payout never holds the inventory back from checkpoints
    g.disconnect(conn);
    const again = await join(g, 'bea');
    tick(g, 3);
    g.disconnect(again);
    tick(g, 8);
    expect(g.worldOf(id)).toBe(a); // the leave is due but waits
    store.release();
    await g.flush();
    tick(g);
    await g.flush();
    expect(g.worldOf(id)).toBeUndefined();
    expect(store.ledger.filter((l) => l.operatorId === id)).toHaveLength(1);
    expect(store.operators.get(id)!.bits).toBe(128);
    const third = await join(g, 'bea');
    expect(third.of('snapshot')[0]!.d.self).toMatchObject({ bits: 128, tickets: [] });
    tick(g, 3);
    await g.flush();
    expect(store.ledger.filter((l) => l.operatorId === id)).toHaveLength(1);
    await g.shutdown();
  });

  it('deliver: accepted in one world, completed after travelling to the destination host, paid once', async () => {
    const store = new MemoryStore();
    const { b, game: g } = game(store);
    const gw = TEST_SUBNET.gateways[0]!;
    const id = await player(store, 'cal', gw.at);
    store.tickets.set('tk-3', row(id, 'tk-3', { subnet: 'test', params: { kind: 'deliver', to: 'testb' } }));
    const conn = await join(g, 'cal');
    tick(g, 3);
    await g.flush();
    expect(store.tickets.get('tk-3')!.status).toBe('OPEN'); // not at the destination yet
    await g.message(conn, cmd({ cmd: 'travel', actor: self, args: { gatewayId: gw.id } }));
    tick(g);
    await g.flush();
    expect(g.worldOf(id)).toBe(b);
    // arrives next to testb's host: the destination world completes it
    for (let i = 0; i < 3; i++) {
      tick(g);
      await g.flush();
    }
    expect(store.tickets.get('tk-3')!.status).toBe('DONE');
    expect(store.ledger.filter((l) => l.operatorId === id)).toHaveLength(1);
    expect(b.operators.get(id)!.bits).toBe(128);
    await g.shutdown();
  });

  it('accept and abandon go through the store and survive a reconnect (the store is the truth for the day)', async () => {
    const store = new MemoryStore();
    store.now = () => FIXED_CLOCK;
    const subnet = getSubnet('lo');
    const world = new World({ subnet, seed: 'lo', seedId: 'cccc0003', spawner: false, clock: () => FIXED_CLOCK });
    const g = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus(), retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4 });
    const id = await player(store, 'dot', subnet.host);
    store.operators.get(id)!.subnet = 'lo';
    const conn = await join(g, 'dot');
    const send = async (c: FakeConn, command: Command) => {
      await g.message(c, cmd(command));
      tick(g);
      await g.flush();
      tick(g);
    };
    await send(conn, accept({ index: 0 }));
    await send(conn, accept({ index: 1 }));
    expect(conn.of('ack')).toHaveLength(2);
    const op = world.operators.get(id)!;
    await send(conn, { cmd: 'abandonTicket', actor: self, args: { ticketId: op.tickets[0]!.id } });
    expect(store.tickets.size).toBe(2);
    expect([...store.tickets.values()].map((t) => t.status).sort()).toEqual(['ABANDONED', 'OPEN']);
    // leave and come back: the record carries one open ticket and two accepted today
    g.disconnect(conn);
    tick(g, 6);
    await g.flush();
    expect(g.worldOf(id)).toBeUndefined();
    const again = await join(g, 'dot');
    expect(again.of('snapshot')[0]!.d.self).toMatchObject({ ticketsToday: 2, tickets: [{ index: 1, day: DAY, subnet: 'lo', title: ticketBoard('lo', DAY)[1]!.title }] });
    await send(again, accept({ index: 0 }));
    expect(again.of('err').at(-1)!.d).toMatchObject({ code: 'E_STATE', message: 'already accepted' });
    await g.shutdown();
  });

  it('scans reach only the operator whose research unlocks them (controller and its spectators), never another operator', async () => {
    const store = new MemoryStore();
    const { a, game: g } = game(store);
    const id = await player(store, 'eve');
    await player(store, 'fay');
    store.research.set(`${id}:5`, 64);
    const wild = placeWild(a, 'pingling', 5, 8.5, 5.5);
    const eve = await join(g, 'eve');
    const eveWatch = await join(g, 'eve', 'spectator');
    const fay = await join(g, 'fay');
    const scanIn = (c: FakeConn) => {
      const snap = c.of('snapshot')[0]!.d.entities.find((e) => e.id === wild.id) as { scan?: unknown } | undefined;
      return snap?.scan;
    };
    expect(scanIn(eve)).toEqual({ nature: 0, ivBuckets: [1, 1, 1, 1, 1, 1, 1, 1], ivs: [10, 10, 10, 10, 10, 10, 10, 10] });
    expect(scanIn(eveWatch)).toEqual(scanIn(eve));
    expect(scanIn(fay)).toBeUndefined();
    expect(fay.of('snapshot')[0]!.d.self.research).toEqual({});
    expect(eve.of('snapshot')[0]!.d.self.research).toEqual({ '5': 64 });
    // later deltas: a new wild appears; only eve's connections carry its scan
    const next = placeWild(a, 'echolet', 9, 9.5, 5.5);
    tick(g);
    const upsert = (c: FakeConn) => c.of('delta').flatMap((m) => m.d.upserts).find((e) => e.id === next.id) as { scan?: unknown } | undefined;
    expect(upsert(eve)?.scan).toMatchObject({ ivs: expect.any(Array) });
    expect(upsert(eveWatch)?.scan).toMatchObject({ ivs: expect.any(Array) });
    expect(upsert(fay)).toBeDefined();
    expect(upsert(fay)!.scan).toBeUndefined();
    expect(JSON.stringify(fay.sent)).not.toContain('"scan"');
    await g.shutdown();
  });

  it('a capture adds a research point in the store and the world once, even when its acknowledgement is lost', async () => {
    const store = new MemoryStore();
    const apply = store.applyIntent.bind(store);
    let lost = 0;
    store.applyIntent = async (intent, ctx) => {
      const result = await apply(intent, ctx);
      if (intent.kind === 'capture' && lost++ < 2) throw new Error('connection reset after commit');
      return result;
    };
    const intent: Intent = {
      id: 'i-cap-research', kind: 'capture', operatorId: 'op-x', captureId: 'c', location: 'DISK', tool: 'sniff', daemon: ownedRecord('pingling', 5, 0, 'cap-x'),
      log: { originalOperatorId: 'op-x', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 },
    };
    store.operators.set('op-x', { id: 'op-x', sub: 'x', name: 'x', starterClaimed: true, bits: 0, diskCapacity: 256, subnet: 'test', x: 1, y: 1, inventory: {} });
    await expect(store.applyIntent(intent, { seedId: 's' })).rejects.toThrow();
    await expect(store.applyIntent(intent, { seedId: 's' })).rejects.toThrow();
    expect(await store.applyIntent(intent, { seedId: 's' })).toEqual({ ok: true, research: 1 });
    expect(store.research.get('op-x:5')).toBe(1);
  });
});
