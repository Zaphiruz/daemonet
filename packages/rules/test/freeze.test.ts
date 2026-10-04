import { describe, expect, it } from 'vitest';
import { WORDS } from '../src/capture/crypto.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { EVOLUTION_ITEMS, ITEMS, STARTING_INVENTORY } from '../src/content/items.js';
import { MOVES, getMove, type MoveDef } from '../src/content/moves.js';
import { SPECIES, getSpecies } from '../src/content/species.js';
import { ROLE_TRAITS, TRAITS } from '../src/content/traits.js';
import { NATURES } from '../src/natures.js';
import { BEATS, IMMUNE, RESISTED_BY, TYPES } from '../src/types.js';

describe('content tables are deep-frozen', () => {
  it.each([
    ['MOVES', MOVES],
    ['TRAITS', TRAITS],
    ['ROLE_TRAITS', ROLE_TRAITS],
    ['BESTIARY', BESTIARY],
    ['EVOLUTION_ITEMS', EVOLUTION_ITEMS],
    ['SPECIES', SPECIES],
    ['ITEMS', ITEMS],
    ['STARTING_INVENTORY', STARTING_INVENTORY],
    ['NATURES', NATURES],
    ['TYPES', TYPES],
    ['BEATS', BEATS],
    ['RESISTED_BY', RESISTED_BY],
    ['IMMUNE', IMMUNE],
    ['WORDS', WORDS],
  ])('%s is frozen', (_name, table) => {
    expect(Object.isFrozen(table)).toBe(true);
  });

  it('nested objects and shared arrays are frozen', () => {
    expect(Object.isFrozen(getMove('encrypt'))).toBe(true);
    expect(Object.isFrozen(getMove('encrypt').status)).toBe(true);
    expect(Object.isFrozen(getMove('broadcast').shape)).toBe(true);
    const pingling = getSpecies('pingling');
    expect(Object.isFrozen(pingling.base)).toBe(true);
    expect(Object.isFrozen(pingling.types)).toBe(true);
    expect(Object.isFrozen(pingling.traits)).toBe(true);
    expect(Object.isFrozen(pingling.learnset)).toBe(true);
    expect(Object.isFrozen(pingling.learnset[0])).toBe(true);
    // The learnset array is shared between species of a type.
    expect(getSpecies('floodhound').learnset).toBe(pingling.learnset);
    expect(Object.isFrozen(ITEMS[0])).toBe(true);
    expect(Object.isFrozen(NATURES[4])).toBe(true);
    expect(Object.isFrozen(SPECIES[0])).toBe(true);
    expect(Object.isFrozen(TRAITS[0])).toBe(true);
    expect(Object.isFrozen(BESTIARY[0])).toBe(true);
    expect(Object.isFrozen(BESTIARY[0]!.types)).toBe(true);
    expect(Object.isFrozen(BESTIARY.find((r) => r.requirement)!.requirement)).toBe(true);
    expect(Object.isFrozen(ROLE_TRAITS.tank)).toBe(true);
    expect(Object.isFrozen(EVOLUTION_ITEMS[0])).toBe(true);
    expect(Object.isFrozen(BEATS.kernel)).toBe(true);
    expect(Object.isFrozen(RESISTED_BY.kernel)).toBe(true);
  });

  it('assigning to a move throws (ESM is strict)', () => {
    const ping = getMove('ping') as { -readonly [K in keyof MoveDef]: MoveDef[K] };
    expect(() => {
      ping.power = 999;
    }).toThrow(TypeError);
    expect(getMove('ping').power).toBe(20);
  });
});
