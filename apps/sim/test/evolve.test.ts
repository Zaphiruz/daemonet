import { getSpecies, movesAtLevel, statBlock, statBlockToArray, typeIndex } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { toRamDaemon, type Intent } from '../src/core/index.js';
import { Out } from '../src/core/out.js';
import { awardXp } from '../src/core/systems/progress.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, idle, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

/** An operator with an Echolet at 16 in slot 0 (evolves into Tracerat, or Broadcaw while holding a Jumbo Frame). */
function setup(discovered: string[] = []) {
  const world = makeWorld('evo', discovered);
  world.addOperator(operatorRecord('alice', { ram: [ownedRecord('echolet', 16, 0, 'alice-d0')], inventory: { jumboframe: 1, bitflipper: 2, restore: 1 } }));
  return world;
}

/** Runs the evolve command and completes its intent through a MemoryStore the world was seeded into. */
async function evolveThrough(world: ReturnType<typeof setup>, store: MemoryStore, formId: string, daemonId = 'alice-d0') {
  const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId, formId } }));
  expect(r.replies).toEqual([]);
  const intent = r.intents[0] as Extract<Intent, { kind: 'evolve' }>;
  expect(intent.kind).toBe('evolve');
  const result = await store.applyIntent(intent, { seedId: 'seed0001' });
  world.completeIntent(intent.id, result);
  return { intent, result, after: step(world) };
}

async function seededStore(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', { x: 5, y: 5 });
  store.operators.get(rec.id)!.id = 'alice';
  store.operators.set('alice', store.operators.get(rec.id)!);
  store.operators.delete(rec.id);
  for (const d of world.checkpoint('alice').ram) store.daemons.set(d.id, { ...d, operatorId: 'alice', location: 'RAM' });
  return store;
}

