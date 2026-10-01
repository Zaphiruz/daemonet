# Daemonet SP4 · Plan 3 — Orgs and rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guilds: orgs with a unique name and 4-character tag, ranks (owner / officer / member), invites, kick / promote / transfer / leave / disband, a member leaderboard, an `org:<id>` chat channel with history, tags shown on operators and chat lines — plus the first vanity bits sinks: org creation (8192), tag change (4096) and operator rename (2048).

**Architecture:** Orgs are owned by the api (Postgres rows, REST under `/api/orgs`). Every paid action is one transaction: a guarded balance decrement (`bits >= price`, HTTP 402 otherwise), the ledger row, and the change itself. Because the sim keeps live operators in memory, the api tells it what changed over the bus: `org { kind: 'membership', operatorId, org | null }` and `admin { kind: 'bits' | 'rename', … }`. `Game` applies those to the live `Operator` (`op.org`, `op.bits`, `op.name`), which flow to clients through the normal self / entity diffs — and the plan-1 chat host now resolves `orgOf`, so `org:<id>` chat works. The same `bits` push also fixes plan SP3b-2's note that dev / admin grants were only seen on the next connection.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP4 plans 1–2 merged; Redis configured for both services (without it, org changes reach the sim only on the operator's next connection).

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp4-social-design.md` §3 (org prices), §7. Decisions fixed here: an owner must transfer ownership before leaving unless they are the last member, in which case leaving disbands the org; officers may invite and kick members, only the owner kicks officers, changes ranks, transfers and changes the tag; org names, tags and new operator names go through the chat filter; the leaderboard counts daemons by `originalOperatorId` (owned + archived).

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Bits are only ever taken by a guarded decrement in the same transaction as the ledger row and the thing bought.
- An operator belongs to at most one org (`OrgMember.operatorId` is the primary key).

## File map

```
packages/db/prisma/schema.prisma            Org, OrgMember, OrgInvite (+ migration 20260930000006)
packages/shared/src/protocol.ts             OperatorSelf.org, OperatorEntity.tag
apps/sim/src/core/{model,world,view}.ts     OrgView, Operator.org, tag on entities
apps/sim/src/runtime/{store,prisma-store}.ts   org on the loaded record
apps/sim/src/runtime/game.ts                bus: org membership, bits, rename; chat orgOf
apps/api/src/routes/orgs.ts                 /api/orgs…, /api/me/rename
apps/api/src/routes/chat.ts                 org channel history for members
apps/api/src/auth/dev-bypass.ts             dev bits pushed over the bus
apps/frontend/src/panels/OrgPanel.tsx, api.ts, App.tsx, TopBar.tsx, render/draw.ts, sdk-types.ts
```

---

### Task 1: Schema, protocol, sim plumbing

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000006_sp4_orgs/migration.sql`
- Modify: `packages/shared/src/protocol.ts`, `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/src/runtime/game.ts`, `apps/sim/test/helpers.ts`, `packages/sandbox/test/sandbox.test.ts`
- Create: `apps/sim/test/orgs.test.ts`

**Interfaces:**
- `OrgView { id; name; tag; rank: 'OWNER' | 'OFFICER' | 'MEMBER' }`; `OperatorRecord.org`, `Operator.org` (`OrgView | null`); `OperatorSelf.org`; `OperatorEntity.tag: string | null`.
- Bus messages the sim consumes: `org { kind: 'membership', operatorId, org: OrgView | null }`; `admin { kind: 'bits', operatorId, delta, reason, balance }` (adds `delta` to the live balance and emits the `bits` event); `admin { kind: 'rename', operatorId, name }`.
- `MemoryStore.orgs: Map<operatorId, OrgView>` for tests.

- [ ] **Step 1: Schema and migration**

Add before the chat models in `packages/db/prisma/schema.prisma`:

```prisma
enum OrgRank {
  OWNER
  OFFICER
  MEMBER
}

/// Orgs (SP4 spec §7): name, 4-character tag, up to 64 members.
model Org {
  id        String      @id
  name      String      @unique
  tag       String      @unique
  ownerId   String
  createdAt DateTime    @default(now())
  members   OrgMember[]
  invites   OrgInvite[]
}

model OrgMember {
  operatorId String   @id
  orgId      String
  org        Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  rank       OrgRank  @default(MEMBER)
  joinedAt   DateTime @default(now())

  @@index([orgId])
}

model OrgInvite {
  orgId      String
  org        Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  operatorId String
  byId       String
  at         DateTime @default(now())

  @@id([orgId, operatorId])
  @@index([operatorId])
}
```

Migration:

```sql
-- CreateEnum
CREATE TYPE "OrgRank" AS ENUM ('OWNER', 'OFFICER', 'MEMBER');

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMember" (
    "operatorId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rank" "OrgRank" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("operatorId")
);

-- CreateTable
CREATE TABLE "OrgInvite" (
    "orgId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("orgId","operatorId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Org_name_key" ON "Org"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Org_tag_key" ON "Org"("tag");

-- CreateIndex
CREATE INDEX "OrgMember_orgId_idx" ON "OrgMember"("orgId");

-- CreateIndex
CREATE INDEX "OrgInvite_operatorId_idx" ON "OrgInvite"("operatorId");

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Deploy and regenerate; add `"Org", "OrgMember", "OrgInvite"` to the api test `TRUNCATE` list.

- [ ] **Step 2: Protocol and core**

`packages/shared/src/protocol.ts`: `OperatorEntity` gains `/** Org tag (4 chars) or null. */ tag: z.string().nullable(),` after `name`; `OperatorSelf` gains before `cluster`:

```ts
  /** The org this operator belongs to (SP4), or null. */
  org: z.object({ id: Id, name: z.string(), tag: z.string(), rank: z.enum(['OWNER', 'OFFICER', 'MEMBER']) }).nullable(),
