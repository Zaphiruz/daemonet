import {
  ADDS_PER_PHASE,
  ADD_LEVEL,
  BOSS_HP_MULTIPLIER,
  BOSS_LEVEL,
  BOSS_PHASES,
  COPY_LEVEL,
  COPY_TTL_MS,
  INCIDENT_SUBNET,
  INCIDENT_WINDOW_MS,
  TELEGRAPH_DAMAGE,
  TELEGRAPH_DELAY_MS,
  TELEGRAPH_EVERY_MS,
  TELEGRAPH_RADIUS,
  bossSpecies,
  getSubnet,
  incidentNumber,
  incidentPayouts,
  lineBase,
  nextIncidentStart,
  rollSpawn,
} from '@daemonet/rules';
import { distance, type Point } from '../grid.js';
import { incidentRewardId, type Daemon, type IncidentParticipant, type IncidentState } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Where evicted operators land: the host of the subnet the Incident gateway comes from. */
export const EVICT_TO = 'backbone';
/** Grace after the copies' lifetime before eviction; also the wait before an eviction that failed is raised again. */
export const EVICT_GRACE_MS = 5_000;
/** The telegraph picks its target among operators this close to the boss. */
export const TELEGRAPH_TARGET_RANGE = 48;

type Phase = 'open' | 'fighting' | 'shield' | 'unshield' | 'cleared' | 'expired';

const publicState = (world: World, inc: IncidentState, phase: Phase) =>
  ({ e: 'incident', phase, id: inc.id, n: inc.n, species: inc.species, endsAt: new Date(inc.endsAtMs).toISOString(), bossId: world.daemons.has(inc.bossId) ? inc.bossId : null }) as const;

/** `p` moved onto the subnet's floor (a copy or an add spawned next to the edge stays inside it). */
function inside(world: World, p: Point): Point {
  const x = Math.min(world.subnet.width - 0.5, Math.max(0.5, p.x));
  const y = Math.min(world.subnet.height - 0.5, Math.max(0.5, p.y));
  return world.grid.isWalkablePoint({ x, y }) ? { x, y } : { ...world.subnet.spawn };
}

/**
 * Every contributor of an Incident (damage > 0), ordered by damage descending then operator id, with its share of the
 * total and its reward (`incidentPayouts`; 0 for a contributor under the minimum share). The full list is what the
 * Incident row records and every payout intent carries, so a store can re-derive each reward from the rules: the
 * payout list alone would drop the sub-1% contributors and change the total.
 */
export function incidentParticipants(damage: ReadonlyMap<string, number>): Array<Omit<IncidentParticipant, 'name'>> {
  const entries = [...damage].filter(([, d]) => Number.isFinite(d) && d > 0);
  const total = entries.reduce((a, [, d]) => a + d, 0);
  const paid = new Map(incidentPayouts(damage).map((p) => [p.operatorId, p.reward]));
  return entries
    .map(([operatorId, d]) => ({ operatorId, damage: d, share: d / total, reward: paid.get(operatorId) ?? 0 }))
    .sort((a, b) => b.damage - a.damage || (a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0));
}

function open(world: World, now: number, out: Out): void {
  const arena = world.subnet.arena ?? { x: world.subnet.width / 2, y: world.subnet.height / 2, radius: 16 };
  const scheduled = !world.incidentRequested && now >= world.nextIncidentAt;
  // A scheduled Incident is numbered by its slot (the boss the api announces for it); an admin start does not move the
  // schedule and draws its boss from the current slot plus the Incidents run since boot. (An admin-started Incident that
  // is still running at a scheduled slot delays that scheduled one until it ends: it then opens at once.)
  const n = scheduled ? incidentNumber(world.nextIncidentAt) : incidentNumber(now) + world.incidentCount;
  const species = bossSpecies(n);
  const boss = world.spawnWild(species, BOSS_LEVEL, inside(world, arena), -1, rollSpawn(world.rng, { clean: 0, signatureStep: 0 }));
  boss.stats = { ...boss.stats, hp: boss.stats.hp * BOSS_HP_MULTIPLIER };
  boss.hp = boss.stats.hp;
  boss.wild!.behaviour = 'territorial';
  boss.wild!.boss = true;
  boss.wild!.open = true;
  world.incidentCount++;
  world.incidentRequested = false;
  if (now >= world.nextIncidentAt) world.nextIncidentAt = nextIncidentStart(now + 1);
  world.incident = {
    id: world.newId('inc'),
    n,
    species,
    phase: 'open',
    bossId: boss.id,
    openedAtMs: now,
    endsAtMs: now + INCIDENT_WINDOW_MS,
    shield: false,
    nextPhase: 0,
    adds: [],
    damage: new Map(),
    nextTelegraphTick: 0,
    telegraph: null,
  };
  world.evictRetryTick.clear();
  out.emit(publicState(world, world.incident, 'open'), { at: null });
}

