/** Condensed SDK declarations for Monaco IntelliSense. Keep in step with packages/sdk/src/client.ts. */
export const SDK_TYPES = `
declare module '@daemonet/sdk' {
  export interface Positioned { x: number; y: number }
  export interface DaemonEntity extends Positioned {
    kind: 'daemon'; id: string; species: string; types: string[]; level: number; hp: number; maxHp: number;
    owner: string | null; taggedBy: string | null; clean: boolean; signature: number; statuses: string[]; hardened: boolean;
    /** The Incident's kernel daemon, and whether it is immune until its adds are cleared. */
    boss?: boolean; shielded?: boolean;
    /** Wild daemons only: what your Codex research on the line reveals (nature at 4 captures, IV buckets at 16, exact IVs at 64). */
    scan?: { nature?: number; ivBuckets?: number[]; ivs?: number[] };
  }
  export interface DaemonView extends DaemonEntity { hpPct: number }
  export interface OperatorEntity extends Positioned { kind: 'operator'; id: string; name: string | null; /** The tag of the org this operator belongs to, or null. */ tag: string | null }
  export type Entity = OperatorEntity | DaemonEntity;
  export interface EvolutionOption { form: string; name: string; level: number; hidden: boolean; revealed: boolean; met: boolean; requirement: unknown[] | null }
  export interface RamDaemon {
    id: string; species: string; level: number; xp: number; nature: number; traitSlot: 0 | 1; ivs: number[]; bonus: number[]; clean: boolean; signature: number;
    hp: number; maxHp: number; energy: number; moves: string[]; crashed: boolean; slot: number; cooldowns: Record<string, number>;
    heldItem: string | null; patched: boolean; moveTypeUses: number[]; crashes: number; evolutions: EvolutionOption[];
  }
  export interface TicketDef { index: number; kind: 'clear' | 'capture' | 'deliver' | 'evolve'; params: unknown; target: number; reward: number; title: string }
  export interface OpenTicket { id: string; day: string; subnet: string; index: number; kind: 'clear' | 'capture' | 'deliver' | 'evolve'; params: unknown; target: number; reward: number; progress: number; title: string }
  export interface ClusterMember { id: string; name: string | null; subnet: string | null; away: boolean }
  export interface ClusterView { id: string; code: string; leaderId: string; members: ClusterMember[] }
  export interface OperatorSelf extends Positioned {
    id: string; name: string | null; starterClaimed: boolean; bits: number; diskCapacity: number; ram: RamDaemon[]; running: string[];
    tickets: OpenTicket[]; ticketsToday: number; ticketsDay?: string; research: Record<string, number>;
    inventory: Record<string, number>; swapReadyTick: number; capture: { captureId: string; targetId: string; deadlineTick: number } | null;
    /** The cluster you are in (join code, leader, members; away = not in your subnet), or null. */
    cluster: ClusterView | null;
    /** The org you are in (id, name, 4-character tag, your rank), or null. */
    org: { id: string; name: string; tag: string; rank: 'OWNER' | 'OFFICER' | 'MEMBER' } | null;
  }
  export class Query<T extends Positioned> {
    readonly length: number;
    all(): T[]; filter(pred: (item: T) => boolean): Query<T>; within(radius: number): Query<T>;
    nearest(pred?: (item: T) => boolean): T | undefined; lowestHp(pred?: (item: T) => boolean): T | undefined;
  }
  export interface GatewayDef { id: string; at: Positioned; to: string; arrive: Positioned; requires: { level: number } }
  export class WorldView { readonly daemons: Query<DaemonView>; readonly wild: Query<DaemonView>; readonly operators: Query<OperatorEntity>; readonly gateways: GatewayDef[]; readonly tickets: TicketDef[]; get(id: string): unknown }
  export class DaemonHandle {
    readonly id: string; readonly ram: RamDaemon | undefined; readonly entity: DaemonView | undefined; readonly x: number; readonly y: number; readonly hpPct: number; readonly energy: number;
    distanceTo(target: Positioned): number; canUse(moveId: string): boolean; bestMoveAgainst(foe: DaemonView): string | null;
    moveTo(x: number, y: number): Promise<unknown>; stop(): Promise<unknown>; use(moveId: string, aim: { id: string } & Positioned | Positioned): Promise<unknown>;
  }
  export interface OperatorScriptContext { client: GameClient; me: OperatorSelf; world: WorldView; tick: number }
  export interface DaemonScriptContext { client: GameClient; self: DaemonHandle; enemies: Query<DaemonView>; world: WorldView; tick: number }
  export class OperatorApi {
    moveTo(x: number, y: number): Promise<unknown>; stop(): Promise<unknown>; run(daemonId: string): Promise<unknown>; recall(daemonId: string): Promise<unknown>;
    swap(outId: string, inId: string): Promise<unknown>; capture(target: { id: string } | string, tool: 'sniff' | 'tap' | 'mirror' | 'dump'): Promise<unknown>;
    submitCapture(captureId: string, answer: unknown): Promise<unknown>; useRestore(daemonId: string): Promise<unknown>; restoreAll(): Promise<unknown>;
    claimStarter(species: string, operatorName: string): Promise<unknown>; store(daemonId: string): Promise<unknown>; load(daemonId: string): Promise<unknown>;
    travel(gatewayId: string): Promise<unknown>; evolve(daemonId: string, formId: string): Promise<unknown>; hold(daemonId: string, itemId: string): Promise<unknown>; unhold(daemonId: string): Promise<unknown>;
    useBitFlipper(daemonId: string, stat: 'hp' | 'attack' | 'defense' | 'focus' | 'resolve' | 'speed' | 'haste' | 'energy'): Promise<unknown>;
    buy(itemId: string, qty?: number): Promise<unknown>; craft(recipeId: string, qty?: number, using?: string): Promise<unknown>; decompile(daemonId: string, confirm?: boolean): Promise<unknown>;
    /** Exchange vault (at a host): deposit moves items out of your inventory, withdraw brings them back. */
    deposit(item: string, qty?: number): Promise<unknown>; withdraw(item: string, qty?: number): Promise<unknown>;
    acceptTicket(index: number, subnet?: string, day?: string): Promise<unknown>; abandonTicket(ticketId: string): Promise<unknown>;
    script(fn: (ctx: OperatorScriptContext) => void): () => void;
  }
  export class DaemonsApi { get(id: string): DaemonHandle; script(fn: (ctx: DaemonScriptContext) => void): () => void }
  export interface CaptureStartEvent { captureId: string; targetId: string; challenge: { kind: 'single' | 'chain'; families: string[]; params: unknown; payload: unknown }; deadlineTick: number }
  export interface ChatLine { id: string; channel: string; from: string; name: string | null; tag: string | null; text: string; at: string }
  /** Chat: one line per 2 s, queued for you (send never rejects with E_RATE). A DM line arrives with channel "dm:<your id>"; reply to line.channel. */
  export class ChatApi {
    /** Channels you can post to right now: your subnet, plus cluster and org channels once you are in them. */
    readonly channels: string[];
    send(channel: string, text: string): Promise<unknown>;
    dm(operatorId: string, text: string): Promise<unknown>;
  }
  /** Clusters: up to 4 operators sharing tags and XP. Rejections carry E_STATE / E_RANGE / E_INVALID / E_RATE. */
  export class ClusterApi {
    /** Creates a cluster of one (if needed); share its join code (client.self.cluster.code). */
    create(): Promise<unknown>;
    /** Invite an operator within 32 tiles in your subnet. */
    invite(operatorId: string): Promise<unknown>;
    accept(clusterId: string): Promise<unknown>;
    join(code: string): Promise<unknown>;
    leave(): Promise<unknown>;
    /** Leader only; the join code changes so the member cannot come back with the old one. */
    kick(operatorId: string): Promise<unknown>;
  }
  export interface IncidentEvent { phase: 'open' | 'fighting' | 'shield' | 'unshield' | 'cleared' | 'expired'; id: string; n: number; species: string; endsAt: string; bossId: string | null; participants?: Array<{ operatorId: string; name: string | null; damage: number; share: number; reward: number }> }
  export class GameClient {
    tick: number; operatorId: string; role: 'controller' | 'spectator'; subnet: string; entities: Map<string, Entity>; self: OperatorSelf; readonly world: WorldView; readonly operator: OperatorApi; readonly daemons: DaemonsApi; readonly chat: ChatApi; readonly cluster: ClusterApi;
    on(name: 'captureStart', handler: (ev: CaptureStartEvent) => void): () => void;
    on(name: 'captureResult', handler: (ev: { captureId: string; ok: boolean; reason?: string }) => void): () => void;
    on(name: 'tick', handler: (tick: number) => void): () => void;
    on(name: 'evolved', handler: (ev: { daemon: string; from: string; to: string; changes: unknown[] }) => void): () => void;
    on(name: 'discovery', handler: (ev: { form: string; operator: string; operatorName: string | null }) => void): () => void;
    on(name: 'travelled', handler: (ev: { from: string; to: string }) => void): () => void;
    on(name: 'bits', handler: (ev: { delta: number; reason: string; balance: number }) => void): () => void;
    on(name: 'decompiled', handler: (ev: { daemon: string; species: string; fragments: Record<string, number> }) => void): () => void;
    on(name: 'ticketProgress', handler: (ev: { ticketId: string; progress: number; target: number }) => void): () => void;
    on(name: 'ticketDone', handler: (ev: { ticketId: string; reward: number; unpaid?: boolean }) => void): () => void;
    /** Incidents (server-wide): the phase changed; "cleared" lists each operator's damage share and reward. */
    on(name: 'incident', handler: (ev: IncidentEvent) => void): () => void;
    /** A blast lands on this circle (tiles) at atTick: move your daemons and yourself out. */
    on(name: 'telegraph', handler: (ev: { x: number; y: number; radius: number; atTick: number }) => void): () => void;
    /** Your payout from a cleared Incident. */
    on(name: 'incidentReward', handler: (ev: { incidentId: string; reward: number; share: number }) => void): () => void;
    /** Something happened to you on the Exchange: kind 'fill' has detail { item, price, qty, side: 'buy' | 'sell', fee? } (fee only on a sale). */
    on(name: 'exchange', handler: (ev: { kind: string; detail: Record<string, unknown> }) => void): () => void;
    on(name: 'chat', handler: (line: ChatLine) => void): () => void;
    on(name: 'chatDeleted', handler: (ev: { id: string; channel: string }) => void): () => void;
    /** Your mute state changed: until is the end of the mute (ISO time), or null when it was lifted. */
    on(name: 'muted', handler: (ev: { until: string | null }) => void): () => void;
    /** Someone invites you to a cluster: accept with client.cluster.accept(clusterId) before expiresAt (ISO time). */
    on(name: 'clusterInvite', handler: (ev: { clusterId: string; from: string; name: string | null; expiresAt: string }) => void): () => void;
    on(name: string, handler: (value: any) => void): () => void;
  }
}
`;

