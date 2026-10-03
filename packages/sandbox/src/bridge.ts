import type { PortLike } from '@daemonet/sdk';
import { COMMANDS_PER_TICK, MAX_SUBMIT_BYTES, parseClientMessage, type Entity, type OperatorSelf } from '@daemonet/shared';

/** What the host already knows; used to answer the sandbox's `auth` with a synthetic snapshot. */
export interface HostState {
  operatorId: string;
  role: 'controller' | 'spectator';
  tick: number;
  subnet: string;
  self: OperatorSelf;
  entities: Entity[];
}

export interface BridgeOptions {
  /** The host's end of the channel (the other end goes to the sandbox). */
  port: PortLike;
  /** Forwards a frame to the real WebSocket. */
  send(data: string): void;
  state(): HostState;
}

export interface Bridge {
  /** Feed every frame from the real WebSocket here. */
  deliver(data: string): void;
  /** Tell the sandbox the game is over (host closed the real socket for good). */
  close(code?: number, reason?: string): void;
}

type Envelope = { t?: unknown };

/** Server frame types relayed to the sandbox. */
const RELAYED: ReadonlySet<string> = new Set(['delta', 'ack', 'err', 'kick']);

/** Error replies per tick; beyond this a flooding script gets silence rather than more work for the host. */
const MAX_ERRORS_PER_TICK = 8;

/**
 * Relays protocol frames between the sandboxed script and the real WebSocket. The sandbox never
 * sees a credential: its `auth` is answered locally from host state, `ping` locally with `pong`,
 * and only validated `cmd` frames go to the server (re-serialized from the parsed message so no
 * extra fields ride along) — at most 8 per tick, like the server enforces. Everything else the
 * sandbox sends (reauth, unknown frames, oversized or malformed data) never leaves the bridge.
 */
export function createBridge(opts: BridgeOptions): Bridge {
  let seq = 0;
  let commandsThisTick = 0;
  let errorsThisTick = 0;
  let authed = false;
  let closed = false;
  const reply = (frame: object) => {
    if (!closed) opts.port.postMessage(JSON.stringify({ ...frame, seq: ++seq }));
  };
  const replyError = (code: string, message: string, reqId?: string) => {
    if (errorsThisTick++ >= MAX_ERRORS_PER_TICK) return;
    reply({ t: 'err', d: { reqId, code, message } });
  };

  opts.port.addEventListener('message', (ev) => {
    if (closed || typeof ev.data !== 'string') return;
    const raw = ev.data;
    if (raw.length > MAX_SUBMIT_BYTES) {
      if (authed) replyError('E_INVALID', 'message too large');
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
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
        if (commandsThisTick >= COMMANDS_PER_TICK) {
          replyError('E_RATE', `at most ${COMMANDS_PER_TICK} commands per tick`, msg.d.reqId);
          return;
        }
        commandsThisTick++;
        opts.send(JSON.stringify(msg));
        return;
      }
      default:
        // reauth never leaves the sandbox: the host owns credentials and reconnection
        return;
    }
  });
  opts.port.start?.();

  return {
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
        commandsThisTick = 0;
        errorsThisTick = 0;
      }
      // Allowlist: only frames the in-sandbox client needs and that carry no credential. authOk, snapshot
      // and pong belong to the host (the sandbox got its own from `auth`/`ping`).
      if (typeof msg.t !== 'string' || !RELAYED.has(msg.t)) return;
      if (!authed) return;
      opts.port.postMessage(JSON.stringify({ ...msg, seq: ++seq }));
    },
    close(code = 1000, reason = 'host closed') {
      if (closed) return;
      closed = true;
      opts.port.postMessage({ type: 'close', code, reason });
      opts.port.close();
    },
  };
}
