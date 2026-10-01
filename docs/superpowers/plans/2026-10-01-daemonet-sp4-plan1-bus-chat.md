# Daemonet SP4 · Plan 1 — Bus and chat (with filter and reports) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators (and their scripts) can talk: chat over the game socket in subnet / cluster / org / DM channels with 7-day history, a chat filter (shipped default list + admin terms; block, mask, auto-mute), player reports with an admin queue, admin mute / delete, and a Redis-backed bus that carries admin actions from the api to the sim.

**Architecture:** A new `@daemonet/bus` package gives sim and api one `Bus` interface (`MemoryBus` for tests and Redis-less development, `RedisBus` over `ioredis`, everything under the `daemonet:` prefix). Chat is handled by a `ChatService` in the sim runtime — outside the tick, because channels span worlds: `Game` hands it `chat` commands, it cleans and filters the text, enforces mute and the 2-second limit, resolves recipients, stores the line through the store, sends a `chat` server message to every connection of every recipient and publishes on the bus. The api owns history, blocks, reports and moderation; its admin actions reach connected clients through the bus (`admin` channel: `mute`, `delete`, `filter`). The filter lives in `rules` (pure: `normalizeForFilter`, `compileFilter`, `applyFilter`, `nameAllowedBy`) so the sim, the api and tests agree; names go through it too.

**Tech Stack:** adds `ioredis` ^6. Everything else as before.

**Prerequisites:** SP3b plans 1–3 merged. Shared Redis reachable from S1 with ACL user `daemonet` (design §4.3 / §4.4); its password in `/root/.daemonet-redis-pw` on S2.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp4-social-design.md` §3, §4, §5, §5.1, §5.2. Decisions fixed here: chat does not count against the 8-commands-per-tick budget (it has its own limit); a store outage rejects the message instead of delivering it unrecorded; cluster history is live-only (clusters are not persisted) and org history arrives with plan 3; the reporter never learns the outcome.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues — reports are handled in-game by admins and acknowledged with "report received".
- Every Redis key and channel is prefixed `daemonet:` (the homelab ACL only allows that pattern).
- Slurs are not shipped in the repository: the default term list is short and generic; admins add the rest at runtime.
- Without `REDIS_URL` both services run on an in-process bus and log a warning; tests never require Redis (the Redis contract test runs only when `REDIS_URL` is set).

## File map

```
packages/bus/                               Bus, MemoryBus, RedisBus, createBus, PREFIX
packages/rules/src/content/chatfilter.ts    terms, normalizeForFilter, compileFilter, applyFilter, nameAllowedBy, cleanChatText, limits
packages/db/prisma/schema.prisma            ChatMessage, ChatBlock, ChatFilterTerm, ChatFilterHit, Report, Operator.mutedUntil (+ migration 20260930000005)
packages/shared/src/protocol.ts             chat command; chat / chatDeleted / muted server messages
packages/sdk/src/client.ts                  ChatApi (queueing send, dm, channels), chat events
apps/sim/src/runtime/chat.ts                ChatService
apps/sim/src/runtime/{game,store,prisma-store,config,main}.ts   wiring, ChatStore, REDIS_URL
apps/sim/src/core/systems/commands.ts       starter names through the filter
apps/api/src/routes/chat.ts                 history, blocks, reports, admin mute / delete / filter / hits / queue, nameAllowed, pruneChat
apps/api/src/{app,config,server}.ts         bus, REDIS_URL, prune timer
apps/frontend/src/game/chat.ts              chat store
apps/frontend/src/panels/{ChatPanel,AdminPanel}.tsx
scripts/provision-secrets.sh                REDIS_URL
```

---

### Task 1: The bus package

**Files:**
- Create: `packages/bus/package.json`, `packages/bus/tsconfig.json`, `packages/bus/src/index.ts`, `packages/bus/test/bus.test.ts`
- Modify: root `tsconfig.json` (add `{ "path": "packages/bus" }` before `packages/shared`)

**Interfaces:**
- `interface Bus { publish(channel, message): Promise<void>; subscribe(channel, handler): () => void; close(): Promise<void> }`
- `MemoryBus` (`log` of publishes; delivery on the next microtask, JSON-copied), `RedisBus(url)` (`ready()`), `createBus(redisUrl | undefined)`, `PREFIX = 'daemonet:'`.

- [ ] **Step 1: Package files**

`packages/bus/package.json`:

```json
{
  "name": "@daemonet/bus",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": { "ioredis": "^6.0.0" }
}
```

`packages/bus/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 2: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MemoryBus, PREFIX, RedisBus, createBus } from '../src/index.js';

