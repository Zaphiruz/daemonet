import { describe, expect, it } from 'vitest';
import { ALLOWED_VAULT_KEYS, filterSecrets } from '../env-filter.mjs';

describe('filterSecrets', () => {
  it('passes exactly the 9 documented keys', () => {
    const doc = Object.fromEntries(ALLOWED_VAULT_KEYS.map((k) => [k, 'v']));
    expect([...ALLOWED_VAULT_KEYS]).toEqual([
      'DATABASE_URL',
      'AUTHENTIK_ISSUER_URL',
      'AUTHENTIK_BOT_CLIENT_ID',
      'AUTH_REQUIRED_GROUP',
      'TRUST_PROXY_HOPS',
      'MAX_CONNECTIONS_PER_IP',
      'SUBNETS',
      'LOG_LEVEL',
      'PORT',
    ]);
    expect(ALLOWED_VAULT_KEYS).toContain('MAX_CONNECTIONS_PER_IP');
    expect(filterSecrets(doc)).toEqual({ applied: doc, ignored: [] });
  });

  it('drops dangerous and unknown keys and reports names only', () => {
    const { applied, ignored } = filterSecrets({
      DATABASE_URL: 'postgresql://x',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      LD_PRELOAD: '/tmp/evil.so',
      AUTH_DEV_BYPASS: 'true',
      NODE_OPTIONS: '--require /tmp/x.js',
      NODE_ENV: 'development',
      SOMETHING_NEW: 'x',
    });
    expect(applied).toEqual({ DATABASE_URL: 'postgresql://x' });
    expect(ignored.sort()).toEqual(
      ['AUTH_DEV_BYPASS', 'LD_PRELOAD', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SOMETHING_NEW'].sort(),
    );
    expect(JSON.stringify(ignored)).not.toContain('evil');
  });

  it('tolerates a missing bag', () => {
    expect(filterSecrets(undefined)).toEqual({ applied: {}, ignored: [] });
  });
});
