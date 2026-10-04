import { createPrisma, type Daemon as DaemonRow, type Prisma, type PrismaClient } from '@daemonet/db';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OrgView, OwnedDaemonRecord, Point } from '../core/index.js';
import { DISK_EXPANSION_ITEM, DISK_STEP, dayKey, getSpecies, type FilterTerm, type TicketKind, type TicketParams } from '@daemonet/rules';
import {
  assertGrantReason,
  checkpointFields,
  intentLedgerReason,
  decompileProblem,
  decompileStoreGain,
  economyIntentProblem,
  INCIDENT_RECOVERY_MS,
  incidentRewardIntent,
  incidentRewardProblem,
  ledgerReason,
  participantsOf,
  missingItem,
  randomHex,
  samePayouts,
  SIM_LEDGER_REASONS,
  stateFields as memStateFields,
  ticketAcceptProblem,
  ticketCapProblem,
  ticketState,
  withItems,
  type ChatRow,
  type IncidentRewardIntent,
  type IncidentRow,
  type IntentContext,
  type LedgerRow,
  type LedgerWrite,
  type LiveOperatorState,
  type LoadedOperator,
  type SimLedgerKind,
  type SimLedgerReason,
  type Store,
} from './store.js';

type OrgMemberWithOrg = { rank: OrgView['rank']; org: { id: string; name: string; tag: string } };

const orgView = (m: OrgMemberWithOrg | null | undefined): OrgView | null => (m ? { id: m.org.id, name: m.org.name, tag: m.org.tag, rank: m.rank } : null);

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

type Tx = Prisma.TransactionClient;

const jsonParams = (p: TicketParams): Prisma.InputJsonValue => p as unknown as Prisma.InputJsonValue;
const jsonParticipants = (p: IncidentRow['participants']): Prisma.InputJsonValue => p as unknown as Prisma.InputJsonValue;

/** Seq of the operator's `incident` ledger row for this Incident, or null when it was not paid. */
async function incidentLedgerSeq(db: Pick<PrismaClient, 'bitsLedger'>, operatorId: string, incidentId: string): Promise<number | null> {
  const row = await db.bitsLedger.findFirst({ where: { operatorId, reason: 'incident', ref: incidentId }, select: { seq: true } });
  return row ? Number(row.seq) : null;
}

/**
 * One Codex research point for the daemon's line, as INSERT ... ON CONFLICT DO UPDATE (never a Research_pkey P2002, even
 * for concurrent captures of one line); returns the line's new total.
 */
async function addResearch(tx: Tx, operatorId: string, species: string): Promise<number> {
  const line = getSpecies(species).line;
  const rows = await tx.$queryRaw<Array<{ points: number }>>`
    INSERT INTO "Research" ("operatorId", "line", "points") VALUES (${operatorId}, ${line}, 1)
    ON CONFLICT ("operatorId", "line") DO UPDATE SET "points" = "Research"."points" + 1
    RETURNING "points"`;
  return Number(rows[0]!.points);
}

/**
 * Locks the operator row (FOR NO KEY UPDATE: it never changes the key, so foreign-key checks are not blocked) for the
 * rest of the transaction and returns its economy columns. Every economy intent takes
 * this lock first, so two of them for one operator (or one racing a checkpoint's update of the row) run one after the
 * other: the balance check, the decrement and the inventory rewrite see each other's committed result.
 */