describe('evolve command', () => {
  it('lists options on the RAM view with met / requirement, hiding undiscovered requirements', () => {
    const world = setup();
    const d = world.daemons.get('alice-d0')!;
    const ram = toRamDaemon(world, d);
    expect(ram.evolutions).toEqual([
      { form: 'tracerat', name: 'Tracerat', level: 16, hidden: false, revealed: true, met: true, requirement: [] },
      { form: 'broadcaw', name: 'Broadcaw', level: 16, hidden: false, revealed: true, met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] },
    ]);
    d.species = 'broadcaw';
    d.level = 32;
    d.ivs = { ...statBlock(10), speed: 31 };
    const hidden = toRamDaemon(world, d).evolutions.find((o) => o.form === 'anycastrel')!;
    expect(hidden).toMatchObject({ hidden: true, revealed: false, requirement: null, met: true });
    world.discovered.add('anycastrel');
    expect(toRamDaemon(world, d).evolutions.find((o) => o.form === 'anycastrel')!.requirement).toEqual([{ kind: 'dominantIV', stat: 'speed' }]);
  });

  it('rejects running, under-levelled, unmet and unknown forms', () => {
    const world = setup();
    const cmd = (formId: string) => input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId } });
    expect(step(world, cmd('broadcaw')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'requirement not met' });
    expect(step(world, cmd('pidzero')).replies[0]).toMatchObject({ code: 'E_INVALID' });
    world.daemons.get('alice-d0')!.level = 15;
    expect(step(world, cmd('tracerat')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'needs level 16' });
    world.daemons.get('alice-d0')!.level = 16;
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(step(world, cmd('tracerat')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'recall the daemon first' });
  });

  it('evolves through the store: species, stats, moves, HP fraction, history, events, first discovery', async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    d.hp = Math.floor(d.stats.hp / 2);
    const { intent, result, after } = await evolveThrough(world, store, 'tracerat');
    expect(result).toEqual({ ok: true, discovered: true });
    expect(d.species).toBe('tracerat');
    expect(d.types).toEqual(['packet', 'signal']);
    expect(d.pending).toBe(false);
    expect(d.moves).toEqual(['ping', 'traceroute', 'sigstop', 'synflood']);
    expect(d.hp).toBe(intent.hp);
    expect(Math.abs(d.hp / d.stats.hp - 0.5)).toBeLessThan(0.05);
    expect(d.history.at(-1)).toEqual({ at: FIXED_CLOCK, kind: 'evolved', detail: 'echolet -> tracerat at level 16' });
    expect(store.daemons.get('alice-d0')).toMatchObject({ species: 'tracerat', ivs: intent.ivs, history: d.history });
    const events = after.events.map((e) => e.event);
    expect(events).toContainEqual({ e: 'evolved', daemon: 'alice-d0', from: 'echolet', to: 'tracerat', changes: intent.changes });
    expect(events).toContainEqual({ e: 'discovery', form: 'tracerat', operator: 'alice', operatorName: 'alice' });
    expect(after.events.find((e) => e.event.e === 'discovery')).toMatchObject({ to: null, at: null });
    expect(after.replies[0]).toMatchObject({ reqId: intent.reqId, ok: true, result: { species: 'tracerat' } });
    expect(world.discovered.has('tracerat')).toBe(true);
    // the second evolution into the same form is not a discovery
    world.addOperator(operatorRecord('bob', { ram: [ownedRecord('echolet', 16, 0, 'bob-d0')] }));
    store.operators.set('bob', { id: 'bob', sub: 'bob', name: 'bob', starterClaimed: true, bits: 0, diskCapacity: 256, subnet: 'test', x: 5, y: 5, inventory: {} });
    store.daemons.set('bob-d0', { ...world.checkpoint('bob').ram[0]!, operatorId: 'bob', location: 'RAM' });
    const r = step(world, input('bob', { cmd: 'evolve', actor: self, args: { daemonId: 'bob-d0', formId: 'tracerat' } }));
    const intent2 = r.intents[0]!;
    expect(await store.applyIntent(intent2, { seedId: 'seed0001' })).toEqual({ ok: true, discovered: false });
  });

  it('consumes the held evolution item and records clean / signature entries', async () => {
    const world = setup();
    const store = await seededStore(world);
    expect(step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } })).replies[0]).toMatchObject({ ok: true });
    const d = world.daemons.get('alice-d0')!;
    expect(d.heldItem).toBe('jumboframe');
    expect(world.operators.get('alice')!.inventory.jumboframe).toBe(0);
    d.ivs = { ...statBlock(31), hp: 30 };
    store.daemons.get('alice-d0')!.ivs = statBlockToArray(d.ivs);
    // force the IV roll to hit: run until the seeded rng grows hp
    let done = false;
    for (let i = 0; i < 8 && !done; i++) {
      const w = setup();
      const s = await seededStore(w);
      const dd = w.daemons.get('alice-d0')!;
      step(w, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } }));
      dd.ivs = { ...statBlock(31), hp: 30 };
      for (let k = 0; k < i; k++) w.rng.float();
      const { intent } = await evolveThrough(w, s, 'broadcaw');
      expect(intent.heldItem).toBeNull();
      expect(intent.changes).toContainEqual({ kind: 'consumed', item: 'jumboframe' });
      expect(dd.species).toBe('broadcaw');
      if (intent.clean) {
        expect(dd.history.map((h) => h.kind)).toEqual(['evolved', 'clean']);
        done = true;
      }
    }
    expect(done).toBe(true);
  });

  it('fails cleanly when the store rejects and locks the daemon while pending', async () => {
    const world = setup();
    const store = new MemoryStore(); // knows no operator
    const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-d0', formId: 'tracerat' } }));
    const d = world.daemons.get('alice-d0')!;
    expect(d.pending).toBe(true);
    expect(step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    await expect(store.applyIntent(r.intents[0]!, { seedId: 'seed0001' })).rejects.toThrow();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(d.pending).toBe(false);
    expect(d.species).toBe('echolet');
    expect(step(world).replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'persist failed' });
  });
});

