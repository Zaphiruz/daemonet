import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import type { BitsPushMessage, Tx } from '../exchange/ledger.js';
import { publishSafely } from '../publish.js';
import { nameAllowed } from './chat.js';

/** Vanity sinks (SP4 spec §3, §7). */
export const ORG_CREATE_PRICE = 8192;
export const ORG_TAG_PRICE = 4096;
export const RENAME_PRICE = 2048;
export const ORG_MAX_MEMBERS = 64;
/** Pending invites an org may hold at once (invite spam bound; a repeated invite to the same operator is one row). */
export const ORG_MAX_INVITES = 64;

const OrgName = z
  .string()
  .regex(/^[A-Za-z0-9 _-]{3,24}$/, 'name: 3-24 letters, digits, space, _ or -')
  .refine((s) => s.trim() === s && !s.includes('  '), 'name: no leading, trailing or double spaces');
const OrgTag = z.string().regex(/^[A-Z0-9]{4}$/, 'tag: exactly 4 upper-case letters or digits');
/** Same rules as the starter claim (`OperatorName` in @daemonet/shared, which the sim validates rename pushes with). */
const OperatorName = z.string().regex(/^[a-z0-9_-]{3,16}$/, 'name: 3-16 of a-z 0-9 _ -');
const Id = z.string().min(1).max(64);
const CreateBody = z.object({ name: OrgName, tag: OrgTag });
const TargetBody = z.object({ operatorId: Id });
const RankBody = z.object({ operatorId: Id, rank: z.enum(['OFFICER', 'MEMBER']) });
const TagBody = z.object({ tag: OrgTag });
const RenameBody = z.object({ name: OperatorName });
const SearchQuery = z.object({ q: z.string().max(32).optional() });

type Rank = 'OWNER' | 'OFFICER' | 'MEMBER';
const insufficient = (price: number) => new AppError(402, 'insufficient_bits', `costs ${price} bits`);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/**
 * Takes `price` bits with a guarded UPDATE (402 when short). It is the first statement of every paid transaction: the
 * UPDATE row-locks the operator, so the ledger row written next gets a seq in commit order (the sim's watermark relies on
 * it) and the checks that follow see every earlier paid change of this operator.
 */
async function debit(tx: Tx, operatorId: string, price: number): Promise<void> {
  const res = await tx.operator.updateMany({ where: { id: operatorId, bits: { gte: BigInt(price) } }, data: { bits: { decrement: BigInt(price) } } });
  if (res.count !== 1) throw insufficient(price);
}

/** The single ledger row of a paid action (after `debit`, in the same transaction); returns the push announcing it. */
async function ledger(tx: Tx, operatorId: string, price: number, reason: 'org' | 'rename', ref: string): Promise<BitsPushMessage> {
  const row = await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(-price), reason, ref }, select: { id: true, seq: true } });
  const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } });
  return { kind: 'bits', operatorId, ledgerId: row.id, seq: Number(row.seq), delta: -price, reason, balance: Number(op.bits), origin: 'api' };
}

/** Row-locks the org: every membership change of one org runs under it, so kicks, leaves, transfers and accepts serialize. */
async function lockOrg(tx: Tx, orgId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Org" WHERE "id" = ${orgId} FOR UPDATE`;
  return rows.length === 1;
}

/** Name of the violated unique constraint of a P2002 (Prisma 7 + pg adapter reports it under meta.driverAdapterError), else null. */
function violatedUnique(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return null;
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: { constraint?: { index?: string }; originalMessage?: string } } | undefined)?.cause;
  const target = meta.target ?? meta.constraint;
  return [cause?.constraint?.index, cause?.originalMessage, Array.isArray(target) ? target.join(',') : target, (err as Error).message]
    .filter((x): x is string => typeof x === 'string')
    .join(' ');
}

/** Maps the unique constraints these routes can hit to a 400; anything else is rethrown (a real 500). */
function uniqueToBadRequest(err: unknown): never {
  const c = violatedUnique(err);
  if (c?.includes('Org_name_key') || c?.includes('Operator_name_key')) throw badRequest('that name is taken');
  if (c?.includes('Org_tag_key')) throw badRequest('that tag is taken');
  if (c?.includes('OrgMember_pkey')) throw badRequest('leave your org first');
  throw err;
}

