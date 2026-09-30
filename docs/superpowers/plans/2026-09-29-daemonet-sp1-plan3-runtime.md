# Daemonet SP1 · Plan 3 — Runtime (database, WebSocket server, auth, SDK) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the deterministic core into a running game: Prisma/PostgreSQL persistence, the `Game` runtime (sessions, per-connection deltas, rate limits, resume, checkpoints, intent persistence with retries), the WebSocket server with Authentik token verification, the `@daemonet/sdk` player library (world mirror, scripts, commands, device-flow login), an example bot and a load script — all covered by contract, unit and end-to-end tests.

**Architecture:** `apps/sim/src/runtime` wraps `World` (Plan 2) without changing it: `Game` owns connections and sessions and calls `world.step()` once per tick from a drift-corrected loop; persistence goes through a `Store` interface with two implementations — `MemoryStore` (tests, local dev) and `PrismaStore` (production) — that share one contract test suite. The SDK speaks the `@daemonet/shared` protocol over the platform `WebSocket`, mirrors snapshot/deltas into a local state and runs player scripts once per tick.

**Tech Stack:** as Plans 1–2 plus Prisma 7.10 (`prisma-client` ESM generator + `@prisma/adapter-pg`), `pg`, `ws` 8, `jose` 6, `pino` 10. Node 24's built-in `WebSocket` and TypeScript type-stripping (`node file.ts`) for the example bot.

**Prerequisites:** Plans 1 and 2 complete. A PostgreSQL 17 database for tests: locally `docker run -d --name daemonet-pg -e POSTGRES_USER=daemonet -e POSTGRES_PASSWORD=daemonet -e POSTGRES_DB=daemonet_test -p 127.0.0.1:5432:5432 postgres:17-alpine` and `export DATABASE_URL=postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_test`.

**Specs:** SP1 spec §5–§9, §11; game design §5, §8, §9, §11, §12.

## Global Constraints

- Everything from Plans 1–2 (Node 24, pnpm 10.33.2, TypeScript ~6.0.3, ESM/NodeNext, LF, private repo, core stays pure).
- `packages/db/src/generated/` is produced by `prisma generate` and is **git-ignored**; every root script runs `pnpm generate` first.
- Only `claimStarter`, `capture`, `store`, `load` intents are persisted before their effects are announced; XP/levels/HP/energy/inventory/position ride on the checkpoint (every 512 ticks, on leave, on shutdown).
- Auth: tokens are verified against Authentik's JWKS (issuer, audience, expiry) and must carry `daemonet-users` (claim or userinfo). `dev:<name>` tokens work only with `AUTH_DEV_BYPASS=true`, which is refused when `NODE_ENV=production`.
- Logs carry `sub`s, operator ids and entity ids — never names or IPs beyond the connection log line's client IP.
- Protocol limits from `@daemonet/shared`: 8 commands per tick, 4 KiB messages (16 KiB for `submitCapture`), 16 s heartbeat, 64-tick resume window.
- Reference solvers stay under `packages/rules/test/`; the example bot ships **only** a Packet solver; the SDK exports challenge types and no solvers.
- No player-facing text (SDK, example README, error messages) links to GitHub.

## File map

```
packages/db/          prisma.config.ts, prisma/schema.prisma, prisma/migrations/20260930000000_init/migration.sql,
                      prisma/migrations/migration_lock.toml, src/index.ts (createPrisma + generated re-exports)
apps/sim/src/runtime/
  store.ts            Store interface, MemoryStore, randomHex
  prisma-store.ts     PrismaStore
  auth.ts             createOidcVerifier, createDevVerifier, combineVerifiers, AuthError
  interest.ts         diffEntities
  game.ts             Game, Conn, Logger, CLOSE codes
  loop.ts             startLoop
  server.ts           startServer, clientIp
  config.ts           loadConfig
  main.ts             entry point
apps/sim/test/        store.test.ts, auth.test.ts, game.test.ts, integration.test.ts
packages/sdk/src/     auth.ts, errors.ts, views.ts, client.ts, index.ts, node.ts (deviceLogin)
packages/sdk/test/    sdk.test.ts
examples/starter-bot/ package.json, README.md, tsconfig.json, src/{index,solvers,load}.ts
.github/workflows/ci.yml   + PostgreSQL service and migrate step
package.json, pnpm-workspace.yaml, tsconfig.json, .gitignore   updated
```

---

### Task 1: `@daemonet/db` — Prisma schema, migration and client

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma.config.ts`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/migration_lock.toml`, `packages/db/prisma/migrations/20260930000000_init/migration.sql`, `packages/db/src/index.ts`
- Modify: `package.json` (root scripts), `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore`, `apps/sim/package.json`, `apps/sim/tsconfig.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces (from `@daemonet/db`): `createPrisma(databaseUrl): PrismaClient`, plus everything the generated client exports (`PrismaClient`, model types such as `Daemon`, `Operator`, enum `Location`).
- Root scripts: `generate`, `build`, `typecheck`, `lint`, `test`, `db:migrate`, `sim`.

- [ ] **Step 1: Create the package**

`packages/db/package.json`:

```json
{
  "name": "@daemonet/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "generate": "prisma generate",
    "migrate:deploy": "prisma migrate deploy"
  },
  "dependencies": {
    "@prisma/adapter-pg": "7.10.0",
    "@prisma/client": "7.10.0",
    "pg": "^8.23.0"
  },
  "devDependencies": {
    "prisma": "7.10.0"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/db/prisma.config.ts`:

```ts
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` does not connect, so an unset URL is fine there; migrate commands need it.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

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
  createdAt      DateTime @default(now())
  lastSeenAt     DateTime @default(now())
  daemons        Daemon[]
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

`packages/db/prisma/migrations/migration_lock.toml`:

```toml
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

`packages/db/prisma/migrations/20260930000000_init/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "Location" AS ENUM ('RAM', 'DISK');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "name" TEXT,
    "starterClaimed" BOOLEAN NOT NULL DEFAULT false,
    "bits" BIGINT NOT NULL DEFAULT 0,
    "subnet" TEXT NOT NULL DEFAULT 'lo',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "inventory" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Daemon" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "xp" INTEGER NOT NULL,
    "nature" INTEGER NOT NULL,
    "traitSlot" INTEGER NOT NULL,
    "ivs" INTEGER[],
    "bonus" INTEGER[],
    "clean" BOOLEAN NOT NULL,
    "signature" INTEGER NOT NULL,
    "hp" INTEGER NOT NULL,
    "energy" INTEGER NOT NULL,
    "moves" TEXT[],
    "crashed" BOOLEAN NOT NULL,
    "location" "Location" NOT NULL,
    "slot" INTEGER NOT NULL,
    "originalOperatorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "captureSubnet" TEXT NOT NULL,
    "captureTool" TEXT NOT NULL,
    "spawnSeedId" TEXT NOT NULL,
    "spawnIndex" INTEGER,

    CONSTRAINT "Daemon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubnetSeed" (
    "id" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubnetSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppliedAction" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppliedAction_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_sub_key" ON "Operator"("sub");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_name_key" ON "Operator"("name");

-- CreateIndex
CREATE INDEX "Daemon_operatorId_idx" ON "Daemon"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Daemon_operatorId_location_slot_key" ON "Daemon"("operatorId", "location", "slot");

-- AddForeignKey
ALTER TABLE "Daemon" ADD CONSTRAINT "Daemon_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

`packages/db/src/index.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export * from './generated/client.js';

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
```

- [ ] **Step 2: Wire the workspace**

Replace `pnpm-workspace.yaml` with (pnpm 10 blocks Prisma's install scripts unless allowed):

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "examples/*"
onlyBuiltDependencies:
  - "@prisma/engines"
  - prisma
```

Replace the root `package.json` with:

```json
{
  "name": "daemonet",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.2",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "generate": "pnpm --filter @daemonet/db generate",
    "build": "pnpm generate && tsc -b",
    "typecheck": "pnpm generate && tsc -b && tsc -p tsconfig.tests.json && tsc -p examples/starter-bot/tsconfig.json",
    "lint": "eslint .",
    "test": "pnpm generate && tsc -b && vitest run",
    "db:migrate": "pnpm --filter @daemonet/db migrate:deploy",
    "sim": "pnpm --filter @daemonet/sim start"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "eslint": "^10.11.0",
    "fast-check": "^4.10.2",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.71.0",
    "vitest": "^4.1.11"
  }
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
    }
  ]
}
```

Append to `.gitignore`:

```
packages/db/src/generated/
```

Replace `apps/sim/package.json` with (adds the runtime dependencies used by Tasks 2–5 and the SDK dev dependency used by Task 8):

```json
{
  "name": "@daemonet/sim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./core": {
      "types": "./dist/core/index.d.ts",
      "default": "./dist/core/index.js"
    }
  },
  "scripts": {
    "start": "node dist/runtime/main.js"
  },
  "dependencies": {
    "@daemonet/db": "workspace:*",
    "@daemonet/rules": "workspace:*",
    "@daemonet/shared": "workspace:*",
    "jose": "^6.2.12",
    "pino": "^10.3.1",
    "ws": "^8.20.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1",
    "@daemonet/sdk": "workspace:*"
  }
}
```

Replace `apps/sim/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../../packages/rules" }, { "path": "../../packages/shared" }, { "path": "../../packages/db" }]
}
```

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: daemonet
          POSTGRES_PASSWORD: daemonet
          POSTGRES_DB: daemonet_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U daemonet"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://daemonet:daemonet@127.0.0.1:5432/daemonet_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: Install, generate, migrate and build**

```bash
pnpm install
pnpm generate
pnpm db:migrate
pnpm typecheck
```

Expected: `Generated Prisma Client (7.10.0) to ./src/generated`, `All migrations have been successfully applied`, and a clean typecheck. (`pnpm install` will fail on Node 23 — Prisma requires 24.)

- [ ] **Step 4: Confirm the migration matches the schema**

Run: `cd packages/db && pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code; cd ../..`
Expected: exit code 0 (no differences). The `examples/*` workspace entry and the `@daemonet/sdk` dev dependency resolve once Tasks 6–8 create those packages; until then `pnpm install` prints a warning about the missing workspace package — that is expected.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): prisma schema, init migration and client; ci: postgres service"
```

---

### Task 2: The `Store` contract — `MemoryStore` and `PrismaStore`

**Files:**
- Create: `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`
- Test: `apps/sim/test/store.test.ts`

**Interfaces:**
- Produces: `interface Store { createSeed(subnet); loadOrCreateOperator(sub, subnet, spawn); applyIntent(intent, ctx: { seedId; storedDaemon? }); checkpoint(records); ping(); close() }`, `class MemoryStore implements Store` (with `failNext` for tests), `class PrismaStore implements Store` (`PrismaStore.connect(url)`), `randomHex(bytes)`.
- Semantics: `applyIntent` is idempotent by `intent.id` (replaying a `load` returns the daemon again); domain failures resolve `{ ok: false, reason }` (`'name taken'`, `'not on Disk'`, `'daemon not found'`); infrastructure failures throw.

- [ ] **Step 1: Write the failing contract tests**

`apps/sim/test/store.test.ts`:

```ts
import { createPrisma } from '@daemonet/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Intent, OwnedDaemonRecord } from '../src/core/index.js';
import { PrismaStore } from '../src/runtime/prisma-store.js';
import { MemoryStore, type Store } from '../src/runtime/store.js';
import { ownedRecord } from './helpers.js';

const SPAWN = { x: 18.5, y: 16.5 };
const log = { originalOperatorId: 'x', capturedAtTick: 1, subnet: 'lo', tool: 'starter' as const, seedId: 'abcd1234', spawnIndex: null };

function claim(operatorId: string, name: string, daemon: OwnedDaemonRecord, id = `i-claim-${name}`): Intent {
  return { id, kind: 'claimStarter', operatorId, reqId: 'r', name, daemon, inventory: { sniff: 8, restore: 2 }, log: { ...log, originalOperatorId: operatorId } };
}

