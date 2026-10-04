import { OperatorName } from '@daemonet/shared';
import { z } from 'zod';
import { SIM_LEDGER_REASONS } from './store.js';

/**
 * Operator state the api changes and pushes to the sim over the bus (SP4 spec §7: orgs, renames, bits spent or granted
 * outside the sim). Bus messages are untrusted: every one is validated against these schemas before the sim acts on
 * it. Pub/sub is at-most-once, so the runtime also re-reads this state from the store on every bus reconnect and
 * periodically (`Game` via the chat resync). `origin: 'sim'` marks the sim's own announcements, which it ignores.
 */

const Id = z.string().min(1).max(64);
const Origin = z.enum(['sim', 'api']).optional();

export const OrgViewSchema = z.object({
  id: Id,
  name: z.string().min(1).max(64),
  /** The api's `OrgTag` rule exactly: 4 upper-case letters or digits. */
  tag: z
    .string()
    .length(4)
    .regex(/^[A-Z0-9]{4}$/),
  rank: z.enum(['OWNER', 'OFFICER', 'MEMBER']),
});

/** `org` channel: the operator's membership changed (create, join, leave, kick, rank, tag change); null = no org. */
export const OrgMembershipPush = z.object({ kind: z.literal('membership'), operatorId: Id, org: OrgViewSchema.nullable(), origin: Origin });

/**
 * `admin` channel: the api committed a BitsLedger row for the operator (org creation, tag change, rename, admin or
 * dev grants). The sim adds `delta` to the live balance (never sets `balance`, which is informational: the world may
 * already have taken the cost of an in-flight intent the DB has not seen yet) once per ledger row: a row at or below
 * the operator's watermark (`seq`, see `LoadedOperator.ledgerSeq`) is already in the balance, and a row id already
 * applied is a duplicate delivery.
 */
export const BitsPush = z.object({
  kind: z.literal('bits'),
  operatorId: Id,
  /** BitsLedger.id */
  ledgerId: Id,
  /** BitsLedger.seq */
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  delta: z
    .number()
    .int()
    .refine((d) => d !== 0 && Number.isSafeInteger(d), 'delta must be a non-zero safe integer'),
  /** The ledger reason; never one of the sim's own (those rows reach the world through its intents). */
  reason: z
    .string()
    .min(1)
    .max(32)
    .refine((r) => !SIM_LEDGER_REASONS.has(r), 'reason belongs to the sim'),
  /** The DB balance after the row (informational only). */
  balance: z.number().int(),
  origin: Origin,
});

/** `admin` channel: the operator was renamed in the api (the api checks the name against the live chat filter). */
export const RenamePush = z.object({ kind: z.literal('rename'), operatorId: Id, name: OperatorName, origin: Origin });

/**
 * `admin` channel: start an Incident now (SP4 spec §8). A one-shot command, not state: pub/sub is at-most-once, so a
 * start published while the bus is down is simply lost (the admin presses the button again); nothing is resynced.
 */
export const IncidentStartPush = z.object({ kind: z.literal('incident:start'), origin: Origin });

export type OrgMembershipPush = z.infer<typeof OrgMembershipPush>;
export type BitsPush = z.infer<typeof BitsPush>;
export type RenamePush = z.infer<typeof RenamePush>;
