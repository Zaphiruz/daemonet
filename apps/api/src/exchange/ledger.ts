import type { Bus } from '@daemonet/bus';
import type { Prisma } from '@daemonet/db';
import { AppError } from '../errors.js';
import { publishSafely, type PublishLog } from '../publish.js';

/**
 * Ledger primitives shared by the api's paid Exchange actions (order book; listings and trades in later plans). The
 * contract (carry-forward #30, #32): lock every Operator row involved FIRST, sorted by id, before any ledger row or
 * vault / order / daemon row is written; one BitsLedger row per balance change; after commit, one `BitsPush` per row.
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
