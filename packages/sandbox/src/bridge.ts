import type { PortLike } from '@daemonet/sdk';
import { MAX_SUBMIT_BYTES, parseClientMessage, type Entity, type OperatorSelf } from '@daemonet/shared';

/*
 * Reconnect contract (host side):
 * - The bridge, its MessageChannel, the sandbox iframe's worker and the script's GameClient are
 *   one unit. Every host reconnect rebuilds all of them: close the old bridge (`bridge.close()`,
 *   which rejects the script's pending commands through the port close), stop/remove the old
 *   sandbox, and start a new one — the script restarts from `main(game)`.
 * - Post the sandbox `init` (with the new port) only after the host's own client has its snapshot,
 *   so the bridge answers the script's `auth` with real state.
 * - On a final real-socket close (no reconnect), call `bridge.close()`.
 */

/** What the host already knows; used to answer the sandbox's `auth` with a synthetic snapshot. */
export interface HostState {
  operatorId: string;
  role: 'controller' | 'spectator';
  tick: number;
  subnet: string;
  self: OperatorSelf;
  entities: Entity[];
}

/** Why the bridge pushed back on the script: `flood` closed the port; `rate` and `invalid` only dropped frames. */
export type BridgeViolation = 'flood' | 'rate' | 'invalid';

export interface BridgeOptions {
  /** The host's end of the channel (the other end goes to the sandbox). */
  port: PortLike;
  /** Forwards a frame to the real WebSocket. */
  send(data: string): void;
  state(): HostState;
  /**
   * The script's share of the per-connection command budget, per tick. Default 6: the server allows
   * 8 per connection and the host keeps 2 for manual play.
   */
  commandsPerTick?: number;
  /** Raw frames per tick the bridge looks at; beyond this they are dropped before any parsing. Default 64. */
  rawFramesPerTick?: number;
  /** Raw frames per tick beyond which the bridge closes the port with 1008 'flood'. Default 2048. */
  floodFramesPerTick?: number;
  /** Called when the script misbehaves, e.g. to show "script stopped: flooding" on `flood`. */
  onViolation?(kind: BridgeViolation): void;
}

export interface Bridge {
  /** Feed every frame from the real WebSocket here. */
  deliver(data: string): void;
  /** Close the sandbox's socket (its pending commands reject); the bridge ignores everything afterwards. */
  close(code?: number, reason?: string): void;
}

type Envelope = { t?: unknown; d?: unknown };

/**
 * Server frame types relayed to the sandbox. `chat`, `chatDeleted` and `muted` (SP4) are deliberate additions: they carry
 * public chat lines and the operator's own mute state, no credential, so a script can read and answer chat. A script's
 * `chat` commands are ordinary `cmd` frames and share the per-tick command budget and the frame flood budget.
 * `clusterInvite` (SP4 plan 2) is one too: a cluster id, the inviter's id and name and an expiry (no credential, and the
 * cluster id only works with the invite), so a script can accept invites; its `cluster*` commands share the same budgets.
 */
const RELAYED: ReadonlySet<string> = new Set(['delta', 'ack', 'err', 'kick', 'chat', 'chatDeleted', 'muted', 'clusterInvite']);

/** Error replies per tick; beyond this a flooding script gets silence rather than more work for the host. */
const MAX_ERRORS_PER_TICK = 8;

/** Prefix on every sandbox reqId, so the host's own replies never reach the script and vice versa. */
const REQ_PREFIX = 's:';
/** The protocol's Id limit (64) minus the prefix. */
const MAX_SANDBOX_REQ_ID = 64 - REQ_PREFIX.length;

/**
 * Relays protocol frames between the sandboxed script and the real WebSocket. The sandbox never
 * sees a credential: its `auth` is answered locally from host state, `ping` locally with `pong`,
 * and only validated `cmd` frames go to the server, re-serialized from the parsed message so no
 * extra fields ride along, with the reqId namespaced as `s:<reqId>` and at most `commandsPerTick`
 * per tick. Replies come back only for `s:` ids (prefix stripped). Everything else the sandbox
 * sends (reauth, unknown frames, oversized or malformed data) never leaves the bridge, and a raw
 * frame budget bounds the work a flooding script can cause.
 */
