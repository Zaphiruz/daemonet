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
// Game constants (mirrors of public rules content; the sandbox has no imports)
// ---------------------------------------------------------------------------------------------------------------

export const RAM_SLOTS = 8;
export const RUNNING_MAX = 2;
export const TICK_HZ = 16;
/** Travel works within this many tiles of the gateway. */
export const GATEWAY_RADIUS = 2;
export const OPEN_TICKETS_MAX = 2;
export const TICKETS_PER_DAY = 8;
/**
 * Commands that need the host (store/load/buy/restoreAll/acceptTicket) work within this many tiles of it.
 * HOST_RADIUS and LEASH_TILES live only in the sim (apps/sim), not in the public rules, so no test pins them.
 */
const HOST_RADIUS = 2;
/** Daemons stay within this many tiles of their operator (sim-only, see above). */
const LEASH_TILES = 8;
/** Fighting distance the operator keeps from its target. */
const ENGAGE_RANGE = 3;
const STATUS_EVERY_MS = 30_000;
/** After a refusal the same action waits this long before it is tried again; repeats double it up to LONG_COOLDOWN_TICKS. */
export const REFUSAL_COOLDOWN_TICKS = 2 * TICK_HZ;
/** The longest refusal cooldown; refusals that will not change soon (evolve, travel) start here. */
export const LONG_COOLDOWN_TICKS = 60 * TICK_HZ;
/** After a failed capture the target is hardened for 8192 ms (132 ticks): leave it to the daemons a little longer. */
export const FAILED_CAPTURE_COOLDOWN_TICKS = Math.ceil((8192 * TICK_HZ) / 1000) + TICK_HZ / 4;

/**
 * Sandbox log budget: a script may send 500 log lines in its whole lifetime (never refilled). Acks are quiet; event
 * lines are capped per status window; near the end only a rare status line is kept.
 */
export const LOG_BUDGET = 500;
/** Event lines (refusals, captures, travel, evolutions, tickets) allowed per 30 s status window. */
export const EVENT_LINES_PER_WINDOW = 4;

/**
 * Capture tools, cheapest first: link range in tiles, NPC shop price in bits, challenge deadline. The solvers answer
 * every noise level and size, so the cheapest tool whose range covers the distance is always the right pick.
 */
export const TOOLS = Object.freeze([
  { id: 'sniff', range: 4, price: 32, deadlineMs: 2048 },
  { id: 'tap', range: 6, price: 128, deadlineMs: 4096 },
  { id: 'mirror', range: 8, price: 512, deadlineMs: 4096 },
  { id: 'dump', range: 8, price: 2048, deadlineMs: 8192 },
]);

/** Every subnet's host node (all open subnets share the same layout; kernelspace is the Incident arena). */
export const HOSTS = Object.freeze({
  lo: { x: 16.5, y: 16.5 },
  lan: { x: 16.5, y: 16.5 },
  dmz: { x: 16.5, y: 16.5 },
  backbone: { x: 16.5, y: 16.5 },
  darknet: { x: 16.5, y: 16.5 },
  cloudnet: { x: 16.5, y: 16.5 },
  kernelspace: { x: 64.5, y: 112.5 },
});

/** Centres of the four spawn regions (lobby, uplink, cache, core), the same footprint in every open subnet. */
const REGION_CENTRES = Object.freeze([
  { x: 40, y: 26 },
  { x: 96, y: 28 },
  { x: 32, y: 92 },
  { x: 96, y: 92 },
]);

/** The order the script climbs the subnets in. */
export const ROUTE = Object.freeze(['lo', 'lan', 'dmz', 'backbone', 'darknet', 'cloudnet']);

/** Gateways between the open subnets and the level the best RAM daemon needs (the kernelspace Incident gateway is left out). */
export const GATEWAYS = Object.freeze({
  lo: [{ id: 'lo-lan', to: 'lan', level: 8 }],
  lan: [
    { id: 'lan-lo', to: 'lo', level: 0 },
    { id: 'lan-dmz', to: 'dmz', level: 16 },
  ],
  dmz: [
    { id: 'dmz-lan', to: 'lan', level: 0 },
    { id: 'dmz-backbone', to: 'backbone', level: 24 },
  ],
  backbone: [
    { id: 'backbone-dmz', to: 'dmz', level: 0 },
    { id: 'backbone-darknet', to: 'darknet', level: 32 },
    { id: 'backbone-cloudnet', to: 'cloudnet', level: 40 },
  ],
  darknet: [{ id: 'darknet-backbone', to: 'backbone', level: 0 }],
  cloudnet: [{ id: 'cloudnet-backbone', to: 'backbone', level: 0 }],
});

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

