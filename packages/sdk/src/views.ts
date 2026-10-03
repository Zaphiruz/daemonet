import type { Entity } from '@daemonet/shared';

export type DaemonEntity = Extract<Entity, { kind: 'daemon' }>;
export type OperatorEntity = Extract<Entity, { kind: 'operator' }>;
/** A daemon as scripts see it: the protocol entity plus a convenience `hpPct` (0-1). */
export type DaemonView = DaemonEntity & { hpPct: number };

export interface Positioned {
  x: number;
  y: number;
}

export const distance = (a: Positioned, b: Positioned): number => Math.hypot(a.x - b.x, a.y - b.y);

export const viewOf = (e: DaemonEntity): DaemonView => ({ ...e, hpPct: e.maxHp > 0 ? e.hp / e.maxHp : 0 });

/** Small immutable query helper over positioned entities, relative to an origin. */
export class Query<T extends Positioned & { hp?: number }> {
  constructor(
    private readonly items: readonly T[],
    private readonly origin: Positioned,
  ) {}

  get length(): number {
    return this.items.length;
  }

  all(): T[] {
    return [...this.items];
  }

  filter(pred: (item: T) => boolean): Query<T> {
    return new Query(this.items.filter(pred), this.origin);
  }

  within(radius: number): Query<T> {
    return this.filter((i) => distance(i, this.origin) <= radius);
  }

  nearest(pred: (item: T) => boolean = () => true): T | undefined {
    let best: T | undefined;
    let bestDist = Infinity;
    for (const i of this.items) {
      if (!pred(i)) continue;
      const d = distance(i, this.origin);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  }

  lowestHp(pred: (item: T) => boolean = () => true): T | undefined {
    let best: T | undefined;
    for (const i of this.items) if (pred(i) && (best === undefined || (i.hp ?? Infinity) < (best.hp ?? Infinity))) best = i;
    return best;
  }
}
