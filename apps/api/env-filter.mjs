/**
 * The only environment keys Vault may set: the `secret/daemonet` keys that
 * `apps/api/src/config.ts` reads and that belong in a secret store.
 *
 * An allowlist (not a denylist) so that `AUTH_DEV_BYPASS`, `NODE_ENV`, `NODE_OPTIONS`,
 * `NODE_TLS_REJECT_UNAUTHORIZED`, `LD_PRELOAD`, `PATH` and anything else that could change what code
 * runs or how it verifies TLS can never be injected through the secret store.
 */
export const ALLOWED_VAULT_KEYS = Object.freeze([
  'DATABASE_URL',
  'SESSION_SECRET',
  'SESSION_COOKIE_SECURE',
  'FRONTEND_ORIGIN',
  'AUTHENTIK_WEB_ISSUER_URL',
  'AUTHENTIK_CLIENT_ID',
  'AUTHENTIK_CLIENT_SECRET',
  'AUTHENTIK_REDIRECT_URI',
  'AUTH_REQUIRED_GROUP',
  'AUTH_ADMIN_GROUP',
  'TRUST_PROXY_HOPS',
  'LOG_LEVEL',
  'PORT',
]);

/** Split a Vault secret bag into values that may be applied and the key NAMES (never values) that were dropped. */
export function filterSecrets(secrets) {
  const applied = {};
  const ignored = [];
  for (const [key, value] of Object.entries(secrets ?? {})) {
    if (ALLOWED_VAULT_KEYS.includes(key)) applied[key] = value;
    else ignored.push(key);
  }
  return { applied, ignored };
}
