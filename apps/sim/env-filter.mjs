/**
 * The only environment keys Vault may set: exactly the 10-key `secret/daemonet` document that
 * `scripts/provision-secrets.sh` writes and `apps/sim/src/runtime/config.ts` reads.
 *
 * An allowlist (not a denylist) so that `AUTH_DEV_BYPASS`, `NODE_ENV`, `NODE_OPTIONS`,
 * `NODE_TLS_REJECT_UNAUTHORIZED`, `LD_PRELOAD`, `PATH` and anything else that could change what code
 * runs or how it verifies TLS can never be injected through the secret store.
 */
export const ALLOWED_VAULT_KEYS = Object.freeze([
  'DATABASE_URL',
  'AUTHENTIK_ISSUER_URL',
  'AUTHENTIK_BOT_CLIENT_ID',
  'AUTH_REQUIRED_GROUP',
  'TRUST_PROXY_HOPS',
  'MAX_CONNECTIONS_PER_IP',
  'SUBNETS',
  'LOG_LEVEL',
  'PORT',
  'REDIS_URL',
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
