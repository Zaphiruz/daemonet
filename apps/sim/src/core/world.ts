import {
  DEFAULT_ODDS,
  RAM_SLOTS,
  emptyMoveTypeUses,
  computeStats,
  createRng,
  getSpecies,
  msToTicks,
  movesAtLevel,
  statBlockFromArray,
  statBlockToArray,
  xpForLevel,
  type Rng,
  type SpawnOdds,
  type SpawnRoll,
  type SubnetDef,
} from '@daemonet/rules';
import { Grid, type Point } from './grid.js';
import { freshEngagement, type Capture, type Daemon, type Input, type Intent, type IntentResult, type Operator, type OperatorRecord, type OwnedDaemonRecord, type StepResult } from './model.js';
import { Out } from './out.js';
import { planWild } from './systems/ai.js';
import { executeQueuedUses, type QueuedUse } from './systems/combat.js';
import { handleCommands } from './systems/commands.js';
import { completeCaptureIntent, progressCaptures } from './systems/capture.js';
import { completeEvolveIntent } from './systems/evolve.js';
import { moveAll } from './systems/movement.js';
import { resolveDefeats } from './systems/progress.js';
import { runSpawner } from './systems/spawner.js';
import { upkeep } from './systems/upkeep.js';
import { toRamDaemon } from './view.js';

export interface WorldOptions {
  subnet: SubnetDef;
  /** Seeds the world RNG. */
  seed: string;
  /** Short id of this seed row (SubnetSeed.id); prefixes generated ids. */
  seedId: string;
  /** Run the wild spawner (default true). Tests turn it off and place wilds by hand. */
  spawner?: boolean;
  /** Spawn odds (tests only). */
  odds?: SpawnOdds;
  /** Form ids already discovered server-wide (loaded from the store at boot). */
  discovered?: Iterable<string>;
  /** Wall-clock ISO timestamp for history entries (tests inject a fixed one). */
  clock?: () => string;
}

export class World {
  readonly subnet: SubnetDef;
  readonly grid: Grid;
  readonly rng: Rng;
  readonly seedId: string;
  readonly odds: SpawnOdds;
  readonly spawnerEnabled: boolean;
  tick = 0;
  spawnIndex = 0;
  readonly operators = new Map<string, Operator>();
  /** Wild daemons and the RAM daemons of connected operators. */
  readonly daemons = new Map<string, Daemon>();
  readonly captures = new Map<string, Capture>();
  readonly regionCounts: number[];
  readonly nextSpawnTick: number[];
  /** Evolution forms whose first evolution has been recorded (hidden requirements are revealed). */
  readonly discovered: Set<string>;
  readonly now: () => string;
  queuedUses: QueuedUse[] = [];
  private readonly pending = new Map<string, Intent>();
  private counter = 0;
  private carry = new Out();

  constructor(opts: WorldOptions) {
    this.subnet = opts.subnet;
    this.grid = new Grid(opts.subnet);
    this.rng = createRng(opts.seed);
    this.seedId = opts.seedId.slice(0, 8);
    this.odds = opts.odds ?? DEFAULT_ODDS;
    this.spawnerEnabled = opts.spawner ?? true;
    this.regionCounts = opts.subnet.regions.map(() => 0);
    this.nextSpawnTick = opts.subnet.regions.map(() => 0);
    this.discovered = new Set(opts.discovered ?? []);
    this.now = opts.clock ?? (() => new Date().toISOString());
    if (this.spawnerEnabled) runSpawner(this, this.carry, true);
  }

  newId(prefix: string): string {
    return `${this.seedId}-${prefix}${++this.counter}`;
  }

  ticks(ms: number): number {
    return msToTicks(ms);
  }

  // ---- operators ----

  addOperator(rec: OperatorRecord): Operator {
    const pos = this.grid.isWalkablePoint(rec) ? { x: rec.x, y: rec.y } : { ...this.subnet.spawn };
    const op: Operator = {
      id: rec.id,
      name: rec.name,
      starterClaimed: rec.starterClaimed,
      x: pos.x,
      y: pos.y,
      path: [],
      bits: rec.bits,
      inventory: { ...rec.inventory },
      ram: [],
      running: [],
      diskSlots: new Set(rec.diskSlots),
      reservedSlots: new Set(),
      swapReadyTick: 0,
      captureId: null,
      restoreUntil: null,
      hitTick: -1,
      pendingClaim: false,
    };
    this.operators.set(op.id, op);
    for (const d of [...rec.ram].sort((a, b) => a.slot - b.slot)) this.addOwned(op, d);
    return op;
  }

