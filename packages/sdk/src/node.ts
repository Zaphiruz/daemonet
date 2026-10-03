import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { TokenSource } from './auth.js';

export interface DeviceLoginOptions {
  /** OIDC issuer, e.g. https://authentik.wispy-nook.casa/application/o/daemonet-bot/ */
  issuer: string;
  clientId: string;
  scope?: string;
  /** Where the refresh token is cached (written with mode 0600). */
  cacheFile?: string;
  print?: (message: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Discovery {
  device_authorization_endpoint: string;
  token_endpoint: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  interval?: number;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_MARGIN_MS = 60_000;

/**
 * OAuth device authorization grant (RFC 8628) against Authentik, with a cached, auto-refreshing token.
 * Prints a verification URL + code on first use; later runs reuse the cached refresh token.
 */
export async function deviceLogin(opts: DeviceLoginOptions): Promise<TokenSource> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((m: string) => console.log(m));
  const scope = opts.scope ?? 'openid profile groups offline_access';
  const base = opts.issuer.endsWith('/') ? opts.issuer : `${opts.issuer}/`;
  const discovery = (await (await f(new URL('.well-known/openid-configuration', base))).json()) as Discovery;
  const listeners = new Set<(token: string) => void>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const post = async (url: string, body: Record<string, string>) => {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    return { status: res.status, json: (await res.json()) as TokenResponse & Record<string, unknown> };
  };

  const toTokens = (r: TokenResponse, previousRefresh: string | null): Tokens => {
    if (!r.access_token) throw new Error(`token endpoint returned no access_token (${r.error ?? 'unknown error'})`);
    return { accessToken: r.access_token, refreshToken: r.refresh_token ?? previousRefresh, expiresAt: now() + (r.expires_in ?? 300) * 1000 };
  };

  const save = async (t: Tokens) => {
    if (!opts.cacheFile) return;
    // Tighten an existing file before the secret is written into it; mode only applies on creation.
    await chmod(opts.cacheFile, 0o600).catch(() => {});
    await writeFile(opts.cacheFile, JSON.stringify(t), { mode: 0o600 });
    await chmod(opts.cacheFile, 0o600);
  };

  const refresh = async (refreshToken: string): Promise<Tokens | null> => {
    const { status, json } = await post(discovery.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: opts.clientId });
    if (status !== 200) return null;
    return toTokens(json, refreshToken);
  };

  const interactive = async (): Promise<Tokens> => {
    const { json: dev } = await post(discovery.device_authorization_endpoint, { client_id: opts.clientId, scope });
    const uri = (dev.verification_uri_complete ?? dev.verification_uri) as string;
    print(`To sign in, open ${uri} and enter code ${String(dev.user_code)}`);
    let interval = ((dev.interval as number | undefined) ?? 5) * 1000;
    const deadline = now() + ((dev.expires_in as number | undefined) ?? 600) * 1000;
    while (now() < deadline) {
      await sleep(interval);
      const { json } = await post(discovery.token_endpoint, { grant_type: DEVICE_GRANT, device_code: String(dev.device_code), client_id: opts.clientId });
      if (json.access_token) return toTokens(json, null);
      if (json.error === 'authorization_pending') continue;
      if (json.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw new Error(`device login failed: ${json.error ?? 'unknown error'}`);
    }
    throw new Error('device login expired');
  };

  let tokens: Tokens | null = null;
  if (opts.cacheFile) {
    try {
      const cached = JSON.parse(await readFile(opts.cacheFile, 'utf8')) as Tokens;
      tokens = cached.expiresAt - REFRESH_MARGIN_MS > now() ? cached : cached.refreshToken ? await refresh(cached.refreshToken) : null;
    } catch {
      tokens = null;
    }
  }
  if (!tokens) tokens = await interactive();
  await save(tokens);

  const schedule = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!tokens?.refreshToken) return;
    const wait = Math.max(1000, tokens.expiresAt - REFRESH_MARGIN_MS - now());
    refreshTimer = setTimeout(() => void renew().catch(() => {}), wait);
    refreshTimer.unref?.();
  };

  const renew = async (): Promise<string> => {
    const next = tokens?.refreshToken ? await refresh(tokens.refreshToken) : null;
    tokens = next ?? (await interactive());
    await save(tokens);
    for (const l of listeners) l(tokens.accessToken);
    schedule();
    return tokens.accessToken;
  };

  schedule();
  return {
    getToken: async () => (tokens && tokens.expiresAt - REFRESH_MARGIN_MS > now() ? tokens.accessToken : renew()),
    onRefresh: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export * from './index.js';