export function createBridge(opts: BridgeOptions): Bridge {
  const commandsPerTick = opts.commandsPerTick ?? 6;
  const rawFramesPerTick = opts.rawFramesPerTick ?? 64;
  const floodFramesPerTick = opts.floodFramesPerTick ?? 2048;
  let seq = 0;
  let framesThisTick = 0;
  let commandsThisTick = 0;
  let errorsThisTick = 0;
  let rateReported = false;
  let authed = false;
  let closed = false;
  const violation = (kind: BridgeViolation) => {
    try {
      opts.onViolation?.(kind);
    } catch {
      // the host's callback must not break the bridge
    }
  };
  const reply = (frame: object) => {
    if (!closed) opts.port.postMessage(JSON.stringify({ ...frame, seq: ++seq }));
  };
  const replyError = (code: string, message: string, reqId?: string) => {
    if (errorsThisTick++ >= MAX_ERRORS_PER_TICK) return;
    reply({ t: 'err', d: { reqId, code, message } });
  };
  const reportRate = () => {
    if (rateReported) return;
    rateReported = true;
    violation('rate');
  };

  const bridge: Bridge = {
    deliver(data) {
      if (closed) return;
      let msg: Envelope;
      try {
        msg = JSON.parse(data) as Envelope;
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      if (msg.t === 'delta') {
        framesThisTick = 0;
        commandsThisTick = 0;
        errorsThisTick = 0;
        rateReported = false;
      }
      // Allowlist: only frames the in-sandbox client needs and that carry no credential. authOk, snapshot
      // and pong belong to the host (the sandbox got its own from `auth`/`ping`).
      if (typeof msg.t !== 'string' || !RELAYED.has(msg.t)) return;
      if (!authed) return;
      if (msg.t === 'ack' || msg.t === 'err') {
        const d = msg.d;
        if (d === null || typeof d !== 'object') return;
        const reqId = (d as { reqId?: unknown }).reqId;
        if (reqId !== undefined) {
          // a reply to someone's command: only the sandbox's own (s:) reach it, with the prefix stripped
          if (typeof reqId !== 'string' || !reqId.startsWith(REQ_PREFIX)) return;
          opts.port.postMessage(JSON.stringify({ ...msg, d: { ...d, reqId: reqId.slice(REQ_PREFIX.length) }, seq: ++seq }));
          return;
        }
        // only `err` may come without a reqId (a connection-level error)
        if (msg.t === 'ack') return;
      }
      opts.port.postMessage(JSON.stringify({ ...msg, seq: ++seq }));
    },
    close(code = 1000, reason = 'host closed') {
      if (closed) return;
      closed = true;
      opts.port.postMessage({ type: 'close', code, reason });
      opts.port.close();
    },
  };

  opts.port.addEventListener('message', (ev) => {
    if (closed) return;
    // Budget first, before looking at the data at all.
    framesThisTick++;
    if (framesThisTick > floodFramesPerTick) {
      bridge.close(1008, 'flood');
      violation('flood');
      return;
    }
    if (framesThisTick > rawFramesPerTick) {
      reportRate();
      return;
    }
    if (typeof ev.data !== 'string') {
      violation('invalid');
      return;
    }
    const raw = ev.data;
    if (raw.length > MAX_SUBMIT_BYTES) {
      violation('invalid');
      if (authed) replyError('E_INVALID', 'message too large');
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      violation('invalid');
      if (authed) replyError(parsed.code, parsed.message);
      return;
    }
    const msg = parsed.message;
    switch (msg.t) {
      case 'auth': {
        if (authed) return;
        const s = opts.state();
        authed = true;
        reply({ t: 'authOk', d: { operatorId: s.operatorId, role: s.role, resumeToken: 'sandbox', tick: s.tick } });
        reply({ t: 'snapshot', d: { tick: s.tick, subnet: s.subnet, self: s.self, entities: s.entities } });
        return;
      }
      case 'ping':
        reply({ t: 'pong', d: {} });
        return;
      case 'cmd': {
        if (!authed) return;
        if (msg.d.reqId.length > MAX_SANDBOX_REQ_ID) {
          violation('invalid');
          replyError('E_INVALID', `reqId longer than ${MAX_SANDBOX_REQ_ID} characters`, msg.d.reqId);
          return;
        }
        if (commandsThisTick >= commandsPerTick) {
          reportRate();
          replyError('E_RATE', `at most ${commandsPerTick} script commands per tick`, msg.d.reqId);
          return;
        }
        commandsThisTick++;
        opts.send(JSON.stringify({ ...msg, d: { ...msg.d, reqId: REQ_PREFIX + msg.d.reqId } }));
        return;
      }
      default:
        // reauth never leaves the sandbox: the host owns credentials and reconnection
        return;
    }
  });
  opts.port.start?.();

  return bridge;
}
