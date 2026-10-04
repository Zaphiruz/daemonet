import { deepFreeze } from '../freeze.js';
import { BESTIARY, type EvolutionRule, type RuledBestiaryRow } from '../content/bestiary.js';

/*
 * SERVER-ONLY. Evolution requirements, hidden ones included. This module is reachable only through the
 * `@daemonet/rules/evolution` subpath; the frontend, the sandbox and the SDK must never import it
 * (eslint `no-restricted-imports`, and `scripts/check-player-bundles.mjs` greps every player build for
 * `EVOLUTION_RULES_TAG` and for each hidden requirement).
 */

/**
 * A unique marker carried inside the requirement table itself (not a separate constant a bundler could
 * drop on its own): any bundle that contains the table contains this string.
 */
export const EVOLUTION_RULES_TAG = 'daemonet:server-only:evolution-rules:5f0c2a9e';

const TABLE = deepFreeze({
  tag: EVOLUTION_RULES_TAG,
  /** Forms with a requirement beyond the level (bestiary spec §4); every other form is level-only and public. */
  rules: {
    upstarter: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    runlevion: { requirement: [{ kind: 'heldItem', item: 'setuidbit' }], hidden: false },
    launchdrake: { requirement: [{ kind: 'subnet', subnet: 'cloudnet' }], hidden: true },
    pidzero: { requirement: [{ kind: 'originalOperator' }, { kind: 'crashes', op: 'max', count: 0 }], hidden: true },
    ioctlynx: { requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
    broadcaw: { requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
    pathfinch: { requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
    anycastrel: { requirement: [{ kind: 'dominantIV', stat: 'speed' }], hidden: true },
    pingodeth: { requirement: [{ kind: 'moveTypeUses', type: 'packet', count: 4096 }, { kind: 'subnet', subnet: 'backbone' }], hidden: true },
    ackhound: { requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
    pepperpent: { requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
    argonaut: { requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
    merklion: { requirement: [{ kind: 'originalOperator' }, { kind: 'arenaWins', count: 16 }], hidden: true },
    collider: { requirement: [{ kind: 'clean' }], hidden: true },
    streamwing: { requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
    prefetchet: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    clonewisp: { requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
    fibrill: { requirement: [{ kind: 'heldItem', item: 'guardpage' }], hidden: false },
    goroutern: { requirement: [{ kind: 'subnet', subnet: 'cloudnet' }], hidden: true },
    forkbomb: { requirement: [{ kind: 'subnet', subnet: 'kernelspace' }, { kind: 'moveTypeUses', type: 'thread', count: 4096 }], hidden: true },
    semaferret: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    toctoucan: { requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
    sigstop: { requirement: [{ kind: 'heldItem', item: 'spinlock' }], hidden: false },
    sshark: { requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
    dnsnake: { requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
    smtpelican: { requirement: [{ kind: 'dominantIV', stat: 'energy' }], hidden: true },
    connectick: { requirement: [{ kind: 'heldItem', item: 'jumboframe' }], hidden: false },
    spraygon: { requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
    brokerpa: { requirement: [{ kind: 'heldItem', item: 'regiontoken' }], hidden: false },
    zshrike: { requirement: [{ kind: 'heldItem', item: 'dotfile' }], hidden: false },
    fishell: { requirement: [{ kind: 'heldItem', item: 'warmcache' }], hidden: false },
    pwshrew: { requirement: [{ kind: 'dominantIV', stat: 'resolve' }], hidden: true },
    fifowl: { requirement: [{ kind: 'heldItem', item: 'ringseal' }], hidden: false },
    suidhawk: { requirement: [{ kind: 'heldItem', item: 'dotfile' }], hidden: false },
    bootkit: { requirement: [{ kind: 'heldItem', item: 'bootsector' }], hidden: false },
    ringminus: { requirement: [{ kind: 'subnet', subnet: 'kernelspace' }, { kind: 'dominantIV', stat: 'attack' }], hidden: true },
    nanwolf: { requirement: [{ kind: 'heldItem', item: 'cosmicray' }], hidden: false },
    tombstag: { requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
    segfang: { requirement: [{ kind: 'crashes', op: 'min', count: 64 }], hidden: true },
    derefiend: { requirement: [{ kind: 'originalOperator' }, { kind: 'subnet', subnet: 'darknet' }], hidden: true },
    blackholet: { requirement: [{ kind: 'heldItem', item: 'regiontoken' }], hidden: false },
    tearwyrm: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    checksumander: { requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
    artifactopus: { requirement: [{ kind: 'dominantIV', stat: 'haste' }], hidden: true },
    sectoroach: { requirement: [{ kind: 'heldItem', item: 'ringseal' }], hidden: false },
    bohrbug: { requirement: [{ kind: 'heldItem', item: 'guardpage' }], hidden: false },
    schrodibug: { requirement: [{ kind: 'unobserved' }, { kind: 'signature', min: 1 }], hidden: true },
    reverseal: { requirement: [{ kind: 'heldItem', item: 'keepalive' }], hidden: false },
    glasswing: { requirement: [{ kind: 'heldItem', item: 'voidshard' }], hidden: false },
    torchid: { requirement: [{ kind: 'subnet', subnet: 'darknet' }], hidden: true },
    tunnelhawk: { requirement: [{ kind: 'heldItem', item: 'cipherkey' }], hidden: false },
    edgewisp: { requirement: [{ kind: 'heldItem', item: 'onionlayer' }], hidden: false },
    shardhive: { requirement: [{ kind: 'heldItem', item: 'arenachunk' }], hidden: false },
    edgelord: { requirement: [{ kind: 'arenaWins', count: 16 }], hidden: true },
    triggoat: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    tracebeetle: { requirement: [{ kind: 'heldItem', item: 'sigmask' }], hidden: false },
    stackoverlord: { requirement: [{ kind: 'moveTypeUses', type: 'stack', count: 4096 }, { kind: 'heldItem', item: 'guardpage' }], hidden: true },
    slabear: { requirement: [{ kind: 'heldItem', item: 'bootsector' }], hidden: false },
    danglerfish: { requirement: [{ kind: 'heldItem', item: 'voidshard' }], hidden: false },
    genbadger: { requirement: [{ kind: 'heldItem', item: 'spinlock' }], hidden: false },
  } satisfies Record<string, EvolutionRule>,
});

export const EVOLUTION_RULES: Readonly<Record<string, EvolutionRule>> = TABLE.rules;

const LEVEL_ONLY: EvolutionRule = deepFreeze({ requirement: null, hidden: false });

/** A form's requirement and hidden flag (level-only forms: `{ requirement: null, hidden: false }`). */
export function ruleFor(formId: string): EvolutionRule {
  return Object.hasOwn(EVOLUTION_RULES, formId) ? EVOLUTION_RULES[formId]! : LEVEL_ONLY;
}

/** The full bestiary with each row's rule merged in (what the Codex masks before serving). */
export const BESTIARY_WITH_RULES: readonly RuledBestiaryRow[] = deepFreeze(BESTIARY.map((row) => ({ ...row, ...ruleFor(row.id) })));
