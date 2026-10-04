import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Bus } from '@daemonet/bus';
import { ARENA_START_RATING, INCIDENT_MAX_OPERATORS, INCIDENT_SUBNET, ticketKey } from '@daemonet/rules';
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Command, type Entity, type ErrorCode, type GameEvent, type ServerMessage } from '@daemonet/shared';
import {
  DISK_SLOT_TAKEN,
  EVICT_TO,
  INTEREST_RADIUS,
  distance,
  entitiesNear,
  isEconomyIntent,
  isInventoryIntent,
  toSelf,
  type Input,
  type Intent,
  type IntentResult,
  type Operator,
  type OperatorRecord,
  type OrgView,
  type World,
} from '../core/index.js';
import { ArenaService, isArenaError, type ArenaError } from './arena.js';
import type { TokenVerifier } from './auth.js';
import { ChatService } from './chat.js';
import { ClusterService, isClusterError, type ClusterError } from './clusters.js';
import { diffEntities } from './interest.js';
import { BitsPush, DiskPush, ExchangePush, exchangeView, IncidentStartPush, OrgMembershipPush, RenamePush } from './pushes.js';
import { randomHex, withItems, type IncidentRow, type Store } from './store.js';

/** Transport-independent connection. */
export interface Conn {
  readonly id: string;
  readonly ip: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

export const CLOSE = { auth: 4401, takeover: 4409, rate: 4429, timeout: 4408, unavailable: 4503, left: 4410 } as const;

export interface GameOptions {
  /** One world per hosted subnet; the first is the default (new operators, unknown subnets). */
  worlds?: readonly World[];
  /** Shorthand for a single world. */
  world?: World;
  store: Store;
  verify: TokenVerifier;
  /** Sim ⇄ api bus (MemoryBus when Redis is not configured). */
  bus: Bus;
  log?: Logger;
  /** Waits between intent persistence attempts (default 128/512/2048 ms). */
  retryDelaysMs?: readonly number[];
  /**
   * Attempts (default 32) and time (default 10 min) after which an intent whose outcome is still unknown stops being
   * retried: it stays unresolved and its operator is reloaded from the store (see `persist`).
   */
  unknownRetryLimit?: number;
  unknownRetryMs?: number;
  checkpointEveryTicks?: number;
  leaveAfterTicks?: number;
  authTimeoutTicks?: number;
  idleTimeoutTicks?: number;
  maxSpectators?: number;
}

type Role = 'controller' | 'spectator';

interface ConnState {
  conn: Conn;
  seq: number;
  phase: 'new' | 'authing' | 'ready' | 'closed';
  openedTick: number;
  lastSeenTick: number;
  bucket: number;
  sub: string | null;
  operatorId: string | null;
  role: Role | null;
  known: Map<string, Entity>;
  lastSelf: string | null;
  /** Keys of this connection's entries in `Game.replyTo`, removed when it detaches. */
  routes: Set<string>;
}

interface ReplyRoute {
  st: ConnState;
  /** The reqId the client sent (the world sees the connection-scoped key instead). */
  reqId: string;
}

interface Session {
  operatorId: string;
  sub: string;
  /** The world the operator is in right now (changes on travel). */
  world: World;
  controller: ConnState | null;
  spectators: Set<ConnState>;
  resumeToken: string;
  /** Deltas sent to the controller, for resume. */
  buffer: Array<{ tick: number; msg: Extract<ServerMessage, { t: 'delta' }> }>;
  /** Oldest client tick a resume can continue from (the snapshot tick, or just before the oldest buffered delta). */
  baseTick: number;
  /** What the last controller knew when it went away (resume continues from here). */
  savedKnown: Map<string, Entity> | null;
  savedSelf: string | null;
  commandsThisTick: number;
  violations: number[];
  leaveAtTick: number | null;
  /**
   * Set when an intent's outcome stayed unknown past the retry cap: the operator was kicked, refuses reconnects until it
   * has left, and its checkpoints skip the inventory so the next load takes the store as truth.
   */
  reloadRequired: boolean;
  /**
   * Ledger watermark of the world's balance: every BitsLedger row of the operator up to this seq is in it (the load's
   * `ledgerSeq`, advanced by resyncs). Rows written outside the sim above it are applied once, as deltas.
   */
  ledgerSeq: number;
  /**
   * The load's watermark, never advanced: the loaded balance holds exactly the ledger rows up to it (an Incident payout
   * committed above it is credited when it completes; one at or below it was already loaded).
   */
  loadSeq: number;
  /** Rows above the watermark already applied from a bus push (id -> seq), pruned when the watermark passes them. */
  ledgerApplied: Map<string, number>;
  /** Bumped by every org / rename push: a resync whose store read raced one does not overwrite it. */
  orgGen: number;
  nameGen: number;
  /** Bumped by every `disk` push: a resync whose store read raced one leaves Disk occupancy alone. */
  diskGen: number;
}

const BUCKET_MAX = 64;
const BUCKET_REFILL_PER_TICK = 2;
const VIOLATION_WINDOW_TICKS = 1024;
const MAX_VIOLATIONS = 256;
const SLOW_TICK_MS = 50;
const RECOVERED_TICK_MS = 25;

/** Longest wait between attempts while an intent's outcome is unknown (see `persist`). */
const MAX_RETRY_MS = 2048;
const UNKNOWN_RETRY_LIMIT = 32;
const UNKNOWN_RETRY_MS = 10 * 60_000;
/** Past the bounded retry schedule, only every WARN_EVERY-th failed attempt is logged. */
const WARN_EVERY = 8;
/** How long a committed Incident payout waits for its operator's session (it was mid-load when the payout landed). */
const PARKED_REWARD_MS = 10 * 60_000;
/** Kick reason when an operator must reconnect to reload its state from the store (transient in the SDK). */
export const RELOAD_KICK = 'reload required';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sameOrg = (a: OrgView | null, b: OrgView | null) => a === b || (a !== null && b !== null && a.id === b.id && a.name === b.name && a.tag === b.tag && a.rank === b.rank);

/** Bus message kinds this class handles on the `admin` channel (the chat service handles the others). */
const ADMIN_KINDS: ReadonlySet<unknown> = new Set(['bits', 'rename', 'incident:start', 'disk']);

/** What a Disk resync notes before its store read, to tell afterwards whether the read may be stale (`resyncDisk`). */
interface DiskMark {
  diskGen: number;
  world: World;
  op: Operator | null;
  diskIntentGen: number;
}

/** The Disk slots reserved by the operator's store and capture-to-Disk intents still waiting for the store. */
function pendingDiskSlots(world: World, operatorId: string): number[] {
  const out: number[] = [];
  for (const i of world.pendingIntents(operatorId)) {
    if (i.kind === 'store') out.push(i.diskSlot);
    else if (i.kind === 'capture' && i.location === 'DISK') out.push(i.daemon.slot);
  }
  return out;
}

/** Constant-time string comparison; different lengths never match. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Game {
  /** Hosted worlds by subnet id; all step once per game tick. */
  readonly worlds: Map<string, World>;
  /** New operators and operators of unhosted subnets start here. */
  readonly defaultWorld: World;
  /** The default world (tests, and callers that host one subnet). */
  readonly world: World;
  private readonly store: Store;
  private readonly verify: TokenVerifier;
  private readonly log: Logger;
  private readonly retryDelays: readonly number[];
  private readonly unknownRetryLimit: number;
  private readonly unknownRetryMs: number;
  private readonly checkpointEvery: number;
  private readonly leaveAfter: number;
  private readonly authTimeout: number;
  private readonly idleTimeout: number;
  private readonly maxSpectators: number;
  private readonly conns = new Map<string, ConnState>();
  private readonly sessions = new Map<string, Session>();
  private readonly leaving = new Map<string, Promise<void>>();
  /**
   * Committed Incident payouts of an operator that had no session when they landed (e.g. it was loading): the session
   * created next applies each one whose ledger row is above its load's watermark (the load did not contain it).
   */
  private readonly parkedRewards = new Map<string, Array<{ seq: number; intent: Extract<Intent, { kind: 'incidentReward' }>; at: number }>>();
  /** Operator loads in flight per sub; a leave marks them stale so they reload after its checkpoint. */
  private readonly loads = new Map<string, Set<{ stale: boolean }>>();
  private readonly inflight = new Set<Promise<void>>();
  private inputs: Input[] = [];
  /** Tail of the serialized store writes: every checkpoint, travel and economy intent, across all worlds (never rejects). */
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * Pending command replies keyed `conn.id:reqId` (the key is the reqId the world sees), so a later connection that
   * reuses a reqId never receives an earlier connection's reply.
   */
  private readonly replyTo = new Map<string, ReplyRoute>();
  private radius = INTEREST_RADIUS;
  private readonly tickMs: number[] = [];
  /** Game ticks so far (every world advances once per game tick). */
  private ticks = 0;
  /** Set by `shutdown`: intents whose outcome is still unknown stop retrying (they are left pending, never failed). */
  private stopping = false;
  /** Chat over the game socket (SP4): outside the tick, its own per-operator limit. */
  readonly chat: ChatService;
  /** Clusters (SP4): membership across worlds, outside the tick, never persisted. */
  readonly clusters: ClusterService;
  /**
   * Arena matches (SP6): queue, challenges and match worlds, outside the tick. Match worlds are never in `worlds`:
   * every lookup over the persistent worlds (checkpoints, discoveries, Incidents, travel) leaves them out by design.
   */
  readonly arena: ArenaService;
  private readonly unsubscribe: Array<() => void>;

