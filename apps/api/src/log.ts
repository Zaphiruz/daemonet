import type { FastifyServerOptions } from 'fastify';

/** Request fields that are safe to log: never the query string (it carries the OIDC `code` and `state`) or headers. */
export function serializeReq(req: { method?: string; url?: string; ip?: string; socket?: { remoteAddress?: string } }) {
  return { method: req.method, url: (req.url ?? '').split('?')[0], remoteAddress: req.ip ?? req.socket?.remoteAddress };
}

export function loggerOptions(level: string): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    serializers: { req: serializeReq },
  };
}