describe('held items and the Bit Flipper', () => {
  it('hold swaps the slot with the inventory; unhold returns it; non-holdables are refused', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    op.inventory.amplifier = 1;
    const hold = (itemId: string) => step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId } })).replies[0];
    expect(hold('restore')).toMatchObject({ code: 'E_INVALID' });
    expect(hold('heatsink')).toMatchObject({ code: 'E_STATE' });
    expect(hold('amplifier')).toMatchObject({ ok: true });
    expect(hold('jumboframe')).toMatchObject({ ok: true });
    expect(op.inventory).toMatchObject({ amplifier: 1, jumboframe: 0 });
    expect(world.daemons.get('alice-d0')!.heldItem).toBe('jumboframe');
    expect(step(world, input('alice', { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: true });
    expect(op.inventory.jumboframe).toBe(1);
    expect(step(world, input('alice', { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    expect(world.checkpoint('alice').ram[0]!.heldItem).toBeNull();
  });

  it('bitflipper raises one IV, marks patched and writes history; capped at 31', () => {
    const world = setup();
    const d = world.daemons.get('alice-d0')!;
    const use = (stat: 'attack' | 'hp') => step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'bitflipper', daemonId: 'alice-d0', stat } })).replies[0];
    expect(use('attack')).toMatchObject({ ok: true, result: { patched: true } });
    expect(d.ivs.attack).toBe(21);
    expect(d.patched).toBe(true);
    expect(d.history).toEqual([{ at: FIXED_CLOCK, kind: 'patched', detail: 'attack +1 (bitflipper)' }]);
    d.ivs.hp = 31;
    expect(use('hp')).toMatchObject({ code: 'E_STATE' });
    expect(world.operators.get('alice')!.inventory.bitflipper).toBe(1);
    expect(step(world, input('alice', { cmd: 'useItem', actor: self, args: { item: 'bitflipper', daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ code: 'E_INVALID' });
  });

  it('a patched daemon never becomes clean on evolution', async () => {
    for (let i = 0; i < 4; i++) {
      const world = setup();
      const store = await seededStore(world);
      const d = world.daemons.get('alice-d0')!;
      d.ivs = { ...statBlock(31), hp: 30 };
      d.patched = true;
      for (let k = 0; k < i; k++) world.rng.float();
      const { intent } = await evolveThrough(world, store, 'tracerat');
      expect(intent.clean).toBe(false);
    }
  });
});

describe('evolve guards and completion edge cases', () => {
  const evolveCmd = (formId: string, daemonId = 'alice-d0') => input('alice', { cmd: 'evolve', actor: self, args: { daemonId, formId } });
  const evolveIntent = (r: { intents: Intent[] }) => r.intents[0] as Extract<Intent, { kind: 'evolve' }>;

  it('rejects a daemon that is not in RAM, a pending one, and an unrevealed hidden requirement', () => {
    const world = setup();
    expect(step(world, evolveCmd('tracerat', 'nope')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'no daemon nope in RAM' });
    const d = world.daemons.get('alice-d0')!;
    d.pending = true;
    expect(step(world, evolveCmd('tracerat')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    d.pending = false;
    d.species = 'broadcaw';
    d.level = 32;
    d.ivs = { ...statBlock(10), attack: 31 }; // not speed-dominant
    expect(step(world, evolveCmd('anycastrel')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'requirement unknown' });
    world.discovered.add('anycastrel');
    expect(step(world, evolveCmd('anycastrel')).replies[0]).toMatchObject({ code: 'E_STATE', message: 'requirement not met' });
  });

  it('is idempotent when the operator was reloaded from the store after the intent committed', async () => {
    const world = setup();
    const store = await seededStore(world);
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    const result = await store.applyIntent(intent, { seedId: 'seed0001' });
    world.removeOperator('alice');
    world.addOperator(await store.loadOrCreateOperator('alice', 'test', { x: 5, y: 5 }));
    world.completeIntent(intent.id, result);
    const d = world.daemons.get('alice-d0')!;
    expect(d.species).toBe('tracerat');
    expect(d.history.filter((h) => h.kind === 'evolved')).toHaveLength(1);
    const after = step(world);
    expect(after.replies[0]).toMatchObject({ reqId: intent.reqId, ok: true, result: { species: 'tracerat' } });
    expect(after.events.map((e) => e.event.e)).toEqual(['discovery']);
  });

  it('still records and announces the discovery when the operator left before completion', async () => {
    const world = setup();
    const store = await seededStore(world);
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    const result = await store.applyIntent(intent, { seedId: 'seed0001' });
    world.removeOperator('alice');
    world.completeIntent(intent.id, result);
    expect(world.discovered.has('tracerat')).toBe(true);
    const after = step(world);
    expect(after.replies).toEqual([]);
    expect(after.events.map((e) => e.event)).toEqual([{ e: 'discovery', form: 'tracerat', operator: 'alice', operatorName: null }]);
  });

  it('a replayed result (no discovered flag) still applies the evolution and marks the form discovered, silently', () => {
    const world = setup();
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    world.completeIntent(intent.id, { ok: true });
    expect(world.daemons.get('alice-d0')!.species).toBe('tracerat');
    expect(world.discovered.has('tracerat')).toBe(true);
    expect(step(world).events.map((e) => e.event.e)).toEqual(['evolved']);
  });

  it("the evolved daemon gets the new form's trait and a fresh engagement when it runs", async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    expect(d.trait).toBe(getSpecies('echolet').traits[d.traitSlot]);
    step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } }));
    await evolveThrough(world, store, 'broadcaw');
    expect(d.trait).toBe(getSpecies('broadcaw').traits[d.traitSlot]);
    d.engagement.freeMove = false;
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    expect(d.engagement).toEqual({ freeMove: true, blocked: false, survived: false, lastHitMove: null });
  });
});

