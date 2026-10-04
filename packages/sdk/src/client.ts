import { getMove, getSubnet, typeMultiplier, type GatewayDef, type StatKey, type ToolId } from '@daemonet/rules';
import {
  COMMANDS_PER_TICK,
  HEARTBEAT_MS,
  ServerMessage,
  type Command,
  type Entity,
  type GameEvent,
  type OperatorSelf,
  type RamDaemon,
} from '@daemonet/shared';
import type { TokenSource } from './auth.js';
import { DaemonetError } from './errors.js';
import { Query, distance, viewOf, type DaemonEntity, type DaemonView, type OperatorEntity, type Positioned } from './views.js';

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ConnectOptions {
  /** e.g. wss://daemonet.wispy-nook.casa/ws */
  url: string;
  auth: TokenSource;
  role?: 'controller' | 'spectator';
  /** Defaults to the global WebSocket (browsers, Node 22+). */
  WebSocket?: WebSocketCtor;
  /** Reconnect with resume after unexpected disconnects (default true). */
  reconnect?: boolean;
  commandTimeoutMs?: number;
  heartbeatMs?: number;
}

type ClientEvents = {
  [K in GameEvent['e']]: Extract<GameEvent, { e: K }>;
} & {
  tick: number;
  ready: void;
  error: DaemonetError;
  kick: string;
  disconnect: { code: number; reason: string };
  reconnect: void;
  scriptError: unknown;
  /** Every raw frame received from the server (used by the sandbox bridge). */
  frame: string;
};

export interface Target extends Positioned {
  id: string;
}

type Aim = Target | { x: number; y: number };

export interface OperatorScriptContext {
  client: GameClient;
  me: OperatorSelf;
  world: WorldView;
  tick: number;
}

export interface DaemonScriptContext {
  client: GameClient;
  self: DaemonHandle;
  /** Wild daemons you may attack (untagged or tagged by you) within 16 tiles of this daemon. */
  enemies: Query<DaemonView>;
  world: WorldView;
  tick: number;
}

const BACKOFF_MIN_MS = 256;
const BACKOFF_MAX_MS = 8192;
const ENEMY_RADIUS = 16;
/** Kick reasons after which reconnecting can succeed; every other kick is terminal. */
export const TRANSIENT_KICKS: ReadonlySet<string> = new Set(['idle', 'auth timeout', 'server shutting down']);

export class WorldView {
  constructor(private readonly client: GameClient) {}

  private origin(): Positioned {
    return this.client.self;
  }

  /** Every daemon in view. */
  get daemons(): Query<DaemonView> {
    const all = [...this.client.entities.values()].filter((e): e is DaemonEntity => e.kind === 'daemon').map(viewOf);
    return new Query(all, this.origin());
  }

  /** Wild daemons in view, relative to your operator. */
  get wild(): Query<DaemonView> {
    return this.daemons.filter((d) => d.owner === null);
  }

  get operators(): Query<OperatorEntity> {
    const ops = [...this.client.entities.values()].filter((e): e is OperatorEntity => e.kind === 'operator');
    return new Query(ops, this.origin());
  }

  get(id: string): Entity | undefined {
    return this.client.entities.get(id);
  }

  /** Gateways of the current subnet (static content), nearest first. */
  get gateways(): GatewayDef[] {
    let gateways: readonly GatewayDef[];
    try {
      gateways = getSubnet(this.client.subnet).gateways;
    } catch {
      return [];
    }
    const me = this.origin();
    return [...gateways].sort((a, b) => distance(a.at, me) - distance(b.at, me));
  }
}

export class DaemonHandle {
  constructor(
    private readonly client: GameClient,
    readonly id: string,
  ) {}

  get ram(): RamDaemon | undefined {
    return this.client.self.ram.find((d) => d.id === this.id);
  }

  get entity(): DaemonView | undefined {
    const e = this.client.entities.get(this.id);
    return e?.kind === 'daemon' ? viewOf(e) : undefined;
  }

  get x(): number {
    return this.entity?.x ?? this.client.self.x;
  }

  get y(): number {
    return this.entity?.y ?? this.client.self.y;
  }

  get hpPct(): number {
    const r = this.ram;
    return r && r.maxHp > 0 ? r.hp / r.maxHp : 0;
  }

  get energy(): number {
    return this.ram?.energy ?? 0;
  }

  distanceTo(target: Positioned): number {
    return distance(this, target);
  }