```

`apps/sim/src/core/model.ts`: add

```ts
export interface OrgView {
  id: string;
  name: string;
  tag: string;
  rank: 'OWNER' | 'OFFICER' | 'MEMBER';
}
```

`org: OrgView | null` on `OperatorRecord` and on `Operator` (comment: loaded with the record and kept current by the runtime over the bus). `world.addOperator` copies `rec.org`, `checkpoint()` returns it. `view.ts`: `toOperatorEntity` returns `tag: op.org?.tag ?? null`, `toSelf` returns `org: op.org`. Test helper `operatorRecord` and the sandbox fixture gain `org: null`.

Stores: `MemoryStore` gets `readonly orgs = new Map<…>()` and returns `org: this.orgs.get(op.id) ?? null`; `PrismaStore.loadOrCreateOperator` also loads `orgMember.findUnique({ where: { operatorId: op.id }, include: { org: true } })` and returns `org: member ? { id: member.org.id, name: member.org.name, tag: member.org.tag, rank: member.rank } : null`.

- [ ] **Step 3: Failing sim test**

```ts
import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET } from './helpers.js';

class FakeConn implements Conn {
  static n = 0;
  readonly id = `conn-${++FakeConn.n}`;
  readonly ip = '127.0.0.1';
  readonly sent: ServerMessage[] = [];
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close() {}
  of<T extends ServerMessage['t']>(t: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

describe('org membership, balance and rename pushes from the api', () => {
  it('loads the org with the record, shows the tag on entities and chat, and follows bus updates', async () => {
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const world = new World({ subnet: TEST_SUBNET, seed: 'o', seedId: 'aaaa0001', spawner: false });
    const game = new Game({ worlds: [world], store, verify: createDevVerifier('daemonet-users'), bus });
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      return conn;
    };
    const recA = await store.loadOrCreateOperator('dev-alice', 'test', world.subnet.spawn);
    store.orgs.set(recA.id, { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' });
    const alice = await join('alice');
    const bob = await join('bob');
    const bobId = bob.of('authOk')[0]!.d.operatorId;
    expect(alice.of('snapshot')[0]!.d.self.org).toEqual({ id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'OWNER' });
    expect(bob.of('snapshot')[0]!.d.self.org).toBeNull();
    expect(bob.of('snapshot')[0]!.d.entities.find((e) => e.id === recA.id)).toMatchObject({ kind: 'operator', tag: 'ROOT' });

    // bob joins the org through the api
    await bus.publish('org', { kind: 'membership', operatorId: bobId, org: { id: 'o1', name: 'Root Access', tag: 'ROOT', rank: 'MEMBER' } });
    game.tick();
    expect(bob.of('delta').at(-1)!.d.self!.org).toMatchObject({ tag: 'ROOT', rank: 'MEMBER' });
    await game.message(alice, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c1', cmd: 'chat', actor: 'self', args: { channel: 'org:o1', text: 'welcome' } } }));
    await game.flush();
    expect(bob.of('chat').at(-1)!.d).toMatchObject({ channel: 'org:o1', tag: 'ROOT', text: 'welcome' });

    // bits spent in the api and a rename reach the live operator
    await bus.publish('admin', { kind: 'bits', operatorId: bobId, delta: 500, reason: 'admin', balance: 500 });
    await bus.publish('admin', { kind: 'rename', operatorId: bobId, name: 'robert' });
    game.tick();
    const d = bob.of('delta').at(-1)!.d;
    expect(d.self).toMatchObject({ bits: 500, name: 'robert' });
    expect(d.events).toContainEqual({ e: 'bits', delta: 500, reason: 'admin', balance: 500 });

    // kicked: the tag and the channel go away
    await bus.publish('org', { kind: 'membership', operatorId: bobId, org: null });
    game.tick();
    expect(bob.of('delta').at(-1)!.d.self!.org).toBeNull();
    await new Promise((r) => setTimeout(r, 2100));
    await game.message(bob, JSON.stringify({ t: 'cmd', seq: 3, d: { reqId: 'c2', cmd: 'chat', actor: 'self', args: { channel: 'org:o1', text: 'still here?' } } }));
    await game.flush();
    expect(bob.of('err').at(-1)!.d).toMatchObject({ reqId: 'c2', code: 'E_STATE' });
    await game.shutdown();
  });
});
```

- [ ] **Step 4: Game — bus subscriptions**

In `apps/sim/src/runtime/game.ts`: the chat host gains `orgOf: (id) => lookup(id)?.op.org ?? undefined,`; the constructor subscribes `this.unsubscribe = [opts.bus.subscribe('org', (m) => this.onOrg(m as never)), opts.bus.subscribe('admin', (m) => this.onAdmin(m as never))];` (unsubscribed in `shutdown`), with the handlers:

```ts
  /** Pushes from the api (SP4 spec §7): org membership, balance changes made outside the sim, renames. */
  private onOrg(m: { kind?: string; operatorId?: string; org?: { id: string; name: string; tag: string; rank?: 'OWNER' | 'OFFICER' | 'MEMBER' } | null }): void {
    if (m.kind !== 'membership' || !m.operatorId) return;
    const op = this.sessions.get(m.operatorId)?.world.operators.get(m.operatorId);
    if (op) op.org = m.org && m.org.rank ? { id: m.org.id, name: m.org.name, tag: m.org.tag, rank: m.org.rank } : null;
  }

  private onAdmin(m: { kind?: string; operatorId?: string; delta?: number; reason?: string; balance?: number; name?: string }): void {
    if (!m.operatorId) return;
    const session = this.sessions.get(m.operatorId);
    const op = session?.world.operators.get(m.operatorId);
    if (!session || !op) return;
    if (m.kind === 'bits' && typeof m.delta === 'number' && typeof m.balance === 'number') {
      op.bits += m.delta;
      session.world.emitCarry({ e: 'bits', delta: m.delta, reason: m.reason ?? 'admin', balance: op.bits }, { to: op.id });
    }
    if (m.kind === 'rename' && typeof m.name === 'string') {
      op.name = m.name;
      const cluster = this.clusters.of(op.id);
      if (cluster) this.clusters.refresh(cluster.id);
    }
  }
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && DATABASE_URL=... pnpm exec vitest run apps/sim` — expected: green.

```bash
git add packages/db packages/shared packages/sandbox apps/sim
git commit -m "feat(sim): org membership, balance and rename pushes from the api; org tags and org chat"
```

---

### Task 2: API — orgs and rename

**Files:**
- Create: `apps/api/src/routes/orgs.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/routes/chat.ts`, `apps/api/src/auth/dev-bypass.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- `GET /api/orgs/mine` → `{ org, rank, invites, prices }`; `GET /api/orgs?q=` (name contains / tag equals; 32 rows); `GET /api/orgs/:id`; `POST /api/orgs { name, tag }` (8192 bits); `POST /api/orgs/invite { operatorId }`; `POST /api/orgs/:id/accept|decline`; `POST /api/orgs/leave`; `POST /api/orgs/kick { operatorId }`; `POST /api/orgs/rank { operatorId, rank: OFFICER | MEMBER }`; `POST /api/orgs/transfer { operatorId }`; `POST /api/orgs/tag { tag }` (4096 bits); `GET /api/orgs/:id/leaderboard`; `POST /api/me/rename { name }` (2048 bits).
- Errors: 402 `insufficient_bits`, 403 for rank violations, 400 for validation / taken names / filter refusals.
- `ORG_CREATE_PRICE = 8192`, `ORG_TAG_PRICE = 4096`, `RENAME_PRICE = 2048`, `ORG_MAX_MEMBERS = 64`.

- [ ] **Step 1: Failing test**

Add to `apps/api/test/app.test.ts` before the dev-seeding case:

```ts
  it('orgs: create for 8192 bits, invite / accept, ranks, kick, tag change, transfer, leave and disband; rename costs 2048', async () => {
    const dev = async (name: string) => {
      const r = await app.inject({ method: 'GET', url: `/api/auth/dev?name=${name}` });
      const cookies = { [COOKIE_NAME]: r.cookies.find((c) => c.name === COOKIE_NAME)!.value };
      const op = await prisma!.operator.findFirstOrThrow({ where: { sub: `dev-${name}` } });
      return { cookies, id: op.id };
    };
    const post = (who: { cookies: Record<string, string> }, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: who.cookies, headers: csrf, payload });
    const owner = await dev('olga');
    const pat = await dev('pat');
    const quinn = await dev('quinn');
    expect((await post(owner, '/api/orgs', { name: 'Root Access', tag: 'ROOT' })).statusCode).toBe(402);
    await post(owner, '/api/dev/bits', { amount: 20_000 });
    bus.log.length = 0;
    expect((await post(owner, '/api/orgs', { name: 'kys crew', tag: 'KYSX' })).statusCode).toBe(400);
    expect((await post(owner, '/api/orgs', { name: 'Root Access', tag: 'root' })).statusCode).toBe(400);
    const created = await post(owner, '/api/orgs', { name: 'Root Access', tag: 'ROOT' });
    expect(created.statusCode).toBe(200);
    const org = created.json();
    expect(org).toMatchObject({ name: 'Root Access', tag: 'ROOT', ownerId: owner.id, members: [{ operatorId: owner.id, rank: 'OWNER' }] });
    expect(bus.log.map((l) => (l.message as { kind: string }).kind)).toEqual(['bits', 'membership']);
    expect(bus.log[0]!.message).toMatchObject({ operatorId: owner.id, delta: -8192, reason: 'org', balance: 20_000 - 8192 });
    expect((await prisma!.bitsLedger.findMany({ where: { reason: 'org' } })).map((l) => Number(l.delta))).toEqual([-8192]);
    expect((await post(owner, '/api/orgs', { name: 'Second', tag: 'SECD' })).statusCode).toBe(400);

    expect((await post(pat, '/api/orgs/invite', { operatorId: quinn.id })).statusCode).toBe(403);
    expect((await post(owner, '/api/orgs/invite', { operatorId: pat.id })).json()).toEqual({ ok: true });
    expect((await post(owner, '/api/orgs/invite', { operatorId: quinn.id })).json()).toEqual({ ok: true });
    const mine = (await app.inject({ method: 'GET', url: '/api/orgs/mine', cookies: pat.cookies })).json();
    expect(mine).toMatchObject({ org: null, invites: [{ orgId: org.id, tag: 'ROOT' }], prices: { create: 8192, tag: 4096, rename: 2048 } });
    expect((await post(pat, `/api/orgs/${org.id}/accept`)).json().members).toHaveLength(2);
    expect((await post(quinn, `/api/orgs/${org.id}/decline`)).json()).toEqual({ ok: true });
    expect((await post(quinn, `/api/orgs/${org.id}/accept`)).statusCode).toBe(404);
    await post(owner, '/api/orgs/invite', { operatorId: quinn.id });
    await post(quinn, `/api/orgs/${org.id}/accept`);

    expect((await post(pat, '/api/orgs/kick', { operatorId: quinn.id })).statusCode).toBe(403);
    expect((await post(owner, '/api/orgs/rank', { operatorId: pat.id, rank: 'OFFICER' })).json()).toEqual({ ok: true });
    expect((await post(pat, '/api/orgs/kick', { operatorId: quinn.id })).json()).toEqual({ ok: true });
    expect(bus.log.at(-1)!.message).toEqual({ kind: 'membership', operatorId: quinn.id, org: null });
    expect((await post(pat, '/api/orgs/kick', { operatorId: owner.id })).statusCode).toBe(403);

    expect((await post(pat, '/api/orgs/tag', { tag: 'RUUT' })).statusCode).toBe(403);
    expect((await post(owner, '/api/orgs/tag', { tag: 'RUUT' })).json()).toEqual({ ok: true, tag: 'RUUT' });
    expect((await prisma!.operator.findUniqueOrThrow({ where: { id: owner.id } })).bits).toBe(BigInt(20_000 - 8192 - 4096));
    const search = (await app.inject({ method: 'GET', url: '/api/orgs?q=ruut', cookies: quinn.cookies })).json();
    expect(search).toEqual([{ id: org.id, name: 'Root Access', tag: 'RUUT', members: 2 }]);

    await prisma!.chatMessage.create({ data: { id: 'om1', channel: `org:${org.id}`, operatorId: owner.id, text: 'org only' } });
    expect((await app.inject({ method: 'GET', url: `/api/chat/org:${org.id}`, cookies: pat.cookies })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/chat/org:${org.id}`, cookies: quinn.cookies })).statusCode).toBe(403);

    const board = (await app.inject({ method: 'GET', url: `/api/orgs/${org.id}/leaderboard`, cookies: pat.cookies })).json();
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ captures: 0, highestSignature: 0, evolutions: 0, ticketsDone: 0 });

    expect((await post(owner, '/api/orgs/leave')).statusCode).toBe(400);
    expect((await post(owner, '/api/orgs/transfer', { operatorId: pat.id })).json()).toEqual({ ok: true });
    expect((await post(owner, '/api/orgs/leave')).json()).toEqual({ ok: true, disbanded: false });
    expect((await post(pat, '/api/orgs/leave')).json()).toEqual({ ok: true, disbanded: true });
    expect(await prisma!.org.count()).toBe(0);
    expect(await prisma!.orgMember.count()).toBe(0);

    expect((await post(owner, '/api/me/rename', { name: 'olga2' })).statusCode).toBe(400); // no starter yet
    await prisma!.operator.update({ where: { id: owner.id }, data: { starterClaimed: true, name: 'olga' } });
    expect((await post(owner, '/api/me/rename', { name: 'shit-lord' })).statusCode).toBe(400);
    const renamed = await post(owner, '/api/me/rename', { name: 'olga2' });
    expect(renamed.json()).toEqual({ ok: true, name: 'olga2', bits: 20_000 - 8192 - 4096 - 2048 });
    expect(bus.log.at(-1)!.message).toEqual({ kind: 'rename', operatorId: owner.id, name: 'olga2' });
  });