describe('MemoryBus', () => {
  it('delivers JSON copies to every subscriber of a channel, asynchronously, and honours unsubscribe', async () => {
    const bus = new MemoryBus();
    const got: unknown[] = [];
    const off = bus.subscribe('chat', (m) => got.push(m));
    bus.subscribe('chat', (m) => got.push({ second: m }));
    const msg = { text: 'hi', nested: { n: 1 } };
    const p = bus.publish('chat', msg);
    expect(got).toEqual([]);
    await p;
    expect(got).toEqual([msg, { second: msg }]);
    expect(got[0]).not.toBe(msg);
    off();
    await bus.publish('chat', { text: 'again' });
    expect(got).toHaveLength(3);
    await bus.publish('other', { x: 1 });
    expect(bus.log.map((l) => l.channel)).toEqual(['chat', 'chat', 'other']);
  });

  it('createBus picks MemoryBus without a URL', () => {
    expect(createBus(undefined)).toBeInstanceOf(MemoryBus);
    expect(PREFIX).toBe('daemonet:');
  });
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)('RedisBus (needs REDIS_URL)', () => {
  it('publishes and receives across two buses under the daemonet: prefix', async () => {
    const a = new RedisBus(url!);
    const b = new RedisBus(url!);
    await Promise.all([a.ready(), b.ready()]);
    const got: unknown[] = [];
    b.subscribe('admin', (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 100));
    await a.publish('admin', { kind: 'mute', operatorId: 'x' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([{ kind: 'mute', operatorId: 'x' }]);
    await Promise.all([a.close(), b.close()]);
  });
});
```

- [ ] **Step 3: Implementation**

```ts
import { Redis } from 'ioredis';

/** Every key and channel the game touches in the shared Redis lives under this prefix (homelab ACL). */
export const PREFIX = 'daemonet:';

export type Handler = (message: unknown) => void;

/**
 * Pub/sub between the sim and the api (SP4 spec §4). Messages are JSON values; delivery is
 * at-most-once and never to the publisher's own handlers on RedisBus — MemoryBus mirrors that.
 */
export interface Bus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: Handler): () => void;
  close(): Promise<void>;
}

/** In-process bus for tests and local development without Redis. Publishing is asynchronous (next microtask). */
export class MemoryBus implements Bus {
  private readonly handlers = new Map<string, Set<Handler>>();
  /** Every publish, for assertions. */
  readonly log: Array<{ channel: string; message: unknown }> = [];

  async publish(channel: string, message: unknown): Promise<void> {
    this.log.push({ channel, message });
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    const hs = this.handlers.get(channel);
    if (!hs) return;
    await Promise.resolve();
    for (const h of [...hs]) h(copy);
  }

  subscribe(channel: string, handler: Handler): () => void {
    let hs = this.handlers.get(channel);
    if (!hs) this.handlers.set(channel, (hs = new Set()));
    hs.add(handler);
    return () => {
      hs.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

/** Redis pub/sub with one publishing and one subscribing connection; channels are prefixed. */
export class RedisBus implements Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub.on('message', (channel: string, raw: string) => {
      const hs = this.handlers.get(channel);
      if (!hs) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of [...hs]) h(message);
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.pub.publish(PREFIX + channel, JSON.stringify(message));
  }

  subscribe(channel: string, handler: Handler): () => void {
    const key = PREFIX + channel;
    let hs = this.handlers.get(key);
    if (!hs) {
      this.handlers.set(key, (hs = new Set()));
      void this.sub.subscribe(key);
    }
    hs.add(handler);
    return () => {
      hs!.delete(handler);
      if (hs!.size === 0) {
        this.handlers.delete(key);
        void this.sub.unsubscribe(key);
      }
    };
  }

  /** Resolves once the subscriber connection is ready (tests wait for it before publishing). */
  async ready(): Promise<void> {
    await Promise.all([this.pub.ping(), this.sub.ping()]);
  }

  async close(): Promise<void> {
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}

/** `REDIS_URL` set → RedisBus, otherwise MemoryBus (single-process development). */
export function createBus(redisUrl: string | undefined): Bus {
  return redisUrl ? new RedisBus(redisUrl) : new MemoryBus();
}
```

- [ ] **Step 4: Verify and commit**

`pnpm install` (the lockfile gains `ioredis`), then `pnpm exec tsc -b packages/bus && pnpm exec vitest run packages/bus` — expected: 2 passed, 1 skipped; with a local Redis (`docker run -d -p 127.0.0.1:6379:6379 redis:7-alpine`, `REDIS_URL=redis://127.0.0.1:6379/4`) 3 passed.

```bash
git add packages/bus tsconfig.json pnpm-lock.yaml
git commit -m "feat(bus): Bus interface with in-memory and Redis implementations"
```

---

### Task 2: Chat filter rules

**Files:**
- Create: `packages/rules/src/content/chatfilter.ts`, `packages/rules/test/chatfilter.test.ts`
- Modify: `packages/rules/src/index.ts` (`export * from './content/chatfilter.js';`)

**Interfaces:**
- `FilterTerm { pattern; kind: 'WORD' | 'REGEX'; action: 'BLOCK' | 'MASK' }`, `DEFAULT_TERMS`, `DEFAULT_FILTER`.
- `normalizeForFilter(text)`, `compileFilter(terms)`, `applyFilter(filter, text)` → `{ ok: true, text, masked[] } | { ok: false, term }`, `nameAllowedBy(filter, name)`, `cleanChatText(text)`.
- Limits: `CHAT_MAX_CHARS = 512`, `CHAT_INTERVAL_MS = 2000`, `CHAT_HISTORY_DAYS = 7`, `AUTO_MUTE_HITS = 3`, `AUTO_MUTE_WINDOW_MS = 600000`, `AUTO_MUTE_MINUTES = 10`, `REPORTS_PER_DAY = 8`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, applyFilter, cleanChatText, compileFilter, nameAllowedBy, normalizeForFilter } from '../src/content/chatfilter.js';

describe('normalizeForFilter', () => {
  it('folds case, leet and repeats, and removes separators inside words', () => {
    expect(normalizeForFilter('SpAm')).toBe('spam');
    expect(normalizeForFilter('sp4m')).toBe('spam');
    expect(normalizeForFilter('spaaaam')).toBe('spaam');
    expect(normalizeForFilter('s.p.a.m')).toBe('spam');
    expect(normalizeForFilter('hello   world ')).toBe('hello world');
    expect(normalizeForFilter('Épée')).toBe('epee');
  });
});

describe('applyFilter', () => {
  it('blocks, masks, and leaves clean text alone', () => {
    expect(applyFilter(DEFAULT_FILTER, 'trade anyone? tap for 2 packet frags')).toEqual({ ok: true, text: 'trade anyone? tap for 2 packet frags', masked: [] });
    expect(applyFilter(DEFAULT_FILTER, 'just KYS lol')).toEqual({ ok: false, term: 'kys' });
    expect(applyFilter(DEFAULT_FILTER, 'join https://example.test now')).toEqual({ ok: false, term: 'https?://' });
    expect(applyFilter(DEFAULT_FILTER, 'what the FUCK was that')).toEqual({ ok: true, text: 'what the *** was that', masked: ['fuck'] });
    expect(applyFilter(DEFAULT_FILTER, 'f.u.c.k this')).toMatchObject({ ok: true, text: '*** this' });
  });

  it('matches whole words only and ignores bad regexes', () => {
    const f = compileFilter([
      { pattern: 'ass', kind: 'WORD', action: 'MASK' },
      { pattern: '(', kind: 'REGEX', action: 'BLOCK' },
    ]);
    expect(f.terms).toHaveLength(1);
    expect(applyFilter(f, 'class assignment')).toMatchObject({ ok: true, text: 'class assignment' });
    expect(applyFilter(f, 'you ass')).toMatchObject({ text: 'you ***' });
  });
});

describe('nameAllowedBy', () => {
  it('checks the whole name and each part, refusing blocked and masked terms', () => {
    expect(nameAllowedBy(DEFAULT_FILTER, 'alice')).toBe(true);
    expect(nameAllowedBy(DEFAULT_FILTER, 'kys')).toBe(false);
    expect(nameAllowedBy(DEFAULT_FILTER, 'shit-lord')).toBe(false);
    expect(nameAllowedBy(DEFAULT_FILTER, 'root_user-7')).toBe(true);
  });
});

describe('cleanChatText', () => {
  it('strips control characters, collapses whitespace and caps at 512', () => {
    expect(cleanChatText('  hi\u0000 there\n\n you ')).toBe('hi there you');
    expect(cleanChatText('x'.repeat(600))).toHaveLength(512);
    expect(cleanChatText('\u0007')).toBe('');
  });
});
```

- [ ] **Step 2: Implementation**

```ts
/**
 * Chat filter (SP4 spec §5.1). The default term list ships here; admins add terms at runtime. Matching
 * runs on a normalised form of the text (case-folded, leet-substituted, repeated characters collapsed,
 * separators removed inside words) so `S.p.a.m` and `spaaam` match `spam`.
 */
export type FilterAction = 'BLOCK' | 'MASK';
export type FilterKind = 'WORD' | 'REGEX';

export interface FilterTerm {
  pattern: string;
  kind: FilterKind;
  action: FilterAction;
}

/** Deliberately short and generic: slurs and harassment terms are added by the admins, not shipped in the repo. */
export const DEFAULT_TERMS: readonly FilterTerm[] = [
  { pattern: 'kys', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'kill yourself', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'free bits', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'discord.gg', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'https?://', kind: 'REGEX', action: 'BLOCK' },
  { pattern: 'fuck', kind: 'WORD', action: 'MASK' },
  { pattern: 'shit', kind: 'WORD', action: 'MASK' },
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Case-fold, undo leet, collapse repeats, drop separators inside words. Pure. */
export function normalizeForFilter(text: string): string {
  const folded = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c);
  return folded
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[.\-_*~^`'"]+(?=\S)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CompiledFilter {
  terms: Array<FilterTerm & { re: RegExp }>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileFilter(terms: readonly FilterTerm[]): CompiledFilter {
  return {
    terms: terms.flatMap((t) => {
      try {
        const source = t.kind === 'REGEX' ? t.pattern : `(?<![a-z])${escape(normalizeForFilter(t.pattern))}(?![a-z])`;
        return [{ ...t, re: new RegExp(source, 'i') }];
      } catch {
        return [];
      }
    }),
  };
}

export type FilterResult = { ok: true; text: string; masked: string[] } | { ok: false; term: string };

/** BLOCK wins over MASK; masking replaces the offending words in the *original* text with `***`. */
export function applyFilter(filter: CompiledFilter, text: string): FilterResult {
  const norm = normalizeForFilter(text);
  const masked: string[] = [];
  let out = text;
  for (const t of filter.terms) {
    if (!t.re.test(norm)) continue;
    if (t.action === 'BLOCK') return { ok: false, term: t.pattern };
    masked.push(t.pattern);
    const words = text.split(/(\s+)/);
    out = words.map((w) => (/\s/.test(w) || !t.re.test(normalizeForFilter(w)) ? w : '***')).join('');
    text = out;
  }
  return { ok: true, text: out, masked };
}

export const DEFAULT_FILTER: CompiledFilter = compileFilter(DEFAULT_TERMS);

/** Names (operators, orgs, tags) join words with - _ . so each part is checked on its own as well as the whole; masked terms are refused too. */
export function nameAllowedBy(filter: CompiledFilter, name: string): boolean {
  return [name, ...name.split(/[-_.\s]+/)].every((part) => {
    const r = applyFilter(filter, part);
    return r.ok && r.masked.length === 0;
  });
}

export const CHAT_MAX_CHARS = 512;
export const CHAT_INTERVAL_MS = 2000;
export const CHAT_HISTORY_DAYS = 7;
/** BLOCK hits within this window that trigger an automatic mute of AUTO_MUTE_MINUTES. */
export const AUTO_MUTE_HITS = 3;
export const AUTO_MUTE_WINDOW_MS = 10 * 60_000;
export const AUTO_MUTE_MINUTES = 10;
export const REPORTS_PER_DAY = 8;

/** Trim, strip control characters, cap the length. Empty result = nothing to send. */
export function cleanChatText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_CHARS);
}
```

- [ ] **Step 3: Verify and commit**

`pnpm exec vitest run packages/rules/test/chatfilter.test.ts` — expected: 5 passed.

```bash
git add packages/rules
git commit -m "feat(rules): chat filter (normalisation, block / mask, name check) and chat limits"
```

---

### Task 3: Chat in the sim

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000005_sp4_chat/migration.sql`
- Modify: `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`
- Create: `apps/sim/src/runtime/chat.ts`, `apps/sim/test/chat.test.ts`
- Modify: `apps/sim/src/runtime/game.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`, `apps/sim/src/runtime/config.ts`, `apps/sim/src/runtime/main.ts`, `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/package.json`, `apps/sim/tsconfig.json`, sim tests that construct a `Game`, `apps/sim/test/helpers.ts`, `apps/sim/test/commands.test.ts`

**Interfaces:**
- Protocol: command `chat { channel, text }`; server messages `chat { id, channel, from, name, tag, text, at }`, `chatDeleted { id, channel }`, `muted { until | null }`.
- `ChatStore { appendChat(row), recordFilterHit(hit), setMute(operatorId, until), isBlocked(blocker, blocked), listFilterTerms() }`; `Store extends ChatStore`; `ChatRow { id, channel, operatorId, toId, text, at }`.
- `ChatService(host: ChatHost, store: ChatStore, bus: Bus, log?)`: `post(from, channel, text)` → `null | { code, message }`, `recipients(from, channel)`, `mute(operatorId, until, reason?)`, `isMuted`, `loadMute`, `setExtraTerms`, `close`. `ChatHost { operator(id), operatorIds(), send(operatorId, msg), clusterOf?, orgOf?, now() }` — plans 2 and 3 supply `clusterOf` / `orgOf`.
- `GameOptions.bus: Bus` (required); `game.chat`; `game.loadChatTerms()`.
- `OperatorRecord.mutedUntil` / `Operator.mutedUntil` (`string | null`).
- Config: `REDIS_URL` (optional) → `config.redisUrl`.
- SDK: `client.chat.send(channel, text)` (queues, ≤ 1 per 2 s), `client.chat.dm(operatorId, text)`, `client.chat.channels`, events `chat`, `chatDeleted`, `muted`.

- [ ] **Step 1: Schema and migration**

Add `mutedUntil DateTime?` to `model Operator` (after `isAdmin`, with the comment `/// chat mute (admin or automatic), null = not muted`) and these models before `enum TicketStatus`:

```prisma
/// Chat (SP4 spec §5): 7 days of history, soft-deleted by admins.
model ChatMessage {
  id         String    @id
  /// subnet:<id> | cluster:<id> | org:<id> | dm:<operatorId>
  channel    String
  operatorId String
  /// for dm channels: the recipient
  toId       String?
  text       String
  at         DateTime  @default(now())
  deletedAt  DateTime?

  @@index([channel, at])
  @@index([operatorId, at])
}

model ChatBlock {
  blockerId String
  blockedId String
  at        DateTime @default(now())

  @@id([blockerId, blockedId])
}

enum FilterKind {
  WORD
  REGEX
}

enum FilterAction {
  BLOCK
  MASK
}

/// Admin-added chat filter terms (the default list ships in rules).
model ChatFilterTerm {
  id      String       @id @default(uuid())
  pattern String
  kind    FilterKind
  action  FilterAction
  addedBy String
  at      DateTime     @default(now())
}

model ChatFilterHit {
  id         String   @id @default(uuid())
  operatorId String
  channel    String
  text       String
  term       String
  at         DateTime @default(now())

  @@index([operatorId, at])
}

enum ReportReason {
  SPAM
  HARASSMENT
  CHEATING
  NAME
  OTHER
}

enum ReportStatus {
  OPEN
  ACTIONED
  DISMISSED
}

/// Player reports (SP4 spec §5.2); resolved by admins in-game, never linked out.
model Report {
  id         String       @id @default(uuid())
  reporterId String
  targetId   String
  messageId  String?
  reason     ReportReason
  note       String       @default("")
  status     ReportStatus @default(OPEN)
  resolvedBy String?
  resolvedAt DateTime?
  action     String?
  at         DateTime     @default(now())

  @@unique([reporterId, messageId])
  @@index([status, at])
  @@index([reporterId, at])
}
```

Migration `packages/db/prisma/migrations/20260930000005_sp4_chat/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "FilterKind" AS ENUM ('WORD', 'REGEX');

-- CreateEnum
CREATE TYPE "FilterAction" AS ENUM ('BLOCK', 'MASK');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "toId" TEXT,
    "text" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatBlock" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatBlock_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "ChatFilterTerm" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "kind" "FilterKind" NOT NULL,
    "action" "FilterAction" NOT NULL,
    "addedBy" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFilterTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatFilterHit" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFilterHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "messageId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "action" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_channel_at_idx" ON "ChatMessage"("channel", "at");

-- CreateIndex
CREATE INDEX "ChatMessage_operatorId_at_idx" ON "ChatMessage"("operatorId", "at");

-- CreateIndex
CREATE INDEX "ChatFilterHit_operatorId_at_idx" ON "ChatFilterHit"("operatorId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_messageId_key" ON "Report"("reporterId", "messageId");

-- CreateIndex
CREATE INDEX "Report_status_at_idx" ON "Report"("status", "at");

-- CreateIndex
CREATE INDEX "Report_reporterId_at_idx" ON "Report"("reporterId", "at");
```

Run `prisma migrate deploy` and `prisma generate`; add `"ChatMessage", "ChatBlock", "ChatFilterTerm", "ChatFilterHit", "Report"` to the `TRUNCATE` list in `apps/api/test/app.test.ts`.

- [ ] **Step 2: Protocol and SDK**

`packages/shared/src/protocol.ts` — command (after `abandonTicket`):

```ts
  z.object({ cmd: z.literal('chat'), actor: Self, args: z.object({ channel: z.string().min(3).max(80), text: z.string().min(1).max(512) }) }),
```

and, at the head of the `ServerMessage` union:

```ts
  /** A chat line for a channel the receiver is in (SP4). */
  z.object({
    t: z.literal('chat'),
    seq: Seq,
    d: z.object({ id: Id, channel: z.string(), from: Id, name: z.string().nullable(), tag: z.string().nullable(), text: z.string(), at: z.string() }),
  }),
  z.object({ t: z.literal('chatDeleted'), seq: Seq, d: z.object({ id: Id, channel: z.string() }) }),
  z.object({ t: z.literal('muted'), seq: Seq, d: z.object({ until: z.string().nullable() }) }),
```

`packages/sdk/src/client.ts`: add to `ClientEvents`

```ts
  /** Chat (SP4): a line for a channel you are in; an admin deletion; your mute state changed. */
  chat: Extract<ServerMessage, { t: 'chat' }>['d'];
  chatDeleted: Extract<ServerMessage, { t: 'chatDeleted' }>['d'];
  muted: Extract<ServerMessage, { t: 'muted' }>['d'];
```

handle the three messages in the frame switch (`case 'chat': this.emit('chat', msg.d); return;` and likewise for `chatDeleted`, `muted`), add `readonly chat = new ChatApi(this);` to `GameClient`, and the class before `GameClient`:

```ts
/** Chat (SP4): one message every 2 s; `send` queues locally so scripts never hit E_RATE. */
export class ChatApi {
  private queue: Array<{ channel: string; text: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = -Infinity;
  constructor(private readonly client: GameClient) {}

  /** Channels this operator can post to right now. */
  get channels(): string[] {
    const out = [`subnet:${this.client.subnet}`];
    const self = this.client.self as { cluster?: { id: string } | null; org?: { id: string } | null } | undefined;
    if (self?.cluster) out.push(`cluster:${self.cluster.id}`);
    if (self?.org) out.push(`org:${self.org.id}`);
    return out;
  }

  send(channel: string, text: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ channel, text, resolve, reject });
      this.pump();
    });
  }

  /** Direct message to an operator id. */
  dm(operatorId: string, text: string): Promise<unknown> {
    return this.send(`dm:${operatorId}`, text);
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastSent + 2000 - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.queue.shift();
      if (!next) return;
      this.lastSent = Date.now();
      this.client.command({ cmd: 'chat', actor: 'self', args: { channel: next.channel, text: next.text } }).then(next.resolve, next.reject);
      this.pump();
    }, wait);
  }
}
```

- [ ] **Step 3: Failing tests**

Create `apps/sim/test/chat.test.ts`:

```ts
import { MemoryBus } from '@daemonet/bus';
import type { ServerMessage } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/core/index.js';
import { createDevVerifier } from '../src/runtime/auth.js';
import { ChatService, type ChatHost } from '../src/runtime/chat.js';
import { Game, type Conn } from '../src/runtime/game.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, TEST_SUBNET_B } from './helpers.js';

/** A chat host over a hand-built roster (no worlds), with a controllable clock. */
function harness() {
  const roster = new Map<string, { name: string; subnet: string; org?: { id: string; tag: string }; cluster?: { id: string; members: string[] } }>();
  const sent: Array<{ to: string; msg: ServerMessage }> = [];
  let now = Date.parse(FIXED_CLOCK);
  const host: ChatHost = {
    operator: (id) => {
      const r = roster.get(id);
      return r ? { op: { id, name: r.name } as never, subnet: r.subnet } : undefined;
    },
    operatorIds: () => roster.keys(),
    send: (to, msg) => sent.push({ to, msg }),
    clusterOf: (id) => roster.get(id)?.cluster,
    orgOf: (id) => roster.get(id)?.org,
    now: () => now,
  };
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const chat = new ChatService(host, store, bus);
  return { roster, sent, store, bus, chat, tick: (ms: number) => (now += ms), lines: (to: string) => sent.filter((s) => s.to === to && s.msg.t === 'chat').map((s) => (s.msg as Extract<ServerMessage, { t: 'chat' }>).d) };
}

describe('ChatService', () => {
  it('delivers subnet chat to everyone in that subnet, stores it, publishes it, and acks', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.roster.set('b', { name: 'bob', subnet: 'lo' });
    h.roster.set('c', { name: 'carol', subnet: 'lan' });
    expect(await h.chat.post('a', 'subnet:lo', '  hello   there ')).toBeNull();
    expect(h.lines('a')).toMatchObject([{ channel: 'subnet:lo', from: 'a', name: 'alice', tag: null, text: 'hello there' }]);
    expect(h.lines('b')).toHaveLength(1);
    expect(h.lines('c')).toHaveLength(0);
    expect(h.store.chat).toMatchObject([{ channel: 'subnet:lo', operatorId: 'a', toId: null, text: 'hello there' }]);
    expect(h.bus.log).toMatchObject([{ channel: 'chat', message: { channel: 'subnet:lo', text: 'hello there' } }]);
  });

  it('guards: empty, wrong subnet, unknown channel, rate limit, DMs to blockers, cluster and org membership', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo', org: { id: 'o1', tag: 'ROOT' } });
    h.roster.set('b', { name: 'bob', subnet: 'lan', org: { id: 'o1', tag: 'ROOT' }, cluster: { id: 'c1', members: ['b', 'd'] } });
    h.roster.set('d', { name: 'dan', subnet: 'lan', cluster: { id: 'c1', members: ['b', 'd'] } });
    expect(await h.chat.post('a', 'subnet:lo', '\u0007')).toMatchObject({ code: 'E_INVALID' });
    expect(await h.chat.post('a', 'subnet:lan', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'nope', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'cluster:c1', 'hi')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'org:o1', 'org hi')).toBeNull();
    expect(h.lines('b').map((l) => l.text)).toEqual(['org hi']);
    expect(h.lines('b')[0]!.tag).toBe('ROOT');
    expect(h.lines('d')).toHaveLength(0);
    expect(await h.chat.post('a', 'org:o1', 'too fast')).toMatchObject({ code: 'E_RATE' });
    h.tick(2000);
    expect(await h.chat.post('b', 'cluster:c1', 'cluster hi')).toBeNull();
    expect(h.lines('d').map((l) => l.text)).toEqual(['cluster hi']);
    h.store.blocks.add('d:a');
    h.tick(2000);
    expect(await h.chat.post('a', 'dm:d', 'psst')).toMatchObject({ code: 'E_STATE' });
    expect(await h.chat.post('a', 'dm:b', 'psst')).toBeNull();
    expect(h.lines('b').at(-1)).toMatchObject({ channel: 'dm:b', from: 'a', text: 'psst' });
    expect(h.lines('a').at(-1)).toMatchObject({ channel: 'dm:b', text: 'psst' });
    expect(h.store.chat.at(-1)).toMatchObject({ toId: 'b' });
    h.tick(2000);
    expect(await h.chat.post('a', 'dm:a', 'me')).toMatchObject({ code: 'E_STATE' });
  });

  it('filters: masks, blocks with a recorded hit, auto-mutes after three blocks, and honours admin mutes / deletes / terms from the bus', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    expect(await h.chat.post('a', 'subnet:lo', 'what the fuck')).toBeNull();
    expect(h.lines('a')[0]!.text).toBe('what the ***');
    for (let i = 0; i < 3; i++) {
      h.tick(2000);
      expect(await h.chat.post('a', 'subnet:lo', 'kys')).toMatchObject({ code: 'E_INVALID', message: 'message blocked by the chat filter' });
    }
    expect(h.store.filterHits).toHaveLength(3);
    expect(h.chat.isMuted('a')).toBe(true);
    expect(h.store.mutes.get('a')).toMatch(/^2026-09-30T00:10/);
    expect(h.sent.filter((s) => s.msg.t === 'muted')).toHaveLength(1);
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'hello?')).toMatchObject({ code: 'E_STATE' });
    h.tick(11 * 60_000);
    expect(h.chat.isMuted('a')).toBe(false);
    expect(await h.chat.post('a', 'subnet:lo', 'hello?')).toBeNull();
    // admin actions arrive on the bus
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: new Date(Date.parse(FIXED_CLOCK) + 3_600_000 * 24).toISOString() });
    expect(h.chat.isMuted('a')).toBe(true);
    await h.bus.publish('admin', { kind: 'mute', operatorId: 'a', until: null });
    expect(h.chat.isMuted('a')).toBe(false);
    await h.bus.publish('admin', { kind: 'delete', id: 'm1', channel: 'subnet:lo' });
    expect(h.sent.at(-1)!.msg).toMatchObject({ t: 'chatDeleted', d: { id: 'm1' } });
    await h.bus.publish('admin', { kind: 'filter', terms: [{ pattern: 'banana', kind: 'WORD', action: 'BLOCK' }] });
    h.tick(2000);
    expect(await h.chat.post('a', 'subnet:lo', 'BANANA time')).toMatchObject({ code: 'E_INVALID' });
    h.chat.close();
  });

  it('loads mutes from the record and reports a store outage instead of delivering', async () => {
    const h = harness();
    h.roster.set('a', { name: 'alice', subnet: 'lo' });
    h.chat.loadMute('a', new Date(Date.parse(FIXED_CLOCK) + 60_000).toISOString());
    expect(h.chat.isMuted('a')).toBe(true);
    h.chat.loadMute('a', null);
    h.store.appendChat = async () => {
      throw new Error('db down');
    };
    expect(await h.chat.post('a', 'subnet:lo', 'hi')).toMatchObject({ code: 'E_STATE', message: 'chat is unavailable right now' });
    expect(h.lines('a')).toHaveLength(0);
  });
});

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

describe('chat through the Game', () => {
  it('routes the chat command outside the tick budget and delivers to the sender’s subnet only', async () => {
    const store = new MemoryStore();
    const a = new World({ subnet: TEST_SUBNET, seed: 'a', seedId: 'aaaa0001', spawner: false });
    const b = new World({ subnet: TEST_SUBNET_B, seed: 'b', seedId: 'bbbb0002', spawner: false });
    const game = new Game({ worlds: [a, b], store, verify: createDevVerifier('daemonet-users'), bus: new MemoryBus() });
    const join = async (name: string) => {
      const conn = new FakeConn();
      game.connect(conn);
      await game.message(conn, JSON.stringify({ t: 'auth', seq: 1, d: { token: `dev:${name}` } }));
      return conn;
    };
    const alice = await join('alice');
    const rec = await store.loadOrCreateOperator('dev-bob', 'test', a.subnet.spawn);
    store.operators.get(rec.id)!.subnet = 'testb';
    const bob = await join('bob');
    const spectator = new FakeConn();
    game.connect(spectator);
    await game.message(spectator, JSON.stringify({ t: 'auth', seq: 1, d: { token: 'dev:alice', role: 'spectator' } }));
    await game.message(alice, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c1', cmd: 'chat', actor: 'self', args: { channel: 'subnet:test', text: 'anyone here?' } } }));
    await game.flush();
    expect(alice.of('ack').map((m) => m.d.reqId)).toEqual(['c1']);
    expect(alice.of('chat').map((m) => m.d.text)).toEqual(['anyone here?']);
    expect(spectator.of('chat')).toHaveLength(1);
    expect(bob.of('chat')).toHaveLength(0);
    await game.message(bob, JSON.stringify({ t: 'cmd', seq: 2, d: { reqId: 'c2', cmd: 'chat', actor: 'self', args: { channel: 'subnet:test', text: 'wrong subnet' } } }));
    await game.flush();
    expect(bob.of('err').at(-1)!.d).toMatchObject({ reqId: 'c2', code: 'E_STATE' });
    await game.shutdown();
  });
});
```

Every existing `new Game({...})` in the sim tests gains `bus: new MemoryBus()` (import from `@daemonet/bus`); `operatorRecord` in the helpers gains `mutedUntil: null`. Add to `apps/sim/test/commands.test.ts` (last describe):

```ts
  it('refuses operator names the chat filter would block or mask', () => {
    const world = makeWorld();
    world.addOperator(operatorRecord('newbie', { starterClaimed: false, name: null, ram: [] }));
    const claim = (operatorName: string) => step(world, input('newbie', { cmd: 'claimStarter', actor: self, args: { species: 'pingling', operatorName } }));
    expect(claim('kys').replies[0]).toMatchObject({ code: 'E_INVALID', message: 'that name is not allowed' });
    expect(claim('shit-lord').replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(claim('newbie').intents[0]).toMatchObject({ kind: 'claimStarter', name: 'newbie' });
  });
```

- [ ] **Step 4: The chat service**

Create `apps/sim/src/runtime/chat.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import {
  AUTO_MUTE_HITS,
  AUTO_MUTE_MINUTES,
  AUTO_MUTE_WINDOW_MS,
  CHAT_INTERVAL_MS,
  DEFAULT_TERMS,
  applyFilter,
  cleanChatText,
  compileFilter,
  type CompiledFilter,
  type FilterTerm,
} from '@daemonet/rules';
import type { ServerMessage } from '@daemonet/shared';
import type { Operator } from '../core/index.js';
import type { ChatStore } from './store.js';

/** What the chat service needs from the game: who is connected, where, and how to reach them. */
export interface ChatHost {
  /** Connected operators (controller or spectators), with their current world's subnet. */
  operator(id: string): { op: Operator; subnet: string } | undefined;
  operatorIds(): Iterable<string>;
  /** Sends to every connection of the operator. */
  send(operatorId: string, msg: Extract<ServerMessage, { t: 'chat' | 'chatDeleted' | 'muted' }>): void;
  /** Cluster / org membership resolution (plans 2–3 fill these in; until then nobody is in one). */
  clusterOf?(operatorId: string): { id: string; members: Iterable<string> } | undefined;
  orgOf?(operatorId: string): { id: string; tag: string } | undefined;
  now(): number;
}

export interface ChatLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}

export type AdminMessage =
  | { kind: 'mute'; operatorId: string; until: string | null; reason?: string }
  | { kind: 'delete'; id: string; channel: string }
  | { kind: 'filter'; terms: FilterTerm[] }
  | { kind: string; [k: string]: unknown };

let counter = 0;

/**
 * Chat over the game socket (SP4 spec §5): guards, the filter, persistence through the store, delivery to
 * every connected member of the channel, and the bus for the API's consumers and admin actions.
 */
export class ChatService {
  private filter: CompiledFilter = compileFilter(DEFAULT_TERMS);
  private readonly lastAt = new Map<string, number>();
  private readonly muted = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly host: ChatHost,
    private readonly store: ChatStore,
    private readonly bus: Bus,
    private readonly log: { warn(obj: object, msg?: string): void } = { warn() {} },
  ) {
    this.unsubscribe = bus.subscribe('admin', (m) => this.onAdmin(m as AdminMessage));
  }

  /** Terms added by admins (loaded at boot, refreshed on the bus). */
  setExtraTerms(terms: readonly FilterTerm[]): void {
    this.filter = compileFilter([...DEFAULT_TERMS, ...terms]);
  }

  /** Called when an operator's record is loaded (mute from the DB). */
  loadMute(operatorId: string, until: string | null): void {
    if (until && Date.parse(until) > this.host.now()) this.muted.set(operatorId, Date.parse(until));
    else this.muted.delete(operatorId);
  }

  isMuted(operatorId: string): boolean {
    const until = this.muted.get(operatorId);
    if (until === undefined) return false;
    if (until <= this.host.now()) {
      this.muted.delete(operatorId);
      return false;
    }
    return true;
  }

  /** Who a message on `channel` from `from` reaches (including the sender); null when `from` may not post there. */
  recipients(from: string, channel: string): string[] | null {
    const me = this.host.operator(from);
    if (!me) return null;
    const [kind, id] = channel.split(':', 2);
    if (!id) return null;
    switch (kind) {
      case 'subnet': {
        if (me.subnet !== id) return null;
        const out: string[] = [];
        for (const oid of this.host.operatorIds()) if (this.host.operator(oid)?.subnet === id) out.push(oid);
        return out;
      }
      case 'cluster': {
        const c = this.host.clusterOf?.(from);
        return c && c.id === id ? [...c.members] : null;
      }
      case 'org': {
        const o = this.host.orgOf?.(from);
        if (!o || o.id !== id) return null;
        const out: string[] = [];
        for (const oid of this.host.operatorIds()) if (this.host.orgOf?.(oid)?.id === id) out.push(oid);
        return out;
      }
      case 'dm':
        if (id === from) return null;
        return [from, id];
      default:
        return null;
    }
  }

  /** Handles a `chat` command. Returns an error to send back, or null when accepted. */
  async post(from: string, channel: string, rawText: string): Promise<{ code: 'E_STATE' | 'E_RATE' | 'E_INVALID'; message: string } | null> {
    const text = cleanChatText(rawText);
    if (!text) return { code: 'E_INVALID', message: 'empty message' };
    if (this.isMuted(from)) return { code: 'E_STATE', message: `muted until ${new Date(this.muted.get(from)!).toISOString()}` };
    const now = this.host.now();
    const last = this.lastAt.get(from) ?? -Infinity;
    if (now - last < CHAT_INTERVAL_MS) return { code: 'E_RATE', message: 'one message every 2 seconds' };
    const to = this.recipients(from, channel);
    if (!to) return { code: 'E_STATE', message: 'you cannot post to that channel' };
    if (channel.startsWith('dm:')) {
      const target = channel.slice(3);
      if (await this.store.isBlocked(target, from)) return { code: 'E_STATE', message: 'that operator is not accepting your messages' };
    }
    const filtered = applyFilter(this.filter, text);
    if (!filtered.ok) {
      this.lastAt.set(from, now);
      void this.store.recordFilterHit({ operatorId: from, channel, text, term: filtered.term }).catch((err: Error) => this.log.warn({ err: err.message }, 'filter hit not recorded'));
      const recent = (this.hits.get(from) ?? []).filter((t) => now - t < AUTO_MUTE_WINDOW_MS);
      recent.push(now);
      this.hits.set(from, recent);
      if (recent.length >= AUTO_MUTE_HITS) {
        this.hits.delete(from);
        await this.mute(from, new Date(now + AUTO_MUTE_MINUTES * 60_000).toISOString(), 'filter');
      }
      return { code: 'E_INVALID', message: 'message blocked by the chat filter' };
    }
    this.lastAt.set(from, now);
    const me = this.host.operator(from)!;
    const line: ChatLine = {
      id: `m${now.toString(36)}${(++counter).toString(36)}`,
      channel,
      from,
      name: me.op.name,
      tag: this.host.orgOf?.(from)?.tag ?? null,
      text: filtered.text,
      at: new Date(now).toISOString(),
    };
    try {
      await this.store.appendChat({ id: line.id, channel, operatorId: from, toId: channel.startsWith('dm:') ? channel.slice(3) : null, text: line.text, at: line.at });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'chat line not stored');
      return { code: 'E_STATE', message: 'chat is unavailable right now' };
    }
    for (const oid of to) this.host.send(oid, { t: 'chat', seq: 0, d: line });
    void this.bus.publish('chat', line);
    return null;
  }

  /** Mutes (or unmutes with null) and tells the operator; persisted through the store. */
  async mute(operatorId: string, until: string | null, reason = 'admin'): Promise<void> {
    if (until) this.muted.set(operatorId, Date.parse(until));
    else this.muted.delete(operatorId);
    try {
      await this.store.setMute(operatorId, until);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, reason }, 'mute not stored');
    }
    this.host.send(operatorId, { t: 'muted', seq: 0, d: { until } });
  }

  private onAdmin(m: AdminMessage): void {
    switch (m.kind) {
      case 'mute': {
        const mm = m as Extract<AdminMessage, { kind: 'mute' }>;
        if (mm.until) this.muted.set(mm.operatorId, Date.parse(mm.until));
        else this.muted.delete(mm.operatorId);
        this.host.send(mm.operatorId, { t: 'muted', seq: 0, d: { until: mm.until } });
        return;
      }
      case 'delete': {
        const d = m as Extract<AdminMessage, { kind: 'delete' }>;
        for (const oid of this.host.operatorIds()) this.host.send(oid, { t: 'chatDeleted', seq: 0, d: { id: d.id, channel: d.channel } });
        return;
      }
      case 'filter':
        this.setExtraTerms((m as Extract<AdminMessage, { kind: 'filter' }>).terms);
        return;
    }
  }

  close(): void {
    this.unsubscribe();
  }
}
```

- [ ] **Step 5: Stores, model, command guard**

Replace `apps/sim/src/runtime/store.ts`:

```ts
import { dayKey, getSpecies, ticketKey, type FilterTerm, type TicketParams } from '@daemonet/rules';
import type { Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';

export interface IntentContext {
  seedId: string;
  /** For `store`: the daemon's current state, written along with the move to Disk. */
  storedDaemon?: OwnedDaemonRecord;
}

export interface ChatRow {
  id: string;
  channel: string;
  operatorId: string;
  toId: string | null;
  text: string;
  at: string;
}

/** What the chat service persists (SP4 spec §5). */
export interface ChatStore {
  appendChat(row: ChatRow): Promise<void>;
  recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void>;
  setMute(operatorId: string, until: string | null): Promise<void>;
  /** `blocker` has blocked `blocked`. */
  isBlocked(blocker: string, blocked: string): Promise<boolean>;
  /** Admin-added filter terms (loaded at boot). */
  listFilterTerms(): Promise<FilterTerm[]>;
}

/** Persistence used by the runtime. Every method may throw on infrastructure failure (the runtime retries intents). */
export interface Store extends ChatStore {
  /** Registers this boot's world seed; the returned id (8 hex chars) prefixes every generated id. */
  createSeed(subnet: string): Promise<{ id: string; seed: string }>;
  loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord>;
  /** Idempotent by intent.id. Domain failures (name taken, not on Disk) resolve with ok: false. */
  applyIntent(intent: Intent, ctx: IntentContext): Promise<IntentResult>;
  checkpoint(records: readonly OperatorRecord[]): Promise<void>;
  /** Form ids with a Discovery row (loaded once at boot into World.discovered). */
  listDiscoveries(): Promise<string[]>;
  /** Credits (or debits) bits outside the sim's intents — admin grants, dev seeding, ticket payouts (SP3b plan 3). */
  grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void>;
  ledgerFor(operatorId: string, limit?: number): Promise<LedgerRow[]>;
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
  subnet: string;
  bits: number;
  diskCapacity: number;
  x: number;
  y: number;
  inventory: Record<string, number>;
}

export interface TicketRow {
  id: string;
  operatorId: string;
  day: string;
  subnet: string;
  index: number;
  kind: 'clear' | 'capture' | 'deliver' | 'evolve';
  params: TicketParams;
  target: number;
  reward: number;
  progress: number;
  status: 'OPEN' | 'DONE' | 'ABANDONED';
  acceptedAt: string;
  completedAt: string | null;
}

export interface LedgerRow {
  operatorId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}

/** In-memory Store with the same semantics as PrismaStore. Used by tests and local development. */
export class MemoryStore implements Store {
  readonly operators = new Map<string, MemOperator>();
  readonly daemons = new Map<string, MemDaemon>();
  readonly applied = new Set<string>();
  readonly seeds: Array<{ id: string; seed: string; subnet: string }> = [];
  readonly discoveries = new Map<string, { operatorId: string; discoveredAt: string }>();
  readonly ledger: LedgerRow[] = [];
  readonly archive = new Map<string, MemDaemon & { reason: string; archivedAt: string }>();
  readonly tickets = new Map<string, TicketRow>();
  readonly chat: ChatRow[] = [];
  readonly filterHits: Array<{ operatorId: string; channel: string; text: string; term: string }> = [];
  readonly blocks = new Set<string>();
  readonly filterTerms: FilterTerm[] = [];
  readonly mutes = new Map<string, string | null>();
  /** `${operatorId}:${line}` -> points */
  readonly research = new Map<string, number>();
  /** Wall clock for "today" (tests override). */
  now: () => string = () => new Date().toISOString();

  private researchFor(operatorId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, points] of this.research) if (key.startsWith(`${operatorId}:`)) out[key.slice(operatorId.length + 1)] = points;
    return out;
  }

  private addResearch(operatorId: string, species: string): void {
    const key = `${operatorId}:${getSpecies(species).line}`;
    this.research.set(key, (this.research.get(key) ?? 0) + 1);
  }
  /** Tests set this to make the next N applyIntent calls throw. */
  failNext = 0;

  async createSeed(subnet: string) {
    const row = { id: randomHex(4), seed: randomHex(16), subnet };
    this.seeds.push(row);
    return { id: row.id, seed: row.seed };
  }

  async loadOrCreateOperator(sub: string, subnet: string, spawn: Point): Promise<OperatorRecord> {
    let op = [...this.operators.values()].find((o) => o.sub === sub);
    if (!op) {
      op = { id: crypto.randomUUID(), sub, name: null, starterClaimed: false, subnet, bits: 0, diskCapacity: 256, x: spawn.x, y: spawn.y, inventory: {} };
      this.operators.set(op.id, op);
    }
    const mine = [...this.daemons.values()].filter((d) => d.operatorId === op.id);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: op.bits,
      diskCapacity: op.diskCapacity,
      inventory: { ...op.inventory },
      ram: mine.filter((d) => d.location === 'RAM').sort((a, b) => a.slot - b.slot).map(({ operatorId: _o, location: _l, ...rec }) => ({ ...rec })),
      diskSlots: mine.filter((d) => d.location === 'DISK').map((d) => d.slot).sort((a, b) => a - b),
      ...this.ticketState(op.id),
      research: this.researchFor(op.id),
      mutedUntil: this.mutes.get(op.id) ?? null,
    };
  }

  async appendChat(row: ChatRow): Promise<void> {
    this.chat.push({ ...row });
  }
  async recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void> {
    this.filterHits.push({ ...hit });
  }
  async setMute(operatorId: string, until: string | null): Promise<void> {
    this.mutes.set(operatorId, until);
  }
  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    return this.blocks.has(`${blocker}:${blocked}`);
  }
  async listFilterTerms(): Promise<FilterTerm[]> {
    return [...this.filterTerms];
  }

  private ticketState(operatorId: string): Pick<OperatorRecord, 'tickets' | 'ticketsToday' | 'ticketsDay' | 'acceptedToday'> {
    const day = dayKey(this.now());
    const rows = [...this.tickets.values()].filter((t) => t.operatorId === operatorId);
    return {
      tickets: rows
        .filter((t) => t.status === 'OPEN')
        .map((t) => ({ id: t.id, day: t.day, subnet: t.subnet, index: t.index, kind: t.kind, params: { ...t.params }, target: t.target, reward: t.reward, progress: t.progress, pending: false, completing: false })),
      ticketsToday: rows.filter((t) => t.day === day).length,
      ticketsDay: day,
      acceptedToday: rows.filter((t) => t.day === day).map((t) => ticketKey(t.day, t.subnet, t.index)),
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
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: 'RAM' });
        this.addResearch(op.id, intent.daemon.species);
        break;
      }
      case 'capture':
        this.daemons.set(intent.daemon.id, { ...intent.daemon, originalOperatorId: intent.log.originalOperatorId, operatorId: op.id, location: intent.location });
        this.addResearch(op.id, intent.daemon.species);
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
      case 'evolve': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM' || d.species !== intent.from) return { ok: false, reason: 'daemon not found' };
        Object.assign(d, {
          species: intent.to, ivs: [...intent.ivs], bonus: [...intent.bonus], clean: intent.clean, signature: intent.signature,
          heldItem: intent.heldItem, moves: [...intent.moves], hp: intent.hp, history: [...d.history, ...intent.history],
        });
        let discovered = false;
        if (!this.discoveries.has(intent.to)) {
          this.discoveries.set(intent.to, { operatorId: op.id, discoveredAt: new Date().toISOString() });
          discovered = true;
        }
        this.applied.add(intent.id);
        return { ok: true, discovered };
      }
      case 'travel':
        Object.assign(op, { subnet: intent.to, x: intent.x, y: intent.y });
        break;
      case 'buy': {
        if (op.bits < intent.price) return { ok: false, reason: 'not enough bits' };
        op.bits -= intent.price;
        if (intent.itemId === 'diskExpansion') op.diskCapacity += 32;
        else op.inventory[intent.itemId] = (op.inventory[intent.itemId] ?? 0) + intent.qty;
        this.ledger.push({ operatorId: op.id, delta: -intent.price, reason: intent.itemId === 'diskExpansion' ? 'disk' : 'shop', ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'craft': {
        if (op.bits < intent.bits) return { ok: false, reason: 'not enough bits' };
        for (const [id, n] of Object.entries(intent.fragments)) if ((op.inventory[id] ?? 0) < n) return { ok: false, reason: `not enough ${id}` };
        op.bits -= intent.bits;
        for (const [id, n] of Object.entries(intent.fragments)) {
          const left = (op.inventory[id] ?? 0) - n;
          if (left <= 0) delete op.inventory[id];
          else op.inventory[id] = left;
        }
        op.inventory[intent.output.item] = (op.inventory[intent.output.item] ?? 0) + intent.output.qty;
        this.ledger.push({ operatorId: op.id, delta: -intent.bits, reason: 'craft', ref: intent.id, at: new Date().toISOString() });
        break;
      }
      case 'decompile': {
        const d = this.daemons.get(intent.daemonId);
        if (!d || d.operatorId !== op.id || d.location !== 'RAM') return { ok: false, reason: 'daemon not found' };
        this.daemons.delete(d.id);
        this.archive.set(d.id, { ...d, history: [...d.history, intent.history], reason: 'decompiled', archivedAt: new Date().toISOString() });
        for (const [id, n] of Object.entries(intent.fragments)) op.inventory[id] = (op.inventory[id] ?? 0) + n;
        break;
      }
      case 'acceptTicket': {
        const dup = [...this.tickets.values()].some((t) => t.operatorId === op.id && t.day === intent.day && t.subnet === intent.subnet && t.index === intent.index);
        if (dup) return { ok: false, reason: 'already accepted' };
        this.tickets.set(intent.ticketId, {
          id: intent.ticketId, operatorId: op.id, day: intent.day, subnet: intent.subnet, index: intent.index, kind: intent.ticketKind, params: { ...intent.params },
          target: intent.target, reward: intent.reward, progress: 0, status: 'OPEN', acceptedAt: this.now(), completedAt: null,
        });
        break;
      }
      case 'abandonTicket': {
        const t = this.tickets.get(intent.ticketId);
        if (!t || t.operatorId !== op.id || t.status !== 'OPEN') return { ok: false, reason: 'no open ticket' };
        t.status = 'ABANDONED';
        break;
      }
      case 'completeTicket': {
        const t = this.tickets.get(intent.ticketId);
        if (!t || t.operatorId !== op.id || t.status !== 'OPEN') return { ok: false, reason: 'no open ticket' };
        t.status = 'DONE';
        t.progress = t.target;
        t.completedAt = this.now();
        op.bits += intent.reward;
        this.ledger.push({ operatorId: op.id, delta: intent.reward, reason: 'ticket', ref: intent.ticketId, at: this.now() });
        break;
      }
    }
    this.applied.add(intent.id);
    return { ok: true };
  }

  async checkpoint(records: readonly OperatorRecord[]): Promise<void> {
    for (const rec of records) {
      const op = this.operators.get(rec.id);
      if (!op) continue;
      // bits move only through intents (the ledger); checkpoints never write them
      Object.assign(op, { subnet: rec.subnet, x: rec.x, y: rec.y, inventory: { ...rec.inventory } });
      for (const t of rec.tickets) {
        const row = this.tickets.get(t.id);
        if (row && row.operatorId === op.id && row.status === 'OPEN') row.progress = t.progress;
      }
      for (const d of rec.ram) {
        const row = this.daemons.get(d.id);
        if (row && row.operatorId === op.id) Object.assign(row, { ...d, location: 'RAM' as const });
      }
    }
  }

  async listDiscoveries(): Promise<string[]> {
    return [...this.discoveries.keys()];
  }

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void> {
    const op = this.operators.get(operatorId);
    if (!op) throw new Error(`unknown operator ${operatorId}`);
    op.bits += delta;
    this.ledger.push({ operatorId, delta, reason, ref: ref ?? null, at: new Date().toISOString() });
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    return this.ledger.filter((l) => l.operatorId === operatorId).slice(-limit);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
```

Replace `apps/sim/src/runtime/prisma-store.ts`:

```ts
import { createPrisma, type Daemon as DaemonRow, type Prisma, type PrismaClient } from '@daemonet/db';
import { dayKey, getSpecies, ticketKey, type FilterTerm, type TicketParams } from '@daemonet/rules';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type ChatRow, type IntentContext, type LedgerRow, type Store } from './store.js';

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
    heldItem: row.heldItem,
    patched: row.patched,
    moveTypeUses: row.moveTypeUses.length === 16 ? row.moveTypeUses : Array.from({ length: 16 }, (_, i) => row.moveTypeUses[i] ?? 0),
    crashes: row.crashes,
    arenaWins: row.arenaWins,
    history: Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : [],
    originalOperatorId: row.originalOperatorId,
  };
}

/** Prisma's Json input type has no room for plain interfaces; history entries are plain data. */
const json = (h: readonly HistoryEntry[]): Prisma.InputJsonValue => h as unknown as Prisma.InputJsonValue;

/** Everything a checkpoint (or store) writes back; identity and capture-log columns never change. */
function stateFields(d: OwnedDaemonRecord) {
  return {
    level: d.level, xp: d.xp, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed,
    ivs: d.ivs, patched: d.patched, heldItem: d.heldItem, moveTypeUses: d.moveTypeUses, crashes: d.crashes, history: json(d.history),
  };
}

function createData(d: OwnedDaemonRecord, operatorId: string) {
  const { originalOperatorId: _o, history, ...rest } = d;
  return { ...rest, history: json(history), operatorId };
}

const jsonParams = (p: TicketParams): Prisma.InputJsonValue => p as unknown as Prisma.InputJsonValue;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export class PrismaStore implements Store {
  constructor(readonly prisma: PrismaClient) {}

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
    const day = dayKey(new Date().toISOString());
    const [tickets, research] = await Promise.all([
      this.prisma.ticket.findMany({ where: { operatorId: op.id, OR: [{ status: 'OPEN' }, { day }] } }),
      this.prisma.research.findMany({ where: { operatorId: op.id } }),
    ]);
    return {
      id: op.id,
      name: op.name,
      starterClaimed: op.starterClaimed,
      subnet: op.subnet,
      x: op.x,
      y: op.y,
      bits: Number(op.bits),
      diskCapacity: op.diskCapacity,
      inventory: (op.inventory ?? {}) as Record<string, number>,
      ram: op.daemons.filter((d) => d.location === 'RAM').map(toRecord),
      diskSlots: op.daemons.filter((d) => d.location === 'DISK').map((d) => d.slot),
      tickets: tickets
        .filter((t) => t.status === 'OPEN')
        .map((t) => ({
          id: t.id, day: t.day, subnet: t.subnet, index: t.index, kind: t.kind as 'clear' | 'capture' | 'deliver' | 'evolve', params: t.params as unknown as TicketParams,
          target: t.target, reward: t.reward, progress: t.progress, pending: false, completing: false,
        })),
      ticketsToday: tickets.filter((t) => t.day === day).length,
      ticketsDay: day,
      acceptedToday: tickets.filter((t) => t.day === day).map((t) => ticketKey(t.day, t.subnet, t.index)),
      research: Object.fromEntries(research.map((r) => [String(r.line), r.points])),
      mutedUntil: op.mutedUntil ? op.mutedUntil.toISOString() : null,
    };
  }

  async appendChat(row: ChatRow): Promise<void> {
    await this.prisma.chatMessage.create({ data: { id: row.id, channel: row.channel, operatorId: row.operatorId, toId: row.toId, text: row.text, at: new Date(row.at) } });
  }
  async recordFilterHit(hit: { operatorId: string; channel: string; text: string; term: string }): Promise<void> {
    await this.prisma.chatFilterHit.create({ data: hit });
  }
  async setMute(operatorId: string, until: string | null): Promise<void> {
    await this.prisma.operator.update({ where: { id: operatorId }, data: { mutedUntil: until ? new Date(until) : null } });
  }
  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    return (await this.prisma.chatBlock.count({ where: { blockerId: blocker, blockedId: blocked } })) > 0;
  }
  async listFilterTerms(): Promise<FilterTerm[]> {
    const rows = await this.prisma.chatFilterTerm.findMany();
    return rows.map((r) => ({ pattern: r.pattern, kind: r.kind, action: r.action }));
  }

  private static async research(tx: Prisma.TransactionClient, operatorId: string, species: string): Promise<void> {
    const line = getSpecies(species).line;
    await tx.research.upsert({ where: { operatorId_line: { operatorId, line } }, create: { operatorId, line, points: 1 }, update: { points: { increment: 1 } } });
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
            await tx.daemon.create({
              data: {
                ...createData(intent.daemon, intent.operatorId),
                location: 'RAM',
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            await PrismaStore.research(tx, intent.operatorId, intent.daemon.species);
            return { ok: true } as const;
          }
          case 'capture': {
            await tx.daemon.create({
              data: {
                ...createData(intent.daemon, intent.operatorId),
                location: intent.location,
                originalOperatorId: intent.log.originalOperatorId,
                capturedAt: now,
                captureSubnet: intent.log.subnet,
                captureTool: intent.log.tool,
                spawnSeedId: ctx.seedId,
                spawnIndex: intent.log.spawnIndex,
              },
            });
            await PrismaStore.research(tx, intent.operatorId, intent.daemon.species);
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
          case 'evolve': {
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM' || row.species !== intent.from) throw new DomainFailure('daemon not found');
            const history = [...(Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : []), ...intent.history];
            await tx.daemon.update({
              where: { id: intent.daemonId },
              data: {
                species: intent.to, ivs: intent.ivs, bonus: intent.bonus, clean: intent.clean, signature: intent.signature,
                heldItem: intent.heldItem, moves: intent.moves, hp: intent.hp, history: json(history),
              },
            });
            const first = await tx.discovery.createMany({ data: [{ formId: intent.to, operatorId: intent.operatorId }], skipDuplicates: true });
            return { ok: true, discovered: first.count === 1 } as const;
          }
          case 'travel': {
            await tx.operator.update({ where: { id: intent.operatorId }, data: { subnet: intent.to, x: intent.x, y: intent.y } });
            return { ok: true } as const;
          }
          case 'buy': {
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            if (op.bits < BigInt(intent.price)) throw new DomainFailure('not enough bits');
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            const disk = intent.itemId === 'diskExpansion';
            if (!disk) inventory[intent.itemId] = (inventory[intent.itemId] ?? 0) + intent.qty;
            await tx.operator.update({
              where: { id: intent.operatorId },
              data: { bits: { decrement: BigInt(intent.price) }, inventory, ...(disk ? { diskCapacity: { increment: 32 } } : {}) },
            });
            await tx.bitsLedger.create({ data: { operatorId: intent.operatorId, delta: BigInt(-intent.price), reason: disk ? 'disk' : 'shop', ref: intent.id } });
            return { ok: true } as const;
          }
          case 'craft': {
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            if (op.bits < BigInt(intent.bits)) throw new DomainFailure('not enough bits');
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            for (const [id, n] of Object.entries(intent.fragments)) {
              if ((inventory[id] ?? 0) < n) throw new DomainFailure(`not enough ${id}`);
              const left = (inventory[id] ?? 0) - n;
              if (left <= 0) delete inventory[id];
              else inventory[id] = left;
            }
            inventory[intent.output.item] = (inventory[intent.output.item] ?? 0) + intent.output.qty;
            await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { decrement: BigInt(intent.bits) }, inventory } });
            await tx.bitsLedger.create({ data: { operatorId: intent.operatorId, delta: BigInt(-intent.bits), reason: 'craft', ref: intent.id } });
            return { ok: true } as const;
          }
          case 'decompile': {
            const row = await tx.daemon.findUnique({ where: { id: intent.daemonId } });
            if (!row || row.operatorId !== intent.operatorId || row.location !== 'RAM') throw new DomainFailure('daemon not found');
            const { location: _l, slot: _s, hp: _h, energy: _e, crashed: _c, ...rest } = row;
            const history = [...(Array.isArray(row.history) ? (row.history as unknown as HistoryEntry[]) : []), intent.history];
            await tx.daemonArchive.create({ data: { ...rest, history: json(history), reason: 'decompiled' } });
            await tx.daemon.delete({ where: { id: intent.daemonId } });
            const op = await tx.operator.findUniqueOrThrow({ where: { id: intent.operatorId } });
            const inventory = { ...((op.inventory ?? {}) as Record<string, number>) };
            for (const [id, n] of Object.entries(intent.fragments)) inventory[id] = (inventory[id] ?? 0) + n;
            await tx.operator.update({ where: { id: intent.operatorId }, data: { inventory } });
            return { ok: true } as const;
          }
          case 'acceptTicket': {
            try {
              await tx.ticket.create({
                data: {
                  id: intent.ticketId, operatorId: intent.operatorId, day: intent.day, subnet: intent.subnet, index: intent.index, kind: intent.ticketKind,
                  params: jsonParams(intent.params), target: intent.target, reward: intent.reward,
                },
              });
            } catch (err) {
              if (isUniqueViolation(err)) throw new DomainFailure('already accepted');
              throw err;
            }
            return { ok: true } as const;
          }
          case 'abandonTicket': {
            const res = await tx.ticket.updateMany({ where: { id: intent.ticketId, operatorId: intent.operatorId, status: 'OPEN' }, data: { status: 'ABANDONED' } });
            if (res.count !== 1) throw new DomainFailure('no open ticket');
            return { ok: true } as const;
          }
          case 'completeTicket': {
            const res = await tx.ticket.updateMany({
              where: { id: intent.ticketId, operatorId: intent.operatorId, status: 'OPEN' },
              data: { status: 'DONE', completedAt: now, progress: { set: undefined } },
            });
            if (res.count !== 1) throw new DomainFailure('no open ticket');
            await tx.ticket.update({ where: { id: intent.ticketId }, data: { progress: (await tx.ticket.findUniqueOrThrow({ where: { id: intent.ticketId } })).target } });
            await tx.operator.update({ where: { id: intent.operatorId }, data: { bits: { increment: BigInt(intent.reward) } } });
            await tx.bitsLedger.create({ data: { operatorId: intent.operatorId, delta: BigInt(intent.reward), reason: 'ticket', ref: intent.ticketId } });
            return { ok: true } as const;
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
          // bits move only through intents (the ledger); checkpoints never write them
          data: { subnet: rec.subnet, x: rec.x, y: rec.y, inventory: rec.inventory, lastSeenAt: now },
        });
        for (const d of rec.ram) {
          await tx.daemon.updateMany({ where: { id: d.id, operatorId: rec.id }, data: stateFields(d) });
        }
        for (const t of rec.tickets) {
          await tx.ticket.updateMany({ where: { id: t.id, operatorId: rec.id, status: 'OPEN' }, data: { progress: t.progress } });
        }
      }
    });
  }

  async listDiscoveries(): Promise<string[]> {
    const rows = await this.prisma.discovery.findMany({ select: { formId: true } });
    return rows.map((r) => r.formId);
  }

  async grantBits(operatorId: string, delta: number, reason: string, ref?: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.operator.update({ where: { id: operatorId }, data: { bits: { increment: BigInt(delta) } } }),
      this.prisma.bitsLedger.create({ data: { operatorId, delta: BigInt(delta), reason, ref: ref ?? null } }),
    ]);
  }

  async ledgerFor(operatorId: string, limit = 64): Promise<LedgerRow[]> {
    const rows = await this.prisma.bitsLedger.findMany({ where: { operatorId }, orderBy: { at: 'desc' }, take: limit });
    return rows.reverse().map((r) => ({ operatorId: r.operatorId, delta: Number(r.delta), reason: r.reason, ref: r.ref, at: r.at.toISOString() }));
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

`apps/sim/src/core/model.ts`: `OperatorRecord` gains `/** Chat mute (ISO) or null. */ mutedUntil: string | null;`, `Operator` gains `mutedUntil: string | null;` (loaded with the record; the chat service owns the live value); `world.ts` copies it in `addOperator` and returns it from `checkpoint()`.

`apps/sim/src/core/systems/commands.ts` (`claimStarter`, after the starter check; import `DEFAULT_FILTER`, `nameAllowedBy` from `@daemonet/rules`):

```ts
  if (!nameAllowedBy(DEFAULT_FILTER, c.args.operatorName)) throw new Rejection('E_INVALID', 'that name is not allowed');
```

- [ ] **Step 6: Game, config, main**

Replace `apps/sim/src/runtime/game.ts`:

```ts
import { COMMANDS_PER_TICK, RESUME_TICKS, parseClientMessage, type ClientMessage, type Entity, type ErrorCode, type ServerMessage } from '@daemonet/shared';
import { INTEREST_RADIUS, distance, entitiesNear, toSelf, type Input, type Intent, type IntentResult, type World } from '../core/index.js';
import type { Bus } from '@daemonet/bus';
import type { TokenVerifier } from './auth.js';
import { ChatService } from './chat.js';
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
  /** One world per hosted subnet; the first is the default (new operators, unknown subnets). */
  worlds?: readonly World[];
  /** Shorthand for a single world. */
  world?: World;
  store: Store;
  verify: TokenVerifier;
  /** Sim ⇄ api bus (MemoryBus when Redis is not configured). */
  bus: Bus;
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
  /** The world the operator is in right now (changes on travel). */
  world: World;
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
  /** Hosted worlds by subnet id; all tick in lockstep. */
  readonly worlds: Map<string, World>;
  readonly defaultWorld: World;
  /** The single world (tests, and callers that host one subnet). */
  readonly world: World;
  private readonly store: Store;
  private readonly verify: TokenVerifier;
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
  /** Game ticks so far (every world advances once per game tick). */
  private ticks = 0;
  readonly chat: ChatService;

  constructor(opts: GameOptions) {
    const worlds = opts.worlds ?? (opts.world ? [opts.world] : []);
    if (worlds.length === 0) throw new Error('Game needs at least one world');
    this.worlds = new Map(worlds.map((w) => [w.subnet.id, w]));
    this.defaultWorld = worlds[0]!;
    this.world = this.defaultWorld;
    this.store = opts.store;
    this.verify = opts.verify;
    this.log = opts.log ?? silent;
    this.retryDelays = opts.retryDelaysMs ?? [128, 512, 2048];
    this.checkpointEvery = opts.checkpointEveryTicks ?? 512;
    this.leaveAfter = opts.leaveAfterTicks ?? 128;
    this.authTimeout = opts.authTimeoutTicks ?? 80;
    this.idleTimeout = opts.idleTimeoutTicks ?? 768;
    this.maxSpectators = opts.maxSpectators ?? 4;
    this.chat = new ChatService(
      {
        operator: (id) => {
          const s = this.sessions.get(id);
          const op = s?.world.operators.get(id);
          return s && op ? { op, subnet: s.world.subnet.id } : undefined;
        },
        operatorIds: () => this.sessions.keys(),
        send: (operatorId, msg) => {
          const s = this.sessions.get(operatorId);
          if (!s) return;
          for (const st of s.controller ? [s.controller, ...s.spectators] : [...s.spectators]) this.send(st, msg);
        },
        now: () => Date.now(),
      },
      this.store,
      opts.bus,
      this.log,
    );
  }

  /** Loads admin filter terms; call once after construction (main.ts). */
  async loadChatTerms(): Promise<void> {
    this.chat.setExtraTerms(await this.store.listFilterTerms());
  }

  /** The world an operator is in, if connected. */
  worldOf(operatorId: string): World | undefined {
    return this.sessions.get(operatorId)?.world;
  }

  // ---- connections ----

  connect(conn: Conn): void {
    const t = this.ticks;
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
    st.lastSeenTick = this.ticks;
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
      const home = this.defaultWorld.subnet;
      const rec = await this.store.loadOrCreateOperator(claims.sub, home.id, home.spawn);
      if (st.phase === 'closed') return;
      let session = this.sessions.get(rec.id);
      if (!session) {
        // An operator whose subnet this process does not host starts over at the default host.
        let world = this.worlds.get(rec.subnet);
        if (!world) {
          world = this.defaultWorld;
          rec.subnet = home.id;
          rec.x = home.spawn.x;
          rec.y = home.spawn.y;
        }
        if (!world.operators.has(rec.id)) world.addOperator(rec);
        session = {
          operatorId: rec.id, sub: claims.sub, world, controller: null, spectators: new Set(), resumeToken: randomHex(16), buffer: [], baseTick: world.tick,
          savedKnown: null, savedSelf: null, commandsThisTick: 0, violations: [], leaveAtTick: null,
        };
        this.sessions.set(rec.id, session);
        this.chat.loadMute(rec.id, rec.mutedUntil);
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
      this.send(st, { t: 'authOk', seq: 0, d: { operatorId: rec.id, role: st.role, resumeToken: session.resumeToken, tick: session.world.tick } });
      if (!(st.role === 'controller' && this.tryResume(st, session, d.resumeToken, d.lastTick))) this.snapshot(st);
      this.log.info({ sub: claims.sub, role: st.role, ip: st.conn.ip, subnet: session.world.subnet.id }, 'operator connected');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'auth: store unavailable');
      this.error(st, 'E_STATE', 'service unavailable');
      this.kick(st, 'unavailable', CLOSE.unavailable);
    }
  }

  private tryResume(st: ConnState, session: Session, token: string | undefined, lastTick: number | undefined): boolean {
    if (token !== session.resumeToken || lastTick === undefined || !session.savedKnown) return false;
    if (lastTick < session.baseTick || lastTick > session.world.tick) return false;
    st.known = new Map(session.savedKnown);
    st.lastSelf = session.savedSelf;
    for (const entry of session.buffer) if (entry.tick > lastTick) this.send(st, entry.msg);
    return true;
  }

  private snapshot(st: ConnState): void {
    const session = this.sessions.get(st.operatorId!)!;
    const world = session.world;
    const op = world.operators.get(st.operatorId!)!;
    if (st.role === 'controller') {
      session.buffer = [];
      session.baseTick = world.tick;
    }
    const entities = entitiesNear(world, op.x, op.y, this.radius, op);
    const self = toSelf(world, op);
    st.known = new Map(entities.map((e) => [e.id, e]));
    st.lastSelf = JSON.stringify(self);
    this.send(st, { t: 'snapshot', seq: 0, d: { tick: world.tick, subnet: world.subnet.id, self, entities } });
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
    if (command.cmd === 'chat') {
      // chat is not gameplay: handled outside the tick, no per-tick budget, its own 2-second limit
      this.track(
        this.chat.post(session.operatorId, command.args.channel, command.args.text).then((err) => {
          if (err) this.error(st, err.code, err.message, reqId);
          else this.send(st, { t: 'ack', seq: 0, d: { reqId } });
        }),
      );
      return;
    }
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
    const now = this.ticks;
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
      session.leaveAtTick = this.ticks + this.leaveAfter;
    }
  }

  // ---- the tick ----

  tick(): void {
    const t0 = performance.now();
    this.ticks++;
    for (const st of [...this.conns.values()]) {
      st.bucket = Math.min(BUCKET_MAX, st.bucket + BUCKET_REFILL_PER_TICK);
      if (st.phase !== 'ready' && this.ticks - st.openedTick > this.authTimeout) this.kick(st, 'auth timeout', CLOSE.timeout);
      else if (st.phase === 'ready' && this.ticks - st.lastSeenTick > this.idleTimeout) this.kick(st, 'idle', CLOSE.timeout);
    }

    const inputsByWorld = new Map<World, Input[]>();
    for (const input of this.inputs) {
      const world = this.sessions.get(input.operatorId)?.world;
      if (!world) continue;
      let list = inputsByWorld.get(world);
      if (!list) inputsByWorld.set(world, (list = []));
      list.push(input);
    }
    this.inputs = [];
    for (const s of this.sessions.values()) s.commandsThisTick = 0;

    for (const world of this.worlds.values()) this.stepWorld(world, inputsByWorld.get(world) ?? []);

    if (this.ticks % this.checkpointEvery === 0) this.checkpointAll();
    for (const session of [...this.sessions.values()]) {
      if (!session.controller && session.leaveAtTick !== null && session.leaveAtTick <= this.ticks) this.leave(session);
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

  private stepWorld(world: World, inputs: Input[]): void {
    const result = world.step(inputs);

    for (const r of result.replies) {
      const st = this.sessions.get(r.operatorId)?.controller;
      if (!st) continue;
      if (r.ok) this.send(st, { t: 'ack', seq: 0, d: r.result === undefined ? { reqId: r.reqId } : { reqId: r.reqId, result: r.result } });
      else this.error(st, r.code, r.message, r.reqId);
    }
    for (const intent of result.intents) this.persist(world, intent);

    for (const session of this.sessions.values()) {
      if (session.world !== world) continue;
      const op = world.operators.get(session.operatorId);
      if (!op) continue;
      const events = result.events
        .filter((e) => (e.to === null ? e.at === null || distance(e.at, op) <= this.radius : e.to === op.id))
        .map((e) => e.event);
      const near = entitiesNear(world, op.x, op.y, this.radius, op);
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
  }

  private leave(session: Session): void {
    const world = session.world;
    const record = world.checkpoint(session.operatorId);
    world.removeOperator(session.operatorId);
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
    const records = [...this.sessions.values()].filter((s) => s.world.operators.has(s.operatorId)).map((s) => s.world.checkpoint(s.operatorId));
    this.track(this.store.checkpoint(records).catch((err: Error) => this.log.error({ err: err.message }, 'checkpoint failed')));
  }

  /** A committed travel intent: hand the operator from its world to the destination and start it with a fresh snapshot. */
  private moveOperator(from: World, intent: Extract<Intent, { kind: 'travel' }>): void {
    const session = this.sessions.get(intent.operatorId);
    const to = this.worlds.get(intent.to);
    if (!session || session.world !== from || !to || !from.operators.has(intent.operatorId)) return;
    const record = from.checkpoint(intent.operatorId);
    from.removeOperator(intent.operatorId);
    to.addOperator({ ...record, subnet: to.subnet.id, x: intent.x, y: intent.y });
    session.world = to;
    to.emitCarry({ e: 'travelled', from: intent.from, to: intent.to }, { to: intent.operatorId });
    for (const st of session.controller ? [session.controller, ...session.spectators] : [...session.spectators]) this.snapshot(st);
    this.log.info({ sub: session.sub, from: intent.from, to: intent.to }, 'operator travelled');
  }

  private persist(world: World, intent: Intent): void {
    const stored = intent.kind === 'store' ? world.daemons.get(intent.daemonId) : undefined;
    const ctx = { seedId: world.seedId, ...(stored ? { storedDaemon: world.toRecord(stored) } : {}) };
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
      world.completeIntent(intent.id, result);
      if (intent.kind === 'evolve' && result.ok && result.discovered) for (const w of this.worlds.values()) w.discovered.add(intent.to);
      if (intent.kind === 'travel' && result.ok) this.moveOperator(world, intent);
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
    this.chat.close();
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

`apps/sim/package.json` gains the dependency `"@daemonet/bus": "workspace:*"`; `apps/sim/tsconfig.json` gains the reference `{ "path": "../../packages/bus" }`.

`apps/sim/src/runtime/config.ts`: add

```ts
  /** redis://daemonet:<pw>@host:6379/4 — unset: in-process bus (single sim process, no api moderation push). */
  REDIS_URL: z.string().min(1).optional(),
```

and `redisUrl: e.REDIS_URL` on `Config`. `apps/sim/src/runtime/main.ts`:

```ts
const bus = createBus(config.redisUrl);
if (!config.redisUrl) log.warn({}, 'REDIS_URL not set: using the in-process bus (admin chat actions from the api will not reach the sim)');
const game = new Game({ worlds, store, verify, bus, log });
await game.loadChatTerms();
```

and `await bus.close();` in `shutdown` before the store closes.

`scripts/provision-secrets.sh`: read the Redis ACL password from S2 (`REDIS_PW=$(ssh -o BatchMode=yes S2 'cat /root/.daemonet-redis-pw')`, fail if empty, export it) and add to the secret document

```python
  # Shared Redis on S2: ACL user daemonet (keys/channels daemonet:*), logical DB 4. Sim and api both use it.
  "REDIS_URL": f"redis://daemonet:{os.environ['REDIS_PW']}@192.168.40.20:6379/4",
```

OPERATIONS.md: in section A step 3, replace the line "Redis is **not** published: the SP1 sim does not use it. …" with

```markdown
**Redis (needed from SP4):** on S2, create the ACL user and publish the port on the LAN address only:

    openssl rand -hex 24 > /root/.daemonet-redis-pw && chmod 600 /root/.daemonet-redis-pw
    docker exec shared-redis redis-cli ACL SETUSER daemonet on ">$(cat /root/.daemonet-redis-pw)" '~daemonet:*' '&daemonet:*' +@all -@dangerous
    docker exec shared-redis redis-cli ACL SAVE        # requires aclfile in the shared-infra redis.conf

Publish `192.168.40.20:6379:6379` in the shared-infra compose file (never `0.0.0.0`) and allow only S1 in `DOCKER-USER`, exactly as for PostgreSQL above. Then rerun `scripts/provision-secrets.sh` (it reads the password over SSH and writes `REDIS_URL`), `fetch-secrets.sh`, and restart sim and api.
```

and in "Local development" add `docker run -d --name daemonet-redis -p 127.0.0.1:6379:6379 redis:7-alpine` plus `REDIS_URL=redis://127.0.0.1:6379/4` in the exported environment (the container name `shared-redis` above is whatever the shared-infra compose calls its Redis service).

- [ ] **Step 7: Verify and commit**

`pnpm install && pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green.

```bash
git add packages/db packages/shared packages/sdk apps/sim scripts/provision-secrets.sh OPERATIONS.md pnpm-lock.yaml
git commit -m "feat(sim): chat over the game socket with filter, mute and bus-driven moderation"
```

---

### Task 4: API — history, blocks, reports, moderation

**Files:**
- Create: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/test/app.test.ts`

**Interfaces:**
- `GET /api/chat/:channel?before=&limit=` (subnet: public; dm: the two sides; cluster / org: 403 for now), `POST|DELETE /api/chat/block { operatorId }`, `POST /api/reports { targetId, messageId?, reason, note }` (≤ 8 / day, duplicate `(reporter, message)` → `{ duplicate: true }`).
- Admin: `POST /api/admin/chat/mute { operatorId, minutes }` (0 = unmute), `DELETE /api/admin/chat/:id`, `GET|POST /api/admin/chat/filter`, `DELETE /api/admin/chat/filter/:id`, `GET /api/admin/chat/hits`, `GET /api/admin/reports?status=`, `POST /api/admin/reports/:id/resolve { action: DISMISS | DELETE | MUTE, minutes? }`. Each publishes on the bus `admin` channel (`mute`, `delete`, `filter`).
- `nameAllowed(prisma, name)`, `pruneChat(prisma, now?)` (server runs it at boot and every 6 h).
- `BuildAppOptions.bus: Bus`; `REDIS_URL` → `config.redisUrl`.

- [ ] **Step 1: Failing test**

In `apps/api/test/app.test.ts`: import `MemoryBus` and `{ nameAllowed, pruneChat }`, create `const bus = new MemoryBus();` in the describe, pass `bus` to `buildApp`, clear `bus.log.length = 0` in `beforeEach`, and add before the dev-seeding case:

```ts
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
    expect(await nameAllowed(prisma!, 'banana-man')).toBe(false);
    expect(await nameAllowed(prisma!, 'alice')).toBe(true);
    expect(await pruneChat(prisma!, new Date('2026-09-30T12:00:00Z'))).toBe(1);
  });
```

- [ ] **Step 2: Routes**

Create `apps/api/src/routes/chat.ts`:

```ts
import type { Bus } from '@daemonet/bus';
import type { PrismaClient } from '@daemonet/db';
import { CHAT_HISTORY_DAYS, DEFAULT_TERMS, REPORTS_PER_DAY, compileFilter, nameAllowedBy, type FilterTerm } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors.js';

const Channel = z.string().regex(/^(subnet|cluster|org|dm):[A-Za-z0-9_-]{1,64}$/);
const HistoryQuery = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(64).default(64) });
const MuteBody = z.object({ operatorId: z.string().min(1), minutes: z.number().int().min(0).max(60 * 24 * 30) });
const TermBody = z.object({ pattern: z.string().min(1).max(64), kind: z.enum(['WORD', 'REGEX']), action: z.enum(['BLOCK', 'MASK']) });
const ReportBody = z.object({
  targetId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  reason: z.enum(['SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER']),
  note: z.string().max(256).default(''),
});
const ResolveBody = z.object({ action: z.enum(['DISMISS', 'DELETE', 'MUTE']), minutes: z.number().int().min(1).max(60 * 24 * 30).optional() });
const BlockBody = z.object({ operatorId: z.string().min(1) });

/** zod failures are the caller's fault: 400, not 500. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** Chat history, blocks, reports and the admin side (mute, delete, filter terms, report queue) — SP4 spec §5. */
export function registerChatRoutes(app: FastifyInstance, prisma: PrismaClient, bus: Bus): void {
  const auth = { preHandler: app.requireAuth };
  const admin = { preHandler: [app.requireAuth, app.requireAdmin] };

  /** Subnet history is public; a DM thread is readable by either side (rows are filtered to the pair); cluster history is live-only; org history comes with SP4 plan 3. */
  async function mayRead(_operatorId: string, channel: string): Promise<boolean> {
    const kind = channel.split(':', 1)[0];
    return kind === 'subnet' || kind === 'dm';
  }

  app.get<{ Params: { channel: string }; Querystring: unknown }>('/api/chat/:channel', auth, async (req) => {
    const channel = parse(Channel, req.params.channel);
    const q = parse(HistoryQuery, req.query);
    if (!(await mayRead(req.operator!.id, channel))) throw forbidden('not a member of that channel');
    const me = req.operator!.id;
    const where = channel.startsWith('dm:')
      ? { deletedAt: null, ...(q.before ? { at: { lt: new Date(q.before) } } : {}), OR: [{ channel, operatorId: me }, { channel: `dm:${me}`, operatorId: channel.slice(3) }] }
      : { channel, deletedAt: null, ...(q.before ? { at: { lt: new Date(q.before) } } : {}) };
    const rows = await prisma.chatMessage.findMany({ where, orderBy: { at: 'desc' }, take: q.limit });
    const names = new Map((await prisma.operator.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.operatorId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return rows.reverse().map((r) => ({ id: r.id, channel: r.channel, from: r.operatorId, name: names.get(r.operatorId) ?? null, text: r.text, at: r.at }));
  });

  app.post('/api/chat/block', auth, async (req) => {
    const { operatorId } = parse(BlockBody, req.body);
    if (operatorId === req.operator!.id) throw badRequest('cannot block yourself');
    await prisma.chatBlock.upsert({ where: { blockerId_blockedId: { blockerId: req.operator!.id, blockedId: operatorId } }, create: { blockerId: req.operator!.id, blockedId: operatorId }, update: {} });
    return { ok: true };
  });
  app.delete('/api/chat/block', auth, async (req) => {
    const { operatorId } = parse(BlockBody, req.body);
    await prisma.chatBlock.deleteMany({ where: { blockerId: req.operator!.id, blockedId: operatorId } });
    return { ok: true };
  });

  // ---- reports (players)
  app.post('/api/reports', auth, async (req, reply) => {
    const body = parse(ReportBody, req.body);
    const me = req.operator!.id;
    if (body.targetId === me) throw badRequest('cannot report yourself');
    const since = new Date(Date.now() - 86_400_000);
    if ((await prisma.report.count({ where: { reporterId: me, at: { gte: since } } })) >= REPORTS_PER_DAY) throw badRequest(`at most ${REPORTS_PER_DAY} reports per day`);
    if (body.messageId) {
      const msg = await prisma.chatMessage.findUnique({ where: { id: body.messageId } });
      if (!msg || msg.operatorId !== body.targetId) throw badRequest('message does not belong to that operator');
      const dup = await prisma.report.findUnique({ where: { reporterId_messageId: { reporterId: me, messageId: body.messageId } } });
      if (dup) return reply.code(200).send({ ok: true, id: dup.id, duplicate: true });
    }
    const row = await prisma.report.create({ data: { reporterId: me, targetId: body.targetId, messageId: body.messageId ?? null, reason: body.reason, note: body.note } });
    return { ok: true, id: row.id };
  });

  // ---- admin
  app.post('/api/admin/chat/mute', admin, async (req) => {
    const { operatorId, minutes } = parse(MuteBody, req.body);
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
    await prisma.operator.update({ where: { id: operatorId }, data: { mutedUntil: until } });
    await bus.publish('admin', { kind: 'mute', operatorId, until: until ? until.toISOString() : null, reason: 'admin' });
    return { ok: true, until };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/chat/:id', admin, async (req) => {
    const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
    if (!msg) throw notFound('no such message');
    await prisma.chatMessage.update({ where: { id: msg.id }, data: { deletedAt: new Date() } });
    await bus.publish('admin', { kind: 'delete', id: msg.id, channel: msg.channel });
    return { ok: true };
  });

  app.get('/api/admin/chat/filter', admin, async () => prisma.chatFilterTerm.findMany({ orderBy: { at: 'asc' } }));
  app.post('/api/admin/chat/filter', admin, async (req) => {
    const body = parse(TermBody, req.body);
    if (body.kind === 'REGEX') {
      try {
        new RegExp(body.pattern);
      } catch {
        throw badRequest('invalid regular expression');
      }
    }
    const row = await prisma.chatFilterTerm.create({ data: { ...body, addedBy: req.operator!.id } });
    await publishTerms();
    return row;
  });
  app.delete<{ Params: { id: string } }>('/api/admin/chat/filter/:id', admin, async (req) => {
    await prisma.chatFilterTerm.deleteMany({ where: { id: req.params.id } });
    await publishTerms();
    return { ok: true };
  });
  async function publishTerms() {
    const terms: FilterTerm[] = (await prisma.chatFilterTerm.findMany()).map((r) => ({ pattern: r.pattern, kind: r.kind, action: r.action }));
    await bus.publish('admin', { kind: 'filter', terms });
  }

  app.get('/api/admin/chat/hits', admin, async () => prisma.chatFilterHit.findMany({ orderBy: { at: 'desc' }, take: 128 }));

  app.get<{ Querystring: { status?: string } }>('/api/admin/reports', admin, async (req) => {
    const status = (['OPEN', 'ACTIONED', 'DISMISSED'] as const).find((s) => s === req.query.status) ?? 'OPEN';
    const rows = await prisma.report.findMany({ where: { status }, orderBy: { at: 'asc' }, take: 128 });
    const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetId]))];
    const names = new Map((await prisma.operator.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const messages = new Map((await prisma.chatMessage.findMany({ where: { id: { in: rows.flatMap((r) => (r.messageId ? [r.messageId] : [])) } } })).map((m) => [m.id, m]));
    return rows.map((r) => ({
      ...r,
      reporterName: names.get(r.reporterId) ?? null,
      targetName: names.get(r.targetId) ?? null,
      message: r.messageId ? (messages.get(r.messageId) ?? null) : null,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/admin/reports/:id/resolve', admin, async (req) => {
    const body = parse(ResolveBody, req.body);
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw notFound('no such report');
    if (report.status !== 'OPEN') throw badRequest('already resolved');
    if (body.action === 'DELETE') {
      if (!report.messageId) throw badRequest('this report has no message to delete');
      const msg = await prisma.chatMessage.update({ where: { id: report.messageId }, data: { deletedAt: new Date() } });
      await bus.publish('admin', { kind: 'delete', id: msg.id, channel: msg.channel });
    }
    if (body.action === 'MUTE') {
      const until = new Date(Date.now() + (body.minutes ?? 60) * 60_000);
      await prisma.operator.update({ where: { id: report.targetId }, data: { mutedUntil: until } });
      await bus.publish('admin', { kind: 'mute', operatorId: report.targetId, until: until.toISOString(), reason: 'report' });
    }
    await prisma.report.update({
      where: { id: report.id },
      data: { status: body.action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED', resolvedBy: req.operator!.id, resolvedAt: new Date(), action: body.action },
    });
    return { ok: true };
  });
}

/** Names and org tags go through the same filter as chat (SP4 spec §5.1). */
export async function nameAllowed(prisma: PrismaClient, name: string): Promise<boolean> {
  const extra: FilterTerm[] = (await prisma.chatFilterTerm.findMany()).map((r) => ({ pattern: r.pattern, kind: r.kind, action: r.action }));
  return nameAllowedBy(compileFilter([...DEFAULT_TERMS, ...extra]), name);
}

/** Deletes chat older than CHAT_HISTORY_DAYS; the server runs it at boot and every 6 hours. */
export async function pruneChat(prisma: PrismaClient, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CHAT_HISTORY_DAYS * 86_400_000);
  const r = await prisma.chatMessage.deleteMany({ where: { at: { lt: cutoff } } });
  return r.count;
}
```

`apps/api/src/app.ts`: `BuildAppOptions` gains `bus: Bus` (import the type from `@daemonet/bus`) and the app registers `registerChatRoutes(app, o.prisma, o.bus);` after the economy routes. `apps/api/package.json` gains `"@daemonet/bus": "workspace:*"`, `apps/api/tsconfig.json` the reference to `../../packages/bus`. `apps/api/src/config.ts` gains optional `REDIS_URL` → `redisUrl`.

Replace `apps/api/src/server.ts`:

```ts
import { createBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { buildApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig } from './config.js';
import { pruneChat } from './routes/chat.js';

const config = loadConfig();
const prisma = createPrisma(config.databaseUrl);
await prisma.$queryRaw`SELECT 1`;

const bus = createBus(config.redisUrl);
const app = await buildApp({
  prisma,
  bus,
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
app.log.info({ port: config.port, devBypass: config.devBypass, redis: Boolean(config.redisUrl) }, 'daemonet api started');
if (!config.redisUrl) app.log.warn('REDIS_URL not set: admin chat actions will not reach the sim');
const prune = () => pruneChat(prisma).then((n) => n > 0 && app.log.info({ deleted: n }, 'pruned chat history')).catch((err: Error) => app.log.error({ err: err.message }, 'chat prune failed'));
void prune();
const pruneTimer = setInterval(prune, 6 * 3_600_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  await app.close();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 3: Verify and commit**

`pnpm install && pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green.

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): chat history, blocks, reports and admin moderation over the bus"
```

---

### Task 5: Client — chat panel, reports, admin panel, e2e

**Files:**
- Create: `apps/frontend/src/game/chat.ts`, `apps/frontend/src/panels/ChatPanel.tsx`, `apps/frontend/src/panels/AdminPanel.tsx`, `apps/frontend/test/chat.test.tsx`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `createChatStore()` / `chatStore` / `useChat()` → `{ lines: Map<channel, ChatLine[]>, unread, active, mutedUntil, version }` (a **stable** snapshot between changes — `useSyncExternalStore` loops otherwise); `push`, `history`, `remove`, `setActive`, `setMuted`; `setMe(id)` so DM threads file under the other side.
- `ChatPanel({ client, isAdmin })` (test ids `channel-<id>`, `chat-lines`, `chat-input`, `chat-send`, `report-<messageId>`, `report-send`), `ReportButton({ targetId, messageId? })`, `AdminPanel()` (`admin-reports`, `admin-filter`, `admin-economy`).
- `api.ts`: `useLazyChatHistoryQuery`, `useReportMutation`, `useAdminReportsQuery`, `useResolveReportMutation`, `useFilterTermsQuery`, `useAddFilterTermMutation`, `useDeleteFilterTermMutation`, `useAdminEconomyQuery`.

- [ ] **Step 1: Failing unit test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createChatStore, setMe, type ChatLine } from '../src/game/chat.ts';

const line = (over: Partial<ChatLine>): ChatLine => ({ id: 'm1', channel: 'subnet:lo', from: 'a', name: 'alice', tag: null, text: 'hi', at: '2026-09-30T00:00:00.000Z', ...over });

describe('chat store', () => {
  it('keeps lines per channel in time order without duplicates, counts unread off the active channel, and files DMs under the other side', () => {
    setMe('me');
    const s = createChatStore();
    s.setActive('subnet:lo');
    s.push(line({ id: 'm2', at: '2026-09-30T00:00:02.000Z', text: 'second' }));
    s.push(line({ id: 'm1', at: '2026-09-30T00:00:01.000Z', text: 'first' }));
    s.history('subnet:lo', [line({ id: 'm0', at: '2026-09-30T00:00:00.000Z', text: 'zero' }), line({ id: 'm1', at: '2026-09-30T00:00:01.000Z', text: 'first' })]);
    expect(s.get().lines.get('subnet:lo')!.map((l) => l.text)).toEqual(['zero', 'first', 'second']);
    expect(s.get().unread.get('subnet:lo')).toBeUndefined();
    s.push(line({ id: 'd1', channel: 'dm:me', from: 'bob', text: 'psst' }));
    expect(s.get().lines.get('dm:bob')!.map((l) => l.text)).toEqual(['psst']);
    expect(s.get().unread.get('dm:bob')).toBe(1);
    s.push(line({ id: 'd2', channel: 'dm:bob', from: 'me', text: 'yes?' }));
    expect(s.get().lines.get('dm:bob')!.map((l) => l.text)).toEqual(['psst', 'yes?']);
    s.setActive('dm:bob');
    expect(s.get().unread.get('dm:bob')).toBeUndefined();
    s.remove('m1');
    expect(s.get().lines.get('subnet:lo')!.map((l) => l.id)).toEqual(['m0', 'm2']);
    const snap = s.get();
    expect(s.get()).toBe(snap); // stable between changes (useSyncExternalStore requires it)
    s.setMuted('2026-10-01T00:00:00.000Z');
    expect(s.get().mutedUntil).toBe('2026-10-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Store and panels**

`apps/frontend/src/game/chat.ts`:

```ts
import { useSyncExternalStore } from 'react';

export interface ChatLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}

const LIMIT = 256;

/** Chat lines per channel, fed by the connection (live) and the API (history). */
export function createChatStore() {
  let lines = new Map<string, ChatLine[]>();
  let unread = new Map<string, number>();
  let active = '';
  let mutedUntil: string | null = null;
  const listeners = new Set<() => void>();
  let version = 0;
  // useSyncExternalStore needs a stable snapshot between changes: rebuilt only in notify()
  let snapshot: { lines: Map<string, ChatLine[]>; unread: Map<string, number>; active: string; mutedUntil: string | null; version: number } = { lines, unread, active, mutedUntil, version };
  const notify = () => {
    version++;
    snapshot = { lines, unread, active, mutedUntil, version };
    listeners.forEach((l) => l());
  };
  const put = (channel: string, incoming: ChatLine[]) => {
    const cur = lines.get(channel) ?? [];
    const seen = new Set(cur.map((l) => l.id));
    const merged = [...cur, ...incoming.filter((l) => !seen.has(l.id))].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    lines = new Map(lines).set(channel, merged.slice(-LIMIT));
  };
  return {
    push(line: ChatLine) {
      // a DM shows under the *other* side's id on both ends
      const channel = line.channel.startsWith('dm:') && line.channel !== `dm:${line.from}` && line.from !== me ? `dm:${line.from}` : line.channel;
      put(channel, [line]);
      if (channel !== active) unread = new Map(unread).set(channel, (unread.get(channel) ?? 0) + 1);
      notify();
    },
    history(channel: string, incoming: ChatLine[]) {
      put(channel, incoming);
      notify();
    },
    remove(id: string) {
      lines = new Map([...lines].map(([c, ls]) => [c, ls.filter((l) => l.id !== id)]));
      notify();
    },
    setActive(channel: string) {
      if (active === channel && !unread.has(channel)) return;
      active = channel;
      if (unread.has(channel)) {
        unread = new Map(unread);
        unread.delete(channel);
      }
      notify();
    },
    setMuted(until: string | null) {
      mutedUntil = until;
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    clear() {
      lines = new Map();
      unread = new Map();
      notify();
    },
  };
}

/** The connected operator's id, set by the connection so DM threads land under the other side. */
export let me = '';
export function setMe(id: string): void {
  me = id;
}

export type ChatStore = ReturnType<typeof createChatStore>;
export const chatStore = createChatStore();

export function useChat() {
  return useSyncExternalStore(chatStore.subscribe, chatStore.get, chatStore.get);
}
```

`apps/frontend/src/panels/ChatPanel.tsx`:

```tsx
import { CHAT_INTERVAL_MS, CHAT_MAX_CHARS } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useRef, useState } from 'react';
import { useLazyChatHistoryQuery, useReportMutation } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { chatStore, useChat, type ChatLine } from '../game/chat.ts';
import { log } from '../game/log.ts';

const REASONS = ['SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER'] as const;

/** Report dialog for a chat line or an operator (SP4 spec §5.2): the reporter only ever sees "report received". */
export function ReportButton({ targetId, messageId, label = 'report' }: { targetId: string; messageId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('SPAM');
  const [note, setNote] = useState('');
  const [report, state] = useReportMutation();
  if (!open) {
    return (
      <button className="text-[10px] text-neutral-600 hover:text-red-300" onClick={() => setOpen(true)} data-testid={`report-${messageId ?? targetId}`}>
        {label}
      </button>
    );
  }
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-[10px]">
      <select className="rounded bg-neutral-800 px-1" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
        {REASONS.map((r) => (
          <option key={r} value={r}>
            {r.toLowerCase()}
          </option>
        ))}
      </select>
      <input className="w-24 rounded bg-neutral-800 px-1" placeholder="note" maxLength={256} value={note} onChange={(e) => setNote(e.target.value)} />
      <button
        className="rounded bg-red-900 px-1 hover:bg-red-800"
        disabled={state.isLoading}
        onClick={async () => {
          try {
            await report({ targetId, ...(messageId ? { messageId } : {}), reason, note }).unwrap();
            log.push('system', 'report received — thank you');
          } catch {
            log.push('error', 'report not sent');
          }
          setOpen(false);
        }}
        data-testid="report-send"
      >
        send
      </button>
      <button className="text-neutral-500" onClick={() => setOpen(false)}>
        cancel
      </button>
    </span>
  );
}

export function ChatPanel({ client, isAdmin }: { client: GameClient; isAdmin: boolean }) {
  const chat = useChat();
  const channels = [...new Set([...client.chat.channels, ...chat.lines.keys()])];
  const [active, setActive] = useState(channels[0] ?? `subnet:${client.subnet}`);
  const [text, setText] = useState('');
  const [dm, setDm] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [loadHistory] = useLazyChatHistoryQuery();
  const listRef = useRef<HTMLDivElement>(null);
  const manual = client.role === 'controller';
  const lines = chat.lines.get(active) ?? [];

  useEffect(() => {
    chatStore.setActive(active);
    if (active.startsWith('cluster:')) return;
    void loadHistory({ channel: active })
      .unwrap()
      .then((rows) => chatStore.history(active, rows as ChatLine[]))
      .catch(() => {});
  }, [active, loadHistory]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lines.length, active]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 250)), 250);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    run(client.chat.send(active, t), 'chat');
    setText('');
    setCooldown(CHAT_INTERVAL_MS);
  };
  const muted = chat.mutedUntil && Date.parse(chat.mutedUntil) > Date.now();

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-1">
        {channels.map((c) => (
          <button key={c} className={`rounded px-1.5 py-0.5 ${active === c ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setActive(c)} data-testid={`channel-${c}`}>
            {c}
            {chat.unread.get(c) ? <span className="ml-1 rounded bg-sky-800 px-1 text-[10px]">{chat.unread.get(c)}</span> : null}
          </button>
        ))}
        <form
          className="ml-auto flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (dm.trim()) setActive(`dm:${dm.trim()}`);
            setDm('');
          }}
        >
          <input className="w-28 rounded bg-neutral-900 px-1" placeholder="dm operator id" value={dm} onChange={(e) => setDm(e.target.value)} />
        </form>
      </div>
      <div ref={listRef} className="mono min-h-0 flex-1 overflow-auto p-2" data-testid="chat-lines">
        {lines.length === 0 && <p className="text-neutral-600">nothing yet</p>}
        {lines.map((l) => (
          <div key={l.id} className="group">
            <span className="text-neutral-600">{new Date(l.at).toLocaleTimeString()}</span>{' '}
            <span className={l.from === client.operatorId ? 'text-sky-300' : 'text-neutral-300'}>
              {l.tag ? `[${l.tag}] ` : ''}
              {l.name ?? l.from.slice(0, 8)}
            </span>
            : <span className="text-neutral-100">{l.text}</span>
            {l.from !== client.operatorId && <ReportButton targetId={l.from} messageId={l.id} />}
            {isAdmin && <AdminLineActions line={l} />}
          </div>
        ))}
      </div>
      <form
        className="flex gap-1 border-t border-neutral-800 p-1"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1"
          placeholder={muted ? `muted until ${new Date(chat.mutedUntil!).toLocaleTimeString()}` : `message ${active}`}
          maxLength={CHAT_MAX_CHARS}
          value={text}
          disabled={!manual || !!muted}
          onChange={(e) => setText(e.target.value)}
          data-testid="chat-input"
        />
        <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={!manual || !!muted || cooldown > 0 || !text.trim()} data-testid="chat-send">
          {cooldown > 0 ? `${(cooldown / 1000).toFixed(1)}s` : 'send'}
        </button>
      </form>
    </div>
  );
}

function AdminLineActions({ line }: { line: ChatLine }) {
  return (
    <span className="ml-1 hidden gap-1 text-[10px] group-hover:inline-flex">
      <button className="text-amber-400" onClick={() => void fetch(`/api/admin/chat/${line.id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-requested-with': 'daemonet' } })}>
        delete
      </button>
      <button
        className="text-amber-400"
        onClick={() => void fetch('/api/admin/chat/mute', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'daemonet', 'content-type': 'application/json' }, body: JSON.stringify({ operatorId: line.from, minutes: 30 }) })}
      >
        mute 30m
      </button>
    </span>
  );
}
```

`apps/frontend/src/panels/AdminPanel.tsx`:

```tsx
import { useState } from 'react';
import { useAddFilterTermMutation, useAdminEconomyQuery, useAdminReportsQuery, useDeleteFilterTermMutation, useFilterTermsQuery, useResolveReportMutation } from '../api.ts';

const VIEWS = ['reports', 'filter', 'economy'] as const;
type View = (typeof VIEWS)[number];

/** Admin tools (daemonet-admins only): the report queue, chat filter terms, and the SP3b economy view. */
export function AdminPanel() {
  const [view, setView] = useState<View>('reports');
  return (
    <div className="space-y-3 p-3 text-sm">
      <nav className="flex gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`admin-${v}`}>
            {v}
          </button>
        ))}
      </nav>
      {view === 'reports' && <Reports />}
      {view === 'filter' && <Filter />}
      {view === 'economy' && <Economy />}
    </div>
  );
}

