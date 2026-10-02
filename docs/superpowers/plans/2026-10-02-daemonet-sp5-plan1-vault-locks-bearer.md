# Daemonet SP5 · Plan 1 — Vault, locks and bearer auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The groundwork every Exchange feature stands on: an api-owned **vault** that holds items for trading (filled and emptied by `deposit` / `withdraw` at a host), a **lock** on daemons that are listed or offered, and **bearer-token auth** on the api so headless bots can use the same Authentik access token they already use on the game socket.

**Architecture:** Live inventory is sim memory, so the api never edits it. Instead `ExchangeVault` rows hold what an operator has set aside; the sim moves items across with a durable `vault` intent (inventory and vault row change in one transaction; a deposit leaves memory optimistically, a withdrawal arrives on commit). Daemons trade from Disk — pure database state — and carry `lockedBy` while on the Exchange; the `load` intent refuses locked rows. The api's `requireAuth` learns a second path: `Authorization: Bearer …` verified against the bot provider's JWKS (issuer, audience, required group), mapped to the operator row by `sub`; bearer requests need no CSRF header because browsers cannot send them cross-site.

**Tech Stack:** adds `jose` to `apps/api` (already used by the sim).

**Prerequisites:** SP4 complete.

**Spec:** `docs/superpowers/specs/2026-10-02-daemonet-sp5-exchange-design.md` §3, §4.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- The api never writes `Operator.inventory`; the sim never writes `ExchangeVault` outside the `vault` intent.
- A locked daemon cannot enter RAM; nothing in this plan locks one yet (plans 3 and 4 do).

## File map

```
packages/rules/src/content/economy.ts       VAULT_MAX_QTY, isTradable
packages/db/prisma/schema.prisma            ExchangeVault, Daemon.lockedBy (+ migration 20261002000000)
packages/shared/src/protocol.ts             deposit / withdraw commands
packages/sdk/src/client.ts                  operator.deposit / withdraw
apps/sim/src/core/systems/economy.ts        vaultMove, completion
apps/sim/src/runtime/{store,prisma-store}.ts   vault intent, locked load
apps/api/src/auth/bearer.ts                 createBearerVerifier, createDevBearerVerifier, combineBearer
apps/api/src/auth/middleware.ts             cookie or bearer
apps/api/src/routes/exchange.ts             GET /api/exchange/vault
apps/frontend: Host panel vault view, Disk lock badge
```

---

### Task 1: Vault intent and locks in the sim

**Files:**
- Modify: `packages/rules/src/content/economy.ts`, `packages/db/prisma/schema.prisma`, `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`, `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/systems/economy.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/test/store.test.ts`
- Create: `packages/db/prisma/migrations/20261002000000_sp5_vault_locks/migration.sql`, `apps/sim/test/vault.test.ts`

**Interfaces:**
- `VAULT_MAX_QTY = 1024`, `isTradable(itemId)`.
- Commands `deposit { item, qty }`, `withdraw { item, qty }` (self, at a host, 1–1024); intent `vault { item, qty }` (positive = deposit); ack result `{ item, inventory }`.
- Store: `applyIntent('vault')` → `not enough in the vault` on overdraw; `load` → `locked on the Exchange`; `MemoryStore.vault` map and `MemDaemon.lockedBy`.
- SDK: `operator.deposit(item, qty = 1)`, `operator.withdraw(item, qty = 1)`.

- [ ] **Step 1: Schema and migration**

`model Daemon` gains after `heldItem`:

```prisma
  /// listing:<id> or trade:<id> while on the Exchange (SP5): cannot be loaded into RAM
  lockedBy           String?
```

and a new model:

```prisma
/// Items an operator has deposited for trading (SP5 spec §4). The api owns these rows; live inventory stays with the sim.
model ExchangeVault {
  operatorId String
  item       String
  qty        Int

  @@id([operatorId, item])
}
```

Migration:

