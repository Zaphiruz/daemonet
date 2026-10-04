import type { Bus } from '@daemonet/bus';
import {
  AUTO_MUTE_HITS,
  AUTO_MUTE_MINUTES,
  AUTO_MUTE_WINDOW_MS,
  CHAT_INTERVAL_MS,
  DEFAULT_TERMS,
  FILTER_MAX_PATTERN,
  FILTER_MAX_TERMS,
  applyFilter,
  cleanChatText,
  compileFilter,
  type CompiledFilter,
  type FilterTerm,
} from '@daemonet/rules';
import type { ServerMessage } from '@daemonet/shared';
import { z } from 'zod';
import type { Operator } from '../core/index.js';
import { randomHex, type ChatStore } from './store.js';

/** What the chat service needs from the game: who is connected, where, and how to reach them. */
export interface ChatHost {
  /** Operators with a session (controller or spectators), with their current world's subnet. */
  operator(id: string): { op: Operator; subnet: string } | undefined;
  operatorIds(): Iterable<string>;
  /** Sends to every connection of the operator. */
  send(operatorId: string, msg: Extract<ServerMessage, { t: 'chat' | 'chatDeleted' | 'muted' }>): void;
  /** Cluster / org membership resolution (plans 2–3 fill these in; until then nobody is in one). */
  clusterOf?(operatorId: string): { id: string; members: Iterable<string> } | undefined;
  orgOf?(operatorId: string): { id: string; tag: string } | undefined;
  now(): number;
}

export interface ChatLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}

export type ChatError = { code: 'E_STATE' | 'E_RATE' | 'E_INVALID'; message: string };

export interface ChatLogger {
  warn(obj: object, msg?: string): void;
}

const OperatorId = z.string().min(1).max(64);
const Until = z.iso.datetime({ offset: true }).nullable();

/**
 * Admin actions on the bus `admin` channel. They come from Redis, so they are validated before anything acts on them;
 * kinds this service does not handle (`incident:start`, …) are ignored.
 */
const AdminMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mute'),
    operatorId: OperatorId,
    until: Until,
    reason: z.string().max(64).optional(),
    /** Who decided it: the sim's own announcements (filter auto-mutes) come back on the bus and are ignored. */
    origin: z.enum(['sim', 'api']).optional(),
  }),
  z.object({ kind: z.literal('unmute'), operatorId: OperatorId }),
  z.object({ kind: z.literal('delete'), id: z.string().min(1).max(64), channel: z.string().min(3).max(80) }),
  z.object({
    kind: z.literal('filter'),
    terms: z
      .array(z.object({ pattern: z.string().max(FILTER_MAX_PATTERN), kind: z.enum(['WORD', 'REGEX']), action: z.enum(['BLOCK', 'MASK']) }))
      .max(FILTER_MAX_TERMS),
  }),
]);
export type AdminMessage = z.infer<typeof AdminMessage>;
const ADMIN_KINDS: ReadonlySet<unknown> = new Set(['mute', 'unmute', 'delete', 'filter']);

/** DM guard lookups (target exists, not blocked: store reads) allowed per operator per CHAT_INTERVAL_MS. */
const DM_LOOKUPS_PER_INTERVAL = 4;
/** Recent lines whose sender and recipients are remembered, so an admin deletion reaches whoever saw the line. */
const RECENT_LINES = 1024;
/** Per-operator bookkeeping maps are swept once they hold this many entries. */
const SWEEP_AT = 4096;

/**
 * Only an error's name and code reach the log: a database error message can quote the row it failed on, and chat
 * text must never be logged.
 */
function errInfo(err: unknown): { name: string; code?: string } {
  const e = err as { name?: unknown; code?: unknown };
  return { name: typeof e?.name === 'string' ? e.name : 'Error', ...(typeof e?.code === 'string' ? { code: e.code } : {}) };
}

/**
 * Chat over the game socket (SP4 spec §5): guards, the filter, persistence through the store, delivery to every
 * connected member of the channel, and the bus for the API's consumers and admin actions.
 *
 * Limits are per operator, not per connection: one accepted (or filter-blocked) line every CHAT_INTERVAL_MS, at most one
 * line in flight. Chat text is never logged.
 */
