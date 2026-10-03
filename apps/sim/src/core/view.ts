import { statBlockToArray, type StatusId } from '@daemonet/rules';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import type { Daemon, Operator } from './model.js';
import type { World } from './world.js';

export const INTEREST_RADIUS = 32;

const activeStatuses = (world: World, d: Daemon): StatusId[] =>
  (Object.entries(d.statuses) as Array<[StatusId, number]>).filter(([, until]) => until > world.tick).map(([s]) => s);

export function toDaemonEntity(world: World, d: Daemon): Entity {
  return {
    kind: 'daemon',
    id: d.id,
    species: d.species,
    types: [...d.types],
    level: d.level,
    x: d.x,
    y: d.y,
    hp: d.hp,
    maxHp: d.stats.hp,
    owner: d.ownerId,
    taggedBy: d.wild?.tagOwner ?? null,
    clean: d.clean,
    signature: d.signature,
    statuses: activeStatuses(world, d),
    hardened: (d.wild?.hardenedUntil ?? 0) > world.tick,
  };
}

export function toOperatorEntity(op: Operator): Entity {
  return { kind: 'operator', id: op.id, name: op.name, x: op.x, y: op.y };
}

export function toRamDaemon(world: World, d: Daemon): RamDaemon {
  return {
    id: d.id,
    species: d.species,
    level: d.level,
    xp: d.xp,
    nature: d.nature,
    traitSlot: d.traitSlot,
    ivs: statBlockToArray(d.ivs),
    bonus: statBlockToArray(d.bonus),
    clean: d.clean,
    signature: d.signature,
    hp: d.hp,
    maxHp: d.stats.hp,
    energy: d.energy,
    moves: [...d.moves],
    crashed: d.crashed,
    slot: d.slot,
    cooldowns: Object.fromEntries(Object.entries(d.cooldowns).filter(([, t]) => t > world.tick)),
  };
}

export function toSelf(world: World, op: Operator): OperatorSelf {
  const cap = op.captureId ? world.captures.get(op.captureId) : undefined;
  return {
    id: op.id,
    name: op.name,
    starterClaimed: op.starterClaimed,
    x: op.x,
    y: op.y,
    bits: op.bits,
    ram: op.ram.map((id) => toRamDaemon(world, world.daemons.get(id)!)).sort((a, b) => a.slot - b.slot),
    running: [...op.running],
    inventory: { ...op.inventory },
    swapReadyTick: op.swapReadyTick,
    capture: cap ? { captureId: cap.id, targetId: cap.targetId, deadlineTick: cap.deadlineTick } : null,
  };
}

/** Every operator and active daemon within `radius` of (x, y). */
export function entitiesNear(world: World, x: number, y: number, radius = INTEREST_RADIUS): Entity[] {
  const at = { x, y };
  const out: Entity[] = [];
  for (const op of world.operators.values()) if (distance(op, at) <= radius) out.push(toOperatorEntity(op));
  for (const d of world.daemons.values()) if (d.active && distance(d, at) <= radius) out.push(toDaemonEntity(world, d));
  return out;
}
