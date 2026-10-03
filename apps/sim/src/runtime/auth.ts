import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Claims {
  sub: string;
  groups: string[];
}

export type TokenVerifier = (token: string) => Promise<Claims>;

export class AuthError extends Error {}

export interface OidcOptions {
  /** Authentik issuer URL, e.g. https://authentik.wispy-nook.casa/application/o/daemonet-bot/ */
  issuer: string;
  /** Accepted audiences (client ids). */
  audiences: string[];
  requiredGroup: string;
  /** Tests inject keys; production discovers jwks_uri from the issuer. */
  jwks?: JWTVerifyGetKey;
  /** Tests inject userinfo; production calls the discovered userinfo endpoint. */
  userinfo?: (token: string) => Promise<{ groups?: unknown }>;
  fetch?: typeof fetch;
}

interface Discovery {
  jwks_uri: string;
  userinfo_endpoint: string;
}

const UNAVAILABLE = 'identity provider unavailable';
const FETCH_TIMEOUT_MS = 5000;

/** Fetches JSON from the identity provider; every failure mode becomes an AuthError. */
async function fetchJson(fetchImpl: typeof fetch, input: string | URL, init: RequestInit = {}): Promise<unknown> {
  try {
    const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new AuthError(`${UNAVAILABLE}: ${(err as Error).message}`);
  }
}

async function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const doc = (await fetchJson(fetchImpl, new URL('.well-known/openid-configuration', base))) as Partial<Discovery> | null;
  if (typeof doc?.jwks_uri !== 'string' || typeof doc.userinfo_endpoint !== 'string') throw new AuthError(`${UNAVAILABLE}: bad discovery document`);
  return { jwks_uri: doc.jwks_uri, userinfo_endpoint: doc.userinfo_endpoint };
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies Authentik access tokens (JWT): signature via JWKS, issuer, audience, expiry.
 * Group membership comes from the `groups` claim, or from userinfo when the token has none.
 */
export function createOidcVerifier(opts: OidcOptions): TokenVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let discovery: Promise<Discovery> | null = null;
  const getDiscovery = () =>
    (discovery ??= discover(opts.issuer, fetchImpl).catch((err: unknown) => {
      discovery = null; // do not cache failures: the next login retries
      throw err;
    }));
  let jwks: JWTVerifyGetKey | null = opts.jwks ?? null;

  return async (token) => {
    if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri));
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audiences, algorithms: ['RS256'] }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      const info = opts.userinfo
        ? await opts.userinfo(token)
        : (((await fetchJson(fetchImpl, (await getDiscovery()).userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })) ?? {}) as { groups?: unknown });
      groups = asGroups(info.groups) ?? [];
    }
    if (!groups.includes(opts.requiredGroup)) throw new AuthError(`not in ${opts.requiredGroup}`);
    return { sub: payload.sub, groups };
  };
}

/** Development only: `dev:<name>` is accepted as sub `dev-<name>`. */
export function createDevVerifier(requiredGroup: string): TokenVerifier {
  return async (token) => {
    const m = /^dev:([a-z0-9_-]{1,32})$/.exec(token);
    if (!m) throw new AuthError('invalid dev token');
    return { sub: `dev-${m[1]}`, groups: [requiredGroup] };
  };
}

/** `dev:` tokens go to `dev` (when enabled), `ticket:` tokens to `ticket` (browser sessions), everything else to `oidc`. */
export function combineVerifiers(oidc: TokenVerifier | null, dev: TokenVerifier | null, ticket: TokenVerifier | null = null): TokenVerifier {
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new AuthError('dev tokens are disabled');
      return dev(token);
    }
    if (token.startsWith('ticket:')) {
      if (!ticket) throw new AuthError('browser tickets are not configured');
      return ticket(token);
    }
    if (!oidc) throw new AuthError('OIDC is not configured');
    return oidc(token);
  };
}
