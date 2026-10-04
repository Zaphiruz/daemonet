import { BOARD_SIZE, BUY_MAX_QTY, CRAFT_MAX_QTY, STATUS_IDS, TYPES } from '@daemonet/rules';
import { z } from 'zod';

/** Upstream limits (UTF-8 bytes). submitCapture gets the larger limit. */
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_SUBMIT_BYTES = 16384;
export const HEARTBEAT_MS = 16_000;
export const RESUME_TICKS = 64;
export const COMMANDS_PER_TICK = 8;

export const ERROR_CODES = ['E_COOLDOWN', 'E_RANGE', 'E_ENERGY', 'E_RATE', 'E_STATE', 'E_AUTH', 'E_INVALID'] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

const Id = z.string().min(1).max(64);
const Coord = z.number().finite();
const TypeIdSchema = z.enum(TYPES);
const Self = z.literal('self');
/** Operator names (claimStarter, and renames pushed by the api). */
export const OperatorName = z.string().regex(/^[a-z0-9_-]{3,16}$/);

// ---- Commands (client -> server, inside a `cmd` message) ----

export const Command = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('moveTo'), actor: Id, args: z.object({ x: Coord, y: Coord }) }),
  z.object({ cmd: z.literal('stop'), actor: Id, args: z.object({}) }),
  z.object({ cmd: z.literal('run'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('recall'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('swap'), actor: Self, args: z.object({ outId: Id, inId: Id }) }),
  z.object({ cmd: z.literal('capture'), actor: Self, args: z.object({ targetId: Id, tool: z.enum(['sniff', 'tap', 'mirror', 'dump']) }) }),
  z.object({ cmd: z.literal('submitCapture'), actor: Self, args: z.object({ captureId: Id, answer: z.unknown() }) }),
  z.object({
    cmd: z.literal('useItem'),
    actor: Self,
    args: z.object({ item: z.enum(['restore', 'bitflipper']), daemonId: Id, stat: z.enum(['hp', 'attack', 'defense', 'focus', 'resolve', 'speed', 'haste', 'energy']).optional() }),
  }),
  z.object({ cmd: z.literal('evolve'), actor: Self, args: z.object({ daemonId: Id, formId: Id }) }),
  z.object({ cmd: z.literal('hold'), actor: Self, args: z.object({ daemonId: Id, itemId: Id }) }),
  z.object({ cmd: z.literal('unhold'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('travel'), actor: Self, args: z.object({ gatewayId: Id }) }),
  z.object({ cmd: z.literal('buy'), actor: Self, args: z.object({ itemId: Id, qty: z.number().int().min(1).max(BUY_MAX_QTY).default(1) }) }),
  z.object({
    cmd: z.literal('craft'),
    actor: Self,
    args: z.object({ recipeId: Id, qty: z.number().int().min(1).max(CRAFT_MAX_QTY).default(1), using: TypeIdSchema.optional() }),
  }),
  z.object({ cmd: z.literal('decompile'), actor: Self, args: z.object({ daemonId: Id, confirm: z.boolean().default(false) }) }),
  z.object({ cmd: z.literal('acceptTicket'), actor: Self, args: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), subnet: Id, index: z.number().int().min(0).max(BOARD_SIZE - 1) }) }),
  z.object({ cmd: z.literal('abandonTicket'), actor: Self, args: z.object({ ticketId: Id }) }),
  z.object({ cmd: z.literal('clusterCreate'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('clusterInvite'), actor: Self, args: z.object({ operatorId: Id }) }),
  z.object({ cmd: z.literal('clusterAccept'), actor: Self, args: z.object({ clusterId: Id }) }),
  z.object({ cmd: z.literal('clusterJoin'), actor: Self, args: z.object({ code: z.string().regex(/^[A-Za-z0-9]{6}$/) }) }),
  z.object({ cmd: z.literal('clusterLeave'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('clusterKick'), actor: Self, args: z.object({ operatorId: Id }) }),
  z.object({ cmd: z.literal('chat'), actor: Self, args: z.object({ channel: z.string().min(3).max(80), text: z.string().min(1).max(512) }) }),
  z.object({ cmd: z.literal('restoreAll'), actor: Self, args: z.object({}) }),
  z.object({ cmd: z.literal('claimStarter'), actor: Self, args: z.object({ species: Id, operatorName: OperatorName }) }),
  z.object({ cmd: z.literal('store'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({ cmd: z.literal('load'), actor: Self, args: z.object({ daemonId: Id }) }),
  z.object({
    cmd: z.literal('use'),
    actor: Id,
    args: z.object({ move: Id, targetId: Id.optional(), x: Coord.optional(), y: Coord.optional() }),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandName = Command['cmd'];

// ---- Client messages ----

const Seq = z.number().int().nonnegative();

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('auth'),
    seq: Seq,
    d: z.object({
      token: z.string().min(1).max(8192),
      role: z.enum(['controller', 'spectator']).default('controller'),
      resumeToken: z.string().max(128).optional(),
      lastTick: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({ t: z.literal('reauth'), seq: Seq, d: z.object({ token: z.string().min(1).max(8192) }) }),
  z.object({ t: z.literal('cmd'), seq: Seq, d: z.intersection(z.object({ reqId: Id }), Command) }),
  z.object({ t: z.literal('ping'), seq: Seq, d: z.object({}) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- Entities (public, within interest radius) ----

export const StatusSchema = z.enum(STATUS_IDS);

export const OperatorEntity = z.object({
  kind: z.literal('operator'),
  id: Id,
  name: z.string().nullable(),
  /** Org tag (4 chars) or null. */
  tag: z.string().nullable(),
  x: Coord,
  y: Coord,
});

export const DaemonEntity = z.object({
  kind: z.literal('daemon'),
  id: Id,
  species: Id,
  types: z.array(TypeIdSchema).min(1).max(2),
  level: z.number().int(),
  x: Coord,
  y: Coord,
  hp: z.number(),
  maxHp: z.number(),
  /** Operator id for running daemons, null for wild ones. */
  owner: Id.nullable(),
  /**
   * Who holds the tag on a wild daemon, as the viewer sees it: the viewer's own id when the viewer's party (it, or its
   * cluster) holds it; otherwise the holder's operator id or an opaque `cluster:<id>`.
   */
  taggedBy: Id.nullable(),
  clean: z.boolean(),
  signature: z.number().int().min(0).max(15),
  statuses: z.array(StatusSchema),
  hardened: z.boolean(),
  /** Incident boss (kernel daemon); `shielded` while its adds are alive. */
  boss: z.boolean().optional(),
  shielded: z.boolean().optional(),
  /** Wild daemons only: what the viewer's Codex research reveals (design §7.2). */
  scan: z
    .object({
      nature: z.number().int().optional(),
      /** IV buckets 0-3 (0-7, 8-15, 16-23, 24-31), STAT_KEYS order. */
      ivBuckets: z.array(z.number().int().min(0).max(3)).length(8).optional(),
      ivs: z.array(z.number().int()).length(8).optional(),
    })
    .optional(),
});

export const Entity = z.discriminatedUnion('kind', [OperatorEntity, DaemonEntity]);
export type Entity = z.infer<typeof Entity>;

/** Changed fields only; `kind` and `id` are always present. */
export const EntityPatch = z.discriminatedUnion('kind', [
  OperatorEntity.partial().extend({ kind: z.literal('operator'), id: Id }),
  DaemonEntity.partial().extend({ kind: z.literal('daemon'), id: Id }),
]);
export type EntityPatch = z.infer<typeof EntityPatch>;

// ---- Private operator state ----

export const RamDaemon = z.object({
  id: Id,
  species: Id,
  level: z.number().int(),
  xp: z.number().int(),
  nature: z.number().int().min(0).max(15),
  traitSlot: z.union([z.literal(0), z.literal(1)]),
  ivs: z.array(z.number().int()).length(8),
  bonus: z.array(z.number().int()).length(8),
  clean: z.boolean(),
  signature: z.number().int().min(0).max(15),
  hp: z.number(),
  maxHp: z.number(),
  energy: z.number(),
  moves: z.array(Id).max(4),
  crashed: z.boolean(),
  slot: z.number().int(),
  /** move id -> tick at which it is ready again. */
  cooldowns: z.record(z.string(), z.number().int()),
  heldItem: z.string().nullable(),
  patched: z.boolean(),
  /** lifetime move uses per type, TYPES order */
  moveTypeUses: z.array(z.number().int()).length(16),
  crashes: z.number().int(),
  evolutions: z.array(
    z.object({
      form: Id,
      name: z.string(),
      level: z.number().int(),
      hidden: z.boolean(),
      revealed: z.boolean(),
      met: z.boolean(),
      requirement: z.array(z.unknown()).nullable(),
    }),
  ),
});
export type RamDaemon = z.infer<typeof RamDaemon>;

export const OperatorSelf = z.object({
  id: Id,
  name: z.string().nullable(),
  starterClaimed: z.boolean(),
  x: Coord,
  y: Coord,
  bits: z.number().int(),
  diskCapacity: z.number().int(),
  /** Open helpdesk tickets. */
  tickets: z.array(
    z.object({
      id: Id,
      day: z.string(),
      subnet: Id,
      index: z.number().int(),
      kind: z.enum(['clear', 'capture', 'deliver', 'evolve']),
      params: z.unknown(),
      target: z.number().int(),
      reward: z.number().int(),
      progress: z.number().int(),
      title: z.string(),
    }),
  ),
  /** The org this operator belongs to (SP4), or null. */
  org: z.object({ id: Id, name: z.string(), tag: z.string(), rank: z.enum(['OWNER', 'OFFICER', 'MEMBER']) }).nullable(),
  /** The cluster this operator is in (SP4): join code, leader, members with their subnet; `away` = not in your subnet. */
  cluster: z
    .object({
      id: Id,
      code: z.string(),
      leaderId: Id,
      members: z.array(z.object({ id: Id, name: z.string().nullable(), subnet: z.string().nullable(), away: z.boolean() })),
    })
    .nullable(),
  /** Tickets accepted today (UTC), of TICKETS_PER_DAY. */
  ticketsToday: z.number().int(),
  /** The server's UTC day (YYYY-MM-DD) `ticketsToday` counts; the day of today's boards. */
  ticketsDay: z.string().optional(),
  /** Codex research points per bestiary line (keys are line numbers). */
  research: z.record(z.string(), z.number().int()),
  ram: z.array(RamDaemon).max(8),
  running: z.array(Id).max(2),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  swapReadyTick: z.number().int(),
  capture: z.object({ captureId: Id, targetId: Id, deadlineTick: z.number().int() }).nullable(),
});
export type OperatorSelf = z.infer<typeof OperatorSelf>;

// ---- Events ----

export const PublicChallengeSchema = z.object({
  kind: z.enum(['single', 'chain']),
  families: z.array(TypeIdSchema).min(1).max(2),
  params: z.unknown(),
  payload: z.unknown(),
});

export const GameEvent = z.discriminatedUnion('e', [
  z.object({ e: z.literal('hit'), source: Id, target: Id, move: Id, amount: z.number().int(), multiplier: z.number() }),
  z.object({ e: z.literal('crash'), daemon: Id }),
  z.object({ e: z.literal('battleStart'), wild: Id, operator: Id }),
  z.object({ e: z.literal('status'), target: Id, status: StatusSchema, untilTick: z.number().int() }),
  z.object({
    e: z.literal('captureStart'),
    captureId: Id,
    targetId: Id,
    challenge: PublicChallengeSchema,
    deadlineTick: z.number().int(),
  }),
  z.object({
    e: z.literal('captureResult'),
    captureId: Id,
    ok: z.boolean(),
    reason: z.enum(['wrong_answer', 'timeout', 'packet_loss', 'persist_failed']).optional(),
    daemon: RamDaemon.optional(),
  }),
  z.object({ e: z.literal('signatureSpawn'), daemon: Id, species: Id, signature: z.number().int(), clean: z.boolean() }),
  z.object({ e: z.literal('levelUp'), daemon: Id, level: z.number().int() }),
  z.object({ e: z.literal('restored'), daemons: z.array(Id) }),
  z.object({ e: z.literal('swap'), out: Id, in: Id }),
  z.object({ e: z.literal('evolved'), daemon: Id, from: Id, to: Id, changes: z.array(z.unknown()) }),
  z.object({ e: z.literal('discovery'), form: Id, operator: Id, operatorName: z.string().nullable() }),
  z.object({ e: z.literal('travelled'), from: z.string(), to: z.string() }),
  z.object({ e: z.literal('bits'), delta: z.number().int(), reason: z.string(), balance: z.number().int() }),
  z.object({ e: z.literal('decompiled'), daemon: Id, species: z.string(), fragments: z.record(z.string(), z.number().int()) }),
  z.object({ e: z.literal('ticketProgress'), ticketId: Id, progress: z.number().int(), target: z.number().int() }),
  /** `unpaid`: the store refused the payout (the row was no longer open); the ticket is closed with reward 0. */
  z.object({ e: z.literal('ticketDone'), ticketId: Id, reward: z.number().int(), unpaid: z.boolean().optional() }),
  /** Incident lifecycle, sent to everyone on the server (SP4 spec §8). */
  z.object({
    e: z.literal('incident'),
    phase: z.enum(['open', 'fighting', 'shield', 'unshield', 'cleared', 'expired']),
    id: Id,
    n: z.number().int(),
    species: z.string(),
    endsAt: z.string(),
    bossId: Id.nullable(),
    participants: z.array(z.object({ operatorId: Id, name: z.string().nullable(), damage: z.number().int(), share: z.number(), reward: z.number().int() })).optional(),
  }),
  /** A blast lands on this circle at `atTick`: move your daemons (and yourself) out. */
  z.object({ e: z.literal('telegraph'), x: Coord, y: Coord, radius: z.number(), atTick: z.number().int() }),
  z.object({ e: z.literal('incidentReward'), incidentId: Id, reward: z.number().int(), share: z.number() }),
]);
export type GameEvent = z.infer<typeof GameEvent>;

// ---- Server messages ----

export const ServerMessage = z.discriminatedUnion('t', [
  /** A chat line for a channel the receiver is in (SP4). */
  z.object({
    t: z.literal('chat'),
    seq: Seq,
    d: z.object({ id: Id, channel: z.string(), from: Id, name: z.string().nullable(), tag: z.string().nullable(), text: z.string(), at: z.string() }),
  }),
  z.object({ t: z.literal('chatDeleted'), seq: Seq, d: z.object({ id: Id, channel: z.string() }) }),
  z.object({ t: z.literal('muted'), seq: Seq, d: z.object({ until: z.string().nullable() }) }),
  /** An invite to a cluster (SP4): accept with `clusterAccept { clusterId }` before `expiresAt`. */
  z.object({ t: z.literal('clusterInvite'), seq: Seq, d: z.object({ clusterId: Id, from: Id, name: z.string().nullable(), expiresAt: z.string() }) }),
  z.object({
    t: z.literal('authOk'),
    seq: Seq,
    d: z.object({ operatorId: Id, role: z.enum(['controller', 'spectator']), resumeToken: z.string(), tick: z.number().int() }),
  }),
  z.object({
    t: z.literal('snapshot'),
    seq: Seq,
    d: z.object({ tick: z.number().int(), subnet: Id, self: OperatorSelf, entities: z.array(Entity) }),
  }),
  z.object({
    t: z.literal('delta'),
    seq: Seq,
    d: z.object({
      tick: z.number().int(),
      upserts: z.array(EntityPatch),
      removes: z.array(Id),
      events: z.array(GameEvent),
      self: OperatorSelf.optional(),
    }),
  }),
  z.object({ t: z.literal('ack'), seq: Seq, d: z.object({ reqId: Id, result: z.unknown().optional() }) }),
  z.object({ t: z.literal('err'), seq: Seq, d: z.object({ reqId: Id.optional(), code: ErrorCode, message: z.string() }) }),
  z.object({ t: z.literal('pong'), seq: Seq, d: z.object({}) }),
  z.object({ t: z.literal('kick'), seq: Seq, d: z.object({ reason: z.string() }) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- Parsing with size limits ----

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; code: 'E_INVALID'; message: string };

const encoder = new TextEncoder();

export function parseClientMessage(raw: string): ParseResult {
  const bytes = encoder.encode(raw).length;
  if (bytes > MAX_SUBMIT_BYTES) return { ok: false, code: 'E_INVALID', message: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'E_INVALID', message: 'malformed JSON' };
  }
  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'E_INVALID', message: parsed.error.issues[0]?.message ?? 'invalid message' };
  const isSubmit = parsed.data.t === 'cmd' && parsed.data.d.cmd === 'submitCapture';
  if (!isSubmit && bytes > MAX_MESSAGE_BYTES) return { ok: false, code: 'E_INVALID', message: 'message too large' };
  return { ok: true, message: parsed.data };
}