// ---------------------------------------------------------------------------------------------------------------
// Pure decision helpers (no client needed; unit-tested)
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {{ x: number, y: number }} Point */

const dist = (/** @type {Point} */ a, /** @type {Point} */ b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The cheapest capture tool held whose range covers `distance` (with half a tile to spare), or null when none does.
 * Without a distance: the cheapest tool held.
 * @param {Record<string, number>} inventory
 * @param {number} [distance]
 */
export function chooseTool(inventory, distance = 0) {
  return TOOLS.find((t) => (inventory[t.id] ?? 0) > 0 && distance <= t.range - 0.5) ?? null;
}

/** Whether any capture tool is held. */
export const holdsTool = (/** @type {Record<string, number>} */ inventory) => TOOLS.some((t) => (inventory[t.id] ?? 0) > 0);

/**
 * A wild daemon this operator may fight: not owned, not tagged by another operator, not an immune Incident boss.
 * @param {{ owner: string | null, taggedBy: string | null, boss?: boolean, shielded?: boolean }} d
 * @param {string} myId
 */
export function attackable(d, myId) {
  return d.owner === null && (d.taggedBy === null || d.taggedBy === myId) && !d.shielded;
}

/**
 * RAM daemons to store at the host: the duplicates of each species (everything but the best one, by level then xp),
 * never a running daemon; crashed ones first, then lowest level first.
 * @param {Array<{ id: string, species: string, level: number, xp?: number, crashed?: boolean }>} ram
 * @param {readonly string[]} running
 */
export function storeCandidates(ram, running) {
  /** @type {Map<string, typeof ram>} */
  const bySpecies = new Map();
  for (const d of ram) {
    const list = bySpecies.get(d.species) ?? [];
    list.push(d);
    bySpecies.set(d.species, list);
  }
  /** @type {typeof ram} */
  const out = [];
  for (const list of bySpecies.values()) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) => b.level - a.level || (b.xp ?? 0) - (a.xp ?? 0));
    // The best of the species stays; a running duplicate stays too.
    for (const d of ranked.slice(1)) if (!running.includes(d.id)) out.push(d);
  }
  return out.sort((a, b) => Number(!a.crashed) - Number(!b.crashed) || a.level - b.level).map((d) => d.id);
}

/**
 * The healthy RAM daemon to run next (highest level first), or null.
 * @param {Array<{ id: string, level: number, crashed: boolean, hp: number }>} ram
 * @param {readonly string[]} running
 */
export function nextToRun(ram, running) {
  const ready = ram.filter((d) => !d.crashed && d.hp > 0 && !running.includes(d.id));
  ready.sort((a, b) => b.level - a.level);
  return ready[0]?.id ?? null;
}

/**
 * The first gateway to take towards the next subnet on {@link ROUTE}, or null when staying.
 * `reached` is the furthest ROUTE index this operator has been to. The next goal is ROUTE[reached + 1]; the path to
 * it may pass through other subnets (darknet -> backbone -> cloudnet), and every hop's level must be met.
 * @param {string} current
 * @param {number} bestLevel highest level in RAM
 * @param {number} reached
 * @returns {{ id: string, to: string, level: number } | null}
 */
export function nextGateway(current, bestLevel, reached) {
  const goal = ROUTE[Math.max(reached, ROUTE.indexOf(current)) + 1];
  if (!goal || !(current in GATEWAYS)) return null;
  // Breadth-first search over the gateway graph, remembering the first hop and the highest level on the way.
  /** @type {Array<{ at: string, first: { id: string, to: string, level: number } | null, need: number }>} */
  const queue = [{ at: current, first: null, need: 0 }];
  const seen = new Set([current]);
  while (queue.length) {
    const step = /** @type {(typeof queue)[number]} */ (queue.shift());
    if (step.at === goal) return step.first && bestLevel >= step.need ? step.first : null;
    for (const g of GATEWAYS[/** @type {keyof typeof GATEWAYS} */ (step.at)] ?? []) {
      if (seen.has(g.to)) continue;
      seen.add(g.to);
      queue.push({ at: g.to, first: step.first ?? g, need: Math.max(step.need, g.level) });
    }
  }
  return null;
}

