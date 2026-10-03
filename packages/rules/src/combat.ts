import { ENERGY_MAX, TICK_HZ, type StatBlock } from './constants.js';
import type { MoveDef } from './content/moves.js';
import type { Rng } from './rng.js';
import { typeMultiplier, type TypeId } from './types.js';

export interface DamageInput {
  level: number;
  attacker: StatBlock;
  attackerTypes: readonly TypeId[];
  defender: StatBlock;
  defenderTypes: readonly TypeId[];
  move: MoveDef;
}

export interface DamageResult {
  amount: number;
  multiplier: number;
}

/**
 * floor(((2*level/5 + 2) * power * atk/def) / 50) + 2, then * type * same-type 1.5 * random [0.875, 1).
 * Physical moves use Attack/Defense, special moves Focus/Resolve. Always draws exactly one random number.
 * Result is >= 1 unless the type multiplier is 0.
 */
export function damage(input: DamageInput, rng: Rng): DamageResult {
  const random = 0.875 + rng.float() * 0.125;
  const { move } = input;
  const multiplier = typeMultiplier(move.type, input.defenderTypes);
  if (multiplier === 0 || move.power === 0) return { amount: 0, multiplier };
  const physical = move.category === 'physical';
  const atk = physical ? input.attacker.attack : input.attacker.focus;
  const def = Math.max(1, physical ? input.defender.defense : input.defender.resolve);
  const base = Math.floor((((2 * input.level) / 5 + 2) * move.power * atk) / def / 50) + 2;
  const stab = input.attackerTypes.includes(move.type) ? 1.5 : 1;
  return { amount: Math.max(1, Math.floor(base * multiplier * stab * random)), multiplier };
}

/** base * 256 / (256 + haste), floored; throttled multiplies by 1.5 (floored). */
export function effectiveCooldownMs(baseMs: number, haste: number, throttled: boolean): number {
  const ms = Math.floor((baseMs * 256) / (256 + haste));
  return throttled ? Math.floor(ms * 1.5) : ms;
}

/** Energy points per second. */
export function energyRegenPerSecond(energyStat: number): number {
  return 1 + energyStat / 64;
}

export function regenEnergy(current: number, energyStat: number, ticks = 1): number {
  return Math.min(ENERGY_MAX, current + (energyRegenPerSecond(energyStat) * ticks) / TICK_HZ);
}
