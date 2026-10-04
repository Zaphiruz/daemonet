/**
 * Reference solvers — TEST ONLY. Never import these from src/ (they must not ship in any package).
 * Each takes the public (params, payload) and returns the answer object.
 */
import { fnv1a32Hex, fromHex, fromUtf8, utf8, xorRepeating } from '../src/capture/common.js';
import type { CryptoParams, CryptoPayload } from '../src/capture/crypto.js';
import type { CacheParams, CachePayload } from '../src/capture/cache.js';
import type { CloudParams, CloudPayload } from '../src/capture/cloud.js';
import type { GlitchPayload } from '../src/capture/glitch.js';
import type { HeapPayload } from '../src/capture/heap.js';
import type { ProxyParams, ProxyPayload } from '../src/capture/proxy.js';
import type { StackParams, StackPayload } from '../src/capture/stack.js';
import type { KernelParams, KernelPayload } from '../src/capture/kernel.js';
import type { BufferParams, BufferPayload } from '../src/capture/buffer.js';
import type { RootParams, RootPayload } from '../src/capture/root.js';
import type { ShellParams, ShellPayload } from '../src/capture/shell.js';
import type { SignalParams, SignalPayload } from '../src/capture/signal.js';
import type { SocketParams, SocketPayload, SocketState } from '../src/capture/socket.js';
import type { ThreadPayload } from '../src/capture/thread.js';
import type { NullParams, NullPayload } from '../src/capture/null.js';
import { packetCrc, type PacketParams, type PacketPayload } from '../src/capture/packet.js';
import { unsealStage, type ChainPayload, type PublicChallenge } from '../src/capture/index.js';
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

const codePointCompare = (a: string, b: string): number => {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

export function solveShell(params: ShellParams, payload: ShellPayload): { output: string[] } {
  let out = payload.lines.filter((l) => l !== '');
  for (const stage of params.pipeline.split(' | ')) {
    const [cmd, ...args] = stage.split(' ');
    if (cmd === 'grep') out = out.filter((l) => l.includes(args[0]!));
    else if (cmd === 'sort') out = [...out].sort(codePointCompare);
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

export function solveStack(params: StackParams, payload: StackPayload): { top: number } {
  const st: number[] = [];
  const pop = () => st.pop() ?? 0;
  let pc = 0;
  for (let steps = 0; pc >= 0 && pc < payload.program.length && steps < params.maxSteps; steps++) {
    const [op, arg] = payload.program[pc]!.split(' ');
    const k = Number(arg);
    pc++;
    if (op === 'push') st.push(k | 0);
    else if (op === 'add') {
      const b = pop();
      st.push((pop() + b) | 0);
    } else if (op === 'sub') {
      const b = pop();
      st.push((pop() - b) | 0);
    } else if (op === 'mul') {
      const b = pop();
      st.push(Math.imul(pop(), b));
    } else if (op === 'dup') {
      const a = pop();
      st.push(a, a);
    } else if (op === 'swap') {
      const b = pop();
      const a = pop();
      st.push(b, a);
    } else if (op === 'drop') pop();
    else if (op === 'jz') {
      if (pop() === 0) pc = k;
    } else if (op === 'jmp') pc = k;
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
  packet: solvePacket,
  crypto: solveCrypto,
  glitch: solveGlitch,
  null: solveNull,
  kernel: solveKernel,
  cache: solveCache,
  thread: solveThread,
  signal: solveSignal,
  socket: solveSocket,
  buffer: solveBuffer,
  shell: solveShell,
  root: solveRoot,
  proxy: solveProxy,
  cloud: solveCloud,
  stack: solveStack,
  heap: solveHeap,
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