```sql
-- AlterTable
ALTER TABLE "Daemon" ADD COLUMN     "lockedBy" TEXT;

-- CreateTable
CREATE TABLE "ExchangeVault" (
    "operatorId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "ExchangeVault_pkey" PRIMARY KEY ("operatorId","item")
);
```

- [ ] **Step 2: Failing tests**

Create `apps/sim/test/vault.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Intent } from '../src/core/index.js';
import { MemoryStore } from '../src/runtime/store.js';
import { TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, self, step } from './helpers.js';

const HOST = TEST_SUBNET.host;

function setup() {
  const world = makeWorld('vault');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y, inventory: { 'frag:packet': 10, tap: 2 } }));
  return world;
}

async function seeded(world: ReturnType<typeof setup>) {
  const store = new MemoryStore();
  const rec = await store.loadOrCreateOperator('alice', 'test', HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  store.operators.set('alice', { ...mem, id: 'alice', inventory: { ...world.checkpoint('alice').inventory } });
  return store;
}

async function through(world: ReturnType<typeof setup>, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null as Intent | null };
  const intent = r.intents[0]!;
  world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
  return { reply: step(world).replies[0]!, intent };
}

describe('Exchange vault', () => {
  it('deposits leave the inventory at once and land in the vault; withdrawals come back on commit', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const dep = await through(world, store, { cmd: 'deposit', actor: self, args: { item: 'frag:packet', qty: 6 } });
    expect(dep.intent).toMatchObject({ kind: 'vault', item: 'frag:packet', qty: 6 });
    expect(dep.reply).toMatchObject({ ok: true, result: { item: 'frag:packet', inventory: 4 } });
    expect(op.inventory['frag:packet']).toBe(4);
    expect(store.vault.get('alice:frag:packet')).toBe(6);
    expect(store.operators.get('alice')!.inventory['frag:packet']).toBe(4);
    const wd = await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'frag:packet', qty: 5 } });
    expect(wd.intent).toMatchObject({ qty: -5 });
    expect(op.inventory['frag:packet']).toBe(9);
    expect(store.vault.get('alice:frag:packet')).toBe(1);
    await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'frag:packet', qty: 1 } });
    expect(store.vault.has('alice:frag:packet')).toBe(false);
    expect(op.inventory['frag:packet']).toBe(10);
  });

  it('guards: at the host, tradable items, enough in the inventory / vault; a refused intent reverts', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const cmd = (c: 'deposit' | 'withdraw', item: string, qty: number) => step(world, input('alice', { cmd: c, actor: self, args: { item, qty } })).replies[0];
    expect(cmd('deposit', 'nonsense', 1)).toMatchObject({ code: 'E_INVALID' });
    expect(cmd('deposit', 'tap', 3)).toMatchObject({ code: 'E_STATE', message: 'need 3 tap, have 2' });
    op.x += 5;
    expect(cmd('deposit', 'tap', 1)).toMatchObject({ code: 'E_RANGE' });
    op.x -= 5;
    const wd = await through(world, store, { cmd: 'withdraw', actor: self, args: { item: 'tap', qty: 1 } });
    expect(wd.reply).toMatchObject({ ok: false, message: 'not enough in the vault' });
    expect(op.inventory.tap).toBe(2);
    const r = step(world, input('alice', { cmd: 'deposit', actor: self, args: { item: 'tap', qty: 2 } }));
    expect(op.inventory.tap).toBeUndefined();
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'persist failed' });
    expect(op.inventory.tap).toBe(2);
  });

  it('a daemon locked on the Exchange cannot be loaded into RAM', async () => {
    const world = setup();
    const store = await seeded(world);
    store.daemons.set('disk-1', { ...ownedRecord('pingling', 8, 0, 'disk-1'), operatorId: 'alice', location: 'DISK', lockedBy: 'listing:l1' });
    world.operators.get('alice')!.diskSlots.add(0);
    const locked = await through(world, store, { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } });
    expect(locked.reply).toMatchObject({ ok: false, message: 'locked on the Exchange' });
    store.daemons.get('disk-1')!.lockedBy = null;
    const ok = await through(world, store, { cmd: 'load', actor: self, args: { daemonId: 'disk-1' } });
    expect(ok.reply).toMatchObject({ ok: true });
  });
});
```

