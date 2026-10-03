import { rollSpawn, type RegionDef, type Rng } from '@daemonet/rules';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export function weightedPick(weights: Readonly<Record<string, number>>, rng: Rng): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.int(1, total);
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function spawnOne(world: World, index: number, region: RegionDef, out: Out): void {
  const species = weightedPick(region.species, world.rng);
  const level = world.rng.int(region.levels[0], region.levels[1]);
  const pos = world.grid.randomWalkableIn(region.rect, world.rng);
  if (!pos) return;
  const roll = rollSpawn(world.rng, world.odds);
  const d = world.spawnWild(species, level, pos, index, roll);
  if (d.clean || d.signature > 0) {
    out.emit({ e: 'signatureSpawn', daemon: d.id, species, signature: d.signature, clean: d.clean }, { at: null });
  }
}

/** initial: fill every region to its cap. Otherwise: one respawn per region per interval while below cap. */
export function runSpawner(world: World, out: Out, initial: boolean): void {
  world.subnet.regions.forEach((region, i) => {
    if (initial) {
      while (world.regionCounts[i]! < region.cap) {
        const before = world.regionCounts[i]!;
        spawnOne(world, i, region, out);
        if (world.regionCounts[i] === before) break;
      }
      world.nextSpawnTick[i] = world.tick + world.ticks(region.respawnMs);
      return;
    }
    if (world.tick < world.nextSpawnTick[i]!) return;
    world.nextSpawnTick[i] = world.tick + world.ticks(region.respawnMs);
    if (world.regionCounts[i]! < region.cap) spawnOne(world, i, region, out);
  });
}