  constructor(opts: GameOptions) {
    const worlds = opts.worlds ?? (opts.world ? [opts.world] : []);
    if (worlds.length === 0) throw new Error('Game needs at least one world');
    this.worlds = new Map(worlds.map((w) => [w.subnet.id, w]));
    if (this.worlds.size !== worlds.length) throw new Error('Game worlds must host distinct subnets');
    for (const w of worlds) {
      w.hosted = (subnet) => this.worlds.has(subnet);
      w.incidentRoom = (subnet) => this.incidentRoom(subnet);
    }
    this.defaultWorld = worlds[0]!;
    this.world = this.defaultWorld;
    this.store = opts.store;
    this.verify = opts.verify;
    this.log = opts.log ?? silent;
    this.retryDelays = opts.retryDelaysMs ?? [128, 512, 2048];
    this.unknownRetryLimit = opts.unknownRetryLimit ?? UNKNOWN_RETRY_LIMIT;
    this.unknownRetryMs = opts.unknownRetryMs ?? UNKNOWN_RETRY_MS;
    this.checkpointEvery = opts.checkpointEveryTicks ?? 512;
    this.leaveAfter = opts.leaveAfterTicks ?? 128;
    this.authTimeout = opts.authTimeoutTicks ?? 80;
    this.idleTimeout = opts.idleTimeoutTicks ?? 768;
    this.maxSpectators = opts.maxSpectators ?? 4;
    const operator = (id: string) => {
      const s = this.sessions.get(id);
      const op = s?.world.operators.get(id);
      return s && op ? { op, subnet: s.world.subnet.id } : undefined;
    };
    this.clusters = new ClusterService({
      operator,
      send: (operatorId, msg) => this.sendTo(operatorId, msg),
      // a party key that lost holders must not keep wild daemons locked in any world where nobody holds it
      releaseTags: (key) => {
        for (const w of this.worlds.values()) w.releaseOrphanTags(key);
      },
      rekeyTags: (from, to) => {
        for (const w of this.worlds.values()) w.rekeyTags(from, to);
      },
      now: () => Date.now(),
      // join codes must be unguessable
      random: () => randomInt(0x1_0000_0000) / 0x1_0000_0000,
    });
    this.chat = new ChatService(
      {
        operator,
        operatorIds: () => this.sessions.keys(),
        send: (operatorId, msg) => this.sendTo(operatorId, msg),
        clusterOf: (id) => this.clusters.of(id),
        orgOf: (id) => operator(id)?.op.org ?? undefined,
        // org membership, names and balances changed while the bus was down are re-read with the mutes
        resync: (ids) => this.resyncOperators(ids),
        // names are checked in the worlds (claimStarter) against the same filter as chat
        filterChanged: (filter) => {
          for (const w of this.worlds.values()) w.nameFilter = filter;
        },
        now: () => Date.now(),
      },
      this.store,
      opts.bus,
      this.log,
    );
    this.arena = new ArenaService({
      // only an operator in a persistent world (so never one already in a match) whose session is not being reloaded
      locate: (id) => {
        const s = this.sessions.get(id);
        const op = s?.world.operators.get(id);
        return s && op && !s.reloadRequired && this.worlds.get(s.world.subnet.id) === s.world ? { op, world: s.world } : undefined;
      },
      connected: (id) => !!this.sessions.get(id)?.controller,
      busy: (id) => {
        for (const w of this.worlds.values()) if (w.hasPendingFor(id)) return true;
        return false;
      },
      transfer: (id, to, record) => this.transfer(id, to, record),
      event: (id, event) => this.sessions.get(id)?.world.emitCarry(event, { to: id }),
      send: (id, msg) => this.sendTo(id, msg),
      // plan 2 reads ratings from the store
      rating: () => ARENA_START_RATING,
      now: () => Date.now(),
      newId: () => randomHex(16),
    });
    this.unsubscribe = [opts.bus.subscribe('org', (m) => this.onOrgPush(m)), opts.bus.subscribe('admin', (m) => this.onAdminPush(m)), opts.bus.subscribe('exchange', (m) => this.onExchange(m))];
  }

  /**
   * `exchange` channel (SP5): delivered as an `exchange` event to each listed operator that is online, in whatever
   * world it is. Each gets its own view; offline operators get nothing (the api history covers it).
   */
  private onExchange(raw: unknown): void {
    const parsed = ExchangePush.safeParse(raw);
    if (!parsed.success) return this.log.warn({ kind: (raw as { kind?: unknown } | null)?.kind === 'fill' ? 'fill' : 'unknown' }, 'dropped a malformed exchange message');
    const m = parsed.data;
    for (const id of new Set(m.operators)) {
      const live = this.live(id);
      if (live) live.session.world.emitCarry({ e: 'exchange', kind: m.kind, detail: exchangeView(m.detail ?? {}, id) }, { to: id });
    }
  }

  // ---- operator state pushed by the api (SP4 spec §7) ----

  /** The connected operator and its session, wherever it is (an operator lives in one world at a time). */
  private live(operatorId: string): { session: Session; op: Operator } | undefined {
    const session = this.sessions.get(operatorId);
    const op = session?.world.operators.get(operatorId);
    return session && op ? { session, op } : undefined;
  }

  /**
   * `org` channel: membership changes (create, join, leave, kick, rank, tag). An operator not loaded here ignores it:
   * its next load reads the store.
   */
  private onOrgPush(raw: unknown): void {
    if ((raw as { kind?: unknown } | null)?.kind !== 'membership') return;
    const parsed = OrgMembershipPush.safeParse(raw);
    if (!parsed.success) return this.log.warn({ kind: 'membership' }, 'dropped a malformed org message');
    const m = parsed.data;
    if (m.origin === 'sim') return;
    const live = this.live(m.operatorId);
    if (!live) return;
    live.session.orgGen++;
    live.op.org = m.org ? { ...m.org } : null;
  }

