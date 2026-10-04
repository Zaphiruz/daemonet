import { describe, expect, it } from 'vitest';
import * as server from '../src/evolution/index.js';
import * as pub from '../src/index.js';

/** Every object/array reachable from `root` (cycles and functions skipped). */
function* walk(root: unknown, seen = new Set<unknown>()): Generator<[path: string, value: Record<string, unknown>]> {
  const stack: Array<[string, unknown]> = [['', root]];
  while (stack.length > 0) {
    const [path, v] = stack.pop()!;
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    yield [path, v as Record<string, unknown>];
    const entries = v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v].map((x, i) => [i, x]) : Object.entries(v);
    for (const [k, child] of entries) stack.push([`${path}.${String(k)}`, child]);
  }
}

describe('the public @daemonet/rules entry carries no evolution requirement data', () => {
  it('has no non-null requirement and no hidden row anywhere in its exports', () => {
    const leaks: string[] = [];
    for (const [name, value] of Object.entries(pub)) {
      for (const [path, obj] of walk(value)) {
        if ('requirement' in obj && obj.requirement !== null && obj.requirement !== undefined) leaks.push(`${name}${path}.requirement`);
        if (obj.hidden === true) leaks.push(`${name}${path}.hidden`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('exports nothing from the server-only evolution module', () => {
    const strings: string[] = [];
    for (const value of Object.values(pub)) {
      if (typeof value === 'string') strings.push(value);
      for (const [, obj] of walk(value)) for (const v of Object.values(obj)) if (typeof v === 'string') strings.push(v);
    }
    expect(strings).not.toContain(server.EVOLUTION_RULES_TAG);
    for (const name of ['EVOLUTION_RULES', 'EVOLUTION_RULES_TAG', 'BESTIARY_WITH_RULES', 'ruleFor', 'requirementMet', 'evolutionOptions', 'applyEvolution']) {
      expect(pub, name).not.toHaveProperty(name);
    }
  });

  it('keeps every requirement on the server subpath, hidden ones included', () => {
    expect(Object.keys(server.EVOLUTION_RULES).length).toBeGreaterThan(0);
    expect(server.ruleFor('anycastrel')).toEqual({ requirement: [{ kind: 'dominantIV', stat: 'speed' }], hidden: true });
    expect(server.ruleFor('tracerat')).toEqual({ requirement: null, hidden: false });
    const merged = server.BESTIARY_WITH_RULES.find((r) => r.id === 'broadcaw')!;
    expect(merged).toMatchObject({ name: 'Broadcaw', requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false });
    expect(server.BESTIARY_WITH_RULES).toHaveLength(pub.BESTIARY.length);
  });
});
