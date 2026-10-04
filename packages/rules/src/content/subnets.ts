import { deepFreeze } from '../freeze.js';
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

export interface SubnetDef {
  id: string;
  width: number;
  height: number;
  /** Blocked rectangles (tile units). The outer border is always blocked. */
  walls: readonly Rect[];
  /** Host node: restore point, store/load point. */
  host: { x: number; y: number };
  /** Where new operators appear. */
  spawn: { x: number; y: number };
  regions: readonly RegionDef[];
}

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

/** 128 x 128, one host, four spawn regions of rising level. */
export const LO: SubnetDef = deepFreeze<SubnetDef>({
  id: 'lo',
  width: 128,
  height: 128,
  walls: [
    { x: 1, y: 56, w: 51, h: 2 },
    { x: 76, y: 56, w: 51, h: 2 },
    { x: 64, y: 1, w: 2, h: 28 },
    { x: 64, y: 44, w: 2, h: 41 },
    { x: 64, y: 100, w: 2, h: 27 },
  ],
  host: { x: 16.5, y: 16.5 },
  spawn: { x: 18.5, y: 16.5 },
  regions: [
    { name: 'lobby', rect: { x: 24, y: 8, w: 32, h: 36 }, levels: [2, 6], species: loWeights(0), cap: 16, respawnMs: 4096 },
    { name: 'uplink', rect: { x: 72, y: 8, w: 48, h: 40 }, levels: [5, 10], species: loWeights(1), cap: 16, respawnMs: 4096 },
    { name: 'cache', rect: { x: 8, y: 64, w: 48, h: 56 }, levels: [9, 16], species: loWeights(2), cap: 16, respawnMs: 4096 },
    { name: 'core', rect: { x: 72, y: 64, w: 48, h: 56 }, levels: [14, 24], species: loWeights(3), cap: 16, respawnMs: 4096 },
  ],
});

export const SUBNETS: readonly SubnetDef[] = deepFreeze([LO]);

export function getSubnet(id: string): SubnetDef {
  const s = SUBNETS.find((x) => x.id === id);
  if (!s) throw new RangeError(`unknown subnet ${id}`);
  return s;
}
