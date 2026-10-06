import type { Bus } from '@daemonet/bus';
import type { Prisma } from '@daemonet/db';
import { AppError } from '../errors.js';
import { publishSafely, type PublishLog } from '../publish.js';

/**
 * Ledger primitives shared by the api's paid Exchange actions (order book; listings and trades in later plans). The
 * contract (carry-forward #30, #32): lock every Operator row involved FIRST, sorted by id, before any ledger row or
 * vault / order / daemon row is written; one BitsLedger row per balance change; after commit, one `BitsPush` per row.
 * The Disk helpers at the end (`freeDiskSlot`, `isSlotTaken`) serve every action that moves a daemon onto a Disk
 * (listing purchases; trades in plan 4).
 */

export type Tx = Prisma.TransactionClient;

/** The bits push the sim applies once per ledger row (apps/sim/src/runtime/pushes.ts `BitsPush`). */
export type BitsPushMessage = {
  kind: 'bits';
  operatorId: string;
  ledgerId: string;
  seq: number;
  delta: number;
  reason: string;
  balance: number;
  origin: 'api';
};

/** A fill as announced on the `exchange` channel (the sim gives each side its own view). */
export interface FillView {
  id: string;
  item: string;
  price: number;
  qty: number;
  buyerId: string;
  sellerId: string;
  fee: number;
}

/** What a transaction must announce once it has committed: one push per ledger row, one message per fill. */
export class Outbox {
  readonly bits: BitsPushMessage[] = [];
  readonly fills: FillView[] = [];
}

/** Row-locks every operator involved, sorted by id (`FOR NO KEY UPDATE`, as the sim's store). Unknown ids throw. */
export async function lockOperators(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Operator" WHERE "id" = ${id} FOR NO KEY UPDATE`;
    if (rows.length !== 1) throw new Error(`unknown operator ${id}`);
  }
}

/** One ledger row for a balance change just made (the operator row is locked, so seq follows commit order). */
export async function ledgerRow(tx: Tx, out: Outbox, operatorId: string, delta: number, balance: bigint, reason: string, ref: string): Promise<void> {
  const row = await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason, ref }, select: { id: true, seq: true } });
  out.bits.push({ kind: 'bits', operatorId, ledgerId: row.id, seq: Number(row.seq), delta, reason, balance: Number(balance), origin: 'api' });
}

/** Adds bits with its ledger row (caller holds the operator lock). Zero is a no-op. */
export async function credit(tx: Tx, out: Outbox, operatorId: string, bits: number, reason: string, ref: string): Promise<void> {
  if (bits === 0) return;
  const rows = await tx.$queryRaw<Array<{ bits: bigint }>>`UPDATE "Operator" SET "bits" = "bits" + ${BigInt(bits)} WHERE "id" = ${operatorId} RETURNING "bits"`;
  if (rows.length !== 1) throw new Error(`unknown operator ${operatorId}`);
  await ledgerRow(tx, out, operatorId, bits, BigInt(rows[0]!.bits), reason, ref);
}

/** Takes bits with a guarded decrement and its ledger row (402 when short; caller holds the operator lock). */
export async function debit(tx: Tx, out: Outbox, operatorId: string, bits: number, reason: string, ref: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ bits: bigint }>>`
    UPDATE "Operator" SET "bits" = "bits" - ${BigInt(bits)} WHERE "id" = ${operatorId} AND "bits" >= ${BigInt(bits)} RETURNING "bits"`;
  if (rows.length !== 1) throw new AppError(402, 'insufficient_bits', `needs ${bits} bits`);
  await ledgerRow(tx, out, operatorId, -bits, BigInt(rows[0]!.bits), reason, ref);
}

/** After commit: one BitsPush per ledger row (the sim applies each once, by seq), one `exchange` message per fill. */
export function announce(bus: Bus, log: PublishLog, out: Outbox): void {
  for (const push of out.bits) publishSafely(bus, log, 'admin', push);
  for (const f of out.fills) {
    publishSafely(bus, log, 'exchange', {
      kind: 'fill',
      operators: [f.buyerId, f.sellerId],
      detail: { item: f.item, price: f.price, qty: f.qty, buyerId: f.buyerId, sellerId: f.sellerId, fee: f.fee },
    });
  }
}

/**
 * Most history entries a daemon keeps after an Exchange move (oldest dropped). Fee-free trades can pass one daemon back
 * and forth indefinitely, and the whole history is served to every browser of the Exchange and loaded into sim records.
 */
export const DAEMON_HISTORY_MAX = 32;

/**
 * A daemon's history with one `traded` entry appended (listing sales and direct trades), capped to the last
 * `DAEMON_HISTORY_MAX` entries: a non-array history (never expected) starts over rather than failing the move.
 */
export function withTraded(history: Prisma.JsonValue, at: Date, detail: string): Prisma.JsonArray {
  return [...(Array.isArray(history) ? history : []), { at: at.toISOString(), kind: 'traded', detail }].slice(-DAEMON_HISTORY_MAX);
}

/**
 * Lowest free Disk slot of an operator, or null when the Disk is full. Read from the DB (never the sim's memory) against
 * `Operator.diskCapacity`; call it under the operator's lock. A sim store / capture that does not take the operator lock
 * can still claim the same slot concurrently: the `(operatorId, location, slot)` unique index then refuses one of them.
 */
export async function freeDiskSlot(tx: Tx, operatorId: string): Promise<number | null> {
  const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { diskCapacity: true } });
  const used = new Set((await tx.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((d) => d.slot));
  for (let s = 0; s < op.diskCapacity; s++) if (!used.has(s)) return s;
  return null;
}

/** True for the unique violation of a Disk (or RAM) slot (Prisma 7 + pg adapter report it under meta.driverAdapterError). */
export function isSlotTaken(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: { constraint?: { index?: string }; originalMessage?: string } } | undefined)?.cause;
  const target = meta.target ?? meta.constraint;
  return [cause?.constraint?.index, cause?.originalMessage, Array.isArray(target) ? target.join(',') : target, (err as Error).message]
    .filter((x): x is string => typeof x === 'string')
    .some((s) => s.includes('Daemon_operatorId_location_slot_key') || s.includes('operatorId,location,slot'));
}