function Reports() {
  const reports = useAdminReportsQuery('OPEN');
  const [resolve] = useResolveReportMutation();
  const rows = reports.data ?? [];
  return (
    <section className="space-y-1" data-testid="admin-reports">
      <p className="text-xs text-neutral-500">
        {rows.length} open ·{' '}
        <button className="underline" onClick={() => reports.refetch()}>
          refresh
        </button>
      </p>
      {rows.map((r) => (
        <div key={r.id} className="rounded border border-neutral-800 p-2">
          <div className="text-xs">
            <span className="text-neutral-400">{r.reporterName ?? r.reporterId.slice(0, 8)}</span> reported <span className="text-neutral-200">{r.targetName ?? r.targetId.slice(0, 8)}</span> · {r.reason.toLowerCase()}
            {r.note ? ` · “${r.note}”` : ''}
          </div>
          {r.message && <div className="mono mt-1 rounded bg-neutral-900 p-1 text-xs text-neutral-300">{r.message.text}</div>}
          <div className="mt-1 flex gap-2 text-xs">
            <button className="rounded bg-neutral-800 px-2 py-0.5" onClick={() => resolve({ id: r.id, action: 'DISMISS' })}>
              dismiss
            </button>
            {r.messageId && (
              <button className="rounded bg-amber-900 px-2 py-0.5" onClick={() => resolve({ id: r.id, action: 'DELETE' })}>
                delete message
              </button>
            )}
            <button className="rounded bg-red-900 px-2 py-0.5" onClick={() => resolve({ id: r.id, action: 'MUTE', minutes: 60 })}>
              mute 1h
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function Filter() {
  const terms = useFilterTermsQuery();
  const [add] = useAddFilterTermMutation();
  const [remove] = useDeleteFilterTermMutation();
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'WORD' | 'REGEX'>('WORD');
  const [action, setAction] = useState<'BLOCK' | 'MASK'>('BLOCK');
  return (
    <section className="space-y-1 text-xs" data-testid="admin-filter">
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pattern.trim()) return;
          void add({ pattern: pattern.trim(), kind, action });
          setPattern('');
        }}
      >
        <input className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1" placeholder="term or regex" value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="filter-pattern" />
        <select className="rounded bg-neutral-800 px-1" value={kind} onChange={(e) => setKind(e.target.value as 'WORD' | 'REGEX')}>
          <option>WORD</option>
          <option>REGEX</option>
        </select>
        <select className="rounded bg-neutral-800 px-1" value={action} onChange={(e) => setAction(e.target.value as 'BLOCK' | 'MASK')}>
          <option>BLOCK</option>
          <option>MASK</option>
        </select>
        <button className="rounded bg-sky-800 px-2">add</button>
      </form>
      <p className="text-neutral-500">the default list ships with the game; these are your additions</p>
      {terms.data?.map((t) => (
        <div key={t.id} className="mono flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
          <span>
            {t.pattern} <span className="text-neutral-500">{t.kind.toLowerCase()} · {t.action.toLowerCase()}</span>
          </span>
          <button className="text-neutral-500 hover:text-red-300" onClick={() => remove(t.id)}>
            remove
          </button>
        </div>
      ))}
    </section>
  );
}

function Economy() {
  const eco = useAdminEconomyQuery();
  if (!eco.data) return <p className="text-xs text-neutral-500">loading…</p>;
  return (
    <section className="mono text-xs" data-testid="admin-economy">
      <p>
        supply {eco.data.supply} bits across {eco.data.operators} operators
      </p>
      {eco.data.days.map((d) => (
        <div key={d.day} className="flex justify-between border-b border-neutral-900 py-0.5">
          <span className="text-neutral-500">{d.day}</span>
          <span className="text-emerald-300">+{d.created}</span>
          <span className="text-red-300">-{d.destroyed}</span>
          <span className="text-neutral-400">{Object.entries(d.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Wiring**

Replace `apps/frontend/src/api.ts`:

```ts
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { BestiaryRow, ItemDef, MoveDef, NatureDef, SpeciesDef, TraitDef, TypeId } from './types.ts';

export interface Me {
  operatorId: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  isAdmin: boolean;
}
export interface ScriptDoc {
  source: string;
  version: number;
  updatedAt: string | null;
}
export interface ScriptVersion {
  version: number;
  createdAt: string;
  bytes: number;
}
export interface DiskDaemon {
  id: string;
  species: string;
  level: number;
  clean: boolean;
  signature: number;
  slot: number;
  hp: number;
  moves: string[];
  ivs: number[];
  heldItem: string | null;
  patched: boolean;
  crashes: number;
  history: Array<{ at: string; kind: string; detail: string }>;
  log: { originalOperatorId: string; capturedAt: string; subnet: string; tool: string; spawnIndex: number | null };
}
export interface ChatHistoryLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}
export interface AdminReport {
  id: string;
  reporterId: string;
  targetId: string;
  messageId: string | null;
  reason: string;
  note: string;
  status: string;
  at: string;
  reporterName: string | null;
  targetName: string | null;
  message: { id: string; text: string; channel: string } | null;
}
export interface FilterTermRow {
  id: string;
  pattern: string;
  kind: 'WORD' | 'REGEX';
  action: 'BLOCK' | 'MASK';
}
export interface EconomyView {
  supply: number;
  operators: number;
  days: Array<{ day: string; created: number; destroyed: number; byReason: Record<string, number> }>;
}
export interface LedgerEntry {
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}
export interface Codex {
  types: TypeId[];
  chart: Record<TypeId, Record<TypeId, number>>;
  species: SpeciesDef[];
  moves: MoveDef[];
  items: ItemDef[];
  natures: NatureDef[];
  traits: TraitDef[];
  /** Bestiary rows with hidden, undiscovered requirements blanked (null). */
  bestiary: BestiaryRow[];
  discovered: string[];
  discoveries: Array<{ formId: string; operatorName: string | null; discoveredAt: string }>;
  /** The caller's research points per bestiary line. */
  research: Record<string, number>;
  /** Requirement kinds of hidden branches in lines researched to 256. */
  hints: Array<{ formId: string; kind: string }>;
}
export interface BoardTicket {
  index: number;
  kind: 'clear' | 'capture' | 'deliver' | 'evolve';
  params: unknown;
  target: number;
  reward: number;
  title: string;
  status: 'OPEN' | 'DONE' | 'ABANDONED' | null;
}
export interface TicketHistory {
  id: string;
  day: string;
  subnet: string;
  index: number;
  kind: string;
  target: number;
  reward: number;
  progress: number;
  status: 'OPEN' | 'DONE' | 'ABANDONED';
  acceptedAt: string;
  completedAt: string | null;
}

/** All mutations carry the CSRF header the API requires. */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api',
    credentials: 'same-origin',
    prepareHeaders: (headers) => {
      headers.set('x-requested-with', 'daemonet');
      return headers;
    },
  }),
  tagTypes: ['Me', 'Script', 'Disk', 'Codex', 'Reports', 'Filter'],
  endpoints: (b) => ({
    me: b.query<Me, void>({ query: () => '/me', providesTags: ['Me'] }),
    codex: b.query<Codex, void>({ query: () => '/codex', providesTags: ['Codex'] }),
    disk: b.query<DiskDaemon[], void>({ query: () => '/disk', providesTags: ['Disk'] }),
    ledger: b.query<LedgerEntry[], void>({ query: () => '/ledger' }),
    board: b.query<{ day: string; subnet: string; tickets: BoardTicket[]; acceptedToday: number }, string>({ query: (subnet) => `/tickets/board?subnet=${encodeURIComponent(subnet)}` }),
    ticketHistory: b.query<TicketHistory[], void>({ query: () => '/tickets' }),
    chatHistory: b.query<ChatHistoryLine[], { channel: string; before?: string }>({
      query: ({ channel, before }) => `/chat/${encodeURIComponent(channel)}${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    }),
    report: b.mutation<{ ok: boolean; id: string; duplicate?: boolean }, { targetId: string; messageId?: string; reason: string; note: string }>({
      query: (body) => ({ url: '/reports', method: 'POST', body }),
    }),
    adminReports: b.query<AdminReport[], string>({ query: (status) => `/admin/reports?status=${status}`, providesTags: ['Reports'] }),
    resolveReport: b.mutation<{ ok: boolean }, { id: string; action: 'DISMISS' | 'DELETE' | 'MUTE'; minutes?: number }>({
      query: ({ id, ...body }) => ({ url: `/admin/reports/${id}/resolve`, method: 'POST', body }),
      invalidatesTags: ['Reports'],
    }),
    filterTerms: b.query<FilterTermRow[], void>({ query: () => '/admin/chat/filter', providesTags: ['Filter'] }),
    addFilterTerm: b.mutation<FilterTermRow, { pattern: string; kind: 'WORD' | 'REGEX'; action: 'BLOCK' | 'MASK' }>({
      query: (body) => ({ url: '/admin/chat/filter', method: 'POST', body }),
      invalidatesTags: ['Filter'],
    }),
    deleteFilterTerm: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `/admin/chat/filter/${id}`, method: 'DELETE' }), invalidatesTags: ['Filter'] }),
    adminEconomy: b.query<EconomyView, void>({ query: () => '/admin/economy' }),
    script: b.query<ScriptDoc, void>({ query: () => '/scripts/main', providesTags: ['Script'] }),
    versions: b.query<ScriptVersion[], void>({ query: () => '/scripts/main/versions', providesTags: ['Script'] }),
    version: b.query<{ version: number; source: string }, number>({ query: (v) => `/scripts/main/versions/${v}` }),
    saveScript: b.mutation<{ version: number; updatedAt: string }, { source: string }>({
      query: (body) => ({ url: '/scripts/main', method: 'PUT', body }),
      invalidatesTags: ['Script'],
    }),
    ticket: b.mutation<{ ticket: string }, void>({ query: () => ({ url: '/ws/ticket', method: 'POST' }) }),
    logout: b.mutation<{ ok: boolean; endSessionUrl: string | null }, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }) }),
  }),
});