Add to the store contract in `apps/sim/test/store.test.ts` (and `"ExchangeVault"` to the PrismaStore `TRUNCATE` list):

```ts
    it('moves items between inventory and the Exchange vault; refuses overdrawn withdrawals', async () => {
      const a = await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN);
      await store.applyIntent(claim(a.id, 'vera', ownedRecord('pingling', 5, 0, 'abcd1234-v1')), { seedId: 'abcd1234' });
      const vault = (id: string, item: string, qty: number): Intent => ({ id, kind: 'vault', operatorId: a.id, reqId: 'r', item, qty });
      expect(await store.applyIntent(vault('i-v1', 'sniff', 5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect(await store.applyIntent(vault('i-v1', 'sniff', 5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN)).inventory).toEqual({ sniff: 3, restore: 2 });
      expect(await store.applyIntent(vault('i-v2', 'sniff', -6), { seedId: 'abcd1234' })).toEqual({ ok: false, reason: 'not enough in the vault' });
      expect(await store.applyIntent(vault('i-v3', 'sniff', -5), { seedId: 'abcd1234' })).toEqual({ ok: true });
      expect((await store.loadOrCreateOperator('sub-v1', 'lo', SPAWN)).inventory).toEqual({ sniff: 8, restore: 2 });
    });
```

- [ ] **Step 3: Rules, protocol, SDK**

`packages/rules/src/content/economy.ts`:

```ts
/** Largest quantity one deposit / withdraw (and one Exchange order) moves. */
export const VAULT_MAX_QTY = 1024;

/** Items the Exchange trades (SP5): everything an inventory can hold. */
export function isTradable(id: string): boolean {
  try {
    getItem(id);
    return true;
  } catch {
    return false;
  }
}
```

`packages/shared/src/protocol.ts` (commands):

```ts
  z.object({ cmd: z.literal('deposit'), actor: Self, args: z.object({ item: Id, qty: z.number().int().min(1).max(1024) }) }),
  z.object({ cmd: z.literal('withdraw'), actor: Self, args: z.object({ item: Id, qty: z.number().int().min(1).max(1024) }) }),
```

`packages/sdk/src/client.ts` (`OperatorApi`):

```ts
  /** Move items from your inventory into the Exchange vault (at a host). */
  deposit(item: string, qty = 1) {
    return this.client.command({ cmd: 'deposit', actor: 'self', args: { item, qty } });
  }
  /** Take items back out of the Exchange vault (at a host). */
  withdraw(item: string, qty = 1) {
    return this.client.command({ cmd: 'withdraw', actor: 'self', args: { item, qty } });
  }
```

- [ ] **Step 4: Sim**

`apps/sim/src/core/model.ts` — intent:

```ts
  /** Exchange vault (SP5): `qty` > 0 deposits from the inventory, < 0 withdraws into it. */
  | { id: string; kind: 'vault'; operatorId: string; reqId: string; item: string; qty: number }
```

`apps/sim/src/core/systems/economy.ts` (import `VAULT_MAX_QTY`, `isTradable`):

```ts
/** Move items between the live inventory and the Exchange vault (SP5 spec §4). A deposit leaves the inventory at once; a withdrawal arrives on commit. */
export function vaultMove(world: World, op: Operator, args: { item: string; qty: number }, direction: 1 | -1, input: Input, out: Out): void {
  if (!isTradable(args.item)) throw new Rejection('E_INVALID', `${args.item} cannot be traded`);
  if (args.qty < 1 || args.qty > VAULT_MAX_QTY) throw new Rejection('E_INVALID', `qty must be 1-${VAULT_MAX_QTY}`);
  if (direction === 1) {
    requireItems(op, { [args.item]: args.qty });
    addItems(op, { [args.item]: args.qty }, -1);
  }
  world.trackIntent({ id: world.newId('i'), kind: 'vault', operatorId: op.id, reqId: input.reqId, item: args.item, qty: direction * args.qty }, out);
}
```

