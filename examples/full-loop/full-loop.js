// Daemonet "full loop" operator script: fight everything, capture everything (all 16 challenge families, single and
// chained), keep RAM and the toolbox in order at the host, take tickets, evolve, and travel up the subnets.
// Paste the whole file into the web client's Script tab and press Run. It uses only the public SDK (`game`).

// ---------------------------------------------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------------------------------------------

/** Travel to the next subnet (lo -> lan -> dmz -> backbone -> darknet -> cloudnet) once a daemon is strong enough. */
export const TRAVEL = true;
/** Spend bits at the host shop on capture tools. */
export const SPEND_BITS = true;
/** Keep at least this many sniff and this many tap in the inventory (bought at the host while bits allow). */
export const TOOL_FLOOR = 3;
/** Start a capture once the target's HP fraction drops below this (daemons hold fire below it). */
export const CAPTURE_HP_PCT = 0.35;

// ---------------------------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} hex */
function fromHex(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {Uint8Array} bytes */
function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const fnvHex = (/** @type {Uint8Array} */ bytes) => fnv1a32(bytes).toString(16).padStart(8, '0');

/** Compare by Unicode code point (shell `sort`). */
function compareCodePoints(/** @type {string} */ a, /** @type {string} */ b) {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Capture solvers: one per family, (params, payload) -> answer object in the family's own key order
// ---------------------------------------------------------------------------------------------------------------

/** @type {Record<string, (params: any, payload: any) => unknown>} */
export const SOLVERS = {
  /** Keep fragments whose crc checks out, reassemble by seq, FNV-1a of the message. */
  packet(params, payload) {
    const chunks = new Map();
    for (const f of payload.fragments) {
      const data = fromHex(f.data);
      let sum = f.seq;
      for (const b of data) sum += b;
      if ((sum & 0xff) === f.crc) chunks.set(f.seq, data);
    }
    const message = new Uint8Array(params.count * 4);
    for (let seq = 0; seq < params.count; seq++) message.set(chunks.get(seq) ?? new Uint8Array(4), seq * 4);
    return { checksum: fnvHex(message) };
  },

  /** Recover the repeating XOR key from the known plaintext, then decrypt. */
  crypto(params, payload) {
    const ct = fromHex(payload.ciphertext);
    const k = params.keyLength;
    const key = new Uint8Array(k);
    const { offset, text } = params.known;
    for (let j = 0; j < text.length; j++) key[(offset + j) % k] = ct[offset + j] ^ text.charCodeAt(j);
    let plaintext = '';
    for (let i = 0; i < ct.length; i++) plaintext += String.fromCharCode(ct[i] ^ key[i % k]);
    return { plaintext };
  },

  /** Hamming(7,4): the syndrome is the flipped position; data bits sit at positions 3, 5, 6, 7. */
  glitch(_params, payload) {
    const nibbles = payload.blocks.map((/** @type {number} */ block) => {
      const bit = (/** @type {number} */ pos) => (block >> (pos - 1)) & 1;
      const s1 = bit(1) ^ bit(3) ^ bit(5) ^ bit(7);
      const s2 = bit(2) ^ bit(3) ^ bit(6) ^ bit(7);
      const s3 = bit(4) ^ bit(5) ^ bit(6) ^ bit(7);
      const syndrome = s1 | (s2 << 1) | (s3 << 2);
      const fixed = syndrome ? block ^ (1 << (syndrome - 1)) : block;
      const at = (/** @type {number} */ pos) => (fixed >> (pos - 1)) & 1;
      return (at(3) << 3) | (at(5) << 2) | (at(6) << 1) | at(7);
    });
    let hex = '';
    for (const n of nibbles) hex += n.toString(16);
    return { hex };
  },

  /** Follow `next` pointers from the head and sum the values. */
  null(params, payload) {
    const memory = payload.memory;
    let sum = 0;
    let addr = params.head;
    for (let steps = 0; addr !== 0 && steps <= memory.length; steps++) {
      sum += memory[addr];
      addr = memory[addr + 1];
    }
    return { sum };
  },

  /** Round-robin: admit arrivals (arrival, pid) before re-queueing the process just run. */
  kernel(params, payload) {
    const live = payload.processes.filter((/** @type {any} */ p) => p.burst > 0).map((/** @type {any} */ p) => ({ pid: p.pid, arrival: p.arrival, left: p.burst }));
    const pending = [...live].sort((a, b) => a.arrival - b.arrival || a.pid - b.pid);
    /** @type {typeof live} */
    const queue = [];
    const order = [];
    let t = 0;
    let next = 0;
    const admit = () => {
      while (next < pending.length && pending[next].arrival <= t) queue.push(pending[next++]);
    };
    let head = 0;
    while (next < pending.length || head < queue.length) {
      admit();
      if (head === queue.length) {
        t = pending[next].arrival;
        continue;
      }
      const p = queue[head++];
      const run = Math.min(params.quantum, p.left);
      t += run;
      p.left -= run;
      admit();
      if (p.left === 0) order.push(p.pid);
      else queue.push(p);
    }
    return { order };
  },

  /** LRU hits; '#' entries are comments. */
  cache(params, payload) {
    const lru = new Map();
    let hits = 0;
    for (const key of payload.trace) {
      if (key.startsWith('#')) continue;
      if (lru.has(key)) {
        hits++;
        lru.delete(key);
      } else if (lru.size >= params.capacity) lru.delete(lru.keys().next().value);
      lru.set(key, true);
    }
    return { hits };
  },

  /** First (i, j) pair of conflicting accesses with disjoint lock sets. */
  thread(_params, payload) {
    /** @type {Map<number, Set<string>>} */
    const held = new Map();
    /** @type {Array<{ i: number, thread: number, obj: string, write: boolean, locks: string[] }>} */
    const accesses = [];
    payload.events.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
      let locks = held.get(e.thread);
      if (!locks) held.set(e.thread, (locks = new Set()));
      if (e.op === 'lock') locks.add(e.obj);
      else if (e.op === 'unlock') locks.delete(e.obj);
      else accesses.push({ i, thread: e.thread, obj: e.obj, write: e.op === 'write', locks: [...locks] });
    });
    for (let a = 0; a < accesses.length; a++) {
      const x = accesses[a];
      for (let b = a + 1; b < accesses.length; b++) {
        const y = accesses[b];
        if (x.thread === y.thread || x.obj !== y.obj || !(x.write || y.write)) continue;
        if (x.locks.some((l) => y.locks.includes(l))) continue;
        return { race: [x.i, y.i] };
      }
    }
    return { race: [-1, -1] };
  },

  /** Masked signals coalesce until unmaskAt, then flush in ascending number. */
  signal(params, payload) {
    const masked = new Set(params.masked);
    const pending = new Set();
    const order = [];
    let lifted = false;
    const sorted = payload.signals.map((/** @type {any} */ s, /** @type {number} */ i) => ({ t: s.t, sig: s.sig, i })).sort((/** @type {any} */ a, /** @type {any} */ b) => a.t - b.t || a.i - b.i);
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
  },

  /** TCP server state machine per connection (listed connections first, then others in first-seen order). */
  socket(params, payload) {
    /** @type {Record<string, Record<string, string>>} */
    const transitions = {
      CLOSED: { SYN: 'SYN_RCVD' },
      SYN_RCVD: { ACK: 'ESTABLISHED', SYNACK: 'ESTABLISHED' },
      ESTABLISHED: { FIN: 'CLOSE_WAIT' },
      CLOSE_WAIT: { FIN: 'LAST_ACK' },
      LAST_ACK: { ACK: 'CLOSED' },
    };
    /** @type {Record<string, string>} */
    const states = {};
    for (const c of params.connections) states[c] = 'CLOSED';
    for (const s of payload.segments) {
      const cur = states[s.conn] ?? 'CLOSED';
      states[s.conn] = s.flag === 'RST' ? 'CLOSED' : (transitions[cur][s.flag] ?? cur);
    }
    return { states };
  },

  /** Overwriting ring buffer. */
  buffer(params, payload) {
    /** @type {string[]} */
    const buf = [];
    for (const op of payload.ops) {
      if (op === 'r') buf.shift();
      else if (op.startsWith('w:')) {
        if (buf.length >= params.capacity) buf.shift();
        buf.push(op.slice(2));
      }
    }
    return { contents: buf.join('') };
  },

  /** grep / sort / uniq / cut / wc over the non-blank input lines. */
  shell(params, payload) {
    /** @type {string[]} */
    let out = payload.lines.filter((/** @type {string} */ l) => l !== '');
    for (const stage of params.pipeline.split(' | ')) {
      const [cmd, ...args] = stage.split(' ');
      if (cmd === 'grep') out = out.filter((l) => l.includes(args[0]));
      else if (cmd === 'sort') out = [...out].sort(compareCodePoints);
      else if (cmd === 'uniq') out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
      else if (cmd === 'cut') {
        const delim = args[0].slice(2);
        const field = Number(args[1].slice(2)) - 1;
        out = out.map((l) => l.split(delim)[field] ?? '');
      } else if (cmd === 'wc') out = [String(out.length)];
    }
    return { output: out };
  },

  /** owner > user ACL > any matching group ACL > file group > other. */
  root(params, payload) {
    const idx = { r: 0, w: 1, x: 2 };
    const has = (/** @type {string} */ triple, /** @type {'r' | 'w' | 'x'} */ op) => triple[idx[op]] === op;
    let allowed = '';
    for (const req of payload.requests) {
      let ok;
      if (req.user === params.owner) ok = has(params.mode.slice(0, 3), req.op);
      else {
        const user = params.acl.find((/** @type {any} */ a) => a.who === `user:${req.user}`);
        const groups = params.acl.filter((/** @type {any} */ a) => a.who.startsWith('group:') && req.groups.includes(a.who.slice(6)));
        if (user) ok = has(user.perms, req.op);
        else if (groups.length) ok = groups.some((/** @type {any} */ a) => has(a.perms, req.op));
        else if (req.groups.includes(params.group)) ok = has(params.mode.slice(3, 6), req.op);
        else ok = has(params.mode.slice(6, 9), req.op);
      }
      allowed += ok ? '1' : '0';
    }
    return { allowed };
  },

  /** Unwrap hex / base64 / xor:n / lenprefix from the last layer back to the first. */
  proxy(params, payload) {
    let text = payload.payload;
    for (let i = params.layers.length - 1; i >= 0; i--) {
      const layer = params.layers[i];
      if (layer === 'hex') text = decoder.decode(fromHex(text));
      else if (layer === 'base64') text = decoder.decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
      else if (layer === 'lenprefix') text = text.slice(text.indexOf(':') + 1);
      else if (layer.startsWith('xor:')) {
        const n = Number(layer.slice(4));
        text = decoder.decode(fromHex(text).map((b) => b ^ n));
      }
    }
    return { inner: text };
  },

  /** Consistent hashing: first ring point at or after the key's hash, wrapping to the first point. */
  cloud(params, payload) {
    const h = (/** @type {string} */ s) => fnv1a32(encoder.encode(s));
    /** @type {Array<{ pos: number, node: string }>} */
    const ring = [];
    for (const node of params.nodes) for (let i = 0; i < params.vnodes; i++) ring.push({ pos: h(`${node}#${i}`), node });
    ring.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    /** @type {Record<string, string>} */
    const placement = {};
    for (const key of payload.keys) {
      if (key.startsWith('#')) continue;
      const pos = h(key);
      let lo = 0;
      let hi = ring.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ring[mid].pos >= pos) hi = mid;
        else lo = mid + 1;
      }
      placement[key] = (ring[lo] ?? ring[0]).node;
    }
    return { placement };
  },

  /** A tiny stack machine, 32-bit signed arithmetic, empty pops yield 0. */
  stack(params, payload) {
    const program = payload.program;
    const maxSteps = params.maxSteps ?? 4096;
    /** @type {number[]} */
    const st = [];
    const pop = () => (st.length ? /** @type {number} */ (st.pop()) : 0);
    let pc = 0;
    for (let steps = 0; pc >= 0 && pc < program.length && steps < maxSteps; steps++) {
      const [op, arg] = program[pc].split(' ');
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
    return { top: st.length ? st[st.length - 1] : 0 };
  },

  /** Replay alloc/free; ids still allocated, ascending. */
  heap(_params, payload) {
    const live = new Set();
    for (const e of payload.events) {
      if (e.op === 'alloc') live.add(e.id);
      else live.delete(e.id);
    }
    return { leaked: [...live].sort((a, b) => a - b) };
  },
};

