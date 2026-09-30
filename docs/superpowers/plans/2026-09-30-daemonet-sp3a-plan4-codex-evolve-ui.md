# Daemonet SP3a · Plan 4 — Codex API, discoveries and the evolve UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can see and drive evolution from the web client: `/api/codex` serves the bestiary with hidden, undiscovered requirements blanked plus the server-wide discovery list; the RAM card shows every evolution branch (requirement text or `???`, an **evolve** button once met), a held-item slot and the `patched` / crash counters; the Codex gets a **trees** view over all 50 lines with discovery marks, the full 16×16 type chart, trait effect text and the item list; a dev-only seeding route lets the e2e evolve a level-8 daemon end to end.

**Architecture:** The API masks requirements server-side (`codexPayload(discoveries)`), so the client never receives a hidden requirement it should not show; the sim already does the same on `RamDaemon.evolutions`. The client adds one pure module (`game/requirements.ts`: requirement → text) and one presentational component file (`panels/EvolveSection.tsx`: `EvolveSection`, `HeldSlot`) that take plain data and callbacks — unit-tested under jsdom with Testing Library — and wires them into `RamPanel`. `CodexPanel` becomes a small tabbed view (trees / species / moves / chart / traits / items); the tree is a recursive walk over the bestiary rows of each line.

**Tech Stack:** as before, plus jsdom + `@testing-library/react` (already devDependencies of `apps/frontend`) for `.test.tsx` files under the root Vitest config.

**Prerequisites:** SP3a plans 1–3 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3a-daemon-depth-design.md` §4.3, §8 (client and API bullets), §9 (api / client testing).

## Global Constraints

- Everything from the earlier plans.
- No player-facing links to the GitHub repository or issues.
- Hidden requirements never leave the server undiscovered: the API blanks them in both `species` and `bestiary`; the client only renders what it receives.
- The dev seeding route exists only under `AUTH_DEV_BYPASS=true` (the same guard as `/api/auth/dev`; refused in production by `loadConfig`).

## File map

```
apps/api/src/routes/misc.ts                codexPayload(discoveries), listDiscoveries, /api/disk extras
apps/api/src/auth/dev-bypass.ts            POST /api/dev/daemon { species, level } → Disk row
apps/api/test/app.test.ts                  codex masking / discoveries, dev seeding
apps/frontend/src/game/requirements.ts     describeRequirement, describeBranch
apps/frontend/src/panels/EvolveSection.tsx EvolveSection, HeldSlot
apps/frontend/src/panels/RamPanel.tsx      held slot, evolve section, patched / trait / crashes
apps/frontend/src/panels/CodexPanel.tsx    trees · species · moves · chart · traits · items
apps/frontend/src/api.ts, types.ts         Codex + DiskDaemon types, 'Codex' tag
apps/frontend/src/game/connection.ts       evolved / discovery log lines
apps/frontend/src/panels/DiskPanel.tsx     patched / held badges
apps/frontend/test/evolve.test.tsx         jsdom unit tests
apps/frontend/e2e/smoke.spec.ts            seed → load → evolve → codex ✓
vitest.config.ts                           include *.test.tsx
```

---

### Task 1: Codex API — masked requirements, discoveries, Disk extras, dev seeding

**Files:**
- Modify: `apps/api/src/routes/misc.ts`, `apps/api/src/auth/dev-bypass.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- `codexPayload(discoveries: DiscoveryRow[])` → previous payload + `bestiary: BestiaryRow[]` (masked), `species` (masked), `discovered: string[]`, `discoveries: [{ formId, operatorName, discoveredAt }]`. `DiscoveryRow { formId; operatorId; operatorName; discoveredAt }`; `listDiscoveries(prisma)`.
- `GET /api/disk` rows gain `heldItem, patched, moveTypeUses, crashes, history`.
- `POST /api/dev/daemon` (session + CSRF header, dev bypass only) body `{ species, level }` → `{ id, species, level, slot }`; 400 on bad body / unknown species / full Disk.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/app.test.ts`, add `"Discovery"` to the `beforeEach` truncation:

```ts
    await prisma!.$executeRawUnsafe('TRUNCATE "ScriptVersion", "Script", "WsTicket", "Session", "Daemon", "Operator", "SubnetSeed", "AppliedAction", "Discovery" CASCADE');
