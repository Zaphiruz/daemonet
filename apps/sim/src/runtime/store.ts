import {
  DISK_BASE,
  DISK_EXPANSION_ITEM,
  DISK_STEP,
  INCIDENT_WINDOW_MS,
  OPEN_TICKETS_MAX,
  TICKETS_PER_DAY,
  VAULT_MAX_QTY,
  dayKey,
  decompileYield,
  diskExpansionPrice,
  fragmentId,
  getRecipe,
  getSpecies,
  isTradable,
  recipeFragments,
  ticketKey,
  type FilterTerm,
  type TicketKind,
  type TicketParams,
} from '@daemonet/rules';
import { DISK_SLOT_TAKEN, incidentParticipants, incidentRewardId, type IncidentParticipant, type Intent, type IntentResult, type OpenTicket, type OperatorRecord, type OrgView, type OwnedDaemonRecord, type Point, type ShopIntent } from '../core/index.js';
import { shopPrice } from '../core/systems/economy.js';
import { boardTicket } from '../core/systems/tickets.js';

export interface IntentContext {
  seedId: string;
  /** For `store` / `decompile`: the daemon's current state, written along with the move to Disk (or the archive). */
  storedDaemon?: OwnedDaemonRecord;
}

export interface ChatRow {
  id: string;
  channel: string;
  operatorId: string;
  /** For dm channels: the recipient. */
  toId: string | null;
  text: string;
  at: string;
}

