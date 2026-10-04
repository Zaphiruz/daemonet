import { deepFreeze } from '../freeze.js';
import type { TypeId } from '../types.js';
import { SANDBOX } from './arena.js';
import { BESTIARY } from './bestiary.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionDef {
  name: string;
  rect: Rect;
  /** Inclusive level range for spawns. */
  levels: readonly [number, number];
  /** species id -> relative spawn weight. */
  species: Readonly<Record<string, number>>;
  /** Max wild daemons alive in this region. */
  cap: number;
  /** One respawn per interval while below cap. */
  respawnMs: number;
}

/** A tile an operator can travel from: `travel { gatewayId }` within GATEWAY_RADIUS of `at` lands at `arrive` in `to`. */
export interface GatewayDef {
  id: string;
  at: { x: number; y: number };
  to: string;
  arrive: { x: number; y: number };
  /** The highest level in RAM must reach this. */
  requires: { level: number };
  /** Only usable while an Incident is open in the destination (SP4 plan 4 enforces it in `travel`). */
  incidentOnly?: boolean;
}

export interface SubnetDef {
  id: string;
  /** 0 (lo) .. 4; drives ticket payouts and shop text (SP3b). */
  tier: number;
  width: number;
  height: number;
  /** Blocked rectangles (tile units). The outer border is always blocked. */
  walls: readonly Rect[];
  /** Host node: restore point, store/load point. */
  host: { x: number; y: number };
  /** Where new operators appear. */
  spawn: { x: number; y: number };
  regions: readonly RegionDef[];
  gateways: readonly GatewayDef[];
  /** Boss arena (kernelspace only): centre and radius in tiles. */
  arena?: { x: number; y: number; radius: number };
}

export const GATEWAY_RADIUS = 2;

/**
 * `lo` spawns every base form (SP3a): the non-starter bases are dealt to the four level bands
 * round-robin by bestiary order (`i % 4`, so neighbouring lines land in different bands); the four starters
 * are always in band 0, the lobby.
 */
function loWeights(band: number): Record<string, number> {
  const bases = BESTIARY.filter((r) => r.stage === 0);
  const out: Record<string, number> = {};
  bases.forEach((r, i) => {
    if (r.starter) {
      if (band === 0) out[r.id] = 3;
      return;
    }
    if (i % 4 === band) out[r.id] = 2;
  });
  return out;
}

/**
 * Species -> weight for every non-capstone form whose primary type is in `types` and whose tree depth
 * is in `stages` (SP3b spec 4.1). Evolved forms spawn wild as themselves; capstones never do (`capstone`, not
 * a stage number: capstones are stage 3 or 4). The deepest listed stage weighs 1, the others 2.
 */
export function spawnTable(types: readonly TypeId[], stages: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const deepest = Math.max(...stages);
  for (const r of BESTIARY) {
    if (r.capstone || !stages.includes(r.stage) || !types.includes(r.types[0]!)) continue;
    out[r.id] = r.stage === deepest ? 1 : 2;
  }
  return out;
}

/** The layout shared by every subnet: two horizontal bars with a central gap and a vertical bar with two gaps. */
const BARS: readonly Rect[] = [
  { x: 1, y: 56, w: 51, h: 2 },
  { x: 76, y: 56, w: 51, h: 2 },
  { x: 64, y: 1, w: 2, h: 28 },
  { x: 64, y: 44, w: 2, h: 41 },
  { x: 64, y: 100, w: 2, h: 27 },
];

/** Four quadrant regions (the same footprint in every subnet) at the given species and level bands. */
function quadrants(species: readonly Record<string, number>[], levels: readonly (readonly [number, number])[]): RegionDef[] {
  const rects: Rect[] = [
    { x: 24, y: 8, w: 32, h: 36 },
    { x: 72, y: 8, w: 48, h: 40 },
    { x: 8, y: 64, w: 48, h: 56 },
    { x: 72, y: 64, w: 48, h: 56 },
  ];
  const names = ['lobby', 'uplink', 'cache', 'core'];
  return rects.map((rect, i) => ({ name: names[i]!, rect, levels: levels[i]!, species: species[i]!, cap: 16, respawnMs: 4096 }));
}

const CORNER_SE = { x: 122.5, y: 122.5 };
const CORNER_NE = { x: 122.5, y: 5.5 };
const CORNER_NW = { x: 3.5, y: 3.5 };
const ARRIVE_NW = { x: 5.5, y: 5.5 };
const ARRIVE_SE = { x: 120.5, y: 120.5 };
const ARRIVE_NE = { x: 120.5, y: 7.5 };

const gate = (id: string, at: { x: number; y: number }, to: string, arrive: { x: number; y: number }, level: number): GatewayDef => ({
  id,
  at,
  to,
  arrive,
  requires: { level },
});

/** 128 x 128, one host, four spawn regions of rising level. */
export const LO: SubnetDef = deepFreeze<SubnetDef>({
  id: 'lo',
  tier: 0,
  width: 128,
  height: 128,
  walls: BARS,
  host: { x: 16.5, y: 16.5 },
  spawn: { x: 18.5, y: 16.5 },
  regions: quadrants([loWeights(0), loWeights(1), loWeights(2), loWeights(3)], [
    [2, 6],
    [5, 10],
    [9, 16],
    [14, 24],
  ]),
  gateways: [gate('lo-lan', CORNER_SE, 'lan', ARRIVE_NW, 8)],
});