```

and append two cases at the end of the `API (needs DATABASE_URL)` describe:

```ts
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
    const seeded = await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'pingling', level: 8 } });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json()).toMatchObject({ species: 'pingling', level: 8, slot: 0 });
    const disk = (await app.inject({ method: 'GET', url: '/api/disk', cookies })).json();
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({ species: 'pingling', level: 8, slot: 0, heldItem: null, patched: false, crashes: 0 });
    expect(disk[0].history[0]).toMatchObject({ kind: 'captured', detail: 'dev seed' });
    const bad = await app.inject({ method: 'POST', url: '/api/dev/daemon', cookies, headers: csrf, payload: { species: 'nope', level: 8 } });
    expect(bad.statusCode).toBe(400);
  });
```

Run: `DATABASE_URL=... pnpm exec vitest run apps/api` — expected: the two new cases fail (no `bestiary`, 404 on the dev route).

- [ ] **Step 2: Routes**

Replace `apps/api/src/routes/misc.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { BESTIARY, ITEMS, MOVES, NATURES, SPECIES, TRAITS, TYPES, typeMultiplier } from '@daemonet/rules';
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
export function codexPayload(discoveries: readonly DiscoveryRow[]) {
  const discovered = new Set(discoveries.map((d) => d.formId));
  const mask = <T extends { id: string; hidden: boolean; requirement: unknown }>(row: T): T =>
    row.hidden && !discovered.has(row.id) ? { ...row, requirement: null } : row;
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
  };
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

  app.get('/api/codex', auth, async () => codexPayload(await listDiscoveries(prisma)));

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

Replace `apps/api/src/auth/dev-bypass.ts`:

```ts
import type { PrismaClient } from '@daemonet/db';
import { DISK_SLOTS, LO, computeStats, emptyMoveTypeUses, getSpecies, movesAtLevel, rollSpawn, createRng, statBlockToArray, xpForLevel } from '@daemonet/rules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { ensureOperator } from './routes.js';
import type { SessionStore } from './session.js';

const SeedBody = z.object({ species: z.string().min(1).max(32), level: z.number().int().min(1).max(64) });

/**
 * Development only (AUTH_DEV_BYPASS=true, refused in production): GET /api/auth/dev?name=alice
 * creates a session for sub `dev-alice` — the same sub the sim's dev verifier uses, so the
 * browser and a `dev:alice` bot share one operator. POST /api/dev/daemon { species, level } puts a
 * daemon of that species on the caller's Disk (tests load it into RAM at the host, e.g. to evolve it).
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

  app.post('/api/dev/daemon', { preHandler: app.requireAuth }, async (req) => {
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('body must be { species, level 1-64 }');
    let species;
    try {
      species = getSpecies(parsed.data.species);
    } catch {
      throw badRequest('unknown species');
    }
    const operatorId = req.operator!.id;
    const used = new Set((await deps.prisma.daemon.findMany({ where: { operatorId, location: 'DISK' }, select: { slot: true } })).map((d) => d.slot));
    let slot = 0;
    while (used.has(slot) && slot < DISK_SLOTS) slot++;
    if (slot >= DISK_SLOTS) throw badRequest('Disk is full');
    const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roll = rollSpawn(createRng(id), { clean: 0, signatureStep: 0 });
    const level = parsed.data.level;
    const row = await deps.prisma.daemon.create({
      data: {
        id, operatorId, species: species.id, level, xp: xpForLevel(level), nature: roll.nature, traitSlot: roll.traitSlot,
        ivs: statBlockToArray(roll.ivs), bonus: statBlockToArray(roll.bonus), clean: false, signature: 0,
        hp: computeStats({ base: species.base, ivs: roll.ivs, bonus: roll.bonus, level, nature: roll.nature }).hp, energy: 128,
        moves: movesAtLevel(species, level), crashed: false, location: 'DISK', slot, moveTypeUses: emptyMoveTypeUses(),
        history: [{ at: new Date().toISOString(), kind: 'captured', detail: 'dev seed' }],
        originalOperatorId: operatorId, capturedAt: new Date(), captureSubnet: LO.id, captureTool: 'dev', spawnSeedId: 'dev', spawnIndex: null,
      },
    });
    return { id: row.id, species: row.species, level: row.level, slot: row.slot };
  });
}
```

- [ ] **Step 3: Verify**