  removeOperator(id: string): void {
    const op = this.operators.get(id);
    if (!op) return;
    if (op.captureId) this.captures.delete(op.captureId);
    for (const d of op.ram) this.daemons.delete(d);
    this.operators.delete(id);
  }

  checkpoint(operatorId: string): OperatorRecord {
    const op = this.operators.get(operatorId);
    if (!op) throw new RangeError(`unknown operator ${operatorId}`);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: op.bits,
      inventory: { ...op.inventory },
      ram: op.ram.map((id) => this.toRecord(this.daemons.get(id)!)),
      diskSlots: [...op.diskSlots].sort((a, b) => a - b),
    };
  }

  // ---- daemons ----

  private makeDaemon(species: string, level: number, fields: Omit<Daemon, 'species' | 'types' | 'level' | 'stats' | 'trait' | 'engagement'>): Daemon {
    const sp = getSpecies(species);
    const stats = computeStats({ base: sp.base, ivs: fields.ivs, bonus: fields.bonus, level, nature: fields.nature });
    return { ...fields, species, types: sp.types, level, stats, trait: sp.traits[fields.traitSlot], engagement: freshEngagement() };
  }

  addOwned(op: Operator, rec: OwnedDaemonRecord): Daemon {
    const d = this.makeDaemon(rec.species, rec.level, {
      id: rec.id,
      xp: rec.xp,
      nature: rec.nature,
      traitSlot: rec.traitSlot,
      ivs: statBlockFromArray(rec.ivs),
      bonus: statBlockFromArray(rec.bonus),
      clean: rec.clean,
      signature: rec.signature,
      moves: [...rec.moves],
      hp: rec.hp,
      energy: rec.energy,
      crashed: rec.crashed,
      ownerId: op.id,
      slot: rec.slot,
      active: false,
      x: op.x,
      y: op.y,
      path: [],
      cooldowns: {},
      statuses: {},
      lastCombatTick: -Infinity,
      pending: false,
      wild: null,
      heldItem: rec.heldItem,
      patched: rec.patched,
      moveTypeUses: [...rec.moveTypeUses],
      crashes: rec.crashes,
      arenaWins: rec.arenaWins,
      history: rec.history.map((h) => ({ ...h })),
      originalOperatorId: rec.originalOperatorId,
    });
    this.daemons.set(d.id, d);
    op.ram.push(d.id);
    return d;
  }

  /** True when `op` already holds daemon `id` in RAM (e.g. reloaded from the DB after the intent committed). */
  ownsDaemon(op: Operator, id: string): boolean {
    return this.daemons.get(id)?.ownerId === op.id && op.ram.includes(id);
  }

  toRecord(d: Daemon): OwnedDaemonRecord {
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
      hp: Math.max(0, Math.floor(d.hp)),
      energy: Math.floor(d.energy),
      moves: [...d.moves],
      crashed: d.crashed,
      slot: d.slot,
      heldItem: d.heldItem,
      patched: d.patched,
      moveTypeUses: [...d.moveTypeUses],
      crashes: d.crashes,
      arenaWins: d.arenaWins,
      history: d.history.map((h) => ({ ...h })),
      originalOperatorId: d.originalOperatorId,
    };
  }

  /** Place a wild daemon. `region` -1 = not owned by any spawn region (tests). */
  spawnWild(species: string, level: number, pos: Point, region: number, roll: SpawnRoll): Daemon {
    const sp = getSpecies(species);
    const d = this.makeDaemon(species, level, {
      id: this.newId('w'),
      xp: xpForLevel(level),
      nature: roll.nature,
      traitSlot: roll.traitSlot,
      ivs: roll.ivs,
      bonus: roll.bonus,
      clean: roll.clean,
      signature: roll.signature,
      moves: movesAtLevel(sp, level),
      hp: 0,
      energy: 128,
      crashed: false,
      ownerId: null,
      slot: -1,
      active: true,
      x: pos.x,
      y: pos.y,
      path: [],
      cooldowns: {},
      statuses: {},
      lastCombatTick: -Infinity,
      pending: false,
      heldItem: null,
      patched: false,
      moveTypeUses: emptyMoveTypeUses(),
      crashes: 0,
      arenaWins: 0,
      history: [],
      originalOperatorId: null,
      wild: {
        behaviour: sp.behaviour,
        region,
        spawnIndex: this.spawnIndex++,
        tagOwner: null,
        tagUntil: 0,
        hardenedUntil: 0,
        aggro: null,
        fleeUntil: 0,
        damagedBy: new Set(),
      },
    });
    d.hp = d.stats.hp;
    this.daemons.set(d.id, d);
    if (region >= 0) this.regionCounts[region]!++;
    return d;
  }

  removeDaemon(id: string): void {
    const d = this.daemons.get(id);
    if (!d) return;
    this.daemons.delete(id);
    if (d.wild && d.wild.region >= 0) this.regionCounts[d.wild.region]!--;
    if (d.ownerId) {
      const op = this.operators.get(d.ownerId);
      if (op) {
        op.ram = op.ram.filter((x) => x !== id);
        op.running = op.running.filter((x) => x !== id);
      }
    }
  }

  activate(d: Daemon, op: Operator): void {
    d.active = true;
    d.engagement = freshEngagement();
    d.x = op.x;
    d.y = op.y;
    d.path = [];
    op.running.push(d.id);
  }

  deactivate(d: Daemon): void {
    d.active = false;
    d.path = [];
    const op = d.ownerId ? this.operators.get(d.ownerId) : undefined;
    if (op) op.running = op.running.filter((x) => x !== d.id);
  }

  freeRamSlot(op: Operator): number | null {
    const used = new Set([...op.ram.map((id) => this.daemons.get(id)!.slot), ...op.reservedSlots]);
    for (let s = 0; s < RAM_SLOTS; s++) if (!used.has(s)) return s;
    return null;
  }

  /** Resolves an entity id to a position (daemon or operator). */
  locate(id: string): Point | null {
    const d = this.daemons.get(id);
    if (d) return d.active ? d : null;
    return this.operators.get(id) ?? null;
  }

  // ---- intents ----

  trackIntent(intent: Intent, out: Out): void {
    this.pending.set(intent.id, intent);
    out.intent(intent);
  }

  completeIntent(id: string, result: IntentResult): void {
    const intent = this.pending.get(id);
    if (!intent) throw new RangeError(`unknown intent ${id}`);
    this.pending.delete(id);
    const out = this.carry;
    const op = this.operators.get(intent.operatorId);
    // An evolve still records its discovery when the operator has left meanwhile.
    if (intent.kind === 'evolve') return completeEvolveIntent(this, op, intent, result, out);
    if (!op) return;
    switch (intent.kind) {
      case 'claimStarter': {
        op.pendingClaim = false;
        if (!result.ok) return out.fail(intent, 'E_STATE', result.reason);
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        if (!this.ownsDaemon(op, intent.daemon.id)) this.addOwned(op, intent.daemon);
        return out.ok(intent, { daemonId: intent.daemon.id });
      }
      case 'capture':
        return completeCaptureIntent(this, op, intent, result, out);
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!result.ok) {
          if (d) d.pending = false;
          op.diskSlots.delete(intent.diskSlot);
          return out.fail(intent, 'E_STATE', result.reason);
        }
        this.removeDaemon(intent.daemonId);
        return out.ok(intent);
      }
      case 'load': {
        op.reservedSlots.delete(intent.ramSlot);
        if (!result.ok || !result.daemon) return out.fail(intent, 'E_STATE', result.ok ? 'missing daemon' : result.reason);
        const rec = { ...result.daemon, slot: intent.ramSlot };
        if (!this.ownsDaemon(op, rec.id)) this.addOwned(op, rec);
        return out.ok(intent, { daemon: toRamDaemon(this, this.daemons.get(rec.id)!) });
      }
    }
  }

  // ---- the tick ----

  step(inputs: readonly Input[]): StepResult {
    this.tick++;
    const out = this.carry;
    this.carry = new Out();
    handleCommands(this, inputs, out);
    moveAll(this);
    const wildUses = planWild(this);
    executeQueuedUses(this, [...this.queuedUses, ...wildUses], out);
    this.queuedUses = [];
    resolveDefeats(this, out);
    progressCaptures(this, out);
    if (this.spawnerEnabled) runSpawner(this, out, false);
    upkeep(this, out);
    return { tick: this.tick, events: out.events, replies: out.replies, intents: out.intents };
  }
}
