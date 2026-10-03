# Daemonet SP3a · Plan 2 — The twelve remaining capture-challenge families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every type is capturable: implement the 12 challenge families SP1 left out (kernel, cache, thread, signal, socket, buffer, shell, root, proxy, cloud, stack, heap) in `packages/rules/src/capture/`, register them, add test-only reference solvers, and prove each with the same property tests the SP1 families pass (solver passes, mutation fails, deterministic per seed, under 64 KiB, malformed answers rejected, chaining works across all 16).

**Architecture:** Each family is one module exporting a `ChallengeFamily` (`generate(size, noise, rng)`, `answerSchema`, `check`) plus its rule function (e.g. `roundRobin`, `lruHits`) so the sim can never disagree with the generator. Rules for each family are written in the module's doc comment — that comment is the player-facing specification (the SDK re-exports the types; the Codex will show the text in SP3a plan 4). Noise, where the spec calls for it, is data the rules say to ignore (burst-0 processes, `#` comments, duplicate segments/signals, blank lines, bad frees, trailing `nop`s).

**Tech Stack:** as before.

**Prerequisites:** SP3a plan 1 merged.

**Spec:** `docs/superpowers/specs/2026-09-30-daemonet-sp3a-daemon-depth-design.md` §5 (this plan fixes the socket machine at five states and defines the exact rules in each module).

## Global Constraints

- Everything from the earlier plans.
- Reference solvers stay under `packages/rules/test/solvers.ts`; nothing in `src/` imports them.
- Every family: `generate` draws only from the injected `Rng`; the payload JSON stays under 64 KiB at size 1024; answers are JSON objects validated by a zod schema.
- Noise levels 0/1/2 mean none / `⌊size/8⌋` / `⌊size/4⌋` decoys (families whose rules have no natural decoy ignore noise).

## File map

```
packages/rules/src/capture/{kernel,cache,thread,signal,socket,buffer,shell,root,proxy,cloud,stack,heap}.ts
packages/rules/src/capture/index.ts      registry of all 16
packages/rules/src/index.ts              type re-exports for the SDK
packages/rules/test/solvers.ts           +12 reference solvers
packages/rules/test/capture.test.ts      FAMILIES = all 16, mutation helper for every answer shape
```

---

### Task 1: kernel, cache, thread, signal

**Files:**
- Create: `packages/rules/src/capture/kernel.ts`, `cache.ts`, `thread.ts`, `signal.ts`
- Modify: `packages/rules/src/capture/index.ts`, `packages/rules/src/index.ts`, `packages/rules/test/solvers.ts`, `packages/rules/test/capture.test.ts`

**Interfaces:**
- kernel: `KernelProcess { pid; arrival; burst }`, params `{ quantum }`, payload `{ processes }`, answer `{ order: pid[] }`, `roundRobin(processes, quantum)`.
- cache: params `{ capacity }`, payload `{ trace }`, answer `{ hits }`, `lruHits(capacity, trace)`.
- thread: `ThreadEvent { thread; op; obj }`, params `{ threads }`, payload `{ events }`, answer `{ race: [i, j] }`, `firstRace(events)`.
- signal: `SignalEvent { t; sig }`, params `{ masked; unmaskAt }`, payload `{ signals }`, answer `{ order }`, `deliveryOrder(params, signals)`.

- [ ] **Step 1: Extend the tests**

In `packages/rules/test/capture.test.ts`:

1. Change the types import to `import { TYPES, type TypeId } from '../src/types.js';` and the family list to
   ```ts
   const FAMILIES: TypeId[] = ['packet', 'crypto', 'glitch', 'null', 'kernel', 'cache', 'thread', 'signal'];
   ```
2. Replace the `mutate` helper with one that covers every answer shape:
   ```ts
   /** Change the answer so it is still schema-valid but wrong (every family's answer shape is covered). */
   function mutate(answer: Record<string, unknown>): Record<string, unknown> {
     const [key, value] = Object.entries(answer)[0]!;
     if (typeof value === 'number') return { [key]: value + 1 };
     if (typeof value === 'string') {
       if (key === 'checksum' || key === 'hex' || key === 'contents') return { [key]: value === '' ? '00' : (value[0] === '0' ? '1' : '0') + value.slice(1) };
       if (key === 'allowed') return { [key]: (value[0] === '1' ? '0' : '1') + value.slice(1) };
       return { [key]: value + 'x' };
     }
     if (Array.isArray(value)) {
       if (key === 'race') return { [key]: [value[0] === -1 ? 0 : -1, value[1]] };
       return { [key]: [...value, typeof value[0] === 'number' ? 1 : 'x'] };
     }
     const entries = Object.entries(value as Record<string, string>);
     if (entries.length === 0) return { [key]: { extra: 'CLOSED' } };
     const [k, v] = entries[0]!;
     return { [key]: { ...(value as Record<string, string>), [k]: v === 'CLOSED' ? 'ESTABLISHED' : 'CLOSED' } };
   }
   ```
3. Replace the `rejects unknown families and bad type counts` test with:
   ```ts
   it('rejects bad type counts', () => {
     expect(() => generateChallenge([], 16, 0, createRng(3))).toThrow(RangeError);
     expect(() => generateChallenge(['kernel', 'heap', 'null'], 16, 0, createRng(3))).toThrow(RangeError);
   });
   ```
   (`heap` is unregistered until Task 3; the three-type check throws before any family is looked up.)

In `packages/rules/test/solvers.ts` add these solvers (and their type imports from the new modules), then add `kernel: solveKernel, cache: solveCache, thread: solveThread, signal: solveSignal` to `SOLVERS`:

```ts
export function solveKernel(params: KernelParams, payload: KernelPayload): { order: number[] } {
  const live = payload.processes.filter((p) => p.burst > 0).map((p) => ({ ...p, left: p.burst }));
  const pending = [...live].sort((a, b) => a.arrival - b.arrival || a.pid - b.pid);
  const queue: typeof live = [];
  const order: number[] = [];
  let t = 0;
  const admit = () => {
    while (pending.length && pending[0]!.arrival <= t) queue.push(pending.shift()!);
  };
  while (pending.length || queue.length) {
    admit();
    if (!queue.length) {
      t = pending[0]!.arrival;
      continue;
    }
    const p = queue.shift()!;
    const run = Math.min(params.quantum, p.left);
    t += run;
    p.left -= run;
    admit();
    if (p.left === 0) order.push(p.pid);
    else queue.push(p);
  }
  return { order };
}

export function solveCache(params: CacheParams, payload: CachePayload): { hits: number } {
  const order: string[] = [];
  let hits = 0;
  for (const key of payload.trace) {
    if (key.startsWith('#')) continue;
    const i = order.indexOf(key);
    if (i >= 0) {
      hits++;
      order.splice(i, 1);
    } else if (order.length >= params.capacity) order.shift();
    order.push(key);
  }
  return { hits };
}

export function solveThread(_params: unknown, payload: ThreadPayload): { race: [number, number] } {
  const held = new Map<number, Set<string>>();
  const acc: Array<{ i: number; thread: number; obj: string; write: boolean; locks: Set<string> }> = [];
  payload.events.forEach((e, i) => {
    const locks = held.get(e.thread) ?? new Set<string>();
    held.set(e.thread, locks);
    if (e.op === 'lock') locks.add(e.obj);
    else if (e.op === 'unlock') locks.delete(e.obj);
    else acc.push({ i, thread: e.thread, obj: e.obj, write: e.op === 'write', locks: new Set(locks) });
  });
  for (let a = 0; a < acc.length; a++)
    for (let b = a + 1; b < acc.length; b++) {
      const x = acc[a]!;
      const y = acc[b]!;
      if (x.thread !== y.thread && x.obj === y.obj && (x.write || y.write) && ![...x.locks].some((l) => y.locks.has(l))) return { race: [x.i, y.i] };
    }
  return { race: [-1, -1] };
}

export function solveSignal(params: SignalParams, payload: SignalPayload): { order: number[] } {
  const masked = new Set(params.masked);
  const pending = new Set<number>();
  const order: number[] = [];
  let lifted = false;
  const sorted = payload.signals.map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const flush = () => {
    for (const sig of [...pending].sort((a, b) => a - b)) order.push(sig);
    pending.clear();
    lifted = true;
  };
  for (const s of sorted) {
    if (!lifted && s.t >= params.unmaskAt) flush();
    if (!lifted && masked.has(s.sig)) pending.add(s.sig);
    else order.push(s.sig);
  }
  if (!lifted) flush();
  return { order };
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture/kernel.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/capture/kernel.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Kernel: round-robin scheduling.
 * Processes with burst 0 never run (noise) and are absent from the answer. Ready queue rules: at each
 * tick boundary, newly arrived processes (by arrival, then pid) join the queue before the pre-empted
 * process is re-queued. The CPU idles until the next arrival when the queue is empty.
 * Answer: pids in completion order.
 */
export interface KernelProcess {
  pid: number;
  arrival: number;
  burst: number;
}
export interface KernelParams {
  quantum: number;
}
export interface KernelPayload {
  processes: KernelProcess[];
}
export interface KernelAnswer {
  order: number[];
}

export function roundRobin(processes: readonly KernelProcess[], quantum: number): number[] {
  const live = processes.filter((p) => p.burst > 0).map((p) => ({ ...p, left: p.burst }));
  const pending = [...live].sort((a, b) => a.arrival - b.arrival || a.pid - b.pid);
  const queue: typeof live = [];
  const order: number[] = [];
  let t = 0;
  const admit = () => {
    while (pending.length && pending[0]!.arrival <= t) queue.push(pending.shift()!);
  };
  while (pending.length || queue.length) {
    admit();
    if (queue.length === 0) {
      t = pending[0]!.arrival;
      continue;
    }
    const p = queue.shift()!;
    const run = Math.min(quantum, p.left);
    t += run;
    p.left -= run;
    admit();
    if (p.left === 0) order.push(p.pid);
    else queue.push(p);
  }
  return order;
}

export const kernelFamily: ChallengeFamily<KernelParams, KernelPayload, KernelAnswer> = {
  type: 'kernel',
  answerSchema: z.object({ order: z.array(z.number().int()).max(8192) }),
  generate(size, noise, rng) {
    const processes: KernelProcess[] = [];
    for (let pid = 1; pid <= size; pid++) processes.push({ pid, arrival: rng.int(0, size * 2), burst: rng.int(1, 8) });
    const decoys = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < decoys; i++) processes.push({ pid: size + 1 + i, arrival: rng.int(0, size * 2), burst: 0 });
    rng.shuffle(processes);
    const quantum = rng.int(1, 4);
    return { params: { quantum }, payload: { processes }, answer: { order: roundRobin(processes, quantum) } };
  },
  check: (e, s) => e.order.length === s.order.length && e.order.every((v, i) => v === s.order[i]),
};
```

`packages/rules/src/capture/cache.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Cache: LRU hit count. `trace` entries starting with '#' are comments to ignore (noise).
 * A hit is an access to a key already in the cache; misses insert and evict the least recently used.
 */
export interface CacheParams {
  capacity: number;
}
export interface CachePayload {
  trace: string[];
}
export interface CacheAnswer {
  hits: number;
}

export function lruHits(capacity: number, trace: readonly string[]): number {
  const order: string[] = [];
  let hits = 0;
  for (const key of trace) {
    if (key.startsWith('#')) continue;
    const i = order.indexOf(key);
    if (i >= 0) {
      hits++;
      order.splice(i, 1);
    } else if (order.length >= capacity) order.shift();
    order.push(key);
  }
  return hits;
}

export const cacheFamily: ChallengeFamily<CacheParams, CachePayload, CacheAnswer> = {
  type: 'cache',
  answerSchema: z.object({ hits: z.number().int().nonnegative() }),
  generate(size, noise, rng) {
    const capacity = Math.max(2, Math.floor(size / 4));
    const alphabet = Math.max(3, capacity * 2);
    const trace: string[] = [];
    for (let i = 0; i < size; i++) trace.push(`k${rng.int(0, alphabet - 1)}`);
    const decoys = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < decoys; i++) trace.splice(rng.int(0, trace.length), 0, `#k${rng.int(0, alphabet - 1)}`);
    return { params: { capacity }, payload: { trace }, answer: { hits: lruHits(capacity, trace) } };
  },
  check: (e, s) => e.hits === s.hits,
};
```

`packages/rules/src/capture/thread.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Thread: find the first data race.
 * Events run in array order. `lock`/`unlock` change the set of locks the thread holds (`obj` is the
 * lock). `read`/`write` access data `obj`. Two accesses i < j race when they touch the same obj from
 * different threads, at least one is a write, and the lock sets held at i and at j have no lock in
 * common. Answer: the smallest [i, j] by i, then j; [-1, -1] when there is none.
 */
export interface ThreadEvent {
  thread: number;
  op: 'lock' | 'unlock' | 'read' | 'write';
  obj: string;
}
export interface ThreadParams {
  threads: number;
}
export interface ThreadPayload {
  events: ThreadEvent[];
}
export interface ThreadAnswer {
  race: [number, number];
}

export function firstRace(events: readonly ThreadEvent[]): [number, number] {
  const held = new Map<number, Set<string>>();
  const accesses: Array<{ i: number; thread: number; obj: string; write: boolean; locks: Set<string> }> = [];
  events.forEach((e, i) => {
    const locks = held.get(e.thread) ?? new Set<string>();
    held.set(e.thread, locks);
    if (e.op === 'lock') locks.add(e.obj);
    else if (e.op === 'unlock') locks.delete(e.obj);
    else accesses.push({ i, thread: e.thread, obj: e.obj, write: e.op === 'write', locks: new Set(locks) });
  });
  for (let a = 0; a < accesses.length; a++) {
    for (let b = a + 1; b < accesses.length; b++) {
      const x = accesses[a]!;
      const y = accesses[b]!;
      if (x.thread === y.thread || x.obj !== y.obj || !(x.write || y.write)) continue;
      if ([...x.locks].some((l) => y.locks.has(l))) continue;
      return [x.i, y.i];
    }
  }
  return [-1, -1];
}

export const threadFamily: ChallengeFamily<ThreadParams, ThreadPayload, ThreadAnswer> = {
  type: 'thread',
  answerSchema: z.object({ race: z.tuple([z.number().int(), z.number().int()]) }),
  generate(size, _noise, rng) {
    const threads = rng.int(2, 4);
    const locks = ['m0', 'm1'];
    const data = ['x', 'y', 'z'];
    const events: ThreadEvent[] = [];
    const held: Set<string>[] = Array.from({ length: threads }, () => new Set());
    for (let i = 0; i < size; i++) {
      const thread = rng.int(0, threads - 1);
      const r = rng.float();
      if (r < 0.2) {
        const l = rng.pick(locks);
        if (held[thread]!.has(l)) {
          held[thread]!.delete(l);
          events.push({ thread, op: 'unlock', obj: l });
        } else {
          held[thread]!.add(l);
          events.push({ thread, op: 'lock', obj: l });
        }
      } else events.push({ thread, op: rng.chance(0.4) ? 'write' : 'read', obj: rng.pick(data) });
    }
    return { params: { threads }, payload: { events }, answer: { race: firstRace(events) } };
  },
  check: (e, s) => e.race[0] === s.race[0] && e.race[1] === s.race[1],
};
```

`packages/rules/src/capture/signal.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Signal: delivery order with a mask.
 * Signals arrive at time t (array order breaks ties). A signal in `masked` becomes pending instead of
 * being delivered; pending signals coalesce (a set). At time `unmaskAt`, before any signal arriving at
 * that time is handled, all pending signals are delivered in ascending signal number and the mask is
 * lifted for good. Answer: signal numbers in delivery order.
 */
export interface SignalEvent {
  t: number;
  sig: number;
}
export interface SignalParams {
  masked: number[];
  unmaskAt: number;
}
export interface SignalPayload {
  signals: SignalEvent[];
}
export interface SignalAnswer {
  order: number[];
}

