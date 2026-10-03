import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, toSelf, type Input, type Intent, type IntentResult, type World } from '../core/index.js';
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
  world: World;
  store: Store;
  verify: TokenVerifier;
  seedId: string;
  log?: Logger;
  /** Waits between intent persistence attempts (default 128/512/2048 ms). */
  retryDelaysMs?: readonly number[];
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
}

const BUCKET_MAX = 64;
const BUCKET_REFILL_PER_TICK = 2;
const VIOLATION_WINDOW_TICKS = 1024;
const MAX_VIOLATIONS = 256;
const SLOW_TICK_MS = 50;
const RECOVERED_TICK_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Game {
  readonly world: World;
  private readonly store: Store;
  private readonly verify: TokenVerifier;
  private readonly seedId: string;
  private readonly log: Logger;
  private readonly retryDelays: readonly number[];
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
  /**
   * Pending command replies keyed `conn.id:reqId` (the key is the reqId the world sees), so a later connection that
   * reuses a reqId never receives an earlier connection's reply.
   */
  private readonly replyTo = new Map<string, ReplyRoute>();
  private radius = INTEREST_RADIUS;
  private readonly tickMs: number[] = [];

  constructor(opts: GameOptions) {
    this.world = opts.world;
    this.store = opts.store;
    this.verify = opts.verify;
    this.seedId = opts.seedId;
    this.log = opts.log ?? silent;
    this.retryDelays = opts.retryDelaysMs ?? [128, 512, 2048];
    this.checkpointEvery = opts.checkpointEveryTicks ?? 512;
    this.leaveAfter = opts.leaveAfterTicks ?? 128;
    this.authTimeout = opts.authTimeoutTicks ?? 80;
    this.idleTimeout = opts.idleTimeoutTicks ?? 768;
    this.maxSpectators = opts.maxSpectators ?? 4;
  }

  // ---- connections ----

  connect(conn: Conn): void {
    const t = this.world.tick;
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
    st.lastSeenTick = this.world.tick;
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
      if (!session) {
        if (!this.world.operators.has(rec.id)) this.world.addOperator(rec);
        session = {
          operatorId: rec.id, sub: claims.sub, controller: null, spectators: new Set(), resumeToken: randomHex(16), buffer: [], baseTick: this.world.tick,
          savedKnown: null, savedSelf: null, commandsThisTick: 0, violations: [], leaveAtTick: null,
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
        if (!session.controller && session.leaveAtTick === null) session.leaveAtTick = this.world.tick + this.leaveAfter;
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
      this.send(st, { t: 'authOk', seq: 0, d: { operatorId: rec.id, role: st.role, resumeToken: session.resumeToken, tick: this.world.tick } });
      if (!(st.role === 'controller' && this.tryResume(st, session, d.resumeToken, d.lastTick))) this.snapshot(st);
      this.log.info({ sub: claims.sub, role: st.role, ip: st.conn.ip }, 'operator connected');
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
    const subnet = this.world.subnet;
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
    if (token !== session.resumeToken || lastTick === undefined || !session.savedKnown) return false;
    if (lastTick < session.baseTick || lastTick > this.world.tick) return false;
    st.known = new Map(session.savedKnown);
    st.lastSelf = session.savedSelf;
    for (const entry of session.buffer) if (entry.tick > lastTick) this.send(st, entry.msg);
    return true;
  }

  private snapshot(st: ConnState): void {
    const op = this.world.operators.get(st.operatorId!)!;
    const session = this.sessions.get(st.operatorId!)!;
    if (st.role === 'controller') {
      session.buffer = [];
      session.baseTick = this.world.tick;
    }
    const entities = entitiesNear(this.world, op.x, op.y, this.radius);
    const self = toSelf(this.world, op);
    st.known = new Map(entities.map((e) => [e.id, e]));
    st.lastSelf = JSON.stringify(self);
    this.send(st, { t: 'snapshot', seq: 0, d: { tick: this.world.tick, subnet: this.world.subnet.id, self, entities } });
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
    const now = this.world.tick;
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
      session.leaveAtTick = this.world.tick + this.leaveAfter;
    }
  }

  // ---- the tick ----

  tick(): void {
    const t0 = performance.now();
    const world = this.world;
    for (const st of [...this.conns.values()]) {
      st.bucket = Math.min(BUCKET_MAX, st.bucket + BUCKET_REFILL_PER_TICK);
      if (st.phase !== 'ready' && world.tick - st.openedTick > this.authTimeout) this.kick(st, 'auth timeout', CLOSE.timeout);
      else if (st.phase === 'ready' && world.tick - st.lastSeenTick > this.idleTimeout) this.kick(st, 'idle', CLOSE.timeout);
    }

    const result = world.step(this.inputs);
    this.inputs = [];
    for (const s of this.sessions.values()) s.commandsThisTick = 0;

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
    for (const intent of result.intents) this.persist(intent);

    for (const session of this.sessions.values()) {
      const op = world.operators.get(session.operatorId);
      if (!op) continue;
      const events = result.events
        .filter((e) => (e.to === null ? e.at === null || distance(e.at, op) <= this.radius : e.to === op.id))
        .map((e) => e.event);
      const near = entitiesNear(world, op.x, op.y, this.radius);
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

    if (result.tick % this.checkpointEvery === 0) this.checkpointAll();
    for (const session of [...this.sessions.values()]) {
      if (!session.controller && session.leaveAtTick !== null && session.leaveAtTick <= result.tick) this.leave(session);
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

  private leave(session: Session): void {
    for (const load of this.loads.get(session.sub) ?? []) load.stale = true;
    const record = this.world.checkpoint(session.operatorId);
    this.world.removeOperator(session.operatorId);
    this.sessions.delete(session.operatorId);
    for (const st of [...session.spectators]) this.kick(st, 'operator left', CLOSE.left);
    for (const [key, route] of this.replyTo) {
      if (route.st.operatorId !== session.operatorId) continue;
      this.replyTo.delete(key);
      route.st.routes.delete(key);
    }
    const done = this.store
      .checkpoint([record])
      .catch((err: Error) => this.log.error({ sub: session.sub, err: err.message }, 'leave checkpoint failed'))
      .finally(() => this.leaving.delete(session.sub));
    this.leaving.set(session.sub, done);
    this.track(done);
    this.log.info({ sub: session.sub }, 'operator left');
  }

  private checkpointAll(): void {
    const records = [...this.world.operators.keys()].map((id) => this.world.checkpoint(id));
    this.track(this.store.checkpoint(records).catch((err: Error) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  private persist(intent: Intent): void {
    const stored = intent.kind === 'store' ? this.world.daemons.get(intent.daemonId) : undefined;
    const ctx = { seedId: this.seedId, ...(stored ? { storedDaemon: this.world.toRecord(stored) } : {}) };
    const run = async () => {
      let result: IntentResult = { ok: false, reason: 'persist failed' };
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        try {
          result = await this.store.applyIntent(intent, ctx);
          break;
        } catch (err) {
          this.log.warn({ intent: intent.id, attempt, err: (err as Error).message }, 'intent persist failed');
          const delay = this.retryDelays[attempt];
          if (delay === undefined) break;
          await sleep(delay);
        }
      }
      this.world.completeIntent(intent.id, result);
    };
    this.track(run());
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

  /** Checkpoint everyone and wait for persistence. */
  async shutdown(): Promise<void> {
    for (const st of [...this.conns.values()]) this.kick(st, 'server shutting down', 1001);
    this.checkpointAll();
    await this.flush();
  }

  stats(): { p50: number; p99: number; max: number; radius: number } {
    const sorted = [...this.tickMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0, radius: this.radius };
  }
}
