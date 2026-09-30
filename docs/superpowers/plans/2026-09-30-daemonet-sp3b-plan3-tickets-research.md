# Daemonet SP3b · Plan 3 — Tickets, research and scans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bits faucet and the Codex's second layer: helpdesk **tickets** (a deterministic daily board per subnet host; accept, progress, abandon, payout through the ledger), **research** points per bestiary line earned by every capture, **scans** that reveal a wild daemon's nature / IV buckets / IVs to operators who have researched its line, and hidden-branch **hints** at 256 points — with the protocol, SDK, API and client for all of it.

**Architecture:** `ticketBoard(subnet, day)` in `rules` generates the same eight tickets for everyone from `tickets:<subnet>:<day>`, so the sim, the SDK and the web client agree without an API call. The sim tracks open tickets on the operator (`op.tickets`), counts defeats / captures / evolutions / host arrivals against them, and raises a `completeTicket` intent when a target is reached; the store closes the row, credits the reward and writes the ledger row in one transaction (`grantBits` semantics from plan 2), and the sim credits the balance only on commit. Accept / abandon are optimistic intents like the shop. Research is incremented in the capture intent's transaction and mirrored in memory; scans are a per-viewer projection in `toDaemonEntity(world, d, viewer)` — deltas were already computed per session, so this costs one projection per viewer per tick.

**Tech Stack:** as before. No new dependencies.

**Prerequisites:** SP3b plans 1–2 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3b-economy-subnets-design.md` §7, §8. Decisions fixed here: a starter counts as a capture for research; the daily counter is UTC and rolls over in the sim as well as in the store; a `deliver` ticket completes when the operator stands within host range in the destination subnet (checked every tick); an abandoned ticket still counts toward the eight per day.

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- A ticket's reward is paid exactly once (the completion intent is idempotent and the row moves to DONE in the same transaction as the ledger row).
- Scan fields never reach an operator whose research is below the threshold; the unviewered projection (`entitiesNear` without `viewer`) never includes them.

## File map

```
packages/rules/src/content/tickets.ts       TicketDef, ticketBoard, dayKey, ticketKey, TICKETS_PER_DAY, OPEN_TICKETS_MAX
packages/db/prisma/schema.prisma            Ticket, Research (+ migration 20260930000004)
packages/shared/src/protocol.ts             acceptTicket / abandonTicket, ticketProgress / ticketDone, OperatorSelf.tickets/ticketsToday/research, DaemonEntity.scan
packages/sdk/src/client.ts                  world.tickets, operator.acceptTicket / abandonTicket
apps/sim/src/core/systems/tickets.ts        acceptTicket, abandonTicket, advanceTickets, checkTickets, completeTicketIntent
apps/sim/src/core/{model,world,view}.ts     OpenTicket, record fields, scans, self fields
apps/sim/src/core/systems/{commands,progress,capture,evolve}.ts   hooks
apps/sim/src/runtime/{store,prisma-store,game}.ts   rows, research, viewer projection
apps/api/src/routes/misc.ts                 codex research + hints, /api/tickets/board, /api/tickets
apps/frontend: HostPanel tickets view, PlayPanel scan, CodexPanel research/hints, api.ts, sdk-types, e2e
```

---

### Task 1: Ticket boards (rules)

**Files:**
- Create: `packages/rules/src/content/tickets.ts`, `packages/rules/test/tickets.test.ts`
- Modify: `packages/rules/src/index.ts`

**Interfaces:**
- `TicketKind = 'clear' | 'capture' | 'deliver' | 'evolve'`; `TicketParams` (discriminated on `kind`: `{ type, count }`, `{ line, minLevel }`, `{ to }`, `{}`); `TicketDef { index; kind; params; target; reward; title }`.
- `ticketBoard(subnetId, day): TicketDef[]` (8; deterministic; `lo` indices 0–1 are `clear`; no `evolve` on tier 0); `dayKey(iso)`, `ticketKey(day, subnet, index)`; `TICKETS_PER_DAY = 8`, `OPEN_TICKETS_MAX = 2`, `BOARD_SIZE = 8`.
- Rewards: clear `max(64, 64·(1+tier)·[1 | ½])`, capture `128·(1+stage) + 64·tier`, deliver `128 + 64·max(tier, destination tier)`, evolve 256 — all capped at 512.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getSpecies } from '../src/content/species.js';
import { OPEN_SUBNET_IDS, getSubnet } from '../src/content/subnets.js';
import { BOARD_SIZE, TICKETS_PER_DAY, dayKey, ticketBoard, ticketKey } from '../src/content/tickets.js';
import { TYPES } from '../src/types.js';

describe('ticket boards', () => {
  it('are deterministic per subnet and day, eight tickets each', () => {
    const a = ticketBoard('lo', '2026-09-30');
    const b = ticketBoard('lo', '2026-09-30');
    expect(a).toEqual(b);
    expect(a).toHaveLength(BOARD_SIZE);
    expect(a.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ticketBoard('lo', '2026-10-01')).not.toEqual(a);
    expect(ticketBoard('lan', '2026-09-30')).not.toEqual(a);
    expect(TICKETS_PER_DAY).toBe(8);
    expect(dayKey('2026-09-30T13:45:00.000Z')).toBe('2026-09-30');
    expect(ticketKey('2026-09-30', 'lo', 3)).toBe('2026-09-30:lo:3');
  });

  it('lo opens every board with two clear tickets and never asks to evolve', () => {
    for (const day of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-11-11']) {
      const board = ticketBoard('lo', day);
      expect(board[0]!.kind).toBe('clear');
      expect(board[1]!.kind).toBe('clear');
      expect(board.some((t) => t.kind === 'evolve')).toBe(false);
    }
  });

  it('every ticket is consistent with its subnet and pays 64-512 bits', () => {
    for (const id of OPEN_SUBNET_IDS) {
      const subnet = getSubnet(id);
      const spawnTypes = new Set(subnet.regions.flatMap((r) => Object.keys(r.species).map((s) => getSpecies(s).types[0])));
      for (const t of ticketBoard(id, '2026-09-30')) {
        expect(t.reward).toBeGreaterThanOrEqual(64);
        expect(t.reward).toBeLessThanOrEqual(512);
        expect(t.title.length).toBeGreaterThan(8);
        switch (t.params.kind) {
          case 'clear':
            expect(spawnTypes.has(t.params.type)).toBe(true);
            expect(TYPES).toContain(t.params.type);
            expect(t.target).toBe(t.params.count);
            break;
          case 'capture':
            expect(t.params.line).toBeGreaterThanOrEqual(1);
            expect(t.params.minLevel).toBeGreaterThanOrEqual(2);
            expect(t.target).toBe(1);
            break;
          case 'deliver':
            expect(subnet.gateways.map((g) => g.to)).toContain(t.params.to);
            break;
          case 'evolve':
            expect(subnet.tier).toBeGreaterThan(0);
            break;
        }
      }
    }
  });
});
```

- [ ] **Step 2: Content**

Create `packages/rules/src/content/tickets.ts`:

```ts
import { createRng, type Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { BESTIARY } from './bestiary.js';
import { getSpecies } from './species.js';
import { getSubnet } from './subnets.js';

/** Helpdesk tickets (SP3b spec §7): the only everyday faucet of bits. */
export const TICKETS_PER_DAY = 8;
export const OPEN_TICKETS_MAX = 2;
export const BOARD_SIZE = 8;

export type TicketKind = 'clear' | 'capture' | 'deliver' | 'evolve';

export type TicketParams =
  | { kind: 'clear'; type: TypeId; count: number }
  | { kind: 'capture'; line: number; minLevel: number }
  | { kind: 'deliver'; to: string }
  | { kind: 'evolve' };

export interface TicketDef {
  /** Position on the board (0-7); with the day and subnet it identifies the ticket. */
  index: number;
  kind: TicketKind;
  params: TicketParams;
  /** Progress needed to complete. */
  target: number;
  /** Bits paid on completion. */
  reward: number;
  title: string;
}

/** UTC calendar day (`YYYY-MM-DD`) a board belongs to. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

const CLEAR_COUNTS = [4, 8, 16, 32] as const;
const cap512 = (n: number) => Math.min(512, n);

function lineName(line: number): string {
  return BESTIARY.find((r) => r.line === line && r.stage === 0)?.name ?? `line ${line}`;
}

/** Types that spawn in the subnet (primary types of its regions' species) and its spawnable species with region minimum levels. */
function subnetPool(subnetId: string): { types: TypeId[]; species: Array<{ id: string; minLevel: number }> } {
  const s = getSubnet(subnetId);
  const types = new Set<TypeId>();
  const species: Array<{ id: string; minLevel: number }> = [];
  for (const r of s.regions) {
    for (const id of Object.keys(r.species)) {
      types.add(getSpecies(id).types[0]!);
      species.push({ id, minLevel: r.levels[0] });
    }
  }
  return { types: [...types], species };
}

function makeTicket(index: number, kind: TicketKind, subnetId: string, tier: number, rng: Rng, pool: ReturnType<typeof subnetPool>): TicketDef {
  switch (kind) {
    case 'clear': {
      const type = rng.pick(pool.types);
      const count = CLEAR_COUNTS[Math.min(3, tier)]! / (rng.chance(0.5) ? 1 : 2);
      const reward = cap512(Math.max(64, 64 * (1 + tier) * (count === CLEAR_COUNTS[Math.min(3, tier)] ? 1 : 0.5)));
      return { index, kind, params: { kind, type, count }, target: count, reward, title: `Clear ${count} ${type} daemons in ${subnetId}` };
    }
    case 'capture': {
      const pick = rng.pick(pool.species);
      const sp = getSpecies(pick.id);
      const reward = cap512(128 * (1 + sp.stage) + 64 * tier);
      return {
        index,
        kind,
        params: { kind, line: sp.line, minLevel: pick.minLevel },
        target: 1,
        reward,
        title: `Capture a ${lineName(sp.line)}-line daemon of level ${pick.minLevel}+ in ${subnetId}`,
      };
    }
    case 'deliver': {
      const to = rng.pick(getSubnet(subnetId).gateways.map((g) => g.to));
      const reward = cap512(128 + 64 * Math.max(tier, getSubnet(to).tier));
      return { index, kind, params: { kind, to }, target: 1, reward, title: `Deliver a token to the host of ${to}` };
    }
    case 'evolve':
      return { index, kind, params: { kind }, target: 1, reward: 256, title: 'Evolve any daemon' };
  }
}

/**
 * The 8 tickets a subnet's host posts on `day` (same for every operator; rotates daily). `lo` boards
 * always open with two tool-free `clear` tickets so a new operator can earn a first purchase.
 */
export function ticketBoard(subnetId: string, day: string): TicketDef[] {
  const subnet = getSubnet(subnetId);
  const rng = createRng(`tickets:${subnetId}:${day}`);
  const pool = subnetPool(subnetId);
  const kinds: TicketKind[] = subnet.tier === 0 ? ['clear', 'capture', 'deliver'] : ['clear', 'capture', 'deliver', 'evolve'];
  const board: TicketDef[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    const kind = subnetId === 'lo' && i < 2 ? 'clear' : rng.pick(kinds);
    board.push(makeTicket(i, kind, subnetId, subnet.tier, rng, pool));
  }
  return board;
}

export function ticketKey(day: string, subnet: string, index: number): string {
  return `${day}:${subnet}:${index}`;
}
```

