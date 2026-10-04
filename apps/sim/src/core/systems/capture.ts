import {
  HARDENED_MS,
  RAM_SLOTS,
  TAG_WINDOW_MS,
  challengeSize,
  checkAnswer,
  emptyMoveTypeUses,
  generateChallenge,
  getSpecies,
  getTool,
  publicChallenge,
  statBlockToArray,
  xpYield,
  type ToolId,
} from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, partyKey, type Capture, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import { toRamDaemon } from '../view.js';
import { addResearch, type World } from '../world.js';
import { FLEE_MS } from './ai.js';
import { awardXp, partyRecipients } from './progress.js';
import { advanceTickets } from './tickets.js';

export function startCapture(world: World, op: Operator, args: { targetId: string; tool: ToolId }, out: Out): string {
  if (op.captureId) throw new Rejection('E_STATE', 'a capture is already active');
  const tool = getTool(args.tool);
  if ((op.inventory[tool.id] ?? 0) <= 0) throw new Rejection('E_STATE', `no ${tool.id} left`);
  const target = world.daemons.get(args.targetId);
  if (!target || !target.wild || !target.active || target.hp <= 0) throw new Rejection('E_STATE', 'not a wild daemon');
  if (target.wild.tagOwner !== null && target.wild.tagOwner !== partyKey(op)) throw new Rejection('E_STATE', 'tagged by another operator');
  if (distance(op, target) > tool.range) throw new Rejection('E_RANGE', 'target out of tool range');
  if (op.ram.length + op.reservedSlots.size >= RAM_SLOTS && op.diskSlots.size >= op.diskCapacity) {
    throw new Rejection('E_STATE', 'RAM and Disk are full');
  }

  op.inventory[tool.id] = (op.inventory[tool.id] ?? 0) - 1;
  const tick = world.tick;
  target.wild.tagOwner = partyKey(op);
  target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
  const size = challengeSize(
    {
      stage: getSpecies(target.species).stage,
      hpFraction: target.hp / target.stats.hp,
      clean: target.clean,
      signature: target.signature,
      hardened: target.wild.hardenedUntil > tick,
      statused: Object.values(target.statuses).some((until) => (until ?? 0) > tick),
    },
    tool,
  );
  const challenge = generateChallenge(target.types, size, tool.noise, world.rng);
  const capture: Capture = {
    id: world.newId('c'),
    operatorId: op.id,
    targetId: target.id,
    tool: tool.id,
    challenge,
    deadlineTick: tick + world.ticks(tool.deadlineMs),
    state: 'open',
  };
  world.captures.set(capture.id, capture);
  op.captureId = capture.id;
  out.emit(
    { e: 'captureStart', captureId: capture.id, targetId: target.id, challenge: publicChallenge(challenge), deadlineTick: capture.deadlineTick },
    { to: op.id },
  );
  return capture.id;
}

export function submitCapture(world: World, op: Operator, args: { captureId: string; answer?: unknown }, out: Out): 'correct' | 'wrong' {
  const cap = world.captures.get(args.captureId);
  if (!cap || cap.operatorId !== op.id || cap.state !== 'open') throw new Rejection('E_STATE', 'no open capture with that id');
  const result = checkAnswer(cap.challenge, args.answer);
  if (result === 'invalid') throw new Rejection('E_INVALID', 'answer does not match the expected shape');
  if (result === 'wrong') {
    failCapture(world, cap, 'wrong_answer', out);
    return 'wrong';
  }
  commitCapture(world, op, cap, out);
  return 'correct';
}

export function failCapture(world: World, cap: Capture, reason: 'wrong_answer' | 'timeout' | 'packet_loss', out: Out): void {
  world.captures.delete(cap.id);
  const op = world.operators.get(cap.operatorId);
  if (op) op.captureId = null;
  const target = world.daemons.get(cap.targetId);
  if (target?.wild && target.active) {
    target.wild.hardenedUntil = world.tick + world.ticks(HARDENED_MS);
    if (target.wild.behaviour === 'timid') target.wild.fleeUntil = world.tick + world.ticks(FLEE_MS);
  }
  out.emit({ e: 'captureResult', captureId: cap.id, ok: false, reason }, { to: cap.operatorId });
}