Run: `pnpm exec tsc -b apps/api && DATABASE_URL=... pnpm exec vitest run apps/api` — expected: green (276 tests repo-wide).

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): codex masks undiscovered hidden requirements, lists discoveries; dev daemon seeding"
```

---

### Task 2: Client — requirement text, evolve section, held slot, Codex trees

**Files:**
- Create: `apps/frontend/src/game/requirements.ts`, `apps/frontend/src/panels/EvolveSection.tsx`, `apps/frontend/test/evolve.test.tsx`
- Modify: `apps/frontend/src/panels/RamPanel.tsx`, `apps/frontend/src/panels/CodexPanel.tsx`, `apps/frontend/src/api.ts`, `apps/frontend/src/types.ts`, `apps/frontend/src/game/connection.ts`, `apps/frontend/src/panels/DiskPanel.tsx`, `vitest.config.ts`

**Interfaces:**
- `describeRequirement(r: Requirement): string`; `describeBranch(level, requirement: unknown[] | null, hidden): string` → `L16 · hold Jumbo Frame`, `L32 · ???`, `L16`.
- `EvolveSection({ daemon: RamDaemon, disabled, onEvolve(formId) })` renders `data-testid="evolve-<slot>"` and one button per branch `evolve-<slot>-<form>` (enabled when `met && !disabled`).
- `HeldSlot({ daemon, inventory, disabled, onHold(itemId), onUnhold() })` renders `held-<slot>` and a `<select data-testid="hold-<slot>">` over holdable inventory items.
- `Codex` (api.ts) gains `bestiary`, `discovered`, `discoveries`; `DiskDaemon` gains `heldItem, patched, crashes, history`; the query carries the `'Codex'` tag.
- RAM card: `data-testid="ram-<slot>-name"` on the species name.

- [ ] **Step 1: Let Vitest see `.test.tsx` files**

In `vitest.config.ts` change the include to

```ts
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
```

- [ ] **Step 2: Write the failing tests**

Create `apps/frontend/test/evolve.test.tsx` (the `// @vitest-environment jsdom` pragma switches this file to jsdom; `cleanup` after each test because Vitest runs without globals):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeBranch, describeRequirement } from '../src/game/requirements.ts';
import { EvolveSection, HeldSlot } from '../src/panels/EvolveSection.tsx';

const daemon = {
  id: 'd1', species: 'echolet', level: 16, xp: 0, nature: 0, traitSlot: 0 as const, ivs: [20, 20, 20, 20, 20, 20, 20, 20], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
  clean: false, signature: 0, hp: 50, maxHp: 50, energy: 128, moves: ['ping'], crashed: false, slot: 2, cooldowns: {},
  heldItem: null, patched: false, moveTypeUses: Array(16).fill(0) as number[], crashes: 0,
  evolutions: [
    { form: 'tracerat', name: 'Tracerat', level: 16, hidden: false, revealed: true, met: true, requirement: [] },
    { form: 'broadcaw', name: 'Broadcaw', level: 16, hidden: false, revealed: true, met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] },
    { form: 'mystery', name: 'Mystery', level: 32, hidden: true, revealed: false, met: false, requirement: null },
  ],
};

afterEach(cleanup);

describe('requirement text', () => {
  it('describes every requirement kind', () => {
    expect(describeRequirement({ kind: 'heldItem', item: 'jumboframe' })).toBe('hold Jumbo Frame');
    expect(describeRequirement({ kind: 'dominantIV', stat: 'speed' })).toBe('highest IV: speed');
    expect(describeRequirement({ kind: 'moveTypeUses', type: 'packet', count: 4096 })).toBe('4096 packet move uses');
    expect(describeRequirement({ kind: 'subnet', subnet: 'darknet' })).toBe('evolve in darknet');
    expect(describeRequirement({ kind: 'clean' })).toBe('clean image');
    expect(describeRequirement({ kind: 'signature', min: 2 })).toBe('signature T2+');
    expect(describeRequirement({ kind: 'originalOperator' })).toBe('with its original operator');
    expect(describeRequirement({ kind: 'crashes', op: 'max', count: 0 })).toBe('at most 0 crashes');
    expect(describeRequirement({ kind: 'crashes', op: 'min', count: 8 })).toBe('at least 8 crashes');
    expect(describeRequirement({ kind: 'arenaWins', count: 16 })).toBe('16 arena wins');
    expect(describeRequirement({ kind: 'unobserved' })).toBe('with no other operator nearby');
  });

  it('formats a branch with its level, ??? while hidden and undiscovered', () => {
    expect(describeBranch(16, [], false)).toBe('L16');
    expect(describeBranch(16, [{ kind: 'heldItem', item: 'jumboframe' }], false)).toBe('L16 · hold Jumbo Frame');
    expect(describeBranch(32, null, true)).toBe('L32 · ???');
    expect(describeBranch(32, null, false)).toBe('L32');
  });
});

