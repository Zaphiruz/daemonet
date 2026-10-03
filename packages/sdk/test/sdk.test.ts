import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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


type Reply = [number, unknown];

describe('deviceLogin', () => {
  let server: Server | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    const s = server;
    server = null;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** Fake Authentik. `refresh` and `device` replies can be overridden per test. */
  async function fakeIdp() {
    let polls = 0;
    const calls: string[] = [];
    const state = {
      refresh: async (): Promise<Reply> => [200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 }],
      device: (): Reply => (++polls < 3 ? [400, { error: 'authorization_pending' }] : [200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 300 }]),
    };
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        void (async () => {
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
            const [status, obj] = grant === 'refresh_token' ? await state.refresh() : state.device();
            return json(status, obj);
          }
          json(404, {});
        })();
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { issuer: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/application/o/daemonet-bot/`, calls, state };
  }

  async function setup() {
    const idp = await fakeIdp();
    const dir = await mkdtemp(join(tmpdir(), 'daemonet-'));
    dirs.push(dir);
    const printed: string[] = [];
    const clock = { t: 1_000_000 };
    const sleeps: number[] = [];
    const cacheFile = join(dir, 'sub', 'token.json');
    const login = () =>
      deviceLogin({
        issuer: idp.issuer,
        clientId: 'daemonet-bot',
        cacheFile,
        print: (m) => printed.push(m),
        sleep: async (ms) => void sleeps.push(ms),
        now: () => clock.t,
      });
    return { ...idp, dir, cacheFile, printed, clock, sleeps, login };
  }

  const DEVICE = 'token:urn:ietf:params:oauth:grant-type:device_code';

  it('prints the code, polls until approved, caches with mode 0600, then refreshes from the cache', async () => {
    const { calls, cacheFile, printed, clock, login } = await setup();
    const source = await login();
    expect(printed[0]).toContain('ABCD-1234');
    expect(await source.getToken()).toBe('access-1');
    expect(calls.filter((c) => c === DEVICE)).toHaveLength(3);
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    if (process.platform !== 'win32') expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    const refreshed: string[] = [];
    source.onRefresh!(() => {
      throw new Error('faulty listener');
    });
    source.onRefresh!((t) => refreshed.push(t));
    clock.t += 290_000;
    expect(await source.getToken()).toBe('access-2');
    expect(refreshed).toEqual(['access-2']);

    const again = await login();
    expect(await again.getToken()).toBe('access-2');
    expect(printed).toHaveLength(1);
  });

  it('shares one refresh request between concurrent getToken calls', async () => {
    const { calls, state, clock, login } = await setup();
    const source = await login();
    state.refresh = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return [200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 }];
    };
    clock.t += 290_000;
    const tokens = await Promise.all([source.getToken(), source.getToken(), source.getToken()]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(calls.filter((c) => c === 'token:refresh_token')).toHaveLength(1);
  });

  it('rejects getToken on a transient refresh failure without starting a device login', async () => {
    const { state, clock, printed, calls, login } = await setup();
    const source = await login();
    state.refresh = async () => [503, { error: 'unavailable' }];
    clock.t += 290_000;
    await expect(source.getToken()).rejects.toThrow(/HTTP 503/);
    expect(printed).toHaveLength(1);
    expect(calls.filter((c) => c === DEVICE)).toHaveLength(3);
  });

  it('does not start a device login at startup when refreshing the cached token fails transiently', async () => {
    const { state, clock, printed, login } = await setup();
    await login();
    state.refresh = async () => [500, {}];
    clock.t += 290_000;
    await expect(login()).rejects.toThrow(/HTTP 500/);
    expect(printed).toHaveLength(1);
  });

  it('goes interactive when the refresh token is definitively rejected', async () => {
    const { state, clock, printed, login } = await setup();
    const source = await login();
    state.refresh = async () => [400, { error: 'invalid_grant' }];
    state.device = () => [200, { access_token: 'access-3', refresh_token: 'refresh-3', expires_in: 300 }];
    clock.t += 290_000;
    expect(await source.getToken()).toBe('access-3');
    expect(printed).toHaveLength(2);
  });

  it('backs off on slow_down', async () => {
    const a = await setup();
    let n = 0;
    a.state.device = () => (++n === 1 ? [400, { error: 'slow_down' }] : [200, { access_token: 'x', refresh_token: 'y', expires_in: 300 }]);
    await a.login();
    expect(a.sleeps).toEqual([1000, 6000]);
  });

  it('fails on access_denied', async () => {
    const b = await setup();
    b.state.device = () => [400, { error: 'access_denied' }];
    await expect(b.login()).rejects.toThrow(/access_denied/);
  });

  it('falls back to interactive login when the cache file is corrupt', async () => {
    const { cacheFile, dir, printed, login } = await setup();
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(cacheFile, '{not json');
    const source = await login();
    expect(printed).toHaveLength(1);
    expect(await source.getToken()).toBe('access-1');
    await writeFile(cacheFile, JSON.stringify({ accessToken: 1 }));
    await login();
    expect(printed).toHaveLength(2);
  });

  it('rejects a non-https, non-loopback issuer', async () => {
    await expect(deviceLogin({ issuer: 'http://idp.example.com/application/o/x/', clientId: 'c' })).rejects.toThrow(/https/);
  });
});
