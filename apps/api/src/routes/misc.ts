import type { PrismaClient } from '@daemonet/db';
import { ITEMS, MOVES, NATURES, SPECIES, TRAITS, TYPES, typeMultiplier } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { hashToken, randomToken } from '../auth/session.js';

export const TICKET_TTL_MS = 60_000;
/** Readiness must answer even when the database hangs (carry-forward #10: the sim uses 2 s too). */
export const READY_TIMEOUT_MS = 2_000;

/** Static content the client renders (Codex) — served from the same package the sim enforces. */
export function codexPayload() {
  return {
    types: TYPES,
    chart: Object.fromEntries(TYPES.map((a) => [a, Object.fromEntries(TYPES.map((d) => [d, typeMultiplier(a, [d])]))])),
    species: SPECIES,
    moves: MOVES,
    items: ITEMS,
    natures: NATURES,
    traits: TRAITS,
  };
}

async function databaseReachable(prisma: PrismaClient): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function registerMiscRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/api/ready', async (_req, reply) => {
    if (await databaseReachable(prisma)) return { ok: true };
    return reply.code(503).send({ ok: false });
  });

  app.get('/api/codex', auth, async () => codexPayload());

  app.get('/api/disk', auth, async (req) => {
    const rows = await prisma.daemon.findMany({ where: { operatorId: req.operator!.id, location: 'DISK' }, orderBy: { slot: 'asc' } });
    return rows.map((d) => ({
      id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus,
      clean: d.clean, signature: d.signature, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed, slot: d.slot,
      log: { originalOperatorId: d.originalOperatorId, capturedAt: d.capturedAt, subnet: d.captureSubnet, tool: d.captureTool, spawnIndex: d.spawnIndex },
    }));
  });

  /** Single-use ticket for the browser's WebSocket (sent as `auth { token: "ticket:<value>" }`). Only its SHA-256 is stored. */
  app.post('/api/ws/ticket', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const value = randomToken();
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    await prisma.wsTicket.create({ data: { tokenHash: hashToken(value), operatorId: req.operator!.id, expiresAt } });
    await prisma.wsTicket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return { ticket: `ticket:${value}`, expiresAt };
  });
}
