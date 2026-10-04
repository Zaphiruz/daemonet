import {
  DISK_SLOTS,
  GATEWAY_RADIUS,
  MAX_IV,
  RUNNING_MAX,
  STARTING_INVENTORY,
  SWAP_COOLDOWN_MS,
  computeStats,
  emptyMoveTypeUses,
  getSpecies,
  isHoldable,
  movesAtLevel,
  rollSpawn,
  statBlockToArray,
  xpForLevel,
} from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { distance, type Point } from '../grid.js';
import { Rejection, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { startCapture, submitCapture } from './capture.js';
import { evolve } from './evolve.js';
import { restoreDaemon } from './upkeep.js';

export const LEASH_TILES = 8;
export const HOST_RADIUS = 2;
export const OUT_OF_COMBAT_MS = 4096;
export const RESTORE_CHANNEL_MS = 2048;
export const STARTER_LEVEL = 5;

type Cmd<N extends Command['cmd']> = Extract<Command, { cmd: N }>;

export function handleCommands(world: World, inputs: readonly Input[], out: Out): void {
  for (const input of inputs) {
    try {
      handle(world, input, out);
    } catch (err) {
      if (err instanceof Rejection) out.fail(input, err.code, err.message);
      else throw err;
    }
  }
}

function ownedDaemon(world: World, op: Operator, id: string): Daemon {
  const d = world.daemons.get(id);
  if (!d || d.ownerId !== op.id) throw new Rejection('E_STATE', `no daemon ${id} in RAM`);
  return d;
}

function runningDaemon(world: World, op: Operator, id: string): Daemon {
  const d = ownedDaemon(world, op, id);
  if (!d.active) throw new Rejection('E_STATE', `daemon ${id} is not running`);
  return d;
}

function requireAtHost(world: World, op: Operator): void {
  if (distance(op, world.subnet.host) > HOST_RADIUS) throw new Rejection('E_RANGE', 'must be at the host node');
}

function requireSwapReady(world: World, op: Operator): void {
  if (world.tick < op.swapReadyTick) throw new Rejection('E_COOLDOWN', 'swap is cooling down');
}

function pathTo(world: World, from: Point, to: Point): Point[] {
  const path = world.grid.findPath(from, to);
  if (!path) throw new Rejection('E_STATE', 'destination unreachable');
  return path;
}

function handle(world: World, input: Input, out: Out): void {
  const op = world.operators.get(input.operatorId);
  if (!op) throw new Rejection('E_STATE', 'operator is not in the world');
  const c = input.command;
  if (!op.starterClaimed && !['claimStarter', 'moveTo', 'stop'].includes(c.cmd)) {
    throw new Rejection('E_STATE', 'claim a starter first');
  }
  if (op.travelling) throw new Rejection('E_STATE', 'travelling');
  switch (c.cmd) {
    case 'moveTo':
      return moveTo(world, op, c, input, out);
    case 'stop':
      if (c.actor === 'self') op.path = [];
      else runningDaemon(world, op, c.actor).path = [];
      return out.ok(input);
    case 'run': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.active) throw new Rejection('E_STATE', 'already running');
      if (d.crashed) throw new Rejection('E_STATE', 'daemon has crashed; restore it first');
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (op.running.length >= RUNNING_MAX) throw new Rejection('E_STATE', `at most ${RUNNING_MAX} daemons can run`);
      requireSwapReady(world, op);
      world.activate(d, op);
      op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
      return out.ok(input);
    }
    case 'recall': {
      const d = runningDaemon(world, op, c.args.daemonId);
      requireSwapReady(world, op);
      world.deactivate(d);
      op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
      return out.ok(input);
    }
    case 'swap':
      return swap(world, op, c, input, out);
    case 'capture':
      return out.ok(input, { captureId: startCapture(world, op, c.args, out) });
    case 'submitCapture':
      return out.ok(input, { status: submitCapture(world, op, c.args, out) });
    case 'useItem': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if ((op.inventory[c.args.item] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${c.args.item} left`);
      // A pending store / evolve snapshots the daemon: a change made now would be lost when it completes.
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (world.tick - d.lastCombatTick < world.ticks(OUT_OF_COMBAT_MS)) throw new Rejection('E_STATE', 'daemon is in combat');
      if (c.args.item === 'bitflipper') return bitFlip(world, op, d, c.args.stat, input, out);
      op.inventory.restore = (op.inventory.restore ?? 0) - 1;
      restoreDaemon(d);
      out.emit({ e: 'restored', daemons: [d.id] }, { to: op.id });
      return out.ok(input);
    }
    case 'hold': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (!isHoldable(c.args.itemId)) throw new Rejection('E_INVALID', `${c.args.itemId} cannot be held`);
      if ((op.inventory[c.args.itemId] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${c.args.itemId} left`);
      if (d.heldItem) op.inventory[d.heldItem] = (op.inventory[d.heldItem] ?? 0) + 1;
      op.inventory[c.args.itemId] = (op.inventory[c.args.itemId] ?? 0) - 1;
      d.heldItem = c.args.itemId;
      return out.ok(input);
    }
    case 'unhold': {
      const d = ownedDaemon(world, op, c.args.daemonId);
      if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
      if (!d.heldItem) throw new Rejection('E_STATE', 'nothing held');
      op.inventory[d.heldItem] = (op.inventory[d.heldItem] ?? 0) + 1;
      d.heldItem = null;
      return out.ok(input);
    }
    case 'evolve':
      return evolve(world, op, ownedDaemon(world, op, c.args.daemonId), c.args.formId, input, out);
    case 'travel':
      return travel(world, op, c, input, out);
    case 'restoreAll':
      requireAtHost(world, op);
      op.path = [];
      op.restoreUntil = world.tick + world.ticks(RESTORE_CHANNEL_MS);
      return out.ok(input, { untilTick: op.restoreUntil });
    case 'claimStarter':
      return claimStarter(world, op, c, input, out);
    case 'store':
      return store(world, op, c, input, out);
    case 'load':
      return load(world, op, c, input, out);
    case 'use': {
      const d = runningDaemon(world, op, c.actor);
      if (!d.moves.includes(c.args.move)) throw new Rejection('E_INVALID', `daemon does not know ${c.args.move}`);
      world.queuedUses.push({ daemonId: d.id, move: c.args.move, aim: c.args, input });
      return;
    }
  }
}

