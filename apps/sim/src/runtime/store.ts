import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';

export interface IntentContext {
  seedId: string;
  /** For `store`: the daemon's current state, written along with the move to Disk. */
  storedDaemon?: OwnedDaemonRecord;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord>;
  /** Idempotent by intent.id. Domain failures (name taken, not on Disk) resolve with ok: false. */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  /** Form ids with a Discovery row (loaded once at boot into World.discovered). */
  listDiscoveries(): Promise<string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Everything a checkpoint (or store) writes back; identity, species and capture-log fields never change here. */
export function stateFields(d: OwnedDaemonRecord) {
  return {
    level: d.level, xp: d.xp, hp: d.hp, energy: d.energy, moves: [...d.moves], crashed: d.crashed,
    ivs: [...d.ivs], patched: d.patched, heldItem: d.heldItem, moveTypeUses: [...d.moveTypeUses], crashes: d.crashes, history: d.history.map((h) => ({ ...h })),
  };
}

interface MemDaemon extends OwnedDaemonRecord {
  operatorId: string;
  location: 'RAM' | 'DISK';
}

interface MemOperator {
  id: string;
  sub: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  x: number;
  y: number;
  inventory: Record<string, number>;
}

/** In-memory Store with the same semantics as PrismaStore. Used by tests and local development. */
export class MemoryStore implements Store {
  readonly operators = new Map<string, MemOperator>();
  readonly daemons = new Map<string, MemDaemon>();
  readonly applied = new Set<string>();
  readonly seeds: Array<{ id: string; seed: string; subnet: string }> = [];
  readonly discoveries = new Map<string, { operatorId: string; discoveredAt: string }>();
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, _subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, bits: 0, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: op.bits,
      inventory: { ...op.inventory },
      ram: mine.filter((d) => d.location === 'RAM').sort((a, b) => a.slot - b.slot).map(({ operatorId: _o, location: _l, ...rec }) => ({ ...rec })),
      diskSlots: mine.filter((d) => d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated store failure');
    }
    if (this.applied.has(intent.id)) {
      if (intent.kind === 'load') {
        const d = this.daemons.get(intent.daemonId)!;
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      return { ok: true };
    }
    const op = this.operators.get(intent.operatorId);
    if (!op) throw new Error(`unknown operator ${intent.operatorId}`);
    switch (intent.kind) {
      case 'claimStarter': {
        if ([...this.operators.values()].some((o) => o.name === intent.name && o.id !== op.id)) return { ok: false, reason: 'name taken' };
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: 'RAM' });
        break;
      }
      case 'capture':
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: intent.location });
        break;
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM') return { ok: false, reason: 'daemon not found' };
        Object.assign(d, ctx.storedDaemon ? stateFields(ctx.storedDaemon) : {}, { location: 'DISK', slot: intent.diskSlot });
        break;
      }
      case 'load': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'DISK') return { ok: false, reason: 'not on Disk' };
        d.location = 'RAM';
        d.slot = intent.ramSlot;
        this.applied.add(intent.id);
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      case 'evolve': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM' || d.species !== intent.from) return { ok: false, reason: 'daemon not found' };
        Object.assign(d, {
          species: intent.to,
          ivs: [...intent.ivs],
          bonus: [...intent.bonus],
          clean: intent.clean,
          signature: intent.signature,
          heldItem: intent.heldItem,
          moves: [...intent.moves],
          hp: intent.hp,
          history: [...d.history, ...intent.history],
        });
        let discovered = false;
        if (!this.discoveries.has(intent.to)) {
          this.discoveries.set(intent.to, { operatorId: op.id, discoveredAt: new Date().toISOString() });
          discovered = true;
        }
        this.applied.add(intent.id);
        return { ok: true, discovered };
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      Object.assign(op, { x: rec.x, y: rec.y, bits: rec.bits, inventory: { ...rec.inventory } });
      for (const d of rec.ram) {
        const row = this.daemons.get(d.id);
        // A record taken before an evolve committed (other species) must not roll the evolved row back.
        if (row && row.operatorId === op.id && row.location === 'RAM' && row.species === d.species) Object.assign(row, stateFields(d));
      }
    }
  }

  async listDiscoveries(): Promise<string[]> {
    return [...this.discoveries.keys()];
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
