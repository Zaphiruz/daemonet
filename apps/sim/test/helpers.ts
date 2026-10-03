import { computeStats, getSpecies, movesAtLevel, rollSpawn, statBlock, statBlockToArray, xpForLevel, createRng, type SubnetDef, type SpawnRoll } from '@daemonet/rules';
import type { Command } from '@daemonet/shared';
import { World, type Input, type OperatorRecord, type OwnedDaemonRecord, type StepResult } from '../src/core/index.js';

/** 32 x 32 open test subnet: one wall segment, host at (4.5, 4.5), no spawn regions. */
export const TEST_SUBNET: SubnetDef = {
  id: 'test',
  width: 32,
  height: 32,
  walls: [{ x: 16, y: 1, w: 1, h: 20 }],
  host: { x: 4.5, y: 4.5 },
  spawn: { x: 5.5, y: 4.5 },
  regions: [],
};

export function makeWorld(seed = 'test'): World {
  return new World({ subnet: TEST_SUBNET, seed, seedId: 'seed0001', spawner: false });
}

export function ownedRecord(species: string, level: number, slot: number, id = `own-${species}-${slot}`): OwnedDaemonRecord {
  const sp = getSpecies(species);
  const ivs = statBlock(20);
  const hp = computeStats({ base: sp.base, ivs, bonus: statBlock(0), level, nature: 0 }).hp;
  return {
    id,
    species,
    level,
    xp: xpForLevel(level),
    nature: 0,
    traitSlot: 0,
    ivs: statBlockToArray(ivs),
    bonus: statBlockToArray(statBlock(0)),
    clean: false,
    signature: 0,
    hp,
    energy: 128,
    moves: movesAtLevel(sp, level),
    crashed: false,
    slot,
  };
}

export function operatorRecord(id: string, overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    id,
    name: id,
    starterClaimed: true,
    x: 5.5,
    y: 5.5,
    bits: 0,
    inventory: { sniff: 8, tap: 2, mirror: 2, dump: 2, restore: 2 },
    ram: [ownedRecord('pingling', 20, 0, `${id}-d0`), ownedRecord('glitchmite', 20, 1, `${id}-d1`)],
    diskSlots: [],
    ...overrides,
  };
}

/** A plain (non-clean) roll with fixed IVs for predictable wild daemons. */
export function plainRoll(): SpawnRoll {
  return { ...rollSpawn(createRng(1), { clean: 0, signatureStep: 0 }), ivs: statBlock(10), nature: 0 };
}

export function placeWild(world: World, species: string, level: number, x: number, y: number, roll: SpawnRoll = plainRoll()) {
  return world.spawnWild(species, level, { x, y }, -1, roll);
}

let req = 0;
export function input(operatorId: string, command: Command): Input {
  return { operatorId, reqId: `r${++req}`, command };
}

/** Step once with the given commands. */
export function step(world: World, ...inputs: Input[]): StepResult {
  return world.step(inputs);
}

/** Step `n` times with no input, collecting all results. */
export function idle(world: World, n: number): StepResult[] {
  return Array.from({ length: n }, () => world.step([]));
}

export const self = 'self' as const;
