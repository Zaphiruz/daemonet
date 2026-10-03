import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SUBMIT_BYTES } from '@daemonet/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Conn, Game, Logger } from './game.js';
import type { Store } from './store.js';

const READY_TIMEOUT_MS = 2000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long `close()` waits for sockets already closing (kicked) to finish their close handshake. */
const CLOSE_GRACE_MS = 1000;

export interface ServerOptions {
  game: Game;
  store: Store;
  port: number;
  host?: string;
  /** Number of trusted reverse proxies in front of the sim (Caddy, nginx, cloudflared = 3). */
  trustProxyHops: number;
  maxConnectionsPerIp?: number;
  log: Logger;
}

/** Same rule as proxy-addr with a hop count: walk back `hops` entries from the socket address. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const addrs = [req.socket.remoteAddress ?? 'unknown', ...forwarded.reverse()];
  return addrs[Math.min(hops, addrs.length - 1)]!;
}

export interface RunningServer {
  port: number;
  /** Stops listening and refuses new WebSocket upgrades; open sockets stay up (so they can still be kicked). */
  stopAccepting(): void;
  /** Stops accepting (if not yet), then ends the remaining sockets and waits for the listener to close. */
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnectionsPerIp ?? 16;
  const sockets = new Set<WebSocket>();

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ws/ready') {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('ping timeout')), READY_TIMEOUT_MS).unref();
      });
      Promise.race([opts.store.ping(), timeout]).then(
        () => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'),
        () => res.writeHead(503, { 'content-type': 'text/plain' }).end('db unavailable'),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SUBMIT_BYTES + 1024 });

  let accepting = true;

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!accepting) {
      socket.destroy();
      return;
    }
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req, opts.trustProxyHops);
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      sockets.add(ws);
      const conn: Conn = {
        id: crypto.randomUUID(),
        ip,
        send: (msg) => {
          if (ws.readyState !== ws.OPEN) return;
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.close(1008, 'slow consumer');
            return;
          }
          ws.send(JSON.stringify(msg));
        },
        close: (code, reason) => ws.close(code, reason),
      };
      ws.on('error', (err) => opts.log.warn({ err: err.message }, 'ws error'));
      opts.game.connect(conn);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return ws.close(1003, 'text frames only');
        opts.game.message(conn, data.toString()).catch((err: Error) => opts.log.error({ err: err.message }, 'message handler failed'));
      });
      ws.on('close', () => {
        sockets.delete(ws);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
        opts.game.disconnect(conn);
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host ?? '0.0.0.0', resolve));

  let listenerClosed: Promise<void> | null = null;
  const stopAccepting = () => {
    if (listenerClosed) return;
    accepting = false;
    wss.close();
    // Resolves once every connection (including upgraded sockets) has ended.
    listenerClosed = new Promise<void>((resolve) => http.close(() => resolve()));
  };

  return {
    port: (http.address() as AddressInfo).port,
    stopAccepting,
    close: async () => {
      stopAccepting();
      // Sockets already in a close handshake (e.g. kicked) get a short grace to deliver it; the rest are terminated.
      const closing: Promise<void>[] = [];
      for (const ws of sockets) {
        if (ws.readyState === ws.CLOSING) closing.push(new Promise<void>((resolve) => ws.once('close', () => resolve())));
        else ws.terminate();
      }
      if (closing.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(closing), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_GRACE_MS)))]);
        clearTimeout(timer);
      }
      for (const ws of sockets) ws.terminate();
      await listenerClosed;
    },
  };
}
