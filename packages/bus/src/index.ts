import { Redis } from 'ioredis';

/** Every key and channel the game touches in the shared Redis lives under this prefix (homelab ACL). */
export const PREFIX = 'daemonet:';

export type Handler = (message: unknown) => void;

/**
 * Pub/sub between the sim and the api (SP4 spec §4). Messages are JSON values; delivery is
 * at-most-once and never to the publisher's own handlers on RedisBus — MemoryBus mirrors that.
 */
export interface Bus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: Handler): () => void;
  close(): Promise<void>;
}

/** A handler that throws must not stop delivery to the other subscribers or crash the process. */
function deliver(hs: Iterable<Handler>, message: unknown): void {
  for (const h of [...hs]) {
    try {
      h(message);
    } catch (err) {
      console.error('bus handler failed', err);
    }
  }
}

/** In-process bus for tests and local development without Redis. Publishing is asynchronous (next microtask). */
export class MemoryBus implements Bus {
  private readonly handlers = new Map<string, Set<Handler>>();
  /** Every publish, for assertions. */
  readonly log: Array<{ channel: string; message: unknown }> = [];

  async publish(channel: string, message: unknown): Promise<void> {
    this.log.push({ channel, message });
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    const hs = this.handlers.get(channel);
    if (!hs) return;
    await Promise.resolve();
    deliver(hs, copy);
  }

  subscribe(channel: string, handler: Handler): () => void {
    let hs = this.handlers.get(channel);
    if (!hs) this.handlers.set(channel, (hs = new Set()));
    hs.add(handler);
    return () => {
      hs.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

/** Reconnect delay: linear backoff capped at 5 s, retried forever (a Redis outage must not take the process down). */
function retryStrategy(times: number): number {
  return Math.min(times * 200, 5000);
}

/** Redis pub/sub with one publishing and one subscribing connection; channels are prefixed. */
export class RedisBus implements Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<Handler>>();
  private closing: Promise<void> | undefined;

  constructor(url: string) {
    const opts = { lazyConnect: false, maxRetriesPerRequest: 2, retryStrategy };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);
    // Without an 'error' listener ioredis emits an uncaught error event; log and let it reconnect.
    this.pub.on('error', (err: Error) => console.error('bus publisher error', err.message));
    this.sub.on('error', (err: Error) => console.error('bus subscriber error', err.message));
    this.sub.on('message', (channel: string, raw: string) => {
      const hs = this.handlers.get(channel);
      if (!hs) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      deliver(hs, message);
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.pub.publish(PREFIX + channel, JSON.stringify(message));
  }

  subscribe(channel: string, handler: Handler): () => void {
    const key = PREFIX + channel;
    let hs = this.handlers.get(key);
    if (!hs) {
      this.handlers.set(key, (hs = new Set()));
      // ioredis re-subscribes to every channel after a reconnect; a failed first attempt is logged only.
      this.sub.subscribe(key).catch((err: Error) => console.error('bus subscribe failed', err.message));
    }
    hs.add(handler);
    return () => {
      hs.delete(handler);
      if (hs.size === 0 && this.handlers.get(key) === hs) {
        this.handlers.delete(key);
        this.sub.unsubscribe(key).catch(() => undefined);
      }
    };
  }

  /** Resolves once both connections are ready (tests wait for it before publishing). */
  async ready(): Promise<void> {
    await Promise.all([this.pub.ping(), this.sub.ping()]);
  }

  /** Idempotent; falls back to a hard disconnect when a graceful QUIT cannot complete. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.handlers.clear();
      await Promise.all(
        [this.pub, this.sub].map(async (c) => {
          try {
            await c.quit();
          } catch {
            c.disconnect();
          }
        }),
      );
    })();
    return this.closing;
  }
}

/** `REDIS_URL` set → RedisBus, otherwise MemoryBus (single-process development). */
export function createBus(redisUrl: string | undefined): Bus {
  return redisUrl ? new RedisBus(redisUrl) : new MemoryBus();
}
