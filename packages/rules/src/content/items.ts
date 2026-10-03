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

export type ItemDef = ToolDef | RestoreDef;
export type ItemId = ItemDef['id'];

export const ITEMS: readonly ItemDef[] = [
  { id: 'sniff', kind: 'tool', name: 'sniff', range: 4, deadlineMs: 2048, noise: 2, sizeMultiplier: 1 },
  { id: 'tap', kind: 'tool', name: 'tap', range: 6, deadlineMs: 4096, noise: 1, sizeMultiplier: 1 },
  { id: 'mirror', kind: 'tool', name: 'mirror', range: 8, deadlineMs: 4096, noise: 0, sizeMultiplier: 1 },
  { id: 'dump', kind: 'tool', name: 'dump', range: 8, deadlineMs: 8192, noise: 0, sizeMultiplier: 0.5 },
  { id: 'restore', kind: 'restore', name: 'restore' },
];

export const STARTING_INVENTORY: Readonly<Partial<Record<ItemId, number>>> = { sniff: 8, restore: 2 };

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

function getItemOrNull(id: string): ItemDef | null {
  return BY_ID.get(id as ItemId) ?? null;
}
