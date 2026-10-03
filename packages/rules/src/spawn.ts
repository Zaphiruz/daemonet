import { MAX_IV, SIGNATURE_MAX, STAT_KEYS, statBlock, type StatBlock } from './constants.js';
import { NATURES } from './natures.js';
import type { Rng } from './rng.js';

export interface SpawnOdds {
  /** Probability a fresh spawn is a clean image (all IVs 31). */
  clean: number;
  /** Probability of each successive signature tier, given clean. */
  signatureStep: number;
}

export const DEFAULT_ODDS: SpawnOdds = { clean: 1 / 4096, signatureStep: 1 / 4 };

export interface SpawnRoll {
  ivs: StatBlock;
  bonus: StatBlock;
  clean: boolean;
  signature: number;
  nature: number;
  traitSlot: 0 | 1;
}

/**
 * Clean with p = odds.clean. Clean: all IVs 31, signature = consecutive successes of odds.signatureStep
 * (capped at 15), each tier +1 bonus on a random stat. Not clean: IVs uniform 0-31, rerolled if all 31.
 * `odds` is injectable for tests only.
 */
export function rollSpawn(rng: Rng, odds: SpawnOdds = DEFAULT_ODDS): SpawnRoll {
  const clean = rng.chance(odds.clean);
  const bonus = statBlock(0);
  let ivs: StatBlock;
  let signature = 0;
  if (clean) {
    ivs = statBlock(MAX_IV);
    while (signature < SIGNATURE_MAX && rng.chance(odds.signatureStep)) signature++;
    for (let i = 0; i < signature; i++) bonus[rng.pick(STAT_KEYS)]++;
  } else {
    do {
      ivs = statBlock(0);
      for (const key of STAT_KEYS) ivs[key] = rng.int(0, MAX_IV);
    } while (STAT_KEYS.every((k) => ivs[k] === MAX_IV));
  }
  const nature = rng.int(0, NATURES.length - 1);
  const traitSlot = rng.int(0, 1) as 0 | 1;
  return { ivs, bonus, clean, signature, nature, traitSlot };
}
