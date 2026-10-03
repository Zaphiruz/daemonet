import { STAT_KEYS, statBlock, type StatBlock } from './constants.js';
import { getNature, natureModifier } from './natures.js';

export interface StatInput {
  base: StatBlock;
  ivs: StatBlock;
  bonus: StatBlock;
  level: number;
  nature: number;
}

/**
 * stat = floor((2*base + IV + bonus) * level / 64) + 5, then * nature (floored)
 * HP   = floor((2*base + IV + bonus) * level / 64) + level + 10
 */
export function computeStats(input: StatInput): StatBlock {
  const nature = getNature(input.nature);
  const out = statBlock(0);
  for (const key of STAT_KEYS) {
    const core = Math.floor(((2 * input.base[key] + input.ivs[key] + input.bonus[key]) * input.level) / 64);
    out[key] = key === 'hp' ? core + input.level + 10 : Math.floor((core + 5) * natureModifier(nature, key));
  }
  return out;
}