/**
 * Scripts are modules whose default export is \`main(game)\`; the SDK arrives through \`game\` (no
 * \`import\` of '@daemonet/sdk': the worker has no module resolution). The JSDoc import below is a
 * comment, only the editor reads it.
 */
export const STARTER_TEMPLATE = `// Daemonet main script. Runs in a sandboxed worker with the same SDK a headless bot uses.
// The default export receives the connected game client; \`document\` and \`window\` do not exist here.

/** Packet-family solver: keep fragments whose crc = (seq + sum of bytes) & 0xff, reassemble, FNV-1a checksum. */
function solvePacket(params, payload) {
  const chunks = new Map();
  for (const f of payload.fragments) {
    const data = f.data.match(/../g).map((h) => parseInt(h, 16));
    if (((f.seq + data.reduce((s, b) => s + b, 0)) & 0xff) === f.crc) chunks.set(f.seq, data);
  }
  let h = 0x811c9dc5;
  for (let seq = 0; seq < params.count; seq++) for (const b of chunks.get(seq)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return { checksum: h.toString(16).padStart(8, '0') };
}

/** @param {import('@daemonet/sdk').GameClient} game */
export default async function main(game) {
  console.log('online as', game.self.name, 'at tick', game.tick);

  game.on('captureStart', ({ captureId, challenge }) => {
    if (challenge.kind === 'single' && challenge.families[0] === 'packet') {
      game.operator.submitCapture(captureId, solvePacket(challenge.params, challenge.payload));
    }
  });

  const attackable = (d) => d.types.includes('packet') && (d.taggedBy === null || d.taggedBy === game.operatorId);
  let busy = false;

  game.operator.script(({ me, world }) => {
    if (busy) return;
    const ready = me.ram.find((d) => !d.crashed);
    if (ready && me.running.length === 0 && me.swapReadyTick <= game.tick) { game.operator.run(ready.id); return; }
    const target = world.wild.nearest(attackable);
    if (!target || me.capture) return;
    if (Math.hypot(target.x - me.x, target.y - me.y) > 3) { game.operator.moveTo(target.x, target.y); return; }
    if (target.hpPct < 0.35 && (me.inventory.sniff ?? 0) > 0) {
      busy = true;
      game.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
    }
  });

  game.daemons.script(({ self, enemies }) => {
    const foe = enemies.nearest(attackable);
    if (!foe || foe.hpPct < 0.35) return;
    const move = self.bestMoveAgainst(foe);
    if (move) self.use(move, foe);
  });
}
`;