type Bands = readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];

function subnet(id: string, tier: number, types: readonly TypeId[], stages: readonly number[], levels: Bands, gateways: GatewayDef[]): SubnetDef {
  const lower = stages.length > 1 ? stages.slice(0, -1) : stages;
  return deepFreeze<SubnetDef>({
    id,
    tier,
    width: 128,
    height: 128,
    walls: BARS,
    host: { x: 16.5, y: 16.5 },
    spawn: { x: 18.5, y: 16.5 },
    regions: quadrants([spawnTable(types, lower), spawnTable(types, stages), spawnTable(types, stages), spawnTable(types, stages)], levels),
    gateways,
  });
}

// Region level bands are the SP3b spec table (4.1) verbatim: lobby · uplink · cache · core.
export const LAN = subnet('lan', 1, ['kernel', 'packet', 'socket', 'thread'], [0, 1], [[8, 14], [12, 18], [16, 22], [18, 24]], [
  gate('lan-lo', CORNER_NW, 'lo', ARRIVE_SE, 0),
  gate('lan-dmz', CORNER_SE, 'dmz', ARRIVE_NW, 16),
]);
export const DMZ = subnet('dmz', 2, ['crypto', 'root', 'shell', 'proxy'], [1, 2], [[16, 22], [20, 26], [24, 30], [28, 34]], [
  gate('dmz-lan', CORNER_NW, 'lan', ARRIVE_SE, 0),
  gate('dmz-backbone', CORNER_SE, 'backbone', ARRIVE_NW, 24),
]);
export const BACKBONE = subnet('backbone', 3, ['packet', 'socket', 'cloud', 'buffer'], [1, 2], [[24, 30], [28, 34], [32, 38], [36, 42]], [
  gate('backbone-dmz', CORNER_NW, 'dmz', ARRIVE_SE, 0),
  gate('backbone-darknet', CORNER_NE, 'darknet', ARRIVE_NW, 32),
  gate('backbone-cloudnet', CORNER_SE, 'cloudnet', ARRIVE_NW, 40),
  { ...gate('backbone-kernelspace', { x: 122.5, y: 64.5 }, 'kernelspace', { x: 66.5, y: 112.5 }, 32), incidentOnly: true },
]);
export const DARKNET = subnet('darknet', 4, ['null', 'glitch', 'proxy', 'crypto'], [2, 3], [[32, 38], [36, 42], [40, 46], [44, 50]], [
  gate('darknet-backbone', CORNER_NW, 'backbone', ARRIVE_NE, 0),
]);
export const CLOUDNET = subnet('cloudnet', 4, ['cloud', 'cache', 'heap', 'stack'], [2, 3], [[40, 46], [44, 50], [48, 54], [52, 58]], [
  gate('cloudnet-backbone', CORNER_NW, 'backbone', ARRIVE_SE, 0),
]);

/**
 * Incidents (SP4 spec 8): 128 x 128 open floor, boss arena in the north, host in the south; nothing spawns on its own.
 * Reached only through the Incident-only `backbone-kernelspace` gateway.
 */
export const KERNELSPACE: SubnetDef = deepFreeze<SubnetDef>({
  id: 'kernelspace',
  tier: 5,
  width: 128,
  height: 128,
  walls: [],
  host: { x: 64.5, y: 112.5 },
  spawn: { x: 66.5, y: 112.5 },
  regions: [],
  gateways: [gate('kernelspace-backbone', { x: 64.5, y: 122.5 }, 'backbone', { x: 120.5, y: 64.5 }, 0)],
  arena: { x: 64.5, y: 40.5, radius: 24 },
});

export const SUBNETS: readonly SubnetDef[] = deepFreeze([LO, LAN, DMZ, BACKBONE, DARKNET, CLOUDNET, KERNELSPACE]);
/** Open-world subnets (those with spawn regions: tickets, wild spawns). */
export const OPEN_SUBNET_IDS: readonly string[] = deepFreeze(SUBNETS.filter((s) => s.regions.length > 0).map((s) => s.id));
/**
 * What one sim process hosts as persistent worlds: the open subnets plus kernelspace. The SP6 sandbox is not among
 * them (nor in `SUBNETS` / `SUBNET_IDS`): the runtime creates a sandbox world per arena match.
 */
export const HOSTED_SUBNET_IDS: readonly string[] = deepFreeze(SUBNETS.map((s) => s.id));
/** Every subnet id that exists in the rules (an evolution `subnet` requirement must name one of these). */
export const SUBNET_IDS: readonly string[] = HOSTED_SUBNET_IDS;

export function getSubnet(id: string): SubnetDef {
  if (id === SANDBOX.id) return SANDBOX;
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}

export function getGateway(subnetId: string, gatewayId: string): GatewayDef | undefined {
  return getSubnet(subnetId).gateways.find((g) => g.id === gatewayId);
}