/**
 * Called by combat for every landed hit on the boss with the HP it actually removed: only that counts as contribution
 * (a shielded or overkill hit adds nothing), and the first hit starts the fight.
 */
export function noteBossHit(world: World, operatorId: string, dealt: number, out: Out): void {
  const inc = world.incident;
  if (!inc) return;
  if (dealt > 0) inc.damage.set(operatorId, (inc.damage.get(operatorId) ?? 0) + dealt);
  if (inc.phase === 'open') {
    inc.phase = 'fighting';
    inc.nextTelegraphTick = world.tick + world.ticks(TELEGRAPH_EVERY_MS);
    out.emit(publicState(world, inc, 'fighting'), { at: null });
  }
}

function spawnAdds(world: World, inc: IncidentState, boss: Daemon): void {
  const species = lineBase(inc.species);
  inc.adds = [];
  for (let i = 0; i < ADDS_PER_PHASE; i++) {
    const angle = (i / ADDS_PER_PHASE) * Math.PI * 2;
    const at = inside(world, { x: boss.x + Math.cos(angle) * 4, y: boss.y + Math.sin(angle) * 4 });
    const add = world.spawnWild(species, ADD_LEVEL, at, -1, rollSpawn(world.rng, { clean: 0, signatureStep: 0 }));
    add.wild!.behaviour = 'territorial';
    add.wild!.open = true;
    add.wild!.aggro = boss.wild!.aggro;
    inc.adds.push(add.id);
  }
}

function removeAdds(world: World, inc: IncidentState): void {
  for (const id of inc.adds) world.removeDaemon(id);
  inc.adds = [];
}

function clear(world: World, inc: IncidentState, out: Out): void {
  removeAdds(world, inc);
  const participants: IncidentParticipant[] = incidentParticipants(inc.damage).map((p) => ({ ...p, name: world.operators.get(p.operatorId)?.name ?? null }));
  const endsAt = new Date(inc.endsAtMs).toISOString();
  // only contributors with a reward (>= the minimum share) are paid and get a copy
  for (const p of participants.filter((x) => x.reward > 0)) {
    // One intent per contributor, with an id derived from the Incident: exactly one payout even across retries.
    world.trackIntent(
      {
        id: incidentRewardId(inc.id, p.operatorId),
        kind: 'incidentReward',
        operatorId: p.operatorId,
        incidentId: inc.id,
        n: inc.n,
        species: inc.species,
        openedAt: new Date(inc.openedAtMs).toISOString(),
        endsAt,
        reward: p.reward,
        damage: p.damage,
        share: p.share,
        participants: participants.map((x) => ({ ...x })),
      },
      out,
    );
    const op = world.operators.get(p.operatorId);
    if (!op) {
      // a contributor who has left kernelspace is paid wherever it is now (the runtime), and gets no copy
      world.markRewardElsewhere(incidentRewardId(inc.id, p.operatorId));
      continue;
    }
    // a personal copy: only this operator can hit or capture it; a fresh roll, so it can be clean or carry a signature
    const copy = world.spawnWild(inc.species, COPY_LEVEL, inside(world, { x: op.x + 1, y: op.y }), -1, rollSpawn(world.rng, world.odds));
    copy.wild!.behaviour = 'wanderer';
    copy.wild!.personal = op.id;
    copy.wild!.tagOwner = `personal:${op.id}`;
    copy.wild!.tagUntil = Number.MAX_SAFE_INTEGER;
    copy.wild!.despawnAtTick = world.tick + world.ticks(COPY_TTL_MS);
    if (copy.clean || copy.signature > 0) out.emit({ e: 'signatureSpawn', daemon: copy.id, species: copy.species, signature: copy.signature, clean: copy.clean }, { to: op.id });
  }
  out.emit({ ...publicState(world, inc, 'cleared'), bossId: null, participants }, { at: null });
  world.incident = null;
  world.incidentClosedAtMs = world.nowMs();
}

function expire(world: World, inc: IncidentState, out: Out): void {
  removeAdds(world, inc);
  world.removeDaemon(inc.bossId);
  out.emit({ ...publicState(world, inc, 'expired'), bossId: null }, { at: null });
  world.incident = null;
  world.incidentClosedAtMs = world.nowMs();
}

