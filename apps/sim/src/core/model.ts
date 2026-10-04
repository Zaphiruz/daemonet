import type { Behaviour, EvolutionChange, StatBlock, StatusId, TicketKind, TicketParams, ToolId, TypeId, Challenge } from '@daemonet/rules';
import type { Command, ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';

/** One line of a daemon's life story (SP3a spec §7). `at` is an ISO timestamp. */
export interface HistoryEntry {
  at: string;
  /** `traded`: the daemon changed hands on the Exchange (written by the api's sale). */
  kind: 'captured' | 'evolved' | 'clean' | 'signature' | 'patched' | 'decompiled' | 'traded';
  detail: string;
}

/**
 * The store's answer to a `store` or a capture to Disk whose Disk slot is already occupied: a daemon arrived there
 * outside the sim (an Exchange purchase) before the world heard of it. The refused intent rolled back entirely; the
 * slot really is taken, so the world keeps it marked (the runtime then re-reads the Disk from the store).
 */
export const DISK_SLOT_TAKEN = 'that Disk slot was just taken; try again';

/** A daemon as persisted (RAM or Disk). Arrays are in STAT_KEYS order. */
export interface OwnedDaemonRecord {
  id: string;
  species: string;
  level: number;
  xp: number;
  nature: number;
  traitSlot: 0 | 1;
  ivs: number[];
  bonus: number[];
  clean: boolean;
  signature: number;
  hp: number;
  energy: number;
  moves: string[];
  crashed: boolean;
  /** RAM slot 0-7. */
  slot: number;
  heldItem: string | null;
  /** Ever touched by a Bit Flipper: can never become a clean image. */
  patched: boolean;
  /** Lifetime move uses per type, TYPES order (16). */
  moveTypeUses: number[];
  crashes: number;
  arenaWins: number;
  history: HistoryEntry[];
  originalOperatorId: string | null;
}

/** A cluster as one member sees it (the runtime's ClusterService writes it onto the operator). */
export interface ClusterView {
  id: string;
  code: string;
  leaderId: string;
  members: Array<{ id: string; name: string | null; subnet: string | null; away: boolean }>;
}

/** An operator's org (SP4 spec §7) and its rank there. */
export interface OrgView {
  id: string;
  name: string;
  tag: string;
  rank: 'OWNER' | 'OFFICER' | 'MEMBER';
}

/**
 * Who a tag belongs to (SP4 spec §6): the cluster while the operator is in one, otherwise the operator.
 * Everything that used to compare `tagOwner` with an operator id compares party keys instead.
 */
export function partyKey(op: { id: string; cluster: ClusterView | null }): string {
  return op.cluster ? `cluster:${op.cluster.id}` : op.id;
}

/** An accepted, still-open ticket as the sim tracks it. */
export interface OpenTicket {
  id: string;
  day: string;
  subnet: string;
  index: number;
  kind: TicketKind;
  params: TicketParams;
  target: number;
  reward: number;
  progress: number;
  /** Waiting for the accept / abandon intent. */
  pending: boolean;
  /** Completion intent in flight. */
  completing: boolean;
}

/** What the runtime loads from the DB when an operator connects. */
export interface OperatorRecord {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  /** Subnet the operator was last in (the runtime picks the world). */
  subnet: string;
  x: number;
  y: number;
  bits: number;
  /** Disk slots owned (DISK_BASE + DISK_STEP per expansion). */
  diskCapacity: number;
  inventory: Record<string, number>;
  ram: OwnedDaemonRecord[];
  /** Occupied Disk slots (0-255). */
  diskSlots: number[];
  /** Open tickets (with progress) and today's accepted count. */
  tickets: OpenTicket[];
  ticketsToday: number;
  /** UTC day `ticketsToday` counts (YYYY-MM-DD). */
  ticketsDay: string;
  /** Keys (day:subnet:index) of every ticket accepted today, open or not. */
  acceptedToday: string[];
  /** Codex research points per bestiary line. */
  research: Record<string, number>;
  /** Chat mute (ISO) or null. */
  mutedUntil: string | null;
  /** The operator's org, or null (loaded with the record; never written by checkpoints). */
  org: OrgView | null;
  /**
   * Set on checkpoint records while an intent that rewrites the inventory in the store (buy, craft, decompile, vault,
   * claimStarter) is in flight: the store must leave `inventory` alone so it can neither rewind a committed intent
   * nor persist the world's not-yet-committed view of it. The next checkpoint after it settles writes it.
   */
  inventoryInFlight?: boolean;
}

export interface WildState {
  behaviour: Behaviour;
  region: number;
  spawnIndex: number;
  /** Party key (`partyKey`) of whoever holds the tag: never compare it with a bare operator id. */
  tagOwner: string | null;
  tagUntil: number;
  hardenedUntil: number;
  /** Id of the entity (daemon or operator) this wild daemon is attacking. */
  aggro: string | null;
  fleeUntil: number;
  /** Owned daemon ids that damaged it while tagged (for XP). */
  damagedBy: Set<string>;
  /** Incident boss. */
  boss?: boolean;
  /** Anyone may hit it and nobody owns its tag (boss and its adds); immune to capture. */
  open?: boolean;
  /**
   * A personal boss copy: only this operator may hit or capture it (never its cluster mates). Its `tagOwner` is the
   * unmatchable key `personal:<id>`, so no party key ever holds, releases or re-keys it.
   */
  personal?: string;
  /** Removed at this tick unless a capture is in progress. */
  despawnAtTick?: number;
}

/** One contributor of a cleared Incident, as recorded on the Incident row and carried by every reward intent. */
export interface IncidentParticipant {
  operatorId: string;
  name: string | null;
  /** Damage dealt to the boss (whole HP). */
  damage: number;
  share: number;
  /** 0 for a contributor under the minimum share (recorded, never paid). */
  reward: number;
  /** Store-side marker on the Incident row: the payout was refused definitively (boot recovery skips it). */
  refused?: boolean;
}

/** A running Incident (kernelspace world only). */
export interface IncidentState {
  id: string;
  n: number;
  species: string;
  phase: 'open' | 'fighting';
  bossId: string;
  openedAtMs: number;
  endsAtMs: number;
  /** Boss immune until its adds are cleared. */
  shield: boolean;
  /** Index into BOSS_PHASES of the next threshold. */
  nextPhase: number;
  adds: string[];
  /** operator id -> damage dealt to the boss. */
  damage: Map<string, number>;
  nextTelegraphTick: number;
  telegraph: { x: number; y: number; radius: number; atTick: number } | null;
}

export interface Daemon {
  id: string;
  species: string;
  types: readonly TypeId[];
  level: number;
  xp: number;
  nature: number;
  traitSlot: 0 | 1;
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  moves: string[];
  stats: StatBlock;
  hp: number;
  energy: number;
  crashed: boolean;
  /** null = wild. */
  ownerId: string | null;
  /** RAM slot for owned daemons. */
  slot: number;
  /** In the world (wild, or owned and running). */
  active: boolean;
  x: number;
  y: number;
  path: Point[];
  /** move id -> tick when ready. */
  cooldowns: Record<string, number>;
  statuses: Partial<Record<StatusId, number>>;
  lastCombatTick: number;
  /** Owned daemon locked by a pending store, evolve or decompile intent. */
  pending: boolean;
  wild: WildState | null;
  /** Trait id (ROLE_TRAITS[species.role][traitSlot]). */
  trait: string;
  heldItem: string | null;
  patched: boolean;
  moveTypeUses: number[];
  crashes: number;
  arenaWins: number;
  history: HistoryEntry[];
  originalOperatorId: string | null;
  /** Per-engagement trait state; reset when the daemon activates or a battle starts. */
  engagement: Engagement;
}

export interface Engagement {
  /** lowlatency: next move ignores its cooldown. */
  freeMove: boolean;
  /** bitshield: the first hit has been blocked. */
  blocked: boolean;
  /** nullsafe: the lethal hit has been survived. */
  survived: boolean;
  /** salted: move id of the last hit taken. */
  lastHitMove: string | null;
}

export function freshEngagement(): Engagement {
  return { freeMove: true, blocked: false, survived: false, lastHitMove: null };
}

export interface Operator {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  x: number;
  y: number;
  path: Point[];
  bits: number;
  diskCapacity: number;
  inventory: Record<string, number>;
  /** Daemon ids in RAM (owned daemons live in World.daemons). */
  ram: string[];
  running: string[];
  diskSlots: Set<number>;
  /**
   * Bumped whenever an intent that changes Disk occupancy (store, capture to Disk, load) is tracked or completed. Not
   * persisted: the runtime's Disk resync compares it around its store read and drops a read that may predate one.
   */
  diskIntentGen: number;
  /** RAM slots reserved by pending load intents. */
  reservedSlots: Set<number>;
  swapReadyTick: number;
  captureId: string | null;
  restoreUntil: number | null;
  hitTick: number;
  pendingClaim: boolean;
  /** Locked by a pending travel intent. */
  travelling: boolean;
  tickets: OpenTicket[];
  ticketsToday: number;
  ticketsDay: string;
  acceptedKeys: Set<string>;
  research: Record<string, number>;
  /** Chat mute as loaded with the record (the runtime's chat service owns the live value). */
  mutedUntil: string | null;
  /** Set by the runtime's cluster service; null when solo. Not persisted. */
  cluster: ClusterView | null;
  /** The operator's org: loaded with the record and kept current by the runtime over the bus. */
  org: OrgView | null;
}

export interface Capture {
  id: string;
  operatorId: string;
  targetId: string;
  tool: ToolId;
  challenge: Challenge;
  deadlineTick: number;
  state: 'open' | 'committing';
}

export interface CaptureLog {
  originalOperatorId: string;
  capturedAtTick: number;
  subnet: string;
  tool: ToolId | 'starter';
  seedId: string;
  spawnIndex: number | null;
}

export type Intent =
  | { id: string; kind: 'claimStarter'; operatorId: string; reqId: string; name: string; daemon: OwnedDaemonRecord; inventory: Record<string, number>; log: CaptureLog }
  | { id: string; kind: 'capture'; operatorId: string; captureId: string; daemon: OwnedDaemonRecord; location: 'RAM' | 'DISK'; tool: ToolId; log: CaptureLog }
  | { id: string; kind: 'store'; operatorId: string; reqId: string; daemonId: string; diskSlot: number }
  | { id: string; kind: 'load'; operatorId: string; reqId: string; daemonId: string; ramSlot: number }
  | {
      id: string;
      kind: 'evolve';
      operatorId: string;
      reqId: string;
      daemonId: string;
      /** The daemon's level when the intent was created (a level-up before completion changes moves and HP). */
      level: number;
      from: string;
      to: string;
      ivs: number[];
      bonus: number[];
      clean: boolean;
      signature: number;
      heldItem: string | null;
      moves: string[];
      hp: number;
      changes: EvolutionChange[];
      history: HistoryEntry[];
    }
  | { id: string; kind: 'travel'; operatorId: string; reqId: string; gatewayId: string; from: string; to: string; x: number; y: number }
  /** Shop purchase (or a Disk expansion when itemId is 'diskExpansion'); `price` is the total in bits. */
  | { id: string; kind: 'buy'; operatorId: string; reqId: string; itemId: string; qty: number; price: number }
  | {
      id: string;
      kind: 'craft';
      operatorId: string;
      reqId: string;
      recipeId: string;
      qty: number;
      /** The fragment type chosen for an `any` slot. */
      using?: TypeId;
      bits: number;
      fragments: Record<string, number>;
      output: { item: string; qty: number };
    }
  /** `fragments` also carries the daemon's held item (it returns to the inventory). */
  | { id: string; kind: 'decompile'; operatorId: string; reqId: string; daemonId: string; species: string; fragments: Record<string, number>; history: HistoryEntry }
  /** Exchange vault (SP5): `qty` > 0 deposits from the inventory, < 0 withdraws into it. */
  | { id: string; kind: 'vault'; operatorId: string; reqId: string; item: string; qty: number }
  | {
      id: string;
      kind: 'acceptTicket';
      operatorId: string;
      reqId: string;
      ticketId: string;
      day: string;
      subnet: string;
      index: number;
      ticketKind: TicketKind;
      params: TicketParams;
      target: number;
      reward: number;
    }
  | { id: string; kind: 'abandonTicket'; operatorId: string; reqId: string; ticketId: string }
  /** Raised by the sim itself (no reqId): pays the reward and closes the row. */
  | { id: string; kind: 'completeTicket'; operatorId: string; ticketId: string; reward: number }
  /**
   * Raised by the sim itself when an Incident is cleared: pays one contributor. The id is derived from the incident and
   * the operator (`incidentRewardId`), and every intent of one Incident carries the whole payout list, so the store can
   * record the Incident row with its participants in the same transaction and re-derive the reward from the rules.
   */
  | {
      id: string;
      kind: 'incidentReward';
      operatorId: string;
      incidentId: string;
      n: number;
      species: string;
      /** ISO start and end of the Incident window (the row is created from the intent when it is missing). */
      openedAt: string;
      endsAt: string;
      reward: number;
      damage: number;
      share: number;
      participants: IncidentParticipant[];
    };

/** The one intent id of an Incident payout to `operatorId`: a replay, a retry or a resumed payout all carry it. */
export function incidentRewardId(incidentId: string, operatorId: string): string {
  return `${incidentId}:reward:${operatorId}`;
}

/**
 * Shop, crafting, decompile and Exchange vault moves: intents that spend bits or rewrite the operator's inventory in the
 * store (costs taken at accept, gains applied on commit; `completeEconomyIntent`).
 */
export const SHOP_INTENTS = ['buy', 'craft', 'decompile', 'vault'] as const;
export type ShopIntent = Extract<Intent, { kind: (typeof SHOP_INTENTS)[number] }>;

/**
 * Intent kinds that move bits, the inventory or tickets in the store (SP3b economy contract). Each is serialized behind
 * every earlier store write, retried (same id) until the store answers definitively, and awaited by a leave.
 */
export const ECONOMY_INTENTS = [...SHOP_INTENTS, 'acceptTicket', 'abandonTicket', 'completeTicket', 'incidentReward'] as const;
export type EconomyIntent = Extract<Intent, { kind: (typeof ECONOMY_INTENTS)[number] }>;

export function isEconomyIntent(intent: Intent): intent is EconomyIntent {
  return (ECONOMY_INTENTS as readonly string[]).includes(intent.kind);
}

/**
 * Intents that rewrite the operator's inventory (or a held item) in the store: while one is pending, checkpoints leave
 * the inventory to the store (`OperatorRecord.inventoryInFlight`). Ticket intents never touch the inventory.
 */
export function isInventoryIntent(intent: Intent): boolean {
  return (SHOP_INTENTS as readonly string[]).includes(intent.kind) || intent.kind === 'claimStarter';
}

export type TicketIntent = Extract<Intent, { kind: 'acceptTicket' | 'abandonTicket' | 'completeTicket' }>;

export function isTicketIntent(intent: Intent): intent is TicketIntent {
  return intent.kind === 'acceptTicket' || intent.kind === 'abandonTicket' || intent.kind === 'completeTicket';
}

/**
 * `discovered`: an evolve intent created the first Discovery row for its form. `research`: for capture / claimStarter,
 * the daemon's line's research points in the store after the commit (also on a replay), so a replayed completion never
 * counts the point twice.
 */
export type IntentResult =
  | {
      ok: true;
      daemon?: OwnedDaemonRecord;
      discovered?: boolean;
      research?: number;
      /**
       * incidentReward: seq of the payout's ledger row (also on a replay), so the runtime can tell whether a balance it
       * loaded already contains it.
       */
      ledgerSeq?: number;
    }
  | { ok: false; reason: string };

export interface Input {
  operatorId: string;
  reqId: string;
  command: Command;
}

export type Reply =
  | { operatorId: string; reqId: string; ok: true; result?: unknown }
  | { operatorId: string; reqId: string; ok: false; code: ErrorCode; message: string };

/** `to` = one operator only; otherwise public: everyone within interest radius of `at`, or everyone if `at` is null. */
export interface ScopedEvent {
  event: GameEvent;
  to: string | null;
  at: Point | null;
}

export interface StepResult {
  tick: number;
  events: ScopedEvent[];
  replies: Reply[];
  intents: Intent[];
}

export class Rejection extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
