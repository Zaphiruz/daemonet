import type { Behaviour, StatBlock, StatusId, ToolId, TypeId, Challenge } from '@daemonet/rules';
import type { Command, ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';

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
}

/** What the runtime loads from the DB when an operator connects. */
export interface OperatorRecord {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  x: number;
  y: number;
  bits: number;
  inventory: Record<string, number>;
  ram: OwnedDaemonRecord[];
  /** Occupied Disk slots (0-255). */
  diskSlots: number[];
}

export interface WildState {
  behaviour: Behaviour;
  region: number;
  spawnIndex: number;
  tagOwner: string | null;
  tagUntil: number;
  hardenedUntil: number;
  /** Id of the entity (daemon or operator) this wild daemon is attacking. */
  aggro: string | null;
  fleeUntil: number;
  /** Owned daemon ids that damaged it while tagged (for XP). */
  damagedBy: Set<string>;
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
  /** Owned daemon locked by a pending store intent. */
  pending: boolean;
  wild: WildState | null;
}

export interface Operator {
  id: string;
  name: string | null;
  starterClaimed: boolean;
  x: number;
  y: number;
  path: Point[];
  bits: number;
  inventory: Record<string, number>;
  /** Daemon ids in RAM (owned daemons live in World.daemons). */
  ram: string[];
  running: string[];
  diskSlots: Set<number>;
  /** RAM slots reserved by pending load intents. */
  reservedSlots: Set<number>;
  swapReadyTick: number;
  captureId: string | null;
  restoreUntil: number | null;
  hitTick: number;
  pendingClaim: boolean;
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
  | { id: string; kind: 'load'; operatorId: string; reqId: string; daemonId: string; ramSlot: number };

export type IntentResult = { ok: true; daemon?: OwnedDaemonRecord } | { ok: false; reason: string };

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