export const {
  useLazyChatHistoryQuery,
  useReportMutation,
  useAdminReportsQuery,
  useResolveReportMutation,
  useFilterTermsQuery,
  useAddFilterTermMutation,
  useDeleteFilterTermMutation,
  useAdminEconomyQuery,
  useMeQuery, useCodexQuery, useDiskQuery, useLedgerQuery, useBoardQuery, useTicketHistoryQuery, useScriptQuery, useVersionsQuery, useLazyVersionQuery, useSaveScriptMutation, useLogoutMutation } = api;

/** Used outside React (the connection manager) to mint a fresh websocket ticket. */
export async function fetchTicket(): Promise<string> {
  const res = await fetch('/api/ws/ticket', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'daemonet' } });
  if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
  return ((await res.json()) as { ticket: string }).ticket;
}
```

`apps/frontend/src/App.tsx`: tabs become `['play', 'ram', 'disk', 'host', 'items', 'codex', 'chat', 'script', 'log', 'admin']`, the nav filters out `admin` unless `me.data.isAdmin`, and the body renders `<ChatPanel client={client} isAdmin={me.data.isAdmin} />` for `chat` and `<AdminPanel />` for `admin` (admins only).

`apps/frontend/src/game/connection.ts` (before `set({ status: 'online', … })`):

```ts
    setMe(client.operatorId);
    client.on('chat', (line) => chatStore.push(line));
    client.on('chatDeleted', (d) => chatStore.remove(d.id));
    client.on('muted', (d) => {
      chatStore.setMuted(d.until);
      log.push('system', d.until ? `you are muted until ${new Date(d.until).toLocaleString()}` : 'your mute was lifted');
    });