async function lockOperator(tx: Tx, id: string): Promise<{ bits: bigint; diskCapacity: number; inventory: Record<string, number> }> {
  const rows = await tx.$queryRaw<Array<{ bits: bigint; diskCapacity: number; inventory: unknown }>>`
    SELECT "bits", "diskCapacity", "inventory" FROM "Operator" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) throw new Error(`unknown operator ${id}`);
  const inventory = row.inventory && typeof row.inventory === 'object' && !Array.isArray(row.inventory) ? (row.inventory as Record<string, number>) : {};
  return { bits: BigInt(row.bits), diskCapacity: Number(row.diskCapacity), inventory };
}

/**
 * Inserts the ledger row of a store intent. The only way `applyIntent` writes BitsLedger: the reason is typed and
 * checked against SIM_INTENT_LEDGER_REASONS for the intent's kind. Call it only after `lockOperator` (seq order =
 * commit order, see `LedgerWrite.seq`).
 */
async function intentLedgerRow<K extends SimLedgerKind>(tx: Tx, kind: K, operatorId: string, delta: number, reason: SimLedgerReason<K>, ref: string): Promise<void> {
  await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason: intentLedgerReason(kind, reason), ref } });
}

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

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<LoadedOperator> {
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
    const day = dayKey(new Date().toISOString());
    const [tickets, research, member, economy] = await Promise.all([
      this.prisma.ticket.findMany({ where: { operatorId: op.id, OR: [{ status: 'OPEN' }, { day }] }, orderBy: { acceptedAt: 'asc' } }),
      this.prisma.research.findMany({ where: { operatorId: op.id } }),
      this.prisma.orgMember.findUnique({ where: { operatorId: op.id }, include: { org: true } }),
      // One statement, so one snapshot: the balance reflects exactly the ledger rows up to `seq` (the watermark above
      // which pushed or resynced rows are applied as deltas).
      this.prisma.$queryRaw<Array<{ bits: bigint; seq: bigint | null }>>`
        SELECT o."bits", (SELECT max(l."seq") FROM "BitsLedger" l WHERE l."operatorId" = o."id") AS "seq"
        FROM "Operator" o WHERE o."id" = ${op.id}`,
    ]);
    const econ = economy[0] ?? { bits: op.bits, seq: null };
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: Number(econ.bits),
      diskCapacity: op.diskCapacity,
      inventory: (op.inventory ?? {}) as Record<string, number>,
      ram: op.daemons.filter((d) => d.location === 'RAM').map(toRecord),
      diskSlots: op.daemons.filter((d) => d.location === 'DISK').map((d) => d.slot),
      ...ticketState(
        tickets.map((t) => ({ ...t, kind: t.kind as TicketKind, params: t.params as unknown as TicketParams })),
        day,
      ),
      research: Object.fromEntries(research.map((r) => [String(r.line), r.points])),
      mutedUntil: op.mutedUntil ? op.mutedUntil.toISOString() : null,
      org: orgView(member),
      ledgerSeq: econ.seq === null ? 0 : Number(econ.seq),
    };
  }

  async liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>> {
    const ids = [...after.keys()];
    if (ids.length === 0) return new Map();
    const [ops, members, rows] = await Promise.all([
      this.prisma.operator.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      this.prisma.orgMember.findMany({ where: { operatorId: { in: ids } }, include: { org: true } }),
      // One statement: per operator, every row above the watermark that has committed (seq order = commit order).
      this.prisma.bitsLedger.findMany({
        where: { OR: ids.map((id) => ({ operatorId: id, seq: { gt: BigInt(after.get(id)!) } })) },
        select: { id: true, seq: true, operatorId: true, delta: true, reason: true },
        orderBy: { seq: 'asc' },
      }),
    ]);
    const orgs = new Map(members.map((m) => [m.operatorId, m]));
    const out = new Map<string, LiveOperatorState>();
    for (const op of ops) out.set(op.id, { name: op.name, org: orgView(orgs.get(op.id)), ledgerSeq: after.get(op.id)!, ledger: [] });
    for (const r of rows) {
      const state = out.get(r.operatorId);
      if (!state) continue;
      const seq = Number(r.seq);
      state.ledgerSeq = Math.max(state.ledgerSeq, seq);
      if (!SIM_LEDGER_REASONS.has(r.reason)) state.ledger.push({ id: r.id, seq, delta: Number(r.delta), reason: r.reason });
    }
    return out;
  }

  async appendChat(row: ChatRow): Promise<void> {
    await this.prisma.chatMessage.create({ data: { id: row.id, channel: row.channel, operatorId: row.operatorId, toId: row.toId, text: row.text, at: new Date(row.at) } });
  }

  async recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void> {
    await this.prisma.chatFilterHit.create({ data: { operatorId: hit.operatorId, channel: hit.channel, text: hit.text, term: hit.term } });
  }

  async setMute(operatorId: string, until: string | null): Promise<void> {
    await this.prisma.operator.update({ where: { id: operatorId }, data: { mutedUntil: until ? new Date(until) : null } });
  }

  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    return (await this.prisma.chatBlock.count({ where: { blockerId: blocker, blockedId: blocked } })) > 0;
  }

  async operatorExists(operatorId: string): Promise<boolean> {
    return (await this.prisma.operator.count({ where: { id: operatorId } })) > 0;
  }

  async listFilterTerms(): Promise<FilterTerm[]> {
    const rows = await this.prisma.chatFilterTerm.findMany({ orderBy: { at: 'asc' } });
    return rows.map((r) => ({ pattern: r.pattern, kind: r.kind, action: r.action }));
  }

  async mutedUntil(operatorIds: readonly string[]): Promise<Map<string, string | null>> {
    if (operatorIds.length === 0) return new Map();
    const rows = await this.prisma.operator.findMany({ where: { id: { in: [...operatorIds] } }, select: { id: true, mutedUntil: true } });
    return new Map(rows.map((r) => [r.id, r.mutedUntil ? r.mutedUntil.toISOString() : null]));
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
            // Conditional on the row still being unclaimed: a stale claim (a retry of one whose outcome was unknown, from
            // a session that has since claimed again) must neither add a second starter nor overwrite the inventory,
            // even when the starter's RAM slot is free again.
            const claimed = await tx.operator.updateMany({
              where: { id: intent.operatorId, starterClaimed: false },
              data: { name: intent.name, starterClaimed: true, inventory: intent.inventory },
            });
            if (claimed.count !== 1) throw new DomainFailure('starter already claimed');
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
            return { ok: true, research: await addResearch(tx, intent.operatorId, d.species) } as const;
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
            return { ok: true, research: await addResearch(tx, intent.operatorId, d.species) } as const;
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
          case 'travel': {
            await tx.operator.update({ where: { id: intent.operatorId }, data: { subnet: intent.to, x: intent.x, y: intent.y } });
            return { ok: true } as const;
          }
          case 'buy': {
            const op = await lockOperator(tx, intent.operatorId);
            const problem = economyIntentProblem(intent, op.diskCapacity);
            if (problem) throw new DomainFailure(problem);
            if (op.bits < BigInt(intent.price)) throw new DomainFailure('not enough bits');
            const disk = intent.itemId === DISK_EXPANSION_ITEM;
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: {
                bits: { decrement: BigInt(intent.price) },
                ...(disk ? { diskCapacity: { increment: DISK_STEP } } : { inventory: withItems(op.inventory, { [intent.itemId]: intent.qty }, 1) }),
              },
            });
            await intentLedgerRow(tx, intent.kind, intent.operatorId, -intent.price, ledgerReason(intent), intent.id);
            return { ok: true } as const;
          }
          case 'craft': {
            const op = await lockOperator(tx, intent.operatorId);
            const problem = economyIntentProblem(intent, op.diskCapacity);
            if (problem) throw new DomainFailure(problem);
            if (op.bits < BigInt(intent.bits)) throw new DomainFailure('not enough bits');
            const missing = missingItem(op.inventory, intent.fragments);
            if (missing) throw new DomainFailure(`not enough ${missing}`);
            const inventory = withItems(withItems(op.inventory, intent.fragments, -1), { [intent.output.item]: intent.output.qty }, 1);
            await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { decrement: BigInt(intent.bits) }, inventory } });
            await intentLedgerRow(tx, intent.kind, intent.operatorId, -intent.bits, ledgerReason(intent), intent.id);
            return { ok: true } as const;
          }
          case 'decompile': {
            const op = await lockOperator(tx, intent.operatorId);
            // Lock the daemon row too (operator first, then daemon: the same order as a checkpoint), so a concurrent
            // store / evolve of it either committed before this read or waits and then finds nothing to move.
            await tx.$queryRaw`SELECT 1 FROM "Daemon" WHERE "id" = ${intent.daemonId} FOR UPDATE`;
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM' || row.species !== intent.species) throw new DomainFailure('daemon not found');
            const problem = decompileProblem(intent, row, ctx.storedDaemon);
            if (problem) throw new DomainFailure(problem);
            const { location: _l, slot: _s, hp: _h, energy: _e, crashed: _c, history: _hi, ...rest } = row;
            const latest = ctx.storedDaemon ? memStateFields(ctx.storedDaemon) : null;
            const state = latest
              ? { level: latest.level, xp: latest.xp, moves: latest.moves, ivs: latest.ivs, patched: latest.patched, heldItem: latest.heldItem, moveTypeUses: latest.moveTypeUses, crashes: latest.crashes }
              : {};
            const history = latest ? latest.history : historyOf(row);
            await tx.daemonArchive.create({ data: { ...rest, ...state, history: json([...history, intent.history]), reason: 'decompiled' } });
            await tx.daemon.delete({ where: { id: intent.daemonId } });
            await tx.operator.update({ where: { id: intent.operatorId }, data: { inventory: withItems(op.inventory, decompileStoreGain(row, ctx.storedDaemon), 1) } });
            return { ok: true } as const;
          }
          case 'acceptTicket': {
            // The operator lock serializes accepts of one operator, so the cap counts see each other's rows.
            await lockOperator(tx, intent.operatorId);
            const rows = await tx.ticket.findMany({
              where: { operatorId: intent.operatorId, OR: [{ status: 'OPEN' }, { day: intent.day }] },
              select: { day: true, subnet: true, index: true, status: true },
            });
            const problem = ticketAcceptProblem(intent, now.toISOString()) ?? ticketCapProblem(rows, intent);
            if (problem) throw new DomainFailure(problem);
            await tx.ticket.create({
              data: {
                id: intent.ticketId, operatorId: intent.operatorId, day: intent.day, subnet: intent.subnet, index: intent.index, kind: intent.ticketKind,
                params: jsonParams(intent.params), target: intent.target, reward: intent.reward, acceptedAt: now,
              },
            });
            return { ok: true } as const;
          }
          case 'abandonTicket': {
            await lockOperator(tx, intent.operatorId);
            const res = await tx.ticket.updateMany({ where: { id: intent.ticketId, operatorId: intent.operatorId, status: 'OPEN' }, data: { status: 'ABANDONED' } });
            if (res.count !== 1) throw new DomainFailure('no open ticket');
            return { ok: true } as const;
          }
          case 'completeTicket': {
            await lockOperator(tx, intent.operatorId);
            const row = await tx.ticket.findUnique({ where: { id: intent.ticketId } });
            if (!row || row.operatorId !== intent.operatorId || row.status !== 'OPEN') throw new DomainFailure('no open ticket');
            if (row.reward !== intent.reward) throw new DomainFailure('reward does not match the ticket');
            // Conditional on OPEN: the row moves to DONE once, and only that transaction pays.
            const res = await tx.ticket.updateMany({
              where: { id: intent.ticketId, operatorId: intent.operatorId, status: 'OPEN' },
              data: { status: 'DONE', progress: row.target, completedAt: now },
            });
            if (res.count !== 1) throw new DomainFailure('no open ticket');
            await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { increment: BigInt(intent.reward) } } });
            await intentLedgerRow(tx, intent.kind, intent.operatorId, intent.reward, 'ticket', intent.ticketId);
            return { ok: true } as const;
          }
          case 'incidentReward':
            return await this.incidentReward(tx, intent, now);
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
        // A concurrent accept of the same board entry committed first (the cap check could not see it yet).
        if (intent.kind === 'acceptTicket' && (violated.includes('Ticket_operatorId_day_subnet_index_key') || /\(`operatorId`,`day`,`subnet`,`index`\)|operatorId,day,subnet,index/.test(violated))) {
          return { ok: false, reason: 'already accepted' };
        }
        // The slot is occupied (the runtime retries unknown outcomes of these kinds until the store answers, so a
        // deterministic conflict must be a domain answer, not an error).
        if (violated.includes('Daemon_operatorId_location_slot_key') || /\(`operatorId`,`location`,`slot`\)|operatorId,location,slot/.test(violated)) {
          if (intent.kind === 'capture') return { ok: false, reason: 'slot taken' };
          if (intent.kind === 'claimStarter') return { ok: false, reason: 'starter already claimed' };
        }
      }
      throw err;
    }
  }

  /**
   * One Incident payout (economy contract): the operator row is locked first, the payout list is re-derived from the
   * rules, the Incident row is written CLEARED with its participants (created when missing; an EXPIRED row or a
   * different list refuses), and the operator is credited with one `incident` ledger row (ref = Incident id) unless one
   * exists already: exactly once per (Incident, operator), whatever the intent id.
   */
  private async incidentReward(tx: Tx, intent: IncidentRewardIntent, now: Date): Promise<IntentResult> {
    await lockOperator(tx, intent.operatorId);
    const problem = incidentRewardProblem(intent);
    if (problem) throw new DomainFailure(problem);
    const participants = jsonParticipants(intent.participants);
    // ON CONFLICT DO NOTHING (no Incident_pkey P2002 when two payouts create the row at once), then lock it.
    await tx.incident.createMany({
      data: [{ id: intent.incidentId, n: intent.n, species: intent.species, endsAt: new Date(intent.endsAt), outcome: 'CLEARED', participants, closedAt: now }],
      skipDuplicates: true,
    });
    const rows = await tx.$queryRaw<Array<{ outcome: string; participants: unknown }>>`
      SELECT "outcome"::text AS "outcome", "participants" FROM "Incident" WHERE "id" = ${intent.incidentId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error(`incident ${intent.incidentId} vanished`);
    if (row.outcome === 'EXPIRED') throw new DomainFailure('the Incident expired');
    if (row.outcome === 'OPEN') {
      await tx.incident.update({ where: { id: intent.incidentId }, data: { outcome: 'CLEARED', participants, closedAt: now } });
    } else if (!samePayouts(participantsOf(row.participants), intent.participants)) {
      throw new DomainFailure('payouts do not match the Incident');
    }
    if ((await incidentLedgerSeq(tx, intent.operatorId, intent.incidentId)) !== null) throw new DomainFailure('already paid');
    await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { increment: BigInt(intent.reward) } } });
    await intentLedgerRow(tx, intent.kind, intent.operatorId, intent.reward, 'incident', intent.incidentId);
    const seq = await incidentLedgerSeq(tx, intent.operatorId, intent.incidentId);
    return seq === null ? { ok: true } : { ok: true, ledgerSeq: seq };
  }

  async recordIncident(row: IncidentRow): Promise<void> {
    const closed = row.outcome !== 'OPEN';
    const data = { n: row.n, species: row.species, endsAt: new Date(row.endsAt), outcome: row.outcome, participants: jsonParticipants(row.participants), closedAt: closed ? new Date() : null };
    await this.prisma.$transaction(async (tx) => {
      await tx.incident.createMany({ data: [{ id: row.id, ...data }], skipDuplicates: true });
      // a closed row is final: only an OPEN one takes the outcome
      if (closed) await tx.incident.updateMany({ where: { id: row.id, outcome: 'OPEN' }, data });
    });
  }

  async recoverIncidents(): Promise<IncidentRewardIntent[]> {
    const now = new Date();
    await this.prisma.incident.updateMany({ where: { outcome: 'OPEN' }, data: { outcome: 'EXPIRED', closedAt: now } });
    const cleared = await this.prisma.incident.findMany({ where: { outcome: 'CLEARED', closedAt: { gte: new Date(now.getTime() - INCIDENT_RECOVERY_MS) } }, orderBy: { openedAt: 'asc' } });
    if (cleared.length === 0) return [];
    const paid = await this.prisma.bitsLedger.findMany({ where: { reason: 'incident', ref: { in: cleared.map((r) => r.id) } }, select: { operatorId: true, ref: true } });
    const done = new Set(paid.map((l) => `${l.ref}:${l.operatorId}`));
    const out: IncidentRewardIntent[] = [];
    for (const r of cleared) {
      const row: IncidentRow = { id: r.id, n: r.n, species: r.species, endsAt: r.endsAt.toISOString(), outcome: 'CLEARED', participants: participantsOf(r.participants) };
      for (const p of row.participants) if (!done.has(`${row.id}:${p.operatorId}`)) out.push(incidentRewardIntent(row, p));
    }
    return out;
  }

  /** The stored result when this intent was already applied, else null. */
  private async replayed(db: Pick<PrismaClient, 'appliedAction' | 'daemon' | 'research' | 'bitsLedger'>, intent: Intent): Promise<IntentResult | null> {
    const done = await db.appliedAction.findUnique({ where: { key: intent.id } });
    if (!done) return null;
    if (intent.kind === 'incidentReward') {
      const seq = await incidentLedgerSeq(db, intent.operatorId, intent.incidentId);
      return seq === null ? { ok: true } : { ok: true, ledgerSeq: seq };
    }
    if (intent.kind === 'capture' || intent.kind === 'claimStarter') {
      const r = await db.research.findUnique({ where: { operatorId_line: { operatorId: intent.operatorId, line: getSpecies(intent.daemon.species).line } } });
      return { ok: true, research: r?.points ?? 0 };
    }
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
          // bits / diskCapacity move only through intents (the ledger); an inventory an intent is rewriting is left to it.
          data: { subnet: rec.subnet, x: rec.x, y: rec.y, ...(rec.inventoryInFlight ? {} : { inventory: rec.inventory }), lastSeenAt: now },
        });
        for (const d of rec.ram) {
          // `species` guard: a record taken before an evolve committed must not roll the evolved row back.
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id, location: 'RAM', species: d.species }, data: { ...checkpointFields(d, rec.inventoryInFlight), history: json(d.history) } });
        }
        for (const t of rec.tickets) {
          // Only an OPEN row's progress, never lowered (a completion already set it to the target) and never past the
          // target (MemoryStore parity).
          const row = await tx.ticket.findFirst({ where: { id: t.id, operatorId: rec.id, status: 'OPEN' }, select: { target: true } });
          if (!row) continue;
          const progress = Math.min(row.target, t.progress);
          await tx.ticket.updateMany({ where: { id: t.id, operatorId: rec.id, status: 'OPEN', progress: { lt: progress } }, data: { progress } });
        }
      }
    });
  }

  async listDiscoveries(): Promise<string[]> {
    const rows = await this.prisma.discovery.findMany({ select: { formId: true }, orderBy: { discoveredAt: 'asc' } });
    return rows.map((r) => r.formId);
  }

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<LedgerWrite> {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new RangeError(`invalid bits delta ${delta}`);
    assertGrantReason(reason);
    return this.prisma.$transaction(async (tx) => {
      // A debit is conditional on the balance (row-locked by the update), so bits never go negative.
      const res = await tx.operator.updateMany({
        where: delta < 0 ? { id: operatorId, bits: { gte: BigInt(-delta) } } : { id: operatorId },
        data: { bits: { increment: BigInt(delta) } },
      });
      if (res.count !== 1) {
        if (delta < 0 && (await tx.operator.count({ where: { id: operatorId } })) === 1) throw new RangeError('not enough bits');
        throw new Error(`unknown operator ${operatorId}`);
      }
      const row = await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason, ref: ref ?? null }, select: { id: true, seq: true } });
      const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } });
      return { id: row.id, seq: Number(row.seq), balance: Number(op.bits) };
    });
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    const rows = await this.prisma.bitsLedger.findMany({ where: { operatorId }, orderBy: { seq: 'desc' }, take: limit });
    return rows.reverse().map((r) => ({ operatorId: r.operatorId, delta: Number(r.delta), reason: r.reason, ref: r.ref, at: r.at.toISOString() }));
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
