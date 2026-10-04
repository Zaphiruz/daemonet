import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME, buildApp } from '../src/app.js';
import type { OidcClient, OidcIdentity } from '../src/auth/oidc.js';
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { hashToken } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { ensureOperator } from '../src/auth/routes.js';
import { loggerOptions } from '../src/log.js';
import { KEPT_VERSIONS, MAX_SCRIPT_BYTES } from '../src/routes/scripts.js';

const csrf = { [CSRF_HEADER]: CSRF_VALUE };

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
    const full = loadConfig({ ...base, AUTHENTIK_WEB_ISSUER_URL: 'https://a/', AUTHENTIK_CLIENT_ID: 'c', AUTHENTIK_CLIENT_SECRET: 'x', AUTHENTIK_REDIRECT_URI: 'https://d/api/auth/callback' });
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
    await prisma!.$executeRawUnsafe('TRUNCATE "ScriptVersion", "Script", "WsTicket", "Session", "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
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

  it('saves scripts with versions, keeps the last 16, and enforces the CSRF header and size limit', async () => {
    const { cookie } = await login();
    const cookies = { [COOKIE_NAME]: cookie! };
    expect((await app.inject({ method: 'GET', url: '/api/scripts/main', cookies })).json()).toEqual({ source: '', version: 0, updatedAt: null });
    expect((await app.inject({ method: 'PUT', url: '/api/scripts/main', cookies, payload: { source: 'x' } })).statusCode).toBe(403);
    for (let i = 1; i <= 20; i++) {
      const r = await app.inject({ method: 'PUT', url: '/api/scripts/main', cookies, headers: csrf, payload: { source: `// v${i}` } });
      expect(r.json().version).toBe(i);
    }
    expect((await app.inject({ method: 'GET', url: '/api/scripts/main', cookies })).json()).toMatchObject({ source: '// v20', version: 20 });
    const versions = (await app.inject({ method: 'GET', url: '/api/scripts/main/versions', cookies })).json() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual(Array.from({ length: KEPT_VERSIONS }, (_, i) => 20 - i));
    expect((await app.inject({ method: 'GET', url: '/api/scripts/main/versions/7', cookies })).json().source).toBe('// v7');
    expect((await app.inject({ method: 'GET', url: '/api/scripts/main/versions/2', cookies })).statusCode).toBe(404);
    const big = await app.inject({ method: 'PUT', url: '/api/scripts/main', cookies, headers: csrf, payload: { source: 'a'.repeat(MAX_SCRIPT_BYTES + 1) } });
    expect(big.statusCode).toBe(400);
  });

  it('handles concurrent script saves without a 500 and validates the version parameter', async () => {
    const { cookie } = await login();
    const cookies = { [COOKIE_NAME]: cookie! };
    const put = (source: string) => app.inject({ method: 'PUT', url: '/api/scripts/main', cookies, headers: csrf, payload: { source } });
    for (const round of ['first', 'second']) {
      const rs = await Promise.all([put(`${round}-a`), put(`${round}-b`), put(`${round}-c`)]);
      expect(rs.map((r) => r.statusCode).filter((c) => c >= 500)).toEqual([]);
      const ok = rs.filter((r) => r.statusCode === 200).map((r) => r.json().version as number);
      expect(new Set(ok).size).toBe(ok.length);
      expect(ok.length).toBeGreaterThan(0);
    }
    const saved = (await app.inject({ method: 'GET', url: '/api/scripts/main', cookies })).json();
    expect(await prisma!.scriptVersion.count({ where: { version: saved.version } })).toBe(1);
    for (const bad of ['0x10', '1e1', '99999999999', '0', '-1', '1.5']) {
      expect((await app.inject({ method: 'GET', url: `/api/scripts/main/versions/${bad}`, cookies })).statusCode, bad).toBe(400);
    }
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

  it('mints single-use websocket tickets and lists Disk daemons and the codex', async () => {
    const { cookie } = await login();
    const cookies = { [COOKIE_NAME]: cookie! };
    const t = await app.inject({ method: 'POST', url: '/api/ws/ticket', cookies, headers: csrf });
    expect(t.json().ticket).toMatch(/^ticket:[A-Za-z0-9_-]{40,}$/);
    expect(await prisma!.wsTicket.count()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/disk', cookies })).json()).toEqual([]);
    const codex = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(codex.types).toHaveLength(16);
    expect(codex.species).toHaveLength(256);
    expect(codex.chart.glitch.null).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).json()).toEqual({ ok: true });
  });

  it('serves the capture rules for all 16 families in type order', async () => {
    const { cookie } = await login();
    const codex = (await app.inject({ method: 'GET', url: '/api/codex', cookies: { [COOKIE_NAME]: cookie! } })).json();
    expect(codex.challenges.map((c: { type: string }) => c.type)).toEqual(codex.types);
    expect(codex.challenges).toHaveLength(16);
    for (const c of codex.challenges) {
      expect(c.rules.length).toBeGreaterThan(20);
      expect(c.rules).not.toMatch(/github|\{@link/i);
    }
    expect(codex.challenges.find((c: { type: string }) => c.type === 'cache').rules).toContain('LRU');
  });

  it('hides undiscovered hidden requirements in the codex and lists discoveries with the discoverer', async () => {
    const { cookie } = await login();
    const cookies = { [COOKIE_NAME]: cookie! };
    const before = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    const hidden = before.bestiary.find((r: { id: string }) => r.id === 'anycastrel');
    expect(hidden).toMatchObject({ hidden: true, requirement: null });
    expect(before.species.find((r: { id: string }) => r.id === 'anycastrel').requirement).toBeNull();
    expect(before.bestiary.find((r: { id: string }) => r.id === 'broadcaw').requirement).toEqual([{ kind: 'heldItem', item: 'jumboframe' }]);
    expect(before.discovered).toEqual([]);
    const op = await prisma!.operator.findFirstOrThrow();
    await prisma!.operator.update({ where: { id: op.id }, data: { name: 'alice' } });
    await prisma!.discovery.create({ data: { formId: 'anycastrel', operatorId: op.id } });
    const after = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(after.bestiary.find((r: { id: string }) => r.id === 'anycastrel').requirement).toEqual([{ kind: 'dominantIV', stat: 'speed' }]);
    expect(after.discovered).toEqual(['anycastrel']);
    expect(after.discoveries).toMatchObject([{ formId: 'anycastrel', operatorName: 'alice' }]);
  });

  it('dev route seeds a daemon on Disk for the session operator', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=eve' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    expect((await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, payload: { species: 'pingling', level: 8 } })).statusCode).toBe(403);
    const seeded = await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'pingling', level: 8 } });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json()).toMatchObject({ species: 'pingling', level: 8, slot: 0 });
    const disk = (await app.inject({ method: 'GET', url: '/api/disk', cookies })).json();
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({ species: 'pingling', level: 8, slot: 0, heldItem: null, patched: false, crashes: 0 });
    expect(disk[0].history[0]).toMatchObject({ kind: 'captured', detail: 'dev seed' });
    const bad = await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'nope', level: 8 } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'pingling', level: 0 } })).statusCode).toBe(400);
  });

  it('expires sessions server-side', async () => {
    const { cookie } = await login();
    await prisma!.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).statusCode).toBe(401);
    expect(await prisma!.session.count()).toBe(0);
  });
});

