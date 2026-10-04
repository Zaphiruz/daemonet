import { ENERGY_MAX, TAG_WINDOW_MS, damage, effectiveCooldownMs, getItem, getMove, typeIndex, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { Rejection, freshEngagement, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Trait thresholds (SP3a spec section 3.5). */
export const FILLER_COOLDOWN_MS = 512;
export const HEAVY_COOLDOWN_MS = 4096;
export const LOW_HP_FRACTION = 0.25;
export const DARKMODE_RANGE = 6;
export const SONAR_BONUS_RANGE = 2;
export const DECAY_ENERGY = 4;
export const ECHO_CHANCE = 0.25;

/** Multiplier of a held item, read from the rules item table. */
function heldMultiplier(id: string): number {
  const item = getItem(id);
  if (item.kind !== 'held') throw new RangeError(`${id} is not a held item`);
  return item.multiplier;
}
/** Held-item multipliers (spec section 3.6). */
export const AMPLIFIER = heldMultiplier('amplifier');
export const HEATSINK = heldMultiplier('heatsink');
export const FIREWALL = heldMultiplier('firewall');
/** Damage multiplier against an exposed target. */
export const EXPOSED_MULT = 1.25;

export interface Aim {
  targetId?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
}

export interface QueuedUse {
  daemonId: string;
  move: string;
  aim: Aim;
  /** Player uses carry their input so the reply can be sent; wild uses have none. */
  input?: Input;
}

type Victim = { kind: 'daemon'; d: Daemon } | { kind: 'operator'; op: Operator };

const pos = (v: Victim): Point => (v.kind === 'daemon' ? v.d : v.op);
const vid = (v: Victim): string => (v.kind === 'daemon' ? v.d.id : v.op.id);

/** Who `attacker` may hit. Owned daemons hit wild daemons not tagged by someone else; wild daemons hit the side they are fighting. */
function candidates(world: World, attacker: Daemon): Victim[] {
  if (attacker.ownerId) {
    const out: Victim[] = [];
    for (const d of world.daemons.values()) {
      if (d.wild && d.active && d.hp > 0 && (d.wild.tagOwner === null || d.wild.tagOwner === attacker.ownerId)) out.push({ kind: 'daemon', d });
    }
    return out;
  }
  const aggro = attacker.wild?.aggro;
  if (!aggro) return [];
  const opId = world.daemons.get(aggro)?.ownerId ?? (world.operators.has(aggro) ? aggro : null);
  const op = opId ? world.operators.get(opId) : undefined;
  if (!op) return [];
  const out: Victim[] = op.running.map((id) => ({ kind: 'daemon' as const, d: world.daemons.get(id)! }));
  out.push({ kind: 'operator', op });
  return out;
}

function aimPoint(world: World, aim: Aim, pool: Victim[]): Point | null {
  if (aim.targetId !== undefined) {
    const v = pool.find((x) => vid(x) === aim.targetId);
    if (v) return pos(v);
    return world.locate(aim.targetId);
  }
  if (aim.x !== undefined && aim.y !== undefined) return { x: aim.x, y: aim.y };
  return null;
}

function selectVictims(world: World, attacker: Daemon, move: MoveDef, aim: Aim): Victim[] {
  const pool = candidates(world, attacker);
  const shape = move.shape;
  if (shape.kind === 'single') {
    if (aim.targetId === undefined) throw new Rejection('E_INVALID', 'single-target moves need targetId');
    const v = pool.find((x) => vid(x) === aim.targetId);
    if (!v) throw new Rejection('E_STATE', 'not a valid target');
    const range = move.range + (attacker.trait === 'sonar' ? SONAR_BONUS_RANGE : 0);
    if (distance(attacker, pos(v)) > range) throw new Rejection('E_RANGE', 'target out of range');
    return [v];
  }
  const at = aimPoint(world, aim, pool);
  if (!at) throw new Rejection('E_INVALID', 'area moves need targetId or x/y');
  if (shape.kind === 'circle') {
    if (distance(attacker, at) > move.range) throw new Rejection('E_RANGE', 'area out of range');
    return pool.filter((v) => distance(at, pos(v)) <= shape.radius);
  }
  const dirX = at.x - attacker.x;
  const dirY = at.y - attacker.y;
  const dirLen = Math.hypot(dirX, dirY) || 1;
  const half = (shape.angleDeg / 2) * (Math.PI / 180);
  return pool.filter((v) => {
    const p = pos(v);
    const dx = p.x - attacker.x;
    const dy = p.y - attacker.y;
    const len = Math.hypot(dx, dy);
    if (len > shape.length) return false;
    if (len === 0) return true;
    const cos = (dx * dirX + dy * dirY) / (len * dirLen);
    return Math.acos(Math.max(-1, Math.min(1, cos))) <= half;
  });
}

const lowHp = (d: Daemon): boolean => d.hp < d.stats.hp * LOW_HP_FRACTION;
const isFiller = (m: MoveDef): boolean => m.cooldownMs <= FILLER_COOLDOWN_MS;
const isHeavy = (m: MoveDef): boolean => m.cooldownMs >= HEAVY_COOLDOWN_MS;

/** Energy a move costs `d` (synburst / lazyeval). */
export function energyCost(d: Daemon, move: MoveDef): number {
  if (d.trait === 'synburst' && isFiller(move) && lowHp(d)) return 0;
  if (d.trait === 'lazyeval' && isHeavy(move)) return Math.floor(move.energyCost * 0.75);
  return move.energyCost;
}

/** Cooldown in ms for `d` using `move` now (haste, throttled, heatsink, overclock). */
export function cooldownMs(d: Daemon, move: MoveDef, tick: number): number {
  let ms = effectiveCooldownMs(move.cooldownMs, d.stats.haste, (d.statuses.throttled ?? 0) > tick);
  if (d.heldItem === 'heatsink') ms = Math.floor(ms * HEATSINK);
  if (d.trait === 'overclock' && lowHp(d)) ms = Math.floor(ms * 0.875);
  return ms;
}

/** Applies every multiplier on top of the base damage roll; a non-zero hit stays >= 1. */
export function scaleDamage(amount: number, attacker: Daemon, target: Daemon, move: MoveDef, tick: number): number {
  if (amount <= 0) return 0;
  let mult = 1;
  if (attacker.heldItem === 'amplifier') mult *= AMPLIFIER;
  if (target.heldItem === 'firewall') mult *= FIREWALL;
  if ((target.statuses.exposed ?? 0) > tick) mult *= EXPOSED_MULT;
  if (target.trait === 'darkmode' && move.range >= DARKMODE_RANGE) mult *= 0.75;
  if (target.trait === 'salted' && target.engagement.lastHitMove === move.id) mult *= 0.75;
  return Math.max(1, Math.floor(amount * mult));
}

/** One landed hit on `target` (bitshield, nullsafe, decay, absorb, tag bookkeeping, status). Returns damage dealt. */
function applyHit(world: World, attacker: Daemon, target: Daemon, move: MoveDef, amount: number, multiplier: number, out: Out): number {
  const tick = world.tick;
  const engagement = target.engagement;
  if (target.trait === 'bitshield' && !engagement.blocked) {
    engagement.blocked = true;
    amount = 0;
  }
  if (amount >= target.hp && target.trait === 'nullsafe' && !engagement.survived) {
    engagement.survived = true;
    amount = Math.max(0, target.hp - 1);
  }
  target.hp = Math.max(0, target.hp - amount);
  target.lastCombatTick = tick;
  engagement.lastHitMove = move.id;
  if (attacker.trait === 'decay') target.energy = Math.max(0, target.energy - DECAY_ENERGY);
  if (target.trait === 'absorb') target.energy = Math.min(ENERGY_MAX, target.energy + amount * 0.1);
  out.emit({ e: 'hit', source: attacker.id, target: target.id, move: move.id, amount, multiplier }, { at: attacker });
  if (target.wild && attacker.ownerId) {
    if (target.wild.tagOwner === null) {
      out.emit({ e: 'battleStart', wild: target.id, operator: attacker.ownerId }, { at: target });
      // A fresh engagement starts with the tag.
      target.engagement = freshEngagement();
      target.engagement.lastHitMove = move.id;
      // The tagging hit has already spent bitshield / nullsafe for this engagement.
      target.engagement.blocked = engagement.blocked;
      target.engagement.survived = engagement.survived;
    }
    target.wild.tagOwner = attacker.ownerId;
    target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
    target.wild.damagedBy.add(attacker.id);
    target.wild.aggro ??= attacker.id;
  }
  if (move.status && multiplier > 0 && target.trait !== 'onewayfn' && world.rng.chance(move.status.chance)) {
    const durationMs = attacker.trait === 'entropy' ? move.status.durationMs * 1.5 : move.status.durationMs;
    const untilTick = tick + world.ticks(durationMs);
    target.statuses[move.status.id] = untilTick;
    out.emit({ e: 'status', target: target.id, status: move.status.id, untilTick }, { at: target });
  }
  return amount;
}

/** Validates and applies one move. Throws Rejection on E_COOLDOWN / E_ENERGY / E_RANGE / E_STATE / E_INVALID. */
export function executeMove(world: World, attacker: Daemon, moveId: string, aim: Aim, out: Out): void {
  if (!attacker.active || attacker.hp <= 0) throw new Rejection('E_STATE', 'daemon is not running');
  const move = getMove(moveId);
  const tick = world.tick;
  const free = attacker.trait === 'lowlatency' && attacker.engagement.freeMove;
  if (!free && (attacker.cooldowns[move.id] ?? 0) > tick) throw new Rejection('E_COOLDOWN', `${move.id} is cooling down`);
  const cost = energyCost(attacker, move);
  if (attacker.energy < cost) throw new Rejection('E_ENERGY', 'not enough energy');
  const victims = selectVictims(world, attacker, move, aim);

  attacker.engagement.freeMove = false;
  attacker.energy -= cost;
  attacker.cooldowns[move.id] = tick + world.ticks(cooldownMs(attacker, move, tick));
  attacker.lastCombatTick = tick;
  attacker.moveTypeUses[typeIndex(move.type)]!++;
  if (victims.length === 0 && attacker.trait === 'retransmit') attacker.energy += cost;

  for (const v of victims) {
    if (v.kind === 'operator') {
      v.op.hitTick = tick;
      out.emit({ e: 'hit', source: attacker.id, target: v.op.id, move: move.id, amount: 0, multiplier: 1 }, { at: attacker });
      continue;
    }
    const target = v.d;
    const r = damage(
      { level: attacker.level, attacker: attacker.stats, attackerTypes: attacker.types, defender: target.stats, defenderTypes: target.types, move },
      world.rng,
    );
    const amount = scaleDamage(r.amount, attacker, target, move, tick);
    const hadSurvived = target.engagement.survived;
    const dealt = applyHit(world, attacker, target, move, amount, r.multiplier, out);
    if (attacker.trait === 'echo' && isFiller(move) && dealt > 0 && target.hp > 0 && (hadSurvived || !target.engagement.survived) && world.rng.chance(ECHO_CHANCE)) {
      applyHit(world, attacker, target, move, Math.max(1, Math.floor(dealt / 2)), r.multiplier, out);
    }
  }
}

/** Player uses first (arrival order), then wild uses. Player uses get a reply. */
export function executeQueuedUses(world: World, uses: readonly QueuedUse[], out: Out): void {
  for (const use of uses) {
    const d = world.daemons.get(use.daemonId);
    try {
      if (!d) throw new Rejection('E_STATE', 'daemon is gone');
      executeMove(world, d, use.move, use.aim, out);
      if (use.input) out.ok(use.input);
    } catch (err) {
      if (!(err instanceof Rejection)) throw err;
      if (use.input) out.fail(use.input, err.code, err.message);
    }
  }
}
