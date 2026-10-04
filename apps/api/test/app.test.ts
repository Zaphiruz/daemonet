import { MemoryBus, type Bus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { EVOLUTION_RULES } from '@daemonet/rules/evolution';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME, buildApp } from '../src/app.js';
import type { OidcClient, OidcIdentity } from '../src/auth/oidc.js';
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { hashToken } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { ensureOperator } from '../src/auth/routes.js';
import { loggerOptions } from '../src/log.js';
import { pruneChat } from '../src/routes/chat.js';
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
    expect(full.redisUrl).toBeUndefined();
    expect(loadConfig({ ...base, AUTH_DEV_BYPASS: 'true', REDIS_URL: 'redis://127.0.0.1:6379/4' }).redisUrl).toBe('redis://127.0.0.1:6379/4');
  });
});

describe.skipIf(!url)('API (needs DATABASE_URL)', () => {
  let app: FastifyInstance;
  let oidc: ReturnType<typeof fakeOidc>;
  const bus = new MemoryBus();

  beforeAll(async () => {
    oidc = fakeOidc();
    // Delegates to the current `oidc`, which beforeEach replaces so a test's overrides never leak.
    const delegate: OidcClient = {
      start: () => oidc.start(),
      finish: (u, e) => oidc.finish(u, e),
      endSessionUrl: (t, r) => oidc.endSessionUrl(t, r),
    };
    app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
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
    bus.log.length = 0;
    await prisma!.$executeRawUnsafe('TRUNCATE "ScriptVersion", "Script", "WsTicket", "Session", "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery", "DaemonArchive", "BitsLedger", "Ticket", "Research", "ChatMessage", "ChatBlock", "ChatFilterTerm", "ChatFilterHit", "Report", "Org", "OrgMember", "OrgInvite" CASCADE');
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
    expect(before.species.find((r: { id: string }) => r.id === 'anycastrel')).not.toHaveProperty('requirement');
    const raw = JSON.stringify(before);
    for (const rule of Object.values(EVOLUTION_RULES).filter((r) => r.hidden)) expect(raw).not.toContain(JSON.stringify(rule.requirement));
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

  it('codex carries the caller’s research and hints (kind only) at 256 points, for that operator alone', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ida' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const other = await app.inject({ method: 'GET', url: '/api/auth/dev?name=bob' });
    const otherCookies = { [COOKIE_NAME]: other.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ida' } });
    await prisma!.research.create({ data: { operatorId: op.id, line: 5, points: 255 } });
    const below = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(below.research).toEqual({ '5': 255 });
    expect(below.hints).toEqual([]);
    await prisma!.research.update({ where: { operatorId_line: { operatorId: op.id, line: 5 } }, data: { points: 256 } });
    const codex = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(codex.research).toEqual({ '5': 256 });
    expect((await app.inject({ method: 'GET', url: '/api/codex', cookies })).headers['cache-control']).toBe('private, no-store');
    expect(codex.hints).toContainEqual({ formId: 'anycastrel', kind: 'dominantIV' });
    for (const h of codex.hints) {
      expect(Object.keys(h).sort()).toEqual(['formId', 'kind']);
      expect(codex.bestiary.find((r: { id: string }) => r.id === h.formId)).toMatchObject({ line: 5, hidden: true, requirement: null });
    }
    // a hint reveals the kind only: never the stat/value of the hidden requirement
    expect(JSON.stringify(codex)).not.toContain(JSON.stringify(EVOLUTION_RULES['anycastrel']!.requirement));
    // another operator with no research, and a request without a session, learn nothing
    const bob = (await app.inject({ method: 'GET', url: '/api/codex', cookies: otherCookies })).json();
    expect(bob.research).toEqual({});
    expect(bob.hints).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/codex' })).statusCode).toBe(401);
    // a discovered form needs no hint
    await prisma!.discovery.create({ data: { formId: 'anycastrel', operatorId: op.id } });
    expect((await app.inject({ method: 'GET', url: '/api/codex', cookies })).json().hints.find((h: { formId: string }) => h.formId === 'anycastrel')).toBeUndefined();
  });

  it('serves today’s ticket board with the caller’s status and the caller’s history only', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ida' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const other = await app.inject({ method: 'GET', url: '/api/auth/dev?name=bob' });
    const otherCookies = { [COOKIE_NAME]: other.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ida' } });
    const board = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies })).json();
    expect(board.tickets).toHaveLength(8);
    expect(board.tickets[0]).toMatchObject({ index: 0, kind: 'clear', status: null });
    await prisma!.ticket.create({ data: { id: 't1', operatorId: op.id, day: board.day, subnet: 'lo', index: 0, kind: 'clear', params: board.tickets[0].params, target: 4, reward: 64, progress: 1 } });
    const again = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies })).json();
    expect(again.tickets[0].status).toBe('OPEN');
    expect(again.acceptedToday).toBe(1);
    const theirs = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies: otherCookies })).json();
    expect(theirs.tickets[0].status).toBeNull();
    expect(theirs.acceptedToday).toBe(0);
    const hist = await app.inject({ method: 'GET', url: '/api/tickets', cookies });
    expect(hist.json()).toMatchObject([{ id: 't1', status: 'OPEN', progress: 1 }]);
    expect(hist.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies })).headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ method: 'GET', url: '/api/tickets', cookies: otherCookies })).json()).toEqual([]);
    const unknown = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=nope', cookies })).json();
    expect(unknown.tickets).toEqual([]);
    expect(unknown.acceptedToday).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/tickets' })).statusCode).toBe(401);
  });

  it('serves the shop, recipes and the caller’s ledger; the admin economy view sums the ledger', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=fay&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const shop = (await app.inject({ method: 'GET', url: '/api/shop', cookies })).json();
    expect(shop.prices.sniff).toBe(32);
    expect(shop).toMatchObject({ diskCapacity: 256, diskExpansionPrice: 8192, bits: 0 });
    const recipes = (await app.inject({ method: 'GET', url: '/api/recipes', cookies })).json();
    expect(recipes).toHaveLength(25);
    expect(recipes.find((r: { id: string }) => r.id === 'tap')).toMatchObject({ bits: 64, fragments: { packet: 4, socket: 4 }, output: { item: 'tap', qty: 1 } });
    const granted = await app.inject({ method: 'POST', url: '/api/dev/bits', cookies, headers: csrf, payload: { amount: 500 } });
    expect(granted.json()).toMatchObject({ bits: 500 });
    expect(granted.json().note).toMatch(/^[\x20-\x7e]+$/); // plain ASCII
    const ledger = (await app.inject({ method: 'GET', url: '/api/ledger', cookies })).json();
    expect(ledger).toMatchObject([{ delta: 500, reason: 'admin', ref: 'dev' }]);
    const economy = (await app.inject({ method: 'GET', url: '/api/admin/economy', cookies })).json();
    expect(economy).toMatchObject({ supply: 500, operators: 1 });
    expect(economy.days[0]).toMatchObject({ created: 500, destroyed: 0, byReason: { admin: 500 } });
    const plain = await app.inject({ method: 'GET', url: '/api/auth/dev?name=gus' });
    const plainCookies = { [COOKIE_NAME]: plain.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    expect((await app.inject({ method: 'GET', url: '/api/admin/economy', cookies: plainCookies })).statusCode).toBe(403);
  });

  it('the admin economy view reports the ledger sum and zero drift after mixed activity, with days grouped in the database', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=kim&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    await app.inject({ method: 'GET', url: '/api/auth/dev?name=lou' });
    const kim = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-kim' } });
    const lou = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-lou' } });
    // Balance change and ledger row together, as the sim and the dev route write them.
    const move = (operatorId: string, delta: number, reason: string, at?: Date) =>
      prisma!.$transaction([
        prisma!.operator.update({ where: { id: operatorId }, data: { bits: { increment: BigInt(delta) } } }),
        prisma!.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason, ...(at ? { at } : {}) } }),
      ]);
    // Every row inside the window is pinned to yesterday 12:00 UTC (no flake when the run straddles midnight).
    const yesterday = new Date(Date.now() - 86_400_000);
    yesterday.setUTCHours(12, 0, 0, 0);
    await move(kim.id, 4000, 'admin', new Date(Date.now() - 40 * 86_400_000)); // outside the 14-day window
    await app.inject({ method: 'POST', url: '/api/dev/bits', cookies, headers: csrf, payload: { amount: 1000 } });
    await prisma!.bitsLedger.updateMany({ where: { operatorId: kim.id, ref: 'dev' }, data: { at: yesterday } });
    await move(kim.id, -128, 'shop', yesterday);
    await move(kim.id, -64, 'craft', yesterday);
    await move(lou.id, 300, 'ticket', yesterday);
    await move(lou.id, 9000, 'admin', yesterday);
    await move(lou.id, -8192, 'disk', yesterday);
    const supply = 4000 + 1000 - 128 - 64 + 300 + 9000 - 8192;
    const economy = (await app.inject({ method: 'GET', url: '/api/admin/economy', cookies })).json();
    expect(economy).toMatchObject({ operators: 2, supply, ledgerSum: supply, drift: 0 });
    // days inside the window only (the 40-day-old grant is in the sum, not in the days)
    expect(economy.days).toEqual([
      { day: yesterday.toISOString().slice(0, 10), created: 10_300, destroyed: 8384, byReason: { admin: 10_000, ticket: 300, shop: -128, craft: -64, disk: -8192 } },
    ]);
    // drift shows a balance change without a ledger row
    await prisma!.operator.update({ where: { id: lou.id }, data: { bits: { increment: 5n } } });
    expect((await app.inject({ method: 'GET', url: '/api/admin/economy', cookies })).json()).toMatchObject({ drift: 5 });
  });

  it('lists the ledger newest first by sequence, capped at 64, and reads admin rights from the operator row', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=hal&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-hal' } });
    const at = new Date('2026-01-01T00:00:00Z');
    // Same timestamp for every row: only `seq` can order them.
    await prisma!.bitsLedger.createMany({ data: Array.from({ length: 70 }, (_, i) => ({ operatorId: op.id, delta: BigInt(i + 1), reason: 'admin', ref: `r${i}`, at })) });
    const ledger = (await app.inject({ method: 'GET', url: '/api/ledger', cookies })).json();
    expect(ledger).toHaveLength(64);
    expect(ledger[0].ref).toBe('r69');
    expect(ledger[63].ref).toBe('r6');
    await prisma!.operator.update({ where: { id: op.id }, data: { isAdmin: false } });
    expect((await app.inject({ method: 'GET', url: '/api/admin/economy', cookies })).statusCode).toBe(403);
  });

  it('dev bits validates its body, needs CSRF, refuses overdraw-shaped input and keeps balance equal to the ledger sum', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ivy' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    expect((await app.inject({ method: 'POST', url: '/api/dev/bits', cookies, payload: { amount: 5 } })).statusCode).toBe(403);
    for (const amount of [0, -5, 1.5, 1_000_001, '5']) {
      expect((await app.inject({ method: 'POST', url: '/api/dev/bits', cookies, headers: csrf, payload: { amount } })).statusCode).toBe(400);
    }
    const results = await Promise.all([3, 4, 5].map((amount) => app.inject({ method: 'POST', url: '/api/dev/bits', cookies, headers: csrf, payload: { amount } })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ivy' } });
    const sum = await prisma!.bitsLedger.aggregate({ where: { operatorId: op.id }, _sum: { delta: true } });
    expect(op.bits).toBe(12n);
    expect(sum._sum.delta).toBe(12n);
  });

  it('serves chat history per channel, blocks, reports with a daily cap, and admin moderation through the bus', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ann' });
    const b = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ben&admin=true' });
    const ca = { [COOKIE_NAME]: a.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const cb = { [COOKIE_NAME]: b.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const ann = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ann' } });
    const ben = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ben' } });
    await prisma!.chatMessage.createMany({
      data: [
        { id: 'm1', channel: 'subnet:lo', operatorId: ann.id, text: 'one', at: new Date('2026-09-30T00:00:01Z') },
        { id: 'm2', channel: 'subnet:lo', operatorId: ben.id, text: 'two', at: new Date('2026-09-30T00:00:02Z') },
        { id: 'm3', channel: `dm:${ben.id}`, operatorId: ann.id, toId: ben.id, text: 'psst', at: new Date('2026-09-30T00:00:03Z') },
        { id: 'm4', channel: `dm:${ann.id}`, operatorId: ben.id, toId: ann.id, text: 'yes?', at: new Date('2026-09-30T00:00:04Z') },
        { id: 'old', channel: 'subnet:lo', operatorId: ann.id, text: 'ancient', at: new Date('2026-09-01T00:00:00Z') },
      ],
    });
    const history = (await app.inject({ method: 'GET', url: '/api/chat/subnet:lo', cookies: ca })).json();
    expect(history.map((m: { id: string }) => m.id)).toEqual(['old', 'm1', 'm2']);
    expect(history[1]).toMatchObject({ from: ann.id, name: null, text: 'one' });
    const before = (await app.inject({ method: 'GET', url: '/api/chat/subnet:lo?before=2026-09-30T00:00:02Z&limit=1', cookies: ca })).json();
    expect(before.map((m: { id: string }) => m.id)).toEqual(['m1']);
    const dm = (await app.inject({ method: 'GET', url: `/api/chat/dm:${ben.id}`, cookies: ca })).json();
    expect(dm.map((m: { id: string }) => m.id)).toEqual(['m3', 'm4']);
    expect((await app.inject({ method: 'GET', url: '/api/chat/org:x', cookies: ca })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/chat/bogus', cookies: ca })).statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/api/chat/block', cookies: ca, headers: csrf, payload: { operatorId: ben.id } })).json()).toEqual({ ok: true });
    expect(await prisma!.chatBlock.count()).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/chat/block', cookies: ca, headers: csrf, payload: { operatorId: ben.id } })).json()).toEqual({ ok: true });
    expect(await prisma!.chatBlock.count()).toBe(0);

    const report = await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, messageId: 'm2', reason: 'SPAM', note: 'ads' } });
    expect(report.json()).toMatchObject({ ok: true, id: expect.any(String) });
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, messageId: 'm2', reason: 'SPAM' } })).json()).toMatchObject({ duplicate: true });
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, messageId: 'm1', reason: 'SPAM' } })).statusCode).toBe(400);
    for (let i = 0; i < 7; i++) await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, reason: 'OTHER', note: `r${i}` } });
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, reason: 'OTHER' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/admin/reports', cookies: ca })).statusCode).toBe(403);
    const queue = (await app.inject({ method: 'GET', url: '/api/admin/reports', cookies: cb })).json();
    expect(queue).toHaveLength(8);
    expect(queue[0]).toMatchObject({ reason: 'SPAM', targetName: null, message: { id: 'm2', text: 'two' } });
    const resolved = await app.inject({ method: 'POST', url: `/api/admin/reports/${queue[0].id}/resolve`, cookies: cb, headers: csrf, payload: { action: 'DELETE' } });
    expect(resolved.json()).toEqual({ ok: true });
    expect((await prisma!.chatMessage.findUniqueOrThrow({ where: { id: 'm2' } })).deletedAt).not.toBeNull();
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'delete', id: 'm2', channel: 'subnet:lo' } });
    expect((await app.inject({ method: 'GET', url: '/api/admin/reports?status=ACTIONED', cookies: cb })).json()).toHaveLength(1);

    const mute = await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: ann.id, minutes: 30 } });
    expect(mute.statusCode).toBe(200);
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: ann.id } })).mutedUntil).not.toBeNull();
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'mute', operatorId: ann.id } });
    const term = await app.inject({ method: 'POST', url: '/api/admin/chat/filter', cookies: cb, headers: csrf, payload: { pattern: 'banana', kind: 'WORD', action: 'BLOCK' } });
    expect(term.statusCode).toBe(200);
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'filter', terms: [{ pattern: 'banana', action: 'BLOCK' }] } });
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/filter', cookies: cb, headers: csrf, payload: { pattern: '(', kind: 'REGEX', action: 'BLOCK' } })).statusCode).toBe(400);
    expect(await pruneChat(prisma!, new Date('2026-09-30T12:00:00Z'))).toMatchObject({ messages: 1 });
  });

  it('pages history with an (at, id) cursor: lines of the same millisecond across a page boundary are not skipped', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ann' });
    const ca = { [COOKIE_NAME]: a.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const ann = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ann' } });
    const t = new Date('2026-09-30T00:00:05.123Z');
    await prisma!.chatMessage.createMany({
      data: [
        { id: 'e0', channel: 'subnet:lo', operatorId: ann.id, text: 'earlier', at: new Date('2026-09-30T00:00:04Z') },
        { id: 'sa', channel: 'subnet:lo', operatorId: ann.id, text: 'a', at: t },
        { id: 'sb', channel: 'subnet:lo', operatorId: ann.id, text: 'b', at: t },
        { id: 'sc', channel: 'subnet:lo', operatorId: ann.id, text: 'c', at: t },
      ],
    });
    const page = async (q: string) => {
      const r = await app.inject({ method: 'GET', url: `/api/chat/subnet:lo?limit=2${q}`, cookies: ca });
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as Array<{ id: string; at: string }>;
    };
    const first = await page('');
    expect(first.map((m) => m.id)).toEqual(['sb', 'sc']);
    const oldest = first[0]!;
    const second = await page(`&before=${encodeURIComponent(oldest.at)}&beforeId=${oldest.id}`);
    expect(second.map((m) => m.id)).toEqual(['e0', 'sa']);
    const third = await page(`&before=${encodeURIComponent(second[0]!.at)}&beforeId=${second[0]!.id}`);
    expect(third).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/chat/subnet:lo?beforeId=sb`, cookies: ca })).statusCode).toBe(400);
  });

  it('chat authorization: admin rights from the operator row on every request, DMs per pair under the viewer’s name, own blocks only', async () => {
    const session = async (name: string, admin = false) => {
      const r = await app.inject({ method: 'GET', url: `/api/auth/dev?name=${name}${admin ? '&admin=true' : ''}` });
      return { [COOKIE_NAME]: r.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    };
    const ca = await session('ann');
    const cb = await session('ben', true);
    const cc = await session('cat');
    const op = (n: string) => prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${n}` } });
    const [ann, ben, cat] = await Promise.all([op('ann'), op('ben'), op('cat')]);

    // every admin route refuses a player
    const adminCalls = [
      { method: 'POST', url: '/api/admin/chat/mute', payload: { operatorId: cat.id, minutes: 5 } },
      { method: 'DELETE', url: '/api/admin/chat/x' },
      { method: 'GET', url: '/api/admin/chat/filter' },
      { method: 'POST', url: '/api/admin/chat/filter', payload: { pattern: 'kiwi', kind: 'WORD', action: 'MASK' } },
      { method: 'DELETE', url: '/api/admin/chat/filter/x' },
      { method: 'GET', url: '/api/admin/chat/hits' },
      { method: 'GET', url: '/api/admin/reports' },
      { method: 'POST', url: '/api/admin/reports/x/resolve', payload: { action: 'DISMISS' } },
    ] as const;
    for (const c of adminCalls) {
      const r = await app.inject({ ...c, cookies: ca, headers: csrf });
      expect([c.method, c.url, r.statusCode]).toEqual([c.method, c.url, 403]);
    }
    expect(bus.log).toHaveLength(0);
    expect(await prisma!.chatFilterTerm.count()).toBe(0);
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: cat.id } })).mutedUntil).toBeNull();
    // demotion takes effect on the next request
    expect((await app.inject({ method: 'GET', url: '/api/admin/chat/hits', cookies: cb })).statusCode).toBe(200);
    await prisma!.operator.update({ where: { id: ben.id }, data: { isAdmin: false } });
    expect((await app.inject({ method: 'GET', url: '/api/admin/chat/hits', cookies: cb })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: cat.id, minutes: 5 } })).statusCode).toBe(403);

    // history needs a session; cluster and org history are not served
    expect((await app.inject({ method: 'GET', url: '/api/chat/subnet:lo' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/chat/cluster:c1', cookies: ca })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/chat/subnet:lo?limit=0', cookies: ca })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/chat/subnet:lo?before=yesterday', cookies: ca })).statusCode).toBe(400);

    // DM rows are stored in the sender's form (dm:<recipient>); each side reads both directions under dm:<other>
    await prisma!.chatMessage.createMany({
      data: [
        { id: 'a1', channel: `dm:${ben.id}`, operatorId: ann.id, toId: ben.id, text: 'hi ben', at: new Date(Date.now() - 4000) },
        { id: 'b1', channel: `dm:${ann.id}`, operatorId: ben.id, toId: ann.id, text: 'hi ann', at: new Date(Date.now() - 3000) },
        { id: 'c1', channel: `dm:${ben.id}`, operatorId: cat.id, toId: ben.id, text: 'hi from cat', at: new Date(Date.now() - 2000) },
        { id: 'b2', channel: `dm:${cat.id}`, operatorId: ben.id, toId: cat.id, text: 'hi cat', at: new Date(Date.now() - 1000) },
      ],
    });
    const read = async (cookies: Record<string, string>, channel: string) =>
      (await app.inject({ method: 'GET', url: `/api/chat/${channel}`, cookies })).json() as Array<{ id: string; channel: string; from: string }>;
    const annBen = await read(ca, `dm:${ben.id}`);
    expect(annBen.map((m) => m.id)).toEqual(['a1', 'b1']);
    expect(annBen.map((m) => m.channel)).toEqual([`dm:${ben.id}`, `dm:${ben.id}`]);
    expect(annBen.map((m) => m.from)).toEqual([ann.id, ben.id]);
    const benAnn = await read(cb, `dm:${ann.id}`);
    expect(benAnn.map((m) => [m.id, m.channel])).toEqual([['a1', `dm:${ann.id}`], ['b1', `dm:${ann.id}`]]);
    expect((await read(cc, `dm:${ben.id}`)).map((m) => m.id)).toEqual(['c1', 'b2']);
    expect(await read(ca, `dm:${cat.id}`)).toEqual([]);
    expect(await read(cc, `dm:${ann.id}`)).toEqual([]);
    await prisma!.chatMessage.update({ where: { id: 'b1' }, data: { deletedAt: new Date() } });
    expect((await read(ca, `dm:${ben.id}`)).map((m) => m.id)).toEqual(['a1']);

    // blocks: only the caller's own rows, never self, never an unknown operator
    expect((await app.inject({ method: 'POST', url: '/api/chat/block', cookies: cc, headers: csrf, payload: { operatorId: ben.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/chat/block', cookies: ca, headers: csrf, payload: { operatorId: ben.id } })).statusCode).toBe(200);
    expect(await prisma!.chatBlock.findMany()).toMatchObject([{ blockerId: cat.id, blockedId: ben.id }]);
    expect((await app.inject({ method: 'POST', url: '/api/chat/block', cookies: ca, headers: csrf, payload: { operatorId: ann.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/chat/block', cookies: ca, headers: csrf, payload: { operatorId: 'nobody' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/chat/block', cookies: ca, payload: { operatorId: ben.id } })).statusCode).toBe(403);
    expect(await prisma!.chatBlock.count()).toBe(1);

    // reports: a DM line can only be reported by its two sides, and the refusal does not reveal that it exists
    const reportA1 = (cookies: Record<string, string>) => app.inject({ method: 'POST', url: '/api/reports', cookies, headers: csrf, payload: { targetId: ann.id, messageId: 'a1', reason: 'HARASSMENT' } });
    const byCat = await reportA1(cc);
    const unknown = await app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: ann.id, messageId: 'zz', reason: 'SPAM' } });
    expect(byCat.statusCode).toBe(400);
    expect(byCat.json().message).toBe(unknown.json().message);
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: 'nobody', reason: 'SPAM' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: cat.id, reason: 'SPAM' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: ann.id, reason: 'SPAM', note: 'x'.repeat(257) } })).statusCode).toBe(400);
    const byBen = await reportA1(cb);
    expect(byBen.statusCode).toBe(200);
    // the reporter never learns the outcome: a later duplicate answers the same shape whatever happened
    await prisma!.report.update({ where: { id: byBen.json().id }, data: { status: 'ACTIONED', action: 'MUTE' } });
    const again = await reportA1(cb);
    expect(Object.keys(again.json()).sort()).toEqual(['duplicate', 'id', 'ok']);
    expect(Object.keys(byBen.json()).sort()).toEqual(['id', 'ok']);

    // concurrent reports respect the daily cap and the (reporter, message) dedupe
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: cat.id, reason: 'OTHER', note: `n${i}` } })));
    expect(burst.filter((r) => r.statusCode === 200)).toHaveLength(8);
    expect(burst.filter((r) => r.statusCode === 400)).toHaveLength(4);
    expect(burst.some((r) => r.statusCode >= 500)).toBe(false);
    expect(await prisma!.report.count({ where: { reporterId: ann.id } })).toBe(8);
    const dupes = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: ben.id, messageId: 'c1', reason: 'SPAM' } })));
    expect(dupes.map((r) => r.statusCode)).toEqual([400, 400, 400, 400]); // c1 is cat's own line: target mismatch
    const dm2 = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: '/api/reports', cookies: cc, headers: csrf, payload: { targetId: ben.id, messageId: 'b2', reason: 'SPAM' } })));
    expect(dm2.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(dm2.filter((r) => r.json().duplicate === true)).toHaveLength(3);
    expect(await prisma!.report.count({ where: { reporterId: cat.id, messageId: 'b2' } })).toBe(1);
  });

  it('admin moderation publishes origin api, validates filter terms, resolves reports once, and prune keeps 7 days', async () => {
    const session = async (name: string, admin = false) => {
      const r = await app.inject({ method: 'GET', url: `/api/auth/dev?name=${name}${admin ? '&admin=true' : ''}` });
      return { [COOKIE_NAME]: r.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    };
    const ca = await session('ann');
    const cb = await session('ben', true);
    const op = (n: string) => prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${n}` } });
    const [ann, ben] = await Promise.all([op('ann'), op('ben')]);

    // mute / unmute
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: ann.id, minutes: 10 } })).statusCode).toBe(200);
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'mute', operatorId: ann.id, until: expect.any(String), origin: 'api' } });
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: ann.id, minutes: 0 } })).statusCode).toBe(200);
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: ann.id } })).mutedUntil).toBeNull();
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'mute', operatorId: ann.id, until: null, origin: 'api' } });
    const n = bus.log.length;
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: 'nobody', minutes: 5 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies: cb, headers: csrf, payload: { operatorId: ann.id, minutes: -1 } })).statusCode).toBe(400);
    expect(bus.log).toHaveLength(n);

    // delete
    await prisma!.chatMessage.create({ data: { id: 'd1', channel: `dm:${ben.id}`, operatorId: ann.id, toId: ben.id, text: 'rude', at: new Date() } });
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/chat/d1', cookies: cb, headers: csrf })).json()).toEqual({ ok: true });
    expect(bus.log.at(-1)).toEqual({ channel: 'admin', message: { kind: 'delete', id: 'd1', channel: `dm:${ben.id}` } });
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/chat/nope', cookies: cb, headers: csrf })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/chat/dm:${ann.id}`, cookies: cb })).json()).toEqual([]);

    // filter terms: unsafe / empty / invalid refused with the reason, nothing stored or published
    const addTerm = (payload: object) => app.inject({ method: 'POST', url: '/api/admin/chat/filter', cookies: cb, headers: csrf, payload });
    const unsafe = await addTerm({ pattern: '(a+)+$', kind: 'REGEX', action: 'BLOCK' });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().message).toContain('unsafe');
    const empty = await addTerm({ pattern: '???', kind: 'WORD', action: 'MASK' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toContain('empty');
    expect((await addTerm({ pattern: 'kiwi', kind: 'SUBSTRING', action: 'MASK' })).statusCode).toBe(400);
    expect(await prisma!.chatFilterTerm.count()).toBe(0);
    const kiwi = (await addTerm({ pattern: 'kiwi', kind: 'WORD', action: 'MASK' })).json();
    const plum = (await addTerm({ pattern: 'plum+', kind: 'REGEX', action: 'BLOCK' })).json();
    expect(bus.log.at(-1)!.message).toEqual({ kind: 'filter', terms: [{ pattern: 'kiwi', kind: 'WORD', action: 'MASK' }, { pattern: 'plum+', kind: 'REGEX', action: 'BLOCK' }] });
    expect((await app.inject({ method: 'GET', url: '/api/admin/chat/filter', cookies: cb })).json().map((t: { id: string }) => t.id)).toEqual([kiwi.id, plum.id]);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/chat/filter/${kiwi.id}`, cookies: cb, headers: csrf })).json()).toEqual({ ok: true });
    expect(bus.log.at(-1)!.message).toEqual({ kind: 'filter', terms: [{ pattern: 'plum+', kind: 'REGEX', action: 'BLOCK' }] });

    // the report queue carries the target's recent lines and filter hits; a report resolves exactly once
    await prisma!.chatMessage.create({ data: { id: 's1', channel: 'subnet:lo', operatorId: ben.id, text: 'buy gold', at: new Date() } });
    await prisma!.chatFilterHit.create({ data: { operatorId: ben.id, channel: 'subnet:lo', text: 'plum plum', term: 'plum+' } });
    const r1 = (await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, messageId: 's1', reason: 'SPAM' } })).json();
    const r2 = (await app.inject({ method: 'POST', url: '/api/reports', cookies: ca, headers: csrf, payload: { targetId: ben.id, reason: 'NAME' } })).json();
    const queue = (await app.inject({ method: 'GET', url: '/api/admin/reports?status=OPEN', cookies: cb })).json();
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ id: r1.id, recent: [{ id: 's1', text: 'buy gold' }], hits: [{ term: 'plum+' }] });
    expect((await app.inject({ method: 'GET', url: '/api/admin/chat/hits', cookies: cb })).json()).toMatchObject([{ operatorId: ben.id, term: 'plum+' }]);
    // another admin resolves the reports against ben (an admin cannot mute themselves)
    const cd = await session('dee', true);
    const dee = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-dee' } });
    const resolve = (id: string, payload: object) => app.inject({ method: 'POST', url: `/api/admin/reports/${id}/resolve`, cookies: cd, headers: csrf, payload });
    expect((await resolve(r2.id, { action: 'DELETE' })).statusCode).toBe(400); // no message on this report
    expect((await prisma!.report.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe('OPEN');
    const both = await Promise.all([resolve(r2.id, { action: 'MUTE', minutes: 15 }), resolve(r2.id, { action: 'MUTE', minutes: 15 })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(bus.log.filter((l) => (l.message as { kind: string }).kind === 'mute' && (l.message as { operatorId: string }).operatorId === ben.id)).toHaveLength(1);
    expect(bus.log.at(-1)).toMatchObject({ channel: 'admin', message: { kind: 'mute', operatorId: ben.id, reason: 'report', origin: 'api' } });
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: ben.id } })).mutedUntil).not.toBeNull();
    expect(await prisma!.report.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: 'ACTIONED', action: 'MUTE', resolvedBy: dee.id });
    expect((await resolve(r1.id, { action: 'DISMISS' })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/admin/reports?status=DISMISSED', cookies: cb })).json()).toHaveLength(1);
    expect((await resolve('nope', { action: 'DISMISS' })).statusCode).toBe(404);

    // prune keeps exactly 7 days
    const now = new Date('2026-10-04T12:00:00Z');
    const day = 86_400_000;
    await prisma!.chatMessage.createMany({
      data: [
        { id: 'p-in', channel: 'subnet:lo', operatorId: ann.id, text: 'x', at: new Date(now.getTime() - 7 * day + 60_000) },
        { id: 'p-out', channel: 'subnet:lo', operatorId: ann.id, text: 'x', at: new Date(now.getTime() - 7 * day - 60_000) },
      ],
    });
    await prisma!.chatMessage.updateMany({ where: { id: { in: ['d1', 's1'] } }, data: { at: now } });
    expect(await pruneChat(prisma!, now)).toMatchObject({ messages: 1 });
    expect(await prisma!.chatMessage.findUnique({ where: { id: 'p-in' } })).not.toBeNull();
    expect(await prisma!.chatMessage.findUnique({ where: { id: 'p-out' } })).toBeNull();
  });

  it('dev daemon seeding honours the operator’s Disk capacity', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=jo' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    await prisma!.operator.updateMany({ where: { sub: 'dev-jo' }, data: { diskCapacity: 1 } });
    const seed = () => app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'pingling', level: 2 } });
    expect((await seed()).statusCode).toBe(200);
    expect((await seed()).statusCode).toBe(400);
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
      prisma: prisma!, bus: new MemoryBus(), sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
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
      prisma: prisma!, bus: new MemoryBus(), sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
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
      prisma: prisma!, bus: new MemoryBus(), sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
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

describe.skipIf(!url)('API chat with a failing bus', () => {
  it('answers admin actions when the bus is down, logs the failure without chat text, and leaves no unhandled rejection', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Session", "Operator", "ChatMessage", "ChatFilterTerm", "Report" CASCADE');
    const lines: string[] = [];
    const failing: Bus = {
      publish: async () => {
        throw Object.assign(new Error('Connection is closed. secret chat text'), { name: 'ReplyError', code: 'ECONNREFUSED' });
      },
      subscribe: () => () => {},
      onReconnect: () => () => {},
      close: async () => {},
    };
    const app = await buildApp({
      prisma: prisma!, bus: failing, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
      logger: { ...loggerOptions('info'), stream: { write: (l: string) => void lines.push(l) } },
    });
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=root&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-root' } });
    const other = await prisma!.operator.create({ data: { sub: 'dev-other', x: 0, y: 0 } });
    await prisma!.chatMessage.create({ data: { id: 'f1', channel: 'subnet:lo', operatorId: op.id, text: 'secret chat text', at: new Date() } });
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies, headers: csrf, payload: { operatorId: other.id, minutes: 5 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/chat/f1', cookies, headers: csrf })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/filter', cookies, headers: csrf, payload: { pattern: 'fig', kind: 'WORD', action: 'MASK' } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    await app.close();
    const failures = lines.map((l) => JSON.parse(l) as { msg?: string; kind?: string }).filter((l) => l.msg === 'bus publish failed');
    expect(failures.map((l) => l.kind)).toEqual(['mute', 'delete', 'filter']);
    expect(lines.join('')).not.toContain('secret chat text');
  });
});

describe.skipIf(!url)('API without the dev bypass', () => {
  it('does not register /api/auth/dev', async () => {
    const app = await buildApp({
      prisma: prisma!, bus: new MemoryBus(), sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: false, disableRateLimit: true,
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/dev?name=alice' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/dev/daemon', headers: csrf, payload: { species: 'pingling', level: 8 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/dev/bits', headers: csrf, payload: { amount: 5 } })).statusCode).toBe(404);
    await app.close();
  });
});

describe.skipIf(!url)('chat retention', () => {
  it('never prunes a line an OPEN report references, and prunes filter hits on the same 7-day horizon', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Operator", "ChatMessage", "ChatFilterHit", "Report" CASCADE');
    const now = new Date('2026-10-04T12:00:00Z');
    const day = 86_400_000;
    const old = new Date(now.getTime() - 7 * day - 60_000);
    const fresh = new Date(now.getTime() - 7 * day + 60_000);
    const a = await prisma!.operator.create({ data: { sub: 'ret-a', x: 0, y: 0 } });
    const b = await prisma!.operator.create({ data: { sub: 'ret-b', x: 0, y: 0 } });
    await prisma!.chatMessage.createMany({
      data: [
        { id: 'r-open', channel: 'subnet:lo', operatorId: b.id, text: 'reported, open', at: old },
        { id: 'r-done', channel: 'subnet:lo', operatorId: b.id, text: 'reported, dismissed', at: old },
        { id: 'r-none', channel: 'subnet:lo', operatorId: b.id, text: 'never reported', at: old },
        { id: 'r-new', channel: 'subnet:lo', operatorId: b.id, text: 'recent', at: fresh },
      ],
    });
    await prisma!.report.create({ data: { reporterId: a.id, targetId: b.id, messageId: 'r-open', reason: 'SPAM' } });
    await prisma!.report.create({ data: { reporterId: a.id, targetId: b.id, messageId: 'r-done', reason: 'SPAM', status: 'DISMISSED' } });
    await prisma!.chatFilterHit.createMany({
      data: [
        { operatorId: b.id, channel: 'subnet:lo', text: 'x', term: 'kys', at: old },
        { operatorId: b.id, channel: 'subnet:lo', text: 'y', term: 'kys', at: fresh },
      ],
    });
    expect(await pruneChat(prisma!, now)).toEqual({ messages: 2, hits: 1 });
    expect((await prisma!.chatMessage.findMany({ orderBy: { id: 'asc' } })).map((m) => m.id)).toEqual(['r-new', 'r-open']);
    expect((await prisma!.chatFilterHit.findMany()).map((h) => h.text)).toEqual(['y']);
    // once the report is resolved, the line ages out like any other
    await prisma!.report.updateMany({ where: { messageId: 'r-open' }, data: { status: 'ACTIONED' } });
    expect(await pruneChat(prisma!, now)).toEqual({ messages: 1, hits: 0 });
  });
});

describe.skipIf(!url)('admin self-moderation', () => {
  it('an admin cannot mute themselves, directly or by resolving a report against themselves', async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "Session", "Operator", "ChatMessage", "Report" CASCADE');
    const bus = new MemoryBus();
    const app = await buildApp({
      prisma: prisma!, bus, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: fakeOidc(), requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
    });
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=root&admin=true' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const me = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-root' } });
    const other = await prisma!.operator.create({ data: { sub: 'dev-other', x: 0, y: 0 } });
    const self = await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies, headers: csrf, payload: { operatorId: me.id, minutes: 5 } });
    expect(self.statusCode).toBe(400);
    expect(self.json().message).toBe('cannot mute yourself');
    const report = await prisma!.report.create({ data: { reporterId: other.id, targetId: me.id, reason: 'SPAM' } });
    const resolve = await app.inject({ method: 'POST', url: `/api/admin/reports/${report.id}/resolve`, cookies, headers: csrf, payload: { action: 'MUTE' } });
    expect(resolve.statusCode).toBe(400);
    expect(resolve.json().message).toBe('cannot mute yourself');
    expect((await prisma!.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe('OPEN');
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: me.id } })).mutedUntil).toBeNull();
    expect(bus.log).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/admin/chat/mute', cookies, headers: csrf, payload: { operatorId: other.id, minutes: 5 } })).statusCode).toBe(200);
    await app.close();
  });
});