/**
 * Where to stand to leave a telegraphed circle: straight out from its centre, `margin` tiles past the edge,
 * clamped inside the 128 x 128 map.
 * @param {Point} pos
 * @param {{ x: number, y: number, radius: number }} circle
 */
export function escapePoint(pos, circle, margin = 2) {
  let dx = pos.x - circle.x;
  let dy = pos.y - circle.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const r = circle.radius + margin;
  const clamp = (/** @type {number} */ v) => Math.min(125.5, Math.max(2.5, v));
  return { x: clamp(circle.x + dx * r), y: clamp(circle.y + dy * r) };
}

/** The circle (if any) that is about to land on `pos`. */
export function dangerAt(/** @type {Point} */ pos, /** @type {Array<{ x: number, y: number, radius: number, atTick: number }>} */ dangers, /** @type {number} */ tick) {
  return dangers.find((d) => d.atTick >= tick && dist(pos, d) <= d.radius + 0.5) ?? null;
}

/**
 * Today's tickets worth accepting: `clear` and `capture` ones not yet tried, while there is room.
 * @param {Array<{ index: number, kind: string }>} board
 * @param {{ tickets: Array<{ index: number, subnet: string, day: string }>, ticketsToday: number }} me
 * @param {string} subnet
 * @param {string} day
 * @param {Set<string>} tried keys `${day}|${subnet}|${index}` already accepted or refused
 */
export function ticketsToAccept(board, me, subnet, day, tried) {
  if (me.tickets.length >= OPEN_TICKETS_MAX || me.ticketsToday >= TICKETS_PER_DAY) return [];
  return board
    .filter((t) => t.kind === 'clear' || t.kind === 'capture')
    .filter((t) => !tried.has(`${day}|${subnet}|${t.index}`))
    .filter((t) => !me.tickets.some((o) => o.subnet === subnet && o.day === day && o.index === t.index))
    .map((t) => t.index);
}

/**
 * Tool purchases that would bring sniff and tap up to the floor, as far as the bits go (cheapest first).
 * @param {Record<string, number>} inventory
 * @param {number} bits
 * @param {number} floor
 */
export function toolsToBuy(inventory, bits, floor = TOOL_FLOOR) {
  /** @type {Array<{ item: string, qty: number }>} */
  const out = [];
  let left = bits;
  for (const id of ['sniff', 'tap']) {
    const price = /** @type {{ price: number }} */ (TOOLS.find((t) => t.id === id)).price;
    const want = Math.max(0, floor - (inventory[id] ?? 0));
    const qty = Math.min(want, Math.floor(left / price));
    if (qty > 0) {
      out.push({ item: id, qty });
      left -= qty * price;
    }
  }
  return out;
}

/**
 * A RAM daemon's first evolution that is met and reached, as `{ daemonId, form }`, or null. Daemons for which
 * `ready(id)` is false (an evolve refusal cooling down) are skipped so they do not block the others.
 * @param {Array<{ id: string, level: number, evolutions?: Array<{ form: string, level: number, met: boolean }> }>} ram
 * @param {(daemonId: string) => boolean} [ready]
 */
