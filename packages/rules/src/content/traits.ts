import { deepFreeze } from '../freeze.js';
import type { Role } from './bestiary.js';

export interface TraitDef {
  id: string;
  name: string;
  description: string;
}

/** Effects are implemented in the sim (SP3a spec §3.5). */
export const TRAITS: readonly TraitDef[] = deepFreeze([
  { id: 'echo', name: 'Echo', description: 'Filler moves (cooldown ≤ 512 ms) have a 25% chance to hit again at half power.' },
  { id: 'lowlatency', name: 'Low Latency', description: 'The first move after becoming active or being tagged ignores its cooldown.' },
  { id: 'synburst', name: 'SYN Burst', description: 'Filler moves cost no energy below 25% HP.' },
  { id: 'retransmit', name: 'Retransmit', description: 'An area move that hits nothing refunds its energy.' },
  { id: 'salted', name: 'Salted', description: 'Takes 25% less damage from the same move as the previous hit.' },
  { id: 'onewayfn', name: 'One-Way', description: 'Immune to status effects.' },
  { id: 'darkmode', name: 'Dark Mode', description: 'Moves with range 6 or more deal 25% less to it.' },
  { id: 'sonar', name: 'Sonar', description: '+2 range on single-target moves.' },
  { id: 'overclock', name: 'Overclock', description: 'Cooldowns −12.5% below 25% HP.' },
  { id: 'bitshield', name: 'Bitshield', description: 'The first hit in each engagement is blocked.' },
  { id: 'entropy', name: 'Entropy', description: 'Statuses it inflicts last 50% longer.' },
  { id: 'decay', name: 'Decay', description: 'Targets it hits lose 4 energy.' },
  { id: 'nullsafe', name: 'Null Safe', description: 'Survives one lethal hit per engagement at 1 HP.' },
  { id: 'lazyeval', name: 'Lazy Eval', description: 'Heavy moves (cooldown ≥ 4096 ms) cost 25% less energy.' },
  { id: 'voidstep', name: 'Void Step', description: '+50% movement speed with no hostile within 8 tiles.' },
  { id: 'absorb', name: 'Absorb', description: 'Regains energy equal to 10% of damage taken.' },
]);

/** The two traits every species of a role can roll (slot 0 / slot 1). */
export const ROLE_TRAITS: Readonly<Record<Role, readonly [string, string]>> = deepFreeze({
  balanced: ['lowlatency', 'nullsafe'],
  sweeper: ['sonar', 'voidstep'],
  nuker: ['lazyeval', 'entropy'],
  tank: ['bitshield', 'absorb'],
  wall: ['salted', 'darkmode'],
  striker: ['echo', 'overclock'],
  spammer: ['synburst', 'decay'],
  support: ['entropy', 'retransmit'],
  scout: ['voidstep', 'lowlatency'],
  bruiser: ['overclock', 'nullsafe'],
  battery: ['absorb', 'synburst'],
});

const BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

export function getTrait(id: string): TraitDef {
  const t = BY_ID.get(id);
  if (!t) throw new RangeError(`unknown trait ${id}`);
  return t;
}
