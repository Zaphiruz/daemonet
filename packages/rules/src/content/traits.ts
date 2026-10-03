import { deepFreeze } from '../freeze.js';

/** Traits are rolled and stored in SP1; their effects arrive in SP3. */
export interface TraitDef {
  id: string;
  name: string;
  description: string;
}

export const TRAITS: readonly TraitDef[] = deepFreeze([
  { id: 'echo', name: 'Echo', description: 'Repeats its last move at half power.' },
  { id: 'lowlatency', name: 'Low Latency', description: 'First move in a battle has no cooldown.' },
  { id: 'synburst', name: 'SYN Burst', description: 'Filler moves cost no energy below 25% HP.' },
  { id: 'retransmit', name: 'Retransmit', description: 'Missed area moves refund half their energy.' },
  { id: 'salted', name: 'Salted', description: 'Takes less damage from repeated moves.' },
  { id: 'onewayfn', name: 'One-Way', description: 'Status effects on it cannot be copied.' },
  { id: 'darkmode', name: 'Dark Mode', description: 'Harder to target from long range.' },
  { id: 'sonar', name: 'Sonar', description: 'Sees daemons through obstacles.' },
  { id: 'overclock', name: 'Overclock', description: 'Cooldowns -12.5% below 25% HP.' },
  { id: 'bitshield', name: 'Bitshield', description: 'Blocks the first hit in each battle.' },
  { id: 'entropy', name: 'Entropy', description: 'Statuses it inflicts last longer.' },
  { id: 'decay', name: 'Decay', description: 'Enemies it hits lose energy over time.' },
  { id: 'nullsafe', name: 'Null Safe', description: 'Survives one lethal hit per battle at 1 HP.' },
  { id: 'lazyeval', name: 'Lazy Eval', description: 'Heavy moves cost less energy.' },
  { id: 'voidstep', name: 'Void Step', description: 'Moves faster out of combat.' },
  { id: 'absorb', name: 'Absorb', description: 'Regains energy when hit.' },
]);

const BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

export function getTrait(id: string): TraitDef {
  const t = BY_ID.get(id);
  if (!t) throw new RangeError(`unknown trait ${id}`);
  return t;
}
