import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { BearerVerifier } from './auth/bearer.js';
import { registerDevBypass } from './auth/dev-bypass.js';
import { makeRequireAdmin, makeRequireAuth } from './auth/middleware.js';
import type { OidcClient } from './auth/oidc.js';
import { operatorForSub, registerAuthRoutes } from './auth/routes.js';
import { createSessionStore } from './auth/session.js';
import { AppError } from './errors.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEconomyRoutes } from './routes/economy.js';
import { registerExchangeRoutes } from './routes/exchange.js';
import { registerIncidentRoutes } from './routes/incidents.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerScriptRoutes } from './routes/scripts.js';

export const COOKIE_NAME = 'daemonet_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface BuildAppOptions {
  prisma: PrismaClient;
  /** The sim ⇄ api bus: admin chat actions, bits and renames go on its `admin` channel, org membership on `org`. */
  bus: Bus;
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
  /** Bots' `Authorization: Bearer` tokens (SP5): the bot provider's verifier, plus `dev:` tokens under the dev bypass. */
  bearer?: BearerVerifier | null;
}

export async function buildApp(o: BuildAppOptions): Promise<FastifyInstance> {
  const hops = o.trustProxyHops ?? 0;
  // Fastify's numeric trustProxy is a no-op; the hop-count predicate is what proxy-addr honours.
  const app = Fastify({ logger: o.logger ?? false, trustProxy: (_addr: string, hop: number) => hop < hops });
  await app.register(cookie, { secret: o.sessionSecret });
  if (!o.disableRateLimit) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  const sessionStore = createSessionStore(o.prisma, SESSION_TTL_SECONDS);
  const common = { cookieName: COOKIE_NAME, cookieSecure: o.cookieSecure, ttlSeconds: SESSION_TTL_SECONDS, adminGroup: o.adminGroup };
  app.decorate(
    'requireAuth',
    makeRequireAuth({ sessionStore, ...common, bearer: o.bearer ?? null, operatorForSub: (sub, groupAdmin) => operatorForSub(o.prisma, sub, groupAdmin) }),
  );
  app.decorate('requireAdmin', makeRequireAdmin());

  // every /api response is per session (research, tickets, ledger...): never stored by a shared cache (the Caddy edge sends no-store too)
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'private, no-store');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: 'internal_error', message: 'internal error' });
    }
    const code = status === 429 ? 'rate_limited' : status === 413 ? 'payload_too_large' : 'bad_request';
    return reply.code(status).send({ error: code, message: e.message ?? 'error' });
  });

  registerAuthRoutes(app, { prisma: o.prisma, sessionStore, oidcClient: o.oidcClient, frontendOrigin: o.frontendOrigin, redirectUri: o.redirectUri ?? null, requiredGroup: o.requiredGroup, ...common });
  if (o.devBypass) registerDevBypass(app, { prisma: o.prisma, bus: o.bus, sessionStore, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  registerScriptRoutes(app, o.prisma);
  registerMiscRoutes(app, o.prisma);
  registerEconomyRoutes(app, o.prisma);
  registerChatRoutes(app, o.prisma, o.bus);
  registerOrgRoutes(app, o.prisma, o.bus);
  registerIncidentRoutes(app, o.prisma, o.bus);
  registerExchangeRoutes(app, o.prisma, o.bus);
  return app;
}