describe('item command guards', () => {
  const useItem = (world: ReturnType<typeof setup>, args: { item: 'restore' | 'bitflipper'; stat?: 'attack' | 'hp' }) =>
    step(world, input('alice', { cmd: 'useItem', actor: self, args: { daemonId: 'alice-d0', ...args } })).replies[0];

  it('hold refuses an item the operator has none of; unhold refuses a pending daemon', () => {
    const world = setup();
    const hold = (itemId: string) => step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId } })).replies[0];
    expect(hold('amplifier')).toMatchObject({ code: 'E_STATE', message: 'no amplifier left' });
    expect(hold('jumboframe')).toMatchObject({ ok: true });
    world.daemons.get('alice-d0')!.pending = true;
    expect(step(world, input('alice', { cmd: 'unhold', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    expect(world.daemons.get('alice-d0')!.heldItem).toBe('jumboframe');
  });

  it('restore and bitflipper refuse a pending daemon, an empty inventory and a daemon in combat', () => {
    const world = setup();
    const d = world.daemons.get('alice-d0')!;
    d.pending = true;
    expect(useItem(world, { item: 'restore' })).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    expect(useItem(world, { item: 'bitflipper', stat: 'attack' })).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    expect(world.operators.get('alice')!.inventory).toMatchObject({ restore: 1, bitflipper: 2 });
    d.pending = false;
    d.lastCombatTick = world.tick;
    expect(useItem(world, { item: 'bitflipper', stat: 'attack' })).toMatchObject({ code: 'E_STATE', message: 'daemon is in combat' });
    d.lastCombatTick = -Infinity;
    world.operators.get('alice')!.inventory.bitflipper = 0;
    expect(useItem(world, { item: 'bitflipper', stat: 'attack' })).toMatchObject({ code: 'E_STATE', message: 'no bitflipper left' });
    expect(d.patched).toBe(false);
  });

  it('a bitflipper on the hp IV keeps the missing HP, and a crashed daemon stays at 0', () => {
    // At level 64 every hp IV point is worth exactly 1 max HP.
    const world = makeWorld('evo');
    world.addOperator(operatorRecord('alice', { ram: [ownedRecord('echolet', 64, 0, 'alice-d0')], inventory: { bitflipper: 2 } }));
    const d = world.daemons.get('alice-d0')!;
    d.hp = 10;
    const before = d.stats.hp;
    expect(useItem(world, { item: 'bitflipper', stat: 'hp' })).toMatchObject({ ok: true });
    expect(d.stats.hp).toBe(before + 1);
    expect(d.hp).toBe(11);
    d.hp = 0;
    d.crashed = true;
    expect(useItem(world, { item: 'bitflipper', stat: 'hp' })).toMatchObject({ ok: true });
    expect(d.ivs.hp).toBe(22);
    expect(d.hp).toBe(0);
  });
});

describe('lifetime counters', () => {
  it('counts move uses per type and crashes', () => {
    const world = setup();
    world.addOperator(operatorRecord('bob'));
    step(world, input('bob', { cmd: 'run', actor: self, args: { daemonId: 'bob-d0' } }));
    const wild = world.spawnWild('bitrot', 5, { x: 7.5, y: 5.5 }, -1, { ...world.daemons.get('bob-d0')!, ivs: statBlock(10), clean: false, signature: 0 });
    step(world, input('bob', { cmd: 'use', actor: 'bob-d0', args: { move: 'ping', targetId: wild.id } }));
    const mine = world.daemons.get('bob-d0')!;
    expect(mine.moveTypeUses[typeIndex('packet')]).toBe(1);
    mine.hp = 0;
    step(world);
    expect(mine.crashes).toBe(1);
    expect(world.checkpoint('bob').ram[0]).toMatchObject({ crashes: 1, moveTypeUses: mine.moveTypeUses });
  });
});