```

- [ ] **Step 2: Routes**

Create `apps/api/src/routes/orgs.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { Prisma, PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { nameAllowed } from './chat.js';

/** Vanity sinks (SP4 spec §3, §7). */
export const ORG_CREATE_PRICE = 8192;
export const ORG_TAG_PRICE = 4096;
export const RENAME_PRICE = 2048;
export const ORG_MAX_MEMBERS = 64;

const OrgName = z.string().regex(/^[A-Za-z0-9 _-]{3,24}$/);
const OrgTag = z.string().regex(/^[A-Z0-9]{4}$/);
const OperatorName = z.string().regex(/^[a-z0-9_-]{3,16}$/);
const CreateBody = z.object({ name: OrgName, tag: OrgTag });
const TargetBody = z.object({ operatorId: z.string().min(1) });
const RankBody = z.object({ operatorId: z.string().min(1), rank: z.enum(['OFFICER', 'MEMBER']) });
const TagBody = z.object({ tag: OrgTag });
const RenameBody = z.object({ name: OperatorName });

type Rank = 'OWNER' | 'OFFICER' | 'MEMBER';
const insufficient = (price: number) => new AppError(402, 'insufficient_bits', `costs ${price} bits`);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Atomically takes `price` bits (402 when short) and writes the ledger row. */
async function charge(tx: Prisma.TransactionClient, operatorId: string, price: number, reason: string, ref: string): Promise<number> {
  const res = await tx.operator.updateMany({ where: { id: operatorId, bits: { gte: BigInt(price) } }, data: { bits: { decrement: BigInt(price) } } });
  if (res.count !== 1) throw insufficient(price);
  await tx.bitsLedger.create({ data: { operatorId, delta: BigInt(-price), reason, ref } });
  const op = await tx.operator.findUniqueOrThrow({ where: { id: operatorId }, select: { bits: true } });
  return Number(op.bits);
}

const isUnique = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

/** Orgs and operator rename (SP4 spec §7). Membership and balance changes are pushed to the sim over the bus. */
export function registerOrgRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };

  const membership = (operatorId: string) => prisma.orgMember.findUnique({ where: { operatorId }, include: { org: true } });
  async function announce(operatorId: string): Promise<void> {
    const m = await membership(operatorId);
    await bus.publish('org', { kind: 'membership', operatorId, org: m ? { id: m.org.id, name: m.org.name, tag: m.org.tag, rank: m.rank } : null });
  }
  const bits = (operatorId: string, delta: number, reason: string, balance: number) => bus.publish('admin', { kind: 'bits', operatorId, delta, reason, balance });

  async function requireRank(operatorId: string, ...ranks: Rank[]) {
    const m = await membership(operatorId);
    if (!m) throw forbidden('you are not in an org');
    if (!ranks.includes(m.rank)) throw forbidden(`requires ${ranks.join(' or ').toLowerCase()}`);
    return m;
  }

  async function view(orgId: string) {
    const org = await prisma.org.findUnique({ where: { id: orgId }, include: { members: { orderBy: { joinedAt: 'asc' } } } });
    if (!org) throw notFound('no such org');
    const names = new Map((await prisma.operator.findMany({ where: { id: { in: org.members.map((m) => m.operatorId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return { id: org.id, name: org.name, tag: org.tag, ownerId: org.ownerId, createdAt: org.createdAt, members: org.members.map((m) => ({ operatorId: m.operatorId, name: names.get(m.operatorId) ?? null, rank: m.rank, joinedAt: m.joinedAt })) };
  }

  app.get('/api/orgs/mine', auth, async (req) => {
    const me = req.operator!.id;
    const m = await membership(me);
    const invites = await prisma.orgInvite.findMany({ where: { operatorId: me }, include: { org: true } });
    return {
      org: m ? await view(m.orgId) : null,
      rank: m?.rank ?? null,
      invites: invites.map((i) => ({ orgId: i.orgId, name: i.org.name, tag: i.org.tag, byId: i.byId, at: i.at })),
      prices: { create: ORG_CREATE_PRICE, tag: ORG_TAG_PRICE, rename: RENAME_PRICE },
    };
  });

  app.get<{ Querystring: { q?: string } }>('/api/orgs', auth, async (req) => {
    const q = (req.query.q ?? '').trim();
    const rows = await prisma.org.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { tag: { equals: q.toUpperCase() } }] } : {},
      orderBy: { createdAt: 'asc' },
      take: 32,
      include: { _count: { select: { members: true } } },
    });
    return rows.map((o) => ({ id: o.id, name: o.name, tag: o.tag, members: o._count.members }));
  });

  app.get<{ Params: { id: string } }>('/api/orgs/:id', auth, async (req) => view(req.params.id));

  app.post('/api/orgs', auth, async (req) => {
    const me = req.operator!.id;
    const body = parse(CreateBody, req.body);
    if (!(await nameAllowed(prisma, body.name)) || !(await nameAllowed(prisma, body.tag))) throw badRequest('that name or tag is not allowed');
    if (await membership(me)) throw badRequest('leave your org first');
    let balance: number;
    let orgId: string;
    try {
      [orgId, balance] = await prisma.$transaction(async (tx) => {
        const org = await tx.org.create({ data: { id: crypto.randomUUID(), name: body.name, tag: body.tag, ownerId: me } });
        await tx.orgMember.create({ data: { orgId: org.id, operatorId: me, rank: 'OWNER' } });
        await tx.orgInvite.deleteMany({ where: { operatorId: me } });
        return [org.id, await charge(tx, me, ORG_CREATE_PRICE, 'org', org.id)] as const;
      });
    } catch (err) {
      if (isUnique(err)) throw badRequest('that name or tag is taken');
      throw err;
    }
    await bits(me, -ORG_CREATE_PRICE, 'org', balance);
    await announce(me);
    return view(orgId);
  });

  app.post('/api/orgs/invite', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER', 'OFFICER');
    if (!(await prisma.operator.findUnique({ where: { id: operatorId } }))) throw notFound('no such operator');
    if (await membership(operatorId)) throw badRequest('that operator is already in an org');
    if ((await prisma.orgMember.count({ where: { orgId: m.orgId } })) >= ORG_MAX_MEMBERS) throw badRequest(`an org holds at most ${ORG_MAX_MEMBERS} members`);
    await prisma.orgInvite.upsert({ where: { orgId_operatorId: { orgId: m.orgId, operatorId } }, create: { orgId: m.orgId, operatorId, byId: me }, update: { byId: me, at: new Date() } });
    await bus.publish('org', { kind: 'invite', operatorId, org: { id: m.org.id, name: m.org.name, tag: m.org.tag } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/orgs/:id/accept', auth, async (req) => {
    const me = req.operator!.id;
    if (await membership(me)) throw badRequest('leave your org first');
    const invite = await prisma.orgInvite.findUnique({ where: { orgId_operatorId: { orgId: req.params.id, operatorId: me } } });
    if (!invite) throw notFound('no such invite');
    await prisma.$transaction(async (tx) => {
      if ((await tx.orgMember.count({ where: { orgId: invite.orgId } })) >= ORG_MAX_MEMBERS) throw badRequest('that org is full');
      await tx.orgMember.create({ data: { orgId: invite.orgId, operatorId: me, rank: 'MEMBER' } });
      await tx.orgInvite.deleteMany({ where: { operatorId: me } });
    });
    await announce(me);
    return view(invite.orgId);
  });

  app.post<{ Params: { id: string } }>('/api/orgs/:id/decline', auth, async (req) => {
    await prisma.orgInvite.deleteMany({ where: { orgId: req.params.id, operatorId: req.operator!.id } });
    return { ok: true };
  });

  app.post('/api/orgs/leave', auth, async (req) => {
    const me = req.operator!.id;
    const m = await requireRank(me, 'OWNER', 'OFFICER', 'MEMBER');
    const count = await prisma.orgMember.count({ where: { orgId: m.orgId } });
    if (m.rank === 'OWNER' && count > 1) throw badRequest('transfer ownership before leaving');
    if (m.rank === 'OWNER') await prisma.org.delete({ where: { id: m.orgId } }); // last member: the org disbands (members cascade)
    else await prisma.orgMember.delete({ where: { operatorId: me } });
    await announce(me);
    return { ok: true, disbanded: m.rank === 'OWNER' };
  });

  app.post('/api/orgs/kick', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER', 'OFFICER');
    const target = await membership(operatorId);
    if (!target || target.orgId !== m.orgId || operatorId === me) throw badRequest('not a member of your org');
    if (target.rank === 'OWNER' || (target.rank === 'OFFICER' && m.rank !== 'OWNER')) throw forbidden('you cannot kick that rank');
    await prisma.orgMember.delete({ where: { operatorId } });
    await announce(operatorId);
    return { ok: true };
  });

  app.post('/api/orgs/rank', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId, rank } = parse(RankBody, req.body);
    const m = await requireRank(me, 'OWNER');
    const target = await membership(operatorId);
    if (!target || target.orgId !== m.orgId || operatorId === me) throw badRequest('not a member of your org');
    await prisma.orgMember.update({ where: { operatorId }, data: { rank } });
    await announce(operatorId);
    return { ok: true };
  });

  app.post('/api/orgs/transfer', auth, async (req) => {
    const me = req.operator!.id;
    const { operatorId } = parse(TargetBody, req.body);
    const m = await requireRank(me, 'OWNER');
    const target = await membership(operatorId);
    if (!target || target.orgId !== m.orgId || operatorId === me) throw badRequest('not a member of your org');
    await prisma.$transaction([
      prisma.orgMember.update({ where: { operatorId }, data: { rank: 'OWNER' } }),
      prisma.orgMember.update({ where: { operatorId: me }, data: { rank: 'OFFICER' } }),
      prisma.org.update({ where: { id: m.orgId }, data: { ownerId: operatorId } }),
    ]);
    await announce(operatorId);
    await announce(me);
    return { ok: true };
  });

  app.post('/api/orgs/tag', auth, async (req) => {
    const me = req.operator!.id;
    const { tag } = parse(TagBody, req.body);
    const m = await requireRank(me, 'OWNER');
    if (!(await nameAllowed(prisma, tag))) throw badRequest('that tag is not allowed');
    let balance: number;
    try {
      balance = await prisma.$transaction(async (tx) => {
        await tx.org.update({ where: { id: m.orgId }, data: { tag } });
        return charge(tx, me, ORG_TAG_PRICE, 'org', m.orgId);
      });
    } catch (err) {
      if (isUnique(err)) throw badRequest('that tag is taken');
      throw err;
    }
    await bits(me, -ORG_TAG_PRICE, 'org', balance);
    for (const member of await prisma.orgMember.findMany({ where: { orgId: m.orgId }, select: { operatorId: true } })) await announce(member.operatorId);
    return { ok: true, tag };
  });

  /** Members ranked by captures (owned + decompiled), with highest signature, evolutions and tickets done. */
  app.get<{ Params: { id: string } }>('/api/orgs/:id/leaderboard', auth, async (req) => {
    const org = await view(req.params.id);
    const ids = org.members.map((m) => m.operatorId);
    const [owned, archived, tickets] = await Promise.all([
      prisma.daemon.findMany({ where: { originalOperatorId: { in: ids } }, select: { originalOperatorId: true, signature: true, history: true } }),
      prisma.daemonArchive.findMany({ where: { originalOperatorId: { in: ids } }, select: { originalOperatorId: true, signature: true, history: true } }),
      prisma.ticket.groupBy({ by: ['operatorId'], where: { operatorId: { in: ids }, status: 'DONE' }, _count: { _all: true } }),
    ]);
    const done = new Map(tickets.map((t) => [t.operatorId, t._count._all]));
    const rows = org.members.map((m) => {
      const mine = [...owned, ...archived].filter((d) => d.originalOperatorId === m.operatorId);
      const evolutions = mine.reduce((n, d) => n + (Array.isArray(d.history) ? (d.history as Array<{ kind?: string }>).filter((h) => h.kind === 'evolved').length : 0), 0);
      return { operatorId: m.operatorId, name: m.name, rank: m.rank, captures: mine.length, highestSignature: mine.reduce((s, d) => Math.max(s, d.signature), 0), evolutions, ticketsDone: done.get(m.operatorId) ?? 0 };
    });
    return rows.sort((a, b) => b.captures - a.captures || b.highestSignature - a.highestSignature);
  });

  app.post('/api/me/rename', auth, async (req) => {
    const me = req.operator!.id;
    const { name } = parse(RenameBody, req.body);
    if (!(await nameAllowed(prisma, name))) throw badRequest('that name is not allowed');
    const current = await prisma.operator.findUniqueOrThrow({ where: { id: me }, select: { starterClaimed: true } });
    if (!current.starterClaimed) throw badRequest('claim a starter first');
    let balance: number;
    try {
      balance = await prisma.$transaction(async (tx) => {
        await tx.operator.update({ where: { id: me }, data: { name } });
        return charge(tx, me, RENAME_PRICE, 'rename', name);
      });
    } catch (err) {
      if (isUnique(err)) throw badRequest('that name is taken');
      throw err;
    }
    await bits(me, -RENAME_PRICE, 'rename', balance);
    await bus.publish('admin', { kind: 'rename', operatorId: me, name });
    return { ok: true, name, bits: balance };
  });
}
```

Register in `apps/api/src/app.ts`: `registerOrgRoutes(app, o.prisma, o.bus);` after the chat routes, and pass `bus: o.bus` to `registerDevBypass`.

In `apps/api/src/routes/chat.ts`, org history is readable by members:

```ts
  async function mayRead(operatorId: string, channel: string): Promise<boolean> {
    const [kind, id] = channel.split(':', 2);
    if (kind === 'org') return (await prisma.orgMember.findUnique({ where: { operatorId } }))?.orgId === id;
    return kind === 'subnet' || kind === 'dm';
  }
