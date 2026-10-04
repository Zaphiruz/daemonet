import type { ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, type ClusterView, type Operator } from '../core/index.js';

export const CLUSTER_MAX = 4;
export const INVITE_TTL_MS = 60_000;
/** Join-by-code attempts (successful or not) per operator per LIMIT_WINDOW_MS: brute-forcing a code is hopeless. */
export const JOIN_ATTEMPTS = 5;
/** Invites sent per operator per LIMIT_WINDOW_MS. */
export const INVITES_PER_WINDOW = 6;
/** Clusters created with `clusterCreate` per operator per LIMIT_WINDOW_MS (creating through an invite counts as an invite). */
export const CREATES_PER_WINDOW = 6;
export const LIMIT_WINDOW_MS = 60_000;
/** Pending (unexpired) invites one operator can hold at once, from different clusters. */
export const MAX_PENDING_INVITES = 4;
/** 32 symbols without look-alikes (no I, O, 0, 1): 32^6 ≈ 1.07e9 codes. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TRIES = 32;
/** Bookkeeping maps are swept once they hold this many entries. */
const SWEEP_AT = 4096;

/** What the cluster service needs from the game. */
export interface ClusterHost {
  /** A connected operator with the subnet of its current world. */
  operator(id: string): { op: Operator; subnet: string } | undefined;
  send(operatorId: string, msg: Extract<ServerMessage, { t: 'clusterInvite' }>): void;
  /**
   * The party key `key` lost holders (a member joined or left a cluster, or a cluster dissolved): in every world where
   * nobody holds it any more, its wild tags must not stay locked to it (`World.releaseOrphanTags`).
   */
  releaseTags(key: string): void;
  /** Hands every wild tag held under `from` to `to` in every world (a solo operator founding a cluster keeps its fights). */
  rekeyTags(from: string, to: string): void;
  now(): number;
  /** Uniform in [0, 1): the game passes a CSPRNG (join codes must be unguessable). */
  random(): number;
}

interface Cluster {
  id: string;
  code: string;
  leaderId: string;
  /** operator id -> joined at (ms); insertion order = seniority. */
  members: Map<string, number>;
  /** Operators the leader kicked: they cannot come back, by code or by invite, while this cluster lives. */
  kicked: Set<string>;
}

export type ClusterError = { code: 'E_STATE' | 'E_RANGE' | 'E_INVALID' | 'E_RATE'; message: string };
/** The target of an invite key `${clusterId}:${operatorId}` (cluster ids never contain a colon). */
const inviteTarget = (key: string): string => key.slice(key.indexOf(':') + 1);
/** Success results carry no `message` (a `clusterCreate` result has a `code`, the join code). */
export const isClusterError = (r: object): r is ClusterError => 'message' in r;
const err = (code: ClusterError['code'], message: string): ClusterError => ({ code, message });

/**
 * Clusters (SP4 spec §6): up to 4 operators, formed by inviting someone nearby or by joining with a code.
 * Not persisted. The service owns membership and writes each member's `op.cluster` view; the core derives
 * the party key (shared tagging, XP, capture rights) from it.
 *
 * Tags follow the party key: founding a cluster carries the founder's tags over to it (it is the only holder of both
 * keys), joining an existing one gives up the joiner's personal tags (released, as if they had expired), and a cluster's
 * tags are released in a world where no member is left (see `ClusterHost.releaseTags`).
 */
export class ClusterService {
  private readonly clusters = new Map<string, Cluster>();
  private readonly byMember = new Map<string, string>();
  private readonly byCode = new Map<string, string>();
  /** `${clusterId}:${operatorId}` -> expires at (ms); one pending invite per cluster and target. */
  private readonly invites = new Map<string, number>();
  /** `${kind}:${operatorId}` -> attempt times (ms) within LIMIT_WINDOW_MS. */
  private readonly attempts = new Map<string, number[]>();
  private counter = 0;

  constructor(private readonly host: ClusterHost) {}

  of(operatorId: string): { id: string; members: string[] } | undefined {
    const c = this.clusters.get(this.byMember.get(operatorId) ?? '');
    return c ? { id: c.id, members: [...c.members.keys()] } : undefined;
  }