describe('EvolveSection', () => {
  it('lists the branches, enables evolve only for met ones, and reports the chosen form', () => {
    const onEvolve = vi.fn();
    render(<EvolveSection daemon={daemon} disabled={false} onEvolve={onEvolve} />);
    expect(screen.getByText('Tracerat')).toBeTruthy();
    expect(screen.getByText('L16 · hold Jumbo Frame')).toBeTruthy();
    expect(screen.getByText('L32 · ???')).toBeTruthy();
    const ready = screen.getByTestId('evolve-2-tracerat') as HTMLButtonElement;
    const blocked = screen.getByTestId('evolve-2-broadcaw') as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    expect(blocked.disabled).toBe(true);
    fireEvent.click(ready);
    expect(onEvolve).toHaveBeenCalledWith('tracerat');
  });

  it('disables everything while the daemon is running', () => {
    render(<EvolveSection daemon={daemon} disabled={true} onEvolve={() => {}} />);
    expect((screen.getByTestId('evolve-2-tracerat') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('HeldSlot', () => {
  it('offers only holdable inventory items and unhold when something is held', () => {
    const onHold = vi.fn();
    const onUnhold = vi.fn();
    const { rerender } = render(<HeldSlot daemon={daemon} inventory={{ jumboframe: 1, restore: 2, amplifier: 0 }} disabled={false} onHold={onHold} onUnhold={onUnhold} />);
    const select = screen.getByTestId('hold-2') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'jumboframe']);
    fireEvent.change(select, { target: { value: 'jumboframe' } });
    expect(onHold).toHaveBeenCalledWith('jumboframe');
    rerender(<HeldSlot daemon={{ ...daemon, heldItem: 'jumboframe' }} inventory={{}} disabled={false} onHold={onHold} onUnhold={onUnhold} />);
    expect(screen.getByTestId('held-2').textContent).toContain('held: jumboframe');
    fireEvent.click(screen.getByText('unhold'));
    expect(onUnhold).toHaveBeenCalled();
  });
});
```

Run: `pnpm exec vitest run apps/frontend` — expected: fails to import the two new modules.

- [ ] **Step 3: Requirement text**

Create `apps/frontend/src/game/requirements.ts`:

```ts
import { getItem, type Requirement } from '@daemonet/rules';

function itemName(id: string): string {
  try {
    return getItem(id).name;
  } catch {
    return id;
  }
}

/** One requirement as the Codex and the RAM card show it. */
export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case 'heldItem':
      return `hold ${itemName(r.item)}`;
    case 'dominantIV':
      return `highest IV: ${r.stat}`;
    case 'moveTypeUses':
      return `${r.count} ${r.type} move uses`;
    case 'subnet':
      return `evolve in ${r.subnet}`;
    case 'clean':
      return 'clean image';
    case 'signature':
      return `signature T${r.min}+`;
    case 'originalOperator':
      return 'with its original operator';
    case 'crashes':
      return r.op === 'max' ? `at most ${r.count} crashes` : `at least ${r.count} crashes`;
    case 'arenaWins':
      return `${r.count} arena wins`;
    case 'unobserved':
      return 'with no other operator nearby';
  }
}

/**
 * `L16 · hold Jumbo Frame` — the level, then each requirement; `???` while a hidden requirement is
 * undiscovered (`requirement === null` with `hidden`). Level-only branches read just `L16`.
 */
export function describeBranch(level: number, requirement: readonly unknown[] | null, hidden: boolean): string {
  const parts = [`L${level}`];
  if (requirement === null) {
    if (hidden) parts.push('???');
  } else parts.push(...(requirement as Requirement[]).map(describeRequirement));
  return parts.join(' · ');
}
```

- [ ] **Step 4: Evolve section and held slot**

Create `apps/frontend/src/panels/EvolveSection.tsx`:

```tsx
import { isHoldable } from '@daemonet/rules';
import type { RamDaemon } from '@daemonet/shared';
import { describeBranch } from '../game/requirements.ts';

/** The RAM card's evolution list: every branch with its requirements; `evolve` enabled once met. */
export function EvolveSection({ daemon, disabled, onEvolve }: { daemon: RamDaemon; disabled: boolean; onEvolve: (formId: string) => void }) {
  if (daemon.evolutions.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs" data-testid={`evolve-${daemon.slot}`}>
      {daemon.evolutions.map((o) => (
        <div key={o.form} className="flex items-center gap-2">
          <span className={o.met ? 'text-emerald-300' : 'text-neutral-400'}>{o.name}</span>
          <span className="mono text-neutral-500">{describeBranch(o.level, o.requirement, o.hidden)}</span>
          <button
            className="ml-auto rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
            disabled={disabled || !o.met}
            onClick={() => onEvolve(o.form)}
            data-testid={`evolve-${daemon.slot}-${o.form}`}
          >
            evolve
          </button>
        </div>
      ))}
    </div>
  );
}

/** The held-item slot: what is held (with unhold) and a picker over the holdable items in the inventory. */
export function HeldSlot({
  daemon,
  inventory,
  disabled,
  onHold,
  onUnhold,
}: {
  daemon: RamDaemon;
  inventory: Record<string, number>;
  disabled: boolean;
  onHold: (itemId: string) => void;
  onUnhold: () => void;
}) {
  const holdable = Object.entries(inventory).filter(([id, n]) => n > 0 && isHoldable(id));
  return (
    <div className="mono mt-1 flex items-center gap-2 text-xs text-neutral-400" data-testid={`held-${daemon.slot}`}>
      <span>held: {daemon.heldItem ?? '—'}</span>
      {daemon.heldItem && (
        <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={disabled} onClick={onUnhold}>
          unhold
        </button>
      )}
      {holdable.length > 0 && (
        <select
          className="rounded bg-neutral-800 px-1"
          value=""
          disabled={disabled}
          onChange={(e) => e.target.value && onHold(e.target.value)}
          data-testid={`hold-${daemon.slot}`}
        >
          <option value="">hold…</option>
          {holdable.map(([id, n]) => (
            <option key={id} value={id}>
              {id} ×{n}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
```

Run: `pnpm exec vitest run apps/frontend` — expected: green (9 tests in two files).

- [ ] **Step 5: API types and log lines**

In `apps/frontend/src/types.ts` re-export `BestiaryRow` too:

```ts
import type { BestiaryRow, ItemDef, MoveDef, Nature, SpeciesDef, TraitDef, TypeId } from '@daemonet/rules';

export type { BestiaryRow, ItemDef, MoveDef, SpeciesDef, TraitDef, TypeId };
export type NatureDef = Nature;
```

In `apps/frontend/src/api.ts`:

1. Import `BestiaryRow` from `./types.ts` alongside the other types.
2. Add to `DiskDaemon` before `log`:
   ```ts
     heldItem: string | null;
     patched: boolean;
     crashes: number;
     history: Array<{ at: string; kind: string; detail: string }>;
   ```
3. Add to `Codex` after `traits`:
   ```ts
     /** Bestiary rows with hidden, undiscovered requirements blanked (null). */
     bestiary: BestiaryRow[];
     discovered: string[];
     discoveries: Array<{ formId: string; operatorName: string | null; discoveredAt: string }>;
   ```
4. `tagTypes: ['Me', 'Script', 'Disk', 'Codex']` and `codex: b.query<Codex, void>({ query: () => '/codex', providesTags: ['Codex'] }),`.

In `apps/frontend/src/game/connection.ts`, after the `crash` handler:

```ts
    client.on('evolved', (e) => log.push('event', `${e.daemon} evolved: ${e.from} -> ${e.to}`));
    client.on('discovery', (e) => log.push('event', `${e.operatorName ?? 'someone'} discovered ${e.form}`));
```

In `apps/frontend/src/panels/DiskPanel.tsx`, after the `T{d.signature}` badge:

```tsx
                {d.patched && <span className="ml-1 text-amber-300">patched</span>}
                {d.heldItem && <span className="mono ml-1 text-xs text-neutral-400">holds {d.heldItem}</span>}
```

- [ ] **Step 6: RAM panel**

Replace `apps/frontend/src/panels/RamPanel.tsx`:

```tsx
import { STAT_KEYS, getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useDiskQuery } from '../api.ts';
import { run } from '../components/WorldCanvas.tsx';
import { setControls } from '../game/controls.ts';
import { spriteCanvas } from '../render/draw.ts';
import { useEffect, useRef } from 'react';
import { EvolveSection, HeldSlot } from './EvolveSection.tsx';

export function SpriteImg({ species, types, clean, signature, size = 32 }: { species: string; types: readonly string[]; clean: boolean; signature: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(spriteCanvas(species, types, clean, signature), 0, 0, size, size);
  }, [species, types, clean, signature, size]);
  return <canvas ref={ref} width={size} height={size} className="shrink-0" />;
}

export function RamPanel({ client }: { client: GameClient }) {
  const me = client.self;
  const manual = client.role === 'controller';
  const atHost = Math.hypot(me.x - 16.5, me.y - 16.5) <= 2;
  const disk = useDiskQuery();
  return (
    <div className="space-y-2 p-3 text-sm">
      <p className="text-xs text-neutral-500">
        RAM {me.ram.length}/8 · running {me.running.length}/2 · {atHost ? 'at the host: store/load enabled' : 'store/load only at the host'}
      </p>
      {me.ram
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((d) => {
          const sp = getSpecies(d.species);
          const running = me.running.includes(d.id);
          return (
            <div key={d.id} className="flex gap-2 rounded border border-neutral-800 p-2" data-testid={`ram-${d.slot}`}>
              <SpriteImg species={d.species} types={sp.types} clean={d.clean} signature={d.signature} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium" data-testid={`ram-${d.slot}-name`}>
                    {sp.name}
                  </span>
                  <span className="text-neutral-500">L{d.level}</span>
                  {d.clean && <span className="text-white">clean</span>}
                  {d.signature > 0 && <span className="text-fuchsia-300">T{d.signature}</span>}
                  {d.patched && <span className="text-amber-300">patched</span>}
                  {d.crashed && <span className="text-red-400">crashed</span>}
                  {running && <span className="text-emerald-400">running</span>}
                </div>
                <div className="mono text-xs text-neutral-400">
                  {Math.round(d.hp)}/{d.maxHp} hp · {Math.floor(d.energy)} en · xp {d.xp} · {sp.traits[d.traitSlot]} · {d.crashes} crashes
                </div>
                <div className="mono text-xs text-neutral-500">
                  IV {STAT_KEYS.map((k, i) => `${k.slice(0, 2)}${d.ivs[i]}`).join(' ')}
                </div>
                <div className="mono text-xs text-neutral-500">moves {d.moves.join(', ')}</div>
                <HeldSlot
                  daemon={d}
                  inventory={me.inventory}
                  disabled={!manual}
                  onHold={(item) => run(client.operator.hold(d.id, item), 'hold')}
                  onUnhold={() => run(client.operator.unhold(d.id), 'unhold')}
                />
                <EvolveSection daemon={d} disabled={!manual || running} onEvolve={(form) => run(client.operator.evolve(d.id, form), 'evolve')} />
                <div className="mt-1 flex gap-2 text-xs">
                  {running ? (
                    <button className="text-neutral-300 hover:text-white" disabled={!manual} onClick={() => run(client.operator.recall(d.id), 'recall')}>
                      recall
                    </button>
                  ) : (
                    <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed} onClick={() => run(client.operator.run(d.id), 'run')} data-testid={`run-${d.slot}`}>
                      run
                    </button>
                  )}
                  <button className="text-neutral-300 hover:text-white" onClick={() => setControls({ actor: d.id })}>
                    select
                  </button>
                  <button className="text-neutral-300 hover:text-white disabled:opacity-40" disabled={!manual || d.crashed || (me.inventory.restore ?? 0) === 0} onClick={() => run(client.operator.useRestore(d.id), 'restore')}>
                    restore ×{me.inventory.restore ?? 0}
                  </button>
                  <button
                    className="text-neutral-300 hover:text-white disabled:opacity-40"
                    disabled={!manual || running || !atHost}
                    onClick={() => run(client.operator.store(d.id).then(() => disk.refetch()), 'store')}
                  >
                    store
                  </button>
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
```

- [ ] **Step 7: Codex panel**

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
type View = (typeof VIEWS)[number];

/** One evolution tree node: the form, its branch text, and a mark once anyone has evolved into it. */
function TreeNode({ row, rows, codex }: { row: BestiaryRow; rows: BestiaryRow[]; codex: Codex }) {
  const children = rows.filter((r) => r.evolvesFrom === row.id);
  const found = codex.discoveries.find((d) => d.formId === row.id);
  const discovered = row.evolvesFrom === null || found !== undefined;
  return (
    <li>
      <div className={`flex items-center gap-1 ${discovered ? '' : 'text-neutral-500'}`} data-testid={`tree-${row.id}`}>
        <SpriteImg species={row.id} types={row.types} clean={false} signature={0} size={16} />
        <span className={discovered ? 'font-medium' : ''}>{row.name}</span>
        {row.evolvesFrom !== null && <span className="mono text-xs text-neutral-500">{describeBranch(row.evolvesAt ?? 0, row.requirement, row.hidden)}</span>}
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

- [ ] **Step 8: Verify**

Run: `pnpm exec tsc -b && pnpm exec eslint . && DATABASE_URL=... pnpm exec vitest run` — expected: green, 28 files, 281 tests. `pnpm --filter @daemonet/frontend build` succeeds.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts apps/frontend
git commit -m "feat(frontend): evolve section, held-item slot, codex trees with discoveries, full type chart"
```

---

### Task 3: End-to-end

**Files:**
- Modify: `apps/frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: Extend the Playwright smoke**

Append to `apps/frontend/e2e/smoke.spec.ts`:

```ts
test('a level-8 daemon seeded on Disk is loaded at the host and evolved from the RAM card; the codex tree marks the discovery', async ({ page }) => {
  const who = `${name}e`;
  await page.goto('/');
  await page.getByTestId('dev-name').fill(who);
  await page.getByTestId('dev-login').click();
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });

  // seed through the dev route (shares the page's session cookie), then load it into RAM at the host (the spawn point is within reach)
  const seeded = await page.request.post('/api/dev/daemon', { data: { species: 'pingling', level: 8 }, headers: { 'x-requested-with': 'daemonet' } });
  expect(seeded.ok()).toBeTruthy();
  await page.getByTestId('tab-disk').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await page.getByRole('button', { name: 'load into RAM' }).click();
  await page.getByTestId('tab-ram').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Pingling', { timeout: 15_000 });
  await expect(page.getByTestId('evolve-1')).toContainText('Echolet');
  await page.getByTestId('evolve-1-echolet').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Echolet', { timeout: 15_000 });
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText('evolved: pingling -> echolet');

  await page.getByTestId('tab-codex').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await expect(page.getByTestId('tree-echolet')).toContainText('✓', { timeout: 10_000 });
});
```

- [ ] **Step 2: Run it**

Build and start the stack as in OPERATIONS.md "Local development" (sim on 3000 and api on 3001 with `AUTH_DEV_BYPASS=true`, `FRONTEND_ORIGIN=http://127.0.0.1:4173`), then:

```bash
pnpm --filter @daemonet/frontend exec vite preview --host 127.0.0.1 --port 4173 &
pnpm --filter @daemonet/frontend exec playwright test
```

Expected: 2 passed (the original smoke and the evolution scenario; about 4 s). Also eyeball the Codex **trees** tab: 50 boxed lines, hidden branches as `???`, item branches as `hold …`, capstones marked, ✓ on the forms evolved so far.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/e2e/smoke.spec.ts
git commit -m "test(e2e): seed, load and evolve a daemon; codex marks the discovery"
```

---

## Self-review

- **Spec coverage:** §4.3 Codex returns requirements only when not hidden or discovered, with the discoverer's name (Task 1); §8 client: RAM card evolve section with ready forms / requirements / `???` / button, Codex trees with discovered markers, 64 moves and the 16×16 chart, held-item slot (Task 2); §8 API: `/api/codex` adds `bestiary`, `discoveries`, trait effect text and held items (Task 1); §9 api tests (masking, discovery listing), client unit test (evolve panel), e2e with a level-8 daemon via a dev route (Tasks 1–3). Sprites for evolved forms are the SP2 procedural ones keyed by species id, so nothing to add.
- **Type consistency:** `RamDaemon` comes from `@daemonet/shared` (as the sim emits it); `BestiaryRow.requirement` is `Requirement[] | null` and `describeBranch` accepts the wire form `unknown[] | null`; test ids `ram-<slot>-name`, `evolve-<slot>`, `evolve-<slot>-<form>`, `tree-<id>`, `codex-<view>` are used identically in components, unit tests and the e2e.
- **Placeholders:** none.
