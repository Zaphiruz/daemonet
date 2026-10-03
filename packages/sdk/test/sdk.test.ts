import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceLogin } from '../src/node.js';
import { Query } from '../src/views.js';

describe('Query', () => {
  const items = [
    { id: 'a', x: 0, y: 0, hp: 10 },
    { id: 'b', x: 3, y: 4, hp: 2 },
    { id: 'c', x: 10, y: 0, hp: 5 },
  ];
  const q = new Query(items, { x: 1, y: 0 });

  it('finds nearest, lowest HP, and filters by radius', () => {
    expect(q.nearest()!.id).toBe('a');
    expect(q.nearest((i) => i.id !== 'a')!.id).toBe('b');
    expect(q.lowestHp()!.id).toBe('b');
    expect(q.within(5).all().map((i) => i.id)).toEqual(['a', 'b']);
    expect(q.filter((i) => i.hp > 100).nearest()).toBeUndefined();
    expect(q.length).toBe(3);
  });
});

describe('deviceLogin', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  /** Minimal fake Authentik: discovery, device endpoint, token endpoint (pending twice, then tokens), refresh. */
  async function fakeIdp() {
    let polls = 0;
    const calls: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const json = (status: number, obj: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
        const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
        if (req.url === '/application/o/daemonet-bot/.well-known/openid-configuration') {
          return json(200, { device_authorization_endpoint: `${base}/device`, token_endpoint: `${base}/token` });
        }
        if (req.url === '/device') {
          calls.push(`device:${form.get('client_id')}:${form.get('scope')}`);
          return json(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: `${base}/verify`, interval: 1, expires_in: 60 });
        }
        if (req.url === '/token') {
          const grant = form.get('grant_type');
          calls.push(`token:${grant}`);
          if (grant === 'refresh_token') return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 });
          if (++polls < 3) return json(400, { error: 'authorization_pending' });
          return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 300 });
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { issuer: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/application/o/daemonet-bot/`, calls };
  }

  it('prints the code, polls until approved, caches with mode 0600, then refreshes from the cache', async () => {
    const { issuer, calls } = await fakeIdp();
    const dir = await mkdtemp(join(tmpdir(), 'daemonet-'));
    const cacheFile = join(dir, 'token.json');
    const printed: string[] = [];
    let clock = 1_000_000;
    const source = await deviceLogin({ issuer, clientId: 'daemonet-bot', cacheFile, print: (m) => printed.push(m), sleep: async () => {}, now: () => clock });
    expect(printed[0]).toContain('ABCD-1234');
    expect(await source.getToken()).toBe('access-1');
    expect(calls.filter((c) => c === `token:urn:ietf:params:oauth:grant-type:device_code`)).toHaveLength(3);
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    if (process.platform !== 'win32') expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    const refreshed: string[] = [];
    source.onRefresh!((t) => refreshed.push(t));
    clock += 290_000;
    expect(await source.getToken()).toBe('access-2');
    expect(refreshed).toEqual(['access-2']);

    const again = await deviceLogin({ issuer, clientId: 'daemonet-bot', cacheFile, print: (m) => printed.push(m), sleep: async () => {}, now: () => clock });
    expect(await again.getToken()).toBe('access-2');
    expect(printed).toHaveLength(1);
  });
});
