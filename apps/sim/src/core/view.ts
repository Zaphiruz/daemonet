import { SCAN_BUCKETS, SCAN_BUCKET_WIDTH, SCAN_IVS, SCAN_NATURE, STAT_KEYS, getSpecies, statBlockToArray, type StatusId } from '@daemonet/rules';
import { evolutionOptions } from '@daemonet/rules/evolution';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import { partyKey, type Daemon, type Operator } from './model.js';
import { evolutionContext } from './systems/evolve.js';
import { boardTicket } from './systems/tickets.js';
import type { World } from './world.js';

export const INTEREST_RADIUS = 32;

const activeStatuses = (world: World, d: Daemon): StatusId[] =>
  (Object.entries(d.statuses) as Array<[StatusId, number]>).filter(([, until]) => until > world.tick).map(([s]) => s);

type Scan = NonNullable<Extract<Entity, { kind: 'daemon' }>['scan']>;

/**
 * What `viewer`'s Codex research reveals about a wild daemon, or undefined. Only the viewer's own projection carries it
 * (spectators of the viewer's session are the same account); it never contains evolution requirement data.
 */
function scanFor(viewer: Operator | undefined, d: Daemon): Scan | undefined {
  if (!viewer || !d.wild) return undefined;
  const points = viewer.research[String(getSpecies(d.species).line)] ?? 0;
  if (points < SCAN_NATURE) return undefined;
  const scan: Scan = { nature: d.nature };
  if (points >= SCAN_BUCKETS) scan.ivBuckets = STAT_KEYS.map((k) => Math.floor(d.ivs[k] / SCAN_BUCKET_WIDTH));
  if (points >= SCAN_IVS) scan.ivs = statBlockToArray(d.ivs);
  return scan;
}

/**
 * Who holds the tag, as `viewer` sees it: a tag held by the viewer's own party reads as the viewer's id (so
 * `taggedBy === me.id` keeps working in clusters); any other tag reads as its raw party key (an operator id, or an
 * opaque `cluster:<id>` that names no member). Without a viewer it is always the raw key.
 */
function taggedByFor(viewer: Operator | undefined, d: Daemon): string | null {
  const key = d.wild?.tagOwner ?? null;
  if (key === null) return null;
  return viewer && key === partyKey(viewer) ? viewer.id : key;
}

/**
 * `viewer` adds the scan fields its research unlocks (wild daemons only; without a viewer there are none) and translates
 * a tag held by its own party to its own id.
 */
export function toDaemonEntity(world: World, d: Daemon, viewer?: Operator): Entity {
  const scan = scanFor(viewer, d);
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
    taggedBy: taggedByFor(viewer, d),
    clean: d.clean,
    signature: d.signature,
    statuses: activeStatuses(world, d),
    hardened: (d.wild?.hardenedUntil ?? 0) > world.tick,
    ...(scan ? { scan } : {}),
  };
}

export function toOperatorEntity(op: Operator): Entity {
  return { kind: 'operator', id: op.id, name: op.name, x: op.x, y: op.y };
}

export function toRamDaemon(world: World, d: Daemon): RamDaemon {
  const op = world.operators.get(d.ownerId!)!;
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
    heldItem: d.heldItem,
    patched: d.patched,
    moveTypeUses: [...d.moveTypeUses],
    crashes: d.crashes,
    evolutions: evolutionOptions(d, evolutionContext(world, op, d)).map((o) => ({
      form: o.form,
      name: o.name,
      level: o.level,
      hidden: o.hidden,
      revealed: o.revealed,
      met: o.met,
      requirement: o.requirement ? [...o.requirement] : null,
    })),
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
    diskCapacity: op.diskCapacity,
    tickets: op.tickets
      .filter((t) => !t.pending)
      .map((t) => ({
        id: t.id,
        day: t.day,
        subnet: t.subnet,
        index: t.index,
        kind: t.kind,
        params: t.params,
        target: t.target,
        reward: t.reward,
        progress: t.progress,
        title: boardTicket(t.subnet, t.day, t.index)?.title ?? t.kind,
      })),
    cluster: op.cluster
      ? { id: op.cluster.id, code: op.cluster.code, leaderId: op.cluster.leaderId, members: op.cluster.members.map((m) => ({ ...m })) }
      : null,
    ticketsToday: op.ticketsToday,
    ticketsDay: op.ticketsDay,
    research: { ...op.research },
    ram: op.ram.map((id) => toRamDaemon(world, world.daemons.get(id)!)).sort((a, b) => a.slot - b.slot),
    running: [...op.running],
    inventory: { ...op.inventory },
    swapReadyTick: op.swapReadyTick,
    capture: cap ? { captureId: cap.id, targetId: cap.targetId, deadlineTick: cap.deadlineTick } : null,
  };
}

/** Every operator and active daemon within `radius` of (x, y), projected for `viewer` (scans, own-party tags). */
export function entitiesNear(world: World, x: number, y: number, radius = INTEREST_RADIUS, viewer?: Operator): Entity[] {
  const at = { x, y };
  const out: Entity[] = [];
  for (const op of world.operators.values()) if (distance(op, at) <= radius) out.push(toOperatorEntity(op));
  for (const d of world.daemons.values()) if (d.active && distance(d, at) <= radius) out.push(toDaemonEntity(world, d, viewer));
  return out;
}
