import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.js';

export const MAX_SCRIPT_BYTES = 256 * 1024;
export const KEPT_VERSIONS = 16;

const PutBody = z.object({ source: z.string() });

export function registerScriptRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const limit = { config: { rateLimit: { max: 64, timeWindow: '1 minute' } } };
  const auth = { preHandler: app.requireAuth };

  app.get('/api/scripts/main', auth, async (req) => {
    const row = await prisma.script.findUnique({ where: { operatorId: req.operator!.id } });
    return row ? { source: row.source, version: row.version, updatedAt: row.updatedAt } : { source: '', version: 0, updatedAt: null };
  });

  app.put('/api/scripts/main', { ...auth, ...limit }, async (req) => {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { source: string }');
    const { source } = parsed.data;
    if (Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES) throw badRequest(`script exceeds ${MAX_SCRIPT_BYTES} bytes`);
    const operatorId = req.operator!.id;
    return prisma.$transaction(async (tx) => {
      // The increment happens in the database, so concurrent saves each get a distinct version.
      const saved = await tx.script.upsert({
        where: { operatorId },
        update: { source, version: { increment: 1 } },
        create: { operatorId, source, version: 1 },
      });
      await tx.scriptVersion.create({ data: { operatorId, version: saved.version, source } });
      const stale = await tx.scriptVersion.findMany({
        where: { operatorId },
        orderBy: { version: 'desc' },
        skip: KEPT_VERSIONS,
        select: { version: true },
      });
      if (stale.length) await tx.scriptVersion.deleteMany({ where: { operatorId, version: { in: stale.map((s) => s.version) } } });
      return { version: saved.version, updatedAt: saved.updatedAt };
    });
  });

  app.get('/api/scripts/main/versions', auth, async (req) => {
    const rows = await prisma.scriptVersion.findMany({
      where: { operatorId: req.operator!.id },
      orderBy: { version: 'desc' },
      select: { version: true, createdAt: true, source: true },
    });
    return rows.map((r) => ({ version: r.version, createdAt: r.createdAt, bytes: Buffer.byteLength(r.source, 'utf8') }));
  });

  app.get<{ Params: { version: string } }>('/api/scripts/main/versions/:version', auth, async (req) => {
    if (!/^\d{1,9}$/.test(req.params.version)) throw badRequest('bad version');
    const version = Number(req.params.version);
    if (version < 1) throw badRequest('bad version');
    const row = await prisma.scriptVersion.findUnique({ where: { operatorId_version: { operatorId: req.operator!.id, version } } });
    if (!row) throw notFound('no such version');
    return { version: row.version, createdAt: row.createdAt, source: row.source };
  });
}
