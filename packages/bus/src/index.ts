import { Redis } from 'ioredis';

/** Every key and channel the game touches in the shared Redis lives under this prefix (homelab ACL). */
export const PREFIX = 'daemonet:';

export type Handler = (message: unknown) => void;

/**
 * Pub/sub between the sim and the api (SP4 spec §4). Messages are JSON values; delivery is
 * at-most-once and reaches every subscriber of the channel, including the publisher's own handlers
 * (Redis delivers to the process's subscriber connection too) — MemoryBus mirrors that.
 */
export interface Bus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: Handler): () => void;
  /**
   * Called after the bus regained its connection following an outage (never for the first connection). Messages
   * published while it was down are lost (at-most-once), so consumers re-read the state they track from the database.
   */
  onReconnect(handler: () => void): () => void;
  close(): Promise<void>;
}

/** Where the bus reports trouble (the sim and the api pass their pino logger). Never given message contents. */
export interface BusLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export const consoleBusLogger: BusLogger = {
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

/** Only an error's name, code and message (ioredis connection errors carry no payload) reach the log. */
function errInfo(err: unknown): { name: string; code?: string; message?: string } {
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof e?.name === 'string' ? e.name : 'Error',
    ...(typeof e?.code === 'string' ? { code: e.code } : {}),
    ...(typeof e?.message === 'string' ? { message: e.message } : {}),
  };
}

/** A handler that throws must not stop delivery to the other subscribers or crash the process. */
function deliver(hs: Iterable<Handler>, message: unknown, log: BusLogger, channel: string): void {
  for (const h of [...hs]) {
    try {
      h(message);
    } catch (err) {
      log.error({ channel, err: { name: (err as Error)?.name ?? 'Error' } }, 'bus handler failed');
    }
  }
}

/** In-process bus for tests and local development without Redis. Publishing is asynchronous (next microtask). */
export class MemoryBus implements Bus {
  private readonly handlers = new Map<string, Set<Handler>>();
  /** The most recent publishes (capped at `logLimit`), for assertions. */
  readonly log: Array<{ channel: string; message: unknown }> = [];

  constructor(
    private readonly logLimit = 1000,
    private readonly logger: BusLogger = consoleBusLogger,
  ) {}

  async publish(channel: string, message: unknown): Promise<void> {
    this.log.push({ channel, message });
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    const hs = this.handlers.get(channel);
    if (!hs) return;
    await Promise.resolve();
    deliver(hs, copy, this.logger, channel);
  }

  subscribe(channel: string, handler: Handler): () => void {
    let hs = this.handlers.get(channel);
    if (!hs) this.handlers.set(channel, (hs = new Set()));
    hs.add(handler);
    return () => {
      hs.delete(handler);
    };
  }

  /** An in-process bus never loses its connection: the handler is never called. */
  onReconnect(_handler: () => void): () => void {
    return () => {};
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
  private readonly reconnectHandlers = new Set<() => void>();
  /** Times the subscriber connection became ready; every time after the first is a reconnect. */
  private readies = 0;
  private closing: Promise<void> | undefined;

  constructor(
    url: string,
    private readonly logger: BusLogger = consoleBusLogger,
  ) {
    // The publisher fails fast; the subscriber queues SUBSCRIBE across outages instead of flushing it. No ready check:
    // it sends INFO, which the production ACL denies (the connection would never become ready).
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, retryStrategy, enableReadyCheck: false });
    this.sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null, retryStrategy, enableReadyCheck: false });
    // (Re)issue SUBSCRIBE for every wanted channel whenever the connection becomes ready; idempotent in Redis.
    this.sub.on('ready', () => {
      this.resubscribe();
      if (this.readies++ > 0) this.reconnected();
    });
    // Without an 'error' listener ioredis emits an uncaught error event; log and let it reconnect.
    this.pub.on('error', (err: Error) => this.logger.error({ err: errInfo(err) }, 'bus publisher error'));
    this.sub.on('error', (err: Error) => this.logger.error({ err: errInfo(err) }, 'bus subscriber error'));
    this.sub.on('message', (channel: string, raw: string) => {
      const hs = this.handlers.get(channel);
      if (!hs) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        this.logger.warn({ channel }, 'bus: dropped a malformed message');
        return;
      }
      deliver(hs, message, this.logger, channel);
    });
  }

  private resubscribe(): void {
    const keys = [...this.handlers.keys()];
    if (keys.length === 0) return;
    this.sub.subscribe(...keys).catch((err: unknown) => this.logger.error({ err: errInfo(err) }, 'bus resubscribe failed'));
  }

  private reconnected(): void {
    for (const h of [...this.reconnectHandlers]) {
      try {
        h();
      } catch (err) {
        this.logger.error({ err: { name: (err as Error)?.name ?? 'Error' } }, 'bus reconnect handler failed');
      }
    }
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
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
      this.sub.subscribe(key).catch((err: unknown) => this.logger.error({ err: errInfo(err) }, 'bus subscribe failed'));
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
      this.reconnectHandlers.clear();
      await Promise.all(
        [this.pub, this.sub].map(async (c) => {
          try {
            // QUIT would queue forever on a connection that is not ready (the subscriber retries indefinitely).
            if (c.status !== 'ready') {
              c.disconnect();
              return;
            }
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
export function createBus(redisUrl: string | undefined, logger: BusLogger = consoleBusLogger): Bus {
  return redisUrl ? new RedisBus(redisUrl, logger) : new MemoryBus(undefined, logger);
}