  /**
   * `admin` channel: bits spent or granted in the api, renames, Disk slots that changed hands on the Exchange, and
   * Incident starts (mutes, deletions and filters go to the chat).
   */
  private onAdminPush(raw: unknown): void {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (!ADMIN_KINDS.has(kind)) return;
    if (kind === 'incident:start') {
      const start = IncidentStartPush.safeParse(raw);
      if (!start.success) return this.log.warn({ kind }, 'dropped a malformed admin message');
      if (start.data.origin === 'sim') return;
      if (!this.startIncident()) this.log.info({}, 'incident start ignored: one is already running (or kernelspace is not hosted)');
      return;
    }
    if (kind === 'disk') {
      const disk = DiskPush.safeParse(raw);
      if (!disk.success) return this.log.warn({ kind }, 'dropped a malformed admin message');
      const m = disk.data;
      if (m.origin === 'sim') return;
      const live = this.live(m.operatorId);
      if (!live) return;
      // a daemon arrived on (or left) this operator's Disk through the Exchange
      live.session.diskGen++;
      if (typeof m.add === 'number') live.op.diskSlots.add(m.add);
      if (typeof m.remove === 'number') live.op.diskSlots.delete(m.remove);
      return;
    }
    const parsed = (kind === 'bits' ? BitsPush : RenamePush).safeParse(raw);
    if (!parsed.success) return this.log.warn({ kind }, 'dropped a malformed admin message');
    const m = parsed.data as BitsPush | RenamePush;
    if (m.origin === 'sim') return;
    const live = this.live(m.operatorId);
    if (!live) return;
    if (m.kind === 'bits') {
      this.applyLedgerRow(live.session, live.op, { id: m.ledgerId, seq: m.seq, delta: m.delta, reason: m.reason });
    } else {
      live.session.nameGen++;
      this.rename(live.op, m.name);
    }
  }

  /**
   * Applies a ledger row written outside the sim to the live balance, once (economy contract): a row at or below the
   * watermark is already in the balance, an applied id is a duplicate. Always a delta, never an absolute balance: the
   * world has already taken the cost of any in-flight intent the DB has not committed yet, and deltas commute, so
   * once both commit the world balance equals the DB balance (and a refused intent's refund lands there too). The
   * balance may dip below zero until such an intent is answered.
   */
  private applyLedgerRow(session: Session, op: Operator, row: { id: string; seq: number; delta: number; reason: string }): void {
    if (row.seq <= session.ledgerSeq || session.ledgerApplied.has(row.id)) return;
    session.ledgerApplied.set(row.id, row.seq);
    op.bits += row.delta;
    session.world.emitCarry({ e: 'bits', delta: row.delta, reason: row.reason, balance: op.bits }, { to: op.id });
  }

  /** A new name shows in entities and `self` from the next tick; cluster views cache names, so they are rebuilt. */
  private rename(op: Operator, name: string): void {
    if (op.name === name) return;
    op.name = name;
    this.clusters.reattach(op.id);
  }

