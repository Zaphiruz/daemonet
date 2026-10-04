import { deepFreeze } from '../freeze.js';
import { TYPES, type TypeId } from '../types.js';

export type ToolId = 'sniff' | 'tap' | 'mirror' | 'dump';
export type Noise = 0 | 1 | 2;

export interface ToolDef {
  id: ToolId;
  kind: 'tool';
  name: string;
  /** Link range in tiles. */
  range: number;
  deadlineMs: number;
  noise: Noise;
  /** Multiplies the challenge size (dump halves it). */
  sizeMultiplier: number;
}

export interface RestoreDef {
  id: 'restore';
  kind: 'restore';
  name: string;
}

export type HeldEffect = 'damageDealt' | 'cooldown' | 'energyRegen' | 'damageTaken';

/** Worn in the single held-item slot; effect is a multiplier on the named quantity. */
export interface HeldDef {
  id: 'amplifier' | 'heatsink' | 'battery' | 'firewall';
  kind: 'held';
  name: string;
  effect: HeldEffect;
  multiplier: number;
}

/** Held and consumed by a branch that requires it (bestiary §3). */
export interface EvolutionItemDef {
  id: EvolutionItemId;
  kind: 'evolution';
  name: string;
  type: TypeId;
}

/** Raises one IV by 1 (cap 31) and marks the daemon patched forever. */
export interface BitFlipperDef {
  id: 'bitflipper';
  kind: 'bitflipper';
  name: string;
}

export type FragmentId = `frag:${TypeId}`;

/** Decompile output; 16 fungible materials, one per type (`frag:<type>`). */
export interface FragmentDef {
  id: FragmentId;
  kind: 'fragment';
  name: string;
  type: TypeId;
}

export type ItemDef = ToolDef | RestoreDef | HeldDef | EvolutionItemDef | BitFlipperDef | FragmentDef;
export type ItemId = ItemDef['id'];

const EVOLUTION_ROWS = [
  ['bootsector', 'Boot Sector', 'kernel'],
  ['jumboframe', 'Jumbo Frame', 'packet'],
  ['cipherkey', 'Cipher Key', 'crypto'],
  ['warmcache', 'Warm Cache', 'cache'],
  ['spinlock', 'Spinlock', 'thread'],
  ['sigmask', 'Sigmask', 'signal'],
  ['keepalive', 'Keepalive', 'socket'],
  ['ringseal', 'Ring Seal', 'buffer'],
  ['dotfile', 'Dotfile', 'shell'],
  ['setuidbit', 'Setuid Bit', 'root'],
  ['voidshard', 'Void Shard', 'null'],
  ['cosmicray', 'Cosmic Ray', 'glitch'],
  ['onionlayer', 'Onion Layer', 'proxy'],
  ['regiontoken', 'Region Token', 'cloud'],
  ['guardpage', 'Guard Page', 'stack'],
  ['arenachunk', 'Arena Chunk', 'heap'],
] as const satisfies readonly (readonly [string, string, TypeId])[];

export type EvolutionItemId = (typeof EVOLUTION_ROWS)[number][0];

export const EVOLUTION_ITEMS: readonly EvolutionItemDef[] = deepFreeze(
  EVOLUTION_ROWS.map(([id, name, type]) => ({ id, kind: 'evolution' as const, name, type })),
);

export const ITEMS: readonly ItemDef[] = deepFreeze([
  { id: 'sniff', kind: 'tool', name: 'sniff', range: 4, deadlineMs: 2048, noise: 2, sizeMultiplier: 1 },
  { id: 'tap', kind: 'tool', name: 'tap', range: 6, deadlineMs: 4096, noise: 1, sizeMultiplier: 1 },
  { id: 'mirror', kind: 'tool', name: 'mirror', range: 8, deadlineMs: 4096, noise: 0, sizeMultiplier: 1 },
  { id: 'dump', kind: 'tool', name: 'dump', range: 8, deadlineMs: 8192, noise: 0, sizeMultiplier: 0.5 },
  { id: 'restore', kind: 'restore', name: 'restore' },
  { id: 'amplifier', kind: 'held', name: 'Amplifier', effect: 'damageDealt', multiplier: 1.125 },
  { id: 'heatsink', kind: 'held', name: 'Heatsink', effect: 'cooldown', multiplier: 0.875 },
  { id: 'battery', kind: 'held', name: 'Battery', effect: 'energyRegen', multiplier: 1.5 },
  { id: 'firewall', kind: 'held', name: 'Firewall', effect: 'damageTaken', multiplier: 0.875 },
  { id: 'bitflipper', kind: 'bitflipper', name: 'Bit Flipper' },
  ...EVOLUTION_ITEMS,
  ...TYPES.map((type): FragmentDef => ({ id: `frag:${type}`, kind: 'fragment', name: `${type} fragment`, type })),
]);

export const STARTING_INVENTORY: Readonly<Partial<Record<ItemId, number>>> = deepFreeze({ sniff: 8, restore: 2 });

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): ItemDef {
  const item = BY_ID.get(id as ItemId);
  if (!item) throw new RangeError(`unknown item ${id}`);
  return item;
}

export function isToolId(id: string): id is ToolId {
  return getItemOrNull(id)?.kind === 'tool';
}

export function getTool(id: ToolId): ToolDef {
  const item = getItem(id);
  if (item.kind !== 'tool') throw new RangeError(`${id} is not a tool`);
  return item;
}

/** Items that can sit in the held slot. */
export function isHoldable(id: string): boolean {
  const kind = getItemOrNull(id)?.kind;
  return kind === 'held' || kind === 'evolution';
}

function getItemOrNull(id: string): ItemDef | null {
  return BY_ID.get(id as ItemId) ?? null;
}