export class ChatService {
  private filter: CompiledFilter = compileFilter(DEFAULT_TERMS);
  private readonly lastAt = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly muted = new Map<string, number>();
  /**
   * Mutes this service set whose store write has not been confirmed (in flight or failed): a record loaded meanwhile
   * may predate it, so `loadMute` keeps the live value for these operators.
   */
  private readonly unconfirmed = new Set<string>();
  /** Bumped by every admin mute decision from the bus: a `mute` whose store write raced one yields to it. */
  private readonly generation = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  private readonly dmLookups = new Map<string, { since: number; n: number }>();
  private readonly recent = new Map<string, { from: string; to: string[] }>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly host: ChatHost,
    private readonly store: ChatStore,
    private readonly bus: Bus,
    private readonly log: ChatLogger = { warn() {} },
  ) {
    this.unsubscribe = bus.subscribe('admin', (m) => this.onAdmin(m));
  }

  /** Terms added by admins (loaded at boot, refreshed on the bus). */
  setExtraTerms(terms: readonly FilterTerm[]): void {
    this.filter = compileFilter([...DEFAULT_TERMS, ...terms]);
  }

  /** Called when an operator's record is loaded (mute from the DB). */
  loadMute(operatorId: string, until: string | null): void {
    // An unconfirmed mute of ours that is still running outranks the record (which may predate it).
    if (this.unconfirmed.has(operatorId) && this.isMuted(operatorId)) return;
    this.unconfirmed.delete(operatorId);
    const at = until ? Date.parse(until) : NaN;
    if (Number.isFinite(at) && at > this.host.now()) this.muted.set(operatorId, at);
    else this.muted.delete(operatorId);
  }

  isMuted(operatorId: string): boolean {
    const until = this.muted.get(operatorId);
    if (until === undefined) return false;
    if (until <= this.host.now()) {
      this.muted.delete(operatorId);
      this.unconfirmed.delete(operatorId);
      return false;
    }
    return true;
  }

  /** Who a message on `channel` from `from` reaches (including the sender); null when `from` may not post there. */
  recipients(from: string, channel: string): string[] | null {
    const me = this.host.operator(from);
    if (!me) return null;
    const colon = channel.indexOf(':');
    if (colon < 0) return null;
    const kind = channel.slice(0, colon);
    const id = channel.slice(colon + 1);
    if (!id) return null;
    switch (kind) {
      case 'subnet': {
        // Everyone whose current world is this subnet (multi-world: the sender's own world only).
        if (me.subnet !== id) return null;
        const out: string[] = [];
        for (const oid of this.host.operatorIds()) if (this.host.operator(oid)?.subnet === id) out.push(oid);
        return out;
      }
      case 'cluster': {
        const c = this.host.clusterOf?.(from);
        return c && c.id === id ? [...c.members] : null;
      }
      case 'org': {
        const o = this.host.orgOf?.(from);
        if (!o || o.id !== id) return null;
        const out: string[] = [];
        for (const oid of this.host.operatorIds()) if (this.host.orgOf?.(oid)?.id === id) out.push(oid);
        return out;
      }
      case 'dm':
        if (id === from) return null;
        return [from, id];
      default:
        return null;
    }
  }

  /** Handles a `chat` command. Returns an error to send back, or null when accepted. */
  async post(from: string, channel: string, rawText: string): Promise<ChatError | null> {
    const text = cleanChatText(rawText);
    if (!text) return { code: 'E_INVALID', message: 'empty message' };
    if (this.isMuted(from)) return { code: 'E_STATE', message: `muted until ${new Date(this.muted.get(from)!).toISOString()}` };
    const now = this.host.now();
    const last = this.lastAt.get(from) ?? -Infinity;
    if (this.busy.has(from) || now - last < CHAT_INTERVAL_MS) return { code: 'E_RATE', message: 'one message every 2 seconds' };
    const before = this.recipients(from, channel);
    if (!before) return { code: 'E_STATE', message: 'you cannot post to that channel' };
    const me = this.host.operator(from)!;
    const name = me.op.name;
    const tag = this.host.orgOf?.(from)?.tag ?? null;
    if (this.lastAt.size > SWEEP_AT) this.sweep(now);
    this.busy.add(from);
    try {
      const dmTo = channel.startsWith('dm:') ? channel.slice(3) : null;
      if (dmTo !== null) {
        const refused = await this.dmProblem(from, dmTo, now);
        if (refused) return refused;
      }
      const filtered = applyFilter(this.filter, text);
      if (!filtered.ok) {
        this.lastAt.set(from, now);
        await this.blocked(from, channel, text, filtered.term, now);
        return { code: 'E_INVALID', message: 'message blocked by the chat filter' };
      }
      this.lastAt.set(from, now);
      // A mute (admin or automatic) may have landed while the guards awaited the store.
      if (this.isMuted(from)) return { code: 'E_STATE', message: `muted until ${new Date(this.muted.get(from)!).toISOString()}` };
      const line: ChatLine = { id: `m${now.toString(36)}${randomHex(6)}`, channel, from, name, tag, text: filtered.text, at: new Date(now).toISOString() };
      try {
        await this.store.appendChat({ id: line.id, channel, operatorId: from, toId: dmTo, text: line.text, at: line.at });
      } catch (err) {
        // Never delivered unrecorded: history, reports and moderation all work from the stored row.
        this.log.warn({ operator: from, channel, err: errInfo(err) }, 'chat line not stored');
        return { code: 'E_STATE', message: 'chat is unavailable right now' };
      }
      // Membership may have changed while the row was written (travel, leave): deliver to the channel as it is now.
      const to = this.recipients(from, channel) ?? before;
      this.remember(line.id, from, to);
      // A DM is filed under the other party's id on each side (spec §5): the sender sees dm:<recipient>, the recipient
      // dm:<sender>, so replying to `line.channel` reaches the right operator. Stored and published as the sender's view.
      for (const oid of to) this.host.send(oid, { t: 'chat', seq: 0, d: dmTo !== null && oid !== from ? { ...line, channel: `dm:${from}` } : line });
      this.publish('chat', line);
      return null;
    } catch (err) {
      this.log.warn({ operator: from, channel, err: errInfo(err) }, 'chat guard lookup failed');
      return { code: 'E_STATE', message: 'chat is unavailable right now' };
    } finally {
      this.busy.delete(from);
    }
  }

  /** The DM target must exist and must not have blocked the sender; the store lookups are themselves rate limited. */
  private async dmProblem(from: string, target: string, now: number): Promise<ChatError | null> {
    const w = this.dmLookups.get(from);
    if (w && now - w.since < CHAT_INTERVAL_MS) {
      if (w.n >= DM_LOOKUPS_PER_INTERVAL) return { code: 'E_RATE', message: 'one message every 2 seconds' };
      w.n++;
    } else {
      this.dmLookups.set(from, { since: now, n: 1 });
    }
    if (!this.host.operator(target) && !(await this.store.operatorExists(target))) return { code: 'E_STATE', message: 'unknown operator' };
    if (await this.store.isBlocked(target, from)) return { code: 'E_STATE', message: 'that operator is not accepting your messages' };
    return null;
  }

  /** A BLOCK hit: recorded for review; AUTO_MUTE_HITS of them within AUTO_MUTE_WINDOW_MS mute the operator. */
  private async blocked(from: string, channel: string, text: string, term: string, now: number): Promise<void> {
    try {
      await this.store.recordFilterHit({ operatorId: from, channel, text, term });
    } catch (err) {
      this.log.warn({ operator: from, err: errInfo(err) }, 'filter hit not recorded');
    }
    const recent = (this.hits.get(from) ?? []).filter((t) => now - t < AUTO_MUTE_WINDOW_MS);
    recent.push(now);
    this.hits.set(from, recent);
    if (recent.length >= AUTO_MUTE_HITS) {
      this.hits.delete(from);
      await this.mute(from, new Date(now + AUTO_MUTE_MINUTES * 60_000).toISOString(), 'filter');
    }
  }

  /** Mutes (or unmutes with null), persists through the store, tells the operator and announces it on the bus. */
  async mute(operatorId: string, until: string | null, reason = 'admin'): Promise<void> {
    const gen = this.generation.get(operatorId) ?? 0;
    this.setMuted(operatorId, until);
    if (until) this.unconfirmed.add(operatorId);
    else this.unconfirmed.delete(operatorId);
    try {
      await this.store.setMute(operatorId, until);
      if ((this.generation.get(operatorId) ?? 0) === gen) this.unconfirmed.delete(operatorId);
    } catch (err) {
      this.log.warn({ operator: operatorId, reason, err: errInfo(err) }, 'mute not stored');
    }
    if ((this.generation.get(operatorId) ?? 0) !== gen) {
      // An admin decision arrived while our write was in flight and may have committed before it: write the admin's
      // (current) value back so the store agrees with the sim, and announce nothing.
      const current = this.muted.get(operatorId);
      try {
        await this.store.setMute(operatorId, current === undefined ? null : new Date(current).toISOString());
      } catch (err) {
        this.log.warn({ operator: operatorId, reason, err: errInfo(err) }, 'mute not restored');
      }
      return;
    }
    this.host.send(operatorId, { t: 'muted', seq: 0, d: { until } });
    this.publish('admin', { kind: 'mute', operatorId, until, reason, origin: 'sim' });
  }

  /** Applies a mute state; true when it changed. */
  private setMuted(operatorId: string, until: string | null): boolean {
    const before = this.muted.get(operatorId);
    const at = until ? Date.parse(until) : undefined;
    if (at === undefined) this.muted.delete(operatorId);
    else this.muted.set(operatorId, at);
    return before !== at;
  }

  private onAdmin(raw: unknown): void {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (!ADMIN_KINDS.has(kind)) return;
    const parsed = AdminMessage.safeParse(raw);
    if (!parsed.success) {
      this.log.warn({ kind }, 'dropped a malformed admin message');
      return;
    }
    const m = parsed.data;
    switch (m.kind) {
      case 'mute':
      case 'unmute': {
        // Our own announcements come back here too (the bus delivers to the publisher).
        if (m.kind === 'mute' && m.origin === 'sim') return;
        const until = m.kind === 'mute' ? m.until : null;
        // An admin decision (written by the api) supersedes any mute of ours, confirmed or not.
        this.generation.set(m.operatorId, (this.generation.get(m.operatorId) ?? 0) + 1);
        this.unconfirmed.delete(m.operatorId);
        if (this.setMuted(m.operatorId, until)) this.host.send(m.operatorId, { t: 'muted', seq: 0, d: { until } });
        return;
      }
      case 'delete': {
        const from = this.recent.get(m.id)?.from;
        const dmTo = m.channel.startsWith('dm:') ? m.channel.slice(3) : null;
        for (const oid of this.audience(m.id, m.channel)) {
          // The DM's recipient files it under the sender's id (when the sender is remembered).
          const channel = dmTo !== null && oid === dmTo && from !== undefined && from !== dmTo ? `dm:${from}` : m.channel;
          this.host.send(oid, { t: 'chatDeleted', seq: 0, d: { id: m.id, channel } });
        }
        return;
      }
      case 'filter':
        this.setExtraTerms(m.terms);
        return;
    }
  }

  /**
   * Who a deletion goes to: for a subnet line, the operators in that subnet now; for any other line, whoever it reached
   * (when remembered) and whoever can read the channel now.
   */
  private audience(id: string, channel: string): Set<string> {
    const colon = channel.indexOf(':');
    const kind = channel.slice(0, colon);
    const target = channel.slice(colon + 1);
    const out = new Set(kind === 'subnet' ? [] : (this.recent.get(id)?.to ?? []));
    for (const oid of this.host.operatorIds()) {
      const reads =
        kind === 'subnet' ? this.host.operator(oid)?.subnet === target
        : kind === 'dm' ? oid === target
        : kind === 'cluster' ? this.host.clusterOf?.(oid)?.id === target
        : kind === 'org' ? this.host.orgOf?.(oid)?.id === target
        : false;
      if (reads) out.add(oid);
    }
    return out;
  }

  private remember(id: string, from: string, to: readonly string[]): void {
    this.recent.set(id, { from, to: [...to] });
    if (this.recent.size > RECENT_LINES) this.recent.delete(this.recent.keys().next().value!);
  }

  private publish(channel: string, message: unknown): void {
    // A bus outage must never fail a chat line (RedisBus rejects when Redis is down).
    this.bus.publish(channel, message).catch((err: unknown) => this.log.warn({ channel, err: errInfo(err) }, 'bus publish failed'));
  }

  private sweep(now: number): void {
    for (const [id, at] of this.lastAt) if (now - at >= CHAT_INTERVAL_MS) this.lastAt.delete(id);
    for (const [id, w] of this.dmLookups) if (now - w.since >= CHAT_INTERVAL_MS) this.dmLookups.delete(id);
    for (const [id, ts] of this.hits) if (ts.every((t) => now - t >= AUTO_MUTE_WINDOW_MS)) this.hits.delete(id);
  }

  close(): void {
    this.unsubscribe();
  }
}