function contract(name: string, make: () => Promise<Store>, reset: () => Promise<void>) {
  describe(`${name} contract`, () => {
    let store: Store;
    beforeEach(async () => {
      await reset();
      store = await make();
    });

    it('creates a seed with an 8-hex id', async () => {
      const seed = await store.createSeed('lo');
      expect(seed.id).toMatch(/^[0-9a-f]{8}$/);
      expect(seed.seed).toMatch(/^[0-9a-f]{32}$/);
    });

    it('creates an operator once, at the spawn point, with nothing claimed', async () => {
      const a = await store.loadOrCreateOperator('sub-1', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-1', 'lo', SPAWN);
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ name: null, starterClaimed: false, x: 18.5, y: 16.5, bits: 0, inventory: {}, ram: [], diskSlots: [] });
    });

    it('claims a starter once; a second operator cannot take the same name', async () => {
      const a = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      const b = await store.loadOrCreateOperator('sub-b', 'lo', SPAWN);
      const d = ownedRecord('pingling', 5, 0, 'abcd1234-d1');
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(claim(a.id, 'alice', d), { seedId: 'abcd1234' })).toEqual({ ok: true });
      const taken = await store.applyIntent(claim(b.id, 'alice', ownedRecord('nullpup', 5, 0, 'abcd1234-d2'), 'i-claim-b'), { seedId: 'abcd1234' });
      expect(taken).toEqual({ ok: false, reason: 'name taken' });
      const reloaded = await store.loadOrCreateOperator('sub-a', 'lo', SPAWN);
      expect(reloaded).toMatchObject({ name: 'alice', starterClaimed: true, inventory: { sniff: 8, restore: 2 } });
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d1']);
    });

    it('persists captures idempotently, to RAM or Disk', async () => {
      const a = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      const intent = (id: string, daemon: OwnedDaemonRecord, location: 'RAM' | 'DISK'): Intent => ({
        id, kind: 'capture', operatorId: a.id, captureId: 'c1', daemon, location, tool: 'sniff', log: { ...log, tool: 'sniff', spawnIndex: 7 },
      });
      const ram = ownedRecord('bitrot', 6, 1, 'abcd1234-d3');
      const disk = ownedRecord('voidlet', 9, 0, 'abcd1234-d4');
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(intent('i-cap-1', ram, 'RAM'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(intent('i-cap-2', disk, 'DISK'), { seedId: 'abcd1234' })).toEqual({ ok: true });
      const reloaded = await store.loadOrCreateOperator('sub-c', 'lo', SPAWN);
      expect(reloaded.ram.map((r) => r.id)).toEqual(['abcd1234-d3']);
      expect(reloaded.diskSlots).toEqual([0]);
    });

    it('stores to Disk with the latest state and loads back into a RAM slot', async () => {
      const a = await store.loadOrCreateOperator('sub-d', 'lo', SPAWN);
      const d = ownedRecord('pingling', 5, 0, 'abcd1234-d5');
      await store.applyIntent(claim(a.id, 'dora', d), { seedId: 'abcd1234' });
      const stored = await store.applyIntent(
        { id: 'i-store', kind: 'store', operatorId: a.id, reqId: 'r', daemonId: d.id, diskSlot: 3 },
        { seedId: 'abcd1234', storedDaemon: { ...d, level: 9, xp: 5832 } },
      );
      expect(stored).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-d', 'lo', SPAWN)).diskSlots).toEqual([3]);
      const loaded = await store.applyIntent({ id: 'i-load', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d.id, ramSlot: 2 }, { seedId: 'abcd1234' });
      expect(loaded).toMatchObject({ ok: true, daemon: { id: d.id, level: 9, slot: 2 } });
      const again = await store.applyIntent({ id: 'i-load', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: d.id, ramSlot: 2 }, { seedId: 'abcd1234' });
      expect(again).toMatchObject({ ok: true, daemon: { id: d.id } });
      const missing = await store.applyIntent({ id: 'i-load-2', kind: 'load', operatorId: a.id, reqId: 'r', daemonId: 'nope', ramSlot: 3 }, { seedId: 'abcd1234' });
      expect(missing).toEqual({ ok: false, reason: 'not on Disk' });
    });

    it('checkpoints position, inventory, bits and RAM daemon state', async () => {
      const a = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      const d = ownedRecord('hashling', 5, 0, 'abcd1234-d6');
      await store.applyIntent(claim(a.id, 'erin', d), { seedId: 'abcd1234' });
      const rec = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      await store.checkpoint([{ ...rec, x: 40.25, y: 12.5, bits: 64, inventory: { sniff: 3 }, ram: [{ ...rec.ram[0]!, level: 7, hp: 3, crashed: true }] }]);
      const after = await store.loadOrCreateOperator('sub-e', 'lo', SPAWN);
      expect(after).toMatchObject({ x: 40.25, y: 12.5, bits: 64, inventory: { sniff: 3 } });
      expect(after.ram[0]).toMatchObject({ level: 7, hp: 3, crashed: true });
    });
  });
}

contract('MemoryStore', async () => new MemoryStore(), async () => {});

const url = process.env.DATABASE_URL;
const prisma = url ? createPrisma(url) : null;
describe.skipIf(!url)('PrismaStore (needs DATABASE_URL)', () => {
  afterAll(async () => prisma?.$disconnect());
  contract(
    'PrismaStore',
    async () => new PrismaStore(prisma!),
    async () => {
      await prisma!.$executeRawUnsafe('TRUNCATE "Daemon", "Operator", "SubnetSeed", "AppliedAction" CASCADE');
    },
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/store.test.ts`
Expected: FAIL — cannot resolve `../src/runtime/prisma-store.js`.

- [ ] **Step 3: Implement**

`apps/sim/src/runtime/store.ts`:

```ts
import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';

export interface IntentContext {
  seedId: string;
  /** For `store`: the daemon's current state, written along with the move to Disk. */
  storedDaemon?: OwnedDaemonRecord;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord>;
  /** Idempotent by intent.id. Domain failures (name taken, not on Disk) resolve with ok: false. */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface MemDaemon extends OwnedDaemonRecord {
  operatorId: string;
  location: 'RAM' | 'DISK';
}

interface MemOperator {
  id: string;
  sub: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  x: number;
  y: number;
  inventory: Record<string, number>;
}

/** In-memory Store with the same semantics as PrismaStore. Used by tests and local development. */
export class MemoryStore implements Store {
  readonly operators = new Map<string, MemOperator>();
  readonly daemons = new Map<string, MemDaemon>();
  readonly applied = new Set<string>();
  readonly seeds: Array<{ id: string; seed: string; subnet: string }> = [];
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, _subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, bits: 0, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: op.bits,
      inventory: { ...op.inventory },
      ram: mine.filter((d) => d.location === 'RAM').sort((a, b) => a.slot - b.slot).map(({ operatorId: _o, location: _l, ...rec }) => ({ ...rec })),
      diskSlots: mine.filter((d) => d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated store failure');
    }
    if (this.applied.has(intent.id)) {
      if (intent.kind === 'load') {
        const d = this.daemons.get(intent.daemonId)!;
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
      return { ok: true };
    }
    const op = this.operators.get(intent.operatorId);
    if (!op) throw new Error(`unknown operator ${intent.operatorId}`);
    switch (intent.kind) {
      case 'claimStarter': {
        if ([...this.operators.values()].some((o) => o.name === intent.name && o.id !== op.id)) return { ok: false, reason: 'name taken' };
        op.name = intent.name;
        op.starterClaimed = true;
        op.inventory = { ...intent.inventory };
        this.daemons.set(intent.daemon.id, { ...intent.daemon, operatorId: op.id, location: 'RAM' });
        break;
      }
      case 'capture':
        this.daemons.set(intent.daemon.id, { ...intent.daemon, operatorId: op.id, location: intent.location });
        break;
      case 'store': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id) return { ok: false, reason: 'daemon not found' };
        Object.assign(d, ctx.storedDaemon ?? {}, { location: 'DISK', slot: intent.diskSlot });
        break;
      }
      case 'load': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'DISK') return { ok: false, reason: 'not on Disk' };
        d.location = 'RAM';
        d.slot = intent.ramSlot;
        this.applied.add(intent.id);
        const { operatorId: _o, location: _l, ...rec } = d;
        return { ok: true, daemon: { ...rec } };
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      Object.assign(op, { x: rec.x, y: rec.y, bits: rec.bits, inventory: { ...rec.inventory } });
      for (const d of rec.ram) {
        const row = this.daemons.get(d.id);
        if (row && row.operatorId === op.id) Object.assign(row, { ...d, location: 'RAM' as const });
      }
    }
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
```

`apps/sim/src/runtime/prisma-store.ts`:

```ts
import { createPrisma, type Daemon as DaemonRow, type PrismaClient } from '@daemonet/db';
import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type IntentContext, type Store } from './store.js';

function toRecord(row: DaemonRow): OwnedDaemonRecord {
  return {
    id: row.id,
    species: row.species,
    level: row.level,
    xp: row.xp,
    nature: row.nature,
    traitSlot: row.traitSlot === 1 ? 1 : 0,
    ivs: row.ivs,
    bonus: row.bonus,
    clean: row.clean,
    signature: row.signature,
    hp: row.hp,
    energy: row.energy,
    moves: row.moves,
    crashed: row.crashed,
    slot: row.slot,
  };
}

function stateFields(d: OwnedDaemonRecord) {
  return { level: d.level, xp: d.xp, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  static connect(databaseUrl: string): PrismaStore {
    return new PrismaStore(createPrisma(databaseUrl));
  }

  async createSeed(subnet: string) {
    for (;;) {
      const row = { id: randomHex(4), seed: randomHex(16), subnet };
      try {
        await this.prisma.subnetSeed.create({ data: row });
        return { id: row.id, seed: row.seed };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    const op = await this.prisma.operator.upsert({
      where: { sub },
      update: {},
      create: { sub, subnet, x: spawn.x, y: spawn.y },
      include: { daemons: { orderBy: { slot: 'asc' } } },
    });
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      x: op.x,
      y: op.y,
      bits: Number(op.bits),
      inventory: (op.inventory ?? {}) as Record<string, number>,
      ram: op.daemons.filter((d) => d.location === 'RAM').map(toRecord),
      diskSlots: op.daemons.filter((d) => d.location === 'DISK').map((d) => d.slot),
    };
  }

  async applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const done = await tx.appliedAction.findUnique({ where: { key: intent.id } });
        if (done) {
          if (intent.kind !== 'load') return { ok: true } as const;
          const row = await tx.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
          return { ok: true, daemon: toRecord(row) } as const;
        }
        await tx.appliedAction.create({ data: { key: intent.id, kind: intent.kind } });
        const now = new Date();
        switch (intent.kind) {
          case 'claimStarter': {
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: { name: intent.name, starterClaimed: true, inventory: intent.inventory },
            });
            const d = intent.daemon;
            await tx.daemon.create({
              data: {
                ...d,
                operatorId: intent.operatorId,
                location: 'RAM',
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'capture': {
            const d = intent.daemon;
            await tx.daemon.create({
              data: {
                ...d,
                operatorId: intent.operatorId,
                location: intent.location,
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            return { ok: true } as const;
          }
          case 'store': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'RAM' },
              data: { ...(ctx.storedDaemon ? stateFields(ctx.storedDaemon) : {}), location: 'DISK', slot: intent.diskSlot },
            });
            if (res.count !== 1) throw new DomainFailure('daemon not found');
            return { ok: true } as const;
          }
          case 'load': {
            const res = await tx.daemon.updateMany({
              where: { id: intent.daemonId, operatorId: intent.operatorId, location: 'DISK' },
              data: { location: 'RAM', slot: intent.ramSlot },
            });
            if (res.count !== 1) throw new DomainFailure('not on Disk');
            const row = await tx.daemon.findUniqueOrThrow({ where: { id: intent.daemonId } });
            return { ok: true, daemon: toRecord(row) } as const;
          }
        }
      });
    } catch (err) {
      if (err instanceof DomainFailure) return { ok: false, reason: err.message };
      if (intent.kind === 'claimStarter' && isUniqueViolation(err)) return { ok: false, reason: 'name taken' };
      throw err;
    }
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const rec of records) {
        await tx.operator.update({
          where: { id: rec.id },
          data: { x: rec.x, y: rec.y, bits: BigInt(rec.bits), inventory: rec.inventory, lastSeenAt: now },
        });
        for (const d of rec.ram) {
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id }, data: stateFields(d) });
        }
      }
    });
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Thrown inside a transaction to roll it back with a domain (non-retryable) reason. */
class DomainFailure extends Error {}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 12 store tests (6 MemoryStore + 6 PrismaStore; the PrismaStore block is skipped when `DATABASE_URL` is unset, so make sure it is set).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): store contract with memory and prisma implementations"
```

---

### Task 3: Token verification

**Files:**
- Create: `apps/sim/src/runtime/auth.ts`
- Test: `apps/sim/test/auth.test.ts`

**Interfaces:**
- Produces: `interface Claims { sub; groups }`, `type TokenVerifier = (token) => Promise<Claims>`, `class AuthError`, `createOidcVerifier({ issuer, audiences, requiredGroup, jwks?, userinfo?, fetch? })`, `createDevVerifier(requiredGroup)`, `combineVerifiers(oidc | null, dev | null)`.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/auth.test.ts`
Expected: FAIL — cannot resolve `../src/runtime/auth.js`.

- [ ] **Step 3: Implement**

