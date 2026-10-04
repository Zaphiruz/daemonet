import { describe, expect, it } from 'vitest';
import { SIGNATURE_MAX, STAT_KEYS, statBlock } from '../src/constants.js';
import { getSpecies } from '../src/content/species.js';
import { applyEvolution, evolutionOptions, requirementMet } from '../src/evolution/index.js';
import { emptyMoveTypeUses, typeIndex, type EvolvableDaemon, type EvolutionContext } from '../src/evolvable.js';
import { createRng } from '../src/rng.js';

const base = (over: Partial<EvolvableDaemon> = {}): EvolvableDaemon => ({
  species: 'echolet', level: 16, nature: 0, ivs: statBlock(20), bonus: statBlock(0), clean: false, signature: 0, patched: false, heldItem: null,
  moveTypeUses: emptyMoveTypeUses(), crashes: 0, arenaWins: 0, ...over,
});
const ctx = (over: Partial<EvolutionContext> = {}): EvolutionContext => ({ subnet: 'lo', unobserved: false, originalOperator: true, discovered: new Set(), ...over });

describe('requirementMet', () => {
  it('evaluates every requirement kind', () => {
    const uses = emptyMoveTypeUses();
    uses[typeIndex('packet')] = 4096;
    const d = base({ heldItem: 'jumboframe', ivs: { ...statBlock(10), speed: 31 }, moveTypeUses: uses, clean: true, signature: 2, crashes: 3, arenaWins: 16 });
    expect(requirementMet({ kind: 'heldItem', item: 'jumboframe' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'heldItem', item: 'sigmask' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'dominantIV', stat: 'speed' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'dominantIV', stat: 'attack' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'moveTypeUses', type: 'packet', count: 4096 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'moveTypeUses', type: 'glitch', count: 1 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'subnet', subnet: 'lo' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'subnet', subnet: 'darknet' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'clean' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'signature', min: 2 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'signature', min: 3 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'originalOperator' }, d, ctx({ originalOperator: false }))).toBe(false);
    expect(requirementMet({ kind: 'crashes', op: 'max', count: 0 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'crashes', op: 'min', count: 3 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'arenaWins', count: 16 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'unobserved' }, d, ctx({ unobserved: true }))).toBe(true);
  });

  it('evaluates the negative side of every requirement kind', () => {
    const uses = emptyMoveTypeUses();
    uses[typeIndex('packet')] = 4095;
    const d = base({ ivs: statBlock(20), moveTypeUses: uses, clean: false, crashes: 0, arenaWins: 15 });
    expect(requirementMet({ kind: 'clean' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'originalOperator' }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'unobserved' }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'arenaWins', count: 16 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'crashes', op: 'max', count: 0 }, d, ctx())).toBe(true);
    expect(requirementMet({ kind: 'crashes', op: 'min', count: 1 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'moveTypeUses', type: 'packet', count: 4096 }, d, ctx())).toBe(false);
    expect(requirementMet({ kind: 'dominantIV', stat: 'speed' }, d, ctx())).toBe(false); // a tie has no dominant stat
  });
});

describe('evolutionOptions', () => {
  it('lists both branches of Echolet, gating on level and items, hiding undiscovered requirements', () => {
    const opts = evolutionOptions(base({ level: 15 }), ctx());
    expect(opts.map((o) => o.form)).toEqual(['tracerat', 'broadcaw']);
    expect(opts.every((o) => !o.met)).toBe(true);
    const at16 = evolutionOptions(base(), ctx());
    expect(at16.find((o) => o.form === 'tracerat')!.met).toBe(true);
    expect(at16.find((o) => o.form === 'broadcaw')).toMatchObject({ met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] });
    expect(evolutionOptions(base({ heldItem: 'jumboframe' }), ctx()).find((o) => o.form === 'broadcaw')!.met).toBe(true);
  });

  it('returns no options for a species without evolutions', () => {
    expect(evolutionOptions(base({ species: 'pidzero', level: 64 }), ctx())).toEqual([]);
  });

  it('hides hidden branch requirements until discovered', () => {
    const d = base({ species: 'broadcaw', level: 32, ivs: { ...statBlock(10), speed: 31 } });
    const hidden = evolutionOptions(d, ctx()).find((o) => o.form === 'anycastrel')!;
    expect(hidden).toMatchObject({ hidden: true, revealed: false, requirement: null, met: true });
    const shown = evolutionOptions(d, ctx({ discovered: new Set(['anycastrel']) })).find((o) => o.form === 'anycastrel')!;
    expect(shown.requirement).toEqual([{ kind: 'dominantIV', stat: 'speed' }]);
  });
});