```

In `apps/api/src/auth/dev-bypass.ts` (`deps` gains `bus: Bus`), the dev bits route announces the new balance so an online operator sees it at once:

```ts
    await deps.bus.publish('admin', { kind: 'bits', operatorId, delta: parsed.data.amount, reason: 'admin', balance: Number(op.bits) });
```

- [ ] **Step 3: Verify and commit**

`pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green.

```bash
git add apps/api
git commit -m "feat(api): orgs (create, invite, ranks, tag, leaderboard) and operator rename as bits sinks"
```

---

### Task 3: Client

**Files:**
- Create: `apps/frontend/src/panels/OrgPanel.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/render/draw.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: API slice**

Types (before `LedgerEntry`):

```ts
export interface OrgMemberRow {
  operatorId: string;
  name: string | null;
  rank: 'OWNER' | 'OFFICER' | 'MEMBER';
  joinedAt: string;
}
export interface OrgView {
  id: string;
  name: string;
  tag: string;
  ownerId: string;
  members: OrgMemberRow[];
}
export interface OrgMine {
  org: OrgView | null;
  rank: 'OWNER' | 'OFFICER' | 'MEMBER' | null;
  invites: Array<{ orgId: string; name: string; tag: string; byId: string; at: string }>;
  prices: { create: number; tag: number; rename: number };
}
export interface OrgLeaderRow {
  operatorId: string;
  name: string | null;
  rank: 'OWNER' | 'OFFICER' | 'MEMBER';
  captures: number;
  highestSignature: number;
  evolutions: number;
  ticketsDone: number;
}
```

Add `'Org'` to `tagTypes`, the endpoints

```ts
    orgMine: b.query<OrgMine, void>({ query: () => '/orgs/mine', providesTags: ['Org'] }),
    orgLeaderboard: b.query<OrgLeaderRow[], string>({ query: (id) => `/orgs/${id}/leaderboard`, providesTags: ['Org'] }),
    /** POST /api/orgs<path> — create (''), /invite, /<id>/accept, /<id>/decline, /leave, /kick, /rank, /transfer, /tag. */
    orgAction: b.mutation<unknown, { path: string; body: object }>({ query: ({ path, body }) => ({ url: `/orgs${path}`, method: 'POST', body }), invalidatesTags: ['Org'] }),
    rename: b.mutation<{ ok: boolean; name: string; bits: number }, { name: string }>({ query: (body) => ({ url: '/me/rename', method: 'POST', body }), invalidatesTags: ['Me', 'Org'] }),
    script: b.query<ScriptDoc, void>({ query: () => '/scripts/main', providesTags: ['Script'] }),
    versions: b.query<ScriptVersion[], void>({ query: () => '/scripts/main/versions', providesTags: ['Script'] }),
    version: b.query<{ version: number; source: string }, number>({ query: (v) => `/scripts/main/versions/${v}` }),
    saveScript: b.mutation<{ version: number; updatedAt: string }, { source: string }>({
      query: (body) => ({ url: '/scripts/main', method: 'PUT', body }),
      invalidatesTags: ['Script'],
    }),
    ticket: b.mutation<{ ticket: string }, void>({ query: () => ({ url: '/ws/ticket', method: 'POST' }) }),
    logout: b.mutation<{ ok: boolean; endSessionUrl: string | null }, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }) }),