Add `export * from './content/tickets.js';` to `packages/rules/src/index.ts` after the economy export.

- [ ] **Step 3: Verify and commit**

Run: `pnpm exec tsc -b packages/rules && pnpm exec vitest run packages/rules` — expected: green.

```bash
git add packages/rules
git commit -m "feat(rules): deterministic daily ticket boards per subnet"
```

---

### Task 2: Tickets, research and scans in the sim

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20260930000004_sp3b_tickets_research/migration.sql`
- Modify: `packages/shared/src/protocol.ts`, `packages/sdk/src/client.ts`
- Modify: `apps/sim/src/core/model.ts`, `apps/sim/src/core/world.ts`, `apps/sim/src/core/view.ts`, `apps/sim/src/core/systems/commands.ts`, `apps/sim/src/core/systems/progress.ts`, `apps/sim/src/core/systems/capture.ts`, `apps/sim/src/core/systems/evolve.ts`, `apps/sim/src/runtime/game.ts`, `apps/sim/src/runtime/store.ts`, `apps/sim/src/runtime/prisma-store.ts`
- Create: `apps/sim/src/core/systems/tickets.ts`, `apps/sim/test/tickets.test.ts`
- Tests: modify `apps/sim/test/helpers.ts`, `apps/sim/test/store.test.ts`, `apps/api/test/app.test.ts` (truncation), `packages/sandbox/test/sandbox.test.ts` (fixture)

**Interfaces:**
- Protocol: commands `acceptTicket { day, subnet, index }`, `abandonTicket { ticketId }`; events `ticketProgress { ticketId, progress, target }`, `ticketDone { ticketId, reward }` (plus the plan-2 `bits` event with reason `ticket`); `OperatorSelf.tickets[{ id, day, subnet, index, kind, params, target, reward, progress, title }]`, `ticketsToday`, `research: Record<line, points>`; `DaemonEntity.scan?: { nature?, ivBuckets?, ivs? }`.
- Model: `OpenTicket { id, day, subnet, index, kind, params, target, reward, progress, pending, completing }`; `OperatorRecord` / `Operator` gain `tickets`, `ticketsToday`, `ticketsDay`, `acceptedToday` (record) / `acceptedKeys` (set), `research`; intents `acceptTicket { ticketId, day, subnet, index, ticketKind, params, target, reward }`, `abandonTicket { ticketId }`, `completeTicket { ticketId, reward }` (no reqId).
- Sim (`systems/tickets.ts`): `acceptTicket`, `abandonTicket`, `advanceTickets(world, op, ev, out)` with `TicketEvent = clear{type} | capture{line, level} | evolve`, `checkTickets(world, out)` (every tick: deliveries at the destination host, retries), `completeTicketIntent`.
- View: `SCAN_NATURE = 4`, `SCAN_BUCKETS = 16`, `SCAN_IVS = 64`, `SCAN_HINTS = 256`; `toDaemonEntity(world, d, viewer?)`, `entitiesNear(world, x, y, radius, viewer?)`.
- Store: rows loaded with the record (open tickets, today's count and keys, research); intents; capture / claimStarter increment `Research`; checkpoints write open tickets' `progress`. MemoryStore exposes `tickets`, `research`, `now` (tests pin it).

- [ ] **Step 1: Schema and migration**

Add to `packages/db/prisma/schema.prisma` before `model Discovery`:

```prisma
enum TicketStatus {
  OPEN
  DONE
  ABANDONED
}

/// A helpdesk ticket an operator accepted (SP3b spec §7); the board itself is generated from rules.
model Ticket {
  id          String       @id
  operatorId  String
  /// UTC day of the board, YYYY-MM-DD
  day         String
  subnet      String
  index       Int
  kind        String
  params      Json
  target      Int
  reward      Int
  progress    Int          @default(0)
  status      TicketStatus @default(OPEN)
  acceptedAt  DateTime     @default(now())
  completedAt DateTime?

  @@unique([operatorId, day, subnet, index])
  @@index([operatorId, status])
  @@index([operatorId, day])
}

/// Codex research: one point per capture of any form of a bestiary line (design §7.2).
model Research {
  operatorId String
  line       Int
  points     Int    @default(0)

  @@id([operatorId, line])
}
```

Create the migration:

```sql
-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'DONE', 'ABANDONED');

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "target" INTEGER NOT NULL,
    "reward" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Research" (
    "operatorId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Research_pkey" PRIMARY KEY ("operatorId","line")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_operatorId_day_subnet_index_key" ON "Ticket"("operatorId", "day", "subnet", "index");

-- CreateIndex
CREATE INDEX "Ticket_operatorId_status_idx" ON "Ticket"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Ticket_operatorId_day_idx" ON "Ticket"("operatorId", "day");
```

Run: `pnpm --filter @daemonet/db exec prisma migrate deploy && pnpm --filter @daemonet/db exec prisma generate`. Add `"Ticket", "Research"` to the `TRUNCATE` lists in `apps/sim/test/store.test.ts` and `apps/api/test/app.test.ts` (after `"BitsLedger"`).

- [ ] **Step 2: Protocol and SDK**

`packages/shared/src/protocol.ts` — commands after `decompile`:

```ts
  z.object({ cmd: z.literal('acceptTicket'), actor: Self, args: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), subnet: Id, index: z.number().int().min(0).max(7) }) }),
  z.object({ cmd: z.literal('abandonTicket'), actor: Self, args: z.object({ ticketId: Id }) }),
```

events after `decompiled`:

```ts
  z.object({ e: z.literal('ticketProgress'), ticketId: Id, progress: z.number().int(), target: z.number().int() }),
  z.object({ e: z.literal('ticketDone'), ticketId: Id, reward: z.number().int() }),
```

`DaemonEntity` gains after `hardened`:

```ts
  /** Wild daemons only: what the viewer's Codex research reveals (design §7.2). */
  scan: z
    .object({
      nature: z.number().int().optional(),
      /** IV buckets 0-3 (0-7, 8-15, 16-23, 24-31), STAT_KEYS order. */
      ivBuckets: z.array(z.number().int().min(0).max(3)).length(8).optional(),
      ivs: z.array(z.number().int()).length(8).optional(),
    })
    .optional(),
```

and `OperatorSelf` gains after `diskCapacity`:

```ts
  /** Open helpdesk tickets. */
  tickets: z.array(
    z.object({
      id: Id,
      day: z.string(),
      subnet: Id,
      index: z.number().int(),
      kind: z.enum(['clear', 'capture', 'deliver', 'evolve']),
      params: z.unknown(),
      target: z.number().int(),
      reward: z.number().int(),
      progress: z.number().int(),
      title: z.string(),
    }),
  ),
  /** Tickets accepted today (UTC), of TICKETS_PER_DAY. */
  ticketsToday: z.number().int(),
  /** Codex research points per bestiary line (keys are line numbers). */
  research: z.record(z.string(), z.number().int()),
```

The sandbox test fixture gains `tickets: [], ticketsToday: 0, research: {},` after `diskCapacity: 256,`.

`packages/sdk/src/client.ts`: import `dayKey`, `ticketBoard`, `type TicketDef` from `@daemonet/rules`; add to `WorldView`

```ts
  /** Today's helpdesk board at this subnet's host (deterministic content; accept with operator.acceptTicket). */
  get tickets(): TicketDef[] {
    try {
      return ticketBoard(this.client.subnet, dayKey(new Date().toISOString()));
    } catch {
      return [];
    }
  }
```

and to `OperatorApi` before `travel`

```ts
  /** Accept a ticket from today's board at this host (`index` 0-7). */
  acceptTicket(index: number, subnet = this.client.subnet, day = dayKey(new Date().toISOString())) {
    return this.client.command({ cmd: 'acceptTicket', actor: 'self', args: { day, subnet, index } });
  }
  abandonTicket(ticketId: string) {
    return this.client.command({ cmd: 'abandonTicket', actor: 'self', args: { ticketId } });
  }