function commitCapture(world: World, op: Operator, cap: Capture, out: Out): void {
  const target = world.daemons.get(cap.targetId)!;
  const wild = target.wild!;
  const sp = getSpecies(target.species);
  // XP to the damaging daemons of every present member of the tagging party (SP4 spec §6).
  awardXp(world, partyRecipients(world, wild.tagOwner ?? partyKey(op), wild.damagedBy, target), xpYield(sp.baseYield, target.level), out);

  let location: 'RAM' | 'DISK' = 'RAM';
  let slot = world.freeRamSlot(op);
  if (slot === null) {
    location = 'DISK';
    slot = 0;
    while (op.diskSlots.has(slot)) slot++;
    op.diskSlots.add(slot);
  } else {
    op.reservedSlots.add(slot);
  }

  const intent: Intent = {
    id: world.newId('i'),
    kind: 'capture',
    operatorId: op.id,
    captureId: cap.id,
    location,
    tool: cap.tool,
    daemon: {
      id: world.newId('d'),
      species: target.species,
      level: target.level,
      xp: target.xp,
      nature: target.nature,
      traitSlot: target.traitSlot,
      ivs: statBlockToArray(target.ivs),
      bonus: statBlockToArray(target.bonus),
      clean: target.clean,
      signature: target.signature,
      hp: Math.max(1, Math.floor(target.hp)),
      energy: Math.floor(target.energy),
      moves: [...target.moves],
      crashed: false,
      slot,
      heldItem: null,
      patched: false,
      moveTypeUses: emptyMoveTypeUses(),
      crashes: 0,
      arenaWins: 0,
      history: [{ at: world.now(), kind: 'captured', detail: `${cap.tool} on ${world.subnet.id}` }],
      originalOperatorId: op.id,
    },
    log: {
      originalOperatorId: op.id,
      capturedAtTick: world.tick,
      subnet: world.subnet.id,
      tool: cap.tool,
      seedId: world.seedId,
      spawnIndex: wild.spawnIndex,
    },
  };
  cap.state = 'committing';
  world.removeDaemon(target.id);
  world.trackIntent(intent, out);
}

export function completeCaptureIntent(world: World, op: Operator, intent: Extract<Intent, { kind: 'capture' }>, result: IntentResult, out: Out): void {
  world.captures.delete(intent.captureId);
  op.captureId = null;
  if (intent.location === 'RAM') op.reservedSlots.delete(intent.daemon.slot);
  if (!result.ok) {
    if (intent.location === 'DISK') op.diskSlots.delete(intent.daemon.slot);
    op.inventory[intent.tool] = (op.inventory[intent.tool] ?? 0) + 1;
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: false, reason: 'persist_failed' }, { to: op.id });
    return;
  }
  // Research and tickets count the capture once, for the operator who made it (a reload after the commit already
  // loaded the research point: see addResearch).
  const reloaded = intent.location === 'RAM' && world.ownsDaemon(op, intent.daemon.id);
  const line = addResearch(op, intent.daemon.species, result, reloaded);
  advanceTickets(world, op, { kind: 'capture', line: Number(line), level: intent.daemon.level }, out);
  if (intent.location === 'RAM') {
    const d = reloaded ? world.daemons.get(intent.daemon.id)! : world.addOwned(op, intent.daemon);
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: true, daemon: toRamDaemon(world, d) }, { to: op.id });
  } else {
    out.emit({ e: 'captureResult', captureId: intent.captureId, ok: true }, { to: op.id });
  }
}

export function progressCaptures(world: World, out: Out): void {
  for (const cap of [...world.captures.values()]) {
    if (cap.state !== 'open') continue;
    const op = world.operators.get(cap.operatorId);
    const target = world.daemons.get(cap.targetId);
    if (!op) {
      world.captures.delete(cap.id);
      continue;
    }
    if (!target || !target.active || target.hp <= 0 || op.hitTick === world.tick || distance(op, target) > getTool(cap.tool).range) {
      failCapture(world, cap, 'packet_loss', out);
    } else if (world.tick > cap.deadlineTick) {
      failCapture(world, cap, 'timeout', out);
    }
  }
}
