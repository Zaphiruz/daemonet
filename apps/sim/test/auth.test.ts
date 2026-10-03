import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, combineVerifiers, createDevVerifier, createOidcVerifier, type TokenVerifier } from '../src/runtime/auth.js';

const ISSUER = 'https://authentik.test/application/o/daemonet-bot/';
const CLIENT = 'daemonet-bot';
const GROUP = 'daemonet-users';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let verifier: TokenVerifier;
let userinfoGroups: string[] = [];

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
  verifier = createOidcVerifier({
    issuer: ISSUER,
    audiences: [CLIENT],
    requiredGroup: GROUP,
    jwks: createLocalJWKSet({ keys: [jwk] }),
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
    await expect(verifier(await token({ sub: 'u1', groups: [GROUP] }, { exp: '-1m' }))).rejects.toBeInstanceOf(AuthError);
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