```

- [ ] **Step 3: Write the failing sim tests**

Test helper: `operatorRecord` gains `tickets: [], ticketsToday: 0, ticketsDay: '2026-09-30', acceptedToday: [], research: {},` after `diskSlots: [],`.

Create `apps/sim/test/tickets.test.ts`:

```ts
import { getSubnet, ticketBoard } from '@daemonet/rules';
import { describe, expect, it } from 'vitest';
import { World, entitiesNear, type Intent, type OpenTicket } from '../src/core/index.js';
import { Out } from '../src/core/out.js';
import { completeCaptureIntent } from '../src/core/systems/capture.js';
import { MemoryStore } from '../src/runtime/store.js';
import { FIXED_CLOCK, TEST_SUBNET, input, makeWorld, operatorRecord, ownedRecord, placeWild, self, step } from './helpers.js';

const DAY = '2026-09-30';
const HOST = TEST_SUBNET.host;

/** Alice at the host of the test subnet (no board of its own: tickets are placed on her directly). */
function setup() {
  const world = makeWorld('tix');
  world.addOperator(operatorRecord('alice', { x: HOST.x, y: HOST.y }));
  return world;
}

/** Alice at lo's host, where the real board applies. */
function lo() {
  const subnet = getSubnet('lo');
  const world = new World({ subnet, seed: 'lo', seedId: 'seed0002', spawner: false, clock: () => FIXED_CLOCK });
  world.addOperator(operatorRecord('alice', { x: subnet.host.x, y: subnet.host.y }));
  return world;
}

async function through(world: World, store: MemoryStore, command: Parameters<typeof input>[1]) {
  const r = step(world, input('alice', command));
  if (r.replies.length > 0) return { reply: r.replies[0]!, intent: null as Intent | null, events: [] as unknown[] };
  const intent = r.intents[0]!;
  world.completeIntent(intent.id, await store.applyIntent(intent, { seedId: 'seed0001' }));
  const after = step(world);
  return { reply: after.replies[0]!, intent, events: after.events.map((e) => e.event) };
}

async function seeded(world: World) {
  const store = new MemoryStore();
  store.now = () => FIXED_CLOCK;
  const rec = await store.loadOrCreateOperator('alice', world.subnet.id, HOST);
  const mem = store.operators.get(rec.id)!;
  store.operators.delete(rec.id);
  store.operators.set('alice', { ...mem, id: 'alice' });
  return store;
}

/** Puts an open ticket on the operator (and, when a store is given, its row) as if loaded. */
function give(world: World, store: MemoryStore | null, t: Pick<OpenTicket, 'kind' | 'params' | 'target' | 'reward'> & { subnet?: string }): OpenTicket {
  const op = world.operators.get('alice')!;
  const ticket: OpenTicket = { id: `t-${op.tickets.length}`, day: DAY, subnet: t.subnet ?? world.subnet.id, index: op.tickets.length, kind: t.kind, params: t.params, target: t.target, reward: t.reward, progress: 0, pending: false, completing: false };
  op.tickets.push(ticket);
  store?.tickets.set(ticket.id, { ...ticket, operatorId: 'alice', status: 'OPEN', acceptedAt: FIXED_CLOCK, completedAt: null });
  return ticket;
}

