import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { IDP_DISCOVERY_TIMEOUT_MS, IDP_FETCH_TIMEOUT_MS } from '@daemonet/auth';
import { AuthError, combineVerifiers, createDevVerifier, createOidcVerifier, type TokenVerifier } from '../src/runtime/auth.js';

const ISSUER = 'https://authentik.test/application/o/daemonet-bot/';
const CLIENT = 'daemonet-bot';
const GROUP = 'daemonet-users';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let verifier: TokenVerifier;
let userinfoGroups: string[] = [];
let jwks: ReturnType<typeof createLocalJWKSet>;

async function token(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  jwks = createLocalJWKSet({ keys: [jwk] });
  verifier = createOidcVerifier({
    issuer: ISSUER,
    audiences: [CLIENT],
    requiredGroup: GROUP,
    jwks,
    userinfo: async () => ({ groups: userinfoGroups }),
  });
});

describe('createOidcVerifier', () => {
  it('accepts a valid token in the required group', async () => {
    const claims = await verifier(await token({ sub: 'u1', groups: [GROUP] }));
    expect(claims).toEqual({ sub: 'u1', groups: [GROUP] });
  });

  it('rejects the wrong issuer, audience, expired tokens and missing groups', async () => {
    await expect(verifier(await token({ sub: 'u1', groups: [GROUP] }, { issuer: 'https://evil/' }))).rejects.toBeInstanceOf(AuthError);
    await expect(verifier(await token({ sub: 'u1', groups: [GROUP] }, { audience: 'other' }))).rejects.toBeInstanceOf(AuthError);
    await expect(verifier(await token({ sub: 'u1', groups: [GROUP] }, { exp: '-1m' }))).rejects.toThrow(/exp/);
    await expect(verifier(await token({ sub: 'u1', groups: ['someone-else'] }))).rejects.toThrow(/daemonet-users/);
    await expect(verifier('not-a-jwt')).rejects.toBeInstanceOf(AuthError);
  });

  it('falls back to userinfo when the token has no groups claim', async () => {
    userinfoGroups = [GROUP];
    expect((await verifier(await token({ sub: 'u2' }))).sub).toBe('u2');
    userinfoGroups = [];
    await expect(verifier(await token({ sub: 'u2' }))).rejects.toBeInstanceOf(AuthError);
  });
});

describe('createOidcVerifier resilience', () => {
  const discoveryDoc = () => Response.json({ jwks_uri: 'http://127.0.0.1:1/jwks', userinfo_endpoint: 'https://authentik.test/userinfo' });
  const make = (fetchImpl: typeof fetch) =>
    createOidcVerifier({ issuer: ISSUER, audiences: [CLIENT], requiredGroup: GROUP, jwks, fetch: fetchImpl });

  it('retries discovery after a failure instead of caching it', async () => {
    let calls = 0;
    // Counts discovery requests only (the shared verifier fetches the JWKS through the same fetch).
    const fetchImpl = (async (url: string | URL) => {
      if (!String(url).includes('openid-configuration')) throw new TypeError('jwks unreachable');
      calls += 1;
      if (calls === 1) throw new TypeError('network down');
      return discoveryDoc();
    }) as typeof fetch;
    // No injected jwks here, so the first call needs discovery.
    const v = createOidcVerifier({ issuer: ISSUER, audiences: [CLIENT], requiredGroup: GROUP, fetch: fetchImpl });
    await expect(v(await token({ sub: 'u1', groups: [GROUP] }))).rejects.toThrow(/identity provider unavailable/);
    // Second call re-runs discovery (it succeeds; the unreachable JWKS then fails verification, still an AuthError).
    await expect(v(await token({ sub: 'u1', groups: [GROUP] }))).rejects.toBeInstanceOf(AuthError);
    expect(calls).toBe(2);
  });

  it('warms discovery at creation with the longer budget, and retries a failed warm-up on the first token', async () => {
    const seen: { url: string; timeoutMs: number | null }[] = [];
    let fail = true;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes('openid-configuration')) throw new TypeError('jwks unreachable');
      // AbortSignal.timeout(ms) is opaque; the budget is pinned through the exported constant below
      seen.push({ url: String(url), timeoutMs: init?.signal instanceof AbortSignal ? 1 : null });
      if (fail) throw new TypeError('network down');
      return discoveryDoc();
    }) as typeof fetch;
    const v = createOidcVerifier({ issuer: ISSUER, audiences: [CLIENT], requiredGroup: GROUP, fetch: fetchImpl, warm: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${ISSUER}.well-known/openid-configuration`);
    expect(seen[0]!.timeoutMs).toBe(1);
    expect(IDP_DISCOVERY_TIMEOUT_MS).toBeGreaterThan(IDP_FETCH_TIMEOUT_MS);
    fail = false;
    // the warm-up failed and was not cached: the first token re-runs discovery (then the unreachable JWKS fails it)
    await expect(v(await token({ sub: 'u1', groups: [GROUP] }))).rejects.toBeInstanceOf(AuthError);
    expect(seen).toHaveLength(2);
  });

  it('does not touch the network at creation without warm', async () => {
    let calls = 0;
    createOidcVerifier({ issuer: ISSUER, audiences: [CLIENT], requiredGroup: GROUP, fetch: (async () => { calls += 1; return discoveryDoc(); }) as typeof fetch });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(0);
  });

  it('maps a userinfo 500 and a non-JSON userinfo body to AuthError', async () => {
    const v500 = make((async (url: string | URL) => (String(url).includes('openid-configuration') ? discoveryDoc() : new Response('boom', { status: 500 }))) as typeof fetch);
    await expect(v500(await token({ sub: 'u2' }))).rejects.toThrow(/identity provider unavailable/);
    const vText = make((async (url: string | URL) => (String(url).includes('openid-configuration') ? discoveryDoc() : new Response('<html>', { status: 200 }))) as typeof fetch);
    await expect(vText(await token({ sub: 'u2' }))).rejects.toBeInstanceOf(AuthError);
  });

  it('requires exp (shared @daemonet/auth rule) and allows 30 s of clock skew', async () => {
    const noExp = await new SignJWT({ sub: 'u1', groups: [GROUP] }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(CLIENT).sign(privateKey);
    await expect(verifier(noExp)).rejects.toThrow(/exp/);
    expect((await verifier(await token({ sub: 'u1', groups: [GROUP] }, { exp: '-10s' }))).sub).toBe('u1');
  });

  it('rejects a token with no sub', async () => {
    await expect(verifier(await token({ groups: [GROUP] }))).rejects.toThrow(/no sub/);
  });
});

describe('dev tokens', () => {
  it('are accepted only when the dev verifier is enabled', async () => {
    const on = combineVerifiers(null, createDevVerifier(GROUP));
    expect(await on('dev:alice')).toEqual({ sub: 'dev-alice', groups: [GROUP] });
    await expect(on('dev:Bad Name')).rejects.toBeInstanceOf(AuthError);
    await expect(on('eyJ.real.jwt')).rejects.toThrow(/OIDC is not configured/);
    const off = combineVerifiers(verifier, null);
    await expect(off('dev:alice')).rejects.toThrow(/disabled/);
  });
});
