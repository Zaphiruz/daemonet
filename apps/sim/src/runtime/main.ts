import { createBus } from '@daemonet/bus';
import { getSubnet } from '@daemonet/rules';
import { pino } from 'pino';
import { World } from '../core/index.js';
import { combineVerifiers, createDevVerifier, createOidcVerifier } from './auth.js';
import { loadConfig } from './config.js';
import { Game } from './game.js';
import { startLoop } from './loop.js';
import { PrismaStore } from './prisma-store.js';
import { startServer } from './server.js';
import { gracefulShutdown } from './shutdown.js';
import { createTicketVerifier } from './ticket.js';

const config = loadConfig();
const log = pino({ level: config.logLevel });

const store = PrismaStore.connect(config.databaseUrl);
await store.ping();
// One world (and one seed row) per hosted subnet; the first is the default world.
const discovered = await store.listDiscoveries();
const worlds: World[] = [];
for (const id of config.subnets) {
  const subnet = getSubnet(id);
  const seed = await store.createSeed(subnet.id);
  worlds.push(new World({ subnet, seed: seed.seed, seedId: seed.id, discovered }));
}

// The dev verifier only exists when AUTH_DEV_BYPASS=true (loadConfig refuses that in production).
const verify = combineVerifiers(
  config.oidc
    ? createOidcVerifier({ issuer: config.oidc.issuer, audiences: [config.oidc.clientId], requiredGroup: config.requiredGroup, warm: true })
    : null,
  config.devBypass ? createDevVerifier(config.requiredGroup) : null,
  createTicketVerifier(store.prisma, config.requiredGroup),
);

const bus = createBus(config.redisUrl, log);
if (!config.redisUrl) log.warn({}, 'REDIS_URL not set: using the in-process bus (admin chat actions from the api will not reach the sim)');
const game = new Game({ worlds, store, verify, bus, log });
await game.loadChatTerms();
// Before anyone can connect: close Incident rows a previous process left open and finish interrupted payouts.
await game.recoverIncidents();
const server = await startServer({ game, store, port: config.port, trustProxyHops: config.trustProxyHops, maxConnectionsPerIp: config.maxConnectionsPerIp, log });
const stopLoop = startLoop(() => game.tick());
const statsTimer = setInterval(() => log.info({ tick: game.world.tick, ...game.stats() }, 'tick stats'), 64_000);

log.info({ port: server.port, subnets: worlds.map((w) => `${w.subnet.id}:${w.seedId}`), devBypass: config.devBypass }, 'daemonet sim started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  stopLoop();
  clearInterval(statsTimer);
  await gracefulShutdown({ server, game, store, bus });
  process.exit(0);
}
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.stack ?? err.message }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) }, 'unhandled rejection');
  process.exit(1);
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