```

and export `useOrgMineQuery`, `useOrgLeaderboardQuery`, `useOrgActionMutation`, `useRenameMutation`.

- [ ] **Step 2: Panel and tags**

Create `apps/frontend/src/panels/OrgPanel.tsx`:

```tsx
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { useOrgActionMutation, useOrgLeaderboardQuery, useOrgMineQuery, useRenameMutation } from '../api.ts';
import { log } from '../game/log.ts';

/** Orgs (SP4 spec §7): create (8192 bits), invites, members by rank, leaderboard, tag change (4096), operator rename (2048). */
export function OrgPanel({ client }: { client: GameClient }) {
  const mine = useOrgMineQuery();
  const [act, state] = useOrgActionMutation();
  const [rename] = useRenameMutation();
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [invitee, setInvitee] = useState('');
  const [newName, setNewName] = useState('');
  const me = client.self;
  const org = mine.data?.org ?? null;
  const rank = mine.data?.rank ?? null;
  const prices = mine.data?.prices ?? { create: 8192, tag: 4096, rename: 2048 };
  const board = useOrgLeaderboardQuery(org?.id ?? '', { skip: !org });

  const go = async (path: string, body: object = {}) => {
    try {
      await act({ path, body }).unwrap();
    } catch (err) {
      log.push('reject', `org: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);
    }
  };

  return (
    <div className="space-y-3 p-3 text-sm" data-testid="org">
      {!org && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">create an org · {prices.create} bits (you have {me.bits})</h3>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void go('', { name: name.trim(), tag: tag.trim().toUpperCase() });
            }}
          >
            <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="name (3–24)" value={name} onChange={(e) => setName(e.target.value)} data-testid="org-name" />
            <input className="mono w-16 rounded bg-neutral-900 px-2 py-1 uppercase" placeholder="TAG" maxLength={4} value={tag} onChange={(e) => setTag(e.target.value)} data-testid="org-tag" />
            <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={state.isLoading || me.bits < prices.create || name.trim().length < 3 || tag.trim().length !== 4} data-testid="org-create">
              create
            </button>
          </form>
          {mine.data?.invites.map((i) => (
            <div key={i.orgId} className="flex items-center gap-2 rounded border border-sky-800 px-2 py-1 text-xs">
              <span>
                invited to [{i.tag}] {i.name}
              </span>
              <button className="ml-auto rounded bg-sky-800 px-2" onClick={() => void go(`/${i.orgId}/accept`)}>
                accept
              </button>
              <button className="text-neutral-500" onClick={() => void go(`/${i.orgId}/decline`)}>
                decline
              </button>
            </div>
          ))}
        </section>
      )}

      {org && (
        <section className="space-y-2">
          <h3 className="text-base">
            <span className="mono text-sky-300" data-testid="org-current-tag">[{org.tag}]</span> {org.name} <span className="text-xs text-neutral-500">{org.members.length}/64 · you are {rank?.toLowerCase()}</span>
          </h3>
          <table className="mono w-full text-xs" data-testid="org-members">
            <tbody>
              {(board.data ?? []).map((m) => (
                <tr key={m.operatorId} className="border-b border-neutral-900">
                  <td className="py-0.5">{m.name ?? m.operatorId.slice(0, 8)}</td>
                  <td className="text-neutral-500">{m.rank.toLowerCase()}</td>
                  <td className="text-right" title="captures">{m.captures} cap</td>
                  <td className="text-right" title="highest signature">T{m.highestSignature}</td>
                  <td className="text-right" title="evolutions">{m.evolutions} evo</td>
                  <td className="text-right" title="tickets done">{m.ticketsDone} tix</td>
                  <td className="text-right">
                    {rank === 'OWNER' && m.rank !== 'OWNER' && (
                      <>
                        <button className="text-neutral-500 hover:text-white" onClick={() => void go('/rank', { operatorId: m.operatorId, rank: m.rank === 'OFFICER' ? 'MEMBER' : 'OFFICER' })}>
                          {m.rank === 'OFFICER' ? 'demote' : 'promote'}
                        </button>{' '}
                        <button className="text-neutral-500 hover:text-white" onClick={() => void go('/transfer', { operatorId: m.operatorId })}>
                          make owner
                        </button>{' '}
                      </>
                    )}
                    {(rank === 'OWNER' || (rank === 'OFFICER' && m.rank === 'MEMBER')) && m.operatorId !== client.operatorId && (
                      <button className="text-neutral-500 hover:text-red-300" onClick={() => void go('/kick', { operatorId: m.operatorId })}>
                        kick
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rank !== 'MEMBER' && (
            <form
              className="flex gap-1 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                if (invitee.trim()) void go('/invite', { operatorId: invitee.trim() });
                setInvitee('');
              }}
            >
              <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="operator id to invite" value={invitee} onChange={(e) => setInvitee(e.target.value)} />
              <button className="rounded bg-neutral-800 px-2">invite</button>
            </form>
          )}
          {rank === 'OWNER' && (
            <form
              className="flex gap-1 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                void go('/tag', { tag: tag.trim().toUpperCase() });
              }}
            >
              <input className="mono w-16 rounded bg-neutral-900 px-2 py-1 uppercase" placeholder="TAG" maxLength={4} value={tag} onChange={(e) => setTag(e.target.value)} />
              <button className="rounded bg-neutral-800 px-2 disabled:opacity-40" disabled={me.bits < prices.tag || tag.trim().length !== 4}>
                change tag · {prices.tag} bits
              </button>
            </form>
          )}
          <button className="text-xs text-neutral-400 hover:text-red-300" onClick={() => void go('/leave')} data-testid="org-leave">
            {rank === 'OWNER' && org.members.length === 1 ? 'disband' : 'leave'}
          </button>
        </section>
      )}

      <section className="space-y-1 border-t border-neutral-800 pt-2 text-xs">
        <h3 className="uppercase tracking-wide text-neutral-500">rename operator · {prices.rename} bits</h3>
        <form
          className="flex gap-1"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await rename({ name: newName.trim() }).unwrap();
              setNewName('');
            } catch (err) {
              log.push('reject', `rename: ${(err as { data?: { message?: string } }).data?.message ?? 'failed'}`);
            }
          }}
        >
          <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="new name (a-z 0-9 _ -)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="rounded bg-neutral-800 px-2 disabled:opacity-40" disabled={me.bits < prices.rename || newName.trim().length < 3}>
            rename
          </button>
        </form>
      </section>
    </div>
  );
}
```

`App.tsx`: add the `org` tab after `chat` and render `<OrgPanel client={client} />`. `TopBar.tsx`: prefix the operator name with `[TAG] ` when `client.self.org` is set. `render/draw.ts`: operator labels read `` `${e.tag ? `[${e.tag}] ` : ''}${e.name ?? '?'}` ``. `sdk-types.ts`: `OperatorEntity` gains `tag: string | null`, `OperatorSelf` gains `org: { id; name; tag; rank } | null`.

- [ ] **Step 3: End-to-end**

In the two-operator scenario, before the contexts are closed:

```ts
  // orgs: A (granted bits while online — the balance arrives over the bus) founds one; the tag shows in the top bar and on chat lines
  expect((await pa.request.post('/api/dev/bits', { data: { amount: 10000 }, headers: { 'x-requested-with': 'daemonet' } })).ok()).toBeTruthy();
  await pa.getByTestId('tab-org').click();
  await pa.getByTestId('org-name').fill(`Org ${name}`);
  await pa.getByTestId('org-tag').fill(name.slice(-4).toUpperCase());
  await expect(pa.getByTestId('org-create')).toBeEnabled({ timeout: 10_000 });
  await pa.getByTestId('org-create').click();
  await expect(pa.getByTestId('org-current-tag')).toHaveText(`[${name.slice(-4).toUpperCase()}]`, { timeout: 10_000 });
  await expect(pa.getByTestId('operator-name')).toContainText(`[${name.slice(-4).toUpperCase()}]`, { timeout: 10_000 });
  await pa.getByTestId('org-leave').click();
  await expect(pa.getByTestId('org-create')).toBeVisible({ timeout: 10_000 });
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 41 files, 354 tests. Build, start the stack with `REDIS_URL` on both services, `playwright test` — 4 passed (the org step depends on the bus: the balance granted through the api must reach the online operator).

```bash
git add apps/frontend
git commit -m "feat(frontend): org panel, tags on operators, rename"
```

---

## Self-review

- **Spec coverage:** §7 tables; create / get / list / invite / accept / decline / leave / kick / promote / demote / transfer / tag / disband with prices and ledger rows; leaderboard (captures, highest signature, evolutions, tickets done); rename; bus membership updates; `op.org`, tag on operator entities, `OperatorSelf.org`; org chat channel and its history; client panel and top-bar tag. Org-name / tag / rename filtering uses plan 1's `nameAllowed`.
- **Type consistency:** `OrgView` is identical in the sim model, the protocol and the bus message; prices are exported constants used by the routes, `/api/orgs/mine` and the tests.
- **Placeholders:** none.
