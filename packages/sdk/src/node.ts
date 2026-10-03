import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { TokenSource } from './auth.js';

export interface DeviceLoginOptions {
  /** OIDC issuer, e.g. https://authentik.wispy-nook.casa/application/o/daemonet-bot/ (https, or a loopback host) */
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

type IdpJson = Record<string, unknown>;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_MARGIN_MS = 60_000;
const IDP_TIMEOUT_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const TRANSIENT_RETRY_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function checkIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('deviceLogin: issuer is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('deviceLogin: issuer must use https (http is only allowed for a loopback host)');
  }
  return issuer.endsWith('/') ? issuer : `${issuer}/`;
}

function isTokens(v: unknown): v is Tokens {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.accessToken === 'string' && (t.refreshToken === null || typeof t.refreshToken === 'string') && typeof t.expiresAt === 'number' && Number.isFinite(t.expiresAt);
}

/**
 * OAuth device authorization grant (RFC 8628) against Authentik, with a cached, auto-refreshing token.
 * Prints a verification URL + code on first use; later runs reuse the cached refresh token.
 *
 * Only a definitive rejection of the refresh token (invalid_grant / invalid_client / HTTP 400 or 401) leads to an
 * interactive login; network errors, timeouts, 429 and 5xx throw so the caller can retry.
 */
export async function deviceLogin(opts: DeviceLoginOptions): Promise<TokenSource> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((m: string) => console.log(m));
  const scope = opts.scope ?? 'openid profile groups offline_access';
  const base = checkIssuer(opts.issuer);
  const listeners = new Set<(token: string) => void>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** One IdP request: timeout, guarded JSON. OAuth 4xx error bodies are returned (not thrown) so `error` can be read. */
  const idp = async (what: string, url: string | URL, init?: RequestInit): Promise<{ status: number; json: IdpJson }> => {
    let res: Response;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`${what}: request failed (${err instanceof Error ? err.name : 'error'})`);
    }
    let json: IdpJson = {};
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null) json = parsed as IdpJson;
    } catch {
      if (res.ok) throw new Error(`${what}: response was not valid JSON`);
    }
    if (!res.ok && res.status !== 400 && res.status !== 401) throw new Error(`${what}: HTTP ${res.status}`);
    return { status: res.status, json };
  };

  const post = (what: string, url: string, body: Record<string, string>) =>
    idp(what, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  const disc = await idp('oidc discovery', new URL('.well-known/openid-configuration', base));
  if (disc.status !== 200 || typeof disc.json.device_authorization_endpoint !== 'string' || typeof disc.json.token_endpoint !== 'string') {
    throw new Error('oidc discovery: missing device_authorization_endpoint or token_endpoint');
  }
  const discovery = disc.json as unknown as Discovery;

  const toTokens = (r: IdpJson, previousRefresh: string | null): Tokens => {
    if (typeof r.access_token !== 'string' || !r.access_token) throw new Error(`token endpoint returned no access_token (${String(r.error ?? 'unknown error')})`);
    const expiresIn = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 300;
    return { accessToken: r.access_token, refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : previousRefresh, expiresAt: now() + expiresIn * 1000 };
  };

  const save = async (t: Tokens) => {
    if (!opts.cacheFile) return;
    const tmp = `${opts.cacheFile}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, opts.cacheFile);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };

  /** Resolves null only when the IdP definitively rejects the refresh token; every other failure throws. */
  const refresh = async (refreshToken: string): Promise<Tokens | null> => {
    const { status, json } = await post('token refresh', discovery.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: opts.clientId });
    if (status === 200) return toTokens(json, refreshToken);
    if (json.error === 'invalid_grant' || json.error === 'invalid_client' || status === 400 || status === 401) return null;
    throw new Error(`token refresh: HTTP ${status}`);
  };

  const interactive = async (): Promise<Tokens> => {
    const { json: dev, status } = await post('device authorization', discovery.device_authorization_endpoint, { client_id: opts.clientId, scope });
    const uri = dev.verification_uri_complete ?? dev.verification_uri;
    if (status !== 200 || typeof uri !== 'string' || typeof dev.device_code !== 'string') {
      throw new Error(`device authorization failed (${String(dev.error ?? `HTTP ${status}`)})`);
    }
    print(`To sign in, open ${uri} and enter code ${String(dev.user_code)}`);
    let interval = (typeof dev.interval === 'number' ? dev.interval : 5) * 1000;
    const deadline = now() + (typeof dev.expires_in === 'number' ? dev.expires_in : 600) * 1000;
    while (now() < deadline) {
      await sleep(interval);
      const { json } = await post('device login', discovery.token_endpoint, { grant_type: DEVICE_GRANT, device_code: dev.device_code, client_id: opts.clientId });
      if (typeof json.access_token === 'string') return toTokens(json, null);
      if (json.error === 'authorization_pending') continue;
      if (json.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw new Error(`device login failed: ${String(json.error ?? 'unknown error')}`);
    }
    throw new Error('device login expired');
  };

  let tokens: Tokens | null = null;
  if (opts.cacheFile) {
    let cached: Tokens | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(opts.cacheFile, 'utf8'));
      if (isTokens(parsed)) cached = parsed;
    } catch {
      cached = null;
    }
    if (cached) {
      // A transient failure here throws out of deviceLogin: it must not start a device login.
      tokens = cached.expiresAt - REFRESH_MARGIN_MS > now() ? cached : cached.refreshToken ? await refresh(cached.refreshToken) : null;
    }
  }
  if (!tokens) tokens = await interactive();
  await save(tokens);

  const adopt = async (next: Tokens) => {
    tokens = next;
    await save(next);
    for (const l of listeners) {
      try {
        l(next.accessToken);
      } catch {
        // a faulty listener must not abort renewal
      }
    }
    schedule();
  };

  let refreshing: Promise<boolean> | null = null;
  let signingIn: Promise<void> | null = null;

  /** Single-flight refresh with the current refresh token. false = nothing to refresh with / definitively rejected. */
  const sharedRefresh = (): Promise<boolean> =>
    (refreshing ??= (async () => {
      try {
        const rt = tokens?.refreshToken;
        const next = rt ? await refresh(rt) : null;
        if (!next) return false;
        await adopt(next);
        return true;
      } finally {
        refreshing = null;
      }
    })());

  const sharedInteractive = (): Promise<void> =>
    (signingIn ??= (async () => {
      try {
        await adopt(await interactive());
      } finally {
        signingIn = null;
      }
    })());

  function schedule(delay?: number) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!tokens?.refreshToken) return;
    const wait = Math.min(MAX_TIMER_MS, delay ?? Math.max(1000, tokens.expiresAt - REFRESH_MARGIN_MS - now()));
    // Never interactive: a definitive rejection stops refreshing (the next getToken decides); transient failures retry.
    refreshTimer = setTimeout(() => {
      sharedRefresh().then(
        () => {},
        () => schedule(TRANSIENT_RETRY_MS),
      );
    }, wait);
    refreshTimer.unref?.();
  }

  schedule();
  return {
    getToken: async () => {
      if (tokens && tokens.expiresAt - REFRESH_MARGIN_MS > now()) return tokens.accessToken;
      if (!(await sharedRefresh())) await sharedInteractive();
      return (tokens as Tokens | null)!.accessToken;
    },
    onRefresh: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export * from './index.js';