`apps/sim/src/runtime/auth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Claims {
  sub: string;
  groups: string[];
}

export type TokenVerifier = (token: string) => Promise<Claims>;

export class AuthError extends Error {}

export interface OidcOptions {
  /** Authentik issuer URL, e.g. https://authentik.wispy-nook.casa/application/o/daemonet-bot/ */
  issuer: string;
  /** Accepted audiences (client ids). */
  audiences: string[];
  requiredGroup: string;
  /** Tests inject keys; production discovers jwks_uri from the issuer. */
  jwks?: JWTVerifyGetKey;
  /** Tests inject userinfo; production calls the discovered userinfo endpoint. */
  userinfo?: (token: string) => Promise<{ groups?: unknown }>;
  fetch?: typeof fetch;
}

interface Discovery {
  jwks_uri: string;
  userinfo_endpoint: string;
}

async function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const res = await fetchImpl(new URL('.well-known/openid-configuration', base));
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  return (await res.json()) as Discovery;
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies Authentik access tokens (JWT): signature via JWKS, issuer, audience, expiry.
 * Group membership comes from the `groups` claim, or from userinfo when the token has none.
 */
export function createOidcVerifier(opts: OidcOptions): TokenVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let discovery: Promise<Discovery> | null = null;
  const getDiscovery = () => (discovery ??= discover(opts.issuer, fetchImpl));
  let jwks: JWTVerifyGetKey | null = opts.jwks ?? null;

  return async (token) => {
    if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri));
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audiences }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      const info = opts.userinfo
        ? await opts.userinfo(token)
        : ((await (await fetchImpl((await getDiscovery()).userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })).json()) as { groups?: unknown });
      groups = asGroups(info.groups) ?? [];
    }
    if (!groups.includes(opts.requiredGroup)) throw new AuthError(`not in ${opts.requiredGroup}`);
    return { sub: payload.sub, groups };
  };
}

/** Development only: `dev:<name>` is accepted as sub `dev-<name>`. */
export function createDevVerifier(requiredGroup: string): TokenVerifier {
  return async (token) => {
    const m = /^dev:([a-z0-9_-]{1,32})$/.exec(token);
    if (!m) throw new AuthError('invalid dev token');
    return { sub: `dev-${m[1]}`, groups: [requiredGroup] };
  };
}

/** Dev tokens go to `dev` (when enabled); everything else to `oidc`. */
export function combineVerifiers(oidc: TokenVerifier | null, dev: TokenVerifier | null): TokenVerifier {
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new AuthError('dev tokens are disabled');
      return dev(token);
    }
    if (!oidc) throw new AuthError('OIDC is not configured');
    return oidc(token);
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (4 auth tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): authentik token verification with dev bypass"
```

---

### Task 4: The `Game` runtime

**Files:**
- Create: `apps/sim/src/runtime/interest.ts`, `apps/sim/src/runtime/game.ts`
- Test: `apps/sim/test/game.test.ts`

**Interfaces:**
- Produces: `diffEntities(known, current): { upserts; removes }`; `interface Conn { id; ip; send(msg); close(code, reason) }`; `interface Logger`; `CLOSE` codes (`auth 4401`, `takeover 4409`, `rate 4429`, `timeout 4408`, `unavailable 4503`, `left 4410`); `class Game { connect(conn); disconnect(conn); message(conn, raw): Promise<void>; tick(); flush(): Promise<void>; shutdown(): Promise<void>; stats() }` with options `{ world, store, verify, seedId, log?, retryDelaysMs?, checkpointEveryTicks?, leaveAfterTicks?, authTimeoutTicks?, idleTimeoutTicks?, maxSpectators? }`.
- Behaviour: first message must be `auth` (5 s / 80 ticks), one controller per operator (a new one kicks the old with `takeover`), up to 4 spectators, `authOk` then `snapshot` (or replayed deltas when resuming with a valid `resumeToken` and a `lastTick` within the 64-tick buffer), a `delta` every tick per connection with changed fields only, replies as `ack`/`err`, 8 commands per tick then `E_RATE`, per-connection token bucket (64, +2/tick), intents persisted with retries (`128/512/2048 ms`) then `completeIntent`, checkpoint every 512 ticks, operator removed 128 ticks after its controller leaves, idle connections closed after 768 ticks, interest radius halves while the average tick exceeds 50 ms.

- [ ] **Step 1: Write the failing tests**

`apps/sim/test/game.test.ts`:

```ts
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { CLOSE, Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage['t']>(t: T) {
    return this.of(t).at(-1);
  }
}

function setup(store = new MemoryStore(), seedId = 'abcd1234') {
  const world = new World({ subnet: TEST_SUBNET, seed: 'game', seedId, spawner: false });
  const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId, retryDelaysMs: [1, 1, 1], leaveAfterTicks: 4 });
  return { world, game, store };
}

async function join(game: Game, name: string, extra: Record<string, unknown> = {}) {
  const conn = new FakeConn();
  game.connect(conn);
  await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}`, ...extra } }));
  return conn;
}

let req = 0;
const cmd = (c: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: `q${++req}`, ...c } });

async function claim(game: Game, conn: FakeConn, name: string, species = 'pingling') {
  await game.message(conn, cmd({ cmd: 'claimStarter', actor: 'self', args: { species, operatorName: name } }));
  game.tick();
  await game.flush();
  game.tick();
}

describe('Game connections', () => {
  it('authenticates with a dev token and sends authOk + snapshot', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    expect(conn.sent.map((m) => m.t)).toEqual(['authOk', 'snapshot']);
    const snap = conn.last('snapshot')!;
    expect(snap.d.self).toMatchObject({ starterClaimed: false, name: null });
    expect(conn.sent.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('rejects bad tokens and anything before auth', async () => {
    const { game } = setup();
    const bad = await join(game, 'Not Valid');
    expect(bad.last('err')!.d.code).toBe('E_AUTH');
    expect(bad.closed?.code).toBe(CLOSE.auth);
    const early = new FakeConn();
    game.connect(early);
    await game.message(early, JSON.stringify({ t: 'ping', seq: 1, d: {} }));
    expect(early.closed?.code).toBe(CLOSE.auth);
  });

  it('times out connections that never authenticate', () => {
    const { game } = setup();
    const conn = new FakeConn();
    game.connect(conn);
    for (let i = 0; i < 82; i++) game.tick();
    expect(conn.closed?.code).toBe(CLOSE.timeout);
  });

  it('claims a starter through the store and persists it', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    const ack = conn.of('ack').at(-1)!;
    expect(ack.d.result).toMatchObject({ daemonId: expect.any(String) });
    const row = [...store.operators.values()][0]!;
    expect(row).toMatchObject({ name: 'alice', starterClaimed: true });
    expect(store.daemons.size).toBe(1);
  });

  it('sends a delta every tick with only changed fields', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    const daemonId = (conn.of('ack').at(-1)!.d.result as { daemonId: string }).daemonId;
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    game.tick();
    game.tick();
    const delta = conn.last('delta')!;
    const me = delta.d.upserts.find((u) => u.kind === 'operator');
    expect(me).toBeDefined();
    expect(Object.keys(me!).sort()).toEqual(['id', 'kind', 'x']);
    expect(daemonId).toBeTruthy();
  });

  it('enforces 8 commands per tick with E_RATE', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    for (let i = 0; i < 10; i++) await game.message(conn, cmd({ cmd: 'stop', actor: 'self', args: {} }));
    expect(conn.of('err').filter((e) => e.d.code === 'E_RATE')).toHaveLength(2);
    game.tick();
    expect(conn.of('ack')).toHaveLength(8);
  });

  it('a second controller takes over; spectators watch but cannot command', async () => {
    const { game } = setup();
    const first = await join(game, 'alice');
    const second = await join(game, 'alice');
    expect(first.closed?.code).toBe(CLOSE.takeover);
    expect(first.last('kick')!.d.reason).toBe('takeover');
    const watcher = await join(game, 'alice', { role: 'spectator' });
    await game.message(watcher, cmd({ cmd: 'stop', actor: 'self', args: {} }));
    expect(watcher.last('err')!.d.code).toBe('E_STATE');
    game.tick();
    expect(second.last('delta')).toBeDefined();
    expect(watcher.last('delta')).toBeDefined();
  });

  it('resumes within 64 ticks by replaying buffered deltas, otherwise snapshots', async () => {
    const { game } = setup();
    const conn = await join(game, 'alice');
    for (let i = 0; i < 5; i++) game.tick();
    const auth = conn.last('authOk')!;
    const seenTick = conn.of('delta')[2]!.d.tick;
    game.disconnect(conn);
    const back = await join(game, 'alice', { resumeToken: auth.d.resumeToken, lastTick: seenTick });
    expect(back.sent.map((m) => m.t)).toEqual(['authOk', 'delta', 'delta']);
    expect(back.of('delta').map((d) => d.d.tick)).toEqual([seenTick + 1, seenTick + 2]);

    game.disconnect(back);
    const stale = await join(game, 'alice', { resumeToken: 'wrong', lastTick: seenTick });
    expect(stale.sent.map((m) => m.t)).toEqual(['authOk', 'snapshot']);
  });

  it('checkpoints and removes the operator after the controller has been gone long enough', async () => {
    const { game, world, store } = setup();
    const conn = await join(game, 'alice');
    await claim(game, conn, 'alice');
    await game.message(conn, cmd({ cmd: 'moveTo', actor: 'self', args: { x: 9.5, y: 4.5 } }));
    for (let i = 0; i < 40; i++) game.tick();
    game.disconnect(conn);
    for (let i = 0; i < 5; i++) game.tick();
    await game.flush();
    expect(world.operators.size).toBe(0);
    const row = [...store.operators.values()][0]!;
    expect(row.x).toBeCloseTo(9.5);
  });

  it('retries failed intent persistence, then succeeds', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    store.failNext = 2;
    await claim(game, conn, 'alice');
    expect(conn.of('ack').at(-1)!.d.result).toMatchObject({ daemonId: expect.any(String) });
  });

  it('reports persist failure after all retries', async () => {
    const { game, store } = setup();
    const conn = await join(game, 'alice');
    store.failNext = 10;
    await claim(game, conn, 'alice');
    expect(conn.last('err')!.d).toMatchObject({ code: 'E_STATE', message: 'persist failed' });
  });
});