/** Orgs and operator rename (SP4 spec §7). Membership, name and balance changes are pushed to the sim over the bus after commit. */
export function registerOrgRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };
  const publish = (channel: 'org' | 'admin', message: { kind: string; [field: string]: unknown }) => publishSafely(bus, app.log, channel, message);

  const membership = (operatorId: string) => prisma.orgMember.findUnique({ where: { operatorId }, include: { org: true } });

  /** Post-commit work failed: the change stands (the sim re-reads it on resync), so log the error class only and carry on. */
  function afterCommitFailed(what: string, err: unknown): void {
    const e = err as { name?: unknown; code?: unknown };
    app.log.warn({ what, err: { name: String(e?.name ?? 'Error'), code: e?.code === undefined ? undefined : String(e.code) } }, 'post-commit read failed');
  }

  /**
   * Publishes each operator's membership as the database has it now (after the change committed); null = no org. Runs
   * after commit, so a failed read never turns a committed change (or purchase) into a 500.
   */
  async function announce(operatorIds: readonly string[] | (() => Promise<string[]>)): Promise<void> {
    try {
      const ids = typeof operatorIds === 'function' ? await operatorIds() : operatorIds;
      if (ids.length === 0) return;
      const rows = new Map((await prisma.orgMember.findMany({ where: { operatorId: { in: [...ids] } }, include: { org: true } })).map((m) => [m.operatorId, m]));
      for (const operatorId of ids) {
        const m = rows.get(operatorId);
        publish('org', { kind: 'membership', operatorId, org: m ? { id: m.org.id, name: m.org.name, tag: m.org.tag, rank: m.rank } : null, origin: 'api' });
      }
    } catch (err) {
      afterCommitFailed('announce', err);
    }
  }

  /** The org view after a committed change; if the read fails (or the org is already gone) the fallback is returned. */
  async function viewAfterCommit<F extends object>(orgId: string, fallback: F) {
    try {
      return await view(orgId);
    } catch (err) {
      afterCommitFailed('view', err);
      return fallback;
    }
  }

  /** Pre-check outside the transaction (clean 403 before a 402); every mutation re-checks under the org lock with `actorIn`. */
  async function requireRank(operatorId: string, ...ranks: Rank[]) {
    const m = await membership(operatorId);
    if (!m) throw forbidden('you are not in an org');
    if (!ranks.includes(m.rank)) throw forbidden(`requires ${ranks.join(' or ').toLowerCase()}`);
    return m;
  }

  /** Locks the org and re-reads the actor's rank in it: a kick, leave or transfer that committed meanwhile is seen here. */
  async function actorIn(tx: Tx, orgId: string, operatorId: string, ...ranks: Rank[]) {
    if (!(await lockOrg(tx, orgId))) throw forbidden('you are not in an org');
    const m = await tx.orgMember.findUnique({ where: { operatorId } });
    if (!m || m.orgId !== orgId) throw forbidden('you are not in an org');
    if (!ranks.includes(m.rank)) throw forbidden(`requires ${ranks.join(' or ').toLowerCase()}`);
    return m;
  }

  /** The target must be another member of the actor's org (read under the org lock). */
  async function targetIn(tx: Tx, orgId: string, actorId: string, operatorId: string) {
    const t = await tx.orgMember.findUnique({ where: { operatorId } });
    if (!t || t.orgId !== orgId || operatorId === actorId) throw badRequest('not another member of your org');
    return t;
  }

  async function view(orgId: string) {
    const org = await prisma.org.findUnique({ where: { id: orgId }, include: { members: { orderBy: [{ joinedAt: 'asc' }, { operatorId: 'asc' }] } } });
    if (!org) throw notFound('no such org');
    const names = new Map((await prisma.operator.findMany({ where: { id: { in: org.members.map((m) => m.operatorId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return {
      id: org.id,
      name: org.name,
      tag: org.tag,
      ownerId: org.ownerId,
      createdAt: org.createdAt,
      members: org.members.map((m) => ({ operatorId: m.operatorId, name: names.get(m.operatorId) ?? null, rank: m.rank, joinedAt: m.joinedAt })),
    };
  }

  app.get('/api/orgs/mine', auth, async (req) => {
    const me = req.operator!.id;
    const m = await membership(me);
    const invites = await prisma.orgInvite.findMany({ where: { operatorId: me }, include: { org: true }, orderBy: { at: 'asc' } });
    return {
      org: m ? await view(m.orgId) : null,
      rank: m?.rank ?? null,
      invites: invites.map((i) => ({ orgId: i.orgId, name: i.org.name, tag: i.org.tag, byId: i.byId, at: i.at })),
      prices: { create: ORG_CREATE_PRICE, tag: ORG_TAG_PRICE, rename: RENAME_PRICE },
    };
  });

  app.get<{ Querystring: unknown }>('/api/orgs', auth, async (req) => {
    const q = (parse(SearchQuery, req.query).q ?? '').trim();
    const rows = await prisma.org.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { tag: { equals: q.toUpperCase() } }] } : {},
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 32,
      include: { _count: { select: { members: true } } },
    });
    return rows.map((o) => ({ id: o.id, name: o.name, tag: o.tag, members: o._count.members }));
  });

  app.get<{ Params: { id: string } }>('/api/orgs/:id', auth, async (req) => view(req.params.id));

  app.post('/api/orgs', auth, async (req) => {
    const me = req.operator!.id;
    const body = parse(CreateBody, req.body);
    if (!(await nameAllowed(prisma, body.name)) || !(await nameAllowed(prisma, body.tag))) throw badRequest('that name or tag is not allowed');
    if (await membership(me)) throw badRequest('leave your org first');
    const orgId = crypto.randomUUID();
    let bits: BitsPushMessage;
    try {
      bits = await prisma.$transaction(async (tx) => {
        await debit(tx, me, ORG_CREATE_PRICE);
        // Under the operator lock: a concurrent create of ours has committed (or rolled back) by now.
        if (await tx.orgMember.findUnique({ where: { operatorId: me } })) throw badRequest('leave your org first');
        // Names are unique whatever their case: serialize creates of one lower-cased name, then look.
        await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`org-name:${body.name.toLowerCase()}`}))`;
        if (await tx.org.findFirst({ where: { name: { equals: body.name, mode: 'insensitive' } }, select: { id: true } })) throw badRequest('that name is taken');
        const push = await ledger(tx, me, ORG_CREATE_PRICE, 'org', orgId);
        await tx.org.create({ data: { id: orgId, name: body.name, tag: body.tag, ownerId: me } });
        await tx.orgMember.create({ data: { orgId, operatorId: me, rank: 'OWNER' } });
        await tx.orgInvite.deleteMany({ where: { operatorId: me } });
        return push;
      });
    } catch (err) {
      uniqueToBadRequest(err);
    }
    publish('admin', bits);
    await announce([me]);
    return viewAfterCommit(orgId, { id: orgId, name: body.name, tag: body.tag, ownerId: me, members: [{ operatorId: me, rank: 'OWNER' as const }] });
  });

  app.post('/api/orgs/invite', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER', 'OFFICER');
    if (!(await prisma.operator.findUnique({ where: { id: operatorId }, select: { id: true } }))) throw notFound('no such operator');
    if (await membership(operatorId)) throw badRequest('that operator is already in an org');
    const created = await prisma.$transaction(async (tx) => {
      await actorIn(tx, m.orgId, me, 'OWNER', 'OFFICER');
      if ((await tx.orgMember.count({ where: { orgId: m.orgId } })) >= ORG_MAX_MEMBERS) throw badRequest(`an org holds at most ${ORG_MAX_MEMBERS} members`);
      if (await tx.orgInvite.findUnique({ where: { orgId_operatorId: { orgId: m.orgId, operatorId } }, select: { orgId: true } })) return false;
      if ((await tx.orgInvite.count({ where: { orgId: m.orgId } })) >= ORG_MAX_INVITES) throw badRequest(`at most ${ORG_MAX_INVITES} pending invites`);
      await tx.orgInvite.create({ data: { orgId: m.orgId, operatorId, byId: me } });
      return true;
    });
    // A repeated invite is one row and one notification.
    if (created) publish('org', { kind: 'invite', operatorId, org: { id: m.org.id, name: m.org.name, tag: m.org.tag }, origin: 'api' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/orgs/:id/accept', auth, async (req) => {
    const me = req.operator!.id;
    const orgId = req.params.id;
    if (await membership(me)) throw badRequest('leave your org first');
    try {
      await prisma.$transaction(async (tx) => {
        // Lock order operator → org (as paid actions): concurrent accepts of one operator into two orgs serialize here
        // instead of deadlocking on each other's membership row and invites.
        await tx.$queryRaw`SELECT "id" FROM "Operator" WHERE "id" = ${me} FOR NO KEY UPDATE`;
        if (await tx.orgMember.findUnique({ where: { operatorId: me }, select: { orgId: true } })) throw badRequest('leave your org first');
        // A disbanded org took its invites with it; the lock keeps a disband from racing this join.
        if (!(await lockOrg(tx, orgId))) throw notFound('no such invite');
        if ((await tx.orgInvite.deleteMany({ where: { orgId, operatorId: me } })).count !== 1) throw notFound('no such invite');
        if ((await tx.orgMember.count({ where: { orgId } })) >= ORG_MAX_MEMBERS) throw badRequest('that org is full');
        await tx.orgMember.create({ data: { orgId, operatorId: me, rank: 'MEMBER' } });
        await tx.orgInvite.deleteMany({ where: { operatorId: me } });
      });
    } catch (err) {
      uniqueToBadRequest(err);
    }
    await announce([me]);
    return viewAfterCommit(orgId, { id: orgId });
  });

  app.post<{ Params: { id: string } }>('/api/orgs/:id/decline', auth, async (req) => {
    await prisma.orgInvite.deleteMany({ where: { orgId: req.params.id, operatorId: req.operator!.id } });
    return { ok: true };
  });

  /** The owner leaves only as the last member, which disbands the org (members and invites cascade). */
  app.post('/api/orgs/leave', auth, async (req) => {
    const me = req.operator!.id;
    const m = await requireRank(me, 'OWNER', 'OFFICER', 'MEMBER');
    const disbanded = await prisma.$transaction(async (tx) => {
      const cur = await actorIn(tx, m.orgId, me, 'OWNER', 'OFFICER', 'MEMBER');
      if (cur.rank !== 'OWNER') {
        await tx.orgMember.delete({ where: { operatorId: me } });
        return false;
      }
      if ((await tx.orgMember.count({ where: { orgId: m.orgId } })) > 1) throw badRequest('transfer ownership before leaving');
      await tx.org.delete({ where: { id: m.orgId } });
      return true;
    });
    await announce([me]);
    return { ok: true, disbanded };
  });

  /** Officers kick members; only the owner kicks officers; nobody kicks the owner. */
  app.post('/api/orgs/kick', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER', 'OFFICER');
    await prisma.$transaction(async (tx) => {
      const actor = await actorIn(tx, m.orgId, me, 'OWNER', 'OFFICER');
      const target = await targetIn(tx, m.orgId, me, operatorId);
      if (target.rank === 'OWNER' || (target.rank === 'OFFICER' && actor.rank !== 'OWNER')) throw forbidden('you cannot kick that rank');
      await tx.orgMember.delete({ where: { operatorId } });
    });
    await announce([operatorId]);
    return { ok: true };
  });

  app.post('/api/orgs/rank', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId, rank } = parse(RankBody, req.body);
    const m = await requireRank(me, 'OWNER');
    await prisma.$transaction(async (tx) => {
      await actorIn(tx, m.orgId, me, 'OWNER');
      await targetIn(tx, m.orgId, me, operatorId);
      await tx.orgMember.update({ where: { operatorId }, data: { rank } });
    });
    await announce([operatorId]);
    return { ok: true };
  });

  /** The new owner takes OWNER and the org's ownerId; the old owner becomes an officer. */
  app.post('/api/orgs/transfer', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER');
    await prisma.$transaction(async (tx) => {
      await actorIn(tx, m.orgId, me, 'OWNER');
      await targetIn(tx, m.orgId, me, operatorId);
      await tx.orgMember.update({ where: { operatorId }, data: { rank: 'OWNER' } });
      await tx.orgMember.update({ where: { operatorId: me }, data: { rank: 'OFFICER' } });
      await tx.org.update({ where: { id: m.orgId }, data: { ownerId: operatorId } });
    });
    await announce([operatorId, me]);
    return { ok: true };
  });

  /** Owner only, 4096 bits; every member's tag changes, so every member is announced. */
  app.post('/api/orgs/tag', auth, async (req) => {
    const me = req.operator!.id;
    const { tag } = parse(TagBody, req.body);
    const m = await requireRank(me, 'OWNER');
    if (tag === m.org.tag) throw badRequest('that is already your tag'); // re-checked under the org lock
    if (!(await nameAllowed(prisma, tag))) throw badRequest('that tag is not allowed');
    let bits: BitsPushMessage;
    try {
      bits = await prisma.$transaction(async (tx) => {
        await debit(tx, me, ORG_TAG_PRICE);
        await actorIn(tx, m.orgId, me, 'OWNER');
        // An identical request that committed while this one waited must not be charged again for a no-op.
        if ((await tx.org.findUniqueOrThrow({ where: { id: m.orgId }, select: { tag: true } })).tag === tag) throw badRequest('that is already your tag');
        const push = await ledger(tx, me, ORG_TAG_PRICE, 'org', m.orgId);
        await tx.org.update({ where: { id: m.orgId }, data: { tag } });
        return push;
      });
    } catch (err) {
      uniqueToBadRequest(err);
    }
    publish('admin', bits);
    await announce(async () => (await prisma.orgMember.findMany({ where: { orgId: m.orgId }, orderBy: [{ joinedAt: 'asc' }, { operatorId: 'asc' }], select: { operatorId: true } })).map((x) => x.operatorId));
    return { ok: true, tag };
  });

  /**
   * Members ranked by captures (Daemon + DaemonArchive rows by original operator, so decompiled and traded-away daemons
   * still count), with highest signature, evolutions (history `evolved` entries) and tickets done. Aggregated in SQL.
   */
  app.get<{ Params: { id: string } }>('/api/orgs/:id/leaderboard', auth, async (req) => {
    const org = await view(req.params.id);
    const ids = org.members.map((m) => m.operatorId);
    const [stats, tickets] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; captures: number; sig: number; evo: number }>>`
        SELECT d."originalOperatorId" AS "id", count(*)::int AS "captures", coalesce(max(d."signature"), 0)::int AS "sig",
          coalesce(sum(jsonb_array_length(jsonb_path_query_array(d."history", '$[*] ? (@.kind == "evolved")'))), 0)::int AS "evo"
        FROM (
          SELECT "originalOperatorId", "signature", "history" FROM "Daemon" WHERE "originalOperatorId" = ANY(${ids})
          UNION ALL
          SELECT "originalOperatorId", "signature", "history" FROM "DaemonArchive" WHERE "originalOperatorId" = ANY(${ids})
        ) d
        GROUP BY d."originalOperatorId"`,
      prisma.ticket.groupBy({ by: ['operatorId'], where: { operatorId: { in: ids }, status: 'DONE' }, _count: { _all: true } }),
    ]);
    const byOp = new Map(stats.map((s) => [s.id, s]));
    const done = new Map(tickets.map((t) => [t.operatorId, t._count._all]));
    const rows = org.members.map((m) => {
      const s = byOp.get(m.operatorId);
      return { operatorId: m.operatorId, name: m.name, rank: m.rank, captures: s?.captures ?? 0, highestSignature: s?.sig ?? 0, evolutions: s?.evo ?? 0, ticketsDone: done.get(m.operatorId) ?? 0 };
    });
    return rows.sort((a, b) => b.captures - a.captures || b.highestSignature - a.highestSignature);
  });

  /** 2048 bits; name rules and filter as the starter claim, unique. Nothing is charged when the name is refused. */
  app.post('/api/me/rename', auth, async (req) => {
    const me = req.operator!.id;
    const { name } = parse(RenameBody, req.body);
    if (!(await nameAllowed(prisma, name))) throw badRequest('that name is not allowed');
    const current = await prisma.operator.findUniqueOrThrow({ where: { id: me }, select: { starterClaimed: true, name: true } });
    if (!current.starterClaimed) throw badRequest('claim a starter first');
    if (current.name === name) throw badRequest('that is already your name'); // re-checked under the operator lock
    let bits: BitsPushMessage;
    try {
      bits = await prisma.$transaction(async (tx) => {
        await debit(tx, me, RENAME_PRICE);
        // Under the operator lock: an identical rename that committed meanwhile makes this one a no-op, not a second charge.
        if ((await tx.operator.findUniqueOrThrow({ where: { id: me }, select: { name: true } })).name === name) throw badRequest('that is already your name');
        const push = await ledger(tx, me, RENAME_PRICE, 'rename', name);
        await tx.operator.update({ where: { id: me }, data: { name } });
        return push;
      });
    } catch (err) {
      uniqueToBadRequest(err);
    }
    publish('admin', bits);
    publish('admin', { kind: 'rename', operatorId: me, name, origin: 'api' });
    return { ok: true, name, bits: bits.balance };
  });
}
