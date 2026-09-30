# Daemonet SP2 · Plan 1 — API and WebSocket tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apps/api` — Authentik web login with PKCE, PostgreSQL sessions, `/api/me`, server-side scripts with 16 kept versions, Disk and Codex listings, and single-use WebSocket tickets — plus the sim's ticket verifier and the production wiring (image, compose, Caddy, deploy, Vault keys), so a browser can authenticate to the game without ever putting the cookie on the socket.

**Architecture:** Fastify 5 + Prisma, mirroring Plantry's backend (`buildApp` with injected deps, an `OidcClient` seam over `openid-client` v6 so routes are testable with a fake provider, hashed session tokens, sliding expiry, an `X-Requested-With` CSRF header for mutations). The browser gets a 60-second single-use `ticket:` token from `POST /api/ws/ticket` and presents it in the WebSocket `auth` message; the sim's `createTicketVerifier` consumes the row in a transaction. Both containers read one Vault document.

**Tech Stack:** Fastify ^5.12.5, @fastify/cookie ^11.1.2, @fastify/rate-limit ^11.2.0, openid-client ^6.8.8, Prisma 7.10 (existing), Vitest (Fastify `inject`), Docker.

**Prerequisites:** SP1 complete and deployed (Plans 1–4). Local test PostgreSQL as in SP1 plan 3 (`DATABASE_URL`).

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp2-web-client-design.md` §4, §7, §8, §9, §11.

## Global Constraints

- Everything from the SP1 plans (Node 24, pnpm 10.33.2, TypeScript ~6.0.3, ESM, LF, private repo, `packages/db/src/generated` git-ignored, `pnpm generate` before builds).
- Cookies: `daemonet_sid` HttpOnly + SameSite=Lax + Secure (outside tests), 7-day sliding; PKCE state cookie `daemonet_oidc` signed, path `/api/auth`, 10 min.
- Session and ticket values are stored only as SHA-256 hashes.
- Mutating `/api` requests require `X-Requested-With: daemonet` (403 otherwise).
- `AUTH_DEV_BYPASS=true` is refused in production by both apps; the dev route creates sub `dev-<name>` — the same sub the sim's `dev:<name>` tokens use.
- Scripts: ≤ 256 KiB, one `main` per operator, last 16 versions kept, never executed server-side.
- Logs carry `sub`s and ids only; `req.headers.cookie` and `authorization` are redacted.
- Test files run sequentially (`fileParallelism: false`) because they share one PostgreSQL.

## File map

```
packages/db/prisma/schema.prisma (+Session, WsTicket, Script, ScriptVersion, Operator.isAdmin)
packages/db/prisma/migrations/20260930000001_sp2_sessions_scripts/migration.sql
apps/api/  package.json, tsconfig.json, Dockerfile, entrypoint.mjs, env-filter.mjs
  src/config.ts, errors.ts, app.ts, server.ts
  src/auth/oidc.ts, session.ts, middleware.ts, routes.ts, dev-bypass.ts
  src/routes/scripts.ts, misc.ts
  test/app.test.ts
apps/sim/src/runtime/ticket.ts, auth.ts (combineVerifiers gains `ticket`), main.ts; test/ticket.test.ts
docker-compose.prod.yml (+api), apps/frontend/Caddyfile (+/api/*), apps/sim/Dockerfile (+api package.json, `tsc -b apps/sim`),
.github/workflows/deploy.yml (3 images, 2 health checks), scripts/provision-secrets.sh (+7 keys), scripts/fake-vault.mjs, OPERATIONS.md,
vitest.config.ts, tsconfig.json, package.json
```

---

### Task 1: Schema additions and migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260930000001_sp2_sessions_scripts/migration.sql`

**Interfaces:**
- Produces Prisma models `Session { id; tokenHash @unique; operatorId; groups: String[]; expiresAt; createdAt; lastSeenAt }`, `WsTicket { tokenHash @id; operatorId; expiresAt; createdAt }`, `Script { operatorId @id; source; version; updatedAt }`, `ScriptVersion { operatorId; version; source; createdAt; @@id([operatorId, version]) }`, and `Operator.isAdmin Boolean @default(false)`. All relations cascade on operator delete.

- [ ] **Step 1: Replace the schema**

`packages/db/prisma/schema.prisma`:

```prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated"
  moduleFormat        = "esm"
  importFileExtension = "js"
  runtime             = "nodejs"
}

datasource db {
  provider = "postgresql"
}

enum Location {
  RAM
  DISK
}

model Operator {
  id             String   @id @default(uuid())
  sub            String   @unique
  name           String?  @unique
  starterClaimed Boolean  @default(false)
  bits           BigInt   @default(0)
  subnet         String   @default("lo")
  x              Float
  y              Float
  /// item id -> count
  inventory      Json     @default("{}")
  isAdmin        Boolean  @default(false)
  createdAt      DateTime @default(now())
  lastSeenAt     DateTime @default(now())
  daemons        Daemon[]
  sessions       Session[]
  tickets        WsTicket[]
  script         Script?
  scriptVersions ScriptVersion[]
}

/// Browser sessions (cookie daemonet_sid). The cookie value is never stored, only its SHA-256.
model Session {
  id         String   @id @default(uuid())
  tokenHash  String   @unique
  operatorId String
  operator   Operator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  groups     String[]
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  @@index([operatorId])
  @@index([expiresAt])
}

/// Single-use, 60-second tickets that let a browser authenticate its WebSocket without a cookie.
model WsTicket {
  tokenHash  String   @id
  operatorId String
  operator   Operator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  expiresAt  DateTime
  createdAt  DateTime @default(now())

  @@index([expiresAt])
}

/// The operator's current main script.
model Script {
  operatorId String   @id
  operator   Operator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  source     String
  version    Int
  updatedAt  DateTime @updatedAt
}

/// The last 16 saved versions of the main script.
model ScriptVersion {
  operatorId String
  operator   Operator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  version    Int
  source     String
  createdAt  DateTime @default(now())

  @@id([operatorId, version])
}

model Daemon {
  id                 String   @id
  operatorId         String
  operator           Operator @relation(fields: [operatorId], references: [id])
  species            String
  level              Int
  xp                 Int
  nature             Int
  traitSlot          Int
  /// 8 values in STAT_KEYS order
  ivs                Int[]
  bonus              Int[]
  clean              Boolean
  signature          Int
  hp                 Int
  energy             Int
  moves              String[]
  crashed            Boolean
  location           Location
  slot               Int
  // capture log
  originalOperatorId String
  capturedAt         DateTime
  captureSubnet      String
  captureTool        String
  spawnSeedId        String
  spawnIndex         Int?

  @@unique([operatorId, location, slot])
  @@index([operatorId])
}

model SubnetSeed {
  /// 8 hex chars; prefixes every id the world generates
  id        String   @id
  subnet    String
  seed      String
  startedAt DateTime @default(now())
}

model AppliedAction {
  key       String   @id
  kind      String
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Add the migration**

`packages/db/prisma/migrations/20260930000001_sp2_sessions_scripts/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "groups" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WsTicket" (
    "tokenHash" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WsTicket_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Script" (
    "operatorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("operatorId")
);

-- CreateTable
CREATE TABLE "ScriptVersion" (
    "operatorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptVersion_pkey" PRIMARY KEY ("operatorId","version")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_operatorId_idx" ON "Session"("operatorId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "WsTicket_expiresAt_idx" ON "WsTicket"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WsTicket" ADD CONSTRAINT "WsTicket_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply, generate and verify the diff is empty**

```bash
pnpm db:migrate
pnpm generate
cd packages/db && pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code; cd ../..
pnpm test
```

Expected: `All migrations have been successfully applied`, diff exit code 0, all SP1 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(db): sessions, websocket tickets and script versions"
```

---

### Task 2: `apps/api` — login, sessions and `/api/me`

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/errors.ts`, `apps/api/src/config.ts`, `apps/api/src/auth/oidc.ts`, `apps/api/src/auth/session.ts`, `apps/api/src/auth/middleware.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/dev-bypass.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/entrypoint.mjs`, `apps/api/env-filter.mjs`
- Modify: `tsconfig.json` (add `apps/api`), `package.json` (add the `api` script)
- Test: `apps/api/test/app.test.ts`

**Interfaces:**
- `loadConfig(env)` → `{ nodeEnv, port, databaseUrl, sessionSecret, cookieSecure, frontendOrigin, oidc | null, requiredGroup, adminGroup, devBypass, trustProxyHops, logLevel }`.
- `interface OidcClient { start(); finish(callbackUrl, expected); endSessionUrl(idToken, postLogoutRedirectUri) }`, `createOidcClient({ issuer, clientId, clientSecret, redirectUri })`.
- `createSessionStore(prisma, ttlSeconds)` → `{ create(operatorId, groups); get(token); touch(token); destroy(token) }`, `hashToken`, `randomToken`.
- `makeRequireAuth(deps)` sets `req.operator = { id, isAdmin }`; `CSRF_HEADER = 'x-requested-with'`, `CSRF_VALUE = 'daemonet'`.
- `ensureOperator(prisma, sub, isAdmin)` — same first-login semantics as the sim's store.
- `buildApp({ prisma, sessionSecret, cookieSecure, frontendOrigin, oidcClient, requiredGroup, adminGroup, devBypass, trustProxyHops?, logger?, disableRateLimit? })`, `COOKIE_NAME = 'daemonet_sid'`, `SESSION_TTL_SECONDS`.
- Routes: `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/me`, and (dev bypass only) `GET /api/auth/dev?name=`.

- [ ] **Step 1: Package shell**

`apps/api/package.json`:

```json
{
  "name": "@daemonet/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@daemonet/db": "workspace:*",
    "@daemonet/rules": "workspace:*",
    "@fastify/cookie": "^11.1.2",
    "@fastify/rate-limit": "^11.2.0",
    "fastify": "^5.12.5",
    "openid-client": "^6.8.8",
    "pino": "^10.3.1",
    "zod": "^4.6.5"
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../../packages/rules" }, { "path": "../../packages/db" }]
}
```

Replace the root `tsconfig.json` with:

```json
{
  "files": [],
  "references": [
    {
      "path": "packages/rules"
    },
    {
      "path": "packages/shared"
    },
    {
      "path": "packages/db"
    },
    {
      "path": "packages/sdk"
    },
    {
      "path": "apps/sim"
    },
    {
      "path": "apps/api"
    }
  ]
}
```

In the root `package.json` `scripts`, add `"api": "pnpm --filter @daemonet/api start"`.

- [ ] **Step 2: Write the failing tests**

`apps/api/test/app.test.ts`:

```ts
import { createPrisma } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME, buildApp } from '../src/app.js';
import type { OidcClient, OidcIdentity } from '../src/auth/oidc.js';
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
    app = await buildApp({
      prisma: prisma!, sessionSecret: 'test-secret-test-secret-test-secret!', cookieSecure: false, frontendOrigin: 'https://daemonet.test',
      oidcClient: oidc, requiredGroup: 'daemonet-users', adminGroup: 'daemonet-admins', devBypass: true, disableRateLimit: true,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma!.$disconnect();
  });
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "ScriptVersion", "Script", "WsTicket", "Session", "Daemon", "Operator", "SubnetSeed", "AppliedAction" CASCADE');
  });

  /** Runs the full login: /login sets the PKCE cookie, /callback exchanges and sets the session cookie. */
  async function login(identity?: Partial<OidcIdentity>) {
    oidc.identity = { sub: 'user-1', groups: ['daemonet-users'], ...identity };
    const start = await app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(start.statusCode).toBe(302);
    const pkce = start.cookies.find((c) => c.name === 'daemonet_oidc')!;
    const cb = await app.inject({ method: 'GET', url: '/api/auth/callback?code=abc&state=st1', cookies: { daemonet_oidc: pkce.value } });
    return { response: cb, cookie: cb.cookies.find((c) => c.name === COOKIE_NAME)?.value };
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
    expect((await login({ groups: ['other'] })).response.statusCode).toBe(403);
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
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [COOKIE_NAME]: cookie! } });
    expect(out.json()).toMatchObject({ ok: true, endSessionUrl: 'https://authentik.test/end-session' });
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE_NAME]: cookie! } })).statusCode).toBe(401);
  });

  it('dev bypass creates a session for sub dev-<name>', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/dev?name=alice' });
    expect(r.statusCode).toBe(302);
    expect(await prisma!.operator.count({ where: { sub: 'dev-alice' } })).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/auth/dev?name=Bad%20Name' })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm install
pnpm vitest run apps/api/test/app.test.ts
```

Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 4: Implement**

`apps/api/src/errors.ts`:

```ts
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, 'validation_error', message);
export const unauthorized = (message: string) => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
```

`apps/api/src/config.ts`:

```ts
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  FRONTEND_ORIGIN: z.url(),
  AUTHENTIK_ISSUER_URL: z.url().optional(),
  AUTHENTIK_CLIENT_ID: z.string().min(1).optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1).optional(),
  AUTHENTIK_REDIRECT_URI: z.url().optional(),
  AUTH_REQUIRED_GROUP: z.string().min(1).default('daemonet-users'),
  AUTH_ADMIN_GROUP: z.string().min(1).default('daemonet-admins'),
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  cookieSecure: boolean;
  frontendOrigin: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; redirectUri: string } | null;
  requiredGroup: string;
  adminGroup: string;
  devBypass: boolean;
  trustProxyHops: number;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const e = Env.parse(env);
  const devBypass = e.AUTH_DEV_BYPASS === 'true';
  if (devBypass && e.NODE_ENV === 'production') throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  const oidc =
    e.AUTHENTIK_ISSUER_URL && e.AUTHENTIK_CLIENT_ID && e.AUTHENTIK_CLIENT_SECRET && e.AUTHENTIK_REDIRECT_URI
      ? { issuer: e.AUTHENTIK_ISSUER_URL, clientId: e.AUTHENTIK_CLIENT_ID, clientSecret: e.AUTHENTIK_CLIENT_SECRET, redirectUri: e.AUTHENTIK_REDIRECT_URI }
      : null;
  if (!oidc && !devBypass) throw new Error('set the AUTHENTIK_* variables (or AUTH_DEV_BYPASS=true outside production)');
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    cookieSecure: e.SESSION_COOKIE_SECURE === 'true',
    frontendOrigin: e.FRONTEND_ORIGIN,
    oidc,
    requiredGroup: e.AUTH_REQUIRED_GROUP,
    adminGroup: e.AUTH_ADMIN_GROUP,
    devBypass,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    logLevel: e.LOG_LEVEL,
  };
}
```

`apps/api/src/auth/oidc.ts`:

```ts
import * as oidc from 'openid-client';