describe('restart', () => {
  it('a captured daemon survives a restart with the same store', async () => {
    const store = new MemoryStore();
    const a = setup(store, 'aaaa0001');
    const conn = await join(a.game, 'alice');
    await claim(a.game, conn, 'alice');
    const daemonId = (conn.of('ack').at(-1)!.d.result as { daemonId: string }).daemonId;
    await a.game.shutdown();

    const b = setup(store, 'bbbb0002');
    const again = await join(b.game, 'alice');
    const snap = again.last('snapshot')!;
    expect(snap.d.self.ram.map((d) => d.id)).toEqual([daemonId]);
    expect(snap.d.self.starterClaimed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/sim/test/game.test.ts`
Expected: FAIL — cannot resolve `../src/runtime/game.js`.

- [ ] **Step 3: Implement**

`apps/sim/src/runtime/interest.ts`:

```ts
import type { Entity, EntityPatch } from '@daemonet/shared';

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Diff what a connection already knows against what it should see now.
 * New entities are sent whole; known ones only with changed fields; vanished ones as removes.
 * `known` is updated in place to `current`.
 */
export function diffEntities(known: Map<string, Entity>, current: readonly Entity[]): { upserts: EntityPatch[]; removes: string[] } {
  const upserts: EntityPatch[] = [];
  const seen = new Set<string>();
  for (const e of current) {
    seen.add(e.id);
    const prev = known.get(e.id);
    if (!prev || prev.kind !== e.kind) {
      upserts.push(e);
    } else {
      const patch: Record<string, unknown> = { kind: e.kind, id: e.id };
      let changed = false;
      for (const [key, value] of Object.entries(e)) {
        if (!same((prev as Record<string, unknown>)[key], value)) {
          patch[key] = value;
          changed = true;
        }
      }
      if (changed) upserts.push(patch as EntityPatch);
    }
    known.set(e.id, e);
  }
  const removes: string[] = [];
  for (const id of known.keys()) {
    if (!seen.has(id)) {
      removes.push(id);
      known.delete(id);
    }
  }
  return { upserts, removes };
}
```

`apps/sim/src/runtime/game.ts`:

```ts
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, toSelf, type Input, type Intent, type IntentResult, type World } from '../core/index.js';
import type { TokenVerifier } from './auth.js';
import { diffEntities } from './interest.js';
import { randomHex, type Store } from './store.js';

/** Transport-independent connection. */
export interface Conn {
  readonly id: string;
  readonly ip: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

export const CLOSE = { auth: 4401, takeover: 4409, rate: 4429, timeout: 4408, unavailable: 4503, left: 4410 } as const;

export interface GameOptions {
  world: World;
  store: Store;
  verify: TokenVerifier;
  seedId: string;
  log?: Logger;
  /** Waits between intent persistence attempts (default 128/512/2048 ms). */
  retryDelaysMs?: readonly number[];
  checkpointEveryTicks?: number;
  leaveAfterTicks?: number;
  authTimeoutTicks?: number;
  idleTimeoutTicks?: number;
  maxSpectators?: number;
}

type Role = 'controller' | 'spectator';

interface ConnState {
  conn: Conn;
  seq: number;
  phase: 'new' | 'authing' | 'ready' | 'closed';
  openedTick: number;
  lastSeenTick: number;
  bucket: number;
  sub: string | null;
  operatorId: string | null;
  role: Role | null;
  known: Map<string, Entity>;
  lastSelf: string | null;
}

interface Session {
  operatorId: string;
  sub: string;
  controller: ConnState | null;
  spectators: Set<ConnState>;
  resumeToken: string;
  /** Deltas sent to the controller, for resume. */
  buffer: Array<{ tick: number; msg: Extract<ServerMessage, { t: 'delta' }> }>;
  /** Oldest client tick a resume can continue from (the snapshot tick, or just before the oldest buffered delta). */
  baseTick: number;
  /** What the last controller knew when it went away (resume continues from here). */
  savedKnown: Map<string, Entity> | null;
  savedSelf: string | null;
  commandsThisTick: number;
  violations: number[];
  leaveAtTick: number | null;
}

const BUCKET_MAX = 64;
const BUCKET_REFILL_PER_TICK = 2;
const VIOLATION_WINDOW_TICKS = 1024;
const MAX_VIOLATIONS = 256;
const SLOW_TICK_MS = 50;
const RECOVERED_TICK_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Game {
  readonly world: World;
  private readonly store: Store;
  private readonly verify: TokenVerifier;
  private readonly seedId: string;
  private readonly log: Logger;
  private readonly retryDelays: readonly number[];
  private readonly checkpointEvery: number;
  private readonly leaveAfter: number;
  private readonly authTimeout: number;
  private readonly idleTimeout: number;
  private readonly maxSpectators: number;
  private readonly conns = new Map<string, ConnState>();
  private readonly sessions = new Map<string, Session>();
  private readonly leaving = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();
  private inputs: Input[] = [];
  private radius = INTEREST_RADIUS;
  private readonly tickMs: number[] = [];

  constructor(opts: GameOptions) {
    this.world = opts.world;
    this.store = opts.store;
    this.verify = opts.verify;
    this.seedId = opts.seedId;
    this.log = opts.log ?? silent;
    this.retryDelays = opts.retryDelaysMs ?? [128, 512, 2048];
    this.checkpointEvery = opts.checkpointEveryTicks ?? 512;
    this.leaveAfter = opts.leaveAfterTicks ?? 128;
    this.authTimeout = opts.authTimeoutTicks ?? 80;
    this.idleTimeout = opts.idleTimeoutTicks ?? 768;
    this.maxSpectators = opts.maxSpectators ?? 4;
  }

  // ---- connections ----

  connect(conn: Conn): void {
    const t = this.world.tick;
    this.conns.set(conn.id, {
      conn, seq: 0, phase: 'new', openedTick: t, lastSeenTick: t, bucket: BUCKET_MAX,
      sub: null, operatorId: null, role: null, known: new Map(), lastSelf: null,
    });
  }

  disconnect(conn: Conn): void {
    const st = this.conns.get(conn.id);
    if (!st) return;
    this.detach(st);
  }

  async message(conn: Conn, raw: string): Promise<void> {
    const st = this.conns.get(conn.id);
    if (!st || st.phase === 'closed') return;
    st.lastSeenTick = this.world.tick;
    if (--st.bucket < 0) {
      st.bucket = 0;
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_RATE', message: 'too many messages' } });
      this.violation(st);
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(st, { t: 'err', seq: 0, d: { code: 'E_INVALID', message: parsed.message } });
      if (st.phase === 'new') this.kick(st, 'auth required', CLOSE.auth);
      return;
    }
    const msg = parsed.message;
    if (st.phase === 'new') {
      if (msg.t !== 'auth') return this.kick(st, 'auth required', CLOSE.auth);
      st.phase = 'authing';
      return this.authenticate(st, msg.d);
    }
    if (st.phase !== 'ready') return;
    switch (msg.t) {
      case 'auth':
        return this.error(st, 'E_STATE', 'already authenticated');
      case 'ping':
        return this.send(st, { t: 'pong', seq: 0, d: {} });
      case 'reauth':
        return this.reauth(st, msg.d.token);
      case 'cmd':
        return this.command(st, msg.d);
    }
  }

  private async authenticate(st: ConnState, d: Extract<ClientMessage, { t: 'auth' }>['d']): Promise<void> {
    let claims;
    try {
      claims = await this.verify(d.token);
    } catch (err) {
      this.error(st, 'E_AUTH', (err as Error).message);
      return this.kick(st, 'unauthorized', CLOSE.auth);
    }
    try {
      await this.leaving.get(claims.sub);
      const subnet = this.world.subnet;
      const rec = await this.store.loadOrCreateOperator(claims.sub, subnet.id, subnet.spawn);
      if (st.phase === 'closed') return;
      let session = this.sessions.get(rec.id);
      if (!session) {
        if (!this.world.operators.has(rec.id)) this.world.addOperator(rec);
        session = {
          operatorId: rec.id, sub: claims.sub, controller: null, spectators: new Set(), resumeToken: randomHex(16), buffer: [], baseTick: this.world.tick,
          savedKnown: null, savedSelf: null, commandsThisTick: 0, violations: [], leaveAtTick: null,
        };
        this.sessions.set(rec.id, session);
      }
      st.sub = claims.sub;
      st.operatorId = rec.id;
      if (d.role === 'spectator') {
        if (session.spectators.size >= this.maxSpectators) {
          this.error(st, 'E_STATE', 'too many spectators');
          return this.kick(st, 'too many spectators', CLOSE.rate);
        }
        st.role = 'spectator';
        session.spectators.add(st);
      } else {
        const old = session.controller;
        if (old) {
          session.savedKnown = old.known;
          session.savedSelf = old.lastSelf;
          session.controller = null;
          this.kick(old, 'takeover', CLOSE.takeover);
        }
        st.role = 'controller';
        session.controller = st;
      }
      session.leaveAtTick = null;
      st.phase = 'ready';
      this.send(st, { t: 'authOk', seq: 0, d: { operatorId: rec.id, role: st.role, resumeToken: session.resumeToken, tick: this.world.tick } });
      if (!(st.role === 'controller' && this.tryResume(st, session, d.resumeToken, d.lastTick))) this.snapshot(st);
      this.log.info({ sub: claims.sub, role: st.role, ip: st.conn.ip }, 'operator connected');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'auth: store unavailable');
      this.error(st, 'E_STATE', 'service unavailable');
      this.kick(st, 'unavailable', CLOSE.unavailable);
    }
  }

  private tryResume(st: ConnState, session: Session, token: string | undefined, lastTick: number | undefined): boolean {
    if (token !== session.resumeToken || lastTick === undefined || !session.savedKnown) return false;
    if (lastTick < session.baseTick || lastTick > this.world.tick) return false;
    st.known = new Map(session.savedKnown);
    st.lastSelf = session.savedSelf;
    for (const entry of session.buffer) if (entry.tick > lastTick) this.send(st, entry.msg);
    return true;
  }

  private snapshot(st: ConnState): void {
    const op = this.world.operators.get(st.operatorId!)!;
    const session = this.sessions.get(st.operatorId!)!;
    if (st.role === 'controller') {
      session.buffer = [];
      session.baseTick = this.world.tick;
    }
    const entities = entitiesNear(this.world, op.x, op.y, this.radius);
    const self = toSelf(this.world, op);
    st.known = new Map(entities.map((e) => [e.id, e]));
    st.lastSelf = JSON.stringify(self);
    this.send(st, { t: 'snapshot', seq: 0, d: { tick: this.world.tick, subnet: this.world.subnet.id, self, entities } });
  }

  private async reauth(st: ConnState, token: string): Promise<void> {
    try {
      const claims = await this.verify(token);
      if (claims.sub !== st.sub) throw new Error('token belongs to a different account');
    } catch (err) {
      this.error(st, 'E_AUTH', (err as Error).message);
      this.kick(st, 'unauthorized', CLOSE.auth);
    }
  }

  private command(st: ConnState, d: Extract<ClientMessage, { t: 'cmd' }>['d']): void {
    const { reqId, ...command } = d;
    if (st.role !== 'controller') return this.error(st, 'E_STATE', 'spectators cannot send commands', reqId);
    const session = this.sessions.get(st.operatorId!)!;
    if (session.commandsThisTick >= COMMANDS_PER_TICK) {
      this.error(st, 'E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`, reqId);
      return this.violation(st);
    }
    session.commandsThisTick++;
    this.inputs.push({ operatorId: session.operatorId, reqId, command });
  }

  private violation(st: ConnState): void {
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    const now = this.world.tick;
    session.violations = session.violations.filter((t) => now - t < VIOLATION_WINDOW_TICKS);
    session.violations.push(now);
    if (session.violations.length > MAX_VIOLATIONS) this.kick(st, 'rate limit', CLOSE.rate);
  }

  private send(st: ConnState, msg: ServerMessage): void {
    if (st.phase === 'closed') return;
    st.conn.send({ ...msg, seq: ++st.seq } as ServerMessage);
  }

  private error(st: ConnState, code: ErrorCode, message: string, reqId?: string): void {
    this.send(st, { t: 'err', seq: 0, d: reqId === undefined ? { code, message } : { reqId, code, message } });
  }

  private kick(st: ConnState, reason: string, code: number): void {
    if (st.phase === 'closed') return;
    this.send(st, { t: 'kick', seq: 0, d: { reason } });
    st.conn.close(code, reason);
    this.detach(st);
  }

  private detach(st: ConnState): void {
    if (st.phase === 'closed' && !this.conns.has(st.conn.id)) return;
    st.phase = 'closed';
    this.conns.delete(st.conn.id);
    const session = st.operatorId ? this.sessions.get(st.operatorId) : undefined;
    if (!session) return;
    session.spectators.delete(st);
    if (session.controller === st) {
      session.controller = null;
      session.savedKnown = st.known;
      session.savedSelf = st.lastSelf;
      session.leaveAtTick = this.world.tick + this.leaveAfter;
    }
  }

  // ---- the tick ----

  tick(): void {
    const t0 = performance.now();
    const world = this.world;
    for (const st of [...this.conns.values()]) {
      st.bucket = Math.min(BUCKET_MAX, st.bucket + BUCKET_REFILL_PER_TICK);
      if (st.phase !== 'ready' && world.tick - st.openedTick > this.authTimeout) this.kick(st, 'auth timeout', CLOSE.timeout);
      else if (st.phase === 'ready' && world.tick - st.lastSeenTick > this.idleTimeout) this.kick(st, 'idle', CLOSE.timeout);
    }

    const result = world.step(this.inputs);
    this.inputs = [];
    for (const s of this.sessions.values()) s.commandsThisTick = 0;

    for (const r of result.replies) {
      const st = this.sessions.get(r.operatorId)?.controller;
      if (!st) continue;
      if (r.ok) this.send(st, { t: 'ack', seq: 0, d: r.result === undefined ? { reqId: r.reqId } : { reqId: r.reqId, result: r.result } });
      else this.error(st, r.code, r.message, r.reqId);
    }
    for (const intent of result.intents) this.persist(intent);

    for (const session of this.sessions.values()) {
      const op = world.operators.get(session.operatorId);
      if (!op) continue;
      const events = result.events
        .filter((e) => (e.to === null ? e.at === null || distance(e.at, op) <= this.radius : e.to === op.id))
        .map((e) => e.event);
      const near = entitiesNear(world, op.x, op.y, this.radius);
      const self = toSelf(world, op);
      const selfJson = JSON.stringify(self);
      const targets = session.controller ? [session.controller, ...session.spectators] : [...session.spectators];
      for (const st of targets) {
        const { upserts, removes } = diffEntities(st.known, near);
        const selfChanged = selfJson !== st.lastSelf;
        st.lastSelf = selfJson;
        const msg: Extract<ServerMessage, { t: 'delta' }> = {
          t: 'delta', seq: 0, d: selfChanged ? { tick: result.tick, upserts, removes, events, self } : { tick: result.tick, upserts, removes, events },
        };
        this.send(st, msg);
        if (st === session.controller) {
          session.buffer.push({ tick: result.tick, msg });
          if (session.buffer.length > RESUME_TICKS) session.baseTick = session.buffer.shift()!.tick;
        }
      }
    }

    if (result.tick % this.checkpointEvery === 0) this.checkpointAll();
    for (const session of [...this.sessions.values()]) {
      if (!session.controller && session.leaveAtTick !== null && session.leaveAtTick <= result.tick) this.leave(session);
    }

    const ms = performance.now() - t0;
    this.tickMs.push(ms);
    if (this.tickMs.length > 1024) this.tickMs.shift();
    const recent = this.tickMs.slice(-16);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > SLOW_TICK_MS && this.radius !== INTEREST_RADIUS / 2) {
      this.radius = INTEREST_RADIUS / 2;
      this.log.warn({ avgMs: avg }, 'slow ticks: shrinking interest radius');
    } else if (avg < RECOVERED_TICK_MS) {
      this.radius = INTEREST_RADIUS;
    }
  }

  private leave(session: Session): void {
    const record = this.world.checkpoint(session.operatorId);
    this.world.removeOperator(session.operatorId);
    this.sessions.delete(session.operatorId);
    for (const st of [...session.spectators]) this.kick(st, 'operator left', CLOSE.left);
    const done = this.store
      .checkpoint([record])
      .catch((err: Error) => this.log.error({ sub: session.sub, err: err.message }, 'leave checkpoint failed'))
      .finally(() => this.leaving.delete(session.sub));
    this.leaving.set(session.sub, done);
    this.track(done);
    this.log.info({ sub: session.sub }, 'operator left');
  }

  private checkpointAll(): void {
    const records = [...this.world.operators.keys()].map((id) => this.world.checkpoint(id));
    this.track(this.store.checkpoint(records).catch((err: Error) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  private persist(intent: Intent): void {
    const stored = intent.kind === 'store' ? this.world.daemons.get(intent.daemonId) : undefined;
    const ctx = { seedId: this.seedId, ...(stored ? { storedDaemon: this.world.toRecord(stored) } : {}) };
    const run = async () => {
      let result: IntentResult = { ok: false, reason: 'persist failed' };
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        try {
          result = await this.store.applyIntent(intent, ctx);
          break;
        } catch (err) {
          this.log.warn({ intent: intent.id, attempt, err: (err as Error).message }, 'intent persist failed');
          const delay = this.retryDelays[attempt];
          if (delay === undefined) break;
          await sleep(delay);
        }
      }
      this.world.completeIntent(intent.id, result);
    };
    this.track(run());
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => {},
      () => {},
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  /** Resolves when all in-flight persistence has settled. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Checkpoint everyone and wait for persistence. */
  async shutdown(): Promise<void> {
    for (const st of [...this.conns.values()]) this.kick(st, 'server shutting down', 1001);
    this.checkpointAll();
    await this.flush();
  }

  stats(): { p50: number; p99: number; max: number; radius: number } {
    const sorted = [...this.tickMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0, radius: this.radius };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (12 game tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sim): game runtime with sessions, deltas, resume and persistence"
```

---

### Task 5: WebSocket server, loop, config and entry point

**Files:**
- Create: `apps/sim/src/runtime/loop.ts`, `apps/sim/src/runtime/server.ts`, `apps/sim/src/runtime/config.ts`, `apps/sim/src/runtime/main.ts`

**Interfaces:**
- Produces: `startLoop(tick, intervalMs = 62.5): stop`, `startServer({ game, store, port, host?, trustProxyHops, maxConnectionsPerIp?, log }): Promise<{ port; close() }>`, `clientIp(req, hops)`, `loadConfig(env?)` → `{ nodeEnv, port, databaseUrl, oidc | null, requiredGroup, devBypass, trustProxyHops, subnet, logLevel }`.
- HTTP: `GET /ws/ready` → 200 when `SELECT 1` succeeds, 503 otherwise; upgrades only on `/ws`; at most 16 sockets per client IP (429).
- Env: `DATABASE_URL`, `PORT` (3000), `AUTHENTIK_ISSUER_URL`, `AUTHENTIK_BOT_CLIENT_ID`, `AUTH_REQUIRED_GROUP` (`daemonet-users`), `AUTH_DEV_BYPASS` (`false`), `TRUST_PROXY_HOPS` (0), `SUBNET` (`lo`), `LOG_LEVEL` (`info`), `NODE_ENV`.

- [ ] **Step 1: Implement**

`apps/sim/src/runtime/loop.ts`:

```ts
import { TICK_MS } from '@daemonet/rules';

const MAX_CATCH_UP = 4;

/**
 * Fixed-timestep loop, drift-corrected against performance.now().
 * If the process falls more than MAX_CATCH_UP ticks behind it skips ahead instead of spiralling.
 * Returns a stop function.
 */
export function startLoop(tick: () => void, intervalMs: number = TICK_MS): () => void {
  let next = performance.now() + intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    let ran = 0;
    while (performance.now() >= next && ran < MAX_CATCH_UP) {
      tick();
      next += intervalMs;
      ran++;
    }
    if (performance.now() >= next) next = performance.now() + intervalMs;
    timer = setTimeout(run, Math.max(0, next - performance.now()));
  };
  timer = setTimeout(run, intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
```

`apps/sim/src/runtime/server.ts`:

```ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SUBMIT_BYTES } from '@daemonet/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Conn, Game, Logger } from './game.js';
import type { Store } from './store.js';

export interface ServerOptions {
  game: Game;
  store: Store;
  port: number;
  host?: string;
  /** Number of trusted reverse proxies in front of the sim (Caddy, nginx, cloudflared = 3). */
  trustProxyHops: number;
  maxConnectionsPerIp?: number;
  log: Logger;
}

/** Same rule as proxy-addr with a hop count: walk back `hops` entries from the socket address. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const addrs = [req.socket.remoteAddress ?? 'unknown', ...forwarded.reverse()];
  return addrs[Math.min(hops, addrs.length - 1)]!;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnectionsPerIp ?? 16;
  const sockets = new Set<WebSocket>();

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ws/ready') {
      opts.store.ping().then(
        () => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'),
        () => res.writeHead(503, { 'content-type': 'text/plain' }).end('db unavailable'),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SUBMIT_BYTES + 1024 });

  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req, opts.trustProxyHops);
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      sockets.add(ws);
      const conn: Conn = {
        id: crypto.randomUUID(),
        ip,
        send: (msg) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        close: (code, reason) => ws.close(code, reason),
      };
      opts.game.connect(conn);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return ws.close(1003, 'text frames only');
        opts.game.message(conn, data.toString()).catch((err: Error) => opts.log.error({ err: err.message }, 'message handler failed'));
      });
      ws.on('close', () => {
        sockets.delete(ws);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
        opts.game.disconnect(conn);
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host ?? '0.0.0.0', resolve));
  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
```

`apps/sim/src/runtime/config.ts`:

```ts
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  AUTHENTIK_ISSUER_URL: z.url().optional(),
  AUTHENTIK_BOT_CLIENT_ID: z.string().min(1).optional(),
  AUTH_REQUIRED_GROUP: z.string().min(1).default('daemonet-users'),
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  SUBNET: z.string().default('lo'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  oidc: { issuer: string; clientId: string } | null;
  requiredGroup: string;
  devBypass: boolean;
  trustProxyHops: number;
  subnet: string;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  const devBypass = e.AUTH_DEV_BYPASS === 'true';
  if (devBypass && e.NODE_ENV === 'production') throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  const oidc = e.AUTHENTIK_ISSUER_URL && e.AUTHENTIK_BOT_CLIENT_ID ? { issuer: e.AUTHENTIK_ISSUER_URL, clientId: e.AUTHENTIK_BOT_CLIENT_ID } : null;
  if (!oidc && !devBypass) throw new Error('set AUTHENTIK_ISSUER_URL and AUTHENTIK_BOT_CLIENT_ID (or AUTH_DEV_BYPASS=true outside production)');
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    oidc,
    requiredGroup: e.AUTH_REQUIRED_GROUP,
    devBypass,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    subnet: e.SUBNET,
    logLevel: e.LOG_LEVEL,
  };
}
```

`apps/sim/src/runtime/main.ts`:

```ts
import { getSubnet } from '@daemonet/rules';
import { pino } from 'pino';
import { World } from '../core/index.js';
import { combineVerifiers, createDevVerifier, createOidcVerifier } from './auth.js';
import { loadConfig } from './config.js';
import { Game } from './game.js';
import { startLoop } from './loop.js';
import { PrismaStore } from './prisma-store.js';
import { startServer } from './server.js';

const config = loadConfig();
const log = pino({ level: config.logLevel });

const store = PrismaStore.connect(config.databaseUrl);
await store.ping();
const subnet = getSubnet(config.subnet);
const seed = await store.createSeed(subnet.id);
const world = new World({ subnet, seed: seed.seed, seedId: seed.id });

const verify = combineVerifiers(
  config.oidc
    ? createOidcVerifier({ issuer: config.oidc.issuer, audiences: [config.oidc.clientId], requiredGroup: config.requiredGroup })
    : null,
  config.devBypass ? createDevVerifier(config.requiredGroup) : null,
);

const game = new Game({ world, store, verify, seedId: seed.id, log });
const server = await startServer({ game, store, port: config.port, trustProxyHops: config.trustProxyHops, log });
const stopLoop = startLoop(() => game.tick());
const statsTimer = setInterval(() => log.info({ tick: world.tick, ...game.stats() }, 'tick stats'), 64_000);

log.info({ port: server.port, subnet: subnet.id, seedId: seed.id, devBypass: config.devBypass }, 'daemonet sim started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  stopLoop();
  clearInterval(statsTimer);
  await game.shutdown();
  await server.close();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 2: Build and smoke-test the real server**

```bash
pnpm build
AUTH_DEV_BYPASS=true PORT=3000 node apps/sim/dist/runtime/main.js
```

In another shell: `curl -i http://127.0.0.1:3000/ws/ready`
Expected: the sim logs `daemonet sim started` with `devBypass: true`; curl returns `200 ok`. Stop the server with Ctrl+C (it logs `shutting down` and exits 0).

- [ ] **Step 3: Confirm production refuses the dev bypass**

Run: `NODE_ENV=production AUTH_DEV_BYPASS=true node apps/sim/dist/runtime/main.js`
Expected: exits with `AUTH_DEV_BYPASS must not be enabled in production`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(sim): websocket server, tick loop, config and entry point"
```

---

### Task 6: `@daemonet/sdk` — client, world mirror and scripts

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/src/auth.ts`, `packages/sdk/src/errors.ts`, `packages/sdk/src/views.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`
- Modify: `tsconfig.json` (already references `packages/sdk` from Task 1)
- Test: `packages/sdk/test/sdk.test.ts` (the `Query` part; Task 7 adds device login)

**Interfaces:**
- Produces: `connect(opts): Promise<GameClient>`, `GameClient { tick; operatorId; self; entities; world: WorldView; operator: OperatorApi; daemons: DaemonsApi; on(name, handler); command(cmd); close(); dropConnection() }`, `WorldView { daemons; wild; operators; get(id) }` (queries relative to your operator), `Query<T> { length; all(); filter(); within(r); nearest(pred?); lowestHp(pred?) }`, `DaemonHandle { id; ram; entity; x; y; hpPct; energy; distanceTo(); canUse(move); bestMoveAgainst(foe); moveTo(); stop(); use(move, target | {x, y}) }`, `OperatorApi` (one method per command + `script(fn)`), `DaemonsApi { get(id); script(fn) }`, `devToken(name)`, `staticToken(token)`, `DaemonetError(code, message)`, and re-exported challenge/protocol types.
- Events: every `GameEvent` by its `e` name, plus `tick`, `ready`, `error`, `kick`, `disconnect`, `reconnect`, `scriptError`.

- [ ] **Step 1: Create the package shell**

`packages/sdk/package.json`:

```json
{
  "name": "@daemonet/sdk",
  "version": "0.0.0",
  "private": true,
  "description": "Daemonet player SDK: connect, mirror the world, and script your operator and daemons.",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "default": "./dist/node.js" }
  },
  "files": ["dist"],
  "dependencies": {
    "@daemonet/rules": "workspace:*",
    "@daemonet/shared": "workspace:*"
  }
}
```

`packages/sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "lib": ["ES2023", "DOM"] },
  "include": ["src"],
  "references": [{ "path": "../rules" }, { "path": "../shared" }]
}
```

- [ ] **Step 2: Write the failing Query test**

`packages/sdk/test/sdk.test.ts` (Task 7 appends the device-login block):

```ts
import { describe, expect, it } from 'vitest';
import { Query } from '../src/views.js';

describe('Query', () => {
  const items = [
    { id: 'a', x: 0, y: 0, hp: 10 },
    { id: 'b', x: 3, y: 4, hp: 2 },
    { id: 'c', x: 10, y: 0, hp: 5 },
  ];
  const q = new Query(items, { x: 1, y: 0 });

  it('finds nearest, lowest HP, and filters by radius', () => {
    expect(q.nearest()!.id).toBe('a');
    expect(q.nearest((i) => i.id !== 'a')!.id).toBe('b');
    expect(q.lowestHp()!.id).toBe('b');
    expect(q.within(5).all().map((i) => i.id)).toEqual(['a', 'b']);
    expect(q.filter((i) => i.hp > 100).nearest()).toBeUndefined();
    expect(q.length).toBe(3);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm install
pnpm vitest run packages/sdk/test/sdk.test.ts
```

Expected: FAIL — cannot resolve `../src/views.js`.

- [ ] **Step 4: Implement**

`packages/sdk/src/auth.ts`:

```ts
/** Supplies access tokens to the client. */
export interface TokenSource {
  getToken(): Promise<string>;
  /** Called with a fresh token whenever the source refreshes; returns an unsubscribe function. */
  onRefresh?(listener: (token: string) => void): () => void;
}

/** Local development servers with AUTH_DEV_BYPASS=true accept `dev:<name>`. */
export function devToken(name: string): TokenSource {
  return { getToken: async () => `dev:${name}` };
}

export function staticToken(token: string): TokenSource {
  return { getToken: async () => token };
}
```

`packages/sdk/src/errors.ts`:

```ts
import type { ErrorCode } from '@daemonet/shared';

/** A rejected command or server error. `code` is one of the protocol error codes. */
export class DaemonetError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DaemonetError';
  }
}
```

`packages/sdk/src/views.ts`:

```ts
import type { Entity } from '@daemonet/shared';

export type DaemonEntity = Extract<Entity, { kind: 'daemon' }>;
export type OperatorEntity = Extract<Entity, { kind: 'operator' }>;
/** A daemon as scripts see it: the protocol entity plus a convenience `hpPct` (0-1). */
export type DaemonView = DaemonEntity & { hpPct: number };

export interface Positioned {
  x: number;
  y: number;
}

export const distance = (a: Positioned, b: Positioned): number => Math.hypot(a.x - b.x, a.y - b.y);

export const viewOf = (e: DaemonEntity): DaemonView => ({ ...e, hpPct: e.maxHp > 0 ? e.hp / e.maxHp : 0 });

/** Small immutable query helper over positioned entities, relative to an origin. */
export class Query<T extends Positioned & { hp?: number }> {
  constructor(
    private readonly items: readonly T[],
    private readonly origin: Positioned,
  ) {}

  get length(): number {
    return this.items.length;
  }

  all(): T[] {
    return [...this.items];
  }

  filter(pred: (item: T) => boolean): Query<T> {
    return new Query(this.items.filter(pred), this.origin);
  }

  within(radius: number): Query<T> {
    return this.filter((i) => distance(i, this.origin) <= radius);
  }

  nearest(pred: (item: T) => boolean = () => true): T | undefined {
    let best: T | undefined;
    let bestDist = Infinity;
    for (const i of this.items) {
      if (!pred(i)) continue;
      const d = distance(i, this.origin);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  }

  lowestHp(pred: (item: T) => boolean = () => true): T | undefined {
    let best: T | undefined;
    for (const i of this.items) if (pred(i) && (best === undefined || (i.hp ?? Infinity) < (best.hp ?? Infinity))) best = i;
    return best;
  }
}
```

`packages/sdk/src/client.ts`:

```ts
import { getMove, typeMultiplier, type ToolId } from '@daemonet/rules';
import {
  COMMANDS_PER_TICK,
  HEARTBEAT_MS,
  ServerMessage,
  type Command,
  type Entity,
  type GameEvent,
  type OperatorSelf,
  type RamDaemon,
} from '@daemonet/shared';
import type { TokenSource } from './auth.js';
import { DaemonetError } from './errors.js';
import { Query, distance, viewOf, type DaemonEntity, type DaemonView, type OperatorEntity, type Positioned } from './views.js';

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ConnectOptions {
  /** e.g. wss://daemonet.wispy-nook.casa/ws */
  url: string;
  auth: TokenSource;
  role?: 'controller' | 'spectator';
  /** Defaults to the global WebSocket (browsers, Node 22+). */
  WebSocket?: WebSocketCtor;
  /** Reconnect with resume after unexpected disconnects (default true). */
  reconnect?: boolean;
  commandTimeoutMs?: number;
  heartbeatMs?: number;
}

type ClientEvents = {
  [K in GameEvent['e']]: Extract<GameEvent, { e: K }>;
} & {
  tick: number;
  ready: void;
  error: DaemonetError;
  kick: string;
  disconnect: { code: number; reason: string };
  reconnect: void;
  scriptError: unknown;
};

export interface Target extends Positioned {
  id: string;
}

type Aim = Target | { x: number; y: number };

export interface OperatorScriptContext {
  client: GameClient;
  me: OperatorSelf;
  world: WorldView;
  tick: number;
}

export interface DaemonScriptContext {
  client: GameClient;
  self: DaemonHandle;
  /** Wild daemons you may attack (untagged or tagged by you) within 16 tiles of this daemon. */
  enemies: Query<DaemonView>;
  world: WorldView;
  tick: number;
}

const BACKOFF_MIN_MS = 256;
const BACKOFF_MAX_MS = 8192;
const ENEMY_RADIUS = 16;

export class WorldView {
  constructor(private readonly client: GameClient) {}

  private origin(): Positioned {
    return this.client.self;
  }

  /** Every daemon in view. */
  get daemons(): Query<DaemonView> {
    const all = [...this.client.entities.values()].filter((e): e is DaemonEntity => e.kind === 'daemon').map(viewOf);
    return new Query(all, this.origin());
  }

  /** Wild daemons in view, relative to your operator. */
  get wild(): Query<DaemonView> {
    return this.daemons.filter((d) => d.owner === null);
  }

  get operators(): Query<OperatorEntity> {
    const ops = [...this.client.entities.values()].filter((e): e is OperatorEntity => e.kind === 'operator');
    return new Query(ops, this.origin());
  }

  get(id: string): Entity | undefined {
    return this.client.entities.get(id);
  }
}

export class DaemonHandle {
  constructor(
    private readonly client: GameClient,
    readonly id: string,
  ) {}

  get ram(): RamDaemon | undefined {
    return this.client.self.ram.find((d) => d.id === this.id);
  }

  get entity(): DaemonView | undefined {
    const e = this.client.entities.get(this.id);
    return e?.kind === 'daemon' ? viewOf(e) : undefined;
  }

  get x(): number {
    return this.entity?.x ?? this.client.self.x;
  }

  get y(): number {
    return this.entity?.y ?? this.client.self.y;
  }

  get hpPct(): number {
    const r = this.ram;
    return r && r.maxHp > 0 ? r.hp / r.maxHp : 0;
  }

  get energy(): number {
    return this.ram?.energy ?? 0;
  }

  distanceTo(target: Positioned): number {
    return distance(this, target);
  }

  /** Known, off cooldown and affordable. */
  canUse(moveId: string): boolean {
    const r = this.ram;
    if (!r || !r.moves.includes(moveId)) return false;
    return (r.cooldowns[moveId] ?? 0) <= this.client.tick && r.energy >= getMove(moveId).energyCost;
  }

  /** The strongest usable move that can reach `foe` and is not immune, or null. */
  bestMoveAgainst(foe: DaemonEntity): string | null {
    const r = this.ram;
    const me = this.entity;
    if (!r || !me) return null;
    const dist = this.distanceTo(foe);
    let best: { id: string; score: number } | null = null;
    for (const id of r.moves) {
      if (!this.canUse(id)) continue;
      const m = getMove(id);
      const reach = m.shape.kind === 'cone' ? m.shape.length : m.range;
      if (dist > reach) continue;
      const score = m.power * typeMultiplier(m.type, foe.types) * (me.types.includes(m.type) ? 1.5 : 1);
      if (score > 0 && (!best || score > best.score)) best = { id, score };
    }
    return best?.id ?? null;
  }

  moveTo(x: number, y: number): Promise<unknown> {
    return this.client.command({ cmd: 'moveTo', actor: this.id, args: { x, y } });
  }

  stop(): Promise<unknown> {
    return this.client.command({ cmd: 'stop', actor: this.id, args: {} });
  }

  use(moveId: string, aim: Aim): Promise<unknown> {
    const args = 'id' in aim ? { move: moveId, targetId: aim.id } : { move: moveId, x: aim.x, y: aim.y };
    return this.client.command({ cmd: 'use', actor: this.id, args });
  }
}

export class OperatorApi {
  constructor(private readonly client: GameClient) {}

  moveTo(x: number, y: number) {
    return this.client.command({ cmd: 'moveTo', actor: 'self', args: { x, y } });
  }
  stop() {
    return this.client.command({ cmd: 'stop', actor: 'self', args: {} });
  }
  run(daemonId: string) {
    return this.client.command({ cmd: 'run', actor: 'self', args: { daemonId } });
  }
  recall(daemonId: string) {
    return this.client.command({ cmd: 'recall', actor: 'self', args: { daemonId } });
  }
  swap(outId: string, inId: string) {
    return this.client.command({ cmd: 'swap', actor: 'self', args: { outId, inId } });
  }
  capture(target: Target | string, tool: ToolId) {
    return this.client.command({ cmd: 'capture', actor: 'self', args: { targetId: typeof target === 'string' ? target : target.id, tool } });
  }
  submitCapture(captureId: string, answer: unknown) {
    return this.client.command({ cmd: 'submitCapture', actor: 'self', args: { captureId, answer } });
  }
  useRestore(daemonId: string) {
    return this.client.command({ cmd: 'useItem', actor: 'self', args: { item: 'restore', daemonId } });
  }
  restoreAll() {
    return this.client.command({ cmd: 'restoreAll', actor: 'self', args: {} });
  }
  claimStarter(species: string, operatorName: string) {
    return this.client.command({ cmd: 'claimStarter', actor: 'self', args: { species, operatorName } });
  }
  store(daemonId: string) {
    return this.client.command({ cmd: 'store', actor: 'self', args: { daemonId } });
  }
  load(daemonId: string) {
    return this.client.command({ cmd: 'load', actor: 'self', args: { daemonId } });
  }

  /** Runs `fn` once per tick after the world update. Returns an unsubscribe function. */
  script(fn: (ctx: OperatorScriptContext) => void): () => void {
    return this.client.addScript(() => fn({ client: this.client, me: this.client.self, world: this.client.world, tick: this.client.tick }));
  }
}

export class DaemonsApi {
  constructor(private readonly client: GameClient) {}

  get(id: string): DaemonHandle {
    return new DaemonHandle(this.client, id);
  }

  /** Runs `fn` once per tick for each running daemon. Returns an unsubscribe function. */
  script(fn: (ctx: DaemonScriptContext) => void): () => void {
    return this.client.addScript(() => {
      const me = this.client.self;
      for (const id of me.running) {
        const self = new DaemonHandle(this.client, id);
        const enemies = new Query(
          this.client.world.wild.all().filter((d) => d.taggedBy === null || d.taggedBy === me.id),
          self,
        ).within(ENEMY_RADIUS);
        fn({ client: this.client, self, enemies, world: this.client.world, tick: this.client.tick });
      }
    });
  }
}

export class GameClient {
  tick = 0;
  operatorId = '';
  self!: OperatorSelf;
  readonly entities = new Map<string, Entity>();
  readonly world = new WorldView(this);
  readonly operator = new OperatorApi(this);
  readonly daemons = new DaemonsApi(this);

  private ws: WebSocketLike | null = null;
  private readonly Ws: WebSocketCtor;
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  private readonly scripts = new Set<() => void>();
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: DaemonetError) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqCounter = 0;
  private seq = 0;
  private sentThisTick = 0;
  private resumeToken: string | undefined;
  private hasState = false;
  private closedByUser = false;
  private noReconnect = false;
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ready!: { resolve: () => void; reject: (e: Error) => void };
  private readonly unsubscribeRefresh: (() => void) | undefined;

  constructor(private readonly opts: ConnectOptions) {
    const Ws = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ws) throw new Error('No WebSocket implementation available; pass options.WebSocket');
    this.Ws = Ws;
    this.unsubscribeRefresh = opts.auth.onRefresh?.((token) => this.sendRaw({ t: 'reauth', seq: ++this.seq, d: { token } }));
  }

  /** Opens the connection; resolves after the first world state arrives. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
      void this.open();
    });
  }

  on<K extends keyof ClientEvents>(name: K, handler: (value: ClientEvents[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(handler as (v: unknown) => void);
    return () => set.delete(handler as (v: unknown) => void);
  }

  /** @internal */
  addScript(run: () => void): () => void {
    this.scripts.add(run);
    return () => this.scripts.delete(run);
  }

  /** Sends a command; resolves with the ack result or rejects with a DaemonetError. */
  command(command: Command): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.sentThisTick >= COMMANDS_PER_TICK) {
        reject(new DaemonetError('E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`));
        return;
      }
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new DaemonetError('E_STATE', 'not connected'));
        return;
      }
      this.sentThisTick++;
      const reqId = `c${++this.reqCounter}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DaemonetError('E_STATE', 'command timed out'));
      }, this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.sendRaw({ t: 'cmd', seq: ++this.seq, d: { reqId, ...command } });
    });
    // Scripts often fire-and-forget; avoid unhandled-rejection noise while still letting callers await.
    promise.catch(() => {});
    return promise;
  }

  close(): void {
    this.closedByUser = true;
    this.unsubscribeRefresh?.();
    this.stopHeartbeat();
    this.ws?.close(1000, 'client closed');
  }

  /** Testing aid: drop the socket as if the network failed (the client reconnects and resumes). */
  dropConnection(): void {
    this.ws?.close(4000, 'dropped');
  }

  private emit<K extends keyof ClientEvents>(name: K, value: ClientEvents[K]): void {
    for (const h of this.listeners.get(name) ?? []) {
      try {
        h(value);
      } catch (err) {
        if (name !== 'scriptError') this.emit('scriptError', err);
      }
    }
  }

  private sendRaw(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private async open(): Promise<void> {
    let token: string;
    try {
      token = await this.opts.auth.getToken();
    } catch (err) {
      this.ready.reject(err as Error);
      return;
    }
    const ws = new this.Ws(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      const d: Record<string, unknown> = { token, role: this.opts.role ?? 'controller' };
      if (this.resumeToken && this.hasState) {
        d.resumeToken = this.resumeToken;
        d.lastTick = this.tick;
      }
      this.sendRaw({ t: 'auth', seq: ++this.seq, d });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onerror = () => {};
    ws.onclose = (ev) => this.closed(ws, ev.code, ev.reason);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.sendRaw({ t: 'ping', seq: ++this.seq, d: {} }), this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private closed(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.stopHeartbeat();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DaemonetError('E_STATE', 'disconnected'));
      this.pending.delete(id);
    }
    this.emit('disconnect', { code, reason });
    if (this.closedByUser || this.noReconnect || this.opts.reconnect === false) {
      if (!this.hasState) this.ready.reject(new Error(`connection closed: ${code} ${reason}`));
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts++);
    setTimeout(() => {
      if (!this.closedByUser) void this.open();
    }, delay);
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = ServerMessage.parse(JSON.parse(raw));
    } catch {
      return;
    }
    switch (msg.t) {
      case 'authOk':
        this.operatorId = msg.d.operatorId;
        this.resumeToken = msg.d.resumeToken;
        if (this.attempts > 0) this.emit('reconnect', undefined);
        this.attempts = 0;
        return;
      case 'snapshot': {
        this.tick = msg.d.tick;
        this.self = msg.d.self;
        this.entities.clear();
        for (const e of msg.d.entities) this.entities.set(e.id, e);
        this.hasState = true;
        this.ready.resolve();
        this.emit('ready', undefined);
        return;
      }
      case 'delta': {
        this.tick = msg.d.tick;
        for (const id of msg.d.removes) this.entities.delete(id);
        for (const patch of msg.d.upserts) {
          const prev = this.entities.get(patch.id);
          this.entities.set(patch.id, prev && prev.kind === patch.kind ? ({ ...prev, ...patch } as Entity) : (patch as Entity));
        }
        if (msg.d.self) this.self = msg.d.self;
        this.sentThisTick = 0;
        for (const ev of msg.d.events) this.emit(ev.e, ev as never);
        this.emit('tick', this.tick);
        for (const run of this.scripts) {
          try {
            run();
          } catch (err) {
            this.emit('scriptError', err);
          }
        }
        return;
      }
      case 'ack': {
        const p = this.pending.get(msg.d.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.d.reqId);
        p.resolve(msg.d.result);
        return;
      }
      case 'err': {
        const error = new DaemonetError(msg.d.code, msg.d.message);
        const p = msg.d.reqId ? this.pending.get(msg.d.reqId) : undefined;
        if (p && msg.d.reqId) {
          clearTimeout(p.timer);
          this.pending.delete(msg.d.reqId);
          p.reject(error);
        } else {
          this.emit('error', error);
        }
        return;
      }
      case 'kick':
        if (['takeover', 'unauthorized', 'rate limit'].includes(msg.d.reason)) this.noReconnect = true;
        this.emit('kick', msg.d.reason);
        return;
      case 'pong':
        return;
    }
  }
}

/** Connects and resolves once the first world snapshot has arrived. */
export async function connect(opts: ConnectOptions): Promise<GameClient> {
  const client = new GameClient(opts);
  await client.start();
  return client;
}

export type { DaemonView, DaemonEntity, OperatorEntity };
```

`packages/sdk/src/index.ts`:

```ts
export { connect, GameClient, WorldView, DaemonHandle, OperatorApi, DaemonsApi } from './client.js';
export type { ConnectOptions, OperatorScriptContext, DaemonScriptContext, Target, DaemonView, DaemonEntity, OperatorEntity } from './client.js';
export { devToken, staticToken, type TokenSource } from './auth.js';
export { DaemonetError } from './errors.js';
export { Query, distance } from './views.js';
export type {
  PublicChallenge,
  PacketParams,
  PacketPayload,
  PacketFragment,
  PacketAnswer,
  CryptoParams,
  CryptoPayload,
  CryptoAnswer,
  GlitchParams,
  GlitchPayload,
  GlitchAnswer,
  NullParams,
  NullPayload,
  NullAnswer,
  ChainPayload,
  ToolId,
  TypeId,
} from '@daemonet/rules';
export type { GameEvent, OperatorSelf, RamDaemon, Entity } from '@daemonet/shared';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. (`pnpm typecheck` builds `packages/sdk`; `node.ts` does not exist yet, so the `./node` export is dangling until Task 7 — `tsc` does not check package exports.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sdk): client with world mirror, scripts and commands"
```

---

### Task 7: Device-flow login (`@daemonet/sdk/node`)

**Files:**
- Create: `packages/sdk/src/node.ts`
- Test: `packages/sdk/test/sdk.test.ts` (append)

**Interfaces:**
- Produces: `deviceLogin({ issuer, clientId, scope?, cacheFile?, print?, fetch?, sleep?, now? }): Promise<TokenSource>` — RFC 8628 device authorization against Authentik; caches `{ accessToken, refreshToken, expiresAt }` at `cacheFile` with mode 0600; refreshes 60 s before expiry and notifies `onRefresh` listeners (the client sends `reauth`). `@daemonet/sdk/node` re-exports everything from `@daemonet/sdk`.

- [ ] **Step 1: Append the failing device-login tests**

Replace `packages/sdk/test/sdk.test.ts` with:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceLogin } from '../src/node.js';
import { Query } from '../src/views.js';

describe('Query', () => {
  const items = [
    { id: 'a', x: 0, y: 0, hp: 10 },
    { id: 'b', x: 3, y: 4, hp: 2 },
    { id: 'c', x: 10, y: 0, hp: 5 },
  ];
  const q = new Query(items, { x: 1, y: 0 });

  it('finds nearest, lowest HP, and filters by radius', () => {
    expect(q.nearest()!.id).toBe('a');
    expect(q.nearest((i) => i.id !== 'a')!.id).toBe('b');
    expect(q.lowestHp()!.id).toBe('b');
    expect(q.within(5).all().map((i) => i.id)).toEqual(['a', 'b']);
    expect(q.filter((i) => i.hp > 100).nearest()).toBeUndefined();
    expect(q.length).toBe(3);
  });
});

describe('deviceLogin', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  /** Minimal fake Authentik: discovery, device endpoint, token endpoint (pending twice, then tokens), refresh. */
  async function fakeIdp() {
    let polls = 0;
    const calls: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const json = (status: number, obj: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
        const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
        if (req.url === '/application/o/daemonet-bot/.well-known/openid-configuration') {
          return json(200, { device_authorization_endpoint: `${base}/device`, token_endpoint: `${base}/token` });
        }
        if (req.url === '/device') {
          calls.push(`device:${form.get('client_id')}:${form.get('scope')}`);
          return json(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: `${base}/verify`, interval: 1, expires_in: 60 });
        }
        if (req.url === '/token') {
          const grant = form.get('grant_type');
          calls.push(`token:${grant}`);
          if (grant === 'refresh_token') return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 });
          if (++polls < 3) return json(400, { error: 'authorization_pending' });
          return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 300 });
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { issuer: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/application/o/daemonet-bot/`, calls };
  }

  it('prints the code, polls until approved, caches with mode 0600, then refreshes from the cache', async () => {
    const { issuer, calls } = await fakeIdp();
    const dir = await mkdtemp(join(tmpdir(), 'daemonet-'));
    const cacheFile = join(dir, 'token.json');
    const printed: string[] = [];
    let clock = 1_000_000;
    const source = await deviceLogin({ issuer, clientId: 'daemonet-bot', cacheFile, print: (m) => printed.push(m), sleep: async () => {}, now: () => clock });
    expect(printed[0]).toContain('ABCD-1234');
    expect(await source.getToken()).toBe('access-1');
    expect(calls.filter((c) => c === `token:urn:ietf:params:oauth:grant-type:device_code`)).toHaveLength(3);
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    if (process.platform !== 'win32') expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    const refreshed: string[] = [];
    source.onRefresh!((t) => refreshed.push(t));
    clock += 290_000;
    expect(await source.getToken()).toBe('access-2');
    expect(refreshed).toEqual(['access-2']);

    const again = await deviceLogin({ issuer, clientId: 'daemonet-bot', cacheFile, print: (m) => printed.push(m), sleep: async () => {}, now: () => clock });
    expect(await again.getToken()).toBe('access-2');
    expect(printed).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/sdk/test/sdk.test.ts`
Expected: FAIL — cannot resolve `../src/node.js`.

- [ ] **Step 3: Implement**

`packages/sdk/src/node.ts`:

```ts
import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { TokenSource } from './auth.js';

export interface DeviceLoginOptions {
  /** OIDC issuer, e.g. https://authentik.wispy-nook.casa/application/o/daemonet-bot/ */
  issuer: string;
  clientId: string;
  scope?: string;
  /** Where the refresh token is cached (written with mode 0600). */
  cacheFile?: string;
  print?: (message: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Discovery {
  device_authorization_endpoint: string;
  token_endpoint: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  interval?: number;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_MARGIN_MS = 60_000;

/**
 * OAuth device authorization grant (RFC 8628) against Authentik, with a cached, auto-refreshing token.
 * Prints a verification URL + code on first use; later runs reuse the cached refresh token.
 */
export async function deviceLogin(opts: DeviceLoginOptions): Promise<TokenSource> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((m: string) => console.log(m));
  const scope = opts.scope ?? 'openid profile groups offline_access';
  const base = opts.issuer.endsWith('/') ? opts.issuer : `${opts.issuer}/`;
  const discovery = (await (await f(new URL('.well-known/openid-configuration', base))).json()) as Discovery;
  const listeners = new Set<(token: string) => void>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const post = async (url: string, body: Record<string, string>) => {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    return { status: res.status, json: (await res.json()) as TokenResponse & Record<string, unknown> };
  };

  const toTokens = (r: TokenResponse, previousRefresh: string | null): Tokens => {
    if (!r.access_token) throw new Error(`token endpoint returned no access_token (${r.error ?? 'unknown error'})`);
    return { accessToken: r.access_token, refreshToken: r.refresh_token ?? previousRefresh, expiresAt: now() + (r.expires_in ?? 300) * 1000 };
  };

  const save = async (t: Tokens) => {
    if (!opts.cacheFile) return;
    await writeFile(opts.cacheFile, JSON.stringify(t), { mode: 0o600 });
    await chmod(opts.cacheFile, 0o600);
  };

  const refresh = async (refreshToken: string): Promise<Tokens | null> => {
    const { status, json } = await post(discovery.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: opts.clientId });
    if (status !== 200) return null;
    return toTokens(json, refreshToken);
  };

  const interactive = async (): Promise<Tokens> => {
    const { json: dev } = await post(discovery.device_authorization_endpoint, { client_id: opts.clientId, scope });
    const uri = (dev.verification_uri_complete ?? dev.verification_uri) as string;
    print(`To sign in, open ${uri} and enter code ${String(dev.user_code)}`);
    let interval = ((dev.interval as number | undefined) ?? 5) * 1000;
    const deadline = now() + ((dev.expires_in as number | undefined) ?? 600) * 1000;
    while (now() < deadline) {
      await sleep(interval);
      const { json } = await post(discovery.token_endpoint, { grant_type: DEVICE_GRANT, device_code: String(dev.device_code), client_id: opts.clientId });
      if (json.access_token) return toTokens(json, null);
      if (json.error === 'authorization_pending') continue;
      if (json.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw new Error(`device login failed: ${json.error ?? 'unknown error'}`);
    }
    throw new Error('device login expired');
  };

  let tokens: Tokens | null = null;
  if (opts.cacheFile) {
    try {
      const cached = JSON.parse(await readFile(opts.cacheFile, 'utf8')) as Tokens;
      tokens = cached.expiresAt - REFRESH_MARGIN_MS > now() ? cached : cached.refreshToken ? await refresh(cached.refreshToken) : null;
    } catch {
      tokens = null;
    }
  }
  if (!tokens) tokens = await interactive();
  await save(tokens);

  const schedule = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!tokens?.refreshToken) return;
    const wait = Math.max(1000, tokens.expiresAt - REFRESH_MARGIN_MS - now());
    refreshTimer = setTimeout(() => void renew(), wait);
    refreshTimer.unref?.();
  };

  const renew = async (): Promise<string> => {
    const next = tokens?.refreshToken ? await refresh(tokens.refreshToken) : null;
    tokens = next ?? (await interactive());
    await save(tokens);
    for (const l of listeners) l(tokens.accessToken);
    schedule();
    return tokens.accessToken;
  };

  schedule();
  return {
    getToken: async () => (tokens && tokens.expiresAt - REFRESH_MARGIN_MS > now() ? tokens.accessToken : renew()),
    onRefresh: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export * from './index.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (2 sdk tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): oauth device-flow login with cached refresh"
```

---

### Task 8: End-to-end tests, the example bot and the load script

**Files:**
- Create: `apps/sim/test/integration.test.ts`, `examples/starter-bot/package.json`, `examples/starter-bot/README.md`, `examples/starter-bot/tsconfig.json`, `examples/starter-bot/src/solvers.ts`, `examples/starter-bot/src/index.ts`, `examples/starter-bot/src/load.ts`

**Interfaces:**
- Consumes: everything above. The example imports `@daemonet/sdk` and `@daemonet/sdk/node` only (no solver from the repo's test folder — it has its own Packet solver).

- [ ] **Step 1: Write the failing integration tests**

`apps/sim/test/integration.test.ts`:

```ts
import { connect, devToken, type GameClient } from '@daemonet/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game } from '../src/runtime/game.js';
import { startLoop } from '../src/runtime/loop.js';
import { startServer, type RunningServer } from '../src/runtime/server.js';
import { MemoryStore } from '../src/runtime/store.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { TEST_SUBNET, placeWild } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };

interface Harness {
  world: World;
  game: Game;
  server: RunningServer;
  url: string;
  stop(): Promise<void>;
}

const running: Harness[] = [];
const clients: GameClient[] = [];

async function boot(store: MemoryStore, seedId: string): Promise<Harness> {
  const world = new World({ subnet: TEST_SUBNET, seed: seedId, seedId, spawner: false });
  const game = new Game({ world, store, verify: createDevVerifier('daemonet-users'), seedId, retryDelaysMs: [1, 1, 1] });
  const server = await startServer({ game, store, port: 0, host: '127.0.0.1', trustProxyHops: 0, log: silent });
  // 16 ms ticks: fast tests, while the 64-tick resume window (~1 s) still outlasts the SDK's first reconnect backoff.
  const stopLoop = startLoop(() => game.tick(), 16);
  const h: Harness = {
    world, game, server, url: `ws://127.0.0.1:${server.port}/ws`,
    stop: async () => {
      stopLoop();
      await game.shutdown();
      await server.close();
    },
  };
  running.push(h);
  return h;
}

async function bot(url: string, name: string): Promise<GameClient> {
  const c = await connect({ url, auth: devToken(name) });
  clients.push(c);
  return c;
}

function until(client: GameClient, pred: () => boolean, ticks = 400): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    let n = 0;
    const off = client.on('tick', () => {
      if (pred()) {
        off();
        resolve();
      } else if (++n > ticks) {
        off();
        reject(new Error('condition not met in time'));
      }
    });
  });
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of running.splice(0)) await h.stop();
});

