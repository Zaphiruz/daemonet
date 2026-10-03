import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SUBMIT_BYTES } from '@daemonet/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Conn, Game, Logger } from './game.js';
import type { Store } from './store.js';

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
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnectionsPerIp ?? 16;
  const sockets = new Set<WebSocket>();

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ws/ready') {
      opts.store.ping().then(
        () => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'),
        () => res.writeHead(503, { 'content-type': 'text/plain' }).end('db unavailable'),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SUBMIT_BYTES + 1024 });

  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
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
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        close: (code, reason) => ws.close(code, reason),
      };
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
  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