  private newCode(): string | null {
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(this.host.random() * CODE_ALPHABET.length)]).join('');
      if (!this.byCode.has(code)) return code;
    }
    return null;
  }

  private create(leaderId: string): Cluster | null {
    const code = this.newCode();
    if (code === null) return null;
    // Short: the chat channel / party key `cluster:<id>` must fit the protocol's 64-character Id.
    const c: Cluster = {
      id: `c${(++this.counter).toString(36)}${Math.floor(this.host.now() / 1000).toString(36)}`,
      code,
      leaderId,
      members: new Map([[leaderId, this.host.now()]]),
      kicked: new Set(),
    };
    this.clusters.set(c.id, c);
    this.byCode.set(code, c.id);
    this.byMember.set(leaderId, c.id);
    // The founder is the only holder of both its old and its new key: its fights carry over to the cluster.
    this.refresh(c.id);
    this.host.rekeyTags(leaderId, `cluster:${c.id}`);
    return c;
  }

  /** Recomputes every member's view (call after membership or subnet changes). */
  refresh(clusterId: string): void {
    const c = this.clusters.get(clusterId);
    if (!c) return;
    const info = [...c.members.keys()].map((id) => ({ id, at: this.host.operator(id) }));
    for (const me of info) {
      if (!me.at) continue;
      const view: ClusterView = {
        id: c.id,
        code: c.code,
        leaderId: c.leaderId,
        members: info.map((m) => ({ id: m.id, name: m.at?.op.name ?? null, subnet: m.at?.subnet ?? null, away: !m.at || m.at.subnet !== me.at!.subnet })),
      };
      me.at.op.cluster = view;
    }
  }

  /** After an operator (re)enters a world (login, travel): restore its view and everyone's `away` flags. */
  reattach(operatorId: string): void {
    const id = this.byMember.get(operatorId);
    if (id) this.refresh(id);
  }

  /** Create a cluster of one (to get a code) if the operator has none. */
  ensure(operatorId: string): ClusterError | { clusterId: string; code: string } {
    if (!this.host.operator(operatorId)) return err('E_STATE', 'not connected');
    const existing = this.clusters.get(this.byMember.get(operatorId) ?? '');
    if (!existing && !this.allow('create', operatorId, CREATES_PER_WINDOW, this.host.now())) return err('E_RATE', `at most ${CREATES_PER_WINDOW} new clusters a minute`);
    const c = existing ?? this.create(operatorId);
    if (!c) return err('E_STATE', 'no cluster code available, try again');
    this.refresh(c.id);
    return { clusterId: c.id, code: c.code };
  }

  invite(from: string, targetId: string): ClusterError | { clusterId: string } {
    const a = this.host.operator(from);
    const b = this.host.operator(targetId);
    if (!a) return err('E_STATE', 'not connected');
    if (targetId === from) return err('E_INVALID', 'cannot invite yourself');
    if (!b) return err('E_STATE', 'that operator is not online');
    if (a.subnet !== b.subnet || distance(a.op, b.op) > INTEREST_RADIUS) return err('E_RANGE', 'invite operators within 32 tiles in your subnet (or share your cluster code)');
    if (this.byMember.has(targetId)) return err('E_STATE', 'that operator is already in a cluster');
    const mine = this.clusters.get(this.byMember.get(from) ?? '');
    if (mine && mine.leaderId !== from) return err('E_STATE', 'only the cluster leader invites');
    if (mine && mine.members.size >= CLUSTER_MAX) return err('E_STATE', `a cluster holds at most ${CLUSTER_MAX} operators`);
    const now = this.host.now();
    this.sweepInvites(now);
    if (mine && (this.invites.get(`${mine.id}:${targetId}`) ?? -Infinity) >= now) return err('E_STATE', 'that operator already has your invite');
    let pending = 0;
    for (const k of this.invites.keys()) if (inviteTarget(k) === targetId) pending++;
    if (pending >= MAX_PENDING_INVITES) return err('E_STATE', 'that operator has too many pending invites');
    if (!this.allow('invite', from, INVITES_PER_WINDOW, now)) return err('E_RATE', `at most ${INVITES_PER_WINDOW} invites a minute`);
    const c = mine ?? this.create(from);
    if (!c) return err('E_STATE', 'no cluster code available, try again');
    const expiresAt = now + INVITE_TTL_MS;
    this.invites.set(`${c.id}:${targetId}`, expiresAt);
    this.refresh(c.id);
    this.host.send(targetId, { t: 'clusterInvite', seq: 0, d: { clusterId: c.id, from, name: a.op.name, expiresAt: new Date(expiresAt).toISOString() } });
    return { clusterId: c.id };
  }

  private add(c: Cluster, operatorId: string): ClusterError | { clusterId: string } {
    if (this.byMember.has(operatorId)) return err('E_STATE', 'leave your cluster first');
    if (c.kicked.has(operatorId)) return err('E_STATE', 'you were removed from that cluster');
    if (c.members.size >= CLUSTER_MAX) return err('E_STATE', 'that cluster is full');
    c.members.set(operatorId, this.host.now());
    this.byMember.set(operatorId, c.id);
    this.dropInvitesTo(operatorId);
    this.refresh(c.id);
    // Joining gives up the operator's personal tags: they would otherwise stay locked to a key nobody holds.
    this.host.releaseTags(operatorId);
    return { clusterId: c.id };
  }

  accept(operatorId: string, clusterId: string): ClusterError | { clusterId: string } {
    const key = `${clusterId}:${operatorId}`;
    const expiresAt = this.invites.get(key);
    this.invites.delete(key);
    const c = this.clusters.get(clusterId);
    if (!c || expiresAt === undefined || expiresAt < this.host.now()) return err('E_STATE', 'that invite has expired');
    if (!this.host.operator(operatorId)) return err('E_STATE', 'not connected');
    return this.add(c, operatorId);
  }

  join(operatorId: string, code: string): ClusterError | { clusterId: string } {
    if (!this.host.operator(operatorId)) return err('E_STATE', 'not connected');
    if (!this.allow('join', operatorId, JOIN_ATTEMPTS, this.host.now())) return err('E_RATE', `at most ${JOIN_ATTEMPTS} join attempts a minute`);
    const c = this.clusters.get(this.byCode.get(code.toUpperCase()) ?? '');
    if (!c) return err('E_INVALID', 'no cluster with that code');
    return this.add(c, operatorId);
  }

  /**
   * Leaves (also when the operator's session leaves the game). The oldest remaining member leads; an empty cluster
   * vanishes with its code and invites. Pending invites to the operator are dropped either way.
   */
  leave(operatorId: string): ClusterError | { ok: true } {
    this.dropInvitesTo(operatorId);
    const c = this.clusters.get(this.byMember.get(operatorId) ?? '');
    if (!c) return err('E_STATE', 'not in a cluster');
    c.members.delete(operatorId);
    this.byMember.delete(operatorId);
    const gone = this.host.operator(operatorId);
    if (gone) gone.op.cluster = null;
    if (c.members.size === 0) {
      this.clusters.delete(c.id);
      this.byCode.delete(c.code);
      for (const k of [...this.invites.keys()]) if (k.startsWith(`${c.id}:`)) this.invites.delete(k);
    } else {
      if (c.leaderId === operatorId) {
        c.leaderId = c.members.keys().next().value!;
        // Invites are the old leader's decisions: they go with it.
        for (const k of [...this.invites.keys()]) if (k.startsWith(`${c.id}:`)) this.invites.delete(k);
      }
      this.refresh(c.id);
    }
    // The cluster's tags stay with members still in the same world; elsewhere (or once dissolved) they are released.
    this.host.releaseTags(`cluster:${c.id}`);
    return { ok: true };
  }

  kick(leaderId: string, targetId: string): ClusterError | { ok: true } {
    const c = this.clusters.get(this.byMember.get(leaderId) ?? '');
    if (!c) return err('E_STATE', 'not in a cluster');
    if (c.leaderId !== leaderId) return err('E_STATE', 'only the cluster leader kicks');
    if (targetId === leaderId || !c.members.has(targetId)) return err('E_INVALID', 'not a member of your cluster');
    // A kick sticks: the kicked operator saw the code, so the code rotates, and it cannot come back by any route.
    c.kicked.add(targetId);
    const code = this.newCode();
    if (code !== null) {
      this.byCode.delete(c.code);
      c.code = code;
      this.byCode.set(code, c.id);
    }
    return this.leave(targetId);
  }

  /** Records an attempt of `kind` by `operatorId`; false when the window's budget is already spent. */
  private allow(kind: string, operatorId: string, max: number, now: number): boolean {
    if (this.attempts.size > SWEEP_AT) {
      for (const [k, ts] of this.attempts) if (ts.every((t) => now - t >= LIMIT_WINDOW_MS)) this.attempts.delete(k);
    }
    const key = `${kind}:${operatorId}`;
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < LIMIT_WINDOW_MS);
    if (recent.length >= max) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  private dropInvitesTo(operatorId: string): void {
    for (const k of [...this.invites.keys()]) if (inviteTarget(k) === operatorId) this.invites.delete(k);
  }

  private sweepInvites(now: number): void {
    for (const [k, at] of this.invites) if (at < now) this.invites.delete(k);
  }

  /** Pending invites (tests and diagnostics). */
  get pendingInvites(): number {
    return this.invites.size;
  }
}