describe('SDK against a live sim', () => {
  it('two bots claim starters and see each other', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0001');
    const alice = await bot(h.url, 'alice');
    const bob = await bot(h.url, 'bob');
    await alice.operator.claimStarter('pingling', 'alice');
    await bob.operator.claimStarter('nullpup', 'bob');
    await until(alice, () => alice.self.starterClaimed && alice.world.operators.all().some((o) => o.name === 'bob'));
    expect(alice.self.ram[0]!.species).toBe('pingling');
    expect(bob.world.operators.all().map((o) => o.name).sort()).toEqual(['alice', 'bob']);
  });

  it('a scripted bot weakens, captures with a solver, and keeps the daemon across a restart', async () => {
    const store = new MemoryStore();
    const h = await boot(store, 'aaaa0002');
    const alice = await bot(h.url, 'alice');
    // Hashling vs a wild Nullpup: neutral matchup, a wanderer that only fights back against the daemon,
    // and two Encrypt hits leave it under half HP without killing it.
    await alice.operator.claimStarter('hashling', 'alice');
    await until(alice, () => alice.self.ram.length === 1);
    await alice.operator.run(alice.self.ram[0]!.id);
    placeWild(h.world, 'nullpup', 5, 7.5, 5.5);

    alice.on('captureStart', (ev) => void alice.operator.submitCapture(ev.captureId, solve(ev.challenge as never)));
    alice.daemons.script(({ self, enemies }) => {
      const foe = enemies.nearest();
      if (!foe || foe.hpPct < 0.5) return;
      const move = self.bestMoveAgainst(foe);
      if (move) void self.use(move, foe);
    });
    let busy = false;
    alice.operator.script(({ me, world }) => {
      const target = world.wild.nearest();
      if (!target || me.capture || busy) return;
      if (Math.hypot(target.x - me.x, target.y - me.y) > 3) {
        void alice.operator.moveTo(target.x, target.y);
        return;
      }
      if (target.hpPct < 0.5) {
        busy = true;
        alice.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
      }
    });
    const result = new Promise((resolve) => alice.on('captureResult', (ev) => ev.ok && resolve(ev)));
    await expect(result).resolves.toMatchObject({ ok: true, daemon: { species: 'nullpup' } });

    await h.stop();
    running.splice(running.indexOf(h), 1);
    const h2 = await boot(store, 'bbbb0003');
    const back = await bot(h2.url, 'alice');
    expect(back.self.ram.map((d) => d.species).sort()).toEqual(['hashling', 'nullpup']);
  });

  it('another operator cannot capture a daemon tagged by someone else', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0004');
    const alice = await bot(h.url, 'alice');
    const bob = await bot(h.url, 'bob');
    await alice.operator.claimStarter('pingling', 'alice');
    await bob.operator.claimStarter('nullpup', 'bob');
    await until(bob, () => bob.self.starterClaimed);
    const wild = placeWild(h.world, 'bitrot', 5, 6.5, 5.5);
    wild.wild!.tagOwner = alice.operatorId;
    wild.wild!.tagUntil = h.world.tick + 10_000;
    await expect(bob.operator.capture(wild.id, 'sniff')).rejects.toMatchObject({ code: 'E_STATE' });
  });

  it('enforces the per-tick command budget locally', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0005');
    const alice = await bot(h.url, 'alice');
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => alice.operator.stop()));
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code: string }).code === 'E_RATE')).toHaveLength(1);
  });

  it('reconnects and resumes after a dropped connection', async () => {
    const h = await boot(new MemoryStore(), 'aaaa0006');
    const alice = await bot(h.url, 'alice');
    let snapshots = 0;
    alice.on('ready', () => snapshots++);
    const reconnected = new Promise<void>((resolve) => alice.on('reconnect', () => resolve()));
    alice.dropConnection();
    await reconnected;
    const before = alice.tick;
    await until(alice, () => alice.tick > before + 3);
    expect(snapshots).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they pass against the real stack**

Run: `pnpm test`
Expected: PASS — 5 integration tests (two bots see each other; scripted capture with a solver survives a restart; tag protection; local command budget; reconnect + resume without a new snapshot). They use real sockets on a random port and a 16 ms loop, and take a few seconds.

- [ ] **Step 3: Create the example bot**

`examples/starter-bot/package.json`:

```json
{
  "name": "@daemonet/starter-bot",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/index.ts",
    "load": "node src/load.ts"
  },
  "dependencies": {
    "@daemonet/sdk": "workspace:*"
  }
}
```

`examples/starter-bot/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": [
      "node"
    ],
    "erasableSyntaxOnly": true
  },
  "include": [
    "src"
  ]
}
```

`examples/starter-bot/README.md`:

````markdown
# starter-bot

A minimal Daemonet operator bot. It claims a starter, runs it, weakens nearby
Packet-type daemons and captures them with `sniff`, solving the Packet
challenge with the solver in `src/solvers.ts`. Every other challenge family is
yours to write.

## Run against the live server

```bash
DAEMONET_URL=wss://daemonet.wispy-nook.casa/ws \
DAEMONET_ISSUER=https://authentik.wispy-nook.casa/application/o/daemonet-bot/ \
DAEMONET_CLIENT_ID=daemonet-bot \
DAEMONET_NAME=yourname DAEMONET_STARTER=pingling \
pnpm --filter @daemonet/starter-bot start
```

The first run prints a verification URL and code; approve it in your browser.
The refresh token is cached in `.daemonet-token.json` (mode 0600).

## Run against a local dev server

```bash
DAEMONET_URL=ws://127.0.0.1:3000/ws DAEMONET_DEV_NAME=alice DAEMONET_NAME=alice pnpm --filter @daemonet/starter-bot start
```

## Load test

`DAEMONET_URL=... DAEMONET_BOTS=64 pnpm --filter @daemonet/starter-bot load` connects N dev-token bots that wander and fight.
````

`examples/starter-bot/src/solvers.ts`:

```ts
import type { PacketAnswer, PacketParams, PacketPayload } from '@daemonet/sdk';

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fnv1a32Hex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Packet family: keep fragments whose crc = (seq + sum of data bytes) mod 256, drop duplicates and decoys,
 * reassemble by seq, and return the FNV-1a checksum of the message.
 */
export function solvePacket(params: PacketParams, payload: PacketPayload): PacketAnswer {
  const chunks = new Map<number, Uint8Array>();
  for (const f of payload.fragments) {
    const data = fromHex(f.data);
    const crc = (f.seq + data.reduce((s, b) => s + b, 0)) & 0xff;
    if (crc === f.crc) chunks.set(f.seq, data);
  }
  const message = new Uint8Array(params.count * 4);
  for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq)!, seq * 4);
  return { checksum: fnv1a32Hex(message) };
}
```

`examples/starter-bot/src/index.ts`:

```ts
import { connect, devToken, type DaemonView, type TokenSource } from '@daemonet/sdk';
import { deviceLogin } from '@daemonet/sdk/node';
import { solvePacket } from './solvers.ts';

const env = process.env;
const url = env.DAEMONET_URL ?? 'ws://127.0.0.1:3000/ws';
const name = env.DAEMONET_NAME ?? 'operator';
const starter = env.DAEMONET_STARTER ?? 'pingling';
const HOST = { x: 16.5, y: 16.5 };

const auth: TokenSource = env.DAEMONET_DEV_NAME
  ? devToken(env.DAEMONET_DEV_NAME)
  : await deviceLogin({ issuer: env.DAEMONET_ISSUER!, clientId: env.DAEMONET_CLIENT_ID ?? 'daemonet-bot', cacheFile: '.daemonet-token.json' });

const game = await connect({ url, auth });
console.log(`connected as ${game.operatorId} at tick ${game.tick}`);

game.on('error', (e) => console.warn('server error:', e.message));
game.on('scriptError', (e) => console.warn('script error:', e));
game.on('kick', (reason) => console.warn('kicked:', reason));
game.on('levelUp', (e) => console.log(`level up: ${e.daemon} -> ${e.level}`));
game.on('captureResult', (e) => console.log(e.ok ? `captured ${e.daemon?.species ?? 'to Disk'}!` : `capture failed: ${e.reason}`));

if (!game.self.starterClaimed) {
  await game.operator.claimStarter(starter, name);
  console.log(`claimed ${starter}`);
}

// Only Packet challenges are solved here; other families are ignored and time out.
game.on('captureStart', ({ captureId, challenge }) => {
  if (challenge.kind === 'single' && challenge.families[0] === 'packet') {
    void game.operator.submitCapture(captureId, solvePacket(challenge.params as never, challenge.payload as never));
  }
});

const canAttack = (meId: string) => (d: DaemonView) => d.types.includes('packet') && (d.taggedBy === null || d.taggedBy === meId);
let busy = false;

game.operator.script(({ me, world }) => {
  if (busy) return;
  const ready = me.ram.find((d) => !d.crashed);
  if (!ready) {
    // Everything crashed: walk home and restore.
    if (Math.hypot(HOST.x - me.x, HOST.y - me.y) > 1.5) {
      void game.operator.moveTo(HOST.x, HOST.y);
    } else {
      busy = true;
      game.operator.restoreAll().catch(() => {}).finally(() => (busy = false));
    }
    return;
  }
  if (me.running.length === 0 && me.swapReadyTick <= game.tick) {
    void game.operator.run(ready.id);
    return;
  }
  const target = world.wild.nearest(canAttack(me.id));
  if (!target || me.capture) return;
  if (Math.hypot(target.x - me.x, target.y - me.y) > 3) {
    void game.operator.moveTo(target.x, target.y);
    return;
  }
  if (target.hpPct < 0.35 && (me.inventory.sniff ?? 0) > 0) {
    busy = true;
    game.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
  }
});

game.daemons.script(({ self, enemies }) => {
  const foe = enemies.nearest(canAttack(game.operatorId));
  if (!foe || foe.hpPct < 0.35) return;
  const move = self.bestMoveAgainst(foe);
  if (move) void self.use(move, foe);
});
```

`examples/starter-bot/src/load.ts`:

```ts
/** Connects N dev-token bots that wander lo and fight what they meet. Watch the sim's tick stats. */
import { connect, devToken } from '@daemonet/sdk';

const url = process.env.DAEMONET_URL ?? 'ws://127.0.0.1:3000/ws';
const bots = Number(process.env.DAEMONET_BOTS ?? 64);
const starters = ['pingling', 'hashling', 'glitchmite', 'nullpup'];

for (let i = 0; i < bots; i++) {
  const name = `load${i}`;
  const game = await connect({ url, auth: devToken(name) });
  if (!game.self.starterClaimed) await game.operator.claimStarter(starters[i % 4]!, name);
  let goal = { x: 30.5 + (i % 8) * 3, y: 20.5 + Math.floor(i / 8) * 2 };
  game.operator.script(({ me, world }) => {
    if (me.running.length === 0 && me.swapReadyTick <= game.tick) {
      const ready = me.ram.find((d) => !d.crashed);
      if (ready) void game.operator.run(ready.id);
      return;
    }
    if (Math.hypot(goal.x - me.x, goal.y - me.y) < 1) goal = { x: 26 + Math.random() * 28, y: 10 + Math.random() * 30 };
    if (game.tick % 16 === i % 16) void game.operator.moveTo(goal.x, goal.y);
    const target = world.wild.nearest((d) => d.taggedBy === null || d.taggedBy === me.id);
    if (target && target.hpPct < 0.35 && !me.capture && (me.inventory.sniff ?? 0) > 0) void game.operator.capture(target, 'sniff');
  });
  game.daemons.script(({ self, enemies }) => {
    const foe = enemies.nearest();
    if (!foe) return;
    const move = self.bestMoveAgainst(foe);
    if (move) void self.use(move, foe);
  });
  console.log(`bot ${name} connected`);
}
console.log(`${bots} bots running; press Ctrl+C to stop`);
```

- [ ] **Step 4: Smoke-test the bot against a local server**

```bash
pnpm install
pnpm build
AUTH_DEV_BYPASS=true PORT=3000 node apps/sim/dist/runtime/main.js
```

In another shell:

```bash
DAEMONET_URL=ws://127.0.0.1:3000/ws DAEMONET_DEV_NAME=alice DAEMONET_NAME=alice pnpm --filter @daemonet/starter-bot start
```

Expected within about 30 s: `claimed pingling`, then `captured pingling!` (possibly after a `capture failed: packet_loss`). Then run `DAEMONET_URL=ws://127.0.0.1:3000/ws DAEMONET_BOTS=32 pnpm --filter @daemonet/starter-bot load` and confirm `32 bots running`; the sim logs `tick stats` every 64 s with `p99` well under 32 ms. Stop everything with Ctrl+C.

- [ ] **Step 5: Run the full check and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 19 test files, 154 tests.

```bash
git add -A
git commit -m "feat: end-to-end tests, starter bot and load script"
```

---

### Task 9: Push and verify CI

- [ ] **Step 1: Confirm nothing player-facing links to GitHub**

Run: `git grep -niE "github\.com|issues" -- packages/sdk examples`
Expected: no output.

- [ ] **Step 2: Push and watch CI**

```bash
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: `CI` passes with the PostgreSQL service (install → migrate → lint → typecheck → test).