/** What the chat service persists (SP4 spec §5). Every method may throw on infrastructure failure. */
export interface ChatStore {
  appendChat(row: ChatRow): Promise<void>;
  recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void>;
  setMute(operatorId: string, until: string | null): Promise<void>;
  /** `blocker` has blocked `blocked`. */
  isBlocked(blocker: string, blocked: string): Promise<boolean>;
  /** An operator row with this id exists (DM targets must). */
  operatorExists(operatorId: string): Promise<boolean>;
  /** Admin-added filter terms (loaded at boot and on every chat resync). */
  listFilterTerms(): Promise<FilterTerm[]>;
  /** The stored mute of each of these operators that has a row (null = not muted); for chat resyncs. */
  mutedUntil(operatorIds: readonly string[]): Promise<Map<string, string | null>>;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store extends ChatStore {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  /**
   * Loads the operator with its open tickets (with progress), today's (UTC, store clock) accepted count and keys, its
   * Codex research, its chat mute, its org and the ledger watermark of its balance (`LoadedOperator.ledgerSeq`).
   */
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<LoadedOperator>;
  /**
   * What changed outside the sim for connected operators (SP4 plan 3: the runtime's resync after bus outages): name,
   * org, the ledger rows above each operator's watermark (`after`: operator id -> seq) that the sim's own intents
   * did not write, and the occupied Disk slots (SP5). Operators without a row are left out.
   */
  liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>>;
  /**
   * Idempotent by intent.id. Domain failures (name taken, not on Disk, ticket not open) resolve with ok: false. A
   * `completeTicket` moves the row OPEN -> DONE and credits the reward with exactly one ledger row (reason `ticket`,
   * ref = ticket id) in one transaction; capture / claimStarter add a Research point and report the line's total.
   */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  /**
   * Writes position, inventory, RAM daemon state and the progress of OPEN tickets (never lowering it). Never writes `bits` or `diskCapacity` (only intents and
   * `grantBits` change those, with a ledger row) and skips `inventory` and every daemon's `heldItem` on records marked
   * `inventoryInFlight` (a held item moves only together with the inventory).
   */
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  /** Form ids with a Discovery row (loaded once at boot into World.discovered). */
  listDiscoveries(): Promise<string[]>;
  /**
   * Credits (or, with a negative delta, debits) bits outside the sim's intents, with a ledger row in the same
   * transaction; returns the row's id and seq and the new balance. Throws on a non-integer or zero delta, an unknown
   * operator, or a debit larger than the balance. `reason` must not be one of SIM_LEDGER_REASONS.
   *
   * For outside-the-sim credits only (admin grants, dev seeding): a connected operator's world applies the row as a
   * delta when it is pushed over the bus (`admin { kind: 'bits' }`) or at the next resync. Payouts to connected
   * operators (tickets, rewards) must be intents applied through the world.
   */
  grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<LedgerWrite>;
  /**
   * Writes an Incident row (`IncidentRow`): created when missing; an OPEN row takes the record's outcome and
   * participants; a closed row (CLEARED / EXPIRED) is final. The CLEARED row is also written by the first reward intent
   * of the Incident, so a lost record never loses the participants.
   */
  recordIncident(row: IncidentRow): Promise<void>;
  /**
   * Boot recovery (call before accepting connections): OPEN rows left by an earlier process close as EXPIRED (its
   * Incident died with it), and the reward intents of recently CLEARED rows whose participants have no `incident` ledger
   * row are returned, with their usual ids, so the runtime can finish a payout a restart interrupted (exactly once:
   * the ids and the ledger check make a second payment impossible).
   */
  recoverIncidents(): Promise<IncidentRewardIntent[]>;
  /**
   * Marks a participant's payout on the Incident row as definitively refused, so boot recovery does not raise it again.
   * No-op for a missing row or participant.
   */
  markIncidentPayoutRefused(incidentId: string, operatorId: string): Promise<void>;
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

/**
 * The ledger reasons each store intent kind writes: the one source of truth for SIM_LEDGER_REASONS. Both stores write
 * intent ledger rows only through a helper typed (and checked) against this map, so a new bits-moving intent (e.g. an
 * incident payout) cannot write a row without listing its reason here. Pinned by store.test.ts.
 */
export const SIM_INTENT_LEDGER_REASONS = Object.freeze({
  buy: Object.freeze(['shop', 'disk'] as const),
  craft: Object.freeze(['craft'] as const),
  completeTicket: Object.freeze(['ticket'] as const),
  incidentReward: Object.freeze(['incident'] as const),
} satisfies Partial<Record<Intent['kind'], readonly string[]>>);

/** An intent kind that writes ledger rows. */
export type SimLedgerKind = keyof typeof SIM_INTENT_LEDGER_REASONS;
/** A ledger reason an intent of kind `K` may write. */
export type SimLedgerReason<K extends SimLedgerKind = SimLedgerKind> = (typeof SIM_INTENT_LEDGER_REASONS)[K][number];

/**
 * Ledger reasons written only by the sim's own store intents (buy / craft / completeTicket). The world applied those
 * itself (costs at accept, gains on commit), so a resync never applies them again; every other reason (admin grants,
 * org and rename spends in the api, ...) was written outside the sim and reaches the world as a delta. `grantBits`
 * refuses these reasons.
 */
export const SIM_LEDGER_REASONS: ReadonlySet<string> = new Set<string>(Object.values(SIM_INTENT_LEDGER_REASONS).flat());

/** The reason an intent ledger row is written with, checked against SIM_INTENT_LEDGER_REASONS (throws RangeError). */
export function intentLedgerReason<K extends SimLedgerKind>(kind: K, reason: SimLedgerReason<K>): SimLedgerReason<K> {
  if (!(SIM_INTENT_LEDGER_REASONS[kind] as readonly string[]).includes(reason)) throw new RangeError(`ledger reason ${reason} is not listed for ${kind}`);
  return reason;
}

/** Throws RangeError for a reason only the sim's intents may write (grantBits). */
export function assertGrantReason(reason: string): void {
  if (SIM_LEDGER_REASONS.has(reason)) throw new RangeError(`ledger reason ${reason} belongs to the sim's intents`);
}

/** A ledger row just written outside the sim's intents. */
export interface LedgerWrite {
  id: string;
  /**
   * BitsLedger.seq. Per operator, rows commit in seq order: every writer locks the operator row (the balance update or
   * `lockOperator`) before inserting its row, so the next writer draws its seq only after the previous one committed.
   * The load watermark and `liveState` depend on it (a read sees a gap-free prefix of the operator's rows, so moving
   * the watermark to the highest seq read never skips a row). Two rules keep it true:
   * - the sequence must stay `CACHE 1` (the Prisma `autoincrement()` default): a cached sequence hands each session
   *   its own block of values, so a later commit could carry a lower seq;
   * - every BitsLedger writer (sim intents, `grantBits`, the api's paid actions and dev route, any future one) must
   *   lock the operator row before inserting. Inserting first lets two writers commit out of seq order.
   * Pinned by the PrismaStore test "seq order is commit order".
   */
  seq: number;
  /** The balance after the row. */
  balance: number;
}

/**
 * The record a load returns. `ledgerSeq` is the highest ledger seq of the operator, read in the same snapshot as
 * `bits`: the balance reflects exactly the rows up to it, so a pushed or resynced row is applied only above it.
 */
export interface LoadedOperator extends OperatorRecord {
  ledgerSeq: number;
}

/** See `Store.liveState`. */
export interface LiveOperatorState {
  name: string | null;
  org: OrgView | null;
  /** Highest ledger seq of the operator in the same read (the caller's watermark when there is none above it). */
  ledgerSeq: number;
  /** Rows above the caller's watermark whose reason is not in SIM_LEDGER_REASONS, in seq order. */
  ledger: Array<{ id: string; seq: number; delta: number; reason: string }>;
  /**
   * Occupied Disk slots, ascending (Exchange sales move daemons between Disks behind the sim: a lost `disk` push heals
   * here).
   */
  diskSlots: number[];
}

/**
 * A deposit the stored inventory cannot cover. The runtime saves the operator's inventory right before a deposit
 * (`Game.saveBeforeDeposits`), so this happens only when it could not (another inventory intent was in flight, or the
 * save failed): the world refunds the items and the player retries. A forged deposit gets the same answer.
 */
export const DEPOSIT_NOT_SAVED = 'inventory not saved yet — try again in a moment';

/** Ledger reason of a bits-spending intent. */
export function ledgerReason(intent: Extract<ShopIntent, { kind: 'buy' }>): SimLedgerReason<'buy'>;
export function ledgerReason(intent: Extract<ShopIntent, { kind: 'craft' }>): SimLedgerReason<'craft'>;
export function ledgerReason(intent: Extract<ShopIntent, { kind: 'buy' | 'craft' }>): SimLedgerReason<'buy' | 'craft'> {
  if (intent.kind === 'craft') return 'craft';
  return intent.itemId === DISK_EXPANSION_ITEM ? 'disk' : 'shop';
}

/**
 * Domain check shared by both stores: what an economy intent costs must match the rules, so a world bug or a forged
 * intent can never mint bits or items. Returns the failure reason, or null when the intent is well-formed.
 * `diskCapacity` is the operator's committed capacity (Disk expansions are priced on it).
 */
export function economyIntentProblem(intent: ShopIntent, diskCapacity: number): string | null {
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
    case 'vault':
      // Whether the inventory (deposit) or the vault (withdrawal) holds enough is checked under the operator lock.
      return isTradable(intent.item) && Number.isSafeInteger(intent.qty) && intent.qty !== 0 && Math.abs(intent.qty) <= VAULT_MAX_QTY ? null : 'invalid vault move';
  }
}

/** True when both maps hold exactly the same item counts. */
export function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

type DecompileRow = Pick<OwnedDaemonRecord, 'species' | 'level' | 'heldItem'>;

/** The rules' type fragments for a decompile at the latest known level, or null for an unknown species. */
function decompileTypeYield(row: DecompileRow, latest: OwnedDaemonRecord | undefined): Record<string, number> | null {
  let sp;
  try {
    sp = getSpecies(row.species);
  } catch {
    return null;
  }
  const level = latest?.level ?? row.level;
  const out: Record<string, number> = {};
  for (const t of sp.types) out[fragmentId(t)] = decompileYield(sp.stage, level);
  return out;
}

/**
 * The check of a decompile's fragments. `row` is the stored daemon (already matched on id, owner, location and
 * species); `latest` is the world's current record of it (`IntentContext.storedDaemon`), which may be ahead of the last
 * checkpoint (levels, a hold or unhold). The fragments must be exactly the rules' yield for the species at the latest
 * level, plus at most one held item that either side believes the daemon holds (`row.heldItem` or `latest.heldItem`):
 * each side returns the held item IT knows of (see `decompileStoreGain`).
 */
export function decompileProblem(intent: Extract<ShopIntent, { kind: 'decompile' }>, row: DecompileRow, latest: OwnedDaemonRecord | undefined): string | null {
  if (latest && (latest.id !== intent.daemonId || latest.species !== row.species || latest.level < row.level)) return 'invalid decompile';
  const types = decompileTypeYield(row, latest);
  if (!types) return 'invalid decompile';
  if (sameCounts(intent.fragments, types)) return null;
  for (const held of new Set([row.heldItem, latest?.heldItem ?? null])) {
    if (held && sameCounts(intent.fragments, withItems(types, { [held]: 1 }, 1))) return null;
  }
  return 'invalid decompile';
}

/**
 * What a decompile adds to the stored inventory: the type fragments plus the held item the STORE knows of
 * (`row.heldItem`). The world adds the item it knows of (`d.heldItem`, in `intent.fragments`). A hold or unhold since the
 * last checkpoint already moved the item in the world's inventory but not in the stored one, so each inventory stays
 * right without a reconciling checkpoint.
 */
export function decompileStoreGain(row: DecompileRow, latest: OwnedDaemonRecord | undefined): Record<string, number> {
  const types = decompileTypeYield(row, latest) ?? {};
  return row.heldItem ? withItems(types, { [row.heldItem]: 1 }, 1) : types;
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

export type IncidentRewardIntent = Extract<Intent, { kind: 'incidentReward' }>;

/** An Incident row as the stores write it (SP4 spec §8). */
export interface IncidentRow {
  id: string;
  n: number;
  species: string;
  /** ISO start of the window; when missing, `endsAt` minus the window (`incidentOpenedAt`). */
  openedAt?: string;
  /** ISO end of the window. */
  endsAt: string;
  outcome: 'OPEN' | 'CLEARED' | 'EXPIRED';
  participants: IncidentParticipant[];
}

/** When an Incident row's window opened: its own `openedAt`, else `endsAt` minus the window (the sim's definition). */
export function incidentOpenedAt(row: Pick<IncidentRow, 'openedAt' | 'endsAt'>): string {
  return row.openedAt ?? new Date(Date.parse(row.endsAt) - INCIDENT_WINDOW_MS).toISOString();
}

/** How far back boot recovery looks for unfinished payouts. */
export const INCIDENT_RECOVERY_MS = 7 * 86_400_000;

/** Participants read back from a JSON column (anything malformed is dropped). */
export function participantsOf(raw: unknown): IncidentParticipant[] {
  if (!Array.isArray(raw)) return [];
  const out: IncidentParticipant[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    if (!p || typeof p.operatorId !== 'string' || typeof p.damage !== 'number' || typeof p.reward !== 'number') continue;
    out.push({
      operatorId: p.operatorId,
      name: typeof p.name === 'string' ? p.name : null,
      damage: p.damage,
      share: typeof p.share === 'number' ? p.share : 0,
      reward: p.reward,
      ...(p.refused === true ? { refused: true } : {}),
    });
  }
  return out;
}

/** The same payout list: operators, damage and rewards, in order (names and float shares are informational). */
export function samePayouts(a: readonly Pick<IncidentParticipant, 'operatorId' | 'damage' | 'reward'>[], b: readonly Pick<IncidentParticipant, 'operatorId' | 'damage' | 'reward'>[]): boolean {
  return a.length === b.length && a.every((p, i) => p.operatorId === b[i]!.operatorId && p.damage === b[i]!.damage && p.reward === b[i]!.reward);
}

/**
 * Domain check of an Incident payout shared by both stores: the participant list (every contributor, sub-minimum ones
 * with reward 0) must be exactly what the rules derive from its damage (`incidentParticipants` over `incidentPayouts`),
 * the intent must pay its own operator's non-zero entry, and its id must be the one id of that (Incident, operator)
 * pair. Returns the failure reason, or null.
 */
export function incidentRewardProblem(intent: IncidentRewardIntent): string | null {
  const ps = intent.participants;
  if (!Array.isArray(ps) || ps.length === 0 || new Set(ps.map((p) => p.operatorId)).size !== ps.length) return 'invalid payout';
  if (!ps.every((p) => Number.isSafeInteger(p.damage) && p.damage > 0 && Number.isSafeInteger(p.reward) && p.reward >= 0)) return 'invalid payout';
  if (intent.id !== incidentRewardId(intent.incidentId, intent.operatorId) || Number.isNaN(Date.parse(intent.endsAt)) || Number.isNaN(Date.parse(intent.openedAt))) return 'invalid payout';
  if (!samePayouts(incidentParticipants(new Map(ps.map((p) => [p.operatorId, p.damage]))), ps)) return 'payouts do not match the rules';
  const mine = ps.find((p) => p.operatorId === intent.operatorId);
  if (!mine || mine.reward <= 0 || mine.reward !== intent.reward || mine.damage !== intent.damage) return 'payouts do not match the rules';
  return null;
}

/** The reward intent of one participant of a cleared Incident row (boot recovery). */
export function incidentRewardIntent(row: IncidentRow, p: IncidentParticipant): IncidentRewardIntent {
  return {
    id: incidentRewardId(row.id, p.operatorId),
    kind: 'incidentReward',
    operatorId: p.operatorId,
    incidentId: row.id,
    n: row.n,
    species: row.species,
    openedAt: incidentOpenedAt(row),
    endsAt: row.endsAt,
    reward: p.reward,
    damage: p.damage,
    share: p.share,
    participants: row.participants.map(({ refused: _r, ...x }) => ({ ...x })),
  };
}

/** The participants of a row still owed a payout by boot recovery: a reward, not refused, no ledger row (`paid`). */
export function unpaidParticipants(row: IncidentRow, paid: (operatorId: string) => boolean): IncidentParticipant[] {
  return row.participants.filter((p) => p.reward > 0 && p.refused !== true && !paid(p.operatorId));
}

/** One UTC day earlier (`YYYY-MM-DD`). */
function previousDay(day: string): string {
  return dayKey(new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString());
}

/**
 * Domain check of an accept shared by both stores: the board must be today's or yesterday's (an accept can commit just
 * after midnight) by the store's clock, and the ticket must be exactly the rules' board entry, so a forged or stale
 * intent can never create a ticket with another reward or target. Returns the failure reason, or null.
 */
export function ticketAcceptProblem(intent: Extract<Intent, { kind: 'acceptTicket' }>, nowIso: string): string | null {
  const today = dayKey(nowIso);
  if (intent.day !== today && intent.day !== previousDay(today)) return `the board for ${intent.day} is gone`;
  const def = Number.isSafeInteger(intent.index) && intent.index >= 0 ? boardTicket(intent.subnet, intent.day, intent.index) : undefined;
  const same =
    def !== undefined &&
    def.kind === intent.ticketKind &&
    def.target === intent.target &&
    def.reward === intent.reward &&
    JSON.stringify(def.params) === JSON.stringify(intent.params);
  return same ? null : 'ticket does not match the board';
}

/** The caps an accept must respect, given the operator's committed rows (checked under the operator lock). */
export function ticketCapProblem(rows: ReadonlyArray<Pick<TicketRow, 'day' | 'subnet' | 'index' | 'status'>>, intent: Extract<Intent, { kind: 'acceptTicket' }>): string | null {
  if (rows.some((t) => t.day === intent.day && t.subnet === intent.subnet && t.index === intent.index)) return 'already accepted';
  if (rows.filter((t) => t.status === 'OPEN').length >= OPEN_TICKETS_MAX) return `at most ${OPEN_TICKETS_MAX} open tickets`;
  if (rows.filter((t) => t.day === intent.day).length >= TICKETS_PER_DAY) return `at most ${TICKETS_PER_DAY} tickets per day`;
  return null;
}

/** The ticket part of an operator record from its rows (`rows`: every OPEN row and every row of `day`). */
export function ticketState(
  rows: ReadonlyArray<Omit<TicketRow, 'operatorId' | 'acceptedAt' | 'completedAt'>>,
  day: string,
): Pick<OperatorRecord, 'tickets' | 'ticketsToday' | 'ticketsDay' | 'acceptedToday'> {
  const todays = rows.filter((t) => t.day === day);
  return {
    tickets: rows
      .filter((t) => t.status === 'OPEN')
      .map(
        (t): OpenTicket => ({
          id: t.id, day: t.day, subnet: t.subnet, index: t.index, kind: t.kind, params: structuredClone(t.params), target: t.target, reward: t.reward,
          progress: t.progress, pending: false, completing: false,
        }),
      ),
    ticketsToday: todays.length,
    ticketsDay: day,
    acceptedToday: todays.map((t) => ticketKey(t.day, t.subnet, t.index)),
  };
}

export interface TicketRow {
  id: string;
  operatorId: string;
  day: string;
  subnet: string;
  index: number;
  kind: TicketKind;
  params: TicketParams;
  target: number;
  reward: number;
  progress: number;
  status: 'OPEN' | 'DONE' | 'ABANDONED';
  acceptedAt: string;
  completedAt: string | null;
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

/**
 * What a checkpoint writes to a RAM daemon row. A held item moves between the daemon and the inventory (hold / unhold),
 * so it is written only together with the inventory: on an `inventoryInFlight` record both are left to the store.
 */
export function checkpointFields(d: OwnedDaemonRecord, inventoryInFlight: boolean | undefined) {
  const { heldItem, ...rest } = stateFields(d);
  return inventoryInFlight ? rest : { ...rest, heldItem };
}

interface MemDaemon extends OwnedDaemonRecord {
  operatorId: string;
  location: 'RAM' | 'DISK';
  /** `listing:<id>` / `trade:<id>` while on the Exchange (the api sets it): `load` refuses the daemon. */
  lockedBy?: string | null;
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
  readonly tickets = new Map<string, TicketRow>();
  /** `${operatorId}:${line}` -> points */
  readonly research = new Map<string, number>();
  readonly chat: ChatRow[] = [];
  readonly filterHits: Array<{ operatorId: string; channel: string; text: string; term: string }> = [];
  /** `${blockerId}:${blockedId}` */
  readonly blocks = new Set<string>();
  readonly filterTerms: FilterTerm[] = [];
  /** operatorId -> mutedUntil (ISO) or null */
  readonly mutes = new Map<string, string | null>();
  /** operatorId -> org membership (the api's OrgMember rows; tests set it). */
  readonly orgs = new Map<string, OrgView>();
  /** Exchange vault rows, `${operatorId}:${item}` -> qty (mirrors ExchangeVault; an emptied row is deleted). */
  readonly vault = new Map<string, number>();
  /** Incident rows by id (mirrors the Incident table). */
  readonly incidents = new Map<string, IncidentRow & { closedAt: string | null }>();
  /** BitsLedger ids and seqs, parallel to `ledger` (kept apart so `ledger` stays in the LedgerRow shape). */
  private readonly ledgerKeys: Array<{ id: string; seq: number }> = [];
  private lastLedgerSeq = 0;
  /** Wall clock for "today" (tests pin it). */
  now: () => string = () => new Date().toISOString();
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  private researchFor(operatorId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, points] of this.research) if (key.startsWith(`${operatorId}:`)) out[key.slice(operatorId.length + 1)] = points;
    return out;
  }

  /** Mirrors PrismaStore's INSERT ... ON CONFLICT increment; returns the line's new total. */
  private addResearch(operatorId: string, species: string): number {
    const key = `${operatorId}:${getSpecies(species).line}`;
    const points = (this.research.get(key) ?? 0) + 1;
    this.research.set(key, points);
    return points;
  }

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  /** Appends a ledger row (mirrors BitsLedger's uuid id and autoincrement seq). */
  private addLedger(row: LedgerRow): { id: string; seq: number } {
    const key = { id: crypto.randomUUID(), seq: ++this.lastLedgerSeq };
    this.ledger.push(row);
    this.ledgerKeys.push(key);
    return key;
  }

  /** Appends the ledger row of a store intent (its reason checked against SIM_INTENT_LEDGER_REASONS). */
  private addIntentLedger<K extends SimLedgerKind>(kind: K, row: Omit<LedgerRow, 'reason'> & { reason: SimLedgerReason<K> }): void {
    this.addLedger({ ...row, reason: intentLedgerReason(kind, row.reason) });
  }

  private maxLedgerSeq(operatorId: string): number {
    let max = 0;
    this.ledger.forEach((l, i) => {
      if (l.operatorId === operatorId) max = Math.max(max, this.ledgerKeys[i]!.seq);
    });
    return max;
  }

  private orgOf(operatorId: string): OrgView | null {
    const o = this.orgs.get(operatorId);
    return o ? { ...o } : null;
  }

  async liveState(after: ReadonlyMap<string, number>): Promise<Map<string, LiveOperatorState>> {
    const out = new Map<string, LiveOperatorState>();
    for (const [id, seq] of after) {
      const op = this.operators.get(id);
      if (!op) continue;
      const diskSlots = [...this.daemons.values()].filter((d) => d.operatorId === id && d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b);
      const state: LiveOperatorState = { name: op.name, org: this.orgOf(id), ledgerSeq: seq, ledger: [], diskSlots };
      this.ledger.forEach((l, i) => {
        const key = this.ledgerKeys[i]!;
        if (l.operatorId !== id || key.seq <= seq) return;
        state.ledgerSeq = Math.max(state.ledgerSeq, key.seq);
        if (!SIM_LEDGER_REASONS.has(l.reason)) state.ledger.push({ id: key.id, seq: key.seq, delta: l.delta, reason: l.reason });
      });
      out.set(id, state);
    }
    return out;
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<LoadedOperator> {
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
      ram: mine.filter((d) => d.location === 'RAM').sort((a, b) => a.slot - b.slot).map(({ operatorId: _o, location: _l, lockedBy: _k, ...rec }) => ({ ...rec })),
      diskSlots: mine.filter((d) => d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b),
      ...this.ticketStateOf(op.id),
      research: this.researchFor(op.id),
      mutedUntil: this.mutes.get(op.id) ?? null,
      org: this.orgOf(op.id),
      ledgerSeq: this.maxLedgerSeq(op.id),
    };
  }

  async appendChat(row: ChatRow): Promise<void> {
    // Mirrors the ChatMessage primary key.
    if (this.chat.some((c) => c.id === row.id)) throw new Error(`duplicate chat id ${row.id}`);
    this.chat.push({ ...row });
  }

  async recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void> {
    this.filterHits.push({ ...hit });
  }

  async setMute(operatorId: string, until: string | null): Promise<void> {
    this.mutes.set(operatorId, until);
  }

  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    return this.blocks.has(`${blocker}:${blocked}`);
  }

