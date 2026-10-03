// Static server for the sandbox verification page. Sets the production-like host CSP on the page and
// SANDBOX_CSP on /sandbox.html (Python's http.server cannot set headers). Serves only a fixed file
// map; counts any request a sandbox might make to /api/* or /ws (there must be none).
//
//   pnpm --filter @daemonet/sandbox verify:build && pnpm --filter @daemonet/sandbox verify:serve
//   then open http://127.0.0.1:5179/   (PORT=... to change; Ctrl+C to stop)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SANDBOX_CSP } from '../dist/index.js';

const HOST_CSP = "default-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'self'";
const file = (p) => fileURLToPath(new URL(p, import.meta.url));
const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const routes = {
  '/': { path: file('./index.html'), type: HTML, csp: HOST_CSP, cookie: true },
  '/host.js': { path: file('../dist/verify/host.js'), type: JS },
  '/sandbox.html': { path: file('../dist/static/sandbox.html'), type: HTML, csp: SANDBOX_CSP },
  '/sandbox/bootstrap.js': { path: file('../dist/static/sandbox/bootstrap.js'), type: JS },
  '/sandbox/worker.js': { path: file('../dist/static/sandbox/worker.js'), type: JS },
  '/sandbox/sdk.js': { path: file('../dist/static/sandbox/sdk.js'), type: JS },
};

let hits = 0;
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/api/') || path === '/ws') {
    hits++;
    console.log(`SANDBOX NETWORK REQUEST (must not happen): ${req.method} ${path}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  if (path === '/__verify/hits') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ hits }));
    return;
  }
  const route = routes[path];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  const headers = { 'content-type': route.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (route.csp) headers['content-security-policy'] = route.csp;
  if (route.cookie) headers['set-cookie'] = 'session=host-secret; Path=/; SameSite=Strict';
  res.writeHead(200, headers).end(readFileSync(route.path));
});
const port = Number(process.env.PORT ?? 5179);
server.listen(port, '127.0.0.1', () => console.log(`sandbox verify: http://127.0.0.1:${port}/  (Ctrl+C to stop)`));