export function evolutionReady(ram, ready = () => true) {
  for (const d of ram) {
    if (!ready(d.id)) continue;
    const option = (d.evolutions ?? []).find((o) => o.met && d.level >= o.level);
    if (option) return { daemonId: d.id, form: option.form };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------------------------

/** @param {import('@daemonet/sdk').GameClient} game */
export default async function main(game) {
  const op = game.operator;

  // --- loop state -----------------------------------------------------------------------------------------------
  let busy = false;
  /** label -> tick before which the action is not retried (after a refusal) */
  const cooldown = new Map();
  /** label -> refusals in a row (each one doubles the cooldown, up to LONG_COOLDOWN_TICKS) */
  const refusals = new Map();
  /** wild daemon id -> tick before which it is not captured again (after a failed capture) */
  const targetCooldown = new Map();
  /** captureId -> what the result line reports */
  const captures = new Map();
  /** @type {string | null} the target of the last capture command (until its captureStart names it) */
  let lastCaptureTarget = null;
  let diskFull = false;
  let diskCapacity = game.self.diskCapacity;
  let reached = ROUTE.indexOf(game.subnet);
  /** @type {Array<{ x: number, y: number, radius: number, atTick: number }>} */
  let dangers = [];
  /** tick until which the operator stays put (restoreAll channel) */
  let holdUntil = 0;
  /** @type {Set<string>} */
  const triedTickets = new Set();
  /** @type {{ x: number, y: number, tick: number } | null} */
  let lastMove = null;
  let wanderIndex = 0;
  let lastStatus = 0;
  const stats = { captured: 0, failed: 0, evolved: 0, tickets: 0, bitsEarned: 0, levelUps: 0 };
  /** daemon id -> tick of its last move order */
  const daemonMoves = new Map();

  // --- logging within the sandbox's lifetime budget ---------------------------------------------------------------
  let linesUsed = 0;
  let windowLines = 0;
  let suppressed = 0;
  const write = (/** @type {string} */ line) => {
    linesUsed++;
    console.log(`[t${game.tick}] ${line}`);
  };
  /** An event line: at most EVENT_LINES_PER_WINDOW per status window, none once the budget runs low. */
  const event = (/** @type {string} */ line) => {
    if (windowLines >= EVENT_LINES_PER_WINDOW || linesUsed >= LOG_BUDGET - 50) {
      suppressed++;
      return;
    }
    windowLines++;
    write(line);
  };
  const ready = (/** @type {string} */ label) => (cooldown.get(label) ?? -1) <= game.tick;

  /**
   * Issue one command if nothing is in flight. Acks are silent; a refusal is logged (as an event line) and puts
   * `label` on a cooldown that doubles with every refusal in a row.
   * @param {string} label
   * @param {() => Promise<unknown>} run
   * @param {{ ok?: (result: any) => void, err?: (message: string) => void, cooldownTicks?: number }} [after]
   */
  const act = (label, run, after = {}) => {
    if (busy || !ready(label)) return false;
    busy = true;
    run()
      .then(
        (result) => {
          refusals.delete(label);
          after.ok?.(result);
        },
        (err) => {
          const message = String(err?.message ?? err);
          const n = (refusals.get(label) ?? 0) + 1;
          refusals.set(label, n);
          const wait = Math.min(LONG_COOLDOWN_TICKS, (after.cooldownTicks ?? REFUSAL_COOLDOWN_TICKS) * 2 ** (n - 1));
          cooldown.set(label, game.tick + wait);
          event(`refused ${label}: ${err?.code ?? 'E?'} ${message} (retry in ${Math.round(wait / TICK_HZ)} s)`);
          if (/Disk is full|RAM and Disk are full/.test(message)) diskFull = true;
          after.err?.(message);
        },
      )
      .finally(() => {
        busy = false;
      });
    return true;
  };

  /** Walk to a point; repeated orders for the same place are skipped (re-sent every 2 s while moving). */
  const walk = (/** @type {Point} */ to, label = 'move') => {
    const me = game.self;
    if (lastMove && dist(lastMove, to) < 1 && game.tick - lastMove.tick < 2 * TICK_HZ && dist(me, to) > 0.5) return true;
    return act(label, () => op.moveTo(to.x, to.y), { ok: () => (lastMove = { x: to.x, y: to.y, tick: game.tick }) });
  };

  const tools = () => TOOLS.map((t) => `${t.id}:${game.self.inventory[t.id] ?? 0}`).join(' ');
  const status = () => {
    const me = game.self;
    const best = me.ram.reduce((m, d) => Math.max(m, d.level), 0);
    const quiet = suppressed ? ` | ${suppressed} lines muted` : '';
    write(
      `status ${game.subnet} | running ${me.running.length}/${RUNNING_MAX} | RAM ${me.ram.length}/${RAM_SLOTS} best L${best} | disk ${diskFull ? 'FULL' : 'ok'}` +
        ` | bits ${me.bits} (+${stats.bitsEarned}) | ${tools()} | caught ${stats.captured} failed ${stats.failed} lvl+ ${stats.levelUps}` +
        ` evolved ${stats.evolved} tickets ${stats.tickets} | log ${linesUsed + 1}/${LOG_BUDGET}${quiet}`,
    );
    suppressed = 0;
    windowLines = 0;
  };
  const statusEveryMs = () => (linesUsed >= LOG_BUDGET - 50 ? 10 * STATUS_EVERY_MS : STATUS_EVERY_MS);

  // --- events ---------------------------------------------------------------------------------------------------
  game.on('captureStart', async (ev) => {
    const started = Date.now();
    const kind = ev.challenge.kind === 'chain' ? `chain ${ev.challenge.families.join('>')}` : ev.challenge.families[0];
    captures.set(ev.captureId, { targetId: ev.targetId, kind, ms: 0 });
    try {
      const answer = await solve(ev.challenge);
      const info = captures.get(ev.captureId);
      if (info) info.ms = Date.now() - started;
      // submitCapture completes the capture already in flight; retry briefly if the per-tick budget was spent.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await op.submitCapture(ev.captureId, answer);
          return;
        } catch (err) {
          if (/** @type {any} */ (err)?.code !== 'E_RATE') throw err;
          await new Promise((r) => setTimeout(r, 1000 / TICK_HZ));
        }
      }
    } catch (err) {
      event(`capture ${kind} not submitted: ${String(/** @type {any} */ (err)?.message ?? err)}`);
    }
  });
  game.on('captureResult', (ev) => {
    const info = captures.get(ev.captureId) ?? { targetId: lastCaptureTarget, kind: '?', ms: 0 };
    captures.delete(ev.captureId);
    if (ev.ok) stats.captured++;
    else {
      stats.failed++;
      // Failed: the target is hardened (and a territorial one hits back). Let the daemons fight it for a while.
      if (info.targetId) targetCooldown.set(info.targetId, game.tick + FAILED_CAPTURE_COOLDOWN_TICKS);
    }
    const d = /** @type {any} */ (ev).daemon;
    event(`capture ${info.kind} ${ev.ok ? 'OK' : `FAILED (${ev.reason ?? '?'})`}${d ? ` ${d.species} L${d.level}` : ''} solved in ${info.ms} ms`);
  });
  game.on('levelUp', (ev) => {
    if (game.self.ram.some((d) => d.id === ev.daemon)) stats.levelUps++;
  });
  game.on('evolved', (ev) => {
    stats.evolved++;
    event(`evolved ${ev.from} -> ${ev.to}`);
  });
  game.on('ticketDone', (ev) => {
    stats.tickets++;
    event(`ticket done +${ev.reward} bits${ev.unpaid ? ' (unpaid)' : ''}`);
  });
  game.on('bits', (ev) => {
    if (ev.delta > 0) stats.bitsEarned += ev.delta;
  });
  game.on('travelled', (ev) => {
    reached = Math.max(reached, ROUTE.indexOf(ev.to));
    lastMove = null;
    dangers = [];
    event(`travelled ${ev.from} -> ${ev.to}`);
  });
  game.on('telegraph', (ev) => {
    dangers.push(ev);
  });

  write(`full-loop online as ${game.self.name ?? game.operatorId} in ${game.subnet} | RAM ${game.self.ram.length}/${RAM_SLOTS} | ${tools()}`);

  /** A target that failed a capture recently is left to the daemons. */
  const captureCooling = (/** @type {string} */ id) => (targetCooldown.get(id) ?? -1) > game.tick;

  // --- operator: one decision per tick ------------------------------------------------------------------------------
  op.script(({ me, world, tick }) => {
    if (Date.now() - lastStatus >= statusEveryMs() && linesUsed < LOG_BUDGET - 1) {
      lastStatus = Date.now();
      status();
    }
    if (!me.starterClaimed || me.arena || busy) return;
    dangers = dangers.filter((d) => d.atTick >= tick);
    for (const [id, until] of targetCooldown) if (until <= tick) targetCooldown.delete(id);
    if (me.diskCapacity > diskCapacity) diskFull = false; // a Disk expansion landed
    diskCapacity = me.diskCapacity;
    reached = Math.max(reached, ROUTE.indexOf(game.subnet));

    // 1. Safety first: step out of a telegraphed blast.
    const danger = dangerAt(me, dangers, tick);
    if (danger) {
      walk(escapePoint(me, danger), 'dodge');
      return;
    }
    if (tick < holdUntil) return; // restoreAll is channelling
    if (me.capture) return; // a capture is in flight: its submit comes from the captureStart handler

    const swapReady = me.swapReadyTick <= tick;
    const crashed = me.ram.filter((d) => d.crashed);
    const host = HOSTS[/** @type {keyof typeof HOSTS} */ (game.subnet)] ?? null;
    const atHost = host !== null && dist(me, host) <= HOST_RADIUS - 0.25;
    const enemiesNear = world.wild.filter((d) => attackable(d, me.id)).within(LEASH_TILES).length > 0;

    // 2. Evolution: evolve any RAM daemon with a met requirement (recall it first when it is running and out of combat).
    const evo = evolutionReady(me.ram, (id) => ready(`evolve ${id}`));
    if (evo) {
      if (!me.running.includes(evo.daemonId)) {
        act(`evolve ${evo.daemonId}`, () => op.evolve(evo.daemonId, evo.form), { cooldownTicks: LONG_COOLDOWN_TICKS });
        return;
      }
      if (swapReady && !enemiesNear) {
        act(`recall ${evo.daemonId} to evolve`, () => op.recall(evo.daemonId));
        return;
      }
    }

    // 3. Host upkeep: tickets, store duplicates, restoreAll, tools.
    const tasks = hostTasks(me, world, atHost);
    if (tasks.length && host) {
      if (!atHost) {
        walk(host, `to host (${tasks.join(', ')})`);
        return;
      }
      if (runHostTask(me, world)) return;
    }

    // 4. Travel up the route when the best daemon is strong enough.
    if (TRAVEL) {
      const best = me.ram.reduce((m, d) => Math.max(m, d.level), 0);
      const hop = nextGateway(game.subnet, best, reached);
      const gate = hop && world.gateways.find((g) => g.id === hop.id);
      if (hop && gate && ready(`travel ${hop.id}`)) {
        if (dist(me, gate.at) > GATEWAY_RADIUS - 0.25) {
          walk(gate.at, `to gateway ${hop.id}`);
          return;
        }
        if (me.running.length) {
          if (swapReady) act(`recall ${me.running[0]} to travel`, () => op.recall(me.running[0]));
          return;
        }
        act(`travel ${hop.id}`, () => op.travel(hop.id), { cooldownTicks: LONG_COOLDOWN_TICKS });
        return;
      }
    }

    // 5. Keep RUNNING_MAX daemons running (the sim takes a crashed daemon out of `running` itself).
    if (me.running.length < RUNNING_MAX && swapReady) {
      const id = nextToRun(me.ram, me.running);
      if (id && ready(`run ${id}`)) {
        act(`run ${id}`, () => op.run(id));
        return;
      }
    }

    // 6. Restore a crashed daemon in place when a restore item is held.
    if (crashed.length && (me.inventory.restore ?? 0) > 0) {
      const d = crashed.find((c) => ready(`restore ${c.id}`));
      if (d) {
        act(`restore ${d.id}`, () => op.useRestore(d.id), { cooldownTicks: 4 * TICK_HZ });
        return;
      }
    }

    // 7. Fight and capture the nearest wild daemon.
    const target = world.wild.nearest((d) => attackable(d, me.id));
    if (!target) {
      const spot = REGION_CENTRES[wanderIndex % REGION_CENTRES.length];
      if (dist(me, spot) < 3) wanderIndex++;
      walk(REGION_CENTRES[wanderIndex % REGION_CENTRES.length], 'wander');
      return;
    }
    const d = dist(me, target);
    if (capturesOn(me) && target.hpPct < CAPTURE_HP_PCT && !target.boss && !captureCooling(target.id)) {
      const tool = chooseTool(me.inventory, d);
      if (!tool) {
        walk(target, 'close in to capture');
        return;
      }
      const label = `capture ${target.id}`;
      act(label, () => {
        lastCaptureTarget = target.id;
        return op.capture(target, /** @type {any} */ (tool.id));
      });
      return;
    }
    if (d > ENGAGE_RANGE) walk(target, 'engage');
  });

  /** Captures are on while a tool is held and RAM or Disk can take the daemon. */
  function capturesOn(/** @type {import('@daemonet/sdk').OperatorSelf} */ me) {
    return !(diskFull && me.ram.length >= RAM_SLOTS) && holdsTool(me.inventory);
  }

  /** Store candidates whose `store` is not cooling down. */
  const storable = (/** @type {import('@daemonet/sdk').OperatorSelf} */ me) => storeCandidates(me.ram, me.running).filter((id) => ready(`store ${id}`));
  /** Tool purchases whose `buy` is not cooling down. */
  const buyable = (/** @type {import('@daemonet/sdk').OperatorSelf} */ me) => toolsToBuy(me.inventory, me.bits).filter((b) => ready(`buy ${b.item}`));
  const needsRestoreAll = (/** @type {import('@daemonet/sdk').OperatorSelf} */ me) => me.ram.some((d) => d.crashed) && (me.inventory.restore ?? 0) === 0 && ready('restoreAll');

  /** What the host should do for us right now (empty: no trip needed). Uses the same cooldowns as runHostTask. */
  function hostTasks(/** @type {import('@daemonet/sdk').OperatorSelf} */ me, /** @type {import('@daemonet/sdk').WorldView} */ world, /** @type {boolean} */ atHost) {
    const tasks = [];
    if (ticketsToAccept(world.tickets, me, game.subnet, me.ticketsDay ?? '', triedTickets).length) tasks.push('tickets');
    if (!diskFull && storable(me).length && (me.ram.length >= RAM_SLOTS || (atHost && me.ram.length > RAM_SLOTS / 2))) tasks.push('store');
    if (needsRestoreAll(me)) tasks.push('restoreAll');
    if (SPEND_BITS && buyable(me).length) {
      const held = TOOLS.reduce((n, t) => n + (me.inventory[t.id] ?? 0), 0);
      // A trip only when the toolbox runs low; at the host anyway, top up to the floor.
      if (held < TOOL_FLOOR || atHost) tasks.push('buy');
    }
    return tasks;
  }

  /** One host action; false when there was nothing to do. */
  function runHostTask(/** @type {import('@daemonet/sdk').OperatorSelf} */ me, /** @type {import('@daemonet/sdk').WorldView} */ world) {
    const day = me.ticketsDay ?? '';
    for (const index of ticketsToAccept(world.tickets, me, game.subnet, day, triedTickets)) {
      triedTickets.add(`${day}|${game.subnet}|${index}`);
      const t = world.tickets.find((x) => x.index === index);
      return act(`accept ticket ${index}`, () => op.acceptTicket(index), { ok: () => event(`ticket accepted: ${t?.title ?? t?.kind}`) });
    }
    if (!diskFull && me.ram.length > RAM_SLOTS / 2) {
      const [id] = storable(me);
      if (id) return act(`store ${id}`, () => op.store(id));
    }
    if (needsRestoreAll(me)) {
      return act('restoreAll', () => op.restoreAll(), {
        ok: (r) => {
          holdUntil = typeof r?.untilTick === 'number' ? r.untilTick + 1 : game.tick + 2 * TICK_HZ;
          cooldown.set('restoreAll', holdUntil + TICK_HZ);
        },
      });
    }
    if (SPEND_BITS) {
      const [buy] = buyable(me);
      if (buy) return act(`buy ${buy.item}`, () => op.buy(buy.item, buy.qty));
    }
    return false;
  }

  // --- daemons: fight the nearest enemy, hold fire on capture-ready targets, dodge blasts -------------------------
  game.daemons.script(({ self, enemies, tick }) => {
    const me = game.self;
    const here = { x: self.x, y: self.y };
    const danger = dangerAt(here, dangers, tick);
    const lastOrder = daemonMoves.get(self.id) ?? -Infinity;
    if (danger) {
      if (tick - lastOrder >= 4) {
        daemonMoves.set(self.id, tick);
        const out = escapePoint(here, danger);
        self.moveTo(out.x, out.y).catch(() => {});
      }
      return;
    }
    const captureTarget = me.capture?.targetId;
    const holdFire = capturesOn(me);
    const foe = enemies.nearest(
      (d) => attackable(d, me.id) && d.id !== captureTarget && !(holdFire && d.hpPct < CAPTURE_HP_PCT && !d.boss && !captureCooling(d.id)),
    );
    if (!foe) return;
    const move = self.bestMoveAgainst(foe);
    if (move) {
      self.use(move, foe).catch(() => {});
      return;
    }
    // Out of reach: step towards the foe (within the leash), at most every half second.
    if (self.distanceTo(foe) > 2 && tick - lastOrder >= 8 && dist(foe, me) <= LEASH_TILES - 1) {
      daemonMoves.set(self.id, tick);
      self.moveTo(foe.x, foe.y).catch(() => {});
    }
  });
}