/**
 * Travel through a gateway (SP3b spec §4.2): within GATEWAY_RADIUS of it, nothing running, no open capture,
 * nothing pending, and the best daemon in RAM at the gate level. The move itself happens once the store has
 * recorded the new subnet (the runtime hands the operator to the destination world).
 */
function travel(world: World, op: Operator, c: Cmd<'travel'>, input: Input, out: Out): void {
  const gate = world.subnet.gateways.find((g) => g.id === c.args.gatewayId);
  if (!gate) throw new Rejection('E_INVALID', `no gateway ${c.args.gatewayId} in ${world.subnet.id}`);
  // Checked here, in the world that runs the travel: a command queued before a hand-off runs in the destination.
  if (!world.hosted(gate.to)) throw new Rejection('E_STATE', `${gate.to} is not available`);
  if (distance(op, gate.at) > GATEWAY_RADIUS) throw new Rejection('E_RANGE', 'move onto the gateway first');
  if (op.running.length > 0) throw new Rejection('E_STATE', 'recall running daemons first');
  if (op.captureId) throw new Rejection('E_STATE', 'a capture is in progress');
  if (world.hasPendingFor(op.id)) throw new Rejection('E_STATE', 'wait for pending actions');
  const best = Math.max(0, ...op.ram.map((id) => world.daemons.get(id)!.level));
  if (best < gate.requires.level) throw new Rejection('E_STATE', `${gate.to} needs a level ${gate.requires.level} daemon`);
  op.travelling = true;
  op.path = [];
  op.restoreUntil = null;
  world.trackIntent(
    { id: world.newId('i'), kind: 'travel', operatorId: op.id, reqId: input.reqId, gatewayId: gate.id, from: world.subnet.id, to: gate.to, x: gate.arrive.x, y: gate.arrive.y },
    out,
  );
}

/** Bit Flipper: +1 to one IV (cap 31); the daemon is patched for life and never rolls clean. */
function bitFlip(world: World, op: Operator, d: Daemon, stat: Cmd<'useItem'>['args']['stat'], input: Input, out: Out): void {
  if (!stat) throw new Rejection('E_INVALID', 'bitflipper needs a stat');
  if (d.ivs[stat] >= MAX_IV) throw new Rejection('E_STATE', `${stat} IV is already ${MAX_IV}`);
  op.inventory.bitflipper = (op.inventory.bitflipper ?? 0) - 1;
  d.ivs[stat]++;
  d.patched = true;
  const sp = getSpecies(d.species);
  const oldMax = d.stats.hp;
  d.stats = computeStats({ base: sp.base, ivs: d.ivs, bonus: d.bonus, level: d.level, nature: d.nature });
  // A crashed daemon stays at 0 HP; otherwise it keeps its missing HP.
  if (d.hp > 0) d.hp = Math.min(d.stats.hp, d.hp + (d.stats.hp - oldMax));
  d.history.push({ at: world.now(), kind: 'patched', detail: `${stat} +1 (bitflipper)` });
  return out.ok(input, { ivs: statBlockToArray(d.ivs), patched: true });
}

