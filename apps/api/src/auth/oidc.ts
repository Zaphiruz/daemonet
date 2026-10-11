import * as oidc from 'openid-client';

export interface AuthorizationStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  sub: string;
  groups: string[];
  preferredUsername?: string;
  idToken?: string;
}

/** Small seam over openid-client so routes can be tested with a fake provider. */
export interface OidcClient {
  start(): Promise<AuthorizationStart>;
  /** `callbackUrl` is the full URL Authentik redirected to (code + state in the query). */
  finish(callbackUrl: URL, expected: { state: string; nonce: string; codeVerifier: string }): Promise<OidcIdentity>;
  endSessionUrl(idToken: string | undefined, postLogoutRedirectUri: string): Promise<string | null>;
}

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
  /** Start discovery now rather than on the first login, so the first player does not wait for it; a failure is retried then. */
  warm?: boolean;
}

/** Token and userinfo requests are bounded to 5 s. */
export const IDP_TIMEOUT_SECONDS = 5;
/** Discovery gets more: Authentik takes ~2 s to serve its document, and it is fetched once, then cached. */
export const DISCOVERY_TIMEOUT_SECONDS = 15;

const asGroups = (v: unknown): string[] => (Array.isArray(v) && v.every((g) => typeof g === 'string') ? v : []);

/**
 * Discovery is deferred and retried (a rejected promise is never cached), so the API boots even if
 * Authentik is briefly unreachable. The ID token is verified by openid-client (signature against the
 * IdP's JWKS with the default RS256 expectation, iss/aud/exp, nonce and state).
 */
export function createOidcClient(opts: OidcClientOptions): OidcClient {
  const scope = opts.scope ?? 'openid profile email groups';
  let configPromise: Promise<oidc.Configuration> | null = null;
  const config = (): Promise<oidc.Configuration> => {
    if (!configPromise) {
      // the discovery timeout is also inherited by every later request: reset it once the document is in
      const p = oidc.discovery(new URL(opts.issuer), opts.clientId, opts.clientSecret, undefined, { timeout: DISCOVERY_TIMEOUT_SECONDS }).then((c) => {
        c.timeout = IDP_TIMEOUT_SECONDS;
        return c;
      });
      configPromise = p;
      p.catch(() => {
        if (configPromise === p) configPromise = null;
      });
    }
    return configPromise;
  };
  if (opts.warm) void config().catch(() => {});

  return {
    async start() {
      const c = await config();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(c, {
        redirect_uri: opts.redirectUri,
        scope,
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      });
      return { url: url.href, state, nonce, codeVerifier };
    },
    async finish(callbackUrl, expected) {
      const c = await config();
      const tokens = await oidc.authorizationCodeGrant(c, callbackUrl, {
        pkceCodeVerifier: expected.codeVerifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('id token has no sub');
      const info = await oidc.fetchUserInfo(c, tokens.access_token, claims.sub);
      const username = typeof info.preferred_username === 'string' ? info.preferred_username : undefined;
      return {
        sub: claims.sub,
        groups: asGroups(info.groups ?? claims.groups),
        ...(username ? { preferredUsername: username } : {}),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      };
    },
    async endSessionUrl(idToken, postLogoutRedirectUri) {
      try {
        const c = await config();
        return oidc.buildEndSessionUrl(c, { post_logout_redirect_uri: postLogoutRedirectUri, ...(idToken ? { id_token_hint: idToken } : {}) }).href;
      } catch {
        // Logout must still succeed locally when the IdP is unreachable or has no end-session endpoint.
        return null;
      }
    },
  };
}
