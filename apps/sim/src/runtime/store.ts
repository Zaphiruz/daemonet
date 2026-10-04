import { DISK_BASE, DISK_EXPANSION_ITEM, DISK_STEP, decompileYield, diskExpansionPrice, fragmentId, getRecipe, getSpecies, recipeFragments } from '@daemonet/rules';
import type { EconomyIntent, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { shopPrice } from '../core/systems/economy.js';

export interface IntentContext {
  seedId: string;
  /** For `store` / `decompile`: the daemon's current state, written along with the move to Disk (or the archive). */
  storedDaemon?: OwnedDaemonRecord;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord>;
  /** Idempotent by intent.id. Domain failures (name taken, not on Disk) resolve with ok: false. */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  /**
   * Writes position, inventory and RAM daemon state. Never writes `bits` or `diskCapacity` (only intents and
   * `grantBits` change those, with a ledger row) and skips `inventory` on records marked `inventoryInFlight`.
   */
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  /** Form ids with a Discovery row (loaded once at boot into World.discovered). */
  listDiscoveries(): Promise<string[]>;
  /**
   * Credits (or, with a negative delta, debits) bits outside the sim's intents (admin grants, dev seeding, ticket
   * payouts) with a ledger row in the same transaction. Throws on a non-integer or zero delta, an unknown operator, or
   * a debit larger than the balance. A connected operator's world sees the new balance on its next connection.
   */
  grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void>;
  /** The operator's most recent `limit` ledger rows, oldest first. */
  ledgerFor(operatorId: string, limit?: number): Promise<LedgerRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface LedgerRow {
  operatorId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}

/** Ledger reason of a bits-spending intent. */
export function ledgerReason(intent: Extract<EconomyIntent, { kind: 'buy' | 'craft' }>): 'shop' | 'disk' | 'craft' {
  if (intent.kind === 'craft') return 'craft';
  return intent.itemId === DISK_EXPANSION_ITEM ? 'disk' : 'shop';
}

/**
 * Domain check shared by both stores: what an economy intent costs must match the rules, so a world bug or a forged
 * intent can never mint bits or items. Returns the failure reason, or null when the intent is well-formed.
 * `diskCapacity` is the operator's committed capacity (Disk expansions are priced on it).
 */
export function economyIntentProblem(intent: EconomyIntent, diskCapacity: number): string | null {
  const count = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
  switch (intent.kind) {
    case 'buy': {
      if (!count(intent.qty, 1) || !count(intent.price, 0)) return 'invalid purchase';
      if (intent.itemId === DISK_EXPANSION_ITEM) {
        const price = diskExpansionPrice(diskCapacity);
        if (price === null) return 'Disk is already at its maximum';
        return intent.qty === 1 && intent.price === price ? null : 'price changed';
      }
      const unit = shopPrice(intent.itemId);
      if (unit === undefined) return 'not for sale';
      return intent.price === unit * intent.qty ? null : 'price changed';
    }
    case 'craft': {
      let ok = count(intent.qty, 1) && count(intent.bits, 0) && count(intent.output.qty, 1);
      try {
        const r = getRecipe(intent.recipeId);
        ok &&= intent.bits === r.bits * intent.qty && intent.output.item === r.output.item && intent.output.qty === r.output.qty * intent.qty;
        ok &&= sameCounts(intent.fragments, recipeFragments(r, intent.qty, intent.using) as Record<string, number>);
      } catch {
        ok = false;
      }
      return ok ? null : 'invalid recipe';
    }
    case 'decompile':
      // Checked against the daemon row by `decompileProblem` once the store has it.
      return null;
  }
}

/** True when both maps hold exactly the same item counts. */
export function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/**
 * The state a decompile archives and the check of its fragments. `row` is the stored daemon (already matched on id,
 * owner, location and species); `latest` is the world's current record of it (`IntentContext.storedDaemon`), which
 * may be ahead of the last checkpoint (levels, a held item). The fragments must be exactly the rules' yield for the
 * species at that level, plus the held item.
 */
export function decompileProblem(
  intent: Extract<EconomyIntent, { kind: 'decompile' }>,
  row: Pick<OwnedDaemonRecord, 'species' | 'level' | 'heldItem'>,
  latest: OwnedDaemonRecord | undefined,
): string | null {
  if (latest && (latest.id !== intent.daemonId || latest.species !== row.species || latest.level < row.level)) return 'invalid decompile';
  const level = latest?.level ?? row.level;
  const heldItem = latest ? latest.heldItem : row.heldItem;
  let sp;
  try {
    sp = getSpecies(row.species);
  } catch {
    return 'invalid decompile';
  }
  const expected: Record<string, number> = {};
  for (const t of sp.types) expected[fragmentId(t)] = decompileYield(sp.stage, level);
  if (heldItem) expected[heldItem] = (expected[heldItem] ?? 0) + 1;
  return sameCounts(intent.fragments, expected) ? null : 'invalid decompile';
}

/** Copy of `inv` with `items` added (sign 1) or removed (sign -1); counts that reach 0 are dropped. */
export function withItems(inv: Readonly<Record<string, number>>, items: Readonly<Record<string, number>>, sign: 1 | -1): Record<string, number> {
  const next = { ...inv };
  for (const [id, n] of Object.entries(items)) {
    const left = (next[id] ?? 0) + sign * n;
    if (left <= 0) delete next[id];
    else next[id] = left;
  }
  return next;
}

/** First item of `items` the inventory has too few of, or null. */
export function missingItem(inv: Readonly<Record<string, number>>, items: Readonly<Record<string, number>>): string | null {
  for (const [id, n] of Object.entries(items)) if ((inv[id] ?? 0) < n) return id;
  return null;
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
  diskCapacity: number;
  subnet: string;
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
  readonly ledger: LedgerRow[] = [];
  readonly archive = new Map<string, MemDaemon & { reason: string; archivedAt: string }>();
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, bits: 0, diskCapacity: DISK_BASE, subnet, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: op.bits,
      diskCapacity: op.diskCapacity,
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
        if (this.slotTaken(op.id, 'RAM', intent.daemon.slot)) return { ok: false, reason: 'starter already claimed' };
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: 'RAM' });
        break;
      }
      case 'capture':
        // Mirrors the Daemon (operatorId, location, slot) unique constraint.
        if (this.slotTaken(op.id, intent.location, intent.daemon.slot)) return { ok: false, reason: 'slot taken' };
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
      case 'travel':
        Object.assign(op, { subnet: intent.to, x: intent.x, y: intent.y });
        break;
      case 'buy': {
        const problem = economyIntentProblem(intent, op.diskCapacity);
        if (problem) return { ok: false, reason: problem };
        if (op.bits < intent.price) return { ok: false, reason: 'not enough bits' };
        op.bits -= intent.price;
        if (intent.itemId === DISK_EXPANSION_ITEM) op.diskCapacity += DISK_STEP;
        else op.inventory = withItems(op.inventory, { [intent.itemId]: intent.qty }, 1);
        this.ledger.push({ operatorId: op.id, delta: -intent.price, reason: ledgerReason(intent), ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'craft': {
        const problem = economyIntentProblem(intent, op.diskCapacity);
        if (problem) return { ok: false, reason: problem };
        if (op.bits < intent.bits) return { ok: false, reason: 'not enough bits' };
        const missing = missingItem(op.inventory, intent.fragments);
        if (missing) return { ok: false, reason: `not enough ${missing}` };
        op.bits -= intent.bits;
        op.inventory = withItems(withItems(op.inventory, intent.fragments, -1), { [intent.output.item]: intent.output.qty }, 1);
        this.ledger.push({ operatorId: op.id, delta: -intent.bits, reason: ledgerReason(intent), ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'decompile': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM' || d.species !== intent.species) return { ok: false, reason: 'daemon not found' };
        const problem = decompileProblem(intent, d, ctx.storedDaemon);
        if (problem) return { ok: false, reason: problem };
        const state = ctx.storedDaemon ? stateFields(ctx.storedDaemon) : stateFields(d);
        this.daemons.delete(d.id);
        this.archive.set(d.id, { ...d, ...state, history: [...state.history, intent.history], reason: 'decompiled', archivedAt: new Date().toISOString() });
        op.inventory = withItems(op.inventory, intent.fragments, 1);
        break;
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  private slotTaken(operatorId: string, location: 'RAM' | 'DISK', slot: number): boolean {
    for (const d of this.daemons.values()) if (d.operatorId === operatorId && d.location === location && d.slot === slot) return true;
    return false;
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      // bits / diskCapacity move only through intents (the ledger); an inventory an intent is rewriting is left to it.
      Object.assign(op, { subnet: rec.subnet, x: rec.x, y: rec.y }, rec.inventoryInFlight ? {} : { inventory: { ...rec.inventory } });
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

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void> {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new RangeError(`invalid bits delta ${delta}`);
    const op = this.operators.get(operatorId);
    if (!op) throw new Error(`unknown operator ${operatorId}`);
    if (op.bits + delta < 0) throw new RangeError('not enough bits');
    op.bits += delta;
    this.ledger.push({ operatorId, delta, reason, ref: ref ?? null, at: new Date().toISOString() });
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    return this.ledger
      .filter((l) => l.operatorId === operatorId)
      .slice(-limit)
      .map((l) => ({ ...l }));
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
