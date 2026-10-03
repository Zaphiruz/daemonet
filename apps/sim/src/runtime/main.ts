import { getSubnet } from '@daemonet/rules';
import { pino } from 'pino';
import { World } from '../core/index.js';
import { combineVerifiers, createDevVerifier, createOidcVerifier } from './auth.js';
import { loadConfig } from './config.js';
import { Game } from './game.js';
import { startLoop } from './loop.js';
import { PrismaStore } from './prisma-store.js';
import { startServer } from './server.js';

const config = loadConfig();
const log = pino({ level: config.logLevel });

const store = PrismaStore.connect(config.databaseUrl);
await store.ping();
const subnet = getSubnet(config.subnet);
const seed = await store.createSeed(subnet.id);
const world = new World({ subnet, seed: seed.seed, seedId: seed.id });

// The dev verifier only exists when AUTH_DEV_BYPASS=true (loadConfig refuses that in production).
const verify = combineVerifiers(
  config.oidc
    ? createOidcVerifier({ issuer: config.oidc.issuer, audiences: [config.oidc.clientId], requiredGroup: config.requiredGroup })
    : null,
  config.devBypass ? createDevVerifier(config.requiredGroup) : null,
);

const game = new Game({ world, store, verify, seedId: seed.id, log });
const server = await startServer({ game, store, port: config.port, trustProxyHops: config.trustProxyHops, log });
const stopLoop = startLoop(() => game.tick());
const statsTimer = setInterval(() => log.info({ tick: world.tick, ...game.stats() }, 'tick stats'), 64_000);

log.info({ port: server.port, subnet: subnet.id, seedId: seed.id, devBypass: config.devBypass }, 'daemonet sim started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  stopLoop();
  clearInterval(statsTimer);
  try {
    await server.close();
    await game.shutdown();
  } finally {
    await store.close();
  }
  process.exit(0);
}
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: String(reason) }, 'unhandled rejection');
  process.exit(1);
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