describe('final-review fixes', () => {
  const evolveCmd = (formId: string, daemonId = 'alice-d0') => input('alice', { cmd: 'evolve', actor: self, args: { daemonId, formId } });
  const evolveIntent = (r: { intents: Intent[] }) => r.intents[0] as Extract<Intent, { kind: 'evolve' }>;

  it('restoreAll leaves a daemon with a pending evolve alone (no runnable 0 HP daemon)', async () => {
    const world = setup();
    const store = await seededStore(world);
    const op = world.operators.get('alice')!;
    op.x = 4.5;
    op.y = 5.5;
    const d = world.daemons.get('alice-d0')!;
    d.hp = 0;
    d.crashed = true;
    expect(step(world, input('alice', { cmd: 'restoreAll', actor: self, args: {} })).replies[0]).toMatchObject({ ok: true });
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    expect(intent.hp).toBe(0);
    const results = idle(world, 40); // the restore channel finishes before the store confirms
    const restored = results.flatMap((r) => r.events).flatMap((e) => (e.event.e === 'restored' ? e.event.daemons : []));
    expect(restored).toEqual([]);
    expect(d.crashed).toBe(true);
    world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
    step(world);
    expect(d.species).toBe('tracerat');
    expect(d.hp).toBe(0);
    expect(d.crashed).toBe(true);
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
  });

  it('a crashed daemon may evolve and stays at 0 HP, still refused by run', async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    d.hp = 0;
    d.crashed = true;
    store.daemons.get('alice-d0')!.hp = 0;
    store.daemons.get('alice-d0')!.crashed = true;
    const { intent } = await evolveThrough(world, store, 'tracerat');
    expect(intent.hp).toBe(0);
    expect(d.species).toBe('tracerat');
    expect(d.hp).toBe(0);
    expect(d.crashed).toBe(true);
    expect(step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } })).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
  });

  it('a reload while an evolve is pending keeps the daemon locked', async () => {
    const world = setup();
    const store = await seededStore(world);
    Object.assign(store.operators.get('alice')!, { starterClaimed: true, inventory: { jumboframe: 1 } });
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    world.removeOperator('alice');
    world.addOperator(await store.loadOrCreateOperator('alice', 'test', { x: 5, y: 5 }));
    const d = world.daemons.get('alice-d0')!;
    expect(d.pending).toBe(true);
    const hold = step(world, input('alice', { cmd: 'hold', actor: self, args: { daemonId: 'alice-d0', itemId: 'jumboframe' } }));
    expect(hold.replies[0]).toMatchObject({ ok: false, code: 'E_STATE', message: 'daemon is busy' });
    world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
    expect(d.pending).toBe(false);
    expect(d.species).toBe('tracerat');
  });

  it('a reload while a store is pending keeps the daemon locked', async () => {
    const world = setup();
    const store = await seededStore(world);
    const op = world.operators.get('alice')!;
    op.x = 4.5;
    op.y = 5.5;
    step(world, input('alice', { cmd: 'store', actor: self, args: { daemonId: 'alice-d0' } }));
    world.removeOperator('alice');
    world.addOperator(await store.loadOrCreateOperator('alice', 'test', { x: 4.5, y: 5.5 }));
    expect(world.daemons.get('alice-d0')!.pending).toBe(true);
  });

  it('a level-up during a pending evolve recomputes moves and keeps the level-up HP', async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    d.hp = Math.floor(d.stats.hp / 2);
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    awardXp(world, ['alice-d0'], 100_000, new Out());
    expect(d.level).toBeGreaterThan(16);
    const liveFraction = d.hp / d.stats.hp;
    world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
    expect(d.species).toBe('tracerat');
    expect(d.moves).toEqual(movesAtLevel(getSpecies('tracerat'), d.level));
    expect(d.stats.hp).toBeGreaterThan(intent.hp);
    expect(Math.abs(d.hp / d.stats.hp - liveFraction)).toBeLessThan(0.05);
    expect(d.hp).toBeGreaterThan(intent.hp);
  });

  it('a level-up during a pending evolve keeps a crashed daemon at 0 HP', async () => {
    const world = setup();
    const store = await seededStore(world);
    const d = world.daemons.get('alice-d0')!;
    d.hp = 0;
    d.crashed = true;
    const intent = evolveIntent(step(world, evolveCmd('tracerat')));
    awardXp(world, ['alice-d0'], 100_000, new Out());
    world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
    expect(d.hp).toBe(0);
    expect(d.crashed).toBe(true);
  });

  it('run and swap reject a pending daemon with a neutral message', () => {
    const world = setup();
    world.addOperator(operatorRecord('bob'));
    world.daemons.get('bob-d1')!.pending = true;
    expect(step(world, input('bob', { cmd: 'run', actor: self, args: { daemonId: 'bob-d1' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
    step(world, input('bob', { cmd: 'run', actor: self, args: { daemonId: 'bob-d0' } }));
    world.operators.get('bob')!.swapReadyTick = 0;
    expect(step(world, input('bob', { cmd: 'swap', actor: self, args: { outId: 'bob-d0', inId: 'bob-d1' } })).replies[0]).toMatchObject({ code: 'E_STATE', message: 'daemon is busy' });
  });
});
