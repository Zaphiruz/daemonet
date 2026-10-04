import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import {
  CHAT_HISTORY_DAYS,
  DEFAULT_TERMS,
  FILTER_MAX_TERMS,
  REPORTS_PER_DAY,
  compileFilter,
  nameAllowedBy,
  validateFilterTerm,
  type FilterTerm,
} from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors.js';
import { publishSafely } from '../publish.js';

const Channel = z.string().regex(/^(subnet|cluster|org|dm):[A-Za-z0-9_-]{1,64}$/);
/**
 * History pages run newest first by `(at, id)`; the cursor is the oldest line held: `before` (its `at`) and `beforeId`
 * (its id), so lines sharing a millisecond across a page boundary are neither skipped nor repeated.
 */
const HistoryQuery = z
  .object({
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(64).default(64),
  })
  .refine((q) => q.beforeId === undefined || q.before !== undefined, { message: 'beforeId needs before' });
const MuteBody = z.object({ operatorId: z.string().min(1).max(64), minutes: z.number().int().min(0).max(60 * 24 * 30) });
const TermBody = z.object({ pattern: z.string().min(1).max(64), kind: z.enum(['WORD', 'REGEX']), action: z.enum(['BLOCK', 'MASK']) });
const ReportBody = z.object({
  targetId: z.string().min(1).max(64),
  messageId: z.string().min(1).max(64).optional(),
  reason: z.enum(['SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER']),
  note: z.string().max(256).default(''),
});
const ResolveBody = z.object({ action: z.enum(['DISMISS', 'DELETE', 'MUTE']), minutes: z.number().int().min(1).max(60 * 24 * 30).optional() });
const BlockBody = z.object({ operatorId: z.string().min(1).max(64) });

/** Lines of the reported operator's recent chat and filter hits shown with each report in the admin queue. */
export const REPORT_CONTEXT_ROWS = 8;
/** Admin terms allowed on top of the default list, so the published list always fits the sim's FILTER_MAX_TERMS. */
export const MAX_ADMIN_TERMS = FILTER_MAX_TERMS - DEFAULT_TERMS.length;

/**
 * Whether a name (operator name, org name or tag) passes the live chat filter: the same terms the sim compiles
 * (DEFAULT_TERMS + the admin ChatFilterTerm rows, oldest first), read afresh so a term added a moment ago applies.
 */
export async function nameAllowed(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.chatFilterTerm.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { pattern: true, kind: true, action: true } });
  return nameAllowedBy(compileFilter([...DEFAULT_TERMS, ...rows]), name);
}

/** zod failures are the caller's fault: 400, not 500. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Bus `admin` messages, in exactly the shapes the sim's ChatService validates (apps/sim/src/runtime/chat.ts). */
type AdminMessage =
  | { kind: 'mute'; operatorId: string; until: string | null; reason: string; origin: 'api' }
  | { kind: 'delete'; id: string; channel: string }
  | { kind: 'filter'; terms: FilterTerm[] };

