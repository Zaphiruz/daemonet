import type { Entity, EntityPatch } from '@daemonet/shared';

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Diff what a connection already knows against what it should see now.
 * New entities are sent whole; known ones only with changed fields; vanished ones as removes.
 * `known` is updated in place to `current`.
 */
export function diffEntities(known: Map<string, Entity>, current: readonly Entity[]): { upserts: EntityPatch[]; removes: string[] } {
  const upserts: EntityPatch[] = [];
  const seen = new Set<string>();
  for (const e of current) {
    seen.add(e.id);
    const prev = known.get(e.id);
    if (!prev || prev.kind !== e.kind) {
      upserts.push(e);
    } else {
      const patch: Record<string, unknown> = { kind: e.kind, id: e.id };
      let changed = false;
      for (const [key, value] of Object.entries(e)) {
        if (!same((prev as Record<string, unknown>)[key], value)) {
          patch[key] = value;
          changed = true;
        }
      }
      if (changed) upserts.push(patch as EntityPatch);
    }
    known.set(e.id, e);
  }
  const removes: string[] = [];
  for (const id of known.keys()) {
    if (!seen.has(id)) {
      removes.push(id);
      known.delete(id);
    }
  }
  return { upserts, removes };
}