  async operatorExists(operatorId: string): Promise<boolean> {
    return this.operators.has(operatorId);
  }

  async listFilterTerms(): Promise<FilterTerm[]> {
    return this.filterTerms.map((t) => ({ ...t }));
  }

  async mutedUntil(operatorIds: readonly string[]): Promise<Map<string, string | null>> {
    return new Map(operatorIds.filter((id) => this.operators.has(id)).map((id) => [id, this.mutes.get(id) ?? null]));
  }

  private ticketStateOf(operatorId: string) {
    const day = dayKey(this.now());
    return ticketState(
      this.ticketRows(operatorId).filter((t) => t.status === 'OPEN' || t.day === day),
      day,
    );
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated store failure');
    }
    if (this.applied.has(intent.id)) {
      if (intent.kind === 'load') {
        const d = this.daemons.get(intent.daemonId)!;
        const { operatorId: _o, location: _l, lockedBy: _k, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      if (intent.kind === 'capture' || intent.kind === 'claimStarter') {
        return { ok: true, research: this.research.get(`${intent.operatorId}:${getSpecies(intent.daemon.species).line}`) ?? 0 };
      }
      if (intent.kind === 'incidentReward') {
        const seq = this.incidentLedgerSeq(intent.operatorId, intent.incidentId);
        return seq === null ? { ok: true } : { ok: true, ledgerSeq: seq };
      }
      return { ok: true };
    }
    const op = this.operators.get(intent.operatorId);
    if (!op) throw new Error(`unknown operator ${intent.operatorId}`);
    switch (intent.kind) {
      case 'claimStarter': {
        // Mirrors PrismaStore's conditional update (where starterClaimed = false).
        if (op.starterClaimed) return { ok: false, reason: 'starter already claimed' };
        if ([...this.operators.values()].some((o) => o.name === intent.name && o.id !== op.id)) return { ok: false, reason: 'name taken' };
        if (this.slotTaken(op.id, 'RAM', intent.daemon.slot)) return { ok: false, reason: 'starter already claimed' };
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: 'RAM' });
        const research = this.addResearch(op.id, intent.daemon.species);
        this.applied.add(intent.id);
        return { ok: true, research };
      }
      case 'capture': {
        // Mirrors the Daemon (operatorId, location, slot) unique constraint.
        if (this.slotTaken(op.id, intent.location, intent.daemon.slot)) return { ok: false, reason: intent.location === 'DISK' ? DISK_SLOT_TAKEN : 'slot taken' };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: intent.location });
        const research = this.addResearch(op.id, intent.daemon.species);
        this.applied.add(intent.id);
        return { ok: true, research };
      }
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM') return { ok: false, reason: 'daemon not found' };
        // Mirrors the Daemon (operatorId, location, slot) unique constraint (an Exchange purchase may hold the slot).
        if (this.slotTaken(op.id, 'DISK', intent.diskSlot)) return { ok: false, reason: DISK_SLOT_TAKEN };
        Object.assign(d, ctx.storedDaemon ? stateFields(ctx.storedDaemon) : {}, { location: 'DISK', slot: intent.diskSlot });
        break;
      }
      case 'load': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'DISK') return { ok: false, reason: 'not on Disk' };
        if (d.lockedBy) return { ok: false, reason: 'locked on the Exchange' };
        const diskSlot = d.slot;
        d.location = 'RAM';
        d.slot = intent.ramSlot;
        this.applied.add(intent.id);
        const { operatorId: _o, location: _l, lockedBy: _k, ...rec } = d;
        return { ok: true, daemon: { ...rec }, diskSlot };
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
        this.addIntentLedger(intent.kind, { operatorId: op.id, delta: -intent.price, reason: ledgerReason(intent), ref: intent.id, at: new Date().toISOString() });
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
        this.addIntentLedger(intent.kind, { operatorId: op.id, delta: -intent.bits, reason: ledgerReason(intent), ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'decompile': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM' || d.species !== intent.species) return { ok: false, reason: 'daemon not found' };
        const problem = decompileProblem(intent, d, ctx.storedDaemon);
        if (problem) return { ok: false, reason: problem };
        const state = ctx.storedDaemon ? stateFields(ctx.storedDaemon) : stateFields(d);
        this.daemons.delete(d.id);
        // The archive has no lock column (mirrors DaemonArchive).
        const { lockedBy: _k, ...unlocked } = d;
        this.archive.set(d.id, { ...unlocked, ...state, history: [...state.history, intent.history], reason: 'decompiled', archivedAt: new Date().toISOString() });
        op.inventory = withItems(op.inventory, decompileStoreGain(d, ctx.storedDaemon), 1);
        break;
      }
      case 'vault': {
        // Mirrors PrismaStore: rules check, then (under the operator lock there) inventory and vault row together.
        const problem = economyIntentProblem(intent, op.diskCapacity);
        if (problem) return { ok: false, reason: problem };
        const key = `${op.id}:${intent.item}`;
        const have = this.vault.get(key) ?? 0;
        if (intent.qty < 0 && have < -intent.qty) return { ok: false, reason: 'not enough in the vault' };
        // The world took a deposit out of its inventory at accept; the stored inventory must hold it too.
        if (intent.qty > 0 && missingItem(op.inventory, { [intent.item]: intent.qty })) return { ok: false, reason: DEPOSIT_NOT_SAVED };
        op.inventory = withItems(op.inventory, { [intent.item]: Math.abs(intent.qty) }, intent.qty > 0 ? -1 : 1);
        if (have + intent.qty === 0) this.vault.delete(key);
        else this.vault.set(key, have + intent.qty);
        break;
      }
      case 'acceptTicket': {
        const problem = ticketAcceptProblem(intent, this.now()) ?? ticketCapProblem(this.ticketRows(op.id), intent);
        if (problem) return { ok: false, reason: problem };
        // Mirrors the Ticket primary key (a second row with this id is an error, not a domain answer).
        if (this.tickets.has(intent.ticketId)) throw new Error(`duplicate ticket id ${intent.ticketId}`);
        this.tickets.set(intent.ticketId, {
          id: intent.ticketId, operatorId: op.id, day: intent.day, subnet: intent.subnet, index: intent.index, kind: intent.ticketKind, params: structuredClone(intent.params),
          target: intent.target, reward: intent.reward, progress: 0, status: 'OPEN', acceptedAt: this.now(), completedAt: null,
        });
        break;
      }
      case 'abandonTicket': {
        const t = this.tickets.get(intent.ticketId);
        if (!t || t.operatorId !== op.id || t.status !== 'OPEN') return { ok: false, reason: 'no open ticket' };
        t.status = 'ABANDONED';
        break;
      }
      case 'completeTicket': {
        const t = this.tickets.get(intent.ticketId);
        if (!t || t.operatorId !== op.id || t.status !== 'OPEN') return { ok: false, reason: 'no open ticket' };
        if (t.reward !== intent.reward) return { ok: false, reason: 'reward does not match the ticket' };
        t.status = 'DONE';
        t.progress = t.target;
        t.completedAt = this.now();
        op.bits += intent.reward;
        this.addIntentLedger(intent.kind, { operatorId: op.id, delta: intent.reward, reason: 'ticket', ref: intent.ticketId, at: this.now() });
        break;
      }
      case 'incidentReward': {
        // Mirrors PrismaStore: rules check, then (under the operator lock there) the row and the ledger, all or nothing.
        const problem = incidentRewardProblem(intent);
        if (problem) return { ok: false, reason: problem };
        const row = this.incidents.get(intent.incidentId);
        if (row?.outcome === 'EXPIRED') return { ok: false, reason: 'the Incident expired' };
        if (row?.outcome === 'CLEARED' && !samePayouts(row.participants, intent.participants)) return { ok: false, reason: 'payouts do not match the Incident' };
        // One payout per (Incident, operator), whatever the intent id.
        if (this.incidentLedgerSeq(op.id, intent.incidentId) !== null) return { ok: false, reason: 'already paid' };
        const participants = intent.participants.map((p) => ({ ...p }));
        if (!row) {
          this.incidents.set(intent.incidentId, { id: intent.incidentId, n: intent.n, species: intent.species, openedAt: intent.openedAt, endsAt: intent.endsAt, outcome: 'CLEARED', participants, closedAt: this.now() });
        } else if (row.outcome === 'OPEN') {
          Object.assign(row, { outcome: 'CLEARED', participants, closedAt: this.now() });
        }
        op.bits += intent.reward;
        this.addIntentLedger(intent.kind, { operatorId: op.id, delta: intent.reward, reason: 'incident', ref: intent.incidentId, at: this.now() });
        this.applied.add(intent.id);
        return { ok: true, ledgerSeq: this.lastLedgerSeq };
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  /** Seq of the operator's `incident` ledger row for this Incident, or null when it was not paid. */
  private incidentLedgerSeq(operatorId: string, incidentId: string): number | null {
    const i = this.ledger.findIndex((l) => l.operatorId === operatorId && l.reason === 'incident' && l.ref === incidentId);
    return i < 0 ? null : this.ledgerKeys[i]!.seq;
  }

  async recordIncident(row: IncidentRow): Promise<void> {
    const cur = this.incidents.get(row.id);
    const closedAt = row.outcome === 'OPEN' ? null : this.now();
    const fields = { n: row.n, species: row.species, endsAt: row.endsAt, outcome: row.outcome, participants: row.participants.map((p) => ({ ...p })), closedAt };
    if (!cur) this.incidents.set(row.id, { id: row.id, openedAt: incidentOpenedAt(row), ...fields });
    else if (cur.outcome === 'OPEN') Object.assign(cur, fields);
  }

  async markIncidentPayoutRefused(incidentId: string, operatorId: string): Promise<void> {
    const p = this.incidents.get(incidentId)?.participants.find((x) => x.operatorId === operatorId);
    if (p) p.refused = true;
  }

  async recoverIncidents(): Promise<IncidentRewardIntent[]> {
    const since = Date.parse(this.now()) - INCIDENT_RECOVERY_MS;
    const out: IncidentRewardIntent[] = [];
    for (const row of this.incidents.values()) {
      if (row.outcome === 'OPEN') Object.assign(row, { outcome: 'EXPIRED', closedAt: this.now() });
      else if (row.outcome === 'CLEARED' && row.closedAt !== null && Date.parse(row.closedAt) >= since) {
        for (const p of unpaidParticipants(row, (id) => this.incidentLedgerSeq(id, row.id) !== null)) out.push(incidentRewardIntent(row, p));
      }
    }
    return out;
  }

  private ticketRows(operatorId: string): TicketRow[] {
    return [...this.tickets.values()].filter((t) => t.operatorId === operatorId);
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
        if (row && row.operatorId === op.id && row.location === 'RAM' && row.species === d.species) Object.assign(row, checkpointFields(d, rec.inventoryInFlight));
      }
      for (const t of rec.tickets) {
        const row = this.tickets.get(t.id);
        // Only an OPEN row's progress, and never lowered (a completion already set it to the target).
        if (row && row.operatorId === op.id && row.status === 'OPEN' && row.progress < t.progress) row.progress = Math.min(row.target, t.progress);
      }
    }
  }

  async listDiscoveries(): Promise<string[]> {
    return [...this.discoveries.keys()];
  }

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<LedgerWrite> {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new RangeError(`invalid bits delta ${delta}`);
    assertGrantReason(reason);
    const op = this.operators.get(operatorId);
    if (!op) throw new Error(`unknown operator ${operatorId}`);
    if (op.bits + delta < 0) throw new RangeError('not enough bits');
    op.bits += delta;
    const key = this.addLedger({ operatorId, delta, reason, ref: ref ?? null, at: new Date().toISOString() });
    return { ...key, balance: op.bits };
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