`completeEconomyIntent` accepts `'vault'` too (`world.completeIntent` routes it there with `buy` / `craft` / `decompile`) and starts with:

```ts
    case 'vault': {
      if (!result.ok) {
        if (intent.qty > 0) addItems(op, { [intent.item]: intent.qty }, 1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      if (intent.qty < 0) addItems(op, { [intent.item]: -intent.qty }, 1);
      return out.ok(intent, { item: intent.item, inventory: op.inventory[intent.item] ?? 0 });
    }
```

`apps/sim/src/core/systems/commands.ts`:

```ts
    case 'deposit':
      requireAtHost(world, op);
      return vaultMove(world, op, c.args, 1, input, out);
    case 'withdraw':
      requireAtHost(world, op);
      return vaultMove(world, op, c.args, -1, input, out);
```

- [ ] **Step 5: Stores**

`MemoryStore` (`apps/sim/src/runtime/store.ts`): `MemDaemon.lockedBy?: string | null`, `readonly vault = new Map<string, number>()` keyed `${operatorId}:${item}`, `load` returns `{ ok: false, reason: 'locked on the Exchange' }` for a locked row, and

```ts
      case 'vault': {
        const key = `${op.id}:${intent.item}`;
        const have = this.vault.get(key) ?? 0;
        if (intent.qty < 0 && have < -intent.qty) return { ok: false, reason: 'not enough in the vault' };
        if (intent.qty > 0) {
          // the sim already took the items out of memory; the stored inventory follows
          const left = (op.inventory[intent.item] ?? 0) - intent.qty;
          if (left <= 0) delete op.inventory[intent.item];
          else op.inventory[intent.item] = left;
        } else op.inventory[intent.item] = (op.inventory[intent.item] ?? 0) - intent.qty;
        if (have + intent.qty === 0) this.vault.delete(key);
        else this.vault.set(key, have + intent.qty);
        break;
      }
```

`PrismaStore`: the `load` update adds `lockedBy: null` to its `where`; when no row matched, it reports `locked on the Exchange` if the daemon is the operator's, on Disk and locked, otherwise `not on Disk`; the decompile archive copy also drops `lockedBy`; and

```ts
          case 'vault': {
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            const row = await tx.exchangeVault.findUnique({ where: { operatorId_item: { operatorId: intent.operatorId, item: intent.item } } });
            const have = row?.qty ?? 0;
            if (intent.qty < 0 && have < -intent.qty) throw new DomainFailure('not enough in the vault');
            const left = (inventory[intent.item] ?? 0) - intent.qty;
            if (left <= 0) delete inventory[intent.item];
            else inventory[intent.item] = left;
            await tx.operator.update({ where: { id: intent.operatorId }, data: { inventory } });
            if (have + intent.qty === 0) await tx.exchangeVault.deleteMany({ where: { operatorId: intent.operatorId, item: intent.item } });
            else
              await tx.exchangeVault.upsert({
                where: { operatorId_item: { operatorId: intent.operatorId, item: intent.item } },
                create: { operatorId: intent.operatorId, item: intent.item, qty: have + intent.qty },
                update: { qty: have + intent.qty },
              });
            return { ok: true } as const;
          }
```

- [ ] **Step 6: Verify and commit**

Deploy the migration, regenerate Prisma, then `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green.

```bash
git add packages/rules packages/db packages/shared packages/sdk apps/sim
git commit -m "feat(sim): Exchange vault (deposit / withdraw) and Disk locks"
```

---

### Task 2: Bearer auth and the vault endpoint

**Files:**
- Create: `apps/api/src/auth/bearer.ts`, `apps/api/src/routes/exchange.ts`
- Modify: `apps/api/src/auth/middleware.ts`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/misc.ts`, `apps/api/package.json`, `apps/api/test/app.test.ts`, `scripts/provision-secrets.sh`

