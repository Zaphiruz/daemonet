/** Condensed SDK declarations for Monaco IntelliSense. Keep in step with packages/sdk/src/client.ts. */
export const SDK_TYPES = `
declare module '@daemonet/sdk' {
  export interface Positioned { x: number; y: number }
  export interface DaemonEntity extends Positioned {
    kind: 'daemon'; id: string; species: string; types: string[]; level: number; hp: number; maxHp: number;
    owner: string | null; taggedBy: string | null; clean: boolean; signature: number; statuses: string[]; hardened: boolean;
  }
  export interface DaemonView extends DaemonEntity { hpPct: number }
  export interface OperatorEntity extends Positioned { kind: 'operator'; id: string; name: string | null }
  export type Entity = OperatorEntity | DaemonEntity;
  export interface EvolutionOption { form: string; name: string; level: number; hidden: boolean; revealed: boolean; met: boolean; requirement: unknown[] | null }
  export interface RamDaemon {
    id: string; species: string; level: number; xp: number; nature: number; traitSlot: 0 | 1; ivs: number[]; bonus: number[]; clean: boolean; signature: number;
    hp: number; maxHp: number; energy: number; moves: string[]; crashed: boolean; slot: number; cooldowns: Record<string, number>;
    heldItem: string | null; patched: boolean; moveTypeUses: number[]; crashes: number; evolutions: EvolutionOption[];
  }
  export interface OperatorSelf extends Positioned {
    id: string; name: string | null; starterClaimed: boolean; bits: number; diskCapacity: number; ram: RamDaemon[]; running: string[];
    inventory: Record<string, number>; swapReadyTick: number; capture: { captureId: string; targetId: string; deadlineTick: number } | null;
  }
  export class Query<T extends Positioned> {
    readonly length: number;
    all(): T[]; filter(pred: (item: T) => boolean): Query<T>; within(radius: number): Query<T>;
    nearest(pred?: (item: T) => boolean): T | undefined; lowestHp(pred?: (item: T) => boolean): T | undefined;
  }
  export interface GatewayDef { id: string; at: Positioned; to: string; arrive: Positioned; requires: { level: number } }
  export class WorldView { readonly daemons: Query<DaemonView>; readonly wild: Query<DaemonView>; readonly operators: Query<OperatorEntity>; readonly gateways: GatewayDef[]; get(id: string): unknown }
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
    script(fn: (ctx: OperatorScriptContext) => void): () => void;
  }
  export class DaemonsApi { get(id: string): DaemonHandle; script(fn: (ctx: DaemonScriptContext) => void): () => void }
  export interface CaptureStartEvent { captureId: string; targetId: string; challenge: { kind: 'single' | 'chain'; families: string[]; params: unknown; payload: unknown }; deadlineTick: number }
  export class GameClient {
    tick: number; operatorId: string; role: 'controller' | 'spectator'; subnet: string; entities: Map<string, Entity>; self: OperatorSelf; readonly world: WorldView; readonly operator: OperatorApi; readonly daemons: DaemonsApi;
    on(name: 'captureStart', handler: (ev: CaptureStartEvent) => void): () => void;
    on(name: 'captureResult', handler: (ev: { captureId: string; ok: boolean; reason?: string }) => void): () => void;
    on(name: 'tick', handler: (tick: number) => void): () => void;
    on(name: 'evolved', handler: (ev: { daemon: string; from: string; to: string; changes: unknown[] }) => void): () => void;
    on(name: 'discovery', handler: (ev: { form: string; operator: string; operatorName: string | null }) => void): () => void;
    on(name: 'travelled', handler: (ev: { from: string; to: string }) => void): () => void;
    on(name: 'bits', handler: (ev: { delta: number; reason: string; balance: number }) => void): () => void;
    on(name: 'decompiled', handler: (ev: { daemon: string; species: string; fragments: Record<string, number> }) => void): () => void;
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
