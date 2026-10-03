import { createPrisma, type Daemon as DaemonRow, type PrismaClient } from '@daemonet/db';
import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type IntentContext, type Store } from './store.js';

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
  };
}

function stateFields(d: OwnedDaemonRecord) {
  return { level: d.level, xp: d.xp, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed };
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
  constructor(private readonly prisma: PrismaClient) {}

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
    const op = await this.prisma.operator.upsert({
      where: { sub },
      update: {},
      create: { sub, subnet, x: spawn.x, y: spawn.y },
      include: { daemons: { orderBy: { slot: 'asc' } } },
    });
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
                ...d,
                operatorId: intent.operatorId,
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
                ...d,
                operatorId: intent.operatorId,
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
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id, location: 'RAM' }, data: stateFields(d) });
        }
      }
    });
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
