import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/runtime/config.js';

const base = { DATABASE_URL: 'postgresql://x' };

describe('loadConfig', () => {
  it('applies defaults with dev bypass', () => {
    const c = loadConfig({ ...base, AUTH_DEV_BYPASS: 'true' });
    expect(c).toMatchObject({ port: 3000, devBypass: true, oidc: null, requiredGroup: 'daemonet-users', trustProxyHops: 0, subnet: 'lo', maxConnectionsPerIp: 16 });
  });

  it('reads and validates MAX_CONNECTIONS_PER_IP', () => {
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', MAX_CONNECTIONS_PER_IP: '128' }).maxConnectionsPerIp).toBe(128);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', MAX_CONNECTIONS_PER_IP: bad })).toThrow();
    }
  });

  it('refuses the dev bypass in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_DEV_BYPASS: 'true' })).toThrow(
      'AUTH_DEV_BYPASS must not be enabled in production',
    );
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUTH_DEV_BYPASS: 'true', AUTHENTIK_ISSUER_URL: 'https://a.example/', AUTHENTIK_BOT_CLIENT_ID: 'c' }),
    ).toThrow('AUTH_DEV_BYPASS');
  });

  it('requires OIDC or the bypass', () => {
    expect(() => loadConfig(base)).toThrow('AUTHENTIK_ISSUER_URL');
    const c = loadConfig({ ...base, NODE_ENV: 'production', AUTHENTIK_ISSUER_URL: 'https://a.example/', AUTHENTIK_BOT_CLIENT_ID: 'c' });
    expect(c.devBypass).toBe(false);
    expect(c.oidc).toEqual({ issuer: 'https://a.example/', clientId: 'c' });
  });
});