export interface AuthorizationStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  sub: string;
  groups: string[];
  preferredUsername?: string;
  idToken?: string;
}

/** Small seam over openid-client so routes can be tested with a fake provider. */
export interface OidcClient {
  start(): Promise<AuthorizationStart>;
  /** `callbackUrl` is the full URL Authentik redirected to (code + state in the query). */
  finish(callbackUrl: URL, expected: { state: string; nonce: string; codeVerifier: string }): Promise<OidcIdentity>;
  endSessionUrl(idToken: string | undefined, postLogoutRedirectUri: string): Promise<string | null>;
}

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
}

const asGroups = (v: unknown): string[] => (Array.isArray(v) && v.every((g) => typeof g === 'string') ? v : []);

/** Discovery is deferred and retried, so the API boots even if Authentik is briefly unreachable. */
export function createOidcClient(opts: OidcClientOptions): OidcClient {
  const scope = opts.scope ?? 'openid profile email groups';
  let configPromise: Promise<oidc.Configuration> | null = null;
  const config = () => {
    configPromise ??= oidc.discovery(new URL(opts.issuer), opts.clientId, opts.clientSecret);
    configPromise.catch(() => (configPromise = null));
    return configPromise;
  };

  return {
    async start() {
      const c = await config();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(c, {
        redirect_uri: opts.redirectUri,
        scope,
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      });
      return { url: url.href, state, nonce, codeVerifier };
    },
    async finish(callbackUrl, expected) {
      const c = await config();
      const tokens = await oidc.authorizationCodeGrant(c, callbackUrl, {
        pkceCodeVerifier: expected.codeVerifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('id token has no sub');
      const info = await oidc.fetchUserInfo(c, tokens.access_token, claims.sub);
      const username = typeof info.preferred_username === 'string' ? info.preferred_username : undefined;
      return {
        sub: claims.sub,
        groups: asGroups(info.groups ?? claims.groups),
        ...(username ? { preferredUsername: username } : {}),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      };
    },
    async endSessionUrl(idToken, postLogoutRedirectUri) {
      const c = await config();
      try {
        return oidc.buildEndSessionUrl(c, { post_logout_redirect_uri: postLogoutRedirectUri, ...(idToken ? { id_token_hint: idToken } : {}) }).href;
      } catch {
        return null;
      }
    },
  };
}
```

`apps/api/src/auth/session.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@daemonet/db';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

export interface SessionRecord {
  operatorId: string;
  groups: string[];
  expiresAt: Date;
}

export interface SessionStore {
  create(operatorId: string, groups: string[]): Promise<string>;
  get(token: string): Promise<SessionRecord | null>;
  touch(token: string): Promise<void>;
  destroy(token: string): Promise<void>;
}

/** Sessions live in PostgreSQL; only the SHA-256 of the cookie value is stored. */
export function createSessionStore(prisma: PrismaClient, ttlSeconds: number): SessionStore {
  const expiry = () => new Date(Date.now() + ttlSeconds * 1000);
  return {
    async create(operatorId, groups) {
      const token = randomToken();
      await prisma.session.create({ data: { tokenHash: hashToken(token), operatorId, groups, expiresAt: expiry() } });
      return token;
    },
    async get(token) {
      const row = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!row) return null;
      if (row.expiresAt.getTime() <= Date.now()) {
        await prisma.session.deleteMany({ where: { tokenHash: row.tokenHash } });
        return null;
      }
      return { operatorId: row.operatorId, groups: row.groups, expiresAt: row.expiresAt };
    },
    async touch(token) {
      await prisma.session.updateMany({ where: { tokenHash: hashToken(token) }, data: { expiresAt: expiry(), lastSeenAt: new Date() } });
    },
    async destroy(token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    },
  };
}
```

`apps/api/src/auth/middleware.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../errors.js';
import type { SessionStore } from './session.js';

export interface RequestOperator {
  id: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: RequestOperator;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthMiddlewareDeps {
  sessionStore: SessionStore;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  adminGroup: string;
}

/** Mutating requests must carry this header: browsers cannot add it cross-site, so it doubles as CSRF protection. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'daemonet';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function makeRequireAuth(deps: AuthMiddlewareDeps) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies[deps.cookieName];
    if (!token) throw unauthorized('no session');
    const session = await deps.sessionStore.get(token);
    if (!session) throw unauthorized('invalid session');
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) throw forbidden(`missing ${CSRF_HEADER} header`);
    // Sliding expiry: once less than 6/7 of the TTL remains, extend the row and the cookie.
    if (session.expiresAt.getTime() - Date.now() < deps.ttlSeconds * 1000 * (6 / 7)) {
      await deps.sessionStore.touch(token);
      reply.setCookie(deps.cookieName, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    }
    req.operator = { id: session.operatorId, isAdmin: session.groups.includes(deps.adminGroup) };
  };
}

export function makeRequireAdmin() {
  return async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!req.operator) throw unauthorized('no session');
    if (!req.operator.isAdmin) throw forbidden('admin required');
  };
}
```

`apps/api/src/auth/routes.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { LO } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { badRequest, forbidden } from '../errors.js';
import type { OidcClient } from './oidc.js';
import type { SessionStore } from './session.js';

export interface AuthRouteDeps {
  prisma: PrismaClient;
  sessionStore: SessionStore;
  oidcClient: OidcClient | null;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  frontendOrigin: string;
  requiredGroup: string;
  adminGroup: string;
}

interface Pkce {
  state: string;
  nonce: string;
  codeVerifier: string;
}
export const PKCE_COOKIE = 'daemonet_oidc';

const encode = (p: Pkce) => Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
function decode(v: string): Pkce | null {
  try {
    const p = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Pkce;
    return typeof p.state === 'string' && typeof p.nonce === 'string' && typeof p.codeVerifier === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Same rule as the sim: an operator row is keyed by the OIDC sub and created on first sight. */
export async function ensureOperator(prisma: PrismaClient, sub: string, isAdmin: boolean): Promise<{ id: string }> {
  return prisma.operator.upsert({
    where: { sub },
    update: { isAdmin, lastSeenAt: new Date() },
    create: { sub, subnet: LO.id, x: LO.spawn.x, y: LO.spawn.y, isAdmin },
    select: { id: true },
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const limit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: deps.cookieSecure, maxAge: deps.ttlSeconds };

  app.get('/api/auth/login', limit, async (_req, reply) => {
    if (!deps.oidcClient) throw badRequest('OIDC is not configured');
    const start = await deps.oidcClient.start();
    reply.setCookie(PKCE_COOKIE, encode({ state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier }), {
      path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, signed: true, maxAge: 600,
    });
    return reply.redirect(start.url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/callback', limit, async (req, reply) => {
    if (!deps.oidcClient) throw badRequest('OIDC is not configured');
    const { code, state, error } = req.query;
    if (error) throw badRequest(`provider returned: ${error}`);
    if (!code || !state) throw badRequest('missing code or state');
    const raw = req.cookies[PKCE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const pkce = unsigned?.valid && unsigned.value ? decode(unsigned.value) : null;
    if (!pkce || pkce.state !== state) throw badRequest('state mismatch');

    const callbackUrl = new URL(req.url, deps.frontendOrigin);
    let identity;
    try {
      identity = await deps.oidcClient.finish(callbackUrl, pkce);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'oidc exchange failed');
      throw badRequest('token exchange failed');
    }
    reply.clearCookie(PKCE_COOKIE, { path: '/api/auth' });
    if (!identity.groups.includes(deps.requiredGroup)) throw forbidden(`not in ${deps.requiredGroup}`);
    const op = await ensureOperator(deps.prisma, identity.sub, identity.groups.includes(deps.adminGroup));
    const token = await deps.sessionStore.create(op.id, identity.groups);
    reply.setCookie(deps.cookieName, token, cookieOpts);
    req.log.info({ sub: identity.sub }, 'login');
    return reply.redirect(`${deps.frontendOrigin}/`);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[deps.cookieName];
    if (token) await deps.sessionStore.destroy(token);
    reply.clearCookie(deps.cookieName, { path: '/' });
    const endSessionUrl = deps.oidcClient ? await deps.oidcClient.endSessionUrl(undefined, deps.frontendOrigin) : null;
    return { ok: true, endSessionUrl };
  });

  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => {
    const op = await deps.prisma.operator.findUniqueOrThrow({
      where: { id: req.operator!.id },
      select: { id: true, name: true, starterClaimed: true, bits: true },
    });
    return { operatorId: op.id, name: op.name, starterClaimed: op.starterClaimed, bits: Number(op.bits), isAdmin: req.operator!.isAdmin };
  });
}
```

`apps/api/src/auth/dev-bypass.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import { ensureOperator } from './routes.js';
import type { SessionStore } from './session.js';

/**
 * Development only (AUTH_DEV_BYPASS=true, refused in production): GET /api/auth/dev?name=alice
 * creates a session for sub `dev-alice` — the same sub the sim's dev verifier uses, so the
 * browser and a `dev:alice` bot share one operator.
 */
export function registerDevBypass(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; sessionStore: SessionStore; cookieName: string; cookieSecure: boolean; ttlSeconds: number; frontendOrigin: string; adminGroup: string; requiredGroup: string },
): void {
  app.get<{ Querystring: { name?: string; admin?: string } }>('/api/auth/dev', async (req, reply) => {
    const name = req.query.name ?? '';
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw badRequest('name must match [a-z0-9_-]{1,32}');
    const isAdmin = req.query.admin === 'true';
    const op = await ensureOperator(deps.prisma, `dev-${name}`, isAdmin);
    const token = await deps.sessionStore.create(op.id, isAdmin ? [deps.requiredGroup, deps.adminGroup] : [deps.requiredGroup]);
    reply.setCookie(deps.cookieName, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure, maxAge: deps.ttlSeconds });
    return reply.redirect(`${deps.frontendOrigin}/`);
  });
}
```

`apps/api/src/app.ts` (Tasks 3 and 4 add two route modules):

```ts
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@daemonet/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerDevBypass } from './auth/dev-bypass.js';
import { makeRequireAdmin, makeRequireAuth } from './auth/middleware.js';
import type { OidcClient } from './auth/oidc.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createSessionStore } from './auth/session.js';
import { AppError } from './errors.js';

