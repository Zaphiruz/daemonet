import { createPrisma, type Daemon as DaemonRow, type Prisma, type PrismaClient } from '@daemonet/db';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, stateFields as memStateFields, type IntentContext, type Store } from './store.js';

function toRecord(row: DaemonRow): OwnedDaemonRecord {
  return {
    id: row.id,
    species: row.species,
    level: row.level,
    xp: row.xp,
    nature: row.nature,
    traitSlot: row.traitSlot === 1 ? 1 : 0,
    ivs: row.ivs,
    bonus: row.bonus,
    clean: row.clean,
    signature: row.signature,
    hp: row.hp,
    energy: row.energy,
    moves: row.moves,
    crashed: row.crashed,
    slot: row.slot,
    heldItem: row.heldItem,
    patched: row.patched,
    moveTypeUses: row.moveTypeUses.length === 16 ? row.moveTypeUses : Array.from({ length: 16 }, (_, i) => row.moveTypeUses[i] ?? 0),
    crashes: row.crashes,
    arenaWins: row.arenaWins,
    history: historyOf(row),
    originalOperatorId: row.originalOperatorId,
  };
}

function historyOf(row: DaemonRow): HistoryEntry[] {
  return Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : [];
}

/** Prisma's Json input type has no room for plain interfaces; history entries are plain data. */
const json = (h: readonly HistoryEntry[]): Prisma.InputJsonValue => h as unknown as Prisma.InputJsonValue;

/** Everything a checkpoint (or store) writes back: the same fields as MemoryStore. */
function stateFields(d: OwnedDaemonRecord) {
  const fields = memStateFields(d);
  return { ...fields, history: json(fields.history) };
}

/** Columns for a new daemon row; the capture log (originalOperatorId…) comes from the intent's log. */
function createData(d: OwnedDaemonRecord, operatorId: string) {
  const { originalOperatorId: _o, history, ...rest } = d;
  return { ...rest, history: json(history), operatorId };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Name of the violated unique constraint/index. Prisma 7 + pg adapter reports it under meta.driverAdapterError. */
function violatedConstraint(err: unknown): string {
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: { constraint?: { index?: string }; originalMessage?: string } } | undefined)?.cause;
  const target = meta.target ?? meta.constraint;
  return [cause?.constraint?.index, cause?.originalMessage, Array.isArray(target) ? target.join(',') : target, (err as Error).message]
    .filter((x): x is string => typeof x === 'string')
    .join(' ');
}

/** Thrown inside a transaction to roll it back with a domain (non-retryable) reason. */
class DomainFailure extends Error {}

export class PrismaStore implements Store {
  constructor(readonly prisma: PrismaClient) {}

  static connect(databaseUrl: string): PrismaStore {
    return new PrismaStore(createPrisma(databaseUrl));
  }