  /** Known, off cooldown and affordable. */
  canUse(moveId: string): boolean {
    const r = this.ram;
    if (!r || !r.moves.includes(moveId)) return false;
    return (r.cooldowns[moveId] ?? 0) <= this.client.tick && r.energy >= getMove(moveId).energyCost;
  }

  /** The strongest usable move that can reach `foe` and is not immune, or null. */
  bestMoveAgainst(foe: DaemonEntity): string | null {
    const r = this.ram;
    const me = this.entity;
    if (!r || !me) return null;
    const dist = this.distanceTo(foe);
    let best: { id: string; score: number } | null = null;
    for (const id of r.moves) {
      if (!this.canUse(id)) continue;
      const m = getMove(id);
      const reach = m.shape.kind === 'cone' ? m.shape.length : m.range;
      if (dist > reach) continue;
      const score = m.power * typeMultiplier(m.type, foe.types) * (me.types.includes(m.type) ? 1.5 : 1);
      if (score > 0 && (!best || score > best.score)) best = { id, score };
    }
    return best?.id ?? null;
  }

  moveTo(x: number, y: number): Promise<unknown> {
    return this.client.command({ cmd: 'moveTo', actor: this.id, args: { x, y } });
  }

  stop(): Promise<unknown> {
    return this.client.command({ cmd: 'stop', actor: this.id, args: {} });
  }

  use(moveId: string, aim: Aim): Promise<unknown> {
    const args = 'id' in aim ? { move: moveId, targetId: aim.id } : { move: moveId, x: aim.x, y: aim.y };
    return this.client.command({ cmd: 'use', actor: this.id, args });
  }
}

export class OperatorApi {
  constructor(private readonly client: GameClient) {}

  moveTo(x: number, y: number) {
    return this.client.command({ cmd: 'moveTo', actor: 'self', args: { x, y } });
  }
  stop() {
    return this.client.command({ cmd: 'stop', actor: 'self', args: {} });
  }
  run(daemonId: string) {
    return this.client.command({ cmd: 'run', actor: 'self', args: { daemonId } });
  }
  recall(daemonId: string) {
    return this.client.command({ cmd: 'recall', actor: 'self', args: { daemonId } });
  }
  swap(outId: string, inId: string) {
    return this.client.command({ cmd: 'swap', actor: 'self', args: { outId, inId } });
  }
  capture(target: Target | string, tool: ToolId) {
    return this.client.command({ cmd: 'capture', actor: 'self', args: { targetId: typeof target === 'string' ? target : target.id, tool } });
  }
  submitCapture(captureId: string, answer: unknown) {
    return this.client.command({ cmd: 'submitCapture', actor: 'self', args: { captureId, answer } });
  }
  useRestore(daemonId: string) {
    return this.client.command({ cmd: 'useItem', actor: 'self', args: { item: 'restore', daemonId } });
  }
  /** Raises one IV by 1 (cap 31) and marks the daemon patched forever. */
  useBitFlipper(daemonId: string, stat: StatKey) {
    return this.client.command({ cmd: 'useItem', actor: 'self', args: { item: 'bitflipper', daemonId, stat } });
  }
  evolve(daemonId: string, formId: string) {
    return this.client.command({ cmd: 'evolve', actor: 'self', args: { daemonId, formId } });
  }
  hold(daemonId: string, itemId: string) {
    return this.client.command({ cmd: 'hold', actor: 'self', args: { daemonId, itemId } });
  }
  unhold(daemonId: string) {
    return this.client.command({ cmd: 'unhold', actor: 'self', args: { daemonId } });
  }
  restoreAll() {
    return this.client.command({ cmd: 'restoreAll', actor: 'self', args: {} });
  }
  /** Travel through a gateway you are standing on; resolves when the new subnet's snapshot has arrived. */
  travel(gatewayId: string) {
    return this.client.command({ cmd: 'travel', actor: 'self', args: { gatewayId } });
  }
  claimStarter(species: string, operatorName: string) {
    return this.client.command({ cmd: 'claimStarter', actor: 'self', args: { species, operatorName } });
  }
  store(daemonId: string) {
    return this.client.command({ cmd: 'store', actor: 'self', args: { daemonId } });
  }
  load(daemonId: string) {
    return this.client.command({ cmd: 'load', actor: 'self', args: { daemonId } });
  }

