import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface BearerClaims {
  sub: string;
  groups: string[];
}

export type BearerVerifier = (token: string) => Promise<BearerClaims>;

/**
 * Why a bearer token was refused. The message is for the log only (clients get a generic answer);
 * `unavailable` marks identity-provider trouble (discovery, JWKS, userinfo) rather than a bad token.
 */
export class BearerError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = 'BearerError';
  }
}

export interface BearerOptions {
  /** Issuer of the bot provider, e.g. https://authentik…/application/o/daemonet-bot/ */
  issuer: string;
  /** Accepted audiences (the public `daemonet-bot` client id). */
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

/** Fetches JSON from the identity provider; every failure mode becomes an "unavailable" BearerError. */
async function fetchJson(fetchImpl: typeof fetch, input: string | URL, init: RequestInit = {}): Promise<unknown> {
  try {
    const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new BearerError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
  }
}

async function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const doc = (await fetchJson(fetchImpl, new URL('.well-known/openid-configuration', base))) as Partial<Discovery> | null;
  if (typeof doc?.jwks_uri !== 'string' || typeof doc.userinfo_endpoint !== 'string') throw new BearerError(`${UNAVAILABLE}: bad discovery document`, true);
  return { jwks_uri: doc.jwks_uri, userinfo_endpoint: doc.userinfo_endpoint };
}

/** jose error codes that mean "could not get the key set" rather than "the token is bad". */
const JWKS_FETCH_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID']);

/** A remote key set whose fetch failures surface as "unavailable" (the key set's own retry/cooldown stays jose's). */
function remoteKeys(url: string, fetchImpl: typeof fetch): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(new URL(url), { timeoutDuration: FETCH_TIMEOUT_MS, [customFetch]: fetchImpl });
  return async (header, token) => {
    try {
      return await remote(header, token);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code !== 'string' || JWKS_FETCH_CODES.has(code)) throw new BearerError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
      throw err;
    }
  };
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies the same Authentik access tokens headless bots use on the game socket (SP5 spec §3), mirroring
 * the sim's `createOidcVerifier` (apps/sim/src/runtime/auth.ts): signature via JWKS (RS256 only), issuer,
 * audience, expiry (required), required group (claim or userinfo). Discovery is retried after a failure,
 * every IdP fetch is bounded to 5 s, and every failure is a BearerError.
 */
export function createBearerVerifier(opts: BearerOptions): BearerVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let discovery: Promise<Discovery> | null = null;
  const getDiscovery = () =>
    (discovery ??= discover(opts.issuer, fetchImpl).catch((err: unknown) => {
      discovery = null; // never cache a failure: the next request retries
      throw err;
    }));
  let jwks: JWTVerifyGetKey | null = opts.jwks ?? null;

  return async (token) => {
    if (!jwks) jwks = remoteKeys((await getDiscovery()).jwks_uri, fetchImpl);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audiences, algorithms: ['RS256'], requiredClaims: ['exp'] }));
    } catch (err) {
      if (err instanceof BearerError) throw err;
      throw new BearerError(`invalid token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new BearerError('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      let info: { groups?: unknown } | null;
      if (opts.userinfo) {
        try {
          info = await opts.userinfo(token);
        } catch (err) {
          throw new BearerError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
        }
      } else {
        info = (await fetchJson(fetchImpl, (await getDiscovery()).userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })) as { groups?: unknown } | null;
      }
      groups = asGroups(info?.groups) ?? [];
    }
    if (!groups.includes(opts.requiredGroup)) throw new BearerError(`not in ${opts.requiredGroup}`);
    return { sub: payload.sub, groups };
  };
}

/** Development only: `dev:<name>` is accepted as sub `dev-<name>` (the same rule as the sim's dev verifier). */
export function createDevBearerVerifier(requiredGroup: string): BearerVerifier {
  return async (token) => {
    const m = /^dev:([a-z0-9_-]{1,32})$/.exec(token);
    if (!m) throw new BearerError('invalid dev token');
    return { sub: `dev-${m[1]}`, groups: [requiredGroup] };
  };
}

/** `dev:` tokens go to the dev verifier when it exists; everything else to the OIDC verifier. */
export function combineBearer(oidc: BearerVerifier | null, dev: BearerVerifier | null): BearerVerifier | null {
  if (!oidc && !dev) return null;
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new BearerError('dev tokens are disabled');
      return dev(token);
    }
    if (!oidc) throw new BearerError('bearer tokens are not configured');
    return oidc(token);
  };
}