  async createSeed(subnet: string) {
    for (;;) {
      const row = { id: randomHex(4), seed: randomHex(16), subnet };
      try {
        await this.prisma.subnetSeed.create({ data: row });
        return { id: row.id, seed: row.seed };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    const upsert = () =>
      this.prisma.operator.upsert({
        where: { sub },
        update: {},
        create: { sub, subnet, x: spawn.x, y: spawn.y },
        include: { daemons: { orderBy: { slot: 'asc' } } },
      });
    let op: Awaited<ReturnType<typeof upsert>>;
    try {
      op = await upsert();
    } catch (err) {
      // Two simultaneous first logins for one sub: the other insert won, so the retry finds its row.
      if (!isUniqueViolation(err) || !/Operator_sub_key|\(`sub`\)/.test(violatedConstraint(err))) throw err;
      op = await upsert();
    }
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: Number(op.bits),
      inventory: (op.inventory ?? {}) as Record<string, number>,
      ram: op.daemons.filter((d) => d.location === 'RAM').map(toRecord),
      diskSlots: op.daemons.filter((d) => d.location === 'DISK').map((d) => d.slot),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.replayed(tx, intent);
        if (replay) return replay;
        await tx.appliedAction.create({ data: { key: intent.id, kind: intent.kind } });
        const now = new Date();
        switch (intent.kind) {
          case 'claimStarter': {
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: { name: intent.name, starterClaimed: true, inventory: intent.inventory },
            });
            const d = intent.daemon;
            await tx.daemon.create({
              data: {
                ...createData(d, intent.operatorId),
                location: 'RAM',
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'capture': {
            const d = intent.daemon;
            await tx.daemon.create({
              data: {
                ...createData(d, intent.operatorId),
                location: intent.location,
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'store': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'RAM' },
              data: { ...(ctx.storedDaemon ? stateFields(ctx.storedDaemon) : {}), location: 'DISK', slot: intent.diskSlot },
            });
            if (res.count !== 1) throw new DomainFailure('daemon not found');
            return { ok: true } as const;
          }
          case 'load': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'DISK' },
              data: { location: 'RAM', slot: intent.ramSlot },
            });
            if (res.count !== 1) throw new DomainFailure('not on Disk');
            const row = await tx.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
            return { ok: true, daemon: toRecord(row) } as const;
          }
          case 'evolve': {
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM' || row.species !== intent.from) throw new DomainFailure('daemon not found');
            const res = await tx.daemon.updateMany({
              // Guarded on the species read above, so a concurrent writer cannot be overwritten.
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'RAM', species: intent.from },
              data: {
                species: intent.to,
                ivs: intent.ivs,
                bonus: intent.bonus,
                clean: intent.clean,
                signature: intent.signature,
                heldItem: intent.heldItem,
                moves: intent.moves,
                hp: intent.hp,
                history: json([...historyOf(row), ...intent.history]),
              },
            });
            if (res.count !== 1) throw new DomainFailure('daemon not found');
            // ON CONFLICT DO NOTHING: a concurrent first evolution into the same form waits for ours and inserts
            // nothing (count 0 = not the discoverer); it never raises a Discovery P2002.
            const first = await tx.discovery.createMany({ data: [{ formId: intent.to, operatorId: intent.operatorId }], skipDuplicates: true });
            return { ok: true, discovered: first.count === 1 } as const;
          }
        }
      });
    } catch (err) {
      if (err instanceof DomainFailure) return { ok: false, reason: err.message };
      if (isUniqueViolation(err)) {
        const violated = violatedConstraint(err);
        // Same intent applied concurrently: the other transaction committed it, so answer from its marker.
        if (violated.includes('AppliedAction')) {
          const replay = await this.replayed(this.prisma, intent);
          if (replay) return replay;
        }
        if (intent.kind === 'claimStarter' && violated.includes('Operator_name_key')) return { ok: false, reason: 'name taken' };
      }
      throw err;
    }
  }

  /** The stored result when this intent was already applied, else null. */
  private async replayed(db: Pick<PrismaClient, 'appliedAction' | 'daemon'>, intent: Intent): Promise<IntentResult | null> {
    const done = await db.appliedAction.findUnique({ where: { key: intent.id } });
    if (!done) return null;
    if (intent.kind !== 'load') return { ok: true };
    const row = await db.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
    return { ok: true, daemon: toRecord(row) };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const rec of records) {
        await tx.operator.update({
          where: { id: rec.id },
          data: { x: rec.x, y: rec.y, bits: BigInt(rec.bits), inventory: rec.inventory, lastSeenAt: now },
        });
        for (const d of rec.ram) {
          // `species` guard: a record taken before an evolve committed must not roll the evolved row back.
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id, location: 'RAM', species: d.species }, data: stateFields(d) });
        }
      }
    });
  }

  async listDiscoveries(): Promise<string[]> {
    const rows = await this.prisma.discovery.findMany({ select: { formId: true }, orderBy: { discoveredAt: 'asc' } });
    return rows.map((r) => r.formId);
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