export const COOKIE_NAME = 'daemonet_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface BuildAppOptions {
  prisma: PrismaClient;
  sessionSecret: string;
  cookieSecure: boolean;
  frontendOrigin: string;
  oidcClient: OidcClient | null;
  requiredGroup: string;
  adminGroup: string;
  devBypass: boolean;
  trustProxyHops?: number;
  logger?: FastifyServerOptions['logger'];
  disableRateLimit?: boolean;
}

export async function buildApp(o: BuildAppOptions): Promise<FastifyInstance> {
  const hops = o.trustProxyHops ?? 0;
  // Fastify's numeric trustProxy is a no-op; the hop-count predicate is what proxy-addr honours.
  const app = Fastify({ logger: o.logger ?? false, trustProxy: (_addr: string, hop: number) => hop < hops });
  await app.register(cookie, { secret: o.sessionSecret });
  if (!o.disableRateLimit) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  const sessionStore = createSessionStore(o.prisma, SESSION_TTL_SECONDS);
  const common = { cookieName: COOKIE_NAME, cookieSecure: o.cookieSecure, ttlSeconds: SESSION_TTL_SECONDS, adminGroup: o.adminGroup };
  app.decorate('requireAuth', makeRequireAuth({ sessionStore, ...common }));
  app.decorate('requireAdmin', makeRequireAdmin());

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e.message }, 'unhandled error');
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'internal_error', message: status >= 500 ? 'internal error' : (e.message ?? 'error') });
  });

  registerAuthRoutes(app, { prisma: o.prisma, sessionStore, oidcClient: o.oidcClient, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  if (o.devBypass) registerDevBypass(app, { prisma: o.prisma, sessionStore, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  return app;
}
```

`apps/api/src/server.ts`:

```ts
import { createPrisma } from '@daemonet/db';
import { buildApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const prisma = createPrisma(config.databaseUrl);
await prisma.$queryRaw`SELECT 1`;

const app = await buildApp({
  prisma,
  sessionSecret: config.sessionSecret,
  cookieSecure: config.cookieSecure,
  frontendOrigin: config.frontendOrigin,
  oidcClient: config.oidc ? createOidcClient(config.oidc) : null,
  requiredGroup: config.requiredGroup,
  adminGroup: config.adminGroup,
  devBypass: config.devBypass,
  trustProxyHops: config.trustProxyHops,
  logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
});

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ port: config.port, devBypass: config.devBypass }, 'daemonet api started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

`apps/api/env-filter.mjs`:

```js
/**
 * Environment keys that Vault secrets must never be able to set.
 *
 * `NODE_ENV` / `AUTH_DEV_BYPASS` decide whether the auth dev bypass is legal;
 * the `NODE_*` and `PATH` keys can change what code the process loads.
 */
export const PROTECTED_ENV_KEYS = Object.freeze(['NODE_ENV', 'AUTH_DEV_BYPASS', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'TZ', 'PATH']);

/** Split a Vault secret bag into values that may be applied and the key NAMES (never values) that were ignored. */
export function filterSecrets(secrets) {
  const applied = {};
  const ignored = [];
  for (const [key, value] of Object.entries(secrets ?? {})) {
    if (PROTECTED_ENV_KEYS.includes(key)) ignored.push(key);
    else applied[key] = value;
  }
  return { applied, ignored };
}
```

`apps/api/entrypoint.mjs`:

```js
import { spawn } from 'node:child_process';
import { filterSecrets } from './env-filter.mjs';

const { VAULT_ADDR, VAULT_TOKEN, VAULT_PATH = 'secret/data/daemonet' } = process.env;
if (!VAULT_ADDR || !VAULT_TOKEN) {
  console.error('[entrypoint] VAULT_ADDR and VAULT_TOKEN must be set');
  process.exit(1);
}
console.log('[entrypoint] Fetching secrets from Vault...');
const res = await fetch(`${VAULT_ADDR}/v1/${VAULT_PATH}`, { headers: { 'X-Vault-Token': VAULT_TOKEN } });
if (!res.ok) {
  console.error(`[entrypoint] Vault responded ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { data: { data: secrets } } = await res.json();
const { applied, ignored } = filterSecrets(secrets);
if (ignored.length) console.warn(`[entrypoint] Ignored protected key(s) from Vault: ${ignored.join(', ')}`);
Object.assign(process.env, applied);
console.log('[entrypoint] Secrets loaded, starting api...');

const child = spawn(process.execPath, ['apps/api/dist/server.js'], { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 6 api tests (config + login, groups/admin, state mismatch, logout, dev bypass).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): authentik login, sessions and /api/me"
```

---

### Task 3: Scripts with versions

**Files:**
- Create: `apps/api/src/routes/scripts.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- `registerScriptRoutes(app, prisma)`, `MAX_SCRIPT_BYTES = 262144`, `KEPT_VERSIONS = 16`. Routes: `GET /api/scripts/main`, `PUT /api/scripts/main { source }`, `GET /api/scripts/main/versions`, `GET /api/scripts/main/versions/:version`.

- [ ] **Step 1: Add the failing tests**

In `apps/api/test/app.test.ts` add the imports and the `csrf` header constant:

```ts
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { KEPT_VERSIONS, MAX_SCRIPT_BYTES } from '../src/routes/scripts.js';

const csrf = { [CSRF_HEADER]: CSRF_VALUE };
```

and append inside the `API (needs DATABASE_URL)` describe, after the dev-bypass test:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: FAIL — cannot resolve `../src/routes/scripts.js`.

- [ ] **Step 3: Implement**

`apps/api/src/routes/scripts.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.js';

export const MAX_SCRIPT_BYTES = 256 * 1024;
export const KEPT_VERSIONS = 16;

const PutBody = z.object({ source: z.string() });

export function registerScriptRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const limit = { config: { rateLimit: { max: 64, timeWindow: '1 minute' } } };
  const auth = { preHandler: app.requireAuth };

  app.get('/api/scripts/main', auth, async (req) => {
    const row = await prisma.script.findUnique({ where: { operatorId: req.operator!.id } });
    return row ? { source: row.source, version: row.version, updatedAt: row.updatedAt } : { source: '', version: 0, updatedAt: null };
  });

  app.put('/api/scripts/main', { ...auth, ...limit }, async (req) => {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { source: string }');
    const { source } = parsed.data;
    if (Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES) throw badRequest(`script exceeds ${MAX_SCRIPT_BYTES} bytes`);
    const operatorId = req.operator!.id;
    return prisma.$transaction(async (tx) => {
      const current = await tx.script.findUnique({ where: { operatorId } });
      const version = (current?.version ?? 0) + 1;
      const saved = await tx.script.upsert({
        where: { operatorId },
        update: { source, version },
        create: { operatorId, source, version },
      });
      await tx.scriptVersion.create({ data: { operatorId, version, source } });
      const stale = await tx.scriptVersion.findMany({
        where: { operatorId },
        orderBy: { version: 'desc' },
        skip: KEPT_VERSIONS,
        select: { version: true },
      });
      if (stale.length) await tx.scriptVersion.deleteMany({ where: { operatorId, version: { in: stale.map((s) => s.version) } } });
      return { version: saved.version, updatedAt: saved.updatedAt };
    });
  });

  app.get('/api/scripts/main/versions', auth, async (req) => {
    const rows = await prisma.scriptVersion.findMany({
      where: { operatorId: req.operator!.id },
      orderBy: { version: 'desc' },
      select: { version: true, createdAt: true, source: true },
    });
    return rows.map((r) => ({ version: r.version, createdAt: r.createdAt, bytes: Buffer.byteLength(r.source, 'utf8') }));
  });

  app.get<{ Params: { version: string } }>('/api/scripts/main/versions/:version', auth, async (req) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw badRequest('bad version');
    const row = await prisma.scriptVersion.findUnique({ where: { operatorId_version: { operatorId: req.operator!.id, version } } });
    if (!row) throw notFound('no such version');
    return { version: row.version, createdAt: row.createdAt, source: row.source };
  });
}
```

In `apps/api/src/app.ts` add `import { registerScriptRoutes } from './routes/scripts.js';` and, after the dev-bypass registration, `registerScriptRoutes(app, o.prisma);`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 7 api tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): main script with 16 kept versions"
```

---

### Task 4: Readiness, Codex, Disk and WebSocket tickets

**Files:**
- Create: `apps/api/src/routes/misc.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/app.test.ts`, `vitest.config.ts`

**Interfaces:**
- `registerMiscRoutes(app, prisma)`, `codexPayload()`, `TICKET_TTL_MS = 60000`. Routes: `GET /api/ready`, `GET /api/codex`, `GET /api/disk`, `POST /api/ws/ticket` → `{ ticket: "ticket:<value>", expiresAt }`.

- [ ] **Step 1: Add the failing test**

Append inside the same describe block:

```ts
  it('mints single-use websocket tickets and lists Disk daemons and the codex', async () => {
    const { cookie } = await login();
    const cookies = { [COOKIE_NAME]: cookie! };
    const t = await app.inject({ method: 'POST', url: '/api/ws/ticket', cookies, headers: csrf });
    expect(t.json().ticket).toMatch(/^ticket:[A-Za-z0-9_-]{40,}$/);
    expect(await prisma!.wsTicket.count()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/disk', cookies })).json()).toEqual([]);
    const codex = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(codex.types).toHaveLength(16);
    expect(codex.species).toHaveLength(8);
    expect(codex.chart.glitch.null).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).json()).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/test/app.test.ts`
Expected: FAIL — `/api/ws/ticket` returns 404.

- [ ] **Step 3: Implement**

`apps/api/src/routes/misc.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { ITEMS, MOVES, NATURES, SPECIES, TRAITS, TYPES, typeMultiplier } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { hashToken, randomToken } from '../auth/session.js';

export const TICKET_TTL_MS = 60_000;

/** Static content the client renders (Codex) — served from the same package the sim enforces. */
export function codexPayload() {
  return {
    types: TYPES,
    chart: Object.fromEntries(TYPES.map((a) => [a, Object.fromEntries(TYPES.map((d) => [d, typeMultiplier(a, [d])]))])),
    species: SPECIES,
    moves: MOVES,
    items: ITEMS,
    natures: NATURES,
    traits: TRAITS,
  };
}

export function registerMiscRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/api/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get('/api/codex', auth, async () => codexPayload());

  app.get('/api/disk', auth, async (req) => {
    const rows = await prisma.daemon.findMany({ where: { operatorId: req.operator!.id, location: 'DISK' }, orderBy: { slot: 'asc' } });
    return rows.map((d) => ({
      id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus,
      clean: d.clean, signature: d.signature, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed, slot: d.slot,
      log: { originalOperatorId: d.originalOperatorId, capturedAt: d.capturedAt, subnet: d.captureSubnet, tool: d.captureTool, spawnIndex: d.spawnIndex },
    }));
  });

  /** Single-use ticket for the browser's WebSocket (sent as `auth { token: "ticket:<value>" }`). */
  app.post('/api/ws/ticket', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const value = randomToken();
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    await prisma.wsTicket.create({ data: { tokenHash: hashToken(value), operatorId: req.operator!.id, expiresAt } });
    await prisma.wsTicket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return { ticket: `ticket:${value}`, expiresAt };
  });
}
```

In `apps/api/src/app.ts` add `import { registerMiscRoutes } from './routes/misc.js';` and `registerMiscRoutes(app, o.prisma);` after the script routes. The final `app.ts` is:

```ts
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@daemonet/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerDevBypass } from './auth/dev-bypass.js';
import { makeRequireAdmin, makeRequireAuth } from './auth/middleware.js';
import type { OidcClient } from './auth/oidc.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createSessionStore } from './auth/session.js';
import { AppError } from './errors.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerScriptRoutes } from './routes/scripts.js';

export const COOKIE_NAME = 'daemonet_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface BuildAppOptions {
  prisma: PrismaClient;
  sessionSecret: string;
  cookieSecure: boolean;
  frontendOrigin: string;
  oidcClient: OidcClient | null;
  requiredGroup: string;
  adminGroup: string;
  devBypass: boolean;
  trustProxyHops?: number;
  logger?: FastifyServerOptions['logger'];
  disableRateLimit?: boolean;
}

