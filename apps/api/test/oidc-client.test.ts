import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ discovery: vi.fn() }));
vi.mock('openid-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('openid-client')>()), discovery: m.discovery }));

import { createOidcClient, DISCOVERY_TIMEOUT_SECONDS, IDP_TIMEOUT_SECONDS } from '../src/auth/oidc.js';

const opts = { issuer: 'https://authentik.test/application/o/daemonet/', clientId: 'web', clientSecret: 's', redirectUri: 'https://game.test/api/auth/callback' };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => m.discovery.mockReset());

describe('createOidcClient discovery', () => {
  it('gives discovery its own longer budget and resets the inherited timeout for later requests', async () => {
    const config = { timeout: undefined as number | undefined };
    m.discovery.mockResolvedValue(config);
    createOidcClient({ ...opts, warm: true });
    expect(m.discovery).toHaveBeenCalledTimes(1);
    expect(m.discovery.mock.calls[0]![4]).toEqual({ timeout: DISCOVERY_TIMEOUT_SECONDS });
    expect(DISCOVERY_TIMEOUT_SECONDS).toBeGreaterThan(IDP_TIMEOUT_SECONDS);
    await tick();
    expect(config.timeout).toBe(IDP_TIMEOUT_SECONDS);
  });

  it('only discovers on first use without warm', () => {
    m.discovery.mockResolvedValue({});
    createOidcClient(opts);
    expect(m.discovery).not.toHaveBeenCalled();
  });

  it('retries a failed warm-up on the first login instead of caching the failure', async () => {
    m.discovery.mockRejectedValueOnce(new Error('operation timed out'));
    const client = createOidcClient({ ...opts, warm: true });
    await tick();
    expect(m.discovery).toHaveBeenCalledTimes(1);
    m.discovery.mockRejectedValueOnce(new Error('still down'));
    await expect(client.start()).rejects.toThrow('still down');
    expect(m.discovery).toHaveBeenCalledTimes(2);
  });
});