export function deliveryOrder(params: SignalParams, signals: readonly SignalEvent[]): number[] {
  const masked = new Set(params.masked);
  const pending = new Set<number>();
  const order: number[] = [];
  let lifted = false;
  const sorted = signals.map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const flush = () => {
    for (const sig of [...pending].sort((a, b) => a - b)) order.push(sig);
    pending.clear();
    lifted = true;
  };
  for (const s of sorted) {
    if (!lifted && s.t >= params.unmaskAt) flush();
    if (!lifted && masked.has(s.sig)) pending.add(s.sig);
    else order.push(s.sig);
  }
  if (!lifted) flush();
  return order;
}

export const signalFamily: ChallengeFamily<SignalParams, SignalPayload, SignalAnswer> = {
  type: 'signal',
  answerSchema: z.object({ order: z.array(z.number().int()).max(16384) }),
  generate(size, noise, rng) {
    const masked = [...new Set(Array.from({ length: rng.int(2, 6) }, () => rng.int(1, 31)))];
    const signals: SignalEvent[] = [];
    for (let i = 0; i < size; i++) signals.push({ t: rng.int(0, size * 2), sig: rng.chance(0.5) ? rng.pick(masked) : rng.int(1, 31) });
    const dup = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < dup; i++) signals.push({ ...rng.pick(signals) });
    const params = { masked, unmaskAt: rng.int(1, size * 2) };
    return { params, payload: { signals }, answer: { order: deliveryOrder(params, signals) } };
  },
  check: (e, s) => e.order.length === s.order.length && e.order.every((v, i) => v === s.order[i]),
};
```

In `packages/rules/src/capture/index.ts` import the four families and add them to `FAMILIES` (`kernel: kernelFamily as ChallengeFamily`, …). In `packages/rules/src/index.ts` add:

```ts
export type { KernelParams, KernelPayload, KernelAnswer, KernelProcess } from './capture/kernel.js';
export type { CacheParams, CachePayload, CacheAnswer } from './capture/cache.js';
export type { ThreadParams, ThreadPayload, ThreadAnswer, ThreadEvent } from './capture/thread.js';
export type { SignalParams, SignalPayload, SignalAnswer, SignalEvent } from './capture/signal.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): kernel, cache, thread and signal capture challenges"
```

---

### Task 2: socket, buffer, shell, root

**Files:**
- Create: `packages/rules/src/capture/socket.ts`, `buffer.ts`, `shell.ts`, `root.ts`
- Modify: `packages/rules/src/capture/index.ts`, `packages/rules/src/index.ts`, `packages/rules/test/solvers.ts`, `packages/rules/test/capture.test.ts`

**Interfaces:**
- socket: `SocketState` (`CLOSED | SYN_RCVD | ESTABLISHED | CLOSE_WAIT | LAST_ACK`), `SocketFlag`, `Segment { conn; flag }`, params `{ connections }`, payload `{ segments }`, answer `{ states }`, `finalStates(connections, segments)`.
- buffer: params `{ capacity }`, payload `{ ops }`, answer `{ contents: hex }`, `ringContents(capacity, ops)`.
- shell: params `{ pipeline }`, payload `{ lines }`, answer `{ output }`, `runPipeline(pipeline, lines)`.
- root: `AclEntry`, `RootRequest`, params `{ mode; owner; group; acl }`, payload `{ requests }`, answer `{ allowed: '10…' }`, `checkAccess(params, request)`.

- [ ] **Step 1: Extend the tests** — add `'socket', 'buffer', 'shell', 'root'` to `FAMILIES`; add these solvers to `solvers.ts` (with their type imports; `SocketState` is imported from `socket.js`) and `socket: solveSocket, buffer: solveBuffer, shell: solveShell, root: solveRoot` to `SOLVERS`:

```ts
export function solveSocket(params: SocketParams, payload: SocketPayload): { states: Record<string, SocketState> } {
  const next: Record<SocketState, Partial<Record<string, SocketState>>> = {
    CLOSED: { SYN: 'SYN_RCVD' },
    SYN_RCVD: { ACK: 'ESTABLISHED', SYNACK: 'ESTABLISHED' },
    ESTABLISHED: { FIN: 'CLOSE_WAIT' },
    CLOSE_WAIT: { FIN: 'LAST_ACK' },
    LAST_ACK: { ACK: 'CLOSED' },
  };
  const states: Record<string, SocketState> = Object.fromEntries(params.connections.map((c) => [c, 'CLOSED' as const]));
  for (const s of payload.segments) {
    const cur = states[s.conn] ?? 'CLOSED';
    states[s.conn] = s.flag === 'RST' ? 'CLOSED' : (next[cur][s.flag] ?? cur);
  }
  return { states };
}

export function solveBuffer(params: BufferParams, payload: BufferPayload): { contents: string } {
  const buf: string[] = [];
  for (const op of payload.ops) {
    if (op === 'r') buf.shift();
    else {
      if (buf.length >= params.capacity) buf.shift();
      buf.push(op.slice(2));
    }
  }
  return { contents: buf.join('') };
}

