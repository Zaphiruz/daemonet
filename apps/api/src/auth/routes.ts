import type { PrismaClient } from '@daemonet/db';
import { LO } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { badRequest, forbidden } from '../errors.js';
import { CSRF_HEADER, CSRF_VALUE } from './middleware.js';
import type { OidcClient } from './oidc.js';
import type { SessionStore } from './session.js';

export interface AuthRouteDeps {
  prisma: PrismaClient;
  sessionStore: SessionStore;
  oidcClient: OidcClient | null;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  frontendOrigin: string;
  requiredGroup: string;
  adminGroup: string;
}

interface Pkce {
  state: string;
  nonce: string;
  codeVerifier: string;
}
export const PKCE_COOKIE = 'daemonet_oidc';

const encode = (p: Pkce) => Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
function decode(v: string): Pkce | null {
  try {
    const p = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Pkce;
    return typeof p.state === 'string' && typeof p.nonce === 'string' && typeof p.codeVerifier === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Same rule as the sim: an operator row is keyed by the OIDC sub and created on first sight. */
export async function ensureOperator(prisma: PrismaClient, sub: string, isAdmin: boolean): Promise<{ id: string }> {
  return prisma.operator.upsert({
    where: { sub },
    update: { isAdmin, lastSeenAt: new Date() },
    create: { sub, subnet: LO.id, x: LO.spawn.x, y: LO.spawn.y, isAdmin },
    select: { id: true },
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const limit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: deps.cookieSecure, maxAge: deps.ttlSeconds };

  app.get('/api/auth/login', limit, async (_req, reply) => {
    if (!deps.oidcClient) throw badRequest('OIDC is not configured');
    const start = await deps.oidcClient.start();
    reply.setCookie(PKCE_COOKIE, encode({ state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier }), {
      path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, signed: true, maxAge: 600,
    });
    return reply.redirect(start.url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/callback', limit, async (req, reply) => {
    if (!deps.oidcClient) throw badRequest('OIDC is not configured');
    const { code, state, error } = req.query;
    if (error) {
      // Never reflect provider-supplied text back to the client; the log gets a bounded copy.
      req.log.warn({ providerError: String(error).slice(0, 100) }, 'oidc provider returned an error');
      throw badRequest('login failed');
    }
    if (!code || !state) throw badRequest('missing code or state');
    const raw = req.cookies[PKCE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const pkce = unsigned?.valid && unsigned.value ? decode(unsigned.value) : null;
    if (!pkce || pkce.state !== state) throw badRequest('state mismatch');

    const callbackUrl = new URL(req.url, deps.frontendOrigin);
    let identity;
    try {
      identity = await deps.oidcClient.finish(callbackUrl, pkce);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'oidc exchange failed');
      throw badRequest('token exchange failed');
    }
    reply.clearCookie(PKCE_COOKIE, { path: '/api/auth' });
    if (!identity.groups.includes(deps.requiredGroup)) {
      req.log.warn({ sub: identity.sub }, 'login refused: missing required group');
      throw forbidden('not authorized');
    }
    const op = await ensureOperator(deps.prisma, identity.sub, identity.groups.includes(deps.adminGroup));
    const token = await deps.sessionStore.create(op.id, identity.groups);
    reply.setCookie(deps.cookieName, token, cookieOpts);
    req.log.info({ sub: identity.sub }, 'login');
    return reply.redirect(`${deps.frontendOrigin}/`);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.headers[CSRF_HEADER] !== CSRF_VALUE) throw forbidden(`missing ${CSRF_HEADER} header`);
    const token = req.cookies[deps.cookieName];
    if (token) await deps.sessionStore.destroy(token);
    reply.clearCookie(deps.cookieName, { path: '/' });
    const endSessionUrl = deps.oidcClient ? await deps.oidcClient.endSessionUrl(undefined, deps.frontendOrigin) : null;
    return { ok: true, endSessionUrl };
  });

  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => {
    const op = await deps.prisma.operator.findUniqueOrThrow({
      where: { id: req.operator!.id },
      select: { id: true, name: true, starterClaimed: true, bits: true },
    });
    return { operatorId: op.id, name: op.name, starterClaimed: op.starterClaimed, bits: Number(op.bits), isAdmin: req.operator!.isAdmin };
  });
}