  /**
   * Re-reads org membership, names, Disk occupancy and the ledger rows above each watermark for these operators (bus reconnects and
   * the periodic chat resync). A push that arrived while the read was in flight wins over it (generations, applied
   * row ids); an operator that left or reloaded meanwhile is skipped (its new load is newer). Never throws.
   */
  private async resyncOperators(ids: readonly string[]): Promise<void> {
    const before = new Map<string, { session: Session; orgGen: number; nameGen: number } & DiskMark>();
    const after = new Map<string, number>();
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const op = session.world.operators.get(id) ?? null;
      before.set(id, { session, orgGen: session.orgGen, nameGen: session.nameGen, diskGen: session.diskGen, world: session.world, op, diskIntentGen: op?.diskIntentGen ?? 0 });
      after.set(id, session.ledgerSeq);
    }
    if (after.size === 0) return;
    let state;
    try {
      state = await this.store.liveState(after);
    } catch (err) {
      this.log.warn({ err: { name: (err as Error)?.name ?? 'Error' } }, 'operator resync failed');
      return;
    }
    for (const [id, b] of before) {
      const st = state.get(id);
      const live = this.live(id);
      if (!st || !live || live.session !== b.session) continue;
      const { session, op } = live;
      if (session.orgGen === b.orgGen && !sameOrg(op.org, st.org)) op.org = st.org ? { ...st.org } : null;
      // A claimed name is never taken back to null (a claim the store has not committed yet).
      if (session.nameGen === b.nameGen && st.name !== null) this.rename(op, st.name);
      for (const row of st.ledger) this.applyLedgerRow(session, op, row);
      if (st.ledgerSeq > session.ledgerSeq) {
        session.ledgerSeq = st.ledgerSeq;
        for (const [rowId, seq] of session.ledgerApplied) if (seq <= session.ledgerSeq) session.ledgerApplied.delete(rowId);
      }
      this.resyncDisk(session, op, b, st.diskSlots);
    }
  }

  /**
   * Disk occupancy from a resync read (Exchange sales move daemons between Disks behind the sim; a lost `disk` push
   * heals here): the stored slots plus the slots reserved by store / capture-to-Disk intents still waiting for the
   * store. Skipped when the read may be stale for this operator: a `disk` push arrived meanwhile, a store / capture to
   * Disk / load was raised or completed meanwhile (`Operator.diskIntentGen`: the read may predate its commit, even one
   * raised and committed entirely inside the read), or the operator moved worlds or reloaded. The next resync catches up.
   */
  private resyncDisk(session: Session, op: Operator, b: DiskMark, stored: readonly number[]): void {
    if (session.diskGen !== b.diskGen || session.world !== b.world || op !== b.op || op.diskIntentGen !== b.diskIntentGen) return;
    const pending = pendingDiskSlots(session.world, op.id);
    const next = [...new Set([...stored, ...pending])].sort((x, y) => x - y);
    if (next.length === op.diskSlots.size && next.every((s) => op.diskSlots.has(s))) return;
    op.diskSlots.clear();
    for (const s of next) op.diskSlots.add(s);
  }

  /** Sends an out-of-tick server message to every connection of an operator (controller and spectators). */
  private sendTo(operatorId: string, msg: ServerMessage): void {
    const s = this.sessions.get(operatorId);
    if (!s) return;
    for (const st of s.controller ? [s.controller, ...s.spectators] : [...s.spectators]) this.send(st, msg);
  }

  /** Loads the admin-added chat filter terms; call once after construction (main.ts). */
  async loadChatTerms(): Promise<void> {
    this.chat.setExtraTerms(await this.store.listFilterTerms());
  }

  /** The world a connected operator is in. */
  worldOf(operatorId: string): World | undefined {
    return this.sessions.get(operatorId)?.world;
  }

  // ---- connections ----

  connect(conn: Conn): void {
    const t = this.ticks;
    this.conns.set(conn.id, {
      conn, seq: 0, phase: 'new', openedTick: t, lastSeenTick: t, bucket: BUCKET_MAX,
      sub: null, operatorId: null, role: null, known: new Map(), lastSelf: null, routes: new Set(),
    });
  }

  disconnect(conn: Conn): void {
    const st = this.conns.get(conn.id);
    if (!st) return;
    this.detach(st);
  }

  async message(conn: Conn, raw: string): Promise<void> {
    const st = this.conns.get(conn.id);
    if (!st || st.phase === 'closed') return;
    st.lastSeenTick = this.ticks;
    if (--st.bucket < 0) {
      st.bucket = 0;
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_RATE', message: 'too many messages' } });
      this.violation(st);
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_INVALID', message: parsed.message } });
      if (st.phase === 'new') this.kick(st, 'auth required', CLOSE.auth);
      return;
    }
    const msg = parsed.message;
    if (st.phase === 'new') {
      if (msg.t !== 'auth') return this.kick(st, 'auth required', CLOSE.auth);
      st.phase = 'authing';
      return this.authenticate(st, msg.d);
    }
    if (st.phase !== 'ready') return;
    switch (msg.t) {
      case 'auth':
        return this.error(st, 'E_STATE', 'already authenticated');
      case 'ping':
        return this.send(st, { t: 'pong', seq: 0, d: {} });
      case 'reauth':
        return this.reauth(st, msg.d.token);
      case 'cmd':
        return this.command(st, msg.d);
    }
  }

  private async authenticate(st: ConnState, d: Extract<ClientMessage, { t: 'auth' }>['d']): Promise<void> {
    let claims;
    try {
      claims = await this.verify(d.token);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'token verification failed');
      this.error(st, 'E_AUTH', 'authentication failed');
      return this.kick(st, 'unauthorized', CLOSE.auth);
    }
    try {
      const rec = await this.loadOperator(claims.sub);
      if (st.phase === 'closed') return;
      let session = this.sessions.get(rec.id);
      // The old session must leave first (its checkpoint skips the inventory); the client retries the transient kick.
      if (session?.reloadRequired) return this.kick(st, RELOAD_KICK, CLOSE.unavailable);
      if (!session) {
        // An operator whose subnet this process does not host starts over at the default world's spawn.
        let world = this.worlds.get(rec.subnet);
        // kernelspace is capped while an Incident runs (the gateway closes at 16): an operator whose record names it
        // returns to backbone's spawn instead when it is full (with no Incident running, eviction sends it there).
        if (world?.subnet.id === INCIDENT_SUBNET && world.incident && !world.operators.has(rec.id) && !this.incidentRoom(INCIDENT_SUBNET)) {
          world = this.worlds.get(EVICT_TO);
          if (world) {
            rec.subnet = world.subnet.id;
            rec.x = world.subnet.spawn.x;
            rec.y = world.subnet.spawn.y;
          }
        }
        if (!world) {
          world = this.defaultWorld;
          rec.subnet = world.subnet.id;
          rec.x = world.subnet.spawn.x;
          rec.y = world.subnet.spawn.y;
        }
        if (!world.operators.has(rec.id)) world.addOperator(rec);
        session = {
          operatorId: rec.id, sub: claims.sub, world, controller: null, spectators: new Set(), resumeToken: randomHex(16), buffer: [], baseTick: world.tick,
          savedKnown: null, savedSelf: null, commandsThisTick: 0, violations: [], leaveAtTick: null, reloadRequired: false,
          ledgerSeq: rec.ledgerSeq, loadSeq: rec.ledgerSeq, ledgerApplied: new Map(), orgGen: 0, nameGen: 0, diskGen: 0,
        };
        this.sessions.set(rec.id, session);
        this.claimParkedRewards(session, rec.ledgerSeq);
        this.chat.loadMute(rec.id, rec.mutedUntil);
        // Pushes for this operator that landed while the load was in flight had no session and were dropped: re-read
        // org, name and the ledger rows above the load's watermark now rather than at the next periodic resync.
        void this.resyncOperators([rec.id]);
      }
      st.sub = claims.sub;
      st.operatorId = rec.id;
      if (d.role === 'spectator') {
        if (session.spectators.size >= this.maxSpectators) {
          this.error(st, 'E_STATE', 'too many spectators');
          return this.kick(st, 'too many spectators', CLOSE.rate);
        }
        st.role = 'spectator';
        session.spectators.add(st);
        if (!session.controller && session.leaveAtTick === null) session.leaveAtTick = this.ticks + this.leaveAfter;
      } else {
        const old = session.controller;
        if (old) {
          session.savedKnown = old.known;
          session.savedSelf = old.lastSelf;
          session.controller = null;
          this.kick(old, 'takeover', CLOSE.takeover);
        }
        st.role = 'controller';
        session.controller = st;
        session.leaveAtTick = null;
      }
      st.phase = 'ready';
      this.send(st, { t: 'authOk', seq: 0, d: { operatorId: rec.id, role: st.role, resumeToken: session.resumeToken, tick: session.world.tick } });
      if (!(st.role === 'controller' && this.tryResume(st, session, d.resumeToken, d.lastTick))) this.snapshot(st);
      // A running mute is part of the state a client starts from (it relays to sandboxed scripts too).
      const until = this.chat.mutedUntil(rec.id);
      if (until) this.send(st, { t: 'muted', seq: 0, d: { until } });
      this.log.info({ sub: claims.sub, role: st.role, ip: st.conn.ip, subnet: session.world.subnet.id }, 'operator connected');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'auth: store unavailable');
      this.error(st, 'E_STATE', 'service unavailable');
      this.kick(st, 'unavailable', CLOSE.unavailable);
    }
  }

  /**
   * Loads the operator's row from a read that began after the last leave checkpoint for `sub` committed: waits out a
   * leave in progress, and reloads when a leave started while the load was in flight (its result may predate it).
   */
  private async loadOperator(sub: string) {
    const subnet = this.defaultWorld.subnet;
    for (;;) {
      const pending = this.leaving.get(sub);
      if (pending) {
        await pending;
        continue;
      }
      const load = { stale: false };
      let set = this.loads.get(sub);
      if (!set) this.loads.set(sub, (set = new Set()));
      set.add(load);
      try {
        const rec = await this.store.loadOrCreateOperator(sub, subnet.id, subnet.spawn);
        if (!load.stale) return rec;
      } finally {
        set.delete(load);
        if (set.size === 0 && this.loads.get(sub) === set) this.loads.delete(sub);
      }
    }
  }

  private tryResume(st: ConnState, session: Session, token: string | undefined, lastTick: number | undefined): boolean {
    if (token === undefined || !sameSecret(token, session.resumeToken) || lastTick === undefined || !session.savedKnown) return false;
    if (lastTick < session.baseTick || lastTick > session.world.tick) return false;
    st.known = new Map(session.savedKnown);
    st.lastSelf = session.savedSelf;
    for (const entry of session.buffer) if (entry.tick > lastTick) this.send(st, entry.msg);
    return true;
  }

  private snapshot(st: ConnState): void {
    const session = this.sessions.get(st.operatorId!)!;
    const world = session.world;
    const op = world.operators.get(st.operatorId!)!;
    if (st.role === 'controller') {
      session.buffer = [];
      session.baseTick = world.tick;
    }
    const entities = entitiesNear(world, op.x, op.y, this.radius, op);
    const self = toSelf(world, op);
    st.known = new Map(entities.map((e) => [e.id, e]));
    st.lastSelf = JSON.stringify(self);
    this.send(st, { t: 'snapshot', seq: 0, d: { tick: world.tick, subnet: world.subnet.id, self, entities } });
  }

  private async reauth(st: ConnState, token: string): Promise<void> {
    try {
      const claims = await this.verify(token);
      if (claims.sub !== st.sub) throw new Error('token belongs to a different account');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'token verification failed');
      this.error(st, 'E_AUTH', 'authentication failed');
      this.kick(st, 'unauthorized', CLOSE.auth);
    }
  }

  private command(st: ConnState, d: Extract<ClientMessage, { t: 'cmd' }>['d']): void {
    const { reqId, ...command } = d;
    if (st.role !== 'controller') return this.error(st, 'E_STATE', 'spectators cannot send commands', reqId);
    const session = this.sessions.get(st.operatorId!)!;
    if (command.cmd.startsWith('arena')) {
      // Entering and leaving matches is the runtime's business (outside the tick, no per-tick budget; the service has
      // its own limits); only fighting goes through the match world's tick. Replied to the connection that sent it.
      const r = this.arenaCommand(session.operatorId, command);
      if (isArenaError(r)) this.error(st, r.code, r.message, reqId);
      else this.send(st, { t: 'ack', seq: 0, d: { reqId, result: r } });
      return;
    }
    if (command.cmd === 'clusterInvite' && (this.arena.inMatch(session.operatorId) || this.arena.inMatch(command.args.operatorId))) {
      // match worlds share the subnet id: an invite would reach the opponent, or someone in another match
      const mine = this.arena.inMatch(session.operatorId);
      return this.error(st, 'E_STATE', mine ? 'not available in an arena match' : 'that operator is in an arena match', reqId);
    }
    if (command.cmd.startsWith('cluster')) {
      // Social, not gameplay: handled at once outside the tick (no per-tick budget; the service has its own limits),
      // replied to the connection that sent it; the next delta carries the new `self.cluster`.
      const r = this.cluster(session.operatorId, command);
      if (isClusterError(r)) this.error(st, r.code, r.message, reqId);
      else this.send(st, { t: 'ack', seq: 0, d: { reqId, result: r } });
      return;
    }
    if (command.cmd === 'chat') {
      // Chat is not gameplay: handled outside the tick, with no per-tick budget and its own per-operator limit. The
      // reply goes to the connection that sent it (dropped if that connection has gone).
      this.track(
        this.chat.post(session.operatorId, command.args.channel, command.args.text).then((err) => {
          if (err) this.error(st, err.code, err.message, reqId);
          else this.send(st, { t: 'ack', seq: 0, d: { reqId } });
        }),
      );
      return;
    }
    if (session.commandsThisTick >= COMMANDS_PER_TICK) {
      this.error(st, 'E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`, reqId);
      return this.violation(st);
    }
    session.commandsThisTick++;
    const key = `${st.conn.id}:${reqId}`;
    this.replyTo.set(key, { st, reqId });
    st.routes.add(key);
    this.inputs.push({ operatorId: session.operatorId, reqId: key, command });
  }

  private arenaCommand(id: string, command: Command): ArenaError | object {
    switch (command.cmd) {
      case 'arenaQueue':
        return this.arena.queueUp(id, command.args.mode);
      case 'arenaLeave':
        return this.arena.leaveQueue(id);
      case 'arenaChallenge':
        return this.arena.challenge(id, command.args.operatorId, command.args.mode);
      case 'arenaAccept':
        return this.arena.accept(id, command.args.challengeId);
      case 'arenaForfeit':
        return this.arena.forfeit(id);
      default:
        return { code: 'E_INVALID', message: 'unknown arena command' };
    }
  }

  private cluster(id: string, command: Command): ClusterError | object {
    switch (command.cmd) {
      case 'clusterCreate':
        return this.clusters.ensure(id);
      case 'clusterInvite':
        return this.clusters.invite(id, command.args.operatorId);
      case 'clusterAccept':
        return this.clusters.accept(id, command.args.clusterId);
      case 'clusterJoin':
        return this.clusters.join(id, command.args.code);
      case 'clusterLeave':
        return this.clusters.leave(id);
      case 'clusterKick':
        return this.clusters.kick(id, command.args.operatorId);
      default:
        return { code: 'E_INVALID', message: 'unknown cluster command' };
    }
  }

  private violation(st: ConnState): void {
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    const now = this.ticks;
    session.violations = session.violations.filter((t) => now - t < VIOLATION_WINDOW_TICKS);
    session.violations.push(now);
    if (session.violations.length > MAX_VIOLATIONS) this.kick(st, 'rate limit', CLOSE.rate);
  }

  private send(st: ConnState, msg: ServerMessage): void {
    if (st.phase === 'closed') return;
    st.conn.send({ ...msg, seq: ++st.seq } as ServerMessage);
  }

  private error(st: ConnState, code: ErrorCode, message: string, reqId?: string): void {
    this.send(st, { t: 'err', seq: 0, d: reqId === undefined ? { code, message } : { reqId, code, message } });
  }

  private kick(st: ConnState, reason: string, code: number): void {
    if (st.phase === 'closed') return;
    this.send(st, { t: 'kick', seq: 0, d: { reason } });
    st.conn.close(code, reason);
    this.detach(st);
  }

  private detach(st: ConnState): void {
    if (st.phase === 'closed' && !this.conns.has(st.conn.id)) return;
    st.phase = 'closed';
    this.conns.delete(st.conn.id);
    for (const key of st.routes) this.replyTo.delete(key);
    st.routes.clear();
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    session.spectators.delete(st);
    if (session.controller === st) {
      session.controller = null;
      session.savedKnown = st.known;
      session.savedSelf = st.lastSelf;
      session.leaveAtTick = this.ticks + this.leaveAfter;
    }
  }

  // ---- the tick ----

  tick(): void {
    const t0 = performance.now();
    this.ticks++;
    for (const st of [...this.conns.values()]) {
      st.bucket = Math.min(BUCKET_MAX, st.bucket + BUCKET_REFILL_PER_TICK);
      if (st.phase !== 'ready' && this.ticks - st.openedTick > this.authTimeout) this.kick(st, 'auth timeout', CLOSE.timeout);
      else if (st.phase === 'ready' && this.ticks - st.lastSeenTick > this.idleTimeout) this.kick(st, 'idle', CLOSE.timeout);
    }

    // Each input goes to the world its operator is in now.
    const inputsByWorld = new Map<World, Input[]>();
    for (const input of this.inputs) {
      const world = this.sessions.get(input.operatorId)?.world;
      if (!world) continue;
      let list = inputsByWorld.get(world);
      if (!list) inputsByWorld.set(world, (list = []));
      list.push(input);
    }
    this.inputs = [];
    for (const s of this.sessions.values()) s.commandsThisTick = 0;

    this.gateIncidentGateways();
    for (const world of this.worlds.values()) this.stepWorld(world, inputsByWorld.get(world) ?? []);
    // arena matches after the persistent worlds; then the service reports results, sends operators home and matchmakes
    for (const world of this.arena.worlds()) this.stepWorld(world, inputsByWorld.get(world) ?? []);
    this.arena.tick();

    if (this.ticks % this.checkpointEvery === 0) this.checkpointAll();
    for (const session of [...this.sessions.values()]) {
      // A travelling operator leaves once the hand-off has settled (from whichever world it ends up in).
      // An economy intent (buy / craft / decompile, ticket accept / abandon / payout) or a starter claim settles first
      // too: the leave checkpoint then carries its outcome, and a reconnect meanwhile resumes this session (so it can
      // never claim, spend, accept or be paid again on a reload that predates the intent).
      if (!session.controller && session.leaveAtTick !== null && session.leaveAtTick <= this.ticks && !this.travelling(session) && !this.economyInFlight(session)) {
        this.leave(session);
      }
    }

    const ms = performance.now() - t0;
    this.tickMs.push(ms);
    if (this.tickMs.length > 1024) this.tickMs.shift();
    const recent = this.tickMs.slice(-16);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > SLOW_TICK_MS && this.radius !== INTEREST_RADIUS / 2) {
      this.radius = INTEREST_RADIUS / 2;
      this.log.warn({ avgMs: avg }, 'slow ticks: shrinking interest radius');
    } else if (avg < RECOVERED_TICK_MS) {
      this.radius = INTEREST_RADIUS;
    }
  }

  private stepWorld(world: World, inputs: Input[]): void {
    const result = world.step(inputs);
    // before the intents are persisted: the Incident record is queued ahead of its payouts
    if (world.subnet.id === INCIDENT_SUBNET) this.onIncidentEvents(world, result.events);

    for (const r of result.replies) {
      const route = this.replyTo.get(r.reqId);
      if (!route) continue;
      this.replyTo.delete(r.reqId);
      const { st, reqId } = route;
      st.routes.delete(r.reqId);
      if (st.phase === 'closed') continue;
      if (r.ok) this.send(st, { t: 'ack', seq: 0, d: r.result === undefined ? { reqId } : { reqId, result: r.result } });
      else this.error(st, r.code, r.message, reqId);
    }
    this.saveBeforeDeposits(world, result.intents);
    for (const intent of result.intents) this.persist(world, intent);

    for (const session of this.sessions.values()) {
      if (session.world !== world) continue;
      const op = world.operators.get(session.operatorId);
      if (!op) continue;
      const events = result.events
        .filter((e) => (e.to === null ? e.at === null || distance(e.at, op) <= this.radius : e.to === op.id))
        .map((e) => e.event);
      const near = entitiesNear(world, op.x, op.y, this.radius, op);
      const self = toSelf(world, op);
      const selfJson = JSON.stringify(self);
      const targets = session.controller ? [session.controller, ...session.spectators] : [...session.spectators];
      for (const st of targets) {
        const { upserts, removes } = diffEntities(st.known, near);
        const selfChanged = selfJson !== st.lastSelf;
        st.lastSelf = selfJson;
        const msg: Extract<ServerMessage, { t: 'delta' }> = {
          t: 'delta', seq: 0, d: selfChanged ? { tick: result.tick, upserts, removes, events, self } : { tick: result.tick, upserts, removes, events },
        };
        this.send(st, msg);
        if (st === session.controller) {
          session.buffer.push({ tick: result.tick, msg });
          if (session.buffer.length > RESUME_TICKS) session.baseTick = session.buffer.shift()!.tick;
        }
      }
    }
  }

  private travelling(session: Session): boolean {
    return session.world.operators.get(session.operatorId)?.travelling === true;
  }

  /**
   * Any economy intent or starter claim of the operator still pending (`World.economyInFlight`), in any world: an
   * Incident payout stays pending in kernelspace after its operator has travelled on.
   */
  private economyInFlight(session: Session): boolean {
    for (const w of this.worlds.values()) if (w.economyInFlight(session.operatorId)) return true;
    return false;
  }

  // ---- Incidents (SP4 spec section 8) ----

  /**
   * Whether an Incident gateway into `subnet` admits one more operator now: an Incident runs there and the operators in
   * it plus those already travelling in stay under the cap (so two travels in one tick cannot both take the last place).
   */
  private incidentRoom(subnet: string): boolean {
    const dest = this.worlds.get(subnet);
    if (!dest?.incident) return false;
    let inbound = 0;
    for (const w of this.worlds.values()) inbound += w.pendingTravelsTo(subnet);
    return dest.operators.size + inbound < INCIDENT_MAX_OPERATORS;
  }

  /**
   * Incident gateways open only while an Incident runs in the destination and it has room. Server-side only:
   * `closedGateways` is not part of any snapshot or delta (clients judge the gateway from the `incident` events and do
   * not know when the arena is full; a refused travel says so), and `travel` re-checks the room where it executes.
   */
  private gateIncidentGateways(): void {
    for (const world of this.worlds.values()) {
      for (const g of world.subnet.gateways) {
        if (!g.incidentOnly) continue;
        if (this.incidentRoom(g.to)) world.closedGateways.delete(g.id);
        else world.closedGateways.add(g.id);
      }
    }
  }

  /**
   * Incident announcements are server-wide (every other world gets them on its next step); the record is kept for the
   * api. A failed record is only logged: every payout intent writes the CLEARED row with its participants itself, and
   * boot recovery closes rows an earlier process left OPEN.
   */
  private onIncidentEvents(world: World, events: readonly { event: GameEvent }[]): void {
    for (const { event } of events) {
      if (event.e !== 'incident') continue;
      for (const other of this.worlds.values()) if (other !== world) other.emitCarry(event, { at: null });
      if (event.phase !== 'open' && event.phase !== 'cleared' && event.phase !== 'expired') continue;
      const row: IncidentRow = {
        id: event.id,
        n: event.n,
        species: event.species,
        endsAt: event.endsAt,
        outcome: event.phase === 'open' ? 'OPEN' : event.phase === 'cleared' ? 'CLEARED' : 'EXPIRED',
        participants: (event.participants ?? []).map((p) => ({ ...p })),
      };
      this.recordIncident(row);
    }
  }

  /**
   * Admin trigger (bus `admin { kind: 'incident:start' }`, or tests): opens one on kernelspace's next step. Refused
   * (false) while one is running or already requested, or when kernelspace is not hosted here. Does not move the
   * schedule.
   */
  startIncident(): boolean {
    const world = this.worlds.get(INCIDENT_SUBNET);
    if (!world || world.incident || world.incidentRequested) return false;
    world.incidentRequested = true;
    return true;
  }

  /**
   * Boot recovery, before connections are accepted: closes Incident rows an earlier process left OPEN and finishes
   * the payouts a restart interrupted (same intent ids; the store pays each (Incident, operator) once). Nobody is
   * connected yet, so the next load reads the credited balance. Failures are logged and retried at the next boot.
   */
  async recoverIncidents(): Promise<void> {
    let intents;
    try {
      intents = await this.store.recoverIncidents();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'incident recovery failed');
      return;
    }
    for (const intent of intents) {
      try {
        const result = await this.serialized(() => this.store.applyIntent(intent, { seedId: this.defaultWorld.seedId }));
        if (result.ok) this.log.info({ intent: intent.id, operator: intent.operatorId, reward: intent.reward }, 'resumed an interrupted incident payout');
        else {
          this.log.warn({ intent: intent.id, operator: intent.operatorId, reason: result.reason }, 'incident payout refused');
          await this.store.markIncidentPayoutRefused(intent.incidentId, intent.operatorId);
        }
      } catch (err) {
        this.log.error({ intent: intent.id, operator: intent.operatorId, err: (err as Error).message }, 'resuming an incident payout failed');
      }
    }
  }

  /**
   * A settled Incident payout. The world it was raised in credited it if the operator was there all along; otherwise
   * (it had left kernelspace before the clear, or since) it is credited once wherever the operator is now, unless the
   * balance that session loaded already contains the row (its seq is at or below the load's watermark).
   */
  private onIncidentReward(intent: Extract<Intent, { kind: 'incidentReward' }>, result: IntentResult, elsewhere: boolean): void {
    if (!result.ok) {
      this.log.warn({ intent: intent.id, operator: intent.operatorId, incident: intent.incidentId, reason: result.reason }, 'incident payout refused');
      // definitive: boot recovery must not raise it again
      this.track(
        this.store
          .markIncidentPayoutRefused(intent.incidentId, intent.operatorId)
          .catch((err: Error) => this.log.warn({ intent: intent.id, err: err.message }, 'marking a refused incident payout failed')),
      );
      return;
    }
    if (!elsewhere) return;
    const live = this.live(intent.operatorId);
    if (!live) {
      // No session (gone, or still loading): a session created soon applies it if its load predates the row.
      if (result.ledgerSeq !== undefined) this.parkReward(intent, result.ledgerSeq);
      return;
    }
    if (result.ledgerSeq !== undefined && result.ledgerSeq <= live.session.loadSeq) return;
    live.session.world.creditIncidentReward(live.op, intent);
  }

  private parkReward(intent: Extract<Intent, { kind: 'incidentReward' }>, seq: number): void {
    const now = Date.now();
    for (const [id, list] of this.parkedRewards) {
      const fresh = list.filter((r) => now - r.at < PARKED_REWARD_MS);
      if (fresh.length === 0) this.parkedRewards.delete(id);
      else this.parkedRewards.set(id, fresh);
    }
    const list = this.parkedRewards.get(intent.operatorId) ?? [];
    list.push({ seq, intent, at: now });
    this.parkedRewards.set(intent.operatorId, list);
  }

  /** A new session takes the parked payouts its load did not contain (row above the load's watermark), once. */
  private claimParkedRewards(session: Session, loadSeq: number): void {
    const list = this.parkedRewards.get(session.operatorId);
    if (!list) return;
    this.parkedRewards.delete(session.operatorId);
    const op = session.world.operators.get(session.operatorId);
    if (!op) return;
    for (const r of list) if (r.seq > loadSeq && Date.now() - r.at < PARKED_REWARD_MS) session.world.creditIncidentReward(op, r.intent);
  }

  /**
   * Writes an Incident record. A CLEARED record is retried until the store answers (capped like an unknown intent), so
   * the participants are on the row as early as possible; the others get the bounded retries only. Failures are logged:
   * the payout intents also write the CLEARED row, and boot recovery closes rows left OPEN.
   */
  private recordIncident(row: IncidentRow): void {
    const untilKnown = row.outcome === 'CLEARED';
    const run = async () => {
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          await this.store.recordIncident(row);
          return;
        } catch (err) {
          if (attempt < this.retryDelays.length || attempt % WARN_EVERY === 0) {
            this.log.warn({ incident: row.id, outcome: row.outcome, attempt, err: (err as Error).message }, 'incident record failed');
          }
          const delay = this.retryDelays[attempt];
          const giveUp =
            this.stopping || (delay === undefined && !untilKnown) || attempt + 1 >= this.unknownRetryLimit || Date.now() - started >= this.unknownRetryMs;
          if (giveUp) {
            this.log.error({ incident: row.id, outcome: row.outcome, attempts: attempt + 1 }, 'incident record abandoned');
            return;
          }
          await sleep(delay ?? Math.min(MAX_RETRY_MS, this.retryDelays.at(-1) ?? MAX_RETRY_MS));
        }
      }
    };
    this.track(run());
  }

  private leave(session: Session): void {
    // out of the queue, and out of a match (forfeited) back into the home world, so what follows sees the real operator
    this.arena.drop(session.operatorId);
    for (const load of this.loads.get(session.sub) ?? []) load.stale = true;
    const world = session.world;
    const record = this.record(world, session.operatorId);
    // The world drops the operator, then the cluster lets go of it (leadership passes on, an empty cluster dissolves)
    // and every world releases tags of a key nobody there holds any more (either order releases the same tags).
    world.removeOperator(session.operatorId);
    this.clusters.leave(session.operatorId);
    this.sessions.delete(session.operatorId);
    for (const st of [...session.spectators]) this.kick(st, 'operator left', CLOSE.left);
    for (const [key, route] of this.replyTo) {
      if (route.st.operatorId !== session.operatorId) continue;
      this.replyTo.delete(key);
      route.st.routes.delete(key);
    }
    const done = this.writeCheckpoint([record], (err) => this.log.error({ sub: session.sub, err: err.message }, 'leave checkpoint failed')).finally(() =>
      this.leaving.delete(session.sub),
    );
    this.leaving.set(session.sub, done);
    this.track(done);
    this.log.info({ sub: session.sub }, 'operator left');
  }

  /**
   * One checkpoint of every operator in every world. A travelling operator is skipped: its record would still name the
   * source subnet, and the travel intent (queued on the same chain) is what moves it. An operator in an arena match is
   * checkpointed as it left its home world (with what the api pushed meanwhile): copies never reach the database.
   */
  private checkpointAll(): void {
    const records: OperatorRecord[] = [];
    for (const world of this.worlds.values()) {
      for (const op of world.operators.values()) if (!op.travelling) records.push(this.record(world, op.id));
    }
    for (const id of this.sessions.keys()) {
      const home = this.arena.homeRecord(id);
      if (home) records.push(this.guarded(id, home));
    }
    if (records.length === 0) return;
    this.track(this.writeCheckpoint(records, (err) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  /**
   * The store checks a deposit against the inventory it holds, which lags the world's by up to a checkpoint period:
   * an item unheld (or otherwise gained world-side) since then would be refused. So before this tick's deposits reach
   * the store, each depositing operator's inventory (and RAM daemons' held items, as a checkpoint writes them) is saved
   * on the write chain, as it was before the deposits: the live inventory plus everything they took at accept.
   *
   * Only when the deposits are the operator's only inventory intents in flight: another one (a buy, a craft, an
   * earlier deposit already on its way) means the store's inventory is about to change in a way the world has only
   * half applied, so writing the live one could rewind or double it; those deposits may be refused with
   * DEPOSIT_NOT_SAVED (refunded; the player retries). Written once, here, never by the intent's retries: a save
   * replayed after the deposit committed would hand the items back.
   */
  private saveBeforeDeposits(world: World, intents: readonly Intent[]): void {
    const deposits = new Map<string, Array<Extract<Intent, { kind: 'vault' }>>>();
    for (const i of intents) if (i.kind === 'vault' && i.qty > 0) deposits.set(i.operatorId, [...(deposits.get(i.operatorId) ?? []), i]);
    for (const [operatorId, mine] of deposits) {
      const op = world.operators.get(operatorId);
      if (!op || op.travelling || this.sessions.get(operatorId)?.reloadRequired) continue;
      const ids = new Set(mine.map((d) => d.id));
      if (world.pendingIntents(operatorId).some((i) => isInventoryIntent(i) && !ids.has(i.id))) continue;
      const { inventoryInFlight: _f, ...rec } = world.checkpoint(operatorId);
      let inventory = rec.inventory;
      for (const d of mine) inventory = withItems(inventory, { [d.item]: d.qty }, 1);
      this.track(this.writeCheckpoint([{ ...rec, inventory }], (err) => this.log.error({ operator: operatorId, err: err.message }, 'save before deposit failed')));
    }
  }

  /** The operator's checkpoint record; a session that must reload never writes its inventory (the store is the truth). */
  private record(world: World, operatorId: string): OperatorRecord {
    return this.guarded(operatorId, world.checkpoint(operatorId));
  }

  private guarded(operatorId: string, rec: OperatorRecord): OperatorRecord {
    return this.sessions.get(operatorId)?.reloadRequired ? { ...rec, inventoryInFlight: true } : rec;
  }

  /**
   * Arena hand-over (SP6), both ways: the operator leaves the world it is in and enters `to` with `record`. As with
   * travel (#25) nothing the client knew carries over: resume state is reset and every connection gets a snapshot (which
   * restarts the sandbox script). Writes nothing: checkpoints of an operator in a match write its home record.
   */
  private transfer(operatorId: string, to: World, record: OperatorRecord): boolean {
    const session = this.sessions.get(operatorId);
    if (!session || !session.world.operators.has(operatorId)) return false;
    const from = session.world;
    from.removeOperator(operatorId);
    to.addOperator({ ...record, subnet: to.subnet.id });
    session.world = to;
    this.clusters.reattach(operatorId);
    session.savedKnown = null;
    session.savedSelf = null;
    session.buffer = [];
    session.baseTick = to.tick;
    for (const st of session.controller ? [session.controller, ...session.spectators] : [...session.spectators]) this.snapshot(st);
    this.log.info({ sub: session.sub, from: from.subnet.id, to: to.subnet.id }, 'arena hand-over');
    return true;
  }

  /**
   * Queues a checkpoint write behind every earlier store write, so writes commit in the order their records were taken
   * (a slow periodic checkpoint can never overwrite a newer leave checkpoint or a committed travel). Failures are
   * reported and do not break the chain.
   */
  private writeCheckpoint(records: readonly OperatorRecord[], onError: (err: Error) => void): Promise<void> {
    return this.serialized(() => this.store.checkpoint(records)).catch((err: Error) => onError(err));
  }

  /** Runs `fn` after every store write queued before it (one chain for all worlds). */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn);
    this.writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** A committed travel intent: hand the operator from its world to the destination and start it with a fresh snapshot. */
  private moveOperator(from: World, intent: Extract<Intent, { kind: 'travel' }>): void {
    const session = this.sessions.get(intent.operatorId);
    const to = this.worlds.get(intent.to);
    if (!session || session.world !== from || !to || !from.operators.has(intent.operatorId)) {
      this.log.error({ operator: intent.operatorId, from: intent.from, to: intent.to }, 'travel committed but the operator could not be moved');
      // The store now names the destination while the operator is still here: write it back where it really is.
      if (from.operators.has(intent.operatorId)) {
        const record = this.record(from, intent.operatorId);
        this.track(this.writeCheckpoint([record], (err) => this.log.error({ operator: intent.operatorId, err: err.message }, 'travel reconcile checkpoint failed')));
      }
      return;
    }
    const record = from.checkpoint(intent.operatorId);
    from.removeOperator(intent.operatorId);
    to.addOperator({ ...record, subnet: to.subnet.id, x: intent.x, y: intent.y });
    session.world = to;
    // Membership survives travel: the new world's operator gets the view back and every member's `away` flags change.
    this.clusters.reattach(intent.operatorId);
    // Nothing the client knew about the old subnet carries over: a resume must start from a fresh snapshot.
    session.savedKnown = null;
    session.savedSelf = null;
    session.buffer = [];
    session.baseTick = to.tick;
    to.emitCarry({ e: 'travelled', from: intent.from, to: intent.to }, { to: intent.operatorId });
    for (const st of session.controller ? [session.controller, ...session.spectators] : [...session.spectators]) this.snapshot(st);
    this.log.info({ sub: session.sub, from: intent.from, to: intent.to }, 'operator travelled');
  }

  private persist(world: World, intent: Intent): void {
    // store / decompile write (archive) the daemon's current state along with the move.
    const stored = intent.kind === 'store' || intent.kind === 'decompile' ? world.daemons.get(intent.daemonId) : undefined;
    const ctx = { seedId: world.seedId, ...(stored ? { storedDaemon: world.toRecord(stored) } : {}) };
    // A travel rewrites the operator's subnet and position, and an economy intent its bits, inventory or ticket rows:
    // each must commit after every checkpoint taken before it (a checkpoint taken while an inventory intent is pending
    // leaves the inventory alone; one taken while a ticket intent is pending only writes progress of OPEN rows).
    const ordered = intent.kind === 'travel' || isEconomyIntent(intent);
    const apply = () => (ordered ? this.serialized(() => this.store.applyIntent(intent, ctx)) : this.store.applyIntent(intent, ctx));
    // A thrown error leaves the outcome unknown (the commit may have landed). For an intent whose refund would be
    // written over a committed result by the next checkpoint (economy: bits / items; capture: the consumed tool;
    // claimStarter: the starting inventory), or whose invented failure would desync the world from the store (tickets:
    // a revert of a committed accept frees a cap slot, a failed payout would be raised again), a
    // failure is never synthesized: the same intent is retried (idempotent by id) until the store answers. Shutdown
    // abandons it still pending, so the final checkpoint leaves the inventory to the store. An error that persists past
    // the retry cap (a store bug, or a long outage) still invents no outcome: retrying stops and the operator reloads
    // from the store (`reloadFromStore`).
    const untilKnown = isEconomyIntent(intent) || intent.kind === 'capture' || intent.kind === 'claimStarter';
    const run = async () => {
      let result: IntentResult = { ok: false, reason: 'persist failed' };
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          result = await apply();
          break;
        } catch (err) {
          if (attempt < this.retryDelays.length || attempt % WARN_EVERY === 0) {
            this.log.warn({ intent: intent.id, attempt, err: (err as Error).message }, 'intent persist failed');
          }
          if (untilKnown && (attempt + 1 >= this.unknownRetryLimit || Date.now() - started >= this.unknownRetryMs)) {
            return this.reloadFromStore(world, intent, attempt + 1, err as Error);
          }
          const delay = this.retryDelays[attempt];
          if (delay !== undefined) {
            await sleep(delay);
            continue;
          }
          if (!untilKnown) break;
          if (this.stopping) return this.abandon(intent);
          await sleep(Math.min(MAX_RETRY_MS, this.retryDelays.at(-1) ?? MAX_RETRY_MS));
          if (this.stopping) return this.abandon(intent);
        }
      }
      if (intent.kind === 'completeTicket' && !result.ok) this.logRefusedPayout(world, intent, result.reason);
      const elsewhere = intent.kind === 'incidentReward' && world.isRewardElsewhere(intent.id);
      world.completeIntent(intent.id, result);
      // a daemon arrived in that Disk slot behind the sim and its `disk` push is late or lost: re-read the Disk now
      if ((intent.kind === 'store' || intent.kind === 'capture') && !result.ok && result.reason === DISK_SLOT_TAKEN) this.track(this.resyncOperators([intent.operatorId]));
      if (intent.kind === 'incidentReward') this.onIncidentReward(intent, result, elsewhere);
      if (intent.kind === 'evolve' && result.ok) this.shareDiscovery(world, intent, result.discovered === true);
      // the operator's name is set when the claim commits: members' cluster views show it
      if (intent.kind === 'claimStarter' && result.ok) this.clusters.reattach(intent.operatorId);
      if (intent.kind === 'travel' && result.ok) this.moveOperator(world, intent);
    };
    this.track(run());
  }

  /** A definitive refusal of a ticket payout: the ticket closes unpaid, so it must leave a trace. */
  private logRefusedPayout(world: World, intent: Extract<Intent, { kind: 'completeTicket' }>, reason: string): void {
    const t = world.operators.get(intent.operatorId)?.tickets.find((x) => x.id === intent.ticketId);
    const ticket = t ? ticketKey(t.day, t.subnet, t.index) : intent.ticketId;
    this.log.warn({ intent: intent.id, operator: intent.operatorId, ticket, reason }, 'ticket payout refused: ticket closed without payout');
  }

  /**
   * An intent whose outcome is still unknown after the retry cap: it is never completed (no failure is invented) and
   * no longer retried. It leaves the world's pending set, and its operator is kicked and leaves with a checkpoint that
   * skips the inventory (never bits), so the reconnect loads the store's state as the truth. The operator's locks
   * (pending daemons, a pending claim) go with the operator.
   */
  private reloadFromStore(world: World, intent: Intent, attempts: number, err: Error): void {
    this.log.error(
      { intent: intent.id, kind: intent.kind, operator: intent.operatorId, attempts, err: err.message },
      'intent outcome still unknown after the retry cap: operator reloads from the store',
    );
    world.abandonIntent(intent.id);
    const session = this.sessions.get(intent.operatorId);
    if (!session) return;
    session.reloadRequired = true;
    for (const st of [...(session.controller ? [session.controller] : []), ...session.spectators]) this.kick(st, RELOAD_KICK, CLOSE.unavailable);
    session.leaveAtTick = this.ticks;
  }

  private abandon(intent: Intent): void {
    this.log.error({ intent: intent.id, kind: intent.kind, operator: intent.operatorId }, 'shutdown with an intent outcome unknown: left to the store');
  }

  /** A committed evolution is known in every hosted world; a first discovery is announced in all of them. */
  private shareDiscovery(origin: World, intent: Extract<Intent, { kind: 'evolve' }>, first: boolean): void {
    const operatorName = origin.operators.get(intent.operatorId)?.name ?? null;
    for (const w of this.worlds.values()) {
      if (w === origin) continue;
      w.discovered.add(intent.to);
      if (first) w.emitCarry({ e: 'discovery', form: intent.to, operator: intent.operatorId, operatorName }, { at: null });
    }
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => {},
      () => {},
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  /** Resolves when all in-flight persistence has settled. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /**
   * Kick everyone, let in-flight intents complete (an intent whose outcome is still unknown after its retries is
   * abandoned pending), then checkpoint everyone and wait for persistence.
   */
  async shutdown(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.chat.close();
    // matches end without a result; everyone in one is back home for the final checkpoint
    this.arena.endAll();
    for (const st of [...this.conns.values()]) this.kick(st, 'server shutting down', 1001);
    this.stopping = true;
    await this.flush();
    this.checkpointAll();
    await this.flush();
  }

  stats(): { p50: number; p99: number; max: number; radius: number } {
    const sorted = [...this.tickMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0, radius: this.radius };
  }
}