export function solveShell(params: ShellParams, payload: ShellPayload): { output: string[] } {
  let out = payload.lines.filter((l) => l !== '');
  for (const stage of params.pipeline.split(' | ')) {
    const [cmd, ...args] = stage.split(' ');
    if (cmd === 'grep') out = out.filter((l) => l.includes(args[0]!));
    else if (cmd === 'sort') out = [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else if (cmd === 'uniq') out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
    else if (cmd === 'cut') out = out.map((l) => l.split(args[0]!.slice(2))[Number(args[1]!.slice(2)) - 1] ?? '');
    else if (cmd === 'wc') out = [String(out.length)];
  }
  return { output: out };
}

export function solveRoot(params: RootParams, payload: RootPayload): { allowed: string } {
  const has = (t: string, op: string) => t[{ r: 0, w: 1, x: 2 }[op as 'r' | 'w' | 'x']] === op;
  return {
    allowed: payload.requests
      .map((r) => {
        if (r.user === params.owner) return has(params.mode.slice(0, 3), r.op);
        const u = params.acl.find((a) => a.who === `user:${r.user}`);
        if (u) return has(u.perms, r.op);
        const g = params.acl.filter((a) => a.who.startsWith('group:') && r.groups.includes(a.who.slice(6)));
        if (g.length) return g.some((a) => has(a.perms, r.op));
        if (r.groups.includes(params.group)) return has(params.mode.slice(3, 6), r.op);
        return has(params.mode.slice(6, 9), r.op);
      })
      .map((b) => (b ? '1' : '0'))
      .join(''),
  };
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture/socket.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/capture/socket.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Socket: run a (server-side) TCP state machine per connection over a segment trace.
 *   CLOSED --SYN--> SYN_RCVD --ACK|SYNACK--> ESTABLISHED --FIN--> CLOSE_WAIT --FIN--> LAST_ACK --ACK--> CLOSED
 *   RST from any state -> CLOSED. Any other (state, flag) pair is ignored.
 * Every connection starts CLOSED. Answer: the final state of every connection that appears.
 */
export type SocketState = 'CLOSED' | 'SYN_RCVD' | 'ESTABLISHED' | 'CLOSE_WAIT' | 'LAST_ACK';
export type SocketFlag = 'SYN' | 'SYNACK' | 'ACK' | 'FIN' | 'RST';
export interface Segment {
  conn: string;
  flag: SocketFlag;
}
export interface SocketParams {
  connections: string[];
}
export interface SocketPayload {
  segments: Segment[];
}
export interface SocketAnswer {
  states: Record<string, SocketState>;
}

const TRANSITIONS: Record<SocketState, Partial<Record<SocketFlag, SocketState>>> = {
  CLOSED: { SYN: 'SYN_RCVD' },
  SYN_RCVD: { ACK: 'ESTABLISHED', SYNACK: 'ESTABLISHED' },
  ESTABLISHED: { FIN: 'CLOSE_WAIT' },
  CLOSE_WAIT: { FIN: 'LAST_ACK' },
  LAST_ACK: { ACK: 'CLOSED' },
};

export function finalStates(connections: readonly string[], segments: readonly Segment[]): Record<string, SocketState> {
  const states: Record<string, SocketState> = Object.fromEntries(connections.map((c) => [c, 'CLOSED' as const]));
  for (const s of segments) {
    const cur = states[s.conn] ?? 'CLOSED';
    states[s.conn] = s.flag === 'RST' ? 'CLOSED' : (TRANSITIONS[cur][s.flag] ?? cur);
  }
  return states;
}

const FLAGS: SocketFlag[] = ['SYN', 'SYNACK', 'ACK', 'FIN', 'RST'];

export const socketFamily: ChallengeFamily<SocketParams, SocketPayload, SocketAnswer> = {
  type: 'socket',
  answerSchema: z.object({ states: z.record(z.string(), z.enum(['CLOSED', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT', 'LAST_ACK'])) }),
  generate(size, noise, rng) {
    const connections = Array.from({ length: rng.int(2, 4) }, (_, i) => `c${i}`);
    const segments: Segment[] = [];
    for (let i = 0; i < size; i++) segments.push({ conn: rng.pick(connections), flag: rng.chance(0.1) ? 'RST' : rng.pick(FLAGS.slice(0, 4)) });
    const dup = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < dup; i++) segments.splice(rng.int(0, segments.length), 0, { ...rng.pick(segments) });
    return { params: { connections }, payload: { segments }, answer: { states: finalStates(connections, segments) } };
  },
  check: (e, s) => Object.keys(e.states).length === Object.keys(s.states).length && Object.entries(e.states).every(([k, v]) => s.states[k] === v),
};
```

`packages/rules/src/capture/buffer.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Buffer: an overwriting ring buffer of bytes.
 * `w:<hex byte>` appends (when full, the oldest byte is dropped first); `r` removes the oldest byte
 * (no-op when empty). Answer: the remaining bytes, oldest first, as lowercase hex.
 */
export interface BufferParams {
  capacity: number;
}
export interface BufferPayload {
  ops: string[];
}
export interface BufferAnswer {
  contents: string;
}

export function ringContents(capacity: number, ops: readonly string[]): string {
  const buf: string[] = [];
  for (const op of ops) {
    if (op === 'r') buf.shift();
    else if (op.startsWith('w:')) {
      if (buf.length >= capacity) buf.shift();
      buf.push(op.slice(2));
    }
  }
  return buf.join('');
}

export const bufferFamily: ChallengeFamily<BufferParams, BufferPayload, BufferAnswer> = {
  type: 'buffer',
  answerSchema: z.object({ contents: z.string().regex(/^(?:[0-9a-f]{2})*$/).max(65536) }),
  generate(size, _noise, rng) {
    const capacity = Math.max(2, Math.floor(size / 4));
    const ops: string[] = [];
    for (let i = 0; i < size; i++) ops.push(rng.chance(0.7) ? `w:${rng.int(0, 255).toString(16).padStart(2, '0')}` : 'r');
    return { params: { capacity }, payload: { ops }, answer: { contents: ringContents(capacity, ops) } };
  },
  check: (e, s) => e.contents === s.contents,
};
```

`packages/rules/src/capture/shell.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';
import { WORDS } from './crypto.js';

/**
 * Shell: evaluate a small pipeline over `lines`.
 * Stages (separated by " | "): `grep <word>` keeps lines containing the word; `sort` sorts lines
 * (code-point order); `uniq` drops consecutive duplicates; `cut -d<c> -f<n>` keeps the n-th
 * (1-based) field split by the single character c (lines with fewer fields become ""); `wc -l`
 * replaces the output with one line holding the count. Blank lines in the input are ignored (noise).
 * Answer: the output lines.
 */
export interface ShellParams {
  pipeline: string;
}
export interface ShellPayload {
  lines: string[];
}
export interface ShellAnswer {
  output: string[];
}

export function runPipeline(pipeline: string, lines: readonly string[]): string[] {
  let out = lines.filter((l) => l !== '');
  for (const stage of pipeline.split(' | ')) {
    const [cmd, ...args] = stage.split(' ');
    switch (cmd) {
      case 'grep':
        out = out.filter((l) => l.includes(args[0]!));
        break;
      case 'sort':
        out = [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        break;
      case 'uniq':
        out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
        break;
      case 'cut': {
        const delim = args[0]!.slice(2);
        const field = Number(args[1]!.slice(2)) - 1;
        out = out.map((l) => l.split(delim)[field] ?? '');
        break;
      }
      case 'wc':
        out = [String(out.length)];
        break;
    }
  }
  return out;
}

export const shellFamily: ChallengeFamily<ShellParams, ShellPayload, ShellAnswer> = {
  type: 'shell',
  answerSchema: z.object({ output: z.array(z.string()).max(16384) }),
  generate(size, noise, rng) {
    const lines: string[] = [];
    for (let i = 0; i < size; i++) lines.push(`${rng.pick(WORDS)},${rng.int(0, 99)},${rng.pick(WORDS)}`);
    const blanks = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < blanks; i++) lines.splice(rng.int(0, lines.length), 0, '');
    const stages: string[] = [];
    if (rng.chance(0.7)) stages.push(`grep ${rng.pick(WORDS)}`);
    if (rng.chance(0.5)) stages.push(`cut -d, -f${rng.int(1, 3)}`);
    if (rng.chance(0.7)) stages.push('sort');
    if (rng.chance(0.5)) stages.push('uniq');
    if (rng.chance(0.3)) stages.push('wc -l');
    if (stages.length === 0) stages.push('sort');
    const pipeline = stages.join(' | ');
    return { params: { pipeline }, payload: { lines }, answer: { output: runPipeline(pipeline, lines) } };
  },
  check: (e, s) => e.output.length === s.output.length && e.output.every((v, i) => v === s.output[i]),
};
```

`packages/rules/src/capture/root.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Root: POSIX-style permission checks with a small ACL.
 * mode is 9 chars (`rwxr-x---`). Precedence for a request by user U with groups G for op o:
 *   1. U is the owner            -> the owner triple
 *   2. an ACL entry `user:U`     -> its perms
 *   3. any ACL entry `group:g` with g in G -> allowed if ANY such entry grants o
 *   4. the file's group is in G  -> the group triple
 *   5. otherwise                 -> the other triple
 * Answer: one '1'/'0' per request, concatenated.
 */
export interface AclEntry {
  who: string;
  perms: string;
}
export interface RootRequest {
  user: string;
  groups: string[];
  op: 'r' | 'w' | 'x';
}
export interface RootParams {
  mode: string;
  owner: string;
  group: string;
  acl: AclEntry[];
}
export interface RootPayload {
  requests: RootRequest[];
}
export interface RootAnswer {
  allowed: string;
}

const has = (triple: string, op: 'r' | 'w' | 'x') => triple[{ r: 0, w: 1, x: 2 }[op]] === op;

export function checkAccess(params: RootParams, req: RootRequest): boolean {
  if (req.user === params.owner) return has(params.mode.slice(0, 3), req.op);
  const user = params.acl.find((a) => a.who === `user:${req.user}`);
  if (user) return has(user.perms, req.op);
  const groups = params.acl.filter((a) => a.who.startsWith('group:') && req.groups.includes(a.who.slice(6)));
  if (groups.length) return groups.some((a) => has(a.perms, req.op));
  if (req.groups.includes(params.group)) return has(params.mode.slice(3, 6), req.op);
  return has(params.mode.slice(6, 9), req.op);
}

const USERS = ['root', 'alice', 'bob', 'carol', 'dave', 'erin'];
const GROUPS = ['wheel', 'staff', 'ops', 'guest'];

const triple = (rng: { chance(p: number): boolean }) => `${rng.chance(0.6) ? 'r' : '-'}${rng.chance(0.4) ? 'w' : '-'}${rng.chance(0.4) ? 'x' : '-'}`;

export const rootFamily: ChallengeFamily<RootParams, RootPayload, RootAnswer> = {
  type: 'root',
  answerSchema: z.object({ allowed: z.string().regex(/^[01]*$/).max(16384) }),
  generate(size, _noise, rng) {
    const params: RootParams = {
      mode: triple(rng) + triple(rng) + triple(rng),
      owner: rng.pick(USERS),
      group: rng.pick(GROUPS),
      acl: [{ who: `user:${rng.pick(USERS)}`, perms: triple(rng) }, { who: `group:${rng.pick(GROUPS)}`, perms: triple(rng) }],
    };
    const requests: RootRequest[] = [];
    for (let i = 0; i < size; i++) {
      const groups = [...new Set([rng.pick(GROUPS), ...(rng.chance(0.5) ? [rng.pick(GROUPS)] : [])])];
      requests.push({ user: rng.pick(USERS), groups, op: rng.pick(['r', 'w', 'x'] as const) });
    }
    return { params, payload: { requests }, answer: { allowed: requests.map((r) => (checkAccess(params, r) ? '1' : '0')).join('') } };
  },
  check: (e, s) => e.allowed === s.allowed,
};
```

Register the four in `capture/index.ts` and add to `packages/rules/src/index.ts`:

```ts
export type { SocketParams, SocketPayload, SocketAnswer, SocketState, SocketFlag, Segment } from './capture/socket.js';
export type { BufferParams, BufferPayload, BufferAnswer } from './capture/buffer.js';
export type { ShellParams, ShellPayload, ShellAnswer } from './capture/shell.js';
export type { RootParams, RootPayload, RootAnswer, RootRequest, AclEntry } from './capture/root.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(rules): socket, buffer, shell and root capture challenges"
```

---

### Task 3: proxy, cloud, stack, heap — all sixteen registered

**Files:**
- Create: `packages/rules/src/capture/proxy.ts`, `cloud.ts`, `stack.ts`, `heap.ts`
- Modify: `packages/rules/src/capture/index.ts` (final), `packages/rules/src/index.ts`, `packages/rules/test/solvers.ts` (final), `packages/rules/test/capture.test.ts` (final)

**Interfaces:**
- proxy: params `{ layers }`, payload `{ payload }`, answer `{ inner }`, `wrap(layer, text)`.
- cloud: params `{ nodes; vnodes }`, payload `{ keys }`, answer `{ placement }`, `placeKeys(params, keys)`.
- stack: params `{ maxSteps }`, payload `{ program }`, answer `{ top }`, `runStack(program, maxSteps)`, `STACK_MAX_STEPS = 4096`.
- heap: `HeapEvent`, params `{ events }`, payload `{ events }`, answer `{ leaked }`, `leaked(events)`.
- `FAMILIES` becomes `Record<TypeId, ChallengeFamily>` (every type); `hasFamily` is always true.

- [ ] **Step 1: Finalize the tests** — set `const FAMILIES: TypeId[] = [...TYPES];`; the final `solvers.ts` is:

```ts
/**
 * Reference solvers — TEST ONLY. Never import these from src/ (they must not ship in any package).
 * Each takes the public (params, payload) and returns the answer object.
 */
import type { BufferParams, BufferPayload } from '../src/capture/buffer.js';
import type { CacheParams, CachePayload } from '../src/capture/cache.js';
import type { CloudParams, CloudPayload } from '../src/capture/cloud.js';
import { fnv1a32Hex, fromHex, fromUtf8, utf8, xorRepeating } from '../src/capture/common.js';
import type { CryptoParams, CryptoPayload } from '../src/capture/crypto.js';
import type { GlitchPayload } from '../src/capture/glitch.js';
import type { HeapPayload } from '../src/capture/heap.js';
import { unsealStage, type ChainPayload, type PublicChallenge } from '../src/capture/index.js';
import type { KernelParams, KernelPayload } from '../src/capture/kernel.js';
import type { NullParams, NullPayload } from '../src/capture/null.js';
import { packetCrc, type PacketParams, type PacketPayload } from '../src/capture/packet.js';
import type { ProxyParams, ProxyPayload } from '../src/capture/proxy.js';
import type { RootParams, RootPayload } from '../src/capture/root.js';
import type { ShellParams, ShellPayload } from '../src/capture/shell.js';
import type { SignalParams, SignalPayload } from '../src/capture/signal.js';
import type { SocketParams, SocketPayload, SocketState } from '../src/capture/socket.js';
import type { StackPayload } from '../src/capture/stack.js';
import type { ThreadPayload } from '../src/capture/thread.js';
import type { TypeId } from '../src/types.js';

export function solvePacket(params: PacketParams, payload: PacketPayload): { checksum: string } {
  const chunks = new Map<number, Uint8Array>();
  for (const f of payload.fragments) {
    const data = fromHex(f.data);
    if (packetCrc(f.seq, data) === f.crc) chunks.set(f.seq, data);
  }
  const message = new Uint8Array(params.count * 4);
  for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq)!, seq * 4);
  return { checksum: fnv1a32Hex(message) };
}

export function solveCrypto(params: CryptoParams, payload: CryptoPayload): { plaintext: string } {
  const cipher = fromHex(payload.ciphertext);
  const k = params.keyLength;
  const key = new Uint8Array(k);
  const known = utf8(params.known.text);
  for (let j = 0; j < k; j++) {
    const i = params.known.offset + j;
    key[i % k] = cipher[i]! ^ known[j]!;
  }
  return { plaintext: fromUtf8(xorRepeating(cipher, key)) };
}

export function solveGlitch(_params: unknown, payload: GlitchPayload): { hex: string } {
  const nibbles = payload.blocks.map((block) => {
    const b = (pos: number) => (block >> (pos - 1)) & 1;
    const syndrome = (b(1) ^ b(3) ^ b(5) ^ b(7)) | ((b(2) ^ b(3) ^ b(6) ^ b(7)) << 1) | ((b(4) ^ b(5) ^ b(6) ^ b(7)) << 2);
    const fixed = syndrome ? block ^ (1 << (syndrome - 1)) : block;
    const f = (pos: number) => (fixed >> (pos - 1)) & 1;
    return (f(3) << 3) | (f(5) << 2) | (f(6) << 1) | f(7);
  });
  let hex = '';
  for (let i = 0; i < nibbles.length; i += 2) hex += ((nibbles[i]! << 4) | nibbles[i + 1]!).toString(16).padStart(2, '0');
  return { hex };
}

export function solveNull(params: NullParams, payload: NullPayload): { sum: number } {
  let sum = 0;
  for (let addr = params.head; addr !== 0; addr = payload.memory[addr + 1]!) sum += payload.memory[addr]!;
  return { sum };
}

export function solveKernel(params: KernelParams, payload: KernelPayload): { order: number[] } {
  const live = payload.processes.filter((p) => p.burst > 0).map((p) => ({ ...p, left: p.burst }));
  const pending = [...live].sort((a, b) => a.arrival - b.arrival || a.pid - b.pid);
  const queue: typeof live = [];
  const order: number[] = [];
  let t = 0;
  const admit = () => {
    while (pending.length && pending[0]!.arrival <= t) queue.push(pending.shift()!);
  };
  while (pending.length || queue.length) {
    admit();
    if (!queue.length) {
      t = pending[0]!.arrival;
      continue;
    }
    const p = queue.shift()!;
    const run = Math.min(params.quantum, p.left);
    t += run;
    p.left -= run;
    admit();
    if (p.left === 0) order.push(p.pid);
    else queue.push(p);
  }
  return { order };
}

export function solveCache(params: CacheParams, payload: CachePayload): { hits: number } {
  const order: string[] = [];
  let hits = 0;
  for (const key of payload.trace) {
    if (key.startsWith('#')) continue;
    const i = order.indexOf(key);
    if (i >= 0) {
      hits++;
      order.splice(i, 1);
    } else if (order.length >= params.capacity) order.shift();
    order.push(key);
  }
  return { hits };
}

export function solveThread(_params: unknown, payload: ThreadPayload): { race: [number, number] } {
  const held = new Map<number, Set<string>>();
  const acc: Array<{ i: number; thread: number; obj: string; write: boolean; locks: Set<string> }> = [];
  payload.events.forEach((e, i) => {
    const locks = held.get(e.thread) ?? new Set<string>();
    held.set(e.thread, locks);
    if (e.op === 'lock') locks.add(e.obj);
    else if (e.op === 'unlock') locks.delete(e.obj);
    else acc.push({ i, thread: e.thread, obj: e.obj, write: e.op === 'write', locks: new Set(locks) });
  });
  for (let a = 0; a < acc.length; a++)
    for (let b = a + 1; b < acc.length; b++) {
      const x = acc[a]!;
      const y = acc[b]!;
      if (x.thread !== y.thread && x.obj === y.obj && (x.write || y.write) && ![...x.locks].some((l) => y.locks.has(l))) return { race: [x.i, y.i] };
    }
  return { race: [-1, -1] };
}

export function solveSignal(params: SignalParams, payload: SignalPayload): { order: number[] } {
  const masked = new Set(params.masked);
  const pending = new Set<number>();
  const order: number[] = [];
  let lifted = false;
  const sorted = payload.signals.map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const flush = () => {
    for (const sig of [...pending].sort((a, b) => a - b)) order.push(sig);
    pending.clear();
    lifted = true;
  };
  for (const s of sorted) {
    if (!lifted && s.t >= params.unmaskAt) flush();
    if (!lifted && masked.has(s.sig)) pending.add(s.sig);
    else order.push(s.sig);
  }
  if (!lifted) flush();
  return { order };
}

export function solveSocket(params: SocketParams, payload: SocketPayload): { states: Record<string, SocketState> } {
  const next: Record<SocketState, Partial<Record<string, SocketState>>> = {
    CLOSED: { SYN: 'SYN_RCVD' },
    SYN_RCVD: { ACK: 'ESTABLISHED', SYNACK: 'ESTABLISHED' },
    ESTABLISHED: { FIN: 'CLOSE_WAIT' },
    CLOSE_WAIT: { FIN: 'LAST_ACK' },
    LAST_ACK: { ACK: 'CLOSED' },
  };
  const states: Record<string, SocketState> = Object.fromEntries(params.connections.map((c) => [c, 'CLOSED' as const]));
  for (const s of payload.segments) {
    const cur = states[s.conn] ?? 'CLOSED';
    states[s.conn] = s.flag === 'RST' ? 'CLOSED' : (next[cur][s.flag] ?? cur);
  }
  return { states };
}

export function solveBuffer(params: BufferParams, payload: BufferPayload): { contents: string } {
  const buf: string[] = [];
  for (const op of payload.ops) {
    if (op === 'r') buf.shift();
    else {
      if (buf.length >= params.capacity) buf.shift();
      buf.push(op.slice(2));
    }
  }
  return { contents: buf.join('') };
}

export function solveShell(params: ShellParams, payload: ShellPayload): { output: string[] } {
  let out = payload.lines.filter((l) => l !== '');
  for (const stage of params.pipeline.split(' | ')) {
    const [cmd, ...args] = stage.split(' ');
    if (cmd === 'grep') out = out.filter((l) => l.includes(args[0]!));
    else if (cmd === 'sort') out = [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else if (cmd === 'uniq') out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
    else if (cmd === 'cut') out = out.map((l) => l.split(args[0]!.slice(2))[Number(args[1]!.slice(2)) - 1] ?? '');
    else if (cmd === 'wc') out = [String(out.length)];
  }
  return { output: out };
}

export function solveRoot(params: RootParams, payload: RootPayload): { allowed: string } {
  const has = (t: string, op: string) => t[{ r: 0, w: 1, x: 2 }[op as 'r' | 'w' | 'x']] === op;
  return {
    allowed: payload.requests
      .map((r) => {
        if (r.user === params.owner) return has(params.mode.slice(0, 3), r.op);
        const u = params.acl.find((a) => a.who === `user:${r.user}`);
        if (u) return has(u.perms, r.op);
        const g = params.acl.filter((a) => a.who.startsWith('group:') && r.groups.includes(a.who.slice(6)));
        if (g.length) return g.some((a) => has(a.perms, r.op));
        if (r.groups.includes(params.group)) return has(params.mode.slice(3, 6), r.op);
        return has(params.mode.slice(6, 9), r.op);
      })
      .map((b) => (b ? '1' : '0'))
      .join(''),
  };
}

export function solveProxy(params: ProxyParams, payload: ProxyPayload): { inner: string } {
  let text = payload.payload;
  for (const layer of [...params.layers].reverse()) {
    if (layer === 'hex') text = fromUtf8(fromHex(text));
    else if (layer === 'base64') text = fromUtf8(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    else if (layer === 'lenprefix') text = text.slice(text.indexOf(':') + 1);
    else if (layer.startsWith('xor:')) text = fromUtf8(fromHex(text).map((b) => b ^ Number(layer.slice(4))));
  }
  return { inner: text };
}

export function solveCloud(params: CloudParams, payload: CloudPayload): { placement: Record<string, string> } {
  const h = (s: string) => parseInt(fnv1a32Hex(utf8(s)), 16);
  const ring: Array<{ pos: number; node: string }> = [];
  for (const node of params.nodes) for (let i = 0; i < params.vnodes; i++) ring.push({ pos: h(`${node}#${i}`), node });
  ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  const placement: Record<string, string> = {};
  for (const key of payload.keys) {
    if (key.startsWith('#')) continue;
    const pos = h(key);
    placement[key] = (ring.find((r) => r.pos >= pos) ?? ring[0]!).node;
  }
  return { placement };
}

export function solveStack(_params: unknown, payload: StackPayload): { top: number } {
  const st: number[] = [];
  const pop = () => st.pop() ?? 0;
  let pc = 0;
  for (let steps = 0; pc < payload.program.length && steps < 4096; steps++) {
    const [op, arg] = payload.program[pc]!.split(' ');
    const k = Number(arg);
    pc++;
    if (op === 'push') st.push(k | 0);
    else if (op === 'add') { const b = pop(); st.push((pop() + b) | 0); }
    else if (op === 'sub') { const b = pop(); st.push((pop() - b) | 0); }
    else if (op === 'mul') { const b = pop(); st.push(Math.imul(pop(), b)); }
    else if (op === 'dup') { const a = pop(); st.push(a, a); }
    else if (op === 'swap') { const b = pop(); const a = pop(); st.push(b, a); }
    else if (op === 'drop') pop();
    else if (op === 'jz') { if (pop() === 0) pc = k; }
    else if (op === 'jmp') pc = k;
  }
  return { top: st[st.length - 1] ?? 0 };
}

export function solveHeap(_params: unknown, payload: HeapPayload): { leaked: number[] } {
  const live = new Set<number>();
  for (const e of payload.events) {
    if (e.op === 'alloc') live.add(e.id);
    else live.delete(e.id);
  }
  return { leaked: [...live].sort((a, b) => a - b) };
}

const SOLVERS: Record<TypeId, (params: never, payload: never) => unknown> = {
  packet: solvePacket, crypto: solveCrypto, glitch: solveGlitch, null: solveNull,
  kernel: solveKernel, cache: solveCache, thread: solveThread, signal: solveSignal, socket: solveSocket, buffer: solveBuffer,
  shell: solveShell, root: solveRoot, proxy: solveProxy, cloud: solveCloud, stack: solveStack, heap: solveHeap,
};

export function solve(challenge: PublicChallenge): unknown {
  const solveStage = (type: TypeId, params: unknown, payload: unknown) =>
    (SOLVERS[type] as (p: unknown, y: unknown) => unknown)(params, payload);
  if (challenge.kind === 'single') return solveStage(challenge.families[0]!, challenge.params, challenge.payload);
  const chain = challenge.payload as ChainPayload;
  const firstAnswer = solveStage(challenge.families[0]!, chain.first.params, chain.first.payload);
  const second = JSON.parse(unsealStage(chain.sealed, firstAnswer)) as {
    params: unknown;
    payload: unknown;
  };
  return solveStage(challenge.families[1]!, second.params, second.payload);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/rules/test/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture/proxy.js`.

- [ ] **Step 3: Implement**

`packages/rules/src/capture/proxy.ts`:

```ts
import { z } from 'zod';
import { fromUtf8, toHex, utf8, type ChallengeFamily } from './common.js';
import { WORDS } from './crypto.js';

/**
 * Proxy: unwrap nested encapsulation. `layers` lists the encodings applied to the inner text in
 * order (first applied first): `hex` (lowercase hex of the bytes), `base64`, `xor:<n>` (every byte
 * XOR n, then hex — so it is always printable), `lenprefix` (`<byte length>:` + data).
 * Answer: the inner text.
 */
export interface ProxyParams {
  layers: string[];
}
export interface ProxyPayload {
  payload: string;
}
export interface ProxyAnswer {
  inner: string;
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export function wrap(layer: string, text: string): string {
  const bytes = utf8(text);
  if (layer === 'hex') return toHex(bytes);
  if (layer === 'base64') return b64(bytes);
  if (layer === 'lenprefix') return `${bytes.length}:${text}`;
  if (layer.startsWith('xor:')) return toHex(bytes.map((b) => b ^ Number(layer.slice(4))));
  throw new RangeError(`unknown layer ${layer}`);
}

export const proxyFamily: ChallengeFamily<ProxyParams, ProxyPayload, ProxyAnswer> = {
  type: 'proxy',
  answerSchema: z.object({ inner: z.string().max(65536) }),
  generate(size, _noise, rng) {
    let inner = '';
    while (inner.length < size) inner += (inner ? ' ' : '') + rng.pick(WORDS);
    inner = fromUtf8(utf8(inner.slice(0, size)));
    const count = Math.max(1, Math.min(6, Math.floor(size / 16)));
    const layers: string[] = [];
    for (let i = 0; i < count; i++) layers.push(rng.pick(['hex', 'base64', 'lenprefix', `xor:${rng.int(1, 255)}`]));
    let payload = inner;
    for (const layer of layers) payload = wrap(layer, payload);
    return { params: { layers }, payload: { payload }, answer: { inner } };
  },
  check: (e, s) => e.inner === s.inner,
};
```

`packages/rules/src/capture/cloud.ts`:

```ts
import { z } from 'zod';
import { fnv1a32Hex, utf8, type ChallengeFamily } from './common.js';

/**
 * Cloud: consistent hashing with virtual nodes.
 * Ring points: for each node and i in [0, vnodes): position = FNV-1a-32 of UTF-8 "<node>#<i>".
 * A key maps to the node of the first ring point with position >= FNV-1a-32(key), wrapping to the
 * smallest position. Ties on position go to the node that sorts first. Keys starting with '#' are
 * comments to ignore (noise). Answer: key -> node for every real key.
 */
export interface CloudParams {
  nodes: string[];
  vnodes: number;
}
export interface CloudPayload {
  keys: string[];
}
export interface CloudAnswer {
  placement: Record<string, string>;
}

const h = (s: string) => parseInt(fnv1a32Hex(utf8(s)), 16);

export function placeKeys(params: CloudParams, keys: readonly string[]): Record<string, string> {
  const ring: Array<{ pos: number; node: string }> = [];
  for (const node of params.nodes) for (let i = 0; i < params.vnodes; i++) ring.push({ pos: h(`${node}#${i}`), node });
  ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key.startsWith('#')) continue;
    const pos = h(key);
    const hit = ring.find((r) => r.pos >= pos) ?? ring[0]!;
    out[key] = hit.node;
  }
  return out;
}

export const cloudFamily: ChallengeFamily<CloudParams, CloudPayload, CloudAnswer> = {
  type: 'cloud',
  answerSchema: z.object({ placement: z.record(z.string(), z.string()) }),
  generate(size, noise, rng) {
    const nodes = Array.from({ length: rng.int(3, 8) }, (_, i) => `node-${i}`);
    const vnodes = 2 ** rng.int(3, 6);
    const keys: string[] = [];
    for (let i = 0; i < size; i++) keys.push(`key-${rng.int(0, 1_000_000)}`);
    const decoys = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < decoys; i++) keys.splice(rng.int(0, keys.length), 0, `#key-${rng.int(0, 1_000_000)}`);
    const params = { nodes, vnodes };
    return { params, payload: { keys }, answer: { placement: placeKeys(params, keys) } };
  },
  check: (e, s) => Object.keys(e.placement).length === Object.keys(s.placement).length && Object.entries(e.placement).every(([k, v]) => s.placement[k] === v),
};
```

`packages/rules/src/capture/stack.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Stack: run a tiny stack machine and report the top of the stack.
 * Ops: `push n`, `add`, `sub`, `mul` (32-bit signed wraparound), `dup`, `swap`, `drop`, `jz k`
 * (pop; jump to index k when zero), `jmp k`, `nop`. Popping an empty stack yields 0. Execution ends
 * at the end of the program or after 4096 steps. Answer: the top of the stack (0 when empty).
 */
export interface StackParams {
  maxSteps: number;
}
export interface StackPayload {
  program: string[];
}
export interface StackAnswer {
  top: number;
}

export const STACK_MAX_STEPS = 4096;

export function runStack(program: readonly string[], maxSteps = STACK_MAX_STEPS): number {
  const st: number[] = [];
  const pop = () => st.pop() ?? 0;
  let pc = 0;
  for (let steps = 0; pc < program.length && steps < maxSteps; steps++) {
    const [op, arg] = program[pc]!.split(' ');
    const k = Number(arg);
    pc++;
    switch (op) {
      case 'push':
        st.push(k | 0);
        break;
      case 'add': {
        const b = pop();
        st.push((pop() + b) | 0);
        break;
      }
      case 'sub': {
        const b = pop();
        st.push((pop() - b) | 0);
        break;
      }
      case 'mul': {
        const b = pop();
        st.push(Math.imul(pop(), b));
        break;
      }
      case 'dup': {
        const a = pop();
        st.push(a, a);
        break;
      }
      case 'swap': {
        const b = pop();
        const a = pop();
        st.push(b, a);
        break;
      }
      case 'drop':
        pop();
        break;
      case 'jz':
        if (pop() === 0) pc = k;
        break;
      case 'jmp':
        pc = k;
        break;
      case 'nop':
        break;
    }
  }
  return st[st.length - 1] ?? 0;
}

export const stackFamily: ChallengeFamily<StackParams, StackPayload, StackAnswer> = {
  type: 'stack',
  answerSchema: z.object({ top: z.number().int() }),
  generate(size, noise, rng) {
    const program: string[] = [];
    for (let i = 0; i < size; i++) {
      const r = rng.float();
      if (r < 0.4) program.push(`push ${rng.int(-50, 50)}`);
      else if (r < 0.75) program.push(rng.pick(['add', 'sub', 'mul', 'dup', 'swap', 'drop']));
      else if (r < 0.85) program.push(`jz ${rng.int(i + 1, size)}`); // forward jumps only: always terminates
      else if (r < 0.9) program.push(`jmp ${rng.int(i + 1, size)}`);
      else program.push(`push ${rng.int(1, 9)}`);
    }
    const nops = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < nops; i++) {
      // inserting shifts jump targets, so append nops at the end instead
      program.push('nop');
    }
    return { params: { maxSteps: STACK_MAX_STEPS }, payload: { program }, answer: { top: runStack(program) } };
  },
  check: (e, s) => e.top === s.top,
};
```

`packages/rules/src/capture/heap.ts`:

```ts
import { z } from 'zod';
import type { ChallengeFamily } from './common.js';

/**
 * Heap: find the leaked allocations.
 * Replay `alloc` / `free` events in order. A `free` of an id that is not currently allocated (unknown
 * or already freed) is ignored (noise). Answer: ids still allocated at the end, ascending.
 */
export type HeapEvent = { op: 'alloc'; id: number; size: number } | { op: 'free'; id: number };
export interface HeapParams {
  events: number;
}
export interface HeapPayload {
  events: HeapEvent[];
}
export interface HeapAnswer {
  leaked: number[];
}

export function leaked(events: readonly HeapEvent[]): number[] {
  const live = new Set<number>();
  for (const e of events) {
    if (e.op === 'alloc') live.add(e.id);
    else live.delete(e.id);
  }
  return [...live].sort((a, b) => a - b);
}

export const heapFamily: ChallengeFamily<HeapParams, HeapPayload, HeapAnswer> = {
  type: 'heap',
  answerSchema: z.object({ leaked: z.array(z.number().int()).max(16384) }),
  generate(size, noise, rng) {
    const events: HeapEvent[] = [];
    const live: number[] = [];
    let next = 1;
    for (let i = 0; i < size; i++) {
      if (live.length > 0 && rng.chance(0.4)) {
        const idx = rng.int(0, live.length - 1);
        events.push({ op: 'free', id: live[idx]! });
        live.splice(idx, 1);
      } else {
        const id = next++;
        live.push(id);
        events.push({ op: 'alloc', id, size: 2 ** rng.int(3, 12) });
      }
    }
    const bad = [0, Math.floor(size / 8), Math.floor(size / 4)][noise]!;
    for (let i = 0; i < bad; i++) events.splice(rng.int(0, events.length), 0, { op: 'free', id: rng.chance(0.5) ? next + i : rng.int(1, next) });
    return { params: { events: events.length }, payload: { events }, answer: { leaked: leaked(events) } };
  },
  check: (e, s) => e.leaked.length === s.leaked.length && e.leaked.every((v, i) => v === s.leaked[i]),
};
```

The final `packages/rules/src/capture/index.ts`:

```ts
import type { Noise } from '../content/items.js';
import type { Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { bufferFamily } from './buffer.js';
import { cacheFamily } from './cache.js';
import { cloudFamily } from './cloud.js';
import { fromHex, fromUtf8, toHex, utf8, type ChallengeFamily } from './common.js';
import { cryptoFamily } from './crypto.js';
import { glitchFamily } from './glitch.js';
import { heapFamily } from './heap.js';
import { kernelFamily } from './kernel.js';
import { nullFamily } from './null.js';
import { packetFamily } from './packet.js';
import { proxyFamily } from './proxy.js';
import { rootFamily } from './root.js';
import { sha256 } from './sha256.js';
import { shellFamily } from './shell.js';
import { signalFamily } from './signal.js';
import { socketFamily } from './socket.js';
import { stackFamily } from './stack.js';
import { threadFamily } from './thread.js';

export { sha256 };

const FAMILIES: Record<TypeId, ChallengeFamily> = {
  kernel: kernelFamily as ChallengeFamily,
  packet: packetFamily as ChallengeFamily,
  crypto: cryptoFamily as ChallengeFamily,
  cache: cacheFamily as ChallengeFamily,
  thread: threadFamily as ChallengeFamily,
  signal: signalFamily as ChallengeFamily,
  socket: socketFamily as ChallengeFamily,
  buffer: bufferFamily as ChallengeFamily,
  shell: shellFamily as ChallengeFamily,
  root: rootFamily as ChallengeFamily,
  null: nullFamily as ChallengeFamily,
  glitch: glitchFamily as ChallengeFamily,
  proxy: proxyFamily as ChallengeFamily,
  cloud: cloudFamily as ChallengeFamily,
  stack: stackFamily as ChallengeFamily,
  heap: heapFamily as ChallengeFamily,
};

export function getFamily(type: TypeId): ChallengeFamily {
  const family = FAMILIES[type];
  if (!family) throw new RangeError(`no capture challenge family for type ${type}`);
  return family;
}

export function hasFamily(type: TypeId): boolean {
  return FAMILIES[type] !== undefined;
}

/**
 * Wire shape of a challenge (what the operator receives).
 * single: `params`/`payload` belong to families[0].
 * chain:  payload is a {@link ChainPayload}. The submitted answer is the second stage's answer.
 */
export interface PublicChallenge {
  kind: 'single' | 'chain';
  families: TypeId[];
  params: unknown;
  payload: unknown;
}

export interface Challenge extends PublicChallenge {
  /** Expected final answer. Server-side only. */
  answer: unknown;
}

/**
 * Payload of a chained (dual-type) challenge.
 *
 * `first` is stage one in the clear. `sealed` is stage two, `{ params, payload }`, sealed with a key derived from the
 * answer to stage one (see {@link sealStage}):
 *
 * - canonical answer: `JSON.stringify(firstAnswer)` — compact JSON (no whitespace) with the family's own key order,
 *   e.g. `{"checksum":"0a1b2c3d"}`. Players must reproduce it byte for byte.
 * - `key = SHA-256(UTF-8(canonicalAnswer))`.
 * - keystream block i (i = 0, 1, 2, ...) = `SHA-256(key ‖ u32be(i))`; the keystream is the blocks concatenated and cut
 *   to the plaintext length.
 * - `sealed = lowercase hex(UTF-8(JSON.stringify({ params, payload })) XOR keystream)`.
 */
export interface ChainPayload {
  first: { params: unknown; payload: unknown };
  sealed: string;
}

/** The canonical form of a stage answer used to derive the chain key: compact JSON in the family's key order. */
export function canonicalAnswer(answer: unknown): string {
  return JSON.stringify(answer);
}

function keystream(firstAnswer: unknown, length: number): Uint8Array {
  const key = sha256(utf8(canonicalAnswer(firstAnswer)));
  const out = new Uint8Array(length);
  const input = new Uint8Array(key.length + 4);
  input.set(key);
  const counter = new DataView(input.buffer, key.length, 4);
  for (let i = 0; i * 32 < length; i++) {
    counter.setUint32(0, i);
    const block = sha256(input);
    out.set(block.subarray(0, Math.min(32, length - i * 32)), i * 32);
  }
  return out;
}

function xorKeystream(data: Uint8Array, firstAnswer: unknown): Uint8Array {
  const ks = keystream(firstAnswer, data.length);
  return data.map((b, i) => b ^ ks[i]!);
}

/** Seal a stage-two plaintext with the SHA-256 keystream derived from the stage-one answer; returns lowercase hex. */
export function sealStage(plaintext: string, firstAnswer: unknown): string {
  return toHex(xorKeystream(utf8(plaintext), firstAnswer));
}

/** Inverse of {@link sealStage}. */
export function unsealStage(sealed: string, firstAnswer: unknown): string {
  return fromUtf8(xorKeystream(fromHex(sealed), firstAnswer));
}

/** Types are the target daemon's types (1 or 2). Both stages of a chain use the same size and noise. */
export function generateChallenge(types: readonly TypeId[], size: number, noise: Noise, rng: Rng): Challenge {
  if (types.length === 1) {
    const stage = getFamily(types[0]!).generate(size, noise, rng);
    return { kind: 'single', families: [types[0]!], params: stage.params, payload: stage.payload, answer: stage.answer };
  }
  if (types.length !== 2) throw new RangeError('a daemon has 1 or 2 types');
  const [a, b] = types as readonly [TypeId, TypeId];
  const first = getFamily(a).generate(size, noise, rng);
  const second = getFamily(b).generate(size, noise, rng);
  const sealed = sealStage(JSON.stringify({ params: second.params, payload: second.payload }), first.answer);
  const payload: ChainPayload = { first: { params: first.params, payload: first.payload }, sealed };
  return { kind: 'chain', families: [a, b], params: {}, payload, answer: second.answer };
}

export function publicChallenge(challenge: Challenge): PublicChallenge {
  const { kind, families, params, payload } = challenge;
  return { kind, families, params, payload };
}

export type CheckResult = 'correct' | 'wrong' | 'invalid';

export function checkAnswer(challenge: Challenge, submitted: unknown): CheckResult {
  const family = getFamily(challenge.families[challenge.families.length - 1]!);
  const parsed = family.answerSchema.safeParse(submitted);
  if (!parsed.success) return 'invalid';
  return family.check(challenge.answer, parsed.data) ? 'correct' : 'wrong';
}
```

Add to `packages/rules/src/index.ts`:

```ts
export type { ProxyParams, ProxyPayload, ProxyAnswer } from './capture/proxy.js';
export type { CloudParams, CloudPayload, CloudAnswer } from './capture/cloud.js';
export type { StackParams, StackPayload, StackAnswer } from './capture/stack.js';
export type { HeapParams, HeapPayload, HeapAnswer, HeapEvent } from './capture/heap.js';
```

- [ ] **Step 4: Run to verify pass, commit, push**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — 24 files, 241 tests (16 families × 5 property tests + chaining across all 16 pairs).

```bash
git add -A
git commit -m "feat(rules): proxy, cloud, stack and heap challenges; all 16 families registered"
git push origin main
gh run watch --repo Zaphiruz/daemonet --exit-status
```

Expected: CI green. From this deploy on, every wild daemon in `lo` (all 50 base forms) can be captured; the SDK exports every family's `Params`/`Payload`/`Answer` types, and `examples/starter-bot` still solves only Packet — the other fifteen are the players' to write.