describe.skipIf(!url)('API session lifetime and admin rights', () => {
  it('rejects and deletes a session older than 30 days even if its sliding expiry is fresh, and reads isAdmin from the operator', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Session", "Operator" CASCADE');
    const oidc = fakeOidc();
    const app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: oidc, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
    });
    app.get('/api/test/admin', { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({ ok: true }));
    await app.ready();
    const login = async () => {
      const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
      const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
      const cb = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1', cookies: { daemonet_oidc: pkce.value } });
      return { [COOKIE_NAME]: cb.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    };

    oidc.identity = { sub: 'boss', groups: ['daemonet-users', 'daemonet-admins'] };
    const admin = await login();
    expect((await app.inject({ method: 'GET', url: '/api/test/admin', cookies: admin })).statusCode).toBe(200);
    await prisma!.operator.update({ where: { sub: 'boss' }, data: { isAdmin: false } });
    expect((await app.inject({ method: 'GET', url: '/api/test/admin', cookies: admin })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: admin })).json().isAdmin).toBe(false);

    oidc.identity = { sub: 'old', groups: ['daemonet-users'] };
    const old = await login();
    await prisma!.session.updateMany({
      where: { operator: { sub: 'old' } },
      data: { createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
    });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: old })).statusCode).toBe(401);
    expect(await prisma!.session.count({ where: { operator: { sub: 'old' } } })).toBe(0);
    await app.close();
  });
});

describe.skipIf(!url)('API error handling and operator creation', () => {
  it('maps non-AppError client errors to bad_request/payload_too_large and logs the stack of real 500s', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
      logger: { ...loggerOptions('info'), stream: { write: (l: string) => void lines.push(l) } },
    });
    app.post('/api/test/echo', async (req) => req.body);
    app.get('/api/test/boom', async () => {
      throw new Error('kaboom');
    });
    await app.ready();
    const bad = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');
    const big = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('payload_too_large');
    const boom = await app.inject({ method: 'GET', url: '/api/test/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'internal_error', message: 'internal error' });
    await app.close();
    const logged = lines.map((l) => JSON.parse(l) as { msg?: string; err?: { stack?: string } });
    const entry = logged.find((l) => l.msg === 'unhandled error');
    expect(entry?.err?.stack).toContain('kaboom');
  });

  it('ensureOperator retries once when a simultaneous first login hits the sub unique constraint', async () => {
    let calls = 0;
    const fake = {
      operator: {
        async upsert() {
          calls++;
          if (calls === 1) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['sub'] } });
          return { id: 'op-1' };
        },
      },
    };
    expect(await ensureOperator(fake as never, 'sub-x', false)).toEqual({ id: 'op-1' });
    expect(calls).toBe(2);
    const other = { operator: { upsert: async () => Promise.reject(Object.assign(new Error('x'), { code: 'P2002', meta: { target: ['name'] } })) } };
    await expect(ensureOperator(other as never, 'sub-y', false)).rejects.toThrow();
  });
});

describe.skipIf(!url)('API logging', () => {
  it('never logs the OIDC callback query string', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Session", "Operator" CASCADE');
    const lines: string[] = [];
    const stream = { write: (l: string) => void lines.push(l) };
    const app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
      logger: { ...loggerOptions('info'), stream },
    });
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
    const cb = await app.inject({ method: 'GET', url: '/api/auth/callback?code=SECRETCODE123&state=st1', cookies: { daemonet_oidc: pkce.value } });
    expect(cb.statusCode).toBe(302);
    await app.close();
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('');
    expect(all).toContain('/api/auth/callback');
    expect(all).not.toContain('code=');
    expect(all).not.toContain('SECRETCODE123');
  });
});

describe.skipIf(!url)('API without the dev bypass', () => {
  it('does not register /api/auth/dev', async () => {
    const app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/dev?name=alice' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/dev/daemon', headers: csrf, payload: { species: 'pingling', level: 8 } })).statusCode).toBe(404);
    await app.close();
  });
});
