import { consoleBusLogger, createBus, type BusLogger } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { buildApp } from './app.js';
import { combineBearer, createBearerVerifier, createDevBearerVerifier } from './auth/bearer.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig } from './config.js';
import { expireListings } from './exchange/listings.js';
import { expireOrders } from './exchange/orders.js';
import { loggerOptions } from './log.js';
import { pruneChat } from './routes/chat.js';

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(`[api] ${event}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}

const config = loadConfig();
const prisma = createPrisma(config.databaseUrl);
await prisma.$queryRaw`SELECT 1`;

// The bus may report connection trouble before the app (and its logger) exists: console until then, pino after.
let busLog: BusLogger = consoleBusLogger;
const bus = createBus(config.redisUrl, { warn: (obj, msg) => busLog.warn(obj, msg), error: (obj, msg) => busLog.error(obj, msg) });
const app = await buildApp({
  prisma,
  bus,
  sessionSecret: config.sessionSecret,
  cookieSecure: config.cookieSecure,
  frontendOrigin: config.frontendOrigin,
  ...(config.oidc ? { redirectUri: config.oidc.redirectUri } : {}),
  oidcClient: config.oidc ? createOidcClient(config.oidc) : null,
  requiredGroup: config.requiredGroup,
  adminGroup: config.adminGroup,
  devBypass: config.devBypass,
  bearer: combineBearer(
    config.botOidc ? createBearerVerifier({ issuer: config.botOidc.issuer, audiences: [config.botOidc.clientId], requiredGroup: config.requiredGroup }) : null,
    config.devBypass ? createDevBearerVerifier(config.requiredGroup) : null,
  ),
  trustProxyHops: config.trustProxyHops,
  logger: loggerOptions(config.logLevel),
});

busLog = app.log;
await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ port: config.port, devBypass: config.devBypass, redis: Boolean(config.redisUrl), botBearer: Boolean(config.botOidc) }, 'daemonet api started');
if (!config.redisUrl) app.log.warn('REDIS_URL not set: using the in-process bus (admin chat actions will not reach the sim)');

const prune = () =>
  pruneChat(prisma)
    .then(({ messages, hits }) => {
      if (messages > 0 || hits > 0) app.log.info({ messages, hits }, 'pruned chat history');
    })
    .catch((err: unknown) => app.log.error({ err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } }, 'chat prune failed'));
void prune();
const pruneTimer = setInterval(() => void prune(), 6 * 3_600_000);

// Exchange orders and daemon listings past their 7 days: escrow back to their owners, daemons unlocked (at boot, then
// every five minutes; one run at a time).
let expiring = false;
const expire = () => {
  if (expiring) return;
  expiring = true;
  Promise.all([expireOrders(prisma, bus, new Date(), app.log), expireListings(prisma, new Date(), app.log)])
    .then(([orders, listings]) => {
      if (orders + listings > 0) app.log.info({ orders, listings }, 'expired exchange orders and listings');
    })
    .catch((err: unknown) => app.log.error({ err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } }, 'exchange expiry failed'))
    .finally(() => {
      expiring = false;
    });
};
expire();
const expireTimer = setInterval(expire, 5 * 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  clearInterval(expireTimer);
  await app.close();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
