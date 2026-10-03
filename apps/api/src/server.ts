import { createPrisma } from '@daemonet/db';
import { buildApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig } from './config.js';
import { loggerOptions } from './log.js';

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(`[api] ${event}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}

const config = loadConfig();
const prisma = createPrisma(config.databaseUrl);
await prisma.$queryRaw`SELECT 1`;

const app = await buildApp({
  prisma,
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
app.log.info({ port: config.port, devBypass: config.devBypass }, 'daemonet api started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
