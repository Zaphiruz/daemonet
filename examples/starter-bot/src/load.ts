/**
 * Connects N dev-token bots that wander and fight what they meet. Watch the sim's tick stats.
 * The sim caps connections per IP (default 16): a local load test with more bots needs the sim started
 * with MAX_CONNECTIONS_PER_IP raised, e.g. MAX_CONNECTIONS_PER_IP=128. Refused bots are logged and skipped.
 */
import { connect, devToken } from '@daemonet/sdk';

const url = process.env.DAEMONET_URL ?? 'ws://127.0.0.1:3000/ws';
const bots = Number(process.env.DAEMONET_BOTS ?? 64);
const starters = ['pingling', 'hashling', 'glitchmite', 'nullpup'];
let running = 0;

for (let i = 0; i < bots; i++) {
  const name = `load${i}`;
  try {
    const game = await connect({ url, auth: devToken(name) });
    if (!game.self.starterClaimed) await game.operator.claimStarter(starters[i % 4]!, name);
    let goal = { x: 30.5 + (i % 8) * 3, y: 20.5 + Math.floor(i / 8) * 2 };
    game.operator.script(({ me, world }) => {
      if (me.running.length === 0 && me.swapReadyTick <= game.tick) {
        const ready = me.ram.find((d) => !d.crashed);
        if (ready) void game.operator.run(ready.id);
        return;
      }
      if (Math.hypot(goal.x - me.x, goal.y - me.y) < 1) goal = { x: 26 + Math.random() * 28, y: 10 + Math.random() * 30 };
      if (game.tick % 16 === i % 16) void game.operator.moveTo(goal.x, goal.y);
      const target = world.wild.nearest((d) => d.taggedBy === null || d.taggedBy === me.id);
      if (target && target.hpPct < 0.35 && !me.capture && (me.inventory.sniff ?? 0) > 0) void game.operator.capture(target, 'sniff');
    });
    game.daemons.script(({ self, enemies }) => {
      const foe = enemies.nearest();
      if (!foe) return;
      const move = self.bestMoveAgainst(foe);
      if (move) void self.use(move, foe);
    });
    running++;
    console.log(`bot ${name} connected`);
  } catch (err) {
    console.warn(`bot ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (running === 0) {
  console.error(`0 of ${bots} bots running`);
  process.exit(1);
}
console.log(`${running} of ${bots} bots running; press Ctrl+C to stop`);