describe('applyEvolution', () => {
  it('grows IVs with p = 1/2, keeps signature, relearns moves and consumes the required item', () => {
    const rng = createRng('evo');
    const r = applyEvolution(base({ heldItem: 'jumboframe', signature: 2, clean: true, ivs: statBlock(31) }), 'broadcaw', rng, { iv: 0.5, signature: 0 });
    expect(r.species).toBe('broadcaw');
    expect(r.signature).toBe(2);
    expect(r.heldItem).toBeNull();
    expect(r.changes).toContainEqual({ kind: 'consumed', item: 'jumboframe' });
    expect(r.moves).toEqual(['ping', 'traceroute', 'broadcast', 'synflood']);
    expect(r.maxHp).toBeGreaterThan(0);
  });

  it('IV growth averages +1/2 per stat and can create a clean image; patched daemons never become clean', () => {
    let gained = 0;
    for (let i = 0; i < 2000; i++) gained += STAT_KEYS.reduce((a, k) => a + applyEvolution(base(), 'tracerat', createRng(i)).ivs[k] - 20, 0);
    expect(gained / 2000 / 8).toBeGreaterThan(0.45);
    expect(gained / 2000 / 8).toBeLessThan(0.55);
    const almost = { ...statBlock(31), hp: 30 };
    const clean = applyEvolution(base({ ivs: almost }), 'tracerat', createRng(0), { iv: 1, signature: 0 });
    expect(clean.clean).toBe(true);
    expect(clean.changes).toContainEqual({ kind: 'clean' });
    const patched = applyEvolution(base({ ivs: almost, patched: true }), 'tracerat', createRng(0), { iv: 1, signature: 0 });
    expect(patched.clean).toBe(false);
  });

  it('upgrades the signature of clean images at the given chance, adding one bonus point', () => {
    const r = applyEvolution(base({ clean: true, ivs: statBlock(31), signature: 3 }), 'tracerat', createRng(1), { iv: 0, signature: 1 });
    expect(r.signature).toBe(4);
    expect(STAT_KEYS.reduce((a, k) => a + r.bonus[k], 0)).toBe(1);
    expect(r.changes.some((c) => c.kind === 'signature')).toBe(true);
    const never = applyEvolution(base({ clean: false, signature: 0 }), 'tracerat', createRng(1), { iv: 0, signature: 1 });
    expect(never.signature).toBe(0);
  });

  it('runs IV growth, then the clean check, then the signature upgrade in order', () => {
    const r = applyEvolution(base({ ivs: { ...statBlock(31), hp: 30 } }), 'tracerat', createRng(3), { iv: 1, signature: 1 });
    expect(r.clean).toBe(true);
    expect(r.changes.map((c) => c.kind)).toEqual(['iv', 'clean', 'signature']);
    expect(r.signature).toBe(1);
  });

  it('never upgrades a signature already at SIGNATURE_MAX', () => {
    const r = applyEvolution(base({ clean: true, ivs: statBlock(31), signature: SIGNATURE_MAX }), 'tracerat', createRng(3), { iv: 1, signature: 1 });
    expect(r.signature).toBe(SIGNATURE_MAX);
    expect(r.changes.some((c) => c.kind === 'signature')).toBe(false);
  });

  it('leaves a different held item, and items of branches without an item requirement, alone', () => {
    const other = applyEvolution(base({ heldItem: 'sigmask' }), 'broadcaw', createRng(1));
    expect(other.heldItem).toBe('sigmask');
    expect(other.changes.some((c) => c.kind === 'consumed')).toBe(false);
    const free = applyEvolution(base({ heldItem: 'jumboframe' }), 'tracerat', createRng(1));
    expect(free.heldItem).toBe('jumboframe');
  });

  it('rejects forms that do not evolve from the species', () => {
    expect(() => applyEvolution(base(), 'pidzero', createRng(1))).toThrow(RangeError);
    expect(getSpecies('tracerat').evolvesFrom).toBe('echolet');
  });
});
