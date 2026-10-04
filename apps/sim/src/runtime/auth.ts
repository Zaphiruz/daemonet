import { AuthError, type TokenVerifier } from '@daemonet/auth';

// The verifier itself is shared with the api (bots' bearer tokens): @daemonet/auth.
export { AuthError, createDevVerifier, createOidcVerifier, type Claims, type OidcOptions, type TokenVerifier } from '@daemonet/auth';

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
