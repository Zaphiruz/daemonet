import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/runtime/config.js';

const base = { DATABASE_URL: 'postgresql://x' };

describe('loadConfig', () => {
  it('applies defaults with dev bypass', () => {
    const c = loadConfig({ ...base, AUTH_DEV_BYPASS: 'true' });
    expect(c).toMatchObject({ port: 3000, devBypass: true, oidc: null, requiredGroup: 'daemonet-users', trustProxyHops: 0, maxConnectionsPerIp: 16 });
    expect(c.subnets).toEqual(['lo', 'lan', 'dmz', 'backbone', 'darknet', 'cloudnet', 'kernelspace']);
  });

  it('reads and validates SUBNETS', () => {
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', SUBNETS: ' lan, lo ,' }).subnets).toEqual(['lan', 'lo']);
    for (const bad of ['', ' , ', 'lo,lo', 'lo,nowhere', 'lo,sandbox']) {
      expect(() => loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', SUBNETS: bad })).toThrow();
    }
  });

  it('reads the optional REDIS_URL (unset: in-process bus)', () => {
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true' }).redisUrl).toBeUndefined();
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', REDIS_URL: 'redis://daemonet:pw@127.0.0.1:6379/4' }).redisUrl).toBe('redis://daemonet:pw@127.0.0.1:6379/4');
    expect(() => loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', REDIS_URL: '' })).toThrow();
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