/** Chat history, blocks, reports and the admin side (mute, delete, filter terms, report queue) — SP4 spec §5. */
export function registerChatRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: [app.requireAuth, app.requireAdmin] };

  /**
   * The database is the source of truth (the sim reads mutes and terms when it loads); the bus only makes the change
   * live. A Redis outage must neither fail the admin's request nor become an unhandled rejection, and the log carries
   * the kind and error class only (never message text).
   */
  function publish(message: AdminMessage): void {
    publishSafely(bus, app.log, 'admin', message);
  }

  /**
   * Subnet history is public; a DM thread is readable by either side (rows are filtered to the pair); org history is
   * readable by the org's current members only (leaving or being kicked removes access); cluster history is live-only.
   */
  async function mayRead(operatorId: string, channel: string): Promise<boolean> {
    const [kind, id] = channel.split(':', 2);
    if (kind === 'org') return (await prisma.orgMember.findUnique({ where: { operatorId }, select: { orgId: true } }))?.orgId === id;
    return kind === 'subnet' || kind === 'dm';
  }

  app.get<{ Params: { channel: string }; Querystring: unknown }>('/api/chat/:channel', auth, async (req) => {
    const channel = parse(Channel, req.params.channel);
    const q = parse(HistoryQuery, req.query);
    const me = req.operator!.id;
    if (!(await mayRead(me, channel))) throw forbidden('not a member of that channel');
    const before = q.before ? new Date(q.before) : null;
    const cursor = !before ? [] : q.beforeId ? [{ OR: [{ at: { lt: before } }, { at: before, id: { lt: q.beforeId } }] }] : [{ at: { lt: before } }];
    // DM rows are stored in the sender's form (`dm:<recipient>`): the thread is my lines to them plus theirs to me.
    const dm = channel.startsWith('dm:');
    const thread = dm ? [{ OR: [{ channel, operatorId: me }, { channel: `dm:${me}`, operatorId: channel.slice(3) }] }] : [{ channel }];
    const where = { deletedAt: null, AND: [...thread, ...cursor] };
    const rows = await prisma.chatMessage.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: q.limit });
    const names = new Map(
      (await prisma.operator.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.operatorId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]),
    );
    // Each side sees a DM thread under the other's id (spec §5), whichever direction a row was stored in.
    return rows.reverse().map((r) => ({ id: r.id, channel: dm ? channel : r.channel, from: r.operatorId, name: names.get(r.operatorId) ?? null, text: r.text, at: r.at }));
  });

  // ---- blocks (the caller's own rows only)
  app.post('/api/chat/block', auth, async (req) => {
    const { operatorId } = parse(BlockBody, req.body);
    const me = req.operator!.id;
    if (operatorId === me) throw badRequest('cannot block yourself');
    if ((await prisma.operator.count({ where: { id: operatorId } })) === 0) throw badRequest('unknown operator');
    await prisma.chatBlock.upsert({ where: { blockerId_blockedId: { blockerId: me, blockedId: operatorId } }, create: { blockerId: me, blockedId: operatorId }, update: {} });
    return { ok: true };
  });
  app.delete('/api/chat/block', auth, async (req) => {
    const { operatorId } = parse(BlockBody, req.body);
    await prisma.chatBlock.deleteMany({ where: { blockerId: req.operator!.id, blockedId: operatorId } });
    return { ok: true };
  });

  // ---- reports (players). The reporter only ever learns "received" (spec §5.2), never the outcome.
  app.post('/api/reports', auth, async (req) => {
    const body = parse(ReportBody, req.body);
    const me = req.operator!.id;
    if (body.targetId === me) throw badRequest('cannot report yourself');
    if ((await prisma.operator.count({ where: { id: body.targetId } })) === 0) throw badRequest('unknown operator');
    if (body.messageId) {
      const msg = await prisma.chatMessage.findUnique({ where: { id: body.messageId } });
      // A DM line is reportable by its two sides only; the refusal reads the same as for a line that does not exist.
      const readable = msg && (!msg.channel.startsWith('dm:') || msg.operatorId === me || msg.toId === me);
      if (!msg || !readable || msg.operatorId !== body.targetId) throw badRequest('no such message from that operator');
    }
    // One transaction under the reporter's row lock: concurrent reports cannot pass the daily cap or the dedupe together.
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Operator" WHERE "id" = ${me} FOR NO KEY UPDATE`;
      if (body.messageId) {
        const dup = await tx.report.findUnique({ where: { reporterId_messageId: { reporterId: me, messageId: body.messageId } }, select: { id: true } });
        if (dup) return { ok: true, id: dup.id, duplicate: true };
      }
      const since = new Date(Date.now() - 86_400_000);
      if ((await tx.report.count({ where: { reporterId: me, at: { gte: since } } })) >= REPORTS_PER_DAY) throw badRequest(`at most ${REPORTS_PER_DAY} reports per day`);
      const row = await tx.report.create({ data: { reporterId: me, targetId: body.targetId, messageId: body.messageId ?? null, reason: body.reason, note: body.note }, select: { id: true } });
      return { ok: true, id: row.id };
    });
  });

  // ---- admin (Operator.isAdmin is read on every request by requireAuth)
  app.post('/api/admin/chat/mute', admin, async (req) => {
    const { operatorId, minutes } = parse(MuteBody, req.body);
    if (operatorId === req.operator!.id) throw badRequest('cannot mute yourself');
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
    const res = await prisma.operator.updateMany({ where: { id: operatorId }, data: { mutedUntil: until } });
    if (res.count !== 1) throw notFound('no such operator');
    publish({ kind: 'mute', operatorId, until: until ? until.toISOString() : null, reason: 'admin', origin: 'api' });
    return { ok: true, until };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/chat/:id', admin, async (req) => {
    const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.id }, select: { id: true, channel: true, deletedAt: true } });
    if (!msg) throw notFound('no such message');
    if (!msg.deletedAt) await prisma.chatMessage.update({ where: { id: msg.id }, data: { deletedAt: new Date() } });
    publish({ kind: 'delete', id: msg.id, channel: msg.channel });
    return { ok: true };
  });

  app.get('/api/admin/chat/filter', admin, async () => prisma.chatFilterTerm.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }] }));
  app.post('/api/admin/chat/filter', admin, async (req) => {
    const body = parse(TermBody, req.body);
    // Refuse what the sim's compileFilter would silently drop (invalid, unsafe ReDoS-prone, or matching everywhere).
    const valid = validateFilterTerm(body);
    if (!valid.ok) throw badRequest(`filter term refused: ${valid.reason}`);
    if ((await prisma.chatFilterTerm.count()) >= MAX_ADMIN_TERMS) throw badRequest(`at most ${MAX_ADMIN_TERMS} filter terms`);
    const row = await prisma.chatFilterTerm.create({ data: { ...body, addedBy: req.operator!.id } });
    await publishTerms();
    return row;
  });
  app.delete<{ Params: { id: string } }>('/api/admin/chat/filter/:id', admin, async (req) => {
    await prisma.chatFilterTerm.deleteMany({ where: { id: req.params.id } });
    await publishTerms();
    return { ok: true };
  });

  /** Serialized, and each run reads the table afresh: the last list published is the table after the last change. */
  let termsChain: Promise<void> = Promise.resolve();
  function publishTerms(): Promise<void> {
    termsChain = termsChain
      .then(async () => {
        const rows = await prisma.chatFilterTerm.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }], take: MAX_ADMIN_TERMS });
        publish({ kind: 'filter', terms: rows.map((r) => ({ pattern: r.pattern, kind: r.kind, action: r.action })) });
      })
      .catch((err: unknown) => app.log.warn({ err: { name: (err as Error)?.name } }, 'reading filter terms for the bus failed'));
    return termsChain;
  }

  app.get('/api/admin/chat/hits', admin, async () => prisma.chatFilterHit.findMany({ orderBy: { at: 'desc' }, take: 128 }));

  /** Each report comes with the reported message and the target's recent lines and filter hits (spec §5.2). */
  app.get<{ Querystring: { status?: string } }>('/api/admin/reports', admin, async (req) => {
    const status = (['OPEN', 'ACTIONED', 'DISMISSED'] as const).find((s) => s === req.query.status) ?? 'OPEN';
    const rows = await prisma.report.findMany({ where: { status }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: 128 });
    const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetId]))];
    const names = new Map((await prisma.operator.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const messages = new Map((await prisma.chatMessage.findMany({ where: { id: { in: rows.flatMap((r) => (r.messageId ? [r.messageId] : [])) } } })).map((m) => [m.id, m]));
    const targets = [...new Set(rows.map((r) => r.targetId))];
    const context = new Map(
      await Promise.all(
        targets.map(
          async (id) =>
            [
              id,
              {
                recent: await prisma.chatMessage.findMany({ where: { operatorId: id }, orderBy: { at: 'desc' }, take: REPORT_CONTEXT_ROWS }),
                hits: await prisma.chatFilterHit.findMany({ where: { operatorId: id }, orderBy: { at: 'desc' }, take: REPORT_CONTEXT_ROWS }),
              },
            ] as const,
        ),
      ),
    );
    return rows.map((r) => ({
      ...r,
      reporterName: names.get(r.reporterId) ?? null,
      targetName: names.get(r.targetId) ?? null,
      message: r.messageId ? (messages.get(r.messageId) ?? null) : null,
      recent: context.get(r.targetId)?.recent ?? [],
      hits: context.get(r.targetId)?.hits ?? [],
    }));
  });

  /** A report resolves exactly once: the OPEN → resolved claim and the action commit together, then the bus is told. */
  app.post<{ Params: { id: string } }>('/api/admin/reports/:id/resolve', admin, async (req) => {
    const body = parse(ResolveBody, req.body);
    const by = req.operator!.id;
    const message = await prisma.$transaction(async (tx): Promise<AdminMessage | null> => {
      const report = await tx.report.findUnique({ where: { id: req.params.id } });
      if (!report) throw notFound('no such report');
      if (body.action === 'DELETE' && !report.messageId) throw badRequest('this report has no message to delete');
      if (body.action === 'MUTE' && report.targetId === by) throw badRequest('cannot mute yourself');
      const claimed = await tx.report.updateMany({
        where: { id: report.id, status: 'OPEN' },
        data: { status: body.action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED', resolvedBy: by, resolvedAt: new Date(), action: body.action },
      });
      if (claimed.count !== 1) throw badRequest('already resolved');
      if (body.action === 'DELETE') {
        const msg = await tx.chatMessage.findUnique({ where: { id: report.messageId! }, select: { id: true, channel: true, deletedAt: true } });
        if (!msg) throw badRequest('the message no longer exists');
        if (!msg.deletedAt) await tx.chatMessage.update({ where: { id: msg.id }, data: { deletedAt: new Date() } });
        return { kind: 'delete', id: msg.id, channel: msg.channel };
      }
      if (body.action === 'MUTE') {
        const until = new Date(Date.now() + (body.minutes ?? 60) * 60_000);
        const res = await tx.operator.updateMany({ where: { id: report.targetId }, data: { mutedUntil: until } });
        if (res.count !== 1) throw badRequest('the reported operator no longer exists');
        return { kind: 'mute', operatorId: report.targetId, until: until.toISOString(), reason: 'report', origin: 'api' };
      }
      return null;
    });
    if (message) publish(message);
    return { ok: true };
  });
}

/**
 * Deletes chat lines and filter hits older than CHAT_HISTORY_DAYS; the server runs it at boot and every 6 hours. A line
 * an OPEN report references is kept until the report is resolved (the admin must still see it and be able to act on it).
 */
export async function pruneChat(prisma: PrismaClient, now = new Date()): Promise<{ messages: number; hits: number }> {
  const cutoff = new Date(now.getTime() - CHAT_HISTORY_DAYS * 86_400_000);
  // One statement, so a report opened between a read of the OPEN set and the delete cannot lose its line.
  const messages = await prisma.$executeRaw`
    DELETE FROM "ChatMessage" m
    WHERE m."at" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "Report" r WHERE r."messageId" = m."id" AND r."status" = 'OPEN')`;
  const hits = await prisma.chatFilterHit.deleteMany({ where: { at: { lt: cutoff } } });
  return { messages, hits: hits.count };
}
