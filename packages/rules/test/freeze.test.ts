import { describe, expect, it } from 'vitest';
import { WORDS } from '../src/capture/crypto.js';
import { GROUPS, USERS } from '../src/capture/root.js';
import { FLAGS, TRANSITIONS } from '../src/capture/socket.js';
import { FRAGMENT_IDS, RECIPES, SHOP } from '../src/content/economy.js';
import { BESTIARY } from '../src/content/bestiary.js';
import { BESTIARY_WITH_RULES, EVOLUTION_RULES } from '../src/evolution/rules.js';
import { EVOLUTION_ITEMS, ITEMS, STARTING_INVENTORY } from '../src/content/items.js';
import { MOVES, STATUS_IDS, TYPE_MOVES, TYPE_STATUS, getMove, type MoveDef } from '../src/content/moves.js';
import { ROLE_WEIGHTS, SPECIES, STAGE_BUDGETS, STAT_OVERRIDES, getSpecies } from '../src/content/species.js';
import { BACKBONE, CLOUDNET, DARKNET, DMZ, LAN, LO, OPEN_SUBNET_IDS, SUBNETS } from '../src/content/subnets.js';
import { ROLE_TRAITS, TRAITS } from '../src/content/traits.js';
import { NATURES } from '../src/natures.js';
import { BEATS, IMMUNE, RESISTED_BY, TYPES } from '../src/types.js';

describe('content tables are deep-frozen', () => {
  it.each([
    ['MOVES', MOVES],
    ['TRAITS', TRAITS],
    ['ROLE_TRAITS', ROLE_TRAITS],
    ['BESTIARY', BESTIARY],
    ['EVOLUTION_RULES', EVOLUTION_RULES],
    ['BESTIARY_WITH_RULES', BESTIARY_WITH_RULES],
    ['EVOLUTION_ITEMS', EVOLUTION_ITEMS],
    ['SPECIES', SPECIES],
    ['STAGE_BUDGETS', STAGE_BUDGETS],
    ['ROLE_WEIGHTS', ROLE_WEIGHTS],
    ['STAT_OVERRIDES', STAT_OVERRIDES],
    ['LO', LO],
    ['LAN', LAN],
    ['DMZ', DMZ],
    ['BACKBONE', BACKBONE],
    ['DARKNET', DARKNET],
    ['CLOUDNET', CLOUDNET],
    ['OPEN_SUBNET_IDS', OPEN_SUBNET_IDS],
    ['SUBNETS', SUBNETS],
    ['ITEMS', ITEMS],
    ['STARTING_INVENTORY', STARTING_INVENTORY],
    ['SHOP', SHOP],
    ['RECIPES', RECIPES],
    ['FRAGMENT_IDS', FRAGMENT_IDS],
    ['NATURES', NATURES],
    ['TYPES', TYPES],
    ['BEATS', BEATS],
    ['RESISTED_BY', RESISTED_BY],
    ['IMMUNE', IMMUNE],
    ['STATUS_IDS', STATUS_IDS],
    ['TYPE_MOVES', TYPE_MOVES],
    ['TYPE_STATUS', TYPE_STATUS],
    ['WORDS', WORDS],
    ['TRANSITIONS', TRANSITIONS],
    ['FLAGS', FLAGS],
    ['USERS', USERS],
    ['GROUPS', GROUPS],
  ])('%s is frozen', (_name, table) => {
    expect(table).toBeTypeOf('object'); // Object.isFrozen(undefined) is true: a missing export must not pass
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
    expect(Object.isFrozen(STAGE_BUDGETS)).toBe(true);
    expect(Object.isFrozen(ROLE_WEIGHTS.tank)).toBe(true);
    expect(Object.isFrozen(STAT_OVERRIDES.pingling)).toBe(true);
    expect(Object.isFrozen(LO.regions[0]!.species)).toBe(true);
    expect(Object.isFrozen(LAN.regions[0]!.species)).toBe(true);
    expect(Object.isFrozen(BACKBONE.gateways)).toBe(true);
    expect(Object.isFrozen(BACKBONE.gateways[0])).toBe(true);
    expect(Object.isFrozen(BACKBONE.gateways[0]!.requires)).toBe(true);
    expect(Object.isFrozen(ITEMS[0])).toBe(true);
    expect(Object.isFrozen(NATURES[4])).toBe(true);
    expect(Object.isFrozen(SPECIES[0])).toBe(true);
    expect(Object.isFrozen(TRAITS[0])).toBe(true);
    expect(Object.isFrozen(BESTIARY[0])).toBe(true);
    expect(Object.isFrozen(BESTIARY[0]!.types)).toBe(true);
    expect(Object.isFrozen(EVOLUTION_RULES.anycastrel)).toBe(true);
    expect(Object.isFrozen(EVOLUTION_RULES.anycastrel!.requirement)).toBe(true);
    expect(Object.isFrozen(EVOLUTION_RULES.anycastrel!.requirement![0])).toBe(true);
    expect(Object.isFrozen(BESTIARY_WITH_RULES[0])).toBe(true);
    expect(Object.isFrozen(BESTIARY_WITH_RULES.find((r) => r.requirement)!.requirement)).toBe(true);
    expect(Object.isFrozen(ROLE_TRAITS.tank)).toBe(true);
    expect(Object.isFrozen(EVOLUTION_ITEMS[0])).toBe(true);
    expect(Object.isFrozen(RECIPES[0]!.fragments)).toBe(true);
    expect(Object.isFrozen(RECIPES[0]!.output)).toBe(true);
    expect(Object.isFrozen(ITEMS.find((i) => i.kind === 'fragment'))).toBe(true);
    expect(Object.isFrozen(BEATS.kernel)).toBe(true);
    expect(Object.isFrozen(RESISTED_BY.kernel)).toBe(true);
    expect(Object.isFrozen(TRANSITIONS.SYN_RCVD)).toBe(true);
  });

  it('assigning to a move throws (ESM is strict)', () => {
    const ping = getMove('ping') as { -readonly [K in keyof MoveDef]: MoveDef[K] };
    expect(() => {
      ping.power = 999;
    }).toThrow(TypeError);
    expect(getMove('ping').power).toBe(20);
  });
});