```

`apps/frontend/src/sdk-types.ts`: add `ChatLine`, `class ChatApi { readonly channels: string[]; send(channel: string, text: string): Promise<unknown>; dm(operatorId: string, text: string): Promise<unknown> }`, `readonly chat: ChatApi` on `GameClient`, and the `'chat'` / `'muted'` overloads of `on`.

- [ ] **Step 4: End-to-end**

In `apps/frontend/e2e/smoke.spec.ts` import `type Page` and add the helper after the imports:

```ts
async function login(page: Page, who: string) {
  await page.goto('/');
  await page.getByTestId('dev-name').fill(who);
  await page.getByTestId('dev-login').click();
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });
}
```

and append:

```ts
test('two operators chat in subnet:lo; the filter masks and blocks; a line can be reported', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await login(pa, `${name}ca`);
  await login(pb, `${name}cb`);
  await pa.getByTestId('tab-chat').click();
  await pb.getByTestId('tab-chat').click();
  await pa.getByTestId('chat-input').fill('hello from a, what the fuck');
  await pa.getByTestId('chat-send').click();
  await expect(pb.getByTestId('chat-lines')).toContainText('hello from a, what the ***', { timeout: 10_000 });
  await expect(pa.getByTestId('chat-lines')).toContainText(`${name}ca`);
  await pb.getByTestId('chat-input').fill('kys');
  await pb.getByTestId('chat-send').click();
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('message blocked by the chat filter', { timeout: 10_000 });
  await pb.getByTestId('tab-chat').click();
  await pb.locator('[data-testid^="report-m"]').first().click();
  await pb.getByTestId('report-send').click();
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('report received', { timeout: 10_000 });
  await a.close();
  await b.close();
});
```

- [ ] **Step 5: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... REDIS_URL=... pnpm exec vitest run` — expected: green, 39 files, 347 tests. Build, start the stack **with `REDIS_URL` set for both sim and api**, `playwright test` — 4 passed. As an admin (`/api/auth/dev?name=boss&admin=true`): the **admin** tab lists the report from the e2e, "delete message" removes the line from both browsers, adding a filter term blocks it in chat within a second.

```bash
git add apps/frontend
git commit -m "feat(frontend): chat panel with reports, admin panel (reports, filter terms, economy)"
```

---

## Self-review

- **Spec coverage:** §4 bus (Task 1); §5 channels, guards, 2-second limit, persistence, events, SDK, client panel, history API, mute / delete (Tasks 3–5); §5.1 default list, admin terms with bus reload, block / mask, normalisation, filter hits, auto-mute after three blocks in ten minutes, names through the filter (Tasks 2–4); §5.2 reports with daily cap and duplicate handling, admin queue with the message, resolve actions, "report received" only (Tasks 4–5). Cluster and org channels are routed by `ChatService.recipients` through the host hooks that plans 2 and 3 implement; org history and org-name filtering land with plan 3.
- **Type consistency:** `ChatLine` has one shape across the server message, the SDK event, the client store and the API history rows (`tag` is `null` in history until plan 3); `FilterTerm` comes from rules everywhere; `ChatStore` is the only persistence surface the service sees.
- **Placeholders:** none.
