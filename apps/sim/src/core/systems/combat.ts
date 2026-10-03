import { TAG_WINDOW_MS, damage, effectiveCooldownMs, getMove, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { Rejection, type Daemon, type Input, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

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
    if (distance(attacker, pos(v)) > move.range) throw new Rejection('E_RANGE', 'target out of range');
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

/** Validates and applies one move. Throws Rejection on E_COOLDOWN / E_ENERGY / E_RANGE / E_STATE / E_INVALID. */
export function executeMove(world: World, attacker: Daemon, moveId: string, aim: Aim, out: Out): void {
  if (!attacker.active || attacker.hp <= 0) throw new Rejection('E_STATE', 'daemon is not running');
  const move = getMove(moveId);
  const tick = world.tick;
  if ((attacker.cooldowns[move.id] ?? 0) > tick) throw new Rejection('E_COOLDOWN', `${move.id} is cooling down`);
  if (attacker.energy < move.energyCost) throw new Rejection('E_ENERGY', 'not enough energy');
  const victims = selectVictims(world, attacker, move, aim);

  attacker.energy -= move.energyCost;
  const throttled = (attacker.statuses.throttled ?? 0) > tick;
  attacker.cooldowns[move.id] = tick + world.ticks(effectiveCooldownMs(move.cooldownMs, attacker.stats.haste, throttled));
  attacker.lastCombatTick = tick;

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
    target.hp = Math.max(0, target.hp - r.amount);
    target.lastCombatTick = tick;
    out.emit({ e: 'hit', source: attacker.id, target: target.id, move: move.id, amount: r.amount, multiplier: r.multiplier }, { at: attacker });
    if (target.wild && attacker.ownerId) {
      if (target.wild.tagOwner === null) out.emit({ e: 'battleStart', wild: target.id, operator: attacker.ownerId }, { at: target });
      target.wild.tagOwner = attacker.ownerId;
      target.wild.tagUntil = tick + world.ticks(TAG_WINDOW_MS);
      target.wild.damagedBy.add(attacker.id);
      target.wild.aggro ??= attacker.id;
    }
    if (move.status && r.multiplier > 0 && world.rng.chance(move.status.chance)) {
      const untilTick = tick + world.ticks(move.status.durationMs);
      target.statuses[move.status.id] = untilTick;
      out.emit({ e: 'status', target: target.id, status: move.status.id, untilTick }, { at: target });
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
