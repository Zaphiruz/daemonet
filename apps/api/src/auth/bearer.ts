import { AuthError, createDevVerifier, createOidcVerifier, type Claims, type OidcOptions, type TokenVerifier } from '@daemonet/auth';

/**
 * Bots' `Authorization: Bearer` tokens (SP5 spec §3): the same Authentik access tokens they use on the game socket,
 * verified by the verifier the sim uses (@daemonet/auth) — JWKS RS256 only, issuer, audience, exp, required group.
 */
export type BearerClaims = Claims;
export type BearerVerifier = TokenVerifier;
export type BearerOptions = OidcOptions;
/** A refused token; `unavailable` = the identity provider could not be reached (answered 503, not 401). */
export const BearerError = AuthError;
export type BearerError = AuthError;

export const createBearerVerifier: (opts: BearerOptions) => BearerVerifier = createOidcVerifier;
/** Development only: `dev:<name>` is accepted as sub `dev-<name>` (the same rule as the sim's dev verifier). */
export const createDevBearerVerifier: (requiredGroup: string) => BearerVerifier = createDevVerifier;

/** `dev:` tokens go to the dev verifier when it exists; everything else to the OIDC verifier. */
export function combineBearer(oidc: BearerVerifier | null, dev: BearerVerifier | null): BearerVerifier | null {
  if (!oidc && !dev) return null;
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new AuthError('dev tokens are disabled');
      return dev(token);
    }
    if (!oidc) throw new AuthError('bearer tokens are not configured');
    return oidc(token);
  };
}
