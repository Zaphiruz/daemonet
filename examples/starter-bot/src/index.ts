import { connect, devToken, type DaemonView, type TokenSource } from '@daemonet/sdk';
import { deviceLogin } from '@daemonet/sdk/node';
import { solvePacket } from './solvers.ts';

const env = process.env;
const url = env.DAEMONET_URL ?? 'ws://127.0.0.1:3000/ws';
const name = env.DAEMONET_NAME ?? 'operator';
const starter = env.DAEMONET_STARTER ?? 'pingling';
const HOST = { x: 16.5, y: 16.5 };

const auth: TokenSource = env.DAEMONET_DEV_NAME
  ? devToken(env.DAEMONET_DEV_NAME)
  : await deviceLogin({ issuer: env.DAEMONET_ISSUER!, clientId: env.DAEMONET_CLIENT_ID ?? 'daemonet-bot', cacheFile: '.daemonet-token.json' });

const game = await connect({ url, auth });
console.log(`connected as ${game.operatorId} at tick ${game.tick}`);

game.on('error', (e) => console.warn('server error:', e.message));
game.on('scriptError', (e) => console.warn('script error:', e));
game.on('kick', (reason) => console.warn('kicked:', reason));
game.on('levelUp', (e) => console.log(`level up: ${e.daemon} -> ${e.level}`));
game.on('captureResult', (e) => console.log(e.ok ? `captured ${e.daemon?.species ?? 'to Disk'}!` : `capture failed: ${e.reason}`));

if (!game.self.starterClaimed) {
  await game.operator.claimStarter(starter, name);
  console.log(`claimed ${starter}`);
}

// Only Packet challenges are solved here; other families are ignored and time out.
game.on('captureStart', ({ captureId, challenge }) => {
  if (challenge.kind === 'single' && challenge.families[0] === 'packet') {
    void game.operator.submitCapture(captureId, solvePacket(challenge.params as never, challenge.payload as never));
  }
});

const canAttack = (meId: string) => (d: DaemonView) => d.types.includes('packet') && (d.taggedBy === null || d.taggedBy === meId);
let busy = false;

game.operator.script(({ me, world }) => {
  if (busy) return;
  const ready = me.ram.find((d) => !d.crashed);
  if (!ready) {
    // Everything crashed: walk home and restore.
    if (Math.hypot(HOST.x - me.x, HOST.y - me.y) > 1.5) {
      void game.operator.moveTo(HOST.x, HOST.y);
    } else {
      busy = true;
      game.operator.restoreAll().catch(() => {}).finally(() => (busy = false));
    }
    return;
  }
  if (me.running.length === 0 && me.swapReadyTick <= game.tick) {
    void game.operator.run(ready.id);
    return;
  }
  const target = world.wild.nearest(canAttack(me.id));
  if (!target || me.capture) return;
  if (Math.hypot(target.x - me.x, target.y - me.y) > 3) {
    void game.operator.moveTo(target.x, target.y);
    return;
  }
  if (target.hpPct < 0.35 && (me.inventory.sniff ?? 0) > 0) {
    busy = true;
    game.operator.capture(target, 'sniff').catch(() => {}).finally(() => (busy = false));
  }
});

game.daemons.script(({ self, enemies }) => {
  const foe = enemies.nearest(canAttack(game.operatorId));
  if (!foe || foe.hpPct < 0.35) return;
  const move = self.bestMoveAgainst(foe);
  if (move) void self.use(move, foe);
});