  /** Runs `fn` once per tick after the world update. Returns an unsubscribe function. */
  script(fn: (ctx: OperatorScriptContext) => void): () => void {
    return this.client.addScript(() => fn({ client: this.client, me: this.client.self, world: this.client.world, tick: this.client.tick }));
  }
}

export class DaemonsApi {
  constructor(private readonly client: GameClient) {}

  get(id: string): DaemonHandle {
    return new DaemonHandle(this.client, id);
  }

  /** Runs `fn` once per tick for each running daemon. Returns an unsubscribe function. */
  script(fn: (ctx: DaemonScriptContext) => void): () => void {
    return this.client.addScript(() => {
      const me = this.client.self;
      for (const id of me.running) {
        const self = new DaemonHandle(this.client, id);
        const enemies = new Query(
          this.client.world.wild.all().filter((d) => d.taggedBy === null || d.taggedBy === me.id),
          self,
        ).within(ENEMY_RADIUS);
        fn({ client: this.client, self, enemies, world: this.client.world, tick: this.client.tick });
      }
    });
  }
}

export class GameClient {
  tick = 0;
  operatorId = '';
  role: 'controller' | 'spectator' = 'controller';
  subnet = '';
  self!: OperatorSelf;
  readonly entities = new Map<string, Entity>();
  readonly world = new WorldView(this);
  readonly operator = new OperatorApi(this);
  readonly daemons = new DaemonsApi(this);

