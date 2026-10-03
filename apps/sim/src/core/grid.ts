import type { Rect, Rng, SubnetDef } from '@daemonet/rules';

export interface Point {
  x: number;
  y: number;
}

export const MAX_PATH_TILES = 256;
const MAX_EXPANSIONS = 8192;
const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Min-heap of node indices keyed by f-score. */
class Heap {
  private items: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(node: number): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.f[items[parent]!]! <= this.f[items[i]!]!) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.f[items[l]!]! < this.f[items[m]!]!) m = l;
        if (r < items.length && this.f[items[r]!]! < this.f[items[m]!]!) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

export class Grid {
  readonly width: number;
  readonly height: number;
  private readonly blocked: Uint8Array;

  constructor(def: SubnetDef) {
    this.width = def.width;
    this.height = def.height;
    this.blocked = new Uint8Array(def.width * def.height);
    for (let x = 0; x < def.width; x++) {
      this.block(x, 0);
      this.block(x, def.height - 1);
    }
    for (let y = 0; y < def.height; y++) {
      this.block(0, y);
      this.block(def.width - 1, y);
    }
    for (const r of def.walls) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.block(x, y);
    }
  }

  private block(x: number, y: number): void {
    this.blocked[y * this.width + x] = 1;
  }

  isWalkableTile(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height && this.blocked[ty * this.width + tx] === 0;
  }

  isWalkablePoint(p: Point): boolean {
    return this.isWalkableTile(Math.floor(p.x), Math.floor(p.y));
  }

  /**
   * 8-directional A* without corner cutting. Returns waypoints (tile centres, the last one replaced by `to`),
   * excluding the start; [] when already at `to`; null when unreachable or longer than MAX_PATH_TILES.
   */
  findPath(from: Point, to: Point, maxExpansions = MAX_EXPANSIONS): Point[] | null {
    if (!this.isWalkablePoint(to) || !this.isWalkablePoint(from)) return null;
    const w = this.width;
    const start = Math.floor(from.y) * w + Math.floor(from.x);
    const goal = Math.floor(to.y) * w + Math.floor(to.x);
    if (start === goal) return from.x === to.x && from.y === to.y ? [] : [{ x: to.x, y: to.y }];

    const size = w * this.height;
    const g = new Float64Array(size).fill(Infinity);
    const f = new Float64Array(size).fill(Infinity);
    const came = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const gx = goal % w;
    const gy = Math.floor(goal / w);
    const h = (n: number): number => {
      const dx = Math.abs((n % w) - gx);
      const dy = Math.abs(Math.floor(n / w) - gy);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };
    const open = new Heap(f);
    g[start] = 0;
    f[start] = h(start);
    open.push(start);
    let expansions = 0;
    let found = false;

    while (open.size > 0 && expansions < maxExpansions) {
      const cur = open.pop();
      if (closed[cur]) continue;
      if (cur === goal) {
        found = true;
        break;
      }
      closed[cur] = 1;
      expansions++;
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isWalkableTile(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!this.isWalkableTile(cx + dx, cy) || !this.isWalkableTile(cx, cy + dy))) continue;
        const next = ny * w + nx;
        if (closed[next]) continue;
        const cost = g[cur]! + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
        if (cost < g[next]!) {
          g[next] = cost;
          f[next] = cost + h(next);
          came[next] = cur;
          open.push(next);
        }
      }
    }
    if (!found) return null;

    const tiles: number[] = [];
    for (let n = goal; n !== start; n = came[n]!) tiles.push(n);
    if (tiles.length > MAX_PATH_TILES) return null;
    tiles.reverse();
    const path = tiles.map((n) => ({ x: (n % w) + 0.5, y: Math.floor(n / w) + 0.5 }));
    path[path.length - 1] = { x: to.x, y: to.y };
    return path;
  }

  /** Centre of a random walkable tile inside `rect`, or null after `tries` misses. */
  randomWalkableIn(rect: Rect, rng: Rng, tries = 64): Point | null {
    for (let i = 0; i < tries; i++) {
      const x = rng.int(rect.x, rect.x + rect.w - 1);
      const y = rng.int(rect.y, rect.y + rect.h - 1);
      if (this.isWalkableTile(x, y)) return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }
}