export async function buildApp(o: BuildAppOptions): Promise<FastifyInstance> {
  const hops = o.trustProxyHops ?? 0;
  // Fastify's numeric trustProxy is a no-op; the hop-count predicate is what proxy-addr honours.
  const app = Fastify({ logger: o.logger ?? false, trustProxy: (_addr: string, hop: number) => hop < hops });
  await app.register(cookie, { secret: o.sessionSecret });
  if (!o.disableRateLimit) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  const sessionStore = createSessionStore(o.prisma, SESSION_TTL_SECONDS);
  const common = { cookieName: COOKIE_NAME, cookieSecure: o.cookieSecure, ttlSeconds: SESSION_TTL_SECONDS, adminGroup: o.adminGroup };
  app.decorate('requireAuth', makeRequireAuth({ sessionStore, ...common }));
  app.decorate('requireAdmin', makeRequireAdmin());

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e.message }, 'unhandled error');
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'internal_error', message: status >= 500 ? 'internal error' : (e.message ?? 'error') });
  });

  registerAuthRoutes(app, { prisma: o.prisma, sessionStore, oidcClient: o.oidcClient, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  if (o.devBypass) registerDevBypass(app, { prisma: o.prisma, sessionStore, frontendOrigin: o.frontendOrigin, requiredGroup: o.requiredGroup, ...common });
  registerScriptRoutes(app, o.prisma);
  registerMiscRoutes(app, o.prisma);
  return app;
}
```

Replace `vitest.config.ts` with (several suites now share the database):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    // Several suites share the one PostgreSQL in DATABASE_URL and truncate it; keep files sequential.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 8 api tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): readiness, codex, disk listing and websocket tickets"
```

---

### Task 5: The sim consumes tickets

**Files:**
- Create: `apps/sim/src/runtime/ticket.ts`
- Modify: `apps/sim/src/runtime/auth.ts`, `apps/sim/src/runtime/main.ts`, `apps/sim/src/runtime/prisma-store.ts`
- Test: `apps/sim/test/ticket.test.ts`

**Interfaces:**
- `createTicketVerifier(prisma, requiredGroup): TokenVerifier` — consumes `ticket:<value>` once, inside a transaction.
- `combineVerifiers(oidc, dev, ticket = null)` routes `ticket:` tokens.
- `PrismaStore.prisma` becomes public (read-only) so `main.ts` can share the client.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/ticket.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { createPrisma } from '@daemonet/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, combineVerifiers } from '../src/runtime/auth.js';
import { createTicketVerifier } from '../src/runtime/ticket.js';

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

describe.skipIf(!url)('ticket verifier (needs DATABASE_URL)', () => {
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe('TRUNCATE "WsTicket", "Operator" CASCADE');
  });

  async function mint(value: string, ttlMs = 60_000) {
    const op = await prisma!.operator.upsert({ where: { sub: 'user-t' }, update: {}, create: { sub: 'user-t', x: 1, y: 1 } });
    await prisma!.wsTicket.create({ data: { tokenHash: hash(value), operatorId: op.id, expiresAt: new Date(Date.now() + ttlMs) } });
  }

  it('accepts a fresh ticket exactly once', async () => {
    await mint('abc');
    const verify = createTicketVerifier(prisma!, 'daemonet-users');
    expect(await verify('ticket:abc')).toEqual({ sub: 'user-t', groups: ['daemonet-users'] });
    await expect(verify('ticket:abc')).rejects.toBeInstanceOf(AuthError);
    expect(await prisma!.wsTicket.count()).toBe(0);
  });

  it('rejects expired and unknown tickets, and routes the ticket: prefix', async () => {
    await mint('old', -1000);
    const verify = combineVerifiers(null, null, createTicketVerifier(prisma!, 'daemonet-users'));
    await expect(verify('ticket:old')).rejects.toThrow(/expired/);
    await expect(verify('ticket:nope')).rejects.toBeInstanceOf(AuthError);
    await expect(verify('ticket:')).rejects.toThrow(/empty/);
    await expect(combineVerifiers(null, null)('ticket:x')).rejects.toThrow(/not configured/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/ticket.test.ts`
Expected: FAIL — cannot resolve `../src/runtime/ticket.js`.

- [ ] **Step 3: Implement**

`apps/sim/src/runtime/ticket.ts`:

```ts
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@daemonet/db';
import { AuthError, type Claims, type TokenVerifier } from './auth.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Browser sockets authenticate with a single-use ticket minted by the API (`ticket:<value>`).
 * Consuming it deletes the row inside a transaction, so a replay fails; expired rows fail too.
 * Group membership was checked by the API at login, so the ticket implies the required group.
 */
export function createTicketVerifier(prisma: PrismaClient, requiredGroup: string): TokenVerifier {
  return async (token): Promise<Claims> => {
    const value = token.slice('ticket:'.length);
    if (!value) throw new AuthError('empty ticket');
    const row = await prisma.$transaction(async (tx) => {
      const found = await tx.wsTicket.findUnique({ where: { tokenHash: hash(value) }, include: { operator: { select: { sub: true } } } });
      if (!found) return null;
      await tx.wsTicket.delete({ where: { tokenHash: found.tokenHash } });
      return found.expiresAt.getTime() > Date.now() ? found : null;
    });
    if (!row) throw new AuthError('invalid or expired ticket');
    return { sub: row.operator.sub, groups: [requiredGroup] };
  };
}
```

In `apps/sim/src/runtime/auth.ts` replace `combineVerifiers` with:

```ts
/** `dev:` tokens go to `dev` (when enabled), `ticket:` tokens to `ticket` (browser sessions), everything else to `oidc`. */
export function combineVerifiers(oidc: TokenVerifier | null, dev: TokenVerifier | null, ticket: TokenVerifier | null = null): TokenVerifier {
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new AuthError('dev tokens are disabled');
      return dev(token);
    }
    if (token.startsWith('ticket:')) {
      if (!ticket) throw new AuthError('browser tickets are not configured');
      return ticket(token);
    }
    if (!oidc) throw new AuthError('OIDC is not configured');
    return oidc(token);
  };
}
```

In `apps/sim/src/runtime/prisma-store.ts` change the constructor to `constructor(readonly prisma: PrismaClient) {}`.

In `apps/sim/src/runtime/main.ts` add `import { createTicketVerifier } from './ticket.js';` and pass a third argument to `combineVerifiers`:

```ts
const verify = combineVerifiers(
  config.oidc
    ? createOidcVerifier({ issuer: config.oidc.issuer, audiences: [config.oidc.clientId], requiredGroup: config.requiredGroup })
    : null,
  config.devBypass ? createDevVerifier(config.requiredGroup) : null,
  createTicketVerifier(store.prisma, config.requiredGroup),
);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 21 test files, 164 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): single-use websocket tickets for browser sessions"
```

---

### Task 6: Production wiring and smoke test

**Files:**
- Create: `apps/api/Dockerfile`
- Modify: `apps/sim/Dockerfile`, `docker-compose.prod.yml`, `apps/frontend/Caddyfile`, `.github/workflows/deploy.yml`, `scripts/provision-secrets.sh`, `scripts/fake-vault.mjs`, `OPERATIONS.md`

- [ ] **Step 1: Write the files**

`apps/api/Dockerfile`:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY apps/sim/package.json apps/sim/
COPY apps/api/package.json apps/api/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @daemonet/db generate && pnpm exec tsc -b apps/api

FROM node:24-alpine AS runtime
RUN apk add --no-cache openssl tzdata
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./
COPY --from=build --chown=node:node /repo/packages/rules/package.json packages/rules/
COPY --from=build --chown=node:node /repo/packages/rules/dist packages/rules/dist
COPY --from=build --chown=node:node /repo/packages/rules/node_modules packages/rules/node_modules
COPY --from=build --chown=node:node /repo/packages/db/package.json packages/db/
COPY --from=build --chown=node:node /repo/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/node_modules packages/db/node_modules
COPY --from=build --chown=node:node /repo/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /repo/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/node_modules apps/api/node_modules
COPY --chown=node:node apps/api/entrypoint.mjs apps/api/env-filter.mjs apps/api/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/entrypoint.mjs"]
```

`apps/sim/Dockerfile` — add `COPY apps/api/package.json apps/api/` after the `apps/sim/package.json` line (the lockfile lists every workspace package) and change the build line to `RUN pnpm --filter @daemonet/db generate && pnpm exec tsc -b apps/sim`. Full file:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY apps/sim/package.json apps/sim/
COPY apps/api/package.json apps/api/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/sdk packages/sdk
COPY apps/sim apps/sim
RUN pnpm --filter @daemonet/db generate && pnpm exec tsc -b apps/sim

FROM node:24-alpine AS runtime
RUN apk add --no-cache openssl tzdata
WORKDIR /repo
ENV NODE_ENV=production
# Owned by `node`: the Prisma CLI needs a writable engines directory, and `prisma migrate deploy`
# runs from this image during deploys.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./
COPY --from=build --chown=node:node /repo/packages/rules/package.json packages/rules/
COPY --from=build --chown=node:node /repo/packages/rules/dist packages/rules/dist
COPY --from=build --chown=node:node /repo/packages/rules/node_modules packages/rules/node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/node_modules packages/shared/node_modules
COPY --from=build --chown=node:node /repo/packages/db/package.json /repo/packages/db/prisma.config.ts packages/db/
COPY --from=build --chown=node:node /repo/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/prisma packages/db/prisma
COPY --from=build --chown=node:node /repo/packages/db/node_modules packages/db/node_modules
COPY --from=build --chown=node:node /repo/apps/sim/package.json apps/sim/
COPY --from=build --chown=node:node /repo/apps/sim/dist apps/sim/dist
COPY --from=build --chown=node:node /repo/apps/sim/node_modules apps/sim/node_modules
COPY --chown=node:node apps/sim/entrypoint.mjs apps/sim/env-filter.mjs apps/sim/
USER node
EXPOSE 3000
# Liveness only: /ws/ready probes PostgreSQL and is what the deploy workflow checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ws/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/sim/entrypoint.mjs"]
```

`docker-compose.prod.yml`:

```yaml
x-logging: &default-logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

x-vault-env: &vault-env
  env_file: .env            # VAULT_ADDR + VAULT_TOKEN only; everything else comes from Vault at start
  environment:
    TZ: UTC
    NODE_EXTRA_CA_CERTS: /etc/ssl/extra/cloudflare-ca.crt
  volumes:
    - /usr/local/share/ca-certificates/cloudflare-origin-ca.crt:/etc/ssl/extra/cloudflare-ca.crt:ro

services:
  sim:
    build: { context: ., dockerfile: apps/sim/Dockerfile }
    image: daemonet-sim:latest
    restart: unless-stopped
    <<: *vault-env
    # S1 is otherwise idle, but keep the 16 Hz loop from starving the box during builds.
    cpus: 1.5
    mem_limit: 1g
    logging: *default-logging

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    image: daemonet-api:latest
    restart: unless-stopped
    <<: *vault-env
    logging: *default-logging

  frontend:
    build: { context: ., dockerfile: apps/frontend/Dockerfile }
    image: daemonet-frontend:latest
    restart: unless-stopped
    depends_on:
      sim:
        condition: service_healthy
      api:
        condition: service_healthy
    ports: ["192.168.40.21:3010:80"]   # LAN address only; nginx on LC2 is the only intended client
    logging: *default-logging
```

`apps/frontend/Caddyfile`:

```
# Caddy drops an incoming X-Forwarded-For unless the peer is a trusted proxy. Trust ONLY LC2
# (static 192.168.40.11): any other host on the VLAN that reaches this port directly has its
# X-Forwarded-For discarded, so client IPs cannot be spoofed.
# Chain: Cloudflare edge -> cloudflared (LC2, 127.0.0.1) -> nginx (LC2) -> Caddy -> sim/api,
# which is why both run with TRUST_PROXY_HOPS=3.
{
  servers {
    trusted_proxies static 192.168.40.11/32
  }
}

(security_headers) {
  X-Content-Type-Options "nosniff"
  Referrer-Policy "strict-origin-when-cross-origin"
  X-Frame-Options "DENY"
}

:80 {
  encode gzip zstd

  # The game protocol and its readiness probe. WebSocket upgrades pass through reverse_proxy as-is.
  handle /ws* {
    reverse_proxy sim:3000
  }

  handle /api/* {
    header {
      import security_headers
    }
    reverse_proxy api:3000
  }

  # Hashed build output is immutable (SP2 client); everything else must revalidate.
  handle /assets/* {
    root * /srv
    header {
      import security_headers
      Cache-Control "public, max-age=31536000, immutable"
    }
    file_server
  }

  handle {
    root * /srv
    header {
      import security_headers
      Cache-Control "no-cache"
    }
    try_files {path} /index.html
    file_server
  }
}
```

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}

# Nothing here talks to the GitHub API; the runner only needs the checkout it already has on disk.
permissions: {}

concurrency: { group: deploy, cancel-in-progress: false }

jobs:
  deploy:
    # workflow_run fires for CI runs from forks and any branch; without these guards a green CI run
    # on a fork's pull_request would deploy that fork's code.
    if: >-
      ${{ github.event_name == 'workflow_dispatch' ||
          (github.event.workflow_run.conclusion == 'success' &&
           github.event.workflow_run.event == 'push' &&
           github.event.workflow_run.head_branch == 'main' &&
           github.event.workflow_run.head_repository.full_name == github.repository) }}
    runs-on: [self-hosted, daemonet]
    defaults: { run: { working-directory: /opt/daemonet } }
    steps:
      - name: Check out the exact commit CI validated
        run: |
          set -euo pipefail
          git fetch origin
          git checkout --detach "${{ github.event.workflow_run.head_sha || github.sha }}"

      - name: Build images
        run: |
          set -e
          for i in 1 2 3; do
            if docker compose -f docker-compose.prod.yml build sim api frontend; then exit 0; fi
            echo "Attempt $i failed, retrying..."; sleep 10
          done
          echo "Build failed after 3 attempts."; exit 1

      - name: Run migrations (before the new code starts)
        run: |
          set -euo pipefail
          source .env
          DB_URL=$(curl -sf -H "X-Vault-Token: $VAULT_TOKEN" "$VAULT_ADDR/v1/secret/data/daemonet" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['data']['DATABASE_URL'])")
          docker compose -f docker-compose.prod.yml run --rm --no-deps -e DATABASE_URL="$DB_URL" --entrypoint "" sim \
            sh -c 'cd packages/db && node_modules/.bin/prisma migrate deploy'

      - name: Deploy
        run: docker compose -f docker-compose.prod.yml up -d

      - name: Health check
        run: |
          for i in $(seq 1 20); do
            if curl -sf http://192.168.40.21:3010/ws/ready && curl -sf http://192.168.40.21:3010/api/ready; then echo healthy; exit 0; fi
            sleep 3
          done
          docker compose -f docker-compose.prod.yml logs --tail 80 sim api; exit 1

      - name: Prune dangling images (S1 has a 64 GB disk)
        run: docker image prune -f
```

`scripts/provision-secrets.sh`:

```bash
#!/usr/bin/env bash
# One-time: put every Daemonet secret into Vault (LC3) and deliver the app's Vault token to S1.
# Run this yourself, from the repo root, in Git Bash:   bash scripts/provision-secrets.sh
#
# Nothing secret is printed, written to this machine's disk, or put on a command line:
#   - you type the Vault root token (hidden input)
#   - the DB password is read from the root-only file on S2 (OPERATIONS step 3)
#   - everything travels over ssh stdin into `vault kv put`; the periodic app token travels
#     LC3 -> here (in a variable) -> S1:/root/.daemonet-vault-token (mode 600)
#
# Prerequisites: `ssh S2`, `ssh S1` and `ssh LC3` work; Vault is unsealed; OPERATIONS steps 3 and 4 are done.
# Safe to re-run: the KV write is a full replace; an existing app token is reused, not duplicated.
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }

[ -f apps/sim/package.json ] || { say "Run from the repo root."; exit 1; }

say "== Things only you have (input is hidden) =="
VAULT_ROOT_TOKEN=$(ask_secret "Vault root token (1Password)")
BOT_CLIENT_ID=$(ask "Authentik client ID of the public provider 'daemonet-bot'")
WEB_CLIENT_ID=$(ask "Authentik client ID of the confidential provider 'daemonet' (web login)")
WEB_CLIENT_SECRET=$(ask_secret "Authentik client secret of 'daemonet'")
[ -n "$VAULT_ROOT_TOKEN" ] && [ -n "$BOT_CLIENT_ID" ] && [ -n "$WEB_CLIENT_ID" ] && [ -n "$WEB_CLIENT_SECRET" ] || { say "Vault token and both client ids/secret are required."; exit 1; }

say "== Generating SESSION_SECRET (in memory) =="
SESSION_SECRET=$(openssl rand -hex 32)

say "== Reading the DB password from S2 =="
DB_PW=$(ssh -o BatchMode=yes S2 'cat /root/.daemonet-db-pw')
[ -n "$DB_PW" ] || { say "Missing /root/.daemonet-db-pw on S2 (OPERATIONS step 3)."; exit 1; }

say "== Building the secret document =="
export DB_PW BOT_CLIENT_ID WEB_CLIENT_ID WEB_CLIENT_SECRET SESSION_SECRET
KV_JSON=$(python - <<'PY'
import json, os
d = {
  # The sim runs on S1 and reaches the shared PostgreSQL on S2 over the VLAN 40 LAN (OPERATIONS step 3).
  "DATABASE_URL": f"postgresql://daemonet:{os.environ['DB_PW']}@192.168.40.20:5432/daemonet",
  "AUTHENTIK_ISSUER_URL": "https://authentik.wispy-nook.casa/application/o/daemonet-bot/",
  "AUTHENTIK_BOT_CLIENT_ID": os.environ["BOT_CLIENT_ID"],
  "AUTH_REQUIRED_GROUP": "daemonet-users",
  "TRUST_PROXY_HOPS": "3",   # cloudflared -> nginx (both LC2) -> Caddy; Caddy trusts only LC2. Change if the chain changes.
  "SUBNET": "lo",
  "LOG_LEVEL": "info",
  "PORT": "3000",
  # apps/api (web login); the sim ignores keys it does not know.
  "SESSION_SECRET": os.environ["SESSION_SECRET"],
  "SESSION_COOKIE_SECURE": "true",
  "FRONTEND_ORIGIN": "https://daemonet.wispy-nook.casa",
  "AUTHENTIK_CLIENT_ID": os.environ["WEB_CLIENT_ID"],
  "AUTHENTIK_CLIENT_SECRET": os.environ["WEB_CLIENT_SECRET"],
  "AUTHENTIK_REDIRECT_URI": "https://daemonet.wispy-nook.casa/api/auth/callback",
  "AUTH_ADMIN_GROUP": "daemonet-admins",
}
print(json.dumps(d))
PY
)

say "== Writing policy + secrets to Vault on LC3, creating the periodic app token =="
# stdin to LC3: line 1 = root token, line 2 = the JSON document. stdout from LC3 = ONLY the app token.
APP_TOKEN=$(printf '%s\n%s\n' "$VAULT_ROOT_TOKEN" "$KV_JSON" | ssh -o BatchMode=yes LC3 '
  set -euo pipefail
  export VAULT_ADDR=http://127.0.0.1:8200
  read -r VAULT_TOKEN; export VAULT_TOKEN
  umask 077; tmp=$(mktemp -p /dev/shm daemonet.XXXXXX); trap "rm -f $tmp" EXIT
  cat > "$tmp"
  vault token lookup >/dev/null || { echo "Vault rejected the root token" >&2; exit 1; }
  printf "path \"secret/data/daemonet\" { capabilities = [\"read\"] }\n" | vault policy write daemonet - >&2
  vault kv put secret/daemonet @"$tmp" >/dev/null && echo "kv written: $(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$tmp") keys" >&2
  if ! grep -q "^daemonet " /opt/vault/app-tokens 2>/dev/null; then
    bash /opt/vault/add-app-token.sh daemonet daemonet >&2
  else
    echo "app token for daemonet already exists - reusing it" >&2
  fi
  grep "^daemonet " /opt/vault/app-tokens | tail -1 | cut -d" " -f2
')
[ -n "$APP_TOKEN" ] || { say "No app token came back from LC3."; exit 1; }

say "== Delivering the app token to S1:/root/.daemonet-vault-token (mode 600) =="
printf '%s' "$APP_TOKEN" | ssh -o BatchMode=yes S1 'umask 077; cat > /root/.daemonet-vault-token; echo "written: $(stat -c "%a %U %s bytes" /root/.daemonet-vault-token)" >&2'

say "== Verifying the app token can read the secret (from S1, through the same URL the container uses) =="
ssh -o BatchMode=yes S1 '
  code=$(curl -s -o /dev/null -w "%{http_code}" --cacert /usr/local/share/ca-certificates/cloudflare-origin-ca.crt \
    -H "X-Vault-Token: $(cat /root/.daemonet-vault-token)" https://vault.wispy-nook.casa/v1/secret/data/daemonet)
  echo "GET secret/data/daemonet with the app token -> HTTP $code (want 200)" >&2'

unset VAULT_ROOT_TOKEN DB_PW KV_JSON APP_TOKEN WEB_CLIENT_SECRET SESSION_SECRET
say "Done. Next: OPERATIONS step 6 (move the token into /opt/daemonet, write .env)."
```

`scripts/fake-vault.mjs`:

```js
// Local stand-in for Vault so the production image can be booted on a workstation (plan 4 task 1).
// Serves the same document shape as secret/data/daemonet; AUTH_DEV_BYPASS is present on purpose
// to prove the entrypoint ignores protected keys.
import { createServer } from 'node:http';
const secrets = {
  DATABASE_URL: 'postgresql://daemonet:daemonet@host.docker.internal:5432/daemonet_test',
  AUTH_DEV_BYPASS: 'true',            // protected: must be ignored by the entrypoint
  AUTHENTIK_ISSUER_URL: 'https://authentik.wispy-nook.casa/application/o/daemonet-bot/',
  AUTHENTIK_BOT_CLIENT_ID: 'daemonet-bot',
  TRUST_PROXY_HOPS: '3', SUBNET: 'lo', LOG_LEVEL: 'info', PORT: '3000',
  SESSION_SECRET: 'local-session-secret-local-session-secret', SESSION_COOKIE_SECURE: 'false', FRONTEND_ORIGIN: 'http://127.0.0.1:3010',
  AUTHENTIK_CLIENT_ID: 'daemonet', AUTHENTIK_CLIENT_SECRET: 'not-a-real-secret', AUTHENTIK_REDIRECT_URI: 'http://127.0.0.1:3010/api/auth/callback', AUTH_ADMIN_GROUP: 'daemonet-admins',
};
createServer((req, res) => {
  if (req.url === '/v1/secret/data/daemonet' && req.headers['x-vault-token'] === 'tok') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { data: secrets } })); return;
  }
  res.writeHead(403).end();
}).listen(8200, () => console.log('fake vault up'));
```

`OPERATIONS.md`:

````markdown
# Daemonet — Operations

Runbook for provisioning, deploying and operating the Daemonet sim on the homelab.
Section A is the one-time setup (SP1 plan 4), section B the first deploy and its acceptance
checks, section C day-2 operations. Hosts: S1 `192.168.40.21` (runs the game), S2
`192.168.40.20` (shared PostgreSQL), LC2 `192.168.40.11` (nginx + Cloudflare Tunnel), LC3
`192.168.60.11` (Vault). All commands assume `ssh S1`, `ssh S2`, `ssh LC2`, `ssh LC3` work from
the workstation.

## A. Provision (one-time)

- [ ] **Step 1: S1 is up and baselined**

Power S1 on. Then:

```bash
ssh S1 'hostname; ip -4 addr show enp4s0 | grep inet; docker version --format "{{.Server.Version}}"; \
  id runner; ls -l /usr/local/share/ca-certificates/cloudflare-origin-ca.crt; df -h / | tail -1'
```

Expect `192.168.40.21`, a Docker version, the `runner` user (in the `docker` group), the CA cert and free disk. If anything is missing, S1 was provisioned like S2 on 2026-04-20 (`D:\docs\MikroTik\CLAUDE.md`, "S1"); redo the missing piece the same way.

- [ ] **Step 2: GitHub deploy key and self-hosted runner (S1)**

```bash
ssh S1 'sudo -u runner ssh-keygen -t ed25519 -N "" -f /home/runner/.ssh/daemonet-deploy -C daemonet-deploy && \
  printf "Host github.com-daemonet\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/daemonet-deploy\n  IdentitiesOnly yes\n" | sudo -u runner tee -a /home/runner/.ssh/config >/dev/null && \
  cat /home/runner/.ssh/daemonet-deploy.pub'
```

Add the printed public key as a **read-only deploy key** on `Zaphiruz/daemonet` (Settings → Deploy keys). Store the private key in Vault too (LC3): `ssh S1 'sudo cat /home/runner/.ssh/daemonet-deploy' | ssh LC3 'export VAULT_ADDR=http://127.0.0.1:8200; read -r VAULT_TOKEN ...'` — use the "piping a secret from one host into Vault" recipe in the homelab doc, path `deploy-keys/daemonet`, field `private_key`.

Clone and register the runner (GitHub: Settings → Actions → Runners → New self-hosted runner → Linux x64 gives a fresh token):

```bash
ssh S1 'sudo mkdir -p /opt/daemonet /opt/actions-runner-daemonet && sudo chown runner:runner /opt/daemonet /opt/actions-runner-daemonet && \
  sudo -u runner git clone git@github.com-daemonet:Zaphiruz/daemonet.git /opt/daemonet'
ssh S1 'cd /opt/actions-runner-daemonet && sudo -u runner bash -c "curl -sSL -o r.tgz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz && tar xzf r.tgz && rm r.tgz && \
  ./config.sh --url https://github.com/Zaphiruz/daemonet --token <TOKEN> --name s1-daemonet --labels daemonet --unattended" && sudo ./svc.sh install runner && sudo ./svc.sh start'
```

Verify: the runner shows **Idle** with label `daemonet` on GitHub.

- [ ] **Step 3: PostgreSQL user + database, reachable from S1 (S2)**

```bash
ssh S2 'umask 077; openssl rand -hex 24 > /root/.daemonet-db-pw; PW=$(cat /root/.daemonet-db-pw); \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE USER daemonet WITH PASSWORD '"'"'$PW'"'"';" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -c "CREATE DATABASE daemonet OWNER daemonet TEMPLATE template0;" && \
  docker exec shared-infra-postgresql-1 psql -U postgres -d daemonet -c "GRANT ALL PRIVILEGES ON SCHEMA public TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO daemonet; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO daemonet;"'
```

Publish PostgreSQL on S2's LAN address **only**, then restrict it to S1 with a `DOCKER-USER` rule (Docker-published ports bypass host firewalls otherwise):

```bash
ssh S2 'cd /opt/shared-infra && sudo cp docker-compose.yml docker-compose.yml.bak-$(date +%F) && \
  sudo python3 - <<EOF
import re
p="docker-compose.yml"; s=open(p).read()
if "192.168.40.20:5432:5432" not in s:
    s=s.replace("    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data", "    ports: [\"192.168.40.20:5432:5432\"]   # LAN only; DOCKER-USER limits it to S1\n    volumes:\n      - rift-trader_pgdata:/var/lib/postgresql/data",1)
    open(p,"w").write(s)
EOF
  sudo docker compose up -d postgresql && \
  sudo iptables -C DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP 2>/dev/null || \
  sudo iptables -I DOCKER-USER -i end0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL ! -s 192.168.40.21 -j DROP && \
  (dpkg -s iptables-persistent >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent) && sudo netfilter-persistent save'
```

Verify (all three lines must hold):

```bash
ssh S1 'docker run --rm postgres:17-alpine pg_isready -h 192.168.40.20 -p 5432 -U daemonet'      # accepting connections
ssh LC2 'timeout 3 bash -c "</dev/tcp/192.168.40.20/5432" && echo REACHABLE || echo blocked'       # blocked
ssh S2 'docker exec shared-infra-postgresql-1 psql -U postgres -c "\l" | grep -c "^ [a-z]"'          # the other apps still list
```

Redis is **not** published: the SP1 sim does not use it. Publish it the same way (with an ACL user) when a later sub-project needs it.

- [ ] **Step 4: Authentik — public client with the device flow**

In `https://authentik.wispy-nook.casa` (admin):

1. **Providers → Create → OAuth2/OpenID Provider**: name `daemonet-bot`, authorization flow `default-provider-authorization-implicit-consent`, **Client type: Public**, redirect URIs: none needed (the device flow has no redirect; if the form insists, add `https://daemonet.wispy-nook.casa/`), signing key: the `authentik Self-signed Certificate`, scopes: `openid`, `profile`, `email`, `offline_access` **and the custom `groups` scope mapping** (Customisation → Property Mappings, the one BookStack uses). Access token validity `minutes=5`, refresh token validity `days=30`. Note the **Client ID**.
2. **Applications → Create**: name `Daemonet`, slug `daemonet-bot`, provider `daemonet-bot`.
3. **Directory → Groups**: create `daemonet-users` and `daemonet-admins`; add yourself to both. **Bind** `daemonet-users` to the application (Applications → Daemonet → Policy/Group/User Bindings → Bind existing group) — this is the access gate.
4. **System → Brands → the default brand → Device code flow**: set `default-provider-authorization-implicit-consent` if empty (the device flow is disabled on the brand until this is set).
5. **Web login (SP2): Providers → Create → OAuth2/OpenID Provider** `daemonet`, **Confidential** client, redirect URI `https://daemonet.wispy-nook.casa/api/auth/callback` (plus `http://localhost:3010/api/auth/callback` for dev), same scopes incl. `groups`, same signing key. **Applications → Create** `Daemonet Web`, slug `daemonet`, provider `daemonet`, bind `daemonet-users`. Note the Client ID and Client Secret.

Verify the device endpoint answers:

```bash
curl -s -X POST https://authentik.wispy-nook.casa/application/o/device/ -d client_id=<CLIENT_ID> -d scope="openid profile groups offline_access"
```

Expect JSON with `device_code`, `user_code`, `verification_uri`.

- [ ] **Step 5: Vault**

From the repo root on the workstation (prompts for the root token and the client ID; nothing is printed):

```bash
bash scripts/provision-secrets.sh
```

Expect `kv written: 15 keys` and `GET secret/data/daemonet with the app token -> HTTP 200`.

- [ ] **Step 6: Token + .env on S1**

```bash
ssh S1 'sudo mv /root/.daemonet-vault-token /opt/daemonet/vault-token && sudo chown runner:runner /opt/daemonet/vault-token && sudo chmod 400 /opt/daemonet/vault-token && \
  cd /opt/daemonet && sudo -u runner bash fetch-secrets.sh && sudo -u runner ls -l .env vault-token'
```

`.env` holds only `VAULT_ADDR` and `VAULT_TOKEN`.

- [ ] **Step 7: nginx (LC2) + Cloudflare Tunnel**

nginx needs a `map` for WebSocket upgrades (none exists on LC2 yet) and a server block:

```bash
ssh LC2 'sudo cp /etc/nginx/sites-enabled/wispy-nook.casa /root/wispy-nook.casa.bak-$(date +%F-%H%M) && \
  printf "map \$http_upgrade \$connection_upgrade {\n    default upgrade;\n    \"\"      close;\n}\n" | sudo tee /etc/nginx/conf.d/websocket-upgrade.conf >/dev/null && \
  sudo tee -a /etc/nginx/sites-enabled/wispy-nook.casa >/dev/null <<EOF

server {
    listen 443 ssl;
    server_name daemonet.wispy-nook.casa;
    ssl_certificate     /etc/nginx/certs/cloudflare-origin.pem;
    ssl_certificate_key /etc/nginx/certs/cloudflare-origin.key;
    location / {
        proxy_pass http://192.168.40.21:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  sudo nginx -t && sudo systemctl reload nginx'
```

Cloudflare dashboard → Zero Trust → Tunnels → the LC2 tunnel → Public Hostname → add `daemonet.wispy-nook.casa` → `https://localhost:443`, **port 443 (not 433)**, TLS → Origin Server Name `daemonet.wispy-nook.casa`.

## B. First deploy and acceptance

- [ ] **Step 8: Deploy**

Push `main` (CI must be green), or trigger manually: `gh workflow run deploy.yml --repo Zaphiruz/daemonet`. Watch: `gh run watch --repo Zaphiruz/daemonet --exit-status`. Then:

```bash
curl -s https://daemonet.wispy-nook.casa/ws/ready          # ok
curl -s -o /dev/null -w "%{http_code}\n" https://daemonet.wispy-nook.casa/   # 200
ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml ps'
```

- [ ] **Step 9: Acceptance — every line must be checked**

1. **Device-flow bot from the PC captures a daemon:**
   `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_ISSUER=https://authentik.wispy-nook.casa/application/o/daemonet-bot/ DAEMONET_CLIENT_ID=<CLIENT_ID> DAEMONET_NAME=<you> pnpm --filter @daemonet/starter-bot start` → approve the printed code in the browser → `claimed pingling` → within a few minutes `captured pingling!`.
2. **Persistence across a restart:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml restart sim'`; rerun the bot; the log line `connected as …` is followed by no `claimed` line (starter already claimed) and the captured daemon is in RAM (`game.self.ram` — the bot prints `captured` only for new ones; check with `psql`: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "select species, location, slot from \"Daemon\""'`).
3. **Tag protection with a second operator:** a second Authentik user in `daemonet-users` runs the bot at the same time; its log shows `capture failed`/no capture of the first bot's tagged target, and no `E_STATE` other than tag conflicts.
4. **Group gate:** remove a user from `daemonet-users`, restart their bot → `E_AUTH: not in daemonet-users`. Add them back.
5. **Real client IPs and no PII:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs --tail 50 sim | grep "operator connected"'` shows your public IP in `ip` and a `sub`, never a name or email.
6. **Web login (SP2):** open `https://daemonet.wispy-nook.casa/api/auth/login` → Authentik → redirected back with the `daemonet_sid` cookie; `curl` with that cookie to `/api/me` returns your operator. A user outside `daemonet-users` gets 403.
7. **Existing apps unaffected:** open Plantry, Third Eye and Mealie; all load.
8. **Load:** `DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` for 5 minutes (requires `AUTH_DEV_BYPASS`, which production refuses — so run this step against a **staging** start instead: `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml run --rm --no-deps -p 192.168.40.21:3011:3000 -e VAULT_PATH=secret/data/daemonet -e AUTH_DEV_BYPASS=true -e NODE_ENV=development sim'` and point the bots at `ws://192.168.40.21:3011/ws` from a VLAN 40 host, or through an SSH tunnel: `ssh -L 3011:192.168.40.21:3011 S1`). The `tick stats` log lines must show `p99` under 32 ms. Afterwards remove the load operators: `ssh S2 'docker exec shared-infra-postgresql-1 psql -U daemonet -d daemonet -c "DELETE FROM \"Daemon\" WHERE \"operatorId\" IN (SELECT id FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"'); DELETE FROM \"Operator\" WHERE sub LIKE '"'"'dev-%'"'"';"'`.

- [ ] **Step 10: Record it in the homelab doc**

Add to `D:\docs\MikroTik\CLAUDE.md`: S1 now hosts Daemonet (compose at `/opt/daemonet`, port 3010 LAN-bound, runner `s1-daemonet`, Vault `secret/daemonet`, Authentik slug `daemonet-bot` public client + device flow, DB `daemonet`); shared PostgreSQL is published on `192.168.40.20:5432` restricted to S1 by `DOCKER-USER`; the nginx `websocket-upgrade.conf` map on LC2; the S2 port table gains `3010 Daemonet (on S1)`.

## C. Day-2 operations

- **Logs:** `ssh S1 'cd /opt/daemonet && docker compose -f docker-compose.prod.yml logs -f sim api'` (pino JSON; the sim logs `tick stats` every 64 s).
- **Restart:** `… restart sim` — connected bots reconnect and resume on their own; the world reloads from the last checkpoint (≤ 32 s of movement lost, never a daemon).
- **Change a secret:** `vault kv patch secret/daemonet KEY=value` on LC3, then `… restart sim`.
- **Rotate the Vault token:** it is periodic (30 d, renewed weekly by LC3's timer); to replace it, rerun `scripts/provision-secrets.sh` (reuses the existing token unless removed from `/opt/vault/app-tokens`), then `fetch-secrets.sh` and restart.
- **Migrations:** run by `deploy.yml` before `up -d`; manual: the "Run migrations" step's command in `.github/workflows/deploy.yml`.
- **Backups:** the `daemonet` database is included in S2's nightly `pg_dumpall` automatically.
- **Disk:** `docker image prune -f` runs after each deploy; check `df -h /` on S1 occasionally.
- **Wipe the world (dev only):** stop the sim, `psql -U daemonet -d daemonet -c 'TRUNCATE "Daemon","Operator","SubnetSeed","AppliedAction" CASCADE'`, start the sim. Operators re-claim starters.
````

- [ ] **Step 2: Build the three images and smoke the stack through Caddy**

```bash
docker build -f apps/sim/Dockerfile -t daemonet-sim:local .
docker build -f apps/api/Dockerfile -t daemonet-api:local .
docker build -f apps/frontend/Dockerfile -t daemonet-frontend:local .
docker network create daemonet-local
docker run -d --name fake-vault --network daemonet-local node:24-alpine node --input-type=module -e "$(cat scripts/fake-vault.mjs)"
docker run -d --name sim-local --network daemonet-local --network-alias sim --add-host=host.docker.internal:host-gateway -e VAULT_ADDR=http://fake-vault:8200 -e VAULT_TOKEN=tok daemonet-sim:local
docker run -d --name api-local --network daemonet-local --network-alias api --add-host=host.docker.internal:host-gateway -e VAULT_ADDR=http://fake-vault:8200 -e VAULT_TOKEN=tok -e AUTH_DEV_BYPASS=true -e NODE_ENV=development daemonet-api:local
docker run -d --name frontend-local --network daemonet-local -p 127.0.0.1:3010:80 daemonet-frontend:local
sleep 9
curl -s http://127.0.0.1:3010/api/ready; curl -s http://127.0.0.1:3010/ws/ready; echo
COOKIE=$(curl -s -o /dev/null -c - "http://127.0.0.1:3010/api/auth/dev?name=smoke" | awk '/daemonet_sid/ {print $7}')
curl -s -b "daemonet_sid=$COOKIE" http://127.0.0.1:3010/api/me; echo
TICKET=$(curl -s -b "daemonet_sid=$COOKIE" -H "x-requested-with: daemonet" -X POST http://127.0.0.1:3010/api/ws/ticket | python -c "import sys,json;print(json.load(sys.stdin)['ticket'])")
node -e "
const t = process.argv[1];
function go(label) { return new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:3010/ws'); ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', seq: 1, d: { token: t } })); ws.onmessage = (e) => { console.log(label, String(e.data).slice(0, 80)); ws.close(); }; ws.onclose = () => res(); }); }
await go('first:'); await go('replay:');
" "$TICKET"
docker rm -f sim-local api-local frontend-local fake-vault; docker network rm daemonet-local
```

Expected: `{"ok":true}ok`, `/api/me` returns your dev operator, `first: {"t":"authOk",…` and `replay: {"t":"err",…"E_AUTH","message":"invalid or expired ticket"}`. (Git Bash: `export MSYS_NO_PATHCONV=1` first.)

- [ ] **Step 3: Run the full check, commit, push**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "chore: api image, compose, caddy and deploy wiring for SP2"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: CI green; the deploy fails its health check until the Vault document has the seven new keys — do OPERATIONS step 4.5 (provider `daemonet`) and re-run `scripts/provision-secrets.sh` (now `15 keys`), then `gh workflow run deploy.yml --repo Zaphiruz/daemonet` and confirm `curl https://daemonet.wispy-nook.casa/api/ready` → `{"ok":true}` and the OPERATIONS step 9 item 6 login check.