  private ws: WebSocketLike | null = null;
  private readonly Ws: WebSocketCtor;
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  private readonly scripts = new Set<() => void>();
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: DaemonetError) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqCounter = 0;
  private seq = 0;
  private sentThisTick = 0;
  private resumeToken: string | undefined;
  private hasState = false;
  private closedByUser = false;
  private noReconnect = false;
  /** The most specific reason the connection attempt failed, used when settling `ready`. */
  private failure: DaemonetError | null = null;
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ready!: { resolve: () => void; reject: (e: Error) => void };
  private readonly unsubscribeRefresh: (() => void) | undefined;

  constructor(private readonly opts: ConnectOptions) {
    const Ws = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ws) throw new Error('No WebSocket implementation available; pass options.WebSocket');
    this.Ws = Ws;
    this.unsubscribeRefresh = opts.auth.onRefresh?.((token) => this.sendRaw({ t: 'reauth', seq: ++this.seq, d: { token } }));
  }

  /** Opens the connection; resolves after the first world state arrives. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
      void this.open();
    });
  }

  on<K extends keyof ClientEvents>(name: K, handler: (value: ClientEvents[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(handler as (v: unknown) => void);
    return () => set.delete(handler as (v: unknown) => void);
  }

  /** @internal */
  addScript(run: () => void): () => void {
    this.scripts.add(run);
    return () => this.scripts.delete(run);
  }

  /** Sends a command; resolves with the ack result or rejects with a DaemonetError. */
  command(command: Command): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.sentThisTick >= COMMANDS_PER_TICK) {
        reject(new DaemonetError('E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`));
        return;
      }
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new DaemonetError('E_STATE', 'not connected'));
        return;
      }
      this.sentThisTick++;
      const reqId = `c${++this.reqCounter}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DaemonetError('E_STATE', 'command timed out'));
      }, this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.sendRaw({ t: 'cmd', seq: ++this.seq, d: { reqId, ...command } });
    });
    // Scripts often fire-and-forget; avoid unhandled-rejection noise while still letting callers await.
    promise.catch(() => {});
    return promise;
  }

  close(): void {
    this.closedByUser = true;
    this.unsubscribeRefresh?.();
    this.stopHeartbeat();
    this.ws?.close(1000, 'client closed');
  }

  /** Testing aid: drop the socket as if the network failed (the client reconnects and resumes). */
  dropConnection(): void {
    this.ws?.close(4000, 'dropped');
  }

  /** Sends a raw protocol frame (the sandbox bridge forwards already-validated `cmd` frames this way). */
  sendFrame(raw: string): void {
    this.sendRaw(JSON.parse(raw));
  }

  private emit<K extends keyof ClientEvents>(name: K, value: ClientEvents[K]): void {
    for (const h of this.listeners.get(name) ?? []) {
      try {
        h(value);
      } catch (err) {
        if (name !== 'scriptError') this.emit('scriptError', err);
      }
    }
  }

  private sendRaw(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private async open(): Promise<void> {
    let token: string;
    try {
      token = await this.opts.auth.getToken();
    } catch (err) {
      if (this.closedByUser) return;
      const error = err instanceof DaemonetError ? err : new DaemonetError('E_AUTH', err instanceof Error ? err.message : 'token unavailable');
      if (!this.hasState) {
        this.noReconnect = true;
        this.ready.reject(error);
        return;
      }
      this.emit('error', error);
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return;
    const ws = new this.Ws(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      const d: Record<string, unknown> = { token, role: this.opts.role ?? 'controller' };
      if (this.resumeToken && this.hasState) {
        d.resumeToken = this.resumeToken;
        d.lastTick = this.tick;
      }
      this.sendRaw({ t: 'auth', seq: ++this.seq, d });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onerror = () => {};
    ws.onclose = (ev) => this.closed(ws, ev.code, ev.reason);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.sendRaw({ t: 'ping', seq: ++this.seq, d: {} }), this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private closed(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.stopHeartbeat();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DaemonetError('E_STATE', 'disconnected'));
      this.pending.delete(id);
    }
    this.emit('disconnect', { code, reason });
    if (!this.hasState) {
      // The first connection never produced a snapshot: settle connect() instead of retrying forever.
      this.noReconnect = true;
      this.ready.reject(this.failure ?? new DaemonetError('E_STATE', `connection closed: ${code} ${reason}`));
      return;
    }
    if (this.closedByUser || this.noReconnect || this.opts.reconnect === false) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts++);
    setTimeout(() => {
      if (!this.closedByUser) void this.open();
    }, delay);
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = ServerMessage.parse(JSON.parse(raw));
    } catch {
      return;
    }
    this.emit('frame', raw);
    switch (msg.t) {
      case 'authOk':
        this.operatorId = msg.d.operatorId;
        this.role = msg.d.role;
        this.resumeToken = msg.d.resumeToken;
        if (this.attempts > 0) this.emit('reconnect', undefined);
        this.attempts = 0;
        return;
      case 'snapshot': {
        this.tick = msg.d.tick;
        this.subnet = msg.d.subnet;
        this.self = msg.d.self;
        this.entities.clear();
        for (const e of msg.d.entities) this.entities.set(e.id, e);
        this.hasState = true;
        this.ready.resolve();
        this.emit('ready', undefined);
        return;
      }
      case 'delta': {
        this.tick = msg.d.tick;
        for (const id of msg.d.removes) this.entities.delete(id);
        for (const patch of msg.d.upserts) {
          const prev = this.entities.get(patch.id);
          this.entities.set(patch.id, prev && prev.kind === patch.kind ? ({ ...prev, ...patch } as Entity) : (patch as Entity));
        }
        if (msg.d.self) this.self = msg.d.self;
        this.sentThisTick = 0;
        for (const ev of msg.d.events) this.emit(ev.e, ev as never);
        this.emit('tick', this.tick);
        for (const run of this.scripts) {
          try {
            run();
          } catch (err) {
            this.emit('scriptError', err);
          }
        }
        return;
      }
      case 'ack': {
        const p = this.pending.get(msg.d.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.d.reqId);
        p.resolve(msg.d.result);
        return;
      }
      case 'err': {
        const error = new DaemonetError(msg.d.code, msg.d.message);
        const p = msg.d.reqId ? this.pending.get(msg.d.reqId) : undefined;
        if (p && msg.d.reqId) {
          clearTimeout(p.timer);
          this.pending.delete(msg.d.reqId);
          p.reject(error);
        } else {
          if (!this.hasState) this.failure = error;
          this.emit('error', error);
        }
        return;
      }
      case 'kick':
        if (!this.hasState) {
          this.failure = new DaemonetError(msg.d.reason === 'unauthorized' || msg.d.reason === 'auth required' ? 'E_AUTH' : 'E_STATE', msg.d.reason);
          this.noReconnect = true;
        } else if (!TRANSIENT_KICKS.has(msg.d.reason)) this.noReconnect = true;
        this.emit('kick', msg.d.reason);
        return;
      case 'pong':
        return;
    }
  }
}

/** Connects and resolves once the first world snapshot has arrived. */
export async function connect(opts: ConnectOptions): Promise<GameClient> {
  const client = new GameClient(opts);
  await client.start();
  return client;
}

export type { DaemonView, DaemonEntity, OperatorEntity };