/** Solve one stage of a family. */
export function solveStage(/** @type {string} */ family, /** @type {unknown} */ params, /** @type {unknown} */ payload) {
  const solver = SOLVERS[family];
  if (!solver) throw new Error(`no solver for ${family}`);
  return solver(params, payload);
}

/** SHA-256 through WebCrypto (available in the sandbox worker and in Node). */
async function sha256(/** @type {BufferSource} */ data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Open a sealed chain stage: key = SHA-256(UTF-8(JSON.stringify(firstAnswer))), keystream block i =
 * SHA-256(key || u32be(i)), plaintext = sealed XOR keystream, parsed as JSON `{ params, payload }`.
 */
export async function unsealStage(/** @type {string} */ sealed, /** @type {unknown} */ firstAnswer) {
  const data = fromHex(sealed);
  const key = await sha256(encoder.encode(JSON.stringify(firstAnswer)));
  const blocks = Math.ceil(data.length / 32);
  const inputs = Array.from({ length: blocks }, (_, i) => {
    const input = new Uint8Array(36);
    input.set(key);
    new DataView(input.buffer).setUint32(32, i);
    return sha256(input);
  });
  const stream = await Promise.all(inputs);
  for (let i = 0; i < data.length; i++) data[i] ^= stream[i >> 5][i & 31];
  return JSON.parse(decoder.decode(data));
}

/**
 * Solve a public challenge (what `captureStart` carries). A chain's answer is the SECOND stage's answer.
 * @param {{ kind: 'single' | 'chain', families: string[], params: unknown, payload: any }} challenge
 */
export async function solve(challenge) {
  if (challenge.kind === 'single') return solveStage(challenge.families[0], challenge.params, challenge.payload);
  const { first, sealed } = challenge.payload;
  const firstAnswer = solveStage(challenge.families[0], first.params, first.payload);
  const second = await unsealStage(sealed, firstAnswer);
  return solveStage(challenge.families[1], second.params, second.payload);
}