describe('accepting and abandoning', () => {
  it('enforces host, subnet, day, index, the open cap and duplicates, and persists through the store', async () => {
    const world = lo();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const accept = (args: { day?: string; subnet?: string; index: number }) => ({ cmd: 'acceptTicket', actor: self, args: { day: DAY, subnet: 'lo', ...args } }) as const;
    expect(step(world, input('alice', accept({ subnet: 'lan', index: 0 }))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    expect(step(world, input('alice', accept({ day: '2026-09-29', index: 0 }))).replies[0]).toMatchObject({ code: 'E_STATE' });
    expect(step(world, input('alice', accept({ index: 8 }))).replies[0]).toMatchObject({ code: 'E_INVALID' });
    op.x += 5;
    expect(step(world, input('alice', accept({ index: 0 }))).replies[0]).toMatchObject({ code: 'E_RANGE' });
    op.x -= 5;
    const first = await through(world, store, accept({ index: 0 }));
    expect(first.intent).toMatchObject({ kind: 'acceptTicket', day: DAY, subnet: 'lo', index: 0, ticketKind: 'clear', reward: ticketBoard('lo', DAY)[0]!.reward });
    expect(first.reply).toMatchObject({ ok: true, result: { ticketId: expect.any(String) } });
    expect(op.tickets).toHaveLength(1);
    expect(op.tickets[0]).toMatchObject({ pending: false, progress: 0, kind: 'clear' });
    expect(op.ticketsToday).toBe(1);
    expect(step(world, input('alice', accept({ index: 0 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'already accepted' });
    await through(world, store, accept({ index: 1 }));
    expect(step(world, input('alice', accept({ index: 2 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'at most 2 open tickets' });
    // abandon frees a slot but still counts toward the day
    const abandon = await through(world, store, { cmd: 'abandonTicket', actor: self, args: { ticketId: op.tickets[1]!.id } });
    expect(abandon.reply).toMatchObject({ ok: true });
    expect(op.tickets).toHaveLength(1);
    expect(op.ticketsToday).toBe(2);
    expect([...store.tickets.values()].map((t) => t.status)).toEqual(['OPEN', 'ABANDONED']);
    const rec = await store.loadOrCreateOperator('alice', 'lo', HOST);
    expect(rec.tickets.map((t) => t.index)).toEqual([0]);
    expect(rec).toMatchObject({ ticketsToday: 2, ticketsDay: DAY, acceptedToday: [`${DAY}:lo:0`, `${DAY}:lo:1`] });
    op.ticketsToday = 8;
    expect(step(world, input('alice', accept({ index: 3 }))).replies[0]).toMatchObject({ code: 'E_STATE', message: 'at most 8 tickets per day' });
  });

  it('reverts an accept the store refuses, and rolls the daily count over at midnight', async () => {
    const world = lo();
    const op = world.operators.get('alice')!;
    op.ticketsDay = '2026-09-29';
    op.ticketsToday = 8;
    const r = step(world, input('alice', { cmd: 'acceptTicket', actor: self, args: { day: DAY, subnet: 'lo', index: 0 } }));
    expect(r.intents).toHaveLength(1);
    expect(op.tickets).toHaveLength(1);
    expect(op.ticketsToday).toBe(1);
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'already accepted' });
    expect(op.tickets).toHaveLength(0);
    expect(op.ticketsToday).toBe(0);
    expect(step(world).replies[0]).toMatchObject({ ok: false, message: 'already accepted' });
  });
});

describe('progress and payout', () => {
  it('clear tickets count wild defeats of the type in this subnet and pay out through the store', async () => {
    const world = setup();
    const store = await seeded(world);
    const op = world.operators.get('alice')!;
    const t = give(world, store, { kind: 'clear', params: { kind: 'clear', type: 'null', count: 2 }, target: 2, reward: 64 });
    step(world, input('alice', { cmd: 'run', actor: self, args: { daemonId: 'alice-d0' } }));
    const kill = (species: string) => {
      const w = placeWild(world, species, 3, op.x + 1.5, op.y);
      w.trait = 'echo'; // no Bitshield: the one-HP wild goes down to the first ping
      w.hp = 1;
      world.daemons.get('alice-d0')!.cooldowns = {};
      return step(world, input('alice', { cmd: 'use', actor: 'alice-d0', args: { move: 'ping', targetId: w.id } }));
    };
    expect(kill('bitrot').events.map((e) => e.event.e)).not.toContain('ticketProgress'); // packet type: no progress
    expect(kill('nullpup').events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: 't-0', progress: 1, target: 2 });
    expect(world.checkpoint('alice').tickets[0]).toMatchObject({ id: 't-0', progress: 1 });
    const r = kill('nullpup');
    expect(t.completing).toBe(true);
    const complete = r.intents.find((i) => i.kind === 'completeTicket')!;
    expect(complete).toMatchObject({ ticketId: 't-0', reward: 64 });
    world.completeIntent(complete.id, await store.applyIntent(complete, { seedId: 'seed0001' }));
    const after = step(world).events.map((e) => e.event);
    expect(after).toContainEqual({ e: 'ticketDone', ticketId: 't-0', reward: 64 });
    expect(after).toContainEqual({ e: 'bits', delta: 64, reason: 'ticket', balance: 64 });
    expect(op.bits).toBe(64);
    expect(op.tickets).toEqual([]);
    expect(store.tickets.get('t-0')).toMatchObject({ status: 'DONE', progress: 2 });
    expect(store.ledger).toMatchObject([{ delta: 64, reason: 'ticket', ref: 't-0' }]);
  });

  it('capture tickets need the line at the minimum level in this subnet; research grows with every capture', () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    give(world, null, { kind: 'capture', params: { kind: 'capture', line: 5, minLevel: 6 }, target: 1, reward: 128 });
    const captured = (species: string, level: number, id: string): Extract<Intent, { kind: 'capture' }> => ({
      id: `i-${id}`, kind: 'capture', operatorId: 'alice', captureId: `c-${id}`, location: 'RAM', tool: 'sniff',
      daemon: ownedRecord(species, level, 2, id), log: { originalOperatorId: 'alice', capturedAtTick: 1, subnet: 'test', tool: 'sniff', seedId: 'seed0001', spawnIndex: 1 },
    });
    const out = new Out();
    completeCaptureIntent(world, op, captured('pingling', 5, 'w1'), { ok: true }, out); // line 5 but under level: research only
    expect(op.research).toEqual({ '5': 1 });
    expect(out.events.map((e) => e.event.e)).not.toContain('ticketProgress');
    completeCaptureIntent(world, op, { ...captured('pingling', 6, 'w2'), daemon: ownedRecord('pingling', 6, 3, 'w2') }, { ok: true }, out);
    expect(op.research).toEqual({ '5': 2 });
    expect(out.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: 't-0', progress: 1, target: 1 });
    expect(out.intents.at(-1)).toMatchObject({ kind: 'completeTicket', ticketId: 't-0', reward: 128 });
  });

  it('deliver tickets complete at the destination host; a failed completion is retried', () => {
    const world = setup();
    const t = give(world, null, { kind: 'deliver', params: { kind: 'deliver', to: 'test' }, target: 1, reward: 128, subnet: 'testb' });
    const r = step(world);
    expect(r.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: t.id, progress: 1, target: 1 });
    expect(r.intents[0]).toMatchObject({ kind: 'completeTicket', ticketId: t.id, reward: 128 });
    world.completeIntent(r.intents[0]!.id, { ok: false, reason: 'db down' });
    expect(t.completing).toBe(false);
    expect(step(world).intents[0]).toMatchObject({ kind: 'completeTicket', ticketId: t.id });
  });

  it('evolve tickets complete on any evolution', async () => {
    const world = setup();
    const op = world.operators.get('alice')!;
    op.ram = [];
    for (const id of [...world.daemons.keys()]) world.removeDaemon(id);
    world.addOwned(op, ownedRecord('echolet', 16, 0, 'alice-e0'));
    give(world, null, { kind: 'evolve', params: { kind: 'evolve' }, target: 1, reward: 256 });
    const r = step(world, input('alice', { cmd: 'evolve', actor: self, args: { daemonId: 'alice-e0', formId: 'tracerat' } }));
    world.completeIntent(r.intents[0]!.id, { ok: true, discovered: false });
    const after = step(world);
    expect(after.events.map((e) => e.event)).toContainEqual({ e: 'ticketProgress', ticketId: 't-0', progress: 1, target: 1 });
    expect(after.intents[0]).toMatchObject({ kind: 'completeTicket', reward: 256 });
  });
});

describe('scans', () => {
  it('reveal nature, IV buckets and IVs as research on the line grows, for the viewer only', () => {
    const world = setup();
    const alice = world.operators.get('alice')!;
    world.addOperator(operatorRecord('bob'));
    const wild = placeWild(world, 'pingling', 5, 8.5, 5.5);
    const seen = (viewer = alice) => entitiesNear(world, 8.5, 5.5, 4, viewer).find((e) => e.id === wild.id) as { scan?: unknown };
    expect(seen().scan).toBeUndefined();
    alice.research['5'] = 4;
    expect(seen().scan).toEqual({ nature: wild.nature });
    alice.research['5'] = 16;
    expect(seen().scan).toEqual({ nature: wild.nature, ivBuckets: [1, 1, 1, 1, 1, 1, 1, 1] });
    alice.research['5'] = 64;
    expect(seen().scan).toMatchObject({ ivs: [10, 10, 10, 10, 10, 10, 10, 10] });
    expect(seen(world.operators.get('bob')!).scan).toBeUndefined();
    expect((entitiesNear(world, 8.5, 5.5, 4).find((e) => e.id === wild.id) as { scan?: unknown }).scan).toBeUndefined();
  });
});
```

- [ ] **Step 4: Model**

In `apps/sim/src/core/model.ts`: import `TicketKind, TicketParams` types from `@daemonet/rules`; add before `OperatorRecord`

```ts
/** An accepted, still-open ticket as the sim tracks it. */
export interface OpenTicket {
  id: string;
  day: string;
  subnet: string;
  index: number;
  kind: TicketKind;
  params: TicketParams;
  target: number;
  reward: number;
  progress: number;
  /** Waiting for the accept / abandon intent. */
  pending: boolean;
  /** Completion intent in flight. */
  completing: boolean;
}
```

`OperatorRecord` gains after `diskSlots`:

```ts
  /** Open tickets (with progress) and today's accepted count. */
  tickets: OpenTicket[];
  ticketsToday: number;
  /** UTC day `ticketsToday` counts (YYYY-MM-DD). */
  ticketsDay: string;
  /** Keys (day:subnet:index) of every ticket accepted today, open or not. */
  acceptedToday: string[];
  /** Codex research points per bestiary line. */
  research: Record<string, number>;
```

`Operator` gains after `travelling`: `tickets: OpenTicket[]; ticketsToday: number; ticketsDay: string; acceptedKeys: Set<string>; research: Record<string, number>;`. The `Intent` union gains:

```ts
  | {
      id: string;
      kind: 'acceptTicket';
      operatorId: string;
      reqId: string;
      ticketId: string;
      day: string;
      subnet: string;
      index: number;
      ticketKind: TicketKind;
      params: TicketParams;
      target: number;
      reward: number;
    }
  | { id: string; kind: 'abandonTicket'; operatorId: string; reqId: string; ticketId: string }
  /** Raised by the sim itself (no reqId): pays the reward and closes the row. */
  | { id: string; kind: 'completeTicket'; operatorId: string; ticketId: string; reward: number };
```

- [ ] **Step 5: The tickets system and its hooks**

Create `apps/sim/src/core/systems/tickets.ts`:

```ts
import { OPEN_TICKETS_MAX, TICKETS_PER_DAY, dayKey, ticketBoard, ticketKey, type TypeId } from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, type Input, type Intent, type IntentResult, type OpenTicket, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { HOST_RADIUS } from './commands.js';


/** Something a ticket can count: a wild daemon cleared here, a capture here, an evolution anywhere. */
export type TicketEvent = { kind: 'clear'; type: TypeId } | { kind: 'capture'; line: number; level: number } | { kind: 'evolve' };

/** Rolls the per-day counter over at UTC midnight. */
function today(world: World, op: Operator): string {
  const day = dayKey(world.now());
  if (op.ticketsDay !== day) {
    op.ticketsDay = day;
    op.ticketsToday = 0;
  }
  return day;
}

export function acceptTicket(world: World, op: Operator, args: { day: string; subnet: string; index: number }, input: Input, out: Out): void {
  if (distance(op, world.subnet.host) > HOST_RADIUS) throw new Rejection('E_RANGE', 'must be at the host node');
  if (args.subnet !== world.subnet.id) throw new Rejection('E_INVALID', `this host only posts ${world.subnet.id} tickets`);
  const day = today(world, op);
  if (args.day !== day) throw new Rejection('E_STATE', `the board for ${args.day} is gone; today is ${day}`);
  const def = ticketBoard(world.subnet.id, day)[args.index];
  if (!def) throw new Rejection('E_INVALID', 'no such ticket on the board');
  const key = ticketKey(day, args.subnet, args.index);
  if (op.acceptedKeys.has(key)) throw new Rejection('E_STATE', 'already accepted');
  if (op.ticketsToday >= TICKETS_PER_DAY) throw new Rejection('E_STATE', `at most ${TICKETS_PER_DAY} tickets per day`);
  if (op.tickets.length >= OPEN_TICKETS_MAX) throw new Rejection('E_STATE', `at most ${OPEN_TICKETS_MAX} open tickets`);
  const ticket: OpenTicket = {
    id: world.newId('t'),
    day,
    subnet: args.subnet,
    index: args.index,
    kind: def.kind,
    params: def.params,
    target: def.target,
    reward: def.reward,
    progress: 0,
    pending: true,
    completing: false,
  };
  op.tickets.push(ticket);
  op.acceptedKeys.add(key);
  op.ticketsToday++;
  world.trackIntent(
    { id: world.newId('i'), kind: 'acceptTicket', operatorId: op.id, reqId: input.reqId, ticketId: ticket.id, day, subnet: args.subnet, index: args.index, ticketKind: def.kind, params: def.params, target: def.target, reward: def.reward },
    out,
  );
}

export function abandonTicket(world: World, op: Operator, ticketId: string, input: Input, out: Out): void {
  const t = op.tickets.find((x) => x.id === ticketId);
  if (!t) throw new Rejection('E_INVALID', 'no such open ticket');
  if (t.pending || t.completing) throw new Rejection('E_STATE', 'ticket is busy');
  t.pending = true;
  world.trackIntent({ id: world.newId('i'), kind: 'abandonTicket', operatorId: op.id, reqId: input.reqId, ticketId }, out);
}

function matches(world: World, t: OpenTicket, ev: TicketEvent): boolean {
  const p = t.params;
  switch (ev.kind) {
    case 'clear':
      return p.kind === 'clear' && p.type === ev.type && t.subnet === world.subnet.id;
    case 'capture':
      return p.kind === 'capture' && p.line === ev.line && ev.level >= p.minLevel && t.subnet === world.subnet.id;
    case 'evolve':
      return p.kind === 'evolve';
  }
}

function bump(world: World, op: Operator, t: OpenTicket, out: Out): void {
  t.progress = Math.min(t.target, t.progress + 1);
  out.emit({ e: 'ticketProgress', ticketId: t.id, progress: t.progress, target: t.target }, { to: op.id });
  settle(world, op, t, out);
}

/** Raises the completion intent once (again after a failed attempt). */
function settle(world: World, op: Operator, t: OpenTicket, out: Out): void {
  if (t.progress < t.target || t.completing || t.pending) return;
  t.completing = true;
  world.trackIntent({ id: world.newId('i'), kind: 'completeTicket', operatorId: op.id, ticketId: t.id, reward: t.reward }, out);
}

/** Count `ev` against every matching open ticket. */
export function advanceTickets(world: World, op: Operator, ev: TicketEvent, out: Out): void {
  for (const t of op.tickets) if (!t.pending && t.progress < t.target && matches(world, t, ev)) bump(world, op, t, out);
}

/** Per tick: deliveries complete at the destination host; unsettled complete tickets retry. */
export function checkTickets(world: World, out: Out): void {
  for (const op of world.operators.values()) {
    for (const t of op.tickets) {
      if (t.pending) continue;
      if (t.params.kind === 'deliver' && t.progress < t.target && t.params.to === world.subnet.id && distance(op, world.subnet.host) <= HOST_RADIUS) bump(world, op, t, out);
      else settle(world, op, t, out);
    }
  }
}

export function completeTicketIntent(world: World, op: Operator, intent: Extract<Intent, { kind: 'acceptTicket' | 'abandonTicket' | 'completeTicket' }>, result: IntentResult, out: Out): void {
  const t = op.tickets.find((x) => x.id === intent.ticketId);
  switch (intent.kind) {
    case 'acceptTicket': {
      if (!result.ok) {
        op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
        op.acceptedKeys.delete(ticketKey(intent.day, intent.subnet, intent.index));
        op.ticketsToday = Math.max(0, op.ticketsToday - 1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      if (t) t.pending = false;
      return out.ok(intent, { ticketId: intent.ticketId });
    }
    case 'abandonTicket': {
      if (!result.ok) {
        if (t) t.pending = false;
        return out.fail(intent, 'E_STATE', result.reason);
      }
      op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
      return out.ok(intent);
    }
    case 'completeTicket': {
      if (!result.ok) {
        if (t) t.completing = false;
        return;
      }
      op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
      op.bits += intent.reward;
      out.emit({ e: 'ticketDone', ticketId: intent.ticketId, reward: intent.reward }, { to: op.id });
      out.emit({ e: 'bits', delta: intent.reward, reason: 'ticket', balance: op.bits }, { to: op.id });
      return;
    }
  }
}
```

In `apps/sim/src/core/world.ts`: `addOperator` initialises

```ts
      tickets: rec.tickets.map((t) => ({ ...t, params: { ...t.params }, pending: false, completing: false })),
      ticketsToday: rec.ticketsToday,
      ticketsDay: rec.ticketsDay,
      acceptedKeys: new Set(rec.acceptedToday),
      research: { ...rec.research },
```

`checkpoint()` returns

```ts
      tickets: op.tickets.filter((t) => !t.pending).map((t) => ({ ...t, params: { ...t.params } })),
      ticketsToday: op.ticketsToday,
      ticketsDay: op.ticketsDay,
      acceptedToday: [...op.acceptedKeys],
      research: { ...op.research },
```

`completeIntent` routes `acceptTicket` / `abandonTicket` / `completeTicket` to `completeTicketIntent` (import from `./systems/tickets.js`), the `claimStarter` branch adds one research point to the starter's line (`op.research[line] = (op.research[line] ?? 0) + 1` with `line = String(getSpecies(intent.daemon.species).line)`), and `step()` calls `checkTickets(this, out)` right after `upkeep`.

Hooks: in `progress.ts` (`resolveDefeats`, after XP is awarded to the tag owner) `advanceTickets(world, owner, { kind: 'clear', type: d.types[0]! }, out);`; in `capture.ts` (`completeCaptureIntent`, before the RAM/Disk branch)

```ts
  const line = String(getSpecies(intent.daemon.species).line);
  op.research[line] = (op.research[line] ?? 0) + 1;
  advanceTickets(world, op, { kind: 'capture', line: Number(line), level: intent.daemon.level }, out);
```

in `evolve.ts` (`completeEvolveIntent`, after the `evolved` event) `advanceTickets(world, op, { kind: 'evolve' }, out);`; in `commands.ts` the cases

```ts
    case 'acceptTicket':
      return acceptTicket(world, op, c.args, input, out);
    case 'abandonTicket':
      return abandonTicket(world, op, c.args.ticketId, input, out);
```

- [ ] **Step 6: Scans and self**

Replace `apps/sim/src/core/view.ts`:

```ts
import { STAT_KEYS, evolutionOptions, getSpecies, statBlockToArray, ticketBoard, type StatusId } from '@daemonet/rules';
import type { Entity, OperatorSelf, RamDaemon } from '@daemonet/shared';
import { distance } from './grid.js';
import type { Daemon, Operator } from './model.js';
import { evolutionContext } from './systems/evolve.js';
import type { World } from './world.js';

export const INTEREST_RADIUS = 32;

const activeStatuses = (world: World, d: Daemon): StatusId[] =>
  (Object.entries(d.statuses) as Array<[StatusId, number]>).filter(([, until]) => until > world.tick).map(([s]) => s);

/** Research thresholds (design §7.2): 4 → nature (HP is always exact), 16 → IV buckets, 64 → exact IVs. */
export const SCAN_NATURE = 4;
export const SCAN_BUCKETS = 16;
export const SCAN_IVS = 64;
export const SCAN_HINTS = 256;

function scanFor(viewer: Operator | undefined, d: Daemon): Extract<Entity, { kind: 'daemon' }>['scan'] {
  if (!viewer || !d.wild) return undefined;
  const points = viewer.research[String(getSpecies(d.species).line)] ?? 0;
  if (points < SCAN_NATURE) return undefined;
  const scan: NonNullable<Extract<Entity, { kind: 'daemon' }>['scan']> = { nature: d.nature };
  if (points >= SCAN_BUCKETS) scan.ivBuckets = STAT_KEYS.map((k) => Math.floor(d.ivs[k] / 8));
  if (points >= SCAN_IVS) scan.ivs = statBlockToArray(d.ivs);
  return scan;
}

/** `viewer` adds the scan fields its research unlocks (wild daemons only). */
export function toDaemonEntity(world: World, d: Daemon, viewer?: Operator): Entity {
  const scan = scanFor(viewer, d);
  return {
    kind: 'daemon',
    id: d.id,
    species: d.species,
    types: [...d.types],
    level: d.level,
    x: d.x,
    y: d.y,
    hp: d.hp,
    maxHp: d.stats.hp,
    owner: d.ownerId,
    taggedBy: d.wild?.tagOwner ?? null,
    clean: d.clean,
    signature: d.signature,
    statuses: activeStatuses(world, d),
    hardened: (d.wild?.hardenedUntil ?? 0) > world.tick,
    ...(scan ? { scan } : {}),
  };
}

export function toOperatorEntity(op: Operator): Entity {
  return { kind: 'operator', id: op.id, name: op.name, x: op.x, y: op.y };
}

export function toRamDaemon(world: World, d: Daemon): RamDaemon {
  const op = world.operators.get(d.ownerId!)!;
  return {
    id: d.id,
    species: d.species,
    level: d.level,
    xp: d.xp,
    nature: d.nature,
    traitSlot: d.traitSlot,
    ivs: statBlockToArray(d.ivs),
    bonus: statBlockToArray(d.bonus),
    clean: d.clean,
    signature: d.signature,
    hp: d.hp,
    maxHp: d.stats.hp,
    energy: d.energy,
    moves: [...d.moves],
    crashed: d.crashed,
    slot: d.slot,
    cooldowns: Object.fromEntries(Object.entries(d.cooldowns).filter(([, t]) => t > world.tick)),
    heldItem: d.heldItem,
    patched: d.patched,
    moveTypeUses: [...d.moveTypeUses],
    crashes: d.crashes,
    evolutions: evolutionOptions(d, evolutionContext(world, op, d)).map((o) => ({
      form: o.form,
      name: o.name,
      level: o.level,
      hidden: o.hidden,
      revealed: o.revealed,
      met: o.met,
      requirement: o.requirement ? [...o.requirement] : null,
    })),
  };
}

export function toSelf(world: World, op: Operator): OperatorSelf {
  const cap = op.captureId ? world.captures.get(op.captureId) : undefined;
  return {
    id: op.id,
    name: op.name,
    starterClaimed: op.starterClaimed,
    x: op.x,
    y: op.y,
    bits: op.bits,
    diskCapacity: op.diskCapacity,
    tickets: op.tickets
      .filter((t) => !t.pending)
      .map((t) => ({
        id: t.id,
        day: t.day,
        subnet: t.subnet,
        index: t.index,
        kind: t.kind,
        params: t.params,
        target: t.target,
        reward: t.reward,
        progress: t.progress,
        title: ticketBoard(t.subnet, t.day)[t.index]?.title ?? t.kind,
      })),
    ticketsToday: op.ticketsToday,
    research: { ...op.research },
    ram: op.ram.map((id) => toRamDaemon(world, world.daemons.get(id)!)).sort((a, b) => a.slot - b.slot),
    running: [...op.running],
    inventory: { ...op.inventory },
    swapReadyTick: op.swapReadyTick,
    capture: cap ? { captureId: cap.id, targetId: cap.targetId, deadlineTick: cap.deadlineTick } : null,
  };
}

/** Every operator and active daemon within `radius` of (x, y), projected for `viewer` (scans). */
export function entitiesNear(world: World, x: number, y: number, radius = INTEREST_RADIUS, viewer?: Operator): Entity[] {
  const at = { x, y };
  const out: Entity[] = [];
  for (const op of world.operators.values()) if (distance(op, at) <= radius) out.push(toOperatorEntity(op));
  for (const d of world.daemons.values()) if (d.active && distance(d, at) <= radius) out.push(toDaemonEntity(world, d, viewer));
  return out;
}
```

In `apps/sim/src/runtime/game.ts` both `entitiesNear(world, op.x, op.y, this.radius)` calls (snapshot and `stepWorld`) pass the operator as the viewer: `entitiesNear(world, op.x, op.y, this.radius, op)`.

- [ ] **Step 7: Stores**

Replace `apps/sim/src/runtime/store.ts`:

```ts
import { dayKey, getSpecies, ticketKey, type TicketParams } from '@daemonet/rules';
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
    };
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
import { dayKey, getSpecies, ticketKey, type TicketParams } from '@daemonet/rules';
import type { HistoryEntry, Intent, IntentResult, OperatorRecord, OwnedDaemonRecord, Point } from '../core/index.js';
import { randomHex, type IntentContext, type LedgerRow, type Store } from './store.js';

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
    };
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

- [ ] **Step 8: Verify and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green.

```bash
git add packages/db packages/shared packages/sdk packages/sandbox apps/sim apps/api/test
git commit -m "feat(sim): helpdesk tickets with ledger payouts, research points and per-viewer scans"
```

---

### Task 3: API and client

**Files:**
- Modify: `apps/api/src/routes/misc.ts`, `apps/api/test/app.test.ts`
- Modify: `apps/frontend/src/api.ts`, `apps/frontend/src/panels/HostPanel.tsx`, `apps/frontend/src/panels/PlayPanel.tsx`, `apps/frontend/src/panels/CodexPanel.tsx`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/sdk-types.ts`, `apps/frontend/test/host.test.tsx`, `apps/frontend/e2e/smoke.spec.ts`

**Interfaces:**
- `/api/codex` adds `research` (caller) and `hints: [{ formId, kind }]` for hidden, undiscovered forms in lines at ≥ `HINT_RESEARCH = 256`; `GET /api/tickets/board?subnet=` → `{ day, subnet, tickets: TicketDef & { status: 'OPEN' | 'DONE' | 'ABANDONED' | null }[], acceptedToday }` (`tickets: []` for unknown subnets); `GET /api/tickets` → the caller's last 64 rows.
- Client: Host panel **tickets** view (open tickets with progress and abandon; the board with accept; history), `scan` line on the target card, research + scan level per line and `hint: <kind>` under `???` in the Codex trees; `scanLevel(points)` exported from `CodexPanel.tsx`.

- [ ] **Step 1: API tests and routes**

Replace `apps/api/src/routes/misc.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { BESTIARY, ITEMS, MOVES, NATURES, SPECIES, TRAITS, TYPES, dayKey, ticketBoard, ticketKey, typeMultiplier } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { hashToken, randomToken } from '../auth/session.js';

export const TICKET_TTL_MS = 60_000;

export interface DiscoveryRow {
  formId: string;
  operatorId: string;
  operatorName: string | null;
  discoveredAt: Date;
}

/**
 * Static content the client renders (Codex) — served from the same package the sim enforces.
 * Hidden evolution requirements are blanked until someone has discovered the form (SP3a spec §4.3);
 * `discovered` lists every form that has been evolved into at least once.
 */
/** Research points at which a line's hidden branches show the kind of their requirement (design §7.2). */
export const HINT_RESEARCH = 256;

export function codexPayload(discoveries: readonly DiscoveryRow[], research: Readonly<Record<string, number>> = {}) {
  const discovered = new Set(discoveries.map((d) => d.formId));
  const mask = <T extends { id: string; hidden: boolean; requirement: unknown }>(row: T): T =>
    row.hidden && !discovered.has(row.id) ? { ...row, requirement: null } : row;
  const hints = BESTIARY.filter((r) => r.hidden && !discovered.has(r.id) && (research[String(r.line)] ?? 0) >= HINT_RESEARCH && r.requirement).map((r) => ({
    formId: r.id,
    kind: r.requirement![0]!.kind,
  }));
  return {
    types: TYPES,
    chart: Object.fromEntries(TYPES.map((a) => [a, Object.fromEntries(TYPES.map((d) => [d, typeMultiplier(a, [d])]))])),
    species: SPECIES.map(mask),
    bestiary: BESTIARY.map(mask),
    moves: MOVES,
    items: ITEMS,
    natures: NATURES,
    traits: TRAITS,
    discovered: [...discovered],
    discoveries: discoveries.map((d) => ({ formId: d.formId, operatorName: d.operatorName, discoveredAt: d.discoveredAt })),
    research,
    hints,
  };
}

export async function researchFor(prisma: PrismaClient, operatorId: string): Promise<Record<string, number>> {
  const rows = await prisma.research.findMany({ where: { operatorId } });
  return Object.fromEntries(rows.map((r) => [String(r.line), r.points]));
}

export async function listDiscoveries(prisma: PrismaClient): Promise<DiscoveryRow[]> {
  const rows = await prisma.discovery.findMany({ orderBy: { discoveredAt: 'asc' } });
  if (rows.length === 0) return [];
  const ops = await prisma.operator.findMany({ where: { id: { in: rows.map((r) => r.operatorId) } }, select: { id: true, name: true } });
  const names = new Map(ops.map((o) => [o.id, o.name]));
  return rows.map((r) => ({ formId: r.formId, operatorId: r.operatorId, operatorName: names.get(r.operatorId) ?? null, discoveredAt: r.discoveredAt }));
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

  app.get('/api/codex', auth, async (req) => codexPayload(await listDiscoveries(prisma), await researchFor(prisma, req.operator!.id)));

  /** Today's board for a subnet with the caller's accepted flags (the sim generates the same board). */
  app.get<{ Querystring: { subnet?: string } }>('/api/tickets/board', auth, async (req) => {
    const subnet = req.query.subnet ?? 'lo';
    const day = dayKey(new Date().toISOString());
    let board;
    try {
      board = ticketBoard(subnet, day);
    } catch {
      return { day, subnet, tickets: [] };
    }
    const mine = await prisma.ticket.findMany({ where: { operatorId: req.operator!.id, day } });
    const accepted = new Map(mine.map((t) => [ticketKey(t.day, t.subnet, t.index), t.status]));
    return { day, subnet, tickets: board.map((t) => ({ ...t, status: accepted.get(ticketKey(day, subnet, t.index)) ?? null })), acceptedToday: mine.length };
  });

  app.get('/api/tickets', auth, async (req) => {
    const rows = await prisma.ticket.findMany({ where: { operatorId: req.operator!.id }, orderBy: { acceptedAt: 'desc' }, take: 64 });
    return rows.map((t) => ({ id: t.id, day: t.day, subnet: t.subnet, index: t.index, kind: t.kind, params: t.params, target: t.target, reward: t.reward, progress: t.progress, status: t.status, acceptedAt: t.acceptedAt, completedAt: t.completedAt }));
  });

  app.get('/api/disk', auth, async (req) => {
    const rows = await prisma.daemon.findMany({ where: { operatorId: req.operator!.id, location: 'DISK' }, orderBy: { slot: 'asc' } });
    return rows.map((d) => ({
      id: d.id, species: d.species, level: d.level, xp: d.xp, nature: d.nature, traitSlot: d.traitSlot, ivs: d.ivs, bonus: d.bonus,
      clean: d.clean, signature: d.signature, hp: d.hp, energy: d.energy, moves: d.moves, crashed: d.crashed, slot: d.slot,
      heldItem: d.heldItem, patched: d.patched, moveTypeUses: d.moveTypeUses, crashes: d.crashes, history: d.history,
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

Add to `apps/api/test/app.test.ts` before the dev-seeding case:

```ts
  it('codex carries the caller’s research and hints at 256 points; ticket board and history are per operator', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/auth/dev?name=ida' });
    const cookies = { [COOKIE_NAME]: dev.cookies.find((c) => c.name === COOKIE_NAME)!.value };
    const op = await prisma!.operator.findFirstOrThrow({ where: { sub: 'dev-ida' } });
    await prisma!.research.create({ data: { operatorId: op.id, line: 5, points: 256 } });
    const codex = (await app.inject({ method: 'GET', url: '/api/codex', cookies })).json();
    expect(codex.research).toEqual({ '5': 256 });
    expect(codex.hints).toContainEqual({ formId: 'anycastrel', kind: 'dominantIV' });
    for (const h of codex.hints) expect(codex.bestiary.find((r: { id: string }) => r.id === h.formId)).toMatchObject({ line: 5, hidden: true, requirement: null });
    const board = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies })).json();
    expect(board.tickets).toHaveLength(8);
    expect(board.tickets[0]).toMatchObject({ index: 0, kind: 'clear', status: null });
    await prisma!.ticket.create({ data: { id: 't1', operatorId: op.id, day: board.day, subnet: 'lo', index: 0, kind: 'clear', params: board.tickets[0].params, target: 4, reward: 64, progress: 1 } });
    const again = (await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=lo', cookies })).json();
    expect(again.tickets[0].status).toBe('OPEN');
    expect(again.acceptedToday).toBe(1);
    const history = (await app.inject({ method: 'GET', url: '/api/tickets', cookies })).json();
    expect(history).toMatchObject([{ id: 't1', status: 'OPEN', progress: 1 }]);
    expect((await app.inject({ method: 'GET', url: '/api/tickets/board?subnet=nope', cookies })).json().tickets).toEqual([]);
  });
```

- [ ] **Step 2: Client**

Replace `apps/frontend/src/panels/HostPanel.tsx`:

```tsx
import { DISK_MAX, DISK_STEP, RECIPES, SHOP, diskExpansionPrice, getItem, type TypeId } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { useBoardQuery, useLedgerQuery, useTicketHistoryQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { craftCheck, formatBits, fragmentTypes } from '../game/economy.ts';
import { nearHost } from './RamPanel.tsx';

const VIEWS = ['tickets', 'shop', 'craft', 'ledger'] as const;
type View = (typeof VIEWS)[number];

/** Everything that happens at a host node: the NPC shop, Disk expansion, crafting, and the bits ledger. */
export function HostPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = nearHost(client.subnet, me);
  const [view, setView] = useState<View>('tickets');
  const [qty, setQty] = useState(1);
  const [using, setUsing] = useState<TypeId | ''>('');
  const ledger = useLedgerQuery(undefined, { skip: view !== 'ledger' });
  const board = useBoardQuery(client.subnet, { skip: view !== 'tickets' });
  const history = useTicketHistoryQuery(undefined, { skip: view !== 'tickets' });
  const diskPrice = diskExpansionPrice(me.diskCapacity);
  const can = manual && atHost;
  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-neutral-500" data-testid="host-status">
        {atHost ? 'at the host' : 'walk to the host node to trade'} · {me.bits} bits ({formatBits(me.bits)}) · Disk {me.diskCapacity}
      </p>
      <nav className="flex gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`host-${v}`}>
            {v}
          </button>
        ))}
        <label className="ml-auto text-neutral-500">
          qty
          <input className="ml-1 w-12 rounded bg-neutral-800 px-1" type="number" min={1} max={64} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} data-testid="qty" />
        </label>
      </nav>

      {view === 'tickets' && (
        <section className="space-y-2" data-testid="tickets">
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">open ({me.tickets.length}/2) · accepted today {me.ticketsToday}/8</h3>
            {me.tickets.length === 0 && <p className="text-xs text-neutral-500">no open tickets</p>}
            {me.tickets.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1" data-testid={`ticket-${t.id}`}>
                <span>
                  {t.title} <span className="mono text-xs text-neutral-500">{t.progress}/{t.target} · {t.reward} bits</span>
                </span>
                <button className="text-xs text-neutral-400 hover:text-white disabled:opacity-40" disabled={!manual} onClick={() => run(client.operator.abandonTicket(t.id), 'abandonTicket')}>
                  abandon
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
              board · {client.subnet} · {board.data?.day ?? '…'}{' '}
              <button className="underline" onClick={() => void board.refetch()}>
                refresh
              </button>
            </h3>
            {board.data?.tickets.map((t) => (
              <div key={t.index} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1" data-testid={`board-${t.index}`}>
                <span className={t.status ? 'text-neutral-500' : ''}>
                  {t.title} <span className="mono text-xs text-neutral-500">{t.reward} bits{t.status ? ` · ${t.status.toLowerCase()}` : ''}</span>
                </span>
                <button
                  className="rounded bg-amber-800 px-2 py-0.5 hover:bg-amber-700 disabled:opacity-40"
                  disabled={!can || t.status !== null || me.tickets.length >= 2 || me.ticketsToday >= 8}
                  onClick={() => run(client.operator.acceptTicket(t.index, client.subnet, board.data!.day).then(() => board.refetch()), 'acceptTicket')}
                  data-testid={`accept-${t.index}`}
                >
                  accept
                </button>
              </div>
            ))}
          </div>
          {history.data && history.data.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-neutral-500">history ({history.data.length})</summary>
              <div className="mono text-xs">
                {history.data.map((h) => (
                  <div key={h.id} className="flex justify-between border-b border-neutral-900 py-0.5">
                    <span className="text-neutral-500">{h.day}</span>
                    <span>
                      {h.subnet} #{h.index} {h.kind}
                    </span>
                    <span className={h.status === 'DONE' ? 'text-emerald-300' : 'text-neutral-400'}>
                      {h.status.toLowerCase()} {h.progress}/{h.target}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {view === 'shop' && (
        <section className="space-y-1" data-testid="shop">
          {Object.entries(SHOP).map(([id, price]) => (
            <div key={id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
              <span>
                {getItem(id).name} <span className="mono text-xs text-neutral-500">×{me.inventory[id] ?? 0}</span>
              </span>
              <button
                className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
                disabled={!can || me.bits < price * qty}
                onClick={() => run(client.operator.buy(id, qty), 'buy')}
                data-testid={`buy-${id}`}
              >
                buy {qty > 1 ? `×${qty} ` : ''}for {price * qty}
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1">
            <span>
              Disk expansion <span className="mono text-xs text-neutral-500">+{DISK_STEP} slots (max {DISK_MAX})</span>
            </span>
            <button
              className="rounded bg-sky-800 px-2 py-0.5 hover:bg-sky-700 disabled:opacity-40"
              disabled={!can || diskPrice === null || me.bits < diskPrice}
              onClick={() => run(client.operator.buy('diskExpansion', 1), 'buy')}
              data-testid="buy-diskExpansion"
            >
              {diskPrice === null ? 'maxed' : `buy for ${diskPrice}`}
            </button>
          </div>
        </section>
      )}

      {view === 'craft' && (
        <section className="space-y-1" data-testid="craft">
          <label className="text-xs text-neutral-500">
            fragment type for “any” recipes
            <select className="ml-1 rounded bg-neutral-800 px-1" value={using} onChange={(e) => setUsing(e.target.value as TypeId | '')} data-testid="using">
              <option value="">—</option>
              {fragmentTypes(me.inventory).map((t) => (
                <option key={t} value={t}>
                  {t} ×{me.inventory[`frag:${t}`]}
                </option>
              ))}
            </select>
          </label>
          {RECIPES.map((r) => {
            const check = craftCheck(r, qty, me.inventory, me.bits, using || undefined);
            return (
              <div key={r.id} className="rounded border border-neutral-800 px-2 py-1" data-testid={`recipe-${r.id}`}>
                <div className="flex items-center justify-between">
                  <span>
                    {getItem(r.output.item).name}
                    {r.output.qty > 1 ? ` ×${r.output.qty}` : ''} <span className="mono text-xs text-neutral-500">×{me.inventory[r.output.item] ?? 0}</span>
                  </span>
                  <button
                    className="rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
                    disabled={!can || !check.ok}
                    onClick={() => run(client.operator.craft(r.id, qty, using || undefined), 'craft')}
                    data-testid={`craft-${r.id}`}
                  >
                    craft for {check.bits}
                  </button>
                </div>
                <div className="mono text-xs text-neutral-500">
                  {check.needsType && 'pick a fragment type · '}
                  {check.needs.map((n) => (
                    <span key={n.item} className={n.have >= n.need ? 'text-neutral-400' : 'text-red-400'}>
                      {n.item.slice(5)} {n.have}/{n.need}{' '}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {view === 'ledger' && (
        <section className="mono text-xs" data-testid="ledger">
          {ledger.data?.length === 0 && <p className="text-neutral-500">no bits have moved yet</p>}
          {ledger.data?.map((l, i) => (
            <div key={i} className="flex justify-between border-b border-neutral-900 py-0.5">
              <span className="text-neutral-500">{new Date(l.at).toLocaleString()}</span>
              <span>{l.reason}</span>
              <span className={l.delta >= 0 ? 'text-emerald-300' : 'text-red-300'}>{l.delta >= 0 ? '+' : ''}{l.delta}</span>
            </div>
          ))}
          <button className="mt-1 text-neutral-500 underline" onClick={() => ledger.refetch()}>
            refresh
          </button>
        </section>
      )}
    </div>
  );
}
```

Replace `apps/frontend/src/panels/CodexPanel.tsx`:

```tsx
import { STAT_KEYS, type BestiaryRow } from '@daemonet/rules';
import { useState } from 'react';
import { useCodexQuery, type Codex } from '../api.ts';
import { describeBranch } from '../game/requirements.ts';
import { SpriteImg } from './RamPanel.tsx';

export function ItemsPanel({ inventory }: { inventory: Record<string, number> }) {
  const entries = Object.entries(inventory).filter(([, n]) => n > 0);
  return (
    <div className="p-3 text-sm">
      {entries.length === 0 && <p className="text-neutral-500">no items</p>}
      <ul className="space-y-1">
        {entries.map(([id, n]) => (
          <li key={id} className="mono flex justify-between rounded border border-neutral-800 px-2 py-1">
            <span>{id}</span>
            <span className="text-neutral-400">×{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIEWS = ['trees', 'species', 'moves', 'chart', 'traits', 'items'] as const;

/** What research on a line currently reveals about its wild daemons (design §7.2). */
export function scanLevel(points: number): string {
  if (points >= 256) return 'IVs + hidden-branch hints';
  if (points >= 64) return 'exact IVs';
  if (points >= 16) return 'IV buckets';
  if (points >= 4) return 'nature';
  return 'none (4 captures for nature)';
}
type View = (typeof VIEWS)[number];

/** One evolution tree node: the form, its branch text, and a mark once anyone has evolved into it. */
function TreeNode({ row, rows, codex }: { row: BestiaryRow; rows: BestiaryRow[]; codex: Codex }) {
  const children = rows.filter((r) => r.evolvesFrom === row.id);
  const found = codex.discoveries.find((d) => d.formId === row.id);
  const discovered = row.evolvesFrom === null || found !== undefined;
  const hint = codex.hints.find((h) => h.formId === row.id);
  return (
    <li>
      <div className={`flex items-center gap-1 ${discovered ? '' : 'text-neutral-500'}`} data-testid={`tree-${row.id}`}>
        <SpriteImg species={row.id} types={row.types} clean={false} signature={0} size={16} />
        <span className={discovered ? 'font-medium' : ''}>{row.name}</span>
        {row.evolvesFrom !== null && <span className="mono text-xs text-neutral-500">{describeBranch(row.evolvesAt ?? 0, row.requirement, row.hidden)}</span>}
        {hint && row.requirement === null && (
          <span className="mono text-xs text-amber-300" title="research hint">
            hint: {hint.kind}
          </span>
        )}
        {found && (
          <span className="text-emerald-400" title={`first evolved by ${found.operatorName ?? 'an operator'} on ${new Date(found.discoveredAt).toLocaleDateString()}`}>
            ✓
          </span>
        )}
        {row.capstone && <span className="text-fuchsia-300">capstone</span>}
      </div>
      {children.length > 0 && (
        <ul className="ml-4 border-l border-neutral-800 pl-2">
          {children.map((c) => (
            <TreeNode key={c.id} row={c} rows={rows} codex={codex} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CodexPanel() {
  const codex = useCodexQuery();
  const [view, setView] = useState<View>('trees');
  if (!codex.data) return <p className="p-3 text-sm text-neutral-500">loading codex…</p>;
  const data = codex.data;
  const { species, moves, chart, types, traits, items, bestiary } = data;
  const lines = [...new Set(bestiary.map((r) => r.line))].sort((a, b) => a - b);
  return (
    <div className="space-y-3 p-3 text-sm">
      <nav className="flex flex-wrap gap-1 text-xs">
        {VIEWS.map((v) => (
          <button key={v} className={`rounded px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setView(v)} data-testid={`codex-${v}`}>
            {v}
          </button>
        ))}
        <button className="ml-auto text-neutral-500 underline" onClick={() => codex.refetch()}>
          refresh
        </button>
      </nav>

      {view === 'trees' && (
        <section className="space-y-2">
          <p className="text-xs text-neutral-500">
            {data.discovered.length} of {bestiary.filter((r) => r.evolvesFrom !== null).length} evolutions discovered · hidden requirements show as ??? until someone meets them
          </p>
          {lines.map((line) => {
            const rows = bestiary.filter((r) => r.line === line);
            const root = rows.find((r) => r.evolvesFrom === null)!;
            return (
              <ul key={line} className="rounded border border-neutral-800 p-2" data-testid={`line-${line}`}>
                <TreeNode row={root} rows={rows} codex={data} />
                <li className="mono mt-1 text-xs text-neutral-500">research {data.research[String(line)] ?? 0} · scans: {scanLevel(data.research[String(line)] ?? 0)}</li>
              </ul>
            );
          })}
        </section>
      )}

      {view === 'species' && (
        <section>
          {species.map((s) => (
            <div key={s.id} className="mb-1 flex gap-2 rounded border border-neutral-800 p-2">
              <SpriteImg species={s.id} types={s.types} clean={false} signature={0} />
              <div>
                <div>
                  <span className="font-medium">{s.name}</span>{' '}
                  <span className="text-neutral-500">
                    {s.types.join('/')} · {s.role} · {s.behaviour}
                    {s.starter ? ' · starter' : ''} · traits {s.traits.join(' / ')}
                  </span>
                </div>
                <div className="mono text-xs text-neutral-500">{STAT_KEYS.map((k) => `${k.slice(0, 3)} ${s.base[k]}`).join(' · ')}</div>
                <div className="mono text-xs text-neutral-500">{s.learnset.map((l) => `L${l.level} ${l.move}`).join(', ')}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      {view === 'moves' && (
        <section>
          <table className="mono w-full text-xs">
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-b border-neutral-900">
                  <td className="py-0.5">{m.name}</td>
                  <td className="text-neutral-500">{m.type}</td>
                  <td className="text-neutral-500">{m.category}</td>
                  <td className="text-right">{m.power}</td>
                  <td className="text-right text-neutral-500">{m.energyCost}en</td>
                  <td className="text-right text-neutral-500">{m.cooldownMs}ms</td>
                  <td className="text-right text-neutral-500">r{m.range}</td>
                  <td className="text-neutral-500">{m.status ? `${m.status.id} ${Math.round(m.status.chance * 100)}%` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'chart' && (
        <section>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">type chart (attacker ↓ · defender →)</h3>
          <table className="mono text-[10px]" data-testid="type-chart">
            <thead>
              <tr>
                <th />
                {types.map((t) => (
                  <th key={t} className="px-0.5 text-neutral-500">{t.slice(0, 3)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {types.map((a) => (
                <tr key={a}>
                  <td className="pr-1 text-neutral-500">{a}</td>
                  {types.map((d) => {
                    const m = chart[a]?.[d] ?? 1;
                    const tone = m === 0 ? 'text-neutral-600' : m > 1 ? 'text-emerald-300' : m < 1 ? 'text-red-300' : 'text-neutral-500';
                    return (
                      <td key={d} className={`px-0.5 text-center ${tone}`}>{m}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'traits' && (
        <section className="space-y-1">
          {traits.map((t) => (
            <div key={t.id} className="rounded border border-neutral-800 p-2">
              <span className="font-medium">{t.name}</span> <span className="mono text-xs text-neutral-500">{t.id}</span>
              <div className="text-xs text-neutral-400">{t.description}</div>
            </div>
          ))}
        </section>
      )}

      {view === 'items' && (
        <section className="space-y-1">
          {items.map((i) => (
            <div key={i.id} className="flex justify-between rounded border border-neutral-800 px-2 py-1">
              <span>
                {i.name} <span className="mono text-xs text-neutral-500">{i.id}</span>
              </span>
              <span className="text-xs text-neutral-400">
                {i.kind}
                {i.kind === 'held' ? ` · ${i.effect} ×${i.multiplier}` : ''}
                {i.kind === 'evolution' ? ` · ${i.type}` : ''}
                {i.kind === 'tool' ? ` · range ${i.range} · ${i.deadlineMs} ms` : ''}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
```

In `apps/frontend/src/api.ts` add the types and endpoints:

```ts
  /** The caller's research points per bestiary line. */
  research: Record<string, number>;
  /** Requirement kinds of hidden branches in lines researched to 256. */
  hints: Array<{ formId: string; kind: string }>;
```

(on `Codex`), plus

```ts
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
```

and the endpoints

```ts
    board: b.query<{ day: string; subnet: string; tickets: BoardTicket[]; acceptedToday: number }, string>({ query: (subnet) => `/tickets/board?subnet=${encodeURIComponent(subnet)}` }),
    ticketHistory: b.query<TicketHistory[], void>({ query: () => '/tickets' }),
```

exporting `useBoardQuery` and `useTicketHistoryQuery`.

In `apps/frontend/src/panels/PlayPanel.tsx` import `NATURES, STAT_KEYS` from `@daemonet/rules` and render under the target's hp line:

```tsx
            {target.scan && (
              <div className="mono text-xs text-sky-300" data-testid="scan">
                {target.scan.nature !== undefined && <span>nature {NATURES[target.scan.nature]?.id ?? target.scan.nature} </span>}
                {target.scan.ivs
                  ? STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${target.scan!.ivs![i]}`).join(' ')
                  : target.scan.ivBuckets && STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${['0-7', '8-15', '16-23', '24-31'][target.scan!.ivBuckets![i]!]}`).join(' ')}
              </div>
            )}
```

In `apps/frontend/src/game/connection.ts` after the `decompiled` handler:

```ts
    client.on('ticketProgress', (e) => log.push('event', `ticket ${e.ticketId}: ${e.progress}/${e.target}`));
    client.on('ticketDone', (e) => log.push('event', `ticket ${e.ticketId} done: +${e.reward} bits`));
```

In `apps/frontend/src/sdk-types.ts`: `DaemonView` gains `scan?: { nature?: number; ivBuckets?: number[]; ivs?: number[] };`, add `OpenTicket` and `TicketDef` interfaces, `OperatorSelf` gains `tickets: OpenTicket[]; ticketsToday: number; research: Record<string, number>;`, `WorldView` gains `readonly tickets: TicketDef[]`, `OperatorApi` gains `acceptTicket(index: number, subnet?: string, day?: string): Promise<unknown>; abandonTicket(ticketId: string): Promise<unknown>;`, and `on` gains the `'ticketProgress'` / `'ticketDone'` overloads.

Unit test — add to `apps/frontend/test/host.test.tsx` (importing `scanLevel` from `../src/panels/CodexPanel.tsx`):

```ts
describe('scanLevel', () => {
  it('names what each research tier reveals', () => {
    expect(scanLevel(0)).toContain('none');
    expect(scanLevel(4)).toBe('nature');
    expect(scanLevel(16)).toBe('IV buckets');
    expect(scanLevel(64)).toBe('exact IVs');
    expect(scanLevel(256)).toContain('hints');
  });
});
```

- [ ] **Step 3: End-to-end**

The Host panel now opens on **tickets**, so the plan-2 scenario selects the shop first: insert `await page.getByTestId('host-shop').click();` right before `await page.getByTestId('buy-tap').click();`. Then append to that scenario (after the craft assertions):

```ts
  // tickets: accept the first (always a tool-free clear ticket on lo), see it open, abandon it
  await page.getByTestId('tab-host').click();
  await page.getByTestId('host-tickets').click();
  await expect(page.getByTestId('board-0')).toContainText('Clear', { timeout: 10_000 });
  await page.getByTestId('accept-0').click();
  await expect(page.getByTestId('tickets')).toContainText('open (1/2) · accepted today 1/8', { timeout: 10_000 });
  await expect(page.getByTestId('board-0')).toContainText('open');
  await page.getByRole('button', { name: 'abandon' }).click();
  await expect(page.getByTestId('tickets')).toContainText('open (0/2) · accepted today 1/8', { timeout: 10_000 });
```

- [ ] **Step 4: Verify and commit**

`pnpm exec tsc -b && pnpm --filter @daemonet/frontend exec tsc -p tsconfig.json && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 35 files, 331 tests. Build, start the stack and run `playwright test` — 3 passed.

```bash
git add apps/api apps/frontend
git commit -m "feat: ticket board and history API, codex research and hints, tickets / scans in the client"
```

---

## Self-review

- **Spec coverage:** §7 `Ticket` table and unique key, deterministic boards with the `lo` guarantee, kinds and rewards, accept limits (8/day, 2 open, today only, at the host), abandon, progress hooks (defeats, captures, arrival, evolutions), `completeTicket` through the ledger, `OperatorSelf.tickets` / `ticketsToday`, `/api/tickets/board` and `/api/tickets`, host panel view (Tasks 1–3); §8 `Research` rows incremented per capture, `OperatorSelf.research`, scan levels 4 / 16 / 64 per viewer, `/api/codex` research + hints, Codex display (Tasks 2–3).
- **Type consistency:** `TicketParams` is defined once in rules and used by the protocol (`params: unknown` on the wire), the model, both stores and the client; `ticketKind` on the intent avoids clashing with the intent discriminator `kind`.
- **Placeholders:** none.
