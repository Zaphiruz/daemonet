import { timingSafeEqual } from 'node:crypto';
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, isEconomyIntent, toSelf, type Input, type Intent, type IntentResult, type OperatorRecord, type World } from '../core/index.js';
import type { TokenVerifier } from './auth.js';
import { diffEntities } from './interest.js';
import { randomHex, type Store } from './store.js';

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
/** Kick reason when an operator must reconnect to reload its state from the store (transient in the SDK). */
export const RELOAD_KICK = 'reload required';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  constructor(opts: GameOptions) {
    const worlds = opts.worlds ?? (opts.world ? [opts.world] : []);
    if (worlds.length === 0) throw new Error('Game needs at least one world');
    this.worlds = new Map(worlds.map((w) => [w.subnet.id, w]));
    if (this.worlds.size !== worlds.length) throw new Error('Game worlds must host distinct subnets');
    for (const w of worlds) w.hosted = (subnet) => this.worlds.has(subnet);
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
        };
        this.sessions.set(rec.id, session);
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

    for (const world of this.worlds.values()) this.stepWorld(world, inputsByWorld.get(world) ?? []);

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

  /** Any economy intent or starter claim of the operator still pending (`World.economyInFlight`). */
  private economyInFlight(session: Session): boolean {
    return session.world.economyInFlight(session.operatorId);
  }

  private leave(session: Session): void {
    for (const load of this.loads.get(session.sub) ?? []) load.stale = true;
    const world = session.world;
    const record = this.record(world, session.operatorId);
    world.removeOperator(session.operatorId);
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
   * source subnet, and the travel intent (queued on the same chain) is what moves it.
   */
  private checkpointAll(): void {
    const records: OperatorRecord[] = [];
    for (const world of this.worlds.values()) {
      for (const op of world.operators.values()) if (!op.travelling) records.push(this.record(world, op.id));
    }
    if (records.length === 0) return;
    this.track(this.writeCheckpoint(records, (err) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  /** The operator's checkpoint record; a session that must reload never writes its inventory (the store is the truth). */
  private record(world: World, operatorId: string): OperatorRecord {
    const rec = world.checkpoint(operatorId);
    return this.sessions.get(operatorId)?.reloadRequired ? { ...rec, inventoryInFlight: true } : rec;
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
      world.completeIntent(intent.id, result);
      if (intent.kind === 'evolve' && result.ok) this.shareDiscovery(world, intent, result.discovered === true);
      if (intent.kind === 'travel' && result.ok) this.moveOperator(world, intent);
    };
    this.track(run());
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
