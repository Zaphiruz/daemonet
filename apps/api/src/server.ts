import { createBus } from '@daemonet/bus';
import { createPrisma } from '@daemonet/db';
import { buildApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig } from './config.js';
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

const bus = createBus(config.redisUrl);
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
  trustProxyHops: config.trustProxyHops,
  logger: loggerOptions(config.logLevel),
});

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ port: config.port, devBypass: config.devBypass, redis: Boolean(config.redisUrl) }, 'daemonet api started');
if (!config.redisUrl) app.log.warn('REDIS_URL not set: using the in-process bus (admin chat actions will not reach the sim)');

const prune = () =>
  pruneChat(prisma)
    .then((n) => {
      if (n > 0) app.log.info({ deleted: n }, 'pruned chat history');
    })
    .catch((err: unknown) => app.log.error({ err: { name: (err as Error)?.name, code: (err as { code?: unknown })?.code } }, 'chat prune failed'));
void prune();
const pruneTimer = setInterval(() => void prune(), 6 * 3_600_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  await app.close();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
