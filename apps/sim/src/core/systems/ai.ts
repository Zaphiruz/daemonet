import { getMove, type MoveDef } from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import type { Daemon } from '../model.js';
import type { World } from '../world.js';
import type { QueuedUse } from './combat.js';

export const AGGRO_RADIUS = 6;
export const DEAGGRO_RADIUS = 16;
export const FLEE_MS = 4096;
const FLEE_DISTANCE = 8;
const WANDER_CHANCE = 1 / 64;
const REPATH_TICKS = 8;

function reach(move: MoveDef): number {
  return move.shape.kind === 'cone' ? move.shape.length : move.range;
}

function nearestHostile(world: World, d: Daemon): { id: string; at: Point } | null {
  let best: { id: string; at: Point; dist: number } | null = null;
  for (const op of world.operators.values()) {
    const candidates: Array<{ id: string; at: Point }> = [{ id: op.id, at: op }];
    for (const id of op.running) candidates.push({ id, at: world.daemons.get(id)! });
    for (const c of candidates) {
      const dist = distance(d, c.at);
      if (dist <= AGGRO_RADIUS && (!best || dist < best.dist)) best = { ...c, dist };
    }
  }
  return best;
}

function fleePath(world: World, d: Daemon, threat: Point): Point[] {
  const dx = d.x - threat.x;
  const dy = d.y - threat.y;
  const len = Math.hypot(dx, dy) || 1;
  const dest = { x: d.x + (dx / len) * FLEE_DISTANCE, y: d.y + (dy / len) * FLEE_DISTANCE };
  return world.grid.findPath(d, dest) ?? [];
}

/** Decide movement for every wild daemon and return the moves they will use this tick. */
export function planWild(world: World): QueuedUse[] {
  const uses: QueuedUse[] = [];
  const tick = world.tick;
  const capturing = new Map<string, string>();
  for (const cap of world.captures.values()) if (cap.state === 'open') capturing.set(cap.targetId, cap.operatorId);

  for (const d of world.daemons.values()) {
    const w = d.wild;
    if (!w || !d.active || d.hp <= 0) continue;
    const stalled = (d.statuses.stalled ?? 0) > tick;

    const capturer = capturing.get(d.id);
    if (capturer) {
      if (w.behaviour === 'timid') w.fleeUntil = Math.max(w.fleeUntil, tick + 1);
      if (w.behaviour === 'territorial') w.aggro = capturer;
    }
    if (!w.aggro && w.behaviour === 'territorial') w.aggro = nearestHostile(world, d)?.id ?? null;

    const target = w.aggro ? world.locate(w.aggro) : null;
    if (w.aggro && (!target || distance(d, target) > DEAGGRO_RADIUS)) w.aggro = null;

    const fleeing = tick < w.fleeUntil || (w.behaviour === 'timid' && w.tagOwner !== null && d.hp < d.stats.hp / 2);
    if (fleeing) {
      const threat = target ?? (capturer ? world.operators.get(capturer) : undefined);
      if (!stalled && threat && d.path.length === 0) d.path = fleePath(world, d, threat);
      continue;
    }

    if (w.aggro && target) {
      const dist = distance(d, target);
      const usable = d.moves
        .map(getMove)
        .filter((m) => (d.cooldowns[m.id] ?? 0) <= tick && d.energy >= m.energyCost && dist <= reach(m))
        .sort((a, b) => b.power - a.power);
      const best = usable[0];
      if (best) {
        d.path = [];
        uses.push({ daemonId: d.id, move: best.id, aim: { targetId: w.aggro } });
      } else if (!stalled && (d.path.length === 0 || tick % REPATH_TICKS === 0)) {
        d.path = world.grid.findPath(d, target) ?? [];
      }
      continue;
    }

    if (!stalled && d.path.length === 0 && world.rng.chance(WANDER_CHANCE)) {
      const region = world.subnet.regions[w.region];
      const dest = region ? world.grid.randomWalkableIn(region.rect, world.rng) : null;
      if (dest) d.path = world.grid.findPath(d, dest) ?? [];
    }
  }
  return uses;
}
