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

async function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const res = await fetchImpl(new URL('.well-known/openid-configuration', base));
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  return (await res.json()) as Discovery;
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies Authentik access tokens (JWT): signature via JWKS, issuer, audience, expiry.
 * Group membership comes from the `groups` claim, or from userinfo when the token has none.
 */
export function createOidcVerifier(opts: OidcOptions): TokenVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let discovery: Promise<Discovery> | null = null;
  const getDiscovery = () => (discovery ??= discover(opts.issuer, fetchImpl));
  let jwks: JWTVerifyGetKey | null = opts.jwks ?? null;

  return async (token) => {
    if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri));
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audiences }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      const info = opts.userinfo
        ? await opts.userinfo(token)
        : ((await (await fetchImpl((await getDiscovery()).userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })).json()) as { groups?: unknown });
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

/** Dev tokens go to `dev` (when enabled); everything else to `oidc`. */
export function combineVerifiers(oidc: TokenVerifier | null, dev: TokenVerifier | null): TokenVerifier {
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new AuthError('dev tokens are disabled');
      return dev(token);
    }
    if (!oidc) throw new AuthError('OIDC is not configured');
    return oidc(token);
  };
}
