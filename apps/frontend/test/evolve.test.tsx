// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeBranch, describeRequirement } from '../src/game/requirements.ts';
import { EvolveSection, HeldSlot } from '../src/panels/EvolveSection.tsx';

const daemon = {
  id: 'd1', species: 'echolet', level: 16, xp: 0, nature: 0, traitSlot: 0 as const, ivs: [20, 20, 20, 20, 20, 20, 20, 20], bonus: [0, 0, 0, 0, 0, 0, 0, 0],
  clean: false, signature: 0, hp: 50, maxHp: 50, energy: 128, moves: ['ping'], crashed: false, slot: 2, cooldowns: {},
  heldItem: null, patched: false, moveTypeUses: Array(16).fill(0) as number[], crashes: 0,
  evolutions: [
    { form: 'tracerat', name: 'Tracerat', level: 16, hidden: false, revealed: true, met: true, requirement: [] },
    { form: 'broadcaw', name: 'Broadcaw', level: 16, hidden: false, revealed: true, met: false, requirement: [{ kind: 'heldItem', item: 'jumboframe' }] },
    { form: 'mystery', name: 'Mystery', level: 32, hidden: true, revealed: false, met: false, requirement: null },
  ],
};

afterEach(cleanup);

describe('requirement text', () => {
  it('describes every requirement kind', () => {
    expect(describeRequirement({ kind: 'heldItem', item: 'jumboframe' })).toBe('hold Jumbo Frame');
    expect(describeRequirement({ kind: 'dominantIV', stat: 'speed' })).toBe('highest IV: speed');
    expect(describeRequirement({ kind: 'moveTypeUses', type: 'packet', count: 4096 })).toBe('4096 packet move uses');
    expect(describeRequirement({ kind: 'subnet', subnet: 'darknet' })).toBe('evolve in darknet');
    expect(describeRequirement({ kind: 'clean' })).toBe('clean image');
    expect(describeRequirement({ kind: 'signature', min: 2 })).toBe('signature T2+');
    expect(describeRequirement({ kind: 'originalOperator' })).toBe('with its original operator');
    expect(describeRequirement({ kind: 'crashes', op: 'max', count: 0 })).toBe('at most 0 crashes');
    expect(describeRequirement({ kind: 'crashes', op: 'min', count: 8 })).toBe('at least 8 crashes');
    expect(describeRequirement({ kind: 'arenaWins', count: 16 })).toBe('16 arena wins');
    expect(describeRequirement({ kind: 'unobserved' })).toBe('with no other operator nearby');
  });

  it('formats a branch with its level, ??? while hidden and undiscovered', () => {
    expect(describeBranch(16, [], false)).toBe('L16');
    expect(describeBranch(16, [{ kind: 'heldItem', item: 'jumboframe' }], false)).toBe('L16 · hold Jumbo Frame');
    expect(describeBranch(32, null, true)).toBe('L32 · ???');
    expect(describeBranch(32, null, false)).toBe('L32');
  });
});

describe('EvolveSection', () => {
  it('lists the branches, enables evolve only for met ones, and reports the chosen form', () => {
    const onEvolve = vi.fn();
    render(<EvolveSection daemon={daemon} disabled={false} onEvolve={onEvolve} />);
    expect(screen.getByText('Tracerat')).toBeTruthy();
    expect(screen.getByText('L16 · hold Jumbo Frame')).toBeTruthy();
    expect(screen.getByText('L32 · ???')).toBeTruthy();
    const ready = screen.getByTestId('evolve-2-tracerat') as HTMLButtonElement;
    const blocked = screen.getByTestId('evolve-2-broadcaw') as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    expect(blocked.disabled).toBe(true);
    fireEvent.click(ready);
    expect(onEvolve).toHaveBeenCalledWith('tracerat');
  });

  it('disables everything while the daemon is running', () => {
    render(<EvolveSection daemon={daemon} disabled={true} onEvolve={() => {}} />);
    expect((screen.getByTestId('evolve-2-tracerat') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('HeldSlot', () => {
  it('offers only holdable inventory items and unhold when something is held', () => {
    const onHold = vi.fn();
    const onUnhold = vi.fn();
    const { rerender } = render(<HeldSlot daemon={daemon} inventory={{ jumboframe: 1, restore: 2, amplifier: 0 }} disabled={false} onHold={onHold} onUnhold={onUnhold} />);
    const select = screen.getByTestId('hold-2') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'jumboframe']);
    fireEvent.change(select, { target: { value: 'jumboframe' } });
    expect(onHold).toHaveBeenCalledWith('jumboframe');
    rerender(<HeldSlot daemon={{ ...daemon, heldItem: 'jumboframe' }} inventory={{}} disabled={false} onHold={onHold} onUnhold={onUnhold} />);
    expect(screen.getByTestId('held-2').textContent).toContain('held: jumboframe');
    fireEvent.click(screen.getByText('unhold'));
    expect(onUnhold).toHaveBeenCalled();
  });
});
