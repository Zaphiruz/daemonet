import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../errors.js';
import type { SessionStore } from './session.js';

export interface RequestOperator {
  id: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: RequestOperator;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthMiddlewareDeps {
  sessionStore: SessionStore;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  adminGroup: string;
}

/** Mutating requests must carry this header: browsers cannot add it cross-site, so it doubles as CSRF protection. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'daemonet';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function makeRequireAuth(deps: AuthMiddlewareDeps) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies[deps.cookieName];
    if (!token) throw unauthorized('no session');
    const session = await deps.sessionStore.get(token);
    if (!session) throw unauthorized('invalid session');
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) throw forbidden(`missing ${CSRF_HEADER} header`);
    // Sliding expiry: once less than 6/7 of the TTL remains, extend the row and the cookie.
    if (session.expiresAt.getTime() - Date.now() < deps.ttlSeconds * 1000 * (6 / 7)) {
      await deps.sessionStore.touch(token);
      reply.setCookie(deps.cookieName, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    }
    req.operator = { id: session.operatorId, isAdmin: session.groups.includes(deps.adminGroup) };
  };
}

export function makeRequireAdmin() {
  return async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!req.operator) throw unauthorized('no session');
    if (!req.operator.isAdmin) throw forbidden('admin required');
  };
}
