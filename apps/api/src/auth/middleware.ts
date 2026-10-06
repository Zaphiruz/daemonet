import type { FastifyReply, FastifyRequest } from 'fastify';
import { authUnavailable, forbidden, unauthorized, type AppError } from '../errors.js';
import { BearerError, type BearerVerifier } from './bearer.js';
import type { SessionStore } from './session.js';

export interface RequestOperator {
  id: string;
  isAdmin: boolean;
  /** How the request authenticated: a browser session, or a bot's bearer token. */
  via: 'session' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: RequestOperator;
  }
  interface FastifyContextConfig {
    /**
     * Opt-in: this route also accepts bots' `Authorization: Bearer` tokens (SP5 spec §3 — the Exchange, `/api/me`,
     * read-only `/api/disk`, the read-only `/api/arena/*` routes (SP6), and the dev-bypass helpers). Every other route
     * refuses a bearer request with a generic 401.
     */
    bearer?: boolean;
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
  /** Bots: `Authorization: Bearer <access token>` (SP5). Null = bearer auth is off. */
  bearer: BearerVerifier | null;
  /**
   * Resolves the operator row for a bearer subject, creating it on first sight (with `isAdmin` from the token's
   * groups, as a first login would). An existing row is never changed here (a bot request cannot promote or demote).
   */
  operatorForSub: (sub: string, groupAdmin: boolean) => Promise<{ id: string; isAdmin: boolean }>;
}

/** Mutating requests must carry this header: browsers cannot add it cross-site, so it doubles as CSRF protection. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'daemonet';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What every refused credential looks like on the wire; the reason goes to the log (carry-forward #8). */
export const AUTH_FAILED = 'authentication failed';

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

export function makeRequireAuth(deps: AuthMiddlewareDeps) {
  /** Logs why (never the token, the header or the query string) and returns the generic 401. */
  const refuse = (req: FastifyRequest, reason: string, unavailable = false, level: 'info' | 'warn' = 'warn'): AppError => {
    req.log[level]({ reason: reason.slice(0, 200), unavailable }, 'bearer authentication failed');
    return unavailable ? authUnavailable() : unauthorized(AUTH_FAILED);
  };

  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const cookieToken = req.cookies[deps.cookieName];
    if (header !== undefined) {
      // Bots only. A request that ALSO carries a session cookie is ambiguous (which identity, and does CSRF apply?):
      // refuse it rather than pick one.
      // Client mistakes rather than attacks on a verifier: logged at info.
      if (cookieToken) throw refuse(req, 'both a session cookie and an Authorization header', false, 'info');
      const m = BEARER.exec(header);
      if (!m) throw refuse(req, 'malformed Authorization header', false, 'info');
      if (req.routeOptions.config.bearer !== true) throw refuse(req, 'route does not accept bearer tokens', false, 'info');
      if (!deps.bearer) throw refuse(req, 'bearer tokens are not accepted', false, 'info');
      const token = m[1]!;
      let claims;
      try {
        claims = await deps.bearer(token);
      } catch (err) {
        const unavailable = err instanceof BearerError && err.unavailable;
        // Belt and braces: a verifier message must never carry the token into the log.
        const reason = String((err as Error)?.message ?? err).split(token).join('[token]');
        throw refuse(req, reason, unavailable);
      }
      // No CSRF check: a browser cannot attach an Authorization header cross-site (no CORS), and cookies are refused above.
      const op = await deps.operatorForSub(claims.sub, claims.groups.includes(deps.adminGroup));
      // A bot never acts as an admin (SP5 spec §3): admin rights stay with browser sessions (Operator.isAdmin, #17).
      req.operator = { id: op.id, isAdmin: false, via: 'bearer' };
      return;
    }
    if (!cookieToken) throw unauthorized('no session');
    const session = await deps.sessionStore.get(cookieToken);
    if (!session) throw unauthorized('invalid session');
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) throw forbidden(`missing ${CSRF_HEADER} header`);
    // Sliding expiry: once less than 6/7 of the TTL remains, extend the row and the cookie.
    if (session.expiresAt.getTime() - Date.now() < deps.ttlSeconds * 1000 * (6 / 7)) {
      await deps.sessionStore.touch(cookieToken);
      reply.setCookie(deps.cookieName, cookieToken, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    }
    req.operator = { id: session.operatorId, isAdmin: session.isAdmin, via: 'session' };
  };
}

export function makeRequireAdmin() {
  return async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!req.operator) throw unauthorized('no session');
    // Admin actions are browser-only: a bot's bearer token never carries admin rights (SP5 spec §3).
    if (req.operator.via === 'bearer' || !req.operator.isAdmin) throw forbidden('admin required');
  };
}
