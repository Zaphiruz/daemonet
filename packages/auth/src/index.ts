import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Authentik access-token verification shared by the sim (game socket) and the api (bots' `Authorization: Bearer`),
 * so both enforce exactly the same rules (SP5 spec §3, carry-forward #7).
 */

export interface Claims {
  sub: string;
  groups: string[];
}

export type TokenVerifier = (token: string) => Promise<Claims>;

/**
 * Why a token was refused. The message is for the log only: clients get a generic answer (carry-forward #8).
 * `unavailable` marks identity-provider trouble (discovery, JWKS, userinfo unreachable or broken) rather than a bad token.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

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
  /** Used for discovery, the JWKS and userinfo. */
  fetch?: typeof fetch;
}

const UNAVAILABLE = 'identity provider unavailable';
export const IDP_FETCH_TIMEOUT_MS = 5000;
/** Allowed clock skew between Authentik and us for exp / nbf / iat. */
export const CLOCK_TOLERANCE = '30s';

/**
 * Fetches JSON from the identity provider with a 5 s timeout; every failure is an AuthError. A status in `refusals`
 * (userinfo's 401 / 403: the provider rejected the token) is a plain refusal, anything else is "unavailable".
 */
async function fetchJson(fetchImpl: typeof fetch, input: string | URL, init: RequestInit = {}, refusals: readonly number[] = []): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new AuthError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
  }
  if (refusals.includes(res.status)) throw new AuthError(`identity provider refused the token: status ${res.status}`);
  if (!res.ok) throw new AuthError(`${UNAVAILABLE}: status ${res.status}`, true);
  try {
    return await res.json();
  } catch (err) {
    throw new AuthError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
  }
}

interface Discovery {
  jwks_uri: string;
  userinfo_endpoint: string;
}

async function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const doc = (await fetchJson(fetchImpl, new URL('.well-known/openid-configuration', base))) as Partial<Discovery> | null;
  if (typeof doc?.jwks_uri !== 'string' || typeof doc.userinfo_endpoint !== 'string') throw new AuthError(`${UNAVAILABLE}: bad discovery document`, true);
  return { jwks_uri: doc.jwks_uri, userinfo_endpoint: doc.userinfo_endpoint };
}

/** jose error codes that mean "could not get the key set" rather than "the token is bad". */
const JWKS_FETCH_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID']);

/** A remote key set (5 s timeout, the injected fetch) whose fetch failures surface as "unavailable"; jose retries them. */
function remoteKeys(url: string, fetchImpl: typeof fetch): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(new URL(url), { timeoutDuration: IDP_FETCH_TIMEOUT_MS, [customFetch]: fetchImpl });
  return async (header, token) => {
    try {
      return await remote(header, token);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code !== 'string' || JWKS_FETCH_CODES.has(code)) throw new AuthError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
      throw err;
    }
  };
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies Authentik access tokens (JWT): signature via JWKS (RS256 only), issuer, audience, exp (required, 30 s
 * clock tolerance), a non-empty sub, and the required group from the `groups` claim or, when the token has none,
 * from userinfo. Discovery (and the key set built from it) is single-flight and never caches a failure.
 */
export function createOidcVerifier(opts: OidcOptions): TokenVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let setup: Promise<{ keys: JWTVerifyGetKey; userinfoEndpoint: string }> | null = null;
  const getSetup = () =>
    (setup ??= discover(opts.issuer, fetchImpl).then(
      (d) => ({ keys: opts.jwks ?? remoteKeys(d.jwks_uri, fetchImpl), userinfoEndpoint: d.userinfo_endpoint }),
      (err: unknown) => {
        setup = null; // never cache a failure: the next token retries
        throw err;
      },
    ));

  return async (token) => {
    const keys = opts.jwks ?? (await getSetup()).keys;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: opts.issuer,
        audience: opts.audiences,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
        clockTolerance: CLOCK_TOLERANCE,
      }));
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      let info: { groups?: unknown } | null;
      if (opts.userinfo) {
        try {
          info = await opts.userinfo(token);
        } catch (err) {
          if (err instanceof AuthError) throw err;
          throw new AuthError(`${UNAVAILABLE}: ${(err as Error).message}`, true);
        }
      } else {
        info = (await fetchJson(fetchImpl, (await getSetup()).userinfoEndpoint, { headers: { authorization: `Bearer ${token}` } }, [401, 403])) as {
          groups?: unknown;
        } | null;
      }
      groups = asGroups(info?.groups) ?? [];
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