function moveTo(world: World, op: Operator, c: Cmd<'moveTo'>, input: Input, out: Out): void {
  const dest = { x: c.args.x, y: c.args.y };
  if (c.actor === 'self') {
    op.path = pathTo(world, op, dest);
    op.restoreUntil = null;
    return out.ok(input);
  }
  const d = runningDaemon(world, op, c.actor);
  if ((d.statuses.stalled ?? 0) > world.tick) throw new Rejection('E_STATE', 'daemon is stalled');
  if (distance(dest, op) > LEASH_TILES) throw new Rejection('E_RANGE', `daemons stay within ${LEASH_TILES} tiles of their operator`);
  d.path = pathTo(world, d, dest);
  return out.ok(input);
}

function swap(world: World, op: Operator, c: Cmd<'swap'>, input: Input, out: Out): void {
  const outgoing = runningDaemon(world, op, c.args.outId);
  const incoming = ownedDaemon(world, op, c.args.inId);
  if (incoming.active) throw new Rejection('E_STATE', 'incoming daemon is already running');
  if (incoming.crashed) throw new Rejection('E_STATE', 'incoming daemon has crashed');
  if (incoming.pending) throw new Rejection('E_STATE', 'daemon is busy');
  requireSwapReady(world, op);
  world.deactivate(outgoing);
  world.activate(incoming, op);
  op.swapReadyTick = world.tick + world.ticks(SWAP_COOLDOWN_MS);
  out.emit({ e: 'swap', out: outgoing.id, in: incoming.id }, { to: op.id });
  return out.ok(input);
}

function claimStarter(world: World, op: Operator, c: Cmd<'claimStarter'>, input: Input, out: Out): void {
  if (op.starterClaimed || op.pendingClaim) throw new Rejection('E_STATE', 'starter already claimed');
  let species;
  try {
    species = getSpecies(c.args.species);
  } catch {
    throw new Rejection('E_INVALID', 'unknown species');
  }
  if (!species.starter) throw new Rejection('E_INVALID', `${species.name} is not a starter`);
  const roll = rollSpawn(world.rng, { clean: 0, signatureStep: 0 });
  op.pendingClaim = true;
  const daemon = {
    id: world.newId('d'),
    species: species.id,
    level: STARTER_LEVEL,
    xp: xpForLevel(STARTER_LEVEL),
    nature: roll.nature,
    traitSlot: roll.traitSlot,
    ivs: statBlockToArray(roll.ivs),
    bonus: statBlockToArray(roll.bonus),
    clean: false,
    signature: 0,
    hp: computeStats({ base: species.base, ivs: roll.ivs, bonus: roll.bonus, level: STARTER_LEVEL, nature: roll.nature }).hp,
    energy: 128,
    moves: movesAtLevel(species, STARTER_LEVEL),
    crashed: false,
    slot: 0,
    heldItem: null,
    patched: false,
    moveTypeUses: emptyMoveTypeUses(),
    crashes: 0,
    arenaWins: 0,
    history: [{ at: world.now(), kind: 'captured' as const, detail: `starter on ${world.subnet.id}` }],
    originalOperatorId: op.id,
  };
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'claimStarter',
      operatorId: op.id,
      reqId: input.reqId,
      name: c.args.operatorName,
      daemon,
      inventory: { ...STARTING_INVENTORY } as Record<string, number>,
      log: { originalOperatorId: op.id, capturedAtTick: world.tick, subnet: world.subnet.id, tool: 'starter', seedId: world.seedId, spawnIndex: null },
    },
    out,
  );
}

function store(world: World, op: Operator, c: Cmd<'store'>, input: Input, out: Out): void {
  requireAtHost(world, op);
  const d = ownedDaemon(world, op, c.args.daemonId);
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'already being stored');
  let slot = -1;
  for (let s = 0; s < DISK_SLOTS; s++) {
    if (!op.diskSlots.has(s)) {
      slot = s;
      break;
    }
  }
  if (slot < 0) throw new Rejection('E_STATE', 'Disk is full');
  d.pending = true;
  op.diskSlots.add(slot);
  world.trackIntent({ id: world.newId('i'), kind: 'store', operatorId: op.id, reqId: input.reqId, daemonId: d.id, diskSlot: slot }, out);
}

function load(world: World, op: Operator, c: Cmd<'load'>, input: Input, out: Out): void {
  requireAtHost(world, op);
  if (world.daemons.has(c.args.daemonId)) throw new Rejection('E_STATE', 'daemon is already in RAM');
  const slot = world.freeRamSlot(op);
  if (slot === null) throw new Rejection('E_STATE', 'RAM is full');
  op.reservedSlots.add(slot);
  world.trackIntent({ id: world.newId('i'), kind: 'load', operatorId: op.id, reqId: input.reqId, daemonId: c.args.daemonId, ramSlot: slot }, out);
}
