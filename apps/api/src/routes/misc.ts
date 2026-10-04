import type { PrismaClient } from '@daemonet/db';
import { ITEMS, MOVES, NATURES, SPECIES, TRAITS, TYPES, getFamily, typeMultiplier } from '@daemonet/rules';
import { BESTIARY_WITH_RULES } from '@daemonet/rules/evolution';
import type { FastifyInstance } from 'fastify';
import { hashToken, randomToken } from '../auth/session.js';

export const TICKET_TTL_MS = 60_000;
/** Readiness must answer even when the database hangs (carry-forward #10: the sim uses 2 s too). */
export const READY_TIMEOUT_MS = 2_000;

export interface DiscoveryRow {
  formId: string;
  operatorId: string;
  operatorName: string | null;
  discoveredAt: Date;
}

/**
 * Static content the client renders (Codex) — served from the same package the sim enforces.
 * Evolution requirements ride only on `bestiary` (from the server-only rules subpath); hidden ones are
 * blanked until someone has discovered the form (SP3a spec §4.3). `species` carries no requirements;
 * `discovered` lists every form that has been evolved into at least once. `challenges` carries each
 * capture family's player-facing rule text (the package is private, so the client cannot read the source).
 */
export function codexPayload(discoveries: readonly DiscoveryRow[]) {
  const discovered = new Set(discoveries.map((d) => d.formId));
  const mask = <T extends { id: string; hidden: boolean; requirement: unknown }>(row: T): T =>
    row.hidden && !discovered.has(row.id) ? { ...row, requirement: null } : row;
  return {
    types: TYPES,
    chart: Object.fromEntries(TYPES.map((a) => [a, Object.fromEntries(TYPES.map((d) => [d, typeMultiplier(a, [d])]))])),
    species: SPECIES,
    bestiary: BESTIARY_WITH_RULES.map(mask),
    moves: MOVES,
    items: ITEMS,
    natures: NATURES,
    traits: TRAITS,
    challenges: TYPES.map((type) => ({ type, rules: getFamily(type).rules })),
    discovered: [...discovered],
    discoveries: discoveries.map((d) => ({ formId: d.formId, operatorName: d.operatorName, discoveredAt: d.discoveredAt })),
  };
}

export async function listDiscoveries(prisma: PrismaClient): Promise<DiscoveryRow[]> {
  const rows = await prisma.discovery.findMany({ orderBy: { discoveredAt: 'asc' } });
  if (rows.length === 0) return [];
  const ops = await prisma.operator.findMany({ where: { id: { in: rows.map((r) => r.operatorId) } }, select: { id: true, name: true } });
  const names = new Map(ops.map((o) => [o.id, o.name]));
  return rows.map((r) => ({ formId: r.formId, operatorId: r.operatorId, operatorName: names.get(r.operatorId) ?? null, discoveredAt: r.discoveredAt }));
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

  app.get('/api/codex', auth, async () => codexPayload(await listDiscoveries(prisma)));

  app.get('/api/disk', auth, async (req) => {
    const rows = await prisma.daemon.findMany({ where: { operatorId: req.operator!.id, location: 'DISK' }, orderBy: { slot: 'asc' } });
    return rows.map((d) => ({
      id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus,
      clean: d.clean, signature: d.signature, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed, slot: d.slot,
      heldItem: d.heldItem, patched: d.patched, moveTypeUses: d.moveTypeUses, crashes: d.crashes, history: d.history,
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
