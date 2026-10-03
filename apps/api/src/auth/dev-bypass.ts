import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import { ensureOperator } from './routes.js';
import type { SessionStore } from './session.js';

/**
 * Development only (AUTH_DEV_BYPASS=true, refused in production): GET /api/auth/dev?name=alice
 * creates a session for sub `dev-alice` — the same sub the sim's dev verifier uses, so the
 * browser and a `dev:alice` bot share one operator.
 */
export function registerDevBypass(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; sessionStore: SessionStore; cookieName: string; cookieSecure: boolean; ttlSeconds: number; frontendOrigin: string; adminGroup: string; requiredGroup: string },
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
}
