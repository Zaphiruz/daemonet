import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@daemonet/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerDevBypass } from './auth/dev-bypass.js';
import { makeRequireAdmin, makeRequireAuth } from './auth/middleware.js';
import type { OidcClient } from './auth/oidc.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createSessionStore } from './auth/session.js';
import { AppError } from './errors.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerScriptRoutes } from './routes/scripts.js';

export const COOKIE_NAME = 'daemonet_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface BuildAppOptions {
  prisma: PrismaClient;
  sessionSecret: string;
  cookieSecure: boolean;
  frontendOrigin: string;
  /** OIDC redirect URI (defaults to `<frontendOrigin>/api/auth/callback`). */
  redirectUri?: string;
  oidcClient: OidcClient | null;
  requiredGroup: string;
  adminGroup: string;
  devBypass: boolean;
  trustProxyHops?: number;
  logger?: FastifyServerOptions['logger'];
  disableRateLimit?: boolean;
}

export async function buildApp(o: BuildAppOptions): Promise<FastifyInstance> {
  const hops = o.trustProxyHops ?? 0;
  // Fastify's numeric trustProxy is a no-op; the hop-count predicate is what proxy-addr honours.
  const app = Fastify({ logger: o.logger ?? false, trustProxy: (_addr: string, hop: number) => hop < hops });
  await app.register(cookie, { secret: o.sessionSecret });
  if (!o.disableRateLimit) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  const sessionStore = createSessionStore(o.prisma, SESSION_TTL_SECONDS);
  const common = { cookieName: COOKIE_NAME, cookieSecure: o.cookieSecure, ttlSeconds: SESSION_TTL_SECONDS, adminGroup: o.adminGroup };
  app.decorate('requireAuth', makeRequireAuth({ sessionStore, ...common }));
  app.decorate('requireAdmin', makeRequireAdmin());

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e.message }, 'unhandled error');
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'internal_error', message: status >= 500 ? 'internal error' : (e.message ?? 'error') });
  });

  registerAuthRoutes(app, { prisma: o.prisma, sessionStore, oidcClient: o.oidcClient, frontendOrigin: o.frontendOrigin, redirectUri: o.redirectUri ?? null, requiredGroup: o.requiredGroup, ...common });
  if (o.devBypass) registerDevBypass(app, { prisma: o.prisma, sessionStore, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  registerScriptRoutes(app, o.prisma);
  registerMiscRoutes(app, o.prisma);
  return app;
}
