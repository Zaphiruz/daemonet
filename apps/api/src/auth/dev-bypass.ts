import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { LO, computeStats, createRng, emptyMoveTypeUses, getSpecies, movesAtLevel, rollSpawn, statBlockToArray, xpForLevel } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { publishSafely } from '../publish.js';
import { ensureOperator } from './routes.js';
import type { SessionStore } from './session.js';

const BitsBody = z.object({ amount: z.number().int().min(1).max(1_000_000) });
const SeedBody = z.object({ species: z.string().min(1).max(32), level: z.number().int().min(1).max(64) });

/**
 * Development only (AUTH_DEV_BYPASS=true, refused in production): GET /api/auth/dev?name=alice
 * creates a session for sub `dev-alice` — the same sub the sim's dev verifier uses, so the
 * browser and a `dev:alice` bot share one operator. POST /api/dev/daemon { species, level } puts a
 * daemon of that species on the caller's Disk (tests load it into RAM at the host, e.g. to evolve it).
 * POST /api/dev/bits { amount } credits bits (ledger reason `admin`, ref `dev`) and pushes the ledger row to the sim
 * over the bus (`admin { kind: 'bits' }`), so a running session sees it at once (or on the sim's next resync if the
 * push is lost).
 */
export function registerDevBypass(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; bus: Bus; sessionStore: SessionStore; cookieName: string; cookieSecure: boolean; ttlSeconds: number; frontendOrigin: string; adminGroup: string; requiredGroup: string },
): void {
  // Second line of defence behind loadConfig: buildApp callers cannot enable this in production either.
  if (process.env.NODE_ENV === 'production') throw new Error('the auth dev bypass must not be enabled in production');
  app.get<{ Querystring: { name?: string; admin?: string } }>('/api/auth/dev', async (req, reply) => {
    const name = req.query.name ?? '';
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw badRequest('name must match [a-z0-9_-]{1,32}');
    const isAdmin = req.query.admin === 'true';
    const op = await ensureOperator(deps.prisma, `dev-${name}`, isAdmin);
    const token = await deps.sessionStore.create(op.id, isAdmin ? [deps.requiredGroup, deps.adminGroup] : [deps.requiredGroup]);
    reply.setCookie(deps.cookieName, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    return reply.redirect(`${deps.frontendOrigin}/`);
  });

  // The dev helpers also take `dev:` bearer tokens, so bot tests can seed state.
  app.post('/api/dev/bits', { preHandler: app.requireAuth, config: { bearer: true } }, async (req) => {
    const parsed = BitsBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { amount: integer 1-1000000 }');
    const operatorId = req.operator!.id;
    const amount = BigInt(parsed.data.amount);
    // Same invariants as the sim's grantBits: balance change and ledger row commit together, the UPDATE row-locks the operator.
    const { row, bits } = await deps.prisma.$transaction(async (tx) => {
      const res = await tx.operator.updateMany({ where: { id: operatorId }, data: { bits: { increment: amount } } });
      if (res.count !== 1) throw badRequest('unknown operator');
      const row = await tx.bitsLedger.create({ data: { operatorId, delta: amount, reason: 'admin', ref: 'dev' }, select: { id: true, seq: true } });
      return { row, bits: (await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } })).bits };
    });
    // After commit, the row itself (the sim applies each ledger row once, by id and seq).
    publishSafely(deps.bus, app.log, 'admin', {
      kind: 'bits', operatorId, ledgerId: row.id, seq: Number(row.seq), delta: parsed.data.amount, reason: 'admin', balance: Number(bits), origin: 'api',
    });
    return { bits: Number(bits), note: 'a running sim session is told over the bus (or picks it up on its next resync)' };
  });

  app.post('/api/dev/daemon', { preHandler: app.requireAuth, config: { bearer: true } }, async (req) => {
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { species, level 1-64 }');
    let species;
    try {
      species = getSpecies(parsed.data.species);
    } catch {
      throw badRequest('unknown species');
    }
    const operatorId = req.operator!.id;
    const { diskCapacity } = await deps.prisma.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { diskCapacity: true } });
    const used = new Set((await deps.prisma.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((r) => r.slot));
    let slot = 0;
    while (used.has(slot) && slot < diskCapacity) slot++;
    if (slot >= diskCapacity) throw badRequest('Disk is full');
    const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roll = rollSpawn(createRng(id), { clean: 0, signatureStep: 0 });
    const level = parsed.data.level;
    const row = await deps.prisma.daemon.create({
      data: {
        id, operatorId, species: species.id, level, xp: xpForLevel(level), nature: roll.nature, traitSlot: roll.traitSlot,
        ivs: statBlockToArray(roll.ivs), bonus: statBlockToArray(roll.bonus), clean: false, signature: 0,
        hp: computeStats({ base: species.base, ivs: roll.ivs, bonus: roll.bonus, level, nature: roll.nature }).hp, energy: 128,
        moves: movesAtLevel(species, level), crashed: false, location: 'DISK', slot, moveTypeUses: emptyMoveTypeUses(),
        history: [{ at: new Date().toISOString(), kind: 'captured', detail: 'dev seed' }],
        originalOperatorId: operatorId, capturedAt: new Date(), captureSubnet: LO.id, captureTool: 'dev', spawnSeedId: 'dev', spawnIndex: null,
      },
    });
    return { id: row.id, species: row.species, level: row.level, slot: row.slot };
  });
}
