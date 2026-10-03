import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME, buildApp } from '../src/app.js';
import type { OidcClient, OidcIdentity } from '../src/auth/oidc.js';
import { hashToken } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;

/** Fake Authentik: `start` returns a fixed state; `finish` returns whatever identity the test set. */
function fakeOidc(): OidcClient & { identity: OidcIdentity } {
  const client = {
    identity: { sub: 'user-1', groups: ['daemonet-users'] } as OidcIdentity,
    async start() {
      return { url: 'https://authentik.test/authorize?state=st1', state: 'st1', nonce: 'n1', codeVerifier: 'v1' };
    },
    async finish(callbackUrl: URL, expected: { state: string }) {
      if (callbackUrl.searchParams.get('state') !== expected.state) throw new Error('state mismatch');
      return client.identity;
    },
    async endSessionUrl() {
      return 'https://authentik.test/end-session';
    },
  };
  return client;
}

describe('config', () => {
  const base = { DATABASE_URL: 'postgresql://x', SESSION_SECRET: 's'.repeat(32), FRONTEND_ORIGIN: 'https://daemonet.test' };
  it('requires OIDC unless the dev bypass is on, and refuses the bypass in production', () => {
    expect(() => loadConfig(base)).toThrow(/AUTHENTIK/);
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true' }).devBypass).toBe(true);
    expect(() => loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', NODE_ENV: 'production' })).toThrow(/production/);
    const full = loadConfig({ ...base, AUTHENTIK_ISSUER_URL: 'https://a/', AUTHENTIK_CLIENT_ID: 'c', AUTHENTIK_CLIENT_SECRET: 'x', AUTHENTIK_REDIRECT_URI: 'https://d/api/auth/callback' });
    expect(full.oidc?.clientId).toBe('c');
  });
});

describe.skipIf(!url)('API (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  let oidc: ReturnType<typeof fakeOidc>;

  beforeAll(async () => {
    oidc = fakeOidc();
    // Delegates to the current `oidc`, which beforeEach replaces so a test's overrides never leak.
    const delegate: OidcClient = {
      start: () => oidc.start(),
      finish: (u, e) => oidc.finish(u, e),
      endSessionUrl: (t, r) => oidc.endSessionUrl(t, r),
    };
    app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: delegate, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    oidc = fakeOidc();
    await prisma!.$executeRawUnsafe('TRUNCATE "ScriptVersion", "Script", "WsTicket", "Session", "Daemon", "Operator", "SubnetSeed", "AppliedAction" CASCADE');
  });

  /** Runs the full login: /login sets the PKCE cookie, /callback exchanges and sets the session cookie. */
  async function login(identity?: Partial<OidcIdentity>, expectSuccess = true) {
    oidc.identity = { sub: 'user-1', groups: ['daemonet-users'], ...identity };
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(start.statusCode).toBe(302);
    const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
    const cb = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1', cookies: { daemonet_oidc: pkce.value } });
    const cookie = cb.cookies.find((c) => c.name === COOKIE_NAME)?.value;
    if (expectSuccess) {
      expect(cb.statusCode, cb.body).toBe(302);
      expect(cookie).toBeTruthy();
    }
    return { response: cb, cookie };
  }

  it('logs in through OIDC, creates the operator and serves /api/me', async () => {
    const { response, cookie } = await login();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://daemonet.test/');
    expect(cookie).toBeTruthy();
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } });
    expect(me.json()).toMatchObject({ name: null, starterClaimed: false, isAdmin: false, bits: 0 });
    expect(await prisma!.operator.count({ where: { sub: 'user-1' } })).toBe(1);
  });

  it('rejects users outside daemonet-users and flags admins', async () => {
    expect((await login({ groups: ['other'] }, false)).response.statusCode).toBe(403);
    const { cookie } = await login({ sub: 'admin-1', groups: ['daemonet-users', 'daemonet-admins'] });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).json().isAdmin).toBe(true);
  });

  it('rejects a callback whose state does not match the PKCE cookie', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
    const cb = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=wrong', cookies: { daemonet_oidc: pkce.value } });
    expect(cb.statusCode).toBe(400);
  });

  it('requires a session for protected routes and destroys it on logout', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const { cookie } = await login();
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [COOKIE_NAME]: cookie! }, headers: { 'x-requested-with': 'daemonet' } });
    expect(out.json()).toMatchObject({ ok: true, endSessionUrl: 'https://authentik.test/end-session' });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).statusCode).toBe(401);
  });

  it('dev bypass creates a session for sub dev-<name>', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/dev?name=alice' });
    expect(r.statusCode).toBe(302);
    expect(await prisma!.operator.count({ where: { sub: 'dev-alice' } })).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/auth/dev?name=Bad%20Name' })).statusCode).toBe(400);
  });

  it('stores only the SHA-256 of the session token and sets HttpOnly/SameSite=Lax cookies', async () => {
    const { response, cookie } = await login();
    const set = response.cookies.find((c) => c.name === COOKIE_NAME)!;
    expect(set.httpOnly).toBe(true);
    expect(String(set.sameSite).toLowerCase()).toBe('lax');
    const rows = await prisma!.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(cookie!));
    expect(rows[0]!.tokenHash).not.toBe(cookie);
  });

  it('refuses logout without the CSRF header and keeps the session', async () => {
    const { cookie } = await login();
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [COOKIE_NAME]: cookie! } });
    expect(out.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).statusCode).toBe(200);
  });

  it('rejects a tampered or missing PKCE cookie and hides token-exchange details', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
    const tampered = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1', cookies: { daemonet_oidc: pkce.value + 'x' } });
    expect(tampered.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1' })).statusCode).toBe(400);
    oidc.finish = async () => {
      throw new Error('secret idp detail');
    };
    const failed = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1', cookies: { daemonet_oidc: pkce.value } });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain('secret idp detail');
  });

  it('expires sessions server-side', async () => {
    const { cookie } = await login();
    await prisma!.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).statusCode).toBe(401);
    expect(await prisma!.session.count()).toBe(0);
  });
});

describe.skipIf(!url)('API without the dev bypass', () => {
  it('does not register /api/auth/dev', async () => {
    const app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/dev?name=alice' })).statusCode).toBe(404);
    await app.close();
  });
});
