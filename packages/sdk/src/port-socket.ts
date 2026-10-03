import type { WebSocketCtor, WebSocketLike } from './client.js';

/** Wire messages the host bridge sends besides raw protocol strings. */
export type PortControl = { type: 'close'; code?: number; reason?: string };

/** A WebSocket close reason is at most 123 bytes; the port only promises characters. */
const MAX_REASON = 123;
/** The host's close frame is data: only an integer code a WebSocket could carry is used. */
const closeCode = (code: unknown): number => (typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1000);

/** The subset of MessagePort used here; identical in browsers and Node (worker_threads). */
export interface PortLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

/**
 * A WebSocket-shaped adapter over a MessagePort. The sandboxed script's GameClient uses it exactly
 * like a socket; the host page relays frames to the real WebSocket. Opens on the next microtask,
 * and closes only when the host says so — the host owns reconnection.
 */
export class PortSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = PortSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(private readonly port: PortLike) {
    port.addEventListener('message', (ev) => {
      const d: unknown = ev.data;
      if (typeof d === 'string') this.onmessage?.({ data: d });
      else if (d && typeof d === 'object' && (d as { type?: unknown }).type === 'close') {
        const { code, reason } = d as { code?: unknown; reason?: unknown };
        this.finish(closeCode(code), typeof reason === 'string' ? reason.slice(0, MAX_REASON) : '');
      }
    });
    port.start?.();
    queueMicrotask(() => {
      if (this.readyState === PortSocket.CONNECTING) {
        this.readyState = PortSocket.OPEN;
        this.onopen?.({});
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== PortSocket.OPEN) throw new Error('PortSocket is not open');
    this.port.postMessage(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= PortSocket.CLOSING) return;
    this.readyState = PortSocket.CLOSING;
    this.port.postMessage({ type: 'close', code, reason } satisfies PortControl);
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === PortSocket.CLOSED) return;
    this.readyState = PortSocket.CLOSED;
    this.port.close();
    this.onclose?.({ code, reason });
  }

  /** A constructor for `connect({ WebSocket })` that ignores the URL and uses `port`. */
  static factory(port: PortLike): WebSocketCtor {
    return class extends PortSocket {
      constructor(_url: string) {
        super(port);
      }
    };
  }
}
