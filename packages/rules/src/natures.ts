import type { StatKey } from './constants.js';

export interface Nature {
  id: string;
  up: StatKey | null;
  down: StatKey | null;
}

/** 16 natures (a 4-bit value). Index = the stored nature number. HP is never affected. */
export const NATURES: readonly Nature[] = [
  { id: 'steady', up: null, down: null },
  { id: 'idle', up: null, down: null },
  { id: 'nominal', up: null, down: null },
  { id: 'default', up: null, down: null },
  { id: 'aggressive', up: 'attack', down: 'defense' },
  { id: 'reckless', up: 'attack', down: 'resolve' },
  { id: 'guarded', up: 'defense', down: 'attack' },
  { id: 'stubborn', up: 'defense', down: 'speed' },
  { id: 'focused', up: 'focus', down: 'attack' },
  { id: 'analytic', up: 'focus', down: 'haste' },
  { id: 'calm', up: 'resolve', down: 'focus' },
  { id: 'patient', up: 'resolve', down: 'speed' },
  { id: 'eager', up: 'speed', down: 'defense' },
  { id: 'hasty', up: 'haste', down: 'resolve' },
  { id: 'frugal', up: 'energy', down: 'haste' },
  { id: 'bursty', up: 'haste', down: 'energy' },
];

export function getNature(index: number): Nature {
  const n = NATURES[index];
  if (!n) throw new RangeError(`unknown nature ${index}`);
  return n;
}

export function natureModifier(nature: Nature, stat: StatKey): number {
  if (nature.up === stat) return 1.1;
  if (nature.down === stat) return 0.9;
  return 1;
}