**Interfaces:**
- `BearerVerifier = (token) => Promise<{ sub, groups }>`; `createBearerVerifier({ issuer, audiences, requiredGroup, jwks?, userinfo?, fetch? })`, `createDevBearerVerifier(requiredGroup)` (`dev:<name>` → `dev-<name>`), `combineBearer(oidc, dev)`.
- `BuildAppOptions.bearer?: BearerVerifier | null`; `RequestOperator.via: 'session' | 'bearer'`.
- Config: `AUTHENTIK_BOT_ISSUER_URL`, `AUTHENTIK_BOT_CLIENT_ID` → `config.botOidc` (both already exist in Vault for the sim under the names `AUTHENTIK_ISSUER_URL` / `AUTHENTIK_BOT_CLIENT_ID`; the secret document gains `AUTHENTIK_BOT_ISSUER_URL` with the same value as the sim's issuer).
- `GET /api/exchange/vault` → `{ item: qty }`; `/api/disk` rows gain `lockedBy`. Exchange routes are limited to 120 requests / minute.

- [ ] **Step 1: Failing tests**

In `apps/api/test/app.test.ts`: `buildApp` gets

```ts
      bearer: combineBearer(
        async (token) => {
          if (token === 'good-token') return { sub: 'bot-1', groups: ['daemonet-users'] };
          throw new Error('signature verification failed');
        },
        createDevBearerVerifier('daemonet-users'),
      ),
```

`"ExchangeVault"` joins the truncation list, and add:

```ts
  it('accepts bot bearer tokens (no CSRF header needed), rejects bad ones, and serves the vault and Disk locks', async () => {
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    expect((await app.inject({ method: 'GET', url: '/api/exchange/vault' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/exchange/vault', headers: bearer('forged') })).statusCode).toBe(401);
    const empty = await app.inject({ method: 'GET', url: '/api/exchange/vault', headers: bearer('good-token') });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({});
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'bot-1' } });
    await prisma!.exchangeVault.create({ data: { operatorId: op.id, item: 'frag:packet', qty: 7 } });
    expect((await app.inject({ method: 'GET', url: '/api/exchange/vault', headers: bearer('good-token') })).json()).toEqual({ 'frag:packet': 7 });
    // the same operator as a `dev:` game-socket bot; mutating requests work without the CSRF header
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer('dev:robo') })).json();
    expect(me).toMatchObject({ name: null, isAdmin: false });
    const seeded = await app.inject({ method: 'POST', url: '/api/dev/daemon', headers: bearer('dev:robo'), payload: { species: 'pingling', level: 8 } });
    expect(seeded.statusCode).toBe(200);
    await prisma!.daemon.update({ where: { id: seeded.json().id }, data: { lockedBy: 'listing:x' } });
    expect((await app.inject({ method: 'GET', url: '/api/disk', headers: bearer('dev:robo') })).json()[0]).toMatchObject({ lockedBy: 'listing:x' });
    expect((await app.inject({ method: 'GET', url: '/api/admin/economy', headers: bearer('dev:robo') })).statusCode).toBe(403);
  });
```

plus, at the end of the file:

```ts
describe('bearer verifier', () => {
  it('checks signature, issuer, audience and the required group', async () => {
    const { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } = await import('jose');
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
    const issuer = 'https://authentik.test/application/o/daemonet-bot/';
    const sign = (claims: Record<string, unknown>, aud = 'bot-client', iss = issuer) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud).setSubject('user-9').setExpirationTime('5m').sign(privateKey);
    const verify = createBearerVerifier({ issuer, audiences: ['bot-client'], requiredGroup: 'daemonet-users', jwks, userinfo: async () => ({ groups: ['daemonet-users'] }) });
    expect(await verify(await sign({ groups: ['daemonet-users', 'x'] }))).toEqual({ sub: 'user-9', groups: ['daemonet-users', 'x'] });
    expect(await verify(await sign({}))).toEqual({ sub: 'user-9', groups: ['daemonet-users'] });
    await expect(verify(await sign({ groups: ['other'] }))).rejects.toThrow(/not in daemonet-users/);
    await expect(verify(await sign({ groups: ['daemonet-users'] }, 'someone-else'))).rejects.toThrow();
    await expect(verify(await sign({ groups: ['daemonet-users'] }, 'bot-client', 'https://evil.test/'))).rejects.toThrow();
    await expect(verify('not-a-jwt')).rejects.toThrow();
  });
```

- [ ] **Step 2: Verifier and middleware**

Create `apps/api/src/auth/bearer.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface BearerClaims {
  sub: string;
  groups: string[];
}

export type BearerVerifier = (token: string) => Promise<BearerClaims>;

export interface BearerOptions {
  /** Issuer of the bot provider, e.g. https://authentik…/application/o/daemonet-bot/ */
  issuer: string;
  /** Accepted audiences (the public `daemonet-bot` client id). */
  audiences: string[];
  requiredGroup: string;
  jwks?: JWTVerifyGetKey;
  userinfo?: (token: string) => Promise<{ groups?: unknown }>;
  fetch?: typeof fetch;
}

const asGroups = (value: unknown): string[] | null => (Array.isArray(value) && value.every((g) => typeof g === 'string') ? value : null);

/**
 * Verifies the same Authentik access tokens headless bots use on the game socket (SP5 spec §3):
 * signature via JWKS, issuer, audience, expiry, required group (claim or userinfo).
 */
export function createBearerVerifier(opts: BearerOptions): BearerVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  let discovery: Promise<{ jwks_uri: string; userinfo_endpoint: string }> | null = null;
  const discover = () =>
    (discovery ??= (async () => {
      const base = opts.issuer.endsWith('/') ? opts.issuer : `${opts.issuer}/`;
      const res = await fetchImpl(new URL('.well-known/openid-configuration', base));
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      return (await res.json()) as { jwks_uri: string; userinfo_endpoint: string };
    })());
  let jwks: JWTVerifyGetKey | null = opts.jwks ?? null;

  return async (token) => {
    if (!jwks) jwks = createRemoteJWKSet(new URL((await discover()).jwks_uri));
    const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audiences });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('token has no sub');
    let groups = asGroups(payload.groups);
    if (!groups) {
      const info = opts.userinfo
        ? await opts.userinfo(token)
        : ((await (await fetchImpl((await discover()).userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })).json()) as { groups?: unknown });
      groups = asGroups(info.groups) ?? [];
    }
    if (!groups.includes(opts.requiredGroup)) throw new Error(`not in ${opts.requiredGroup}`);
    return { sub: payload.sub, groups };
  };
}

/** Development only: `dev:<name>` is accepted as sub `dev-<name>` (the same rule as the sim's dev verifier). */
export function createDevBearerVerifier(requiredGroup: string): BearerVerifier {
  return async (token) => {
    const m = /^dev:([a-z0-9_-]{1,32})$/.exec(token);
    if (!m) throw new Error('invalid dev token');
    return { sub: `dev-${m[1]}`, groups: [requiredGroup] };
  };
}

/** `dev:` tokens go to the dev verifier when it exists; everything else to the OIDC verifier. */
export function combineBearer(oidc: BearerVerifier | null, dev: BearerVerifier | null): BearerVerifier | null {
  if (!oidc && !dev) return null;
  return async (token) => {
    if (token.startsWith('dev:')) {
      if (!dev) throw new Error('dev tokens are disabled');
      return dev(token);
    }
    if (!oidc) throw new Error('bearer tokens are not configured');
    return oidc(token);
  };
}
```

Replace `apps/api/src/auth/middleware.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../errors.js';
import type { BearerVerifier } from './bearer.js';
import type { SessionStore } from './session.js';

export interface RequestOperator {
  id: string;
  isAdmin: boolean;
  /** How the request authenticated: a browser session, or a bot's bearer token. */
  via: 'session' | 'bearer';
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
  /** Bots: `Authorization: Bearer <access token>` (SP5). Null = bearer auth is off. */
  bearer: BearerVerifier | null;
  /** Resolves (creating on first sight) the operator row for a bearer subject. */
  operatorForSub: (sub: string, isAdmin: boolean) => Promise<{ id: string }>;
}

/** Mutating requests must carry this header: browsers cannot add it cross-site, so it doubles as CSRF protection. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'daemonet';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function makeRequireAuth(deps: AuthMiddlewareDeps) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      // A bearer token cannot be sent by a browser cross-site, so no CSRF header is needed.
      if (!deps.bearer) throw unauthorized('bearer tokens are not accepted');
      let claims;
      try {
        claims = await deps.bearer(header.slice(7).trim());
      } catch (err) {
        throw unauthorized(`invalid token: ${(err as Error).message}`);
      }
      const isAdmin = claims.groups.includes(deps.adminGroup);
      const op = await deps.operatorForSub(claims.sub, isAdmin);
      req.operator = { id: op.id, isAdmin, via: 'bearer' };
      return;
    }
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
    req.operator = { id: session.operatorId, isAdmin: session.groups.includes(deps.adminGroup), via: 'session' };
  };
}

export function makeRequireAdmin() {
  return async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!req.operator) throw unauthorized('no session');
    if (!req.operator.isAdmin) throw forbidden('admin required');
  };
}

/** Used by app.ts to build `operatorForSub` (kept here so the middleware's dependencies are in one place). */
export type OperatorResolver = (prisma: PrismaClient, sub: string, isAdmin: boolean) => Promise<{ id: string }>;
```

`apps/api/src/app.ts`: `BuildAppOptions.bearer?: BearerVerifier | null`, and

```ts
  app.decorate(
    'requireAuth',
    makeRequireAuth({ sessionStore, ...common, bearer: o.bearer ?? null, operatorForSub: (sub, isAdmin) => ensureOperator(o.prisma, sub, isAdmin) }),
  );
```

(`ensureOperator` is exported by `auth/routes.ts`), then `registerExchangeRoutes(app, o.prisma, o.bus);`.

`apps/api/src/config.ts` adds the two optional variables and `botOidc: { issuer, clientId } | null`; `apps/api/src/server.ts` passes

```ts
  bearer: combineBearer(
    config.botOidc ? createBearerVerifier({ issuer: config.botOidc.issuer, audiences: [config.botOidc.clientId], requiredGroup: config.requiredGroup }) : null,
    config.devBypass ? createDevBearerVerifier(config.requiredGroup) : null,
  ),
```

`apps/api/package.json` gains `"jose": "^6.2.12"`. `scripts/provision-secrets.sh` adds `"AUTHENTIK_BOT_ISSUER_URL": "https://authentik.wispy-nook.casa/application/o/daemonet-bot/",` next to the bot client id.

- [ ] **Step 3: Routes**

Create `apps/api/src/routes/exchange.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import type { FastifyInstance } from 'fastify';

/** Exchange (SP5). Plan 1: the vault view; orders, listings and trades are added by plans 2–4. */
export function registerExchangeRoutes(app: FastifyInstance, prisma: PrismaClient, _bus: Bus): void {
  const auth = { preHandler: app.requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/api/exchange/vault', auth, async (req) => {
    const rows = await prisma.exchangeVault.findMany({ where: { operatorId: req.operator!.id }, orderBy: { item: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.item, r.qty]));
  });
}
```

`apps/api/src/routes/misc.ts`: `/api/disk` rows include `lockedBy: d.lockedBy`.

- [ ] **Step 4: Verify and commit**

`pnpm install && pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green. With the stack running under the dev bypass, `curl -H "authorization: Bearer dev:curlbot" http://127.0.0.1:3001/api/exchange/vault` returns `{}`.

```bash
git add apps/api scripts/provision-secrets.sh pnpm-lock.yaml
git commit -m "feat(api): bearer-token auth for bots, Exchange vault endpoint, Disk lock field"
```

---

### Task 3: Client

**Files:**
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/panels/HostPanel.tsx`, `apps/frontend/src/panels/DiskPanel.tsx`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: Vault view**

`api.ts`: `DiskDaemon.lockedBy: string | null`, tag `'Vault'`, `vault: b.query<Record<string, number>, void>({ query: () => '/exchange/vault', providesTags: ['Vault'] })`, hook `useVaultQuery`.

`HostPanel.tsx`: views become `['tickets', 'shop', 'craft', 'vault', 'ledger']`; add

```ts
  const vault = useVaultQuery(undefined, { skip: view !== 'vault' });
  const move = (dir: 'deposit' | 'withdraw', item: string) => run(client.operator[dir](item, qty).then(() => vault.refetch()), dir);
```

and the view:

```tsx
      {view === 'vault' && (
        <section className="space-y-2" data-testid="vault">
          <p className="text-xs text-neutral-500">The Exchange trades what is in your vault. Deposits and withdrawals happen here at the host ({qty} at a time).</p>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">inventory</h3>
            {Object.entries(me.inventory).filter(([, n]) => n > 0).map(([id, n]) => (
              <div key={id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-0.5 text-xs">
                <span>
                  {id} ×{n}
                </span>
                <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={!can || n < qty} onClick={() => move('deposit', id)} data-testid={`deposit-${id}`}>
                  deposit
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">vault</h3>
            {Object.keys(vault.data ?? {}).length === 0 && <p className="text-xs text-neutral-500">empty</p>}
            {Object.entries(vault.data ?? {}).map(([id, n]) => (
              <div key={id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-0.5 text-xs" data-testid={`vault-${id}`}>
                <span>
                  {id} ×{n}
                </span>
                <button className="rounded bg-neutral-800 px-2 hover:bg-neutral-700 disabled:opacity-40" disabled={!can || n < qty} onClick={() => move('withdraw', id)} data-testid={`withdraw-${id}`}>
                  withdraw
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
```

`DiskPanel.tsx`: a locked daemon shows `on the Exchange` and its **load** button is disabled. `sdk-types.ts`: `deposit(item: string, qty?: number): Promise<unknown>; withdraw(item: string, qty?: number): Promise<unknown>;` on `OperatorApi`.

- [ ] **Step 2: End-to-end**

In the economy scenario, after the craft assertions and before the tickets block:

```ts
  // vault: deposit one of the fragments, see it in the vault, take it back
  await page.getByTestId('tab-host').click();
  await page.getByTestId('host-vault').click();
  await page.getByTestId('deposit-frag:signal').click();
  await expect(page.getByTestId('vault-frag:signal')).toContainText('×1', { timeout: 10_000 });
  await page.getByTestId('withdraw-frag:signal').click();
  await expect(page.getByTestId('vault-frag:signal')).toHaveCount(0, { timeout: 10_000 });
```

- [ ] **Step 3: Verify and commit**

`pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 44 files, 374 tests; build, start the stack, `playwright test` — 4 passed.

```bash
git add apps/frontend
git commit -m "feat(frontend): Exchange vault view at the host, lock badge on Disk"
```

---

## Self-review

- **Spec coverage:** §4 `ExchangeVault`, `deposit` / `withdraw` at a host as durable intents with the overdraw failure, `Daemon.lockedBy` refused by `load` and shown by `/api/disk`, cookie-or-bearer auth with JWKS verification, audience, group, dev tokens, no CSRF for bearer, `GET /api/exchange/vault`, 120 / minute. "A held item must be unheld first" holds by construction (a held item is not in the inventory).
- **Type consistency:** the `vault` intent's signed `qty` means the same thing in the sim, both stores and the tests; `BearerVerifier` is the one type the middleware, the server and the tests use.
- **Placeholders:** none.
