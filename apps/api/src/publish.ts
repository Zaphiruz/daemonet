import type { Bus } from '@daemonet/bus';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Publishes a bus message after the database change it announces has committed. The database stays the source of truth
 * (the sim re-reads it on load, on bus reconnect and periodically), so a Redis outage must neither fail the request nor
 * become an unhandled rejection; the log carries the message kind and the error class only, never the payload or the
 * error text (which can quote it).
 */
export function publishSafely(bus: Bus, log: FastifyBaseLogger, channel: string, message: { kind: string; [field: string]: unknown }): void {
  bus.publish(channel, message).catch((err: unknown) => {
    const e = err as { name?: unknown; code?: unknown };
    log.warn({ kind: message.kind, err: { name: String(e?.name ?? 'Error'), code: e?.code === undefined ? undefined : String(e.code) } }, 'bus publish failed');
  });
}