function telegraph(world: World, inc: IncidentState, boss: Daemon, out: Out): void {
  const tick = world.tick;
  if (inc.telegraph) {
    if (tick < inc.telegraph.atTick) return;
    const t = inc.telegraph;
    inc.telegraph = null;
    inc.nextTelegraphTick = tick + world.ticks(TELEGRAPH_EVERY_MS);
    for (const d of world.daemons.values()) {
      if (!d.ownerId || !d.active || d.hp <= 0 || distance(d, t) > t.radius) continue;
      const amount = Math.ceil(d.stats.hp * TELEGRAPH_DAMAGE);
      d.hp = Math.max(0, d.hp - amount);
      d.lastCombatTick = tick;
      out.emit({ e: 'hit', source: boss.id, target: d.id, move: 'telegraph', amount, multiplier: 1 }, { at: d });
    }
    // an operator caught in the blast is hit (as by a wild daemon): it loses its capture (packet loss) and its restore
    for (const op of world.operators.values()) {
      if (op.travelling || distance(op, t) > t.radius) continue;
      op.hitTick = tick;
      out.emit({ e: 'hit', source: boss.id, target: op.id, move: 'telegraph', amount: 0, multiplier: 1 }, { at: op });
    }
    return;
  }
  if (tick < inc.nextTelegraphTick) return;
  const targets = [...world.operators.values()].filter((op) => !op.travelling && distance(op, boss) <= TELEGRAPH_TARGET_RANGE);
  if (targets.length === 0) return;
  const target = world.rng.pick(targets);
  inc.telegraph = { x: target.x, y: target.y, radius: TELEGRAPH_RADIUS, atTick: tick + world.ticks(TELEGRAPH_DELAY_MS) };
  out.emit({ e: 'telegraph', ...inc.telegraph }, { at: null });
}

/**
 * After the window (and the copies' lifetime) nobody stays in kernelspace: a forced travel to backbone's spawn. It is an
 * ordinary `travel` intent (serialized with the checkpoints, waited for by a leave, skipped by checkpoints while in
 * flight); an operator with anything pending or a capture in progress (it settles or times out within the tool's
 * deadline) is left for a later tick, and a failed eviction is raised again after a grace period rather than every tick.
 */
function evictIdle(world: World, now: number, out: Out): void {
  if (now < world.incidentClosedAtMs + COPY_TTL_MS + EVICT_GRACE_MS) return;
  if (!world.hosted(EVICT_TO)) return;
  const dest = getSubnet(EVICT_TO);
  for (const op of world.operators.values()) {
    if (op.travelling || world.hasPendingFor(op.id)) continue;
    if (world.tick < (world.evictRetryTick.get(op.id) ?? 0)) continue;
    // A capture in progress (of a personal copy, say) is left to settle or time out first, as the copy's despawn is.
    if (op.captureId && world.captures.has(op.captureId)) continue;
    for (const id of [...op.running]) world.deactivate(world.daemons.get(id)!);
    op.travelling = true;
    op.path = [];
    op.restoreUntil = null;
    world.evictRetryTick.set(op.id, world.tick + world.ticks(EVICT_GRACE_MS));
    world.trackIntent(
      { id: world.newId('i'), kind: 'travel', operatorId: op.id, reqId: `evict-${world.tick}`, gatewayId: 'evict', from: world.subnet.id, to: dest.id, x: dest.spawn.x, y: dest.spawn.y },
      out,
    );
  }
}

/** Per tick, kernelspace only: schedule, phases, adds, telegraphs, clear / expire, eviction. */
export function stepIncident(world: World, out: Out): void {
  if (world.subnet.id !== INCIDENT_SUBNET) return;
  const now = world.nowMs();
  const inc = world.incident;
  if (!inc) {
    if (world.incidentRequested || now >= world.nextIncidentAt) open(world, now, out);
    else evictIdle(world, now, out);
    return;
  }
  const boss = world.daemons.get(inc.bossId);
  if (!boss || boss.hp <= 0) return clear(world, inc, out);
  if (now >= inc.endsAtMs) return expire(world, inc, out);
  if (inc.shield && inc.adds.every((id) => (world.daemons.get(id)?.hp ?? 0) <= 0)) {
    inc.shield = false;
    inc.adds = [];
    out.emit(publicState(world, inc, 'unshield'), { at: null });
  }
  const threshold = BOSS_PHASES[inc.nextPhase];
  if (!inc.shield && threshold !== undefined && boss.hp <= boss.stats.hp * threshold) {
    inc.shield = true;
    inc.nextPhase++;
    spawnAdds(world, inc, boss);
    out.emit(publicState(world, inc, 'shield'), { at: null });
  }
  if (inc.phase === 'fighting') telegraph(world, inc, boss, out);
}
