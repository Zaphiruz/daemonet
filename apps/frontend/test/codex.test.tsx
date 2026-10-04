// @vitest-environment jsdom
import { BESTIARY } from '@daemonet/rules';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Codex } from '../src/api.ts';

const codexState: { data: Codex | undefined } = { data: undefined };
vi.mock('../src/api.ts', () => ({ useCodexQuery: () => ({ data: codexState.data, refetch: () => {} }) }));
vi.mock('../src/panels/RamPanel.tsx', () => ({ SpriteImg: () => null }));

const { CodexPanel } = await import('../src/panels/CodexPanel.tsx');

afterEach(() => {
  cleanup();
  codexState.data = undefined;
});

const rows = BESTIARY.filter((r) => r.line === 1).map((r) => ({ ...r }));
const child = rows.find((r) => r.evolvesFrom !== null)!;

function codex(over: Partial<Codex> = {}): Codex {
  return {
    types: [], chart: {}, species: [], moves: [], items: [], natures: [], traits: [],
    bestiary: rows, discovered: [], discoveries: [], challenges: [], ...over,
  } as unknown as Codex;
}

describe('CodexPanel', () => {
  it('draws each line as a tree, with ??? for a masked hidden requirement and a mark once discovered', () => {
    codexState.data = codex({
      bestiary: rows.map((r) => (r.id === child.id ? { ...r, hidden: true, requirement: null } : r)),
    });
    render(<CodexPanel />);
    expect(screen.getByTestId('line-1')).toBeTruthy();
    expect(screen.getByTestId(`tree-${child.id}`).textContent).toContain('???');
    expect(screen.queryByText('✓')).toBeNull();
    cleanup();
    codexState.data = codex({ discovered: [child.id], discoveries: [{ formId: child.id, operatorName: 'ada', discoveredAt: '2026-10-01T00:00:00Z' }] });
    render(<CodexPanel />);
    expect(screen.getByText('✓')).toBeTruthy();
  });

  it('lists every type challenge as plain pre-wrapped text, never as HTML', () => {
    codexState.data = codex({ challenges: [{ type: 'packet', rules: 'Line one\n  [socket]\n<b>bold</b>' }, { type: 'crypto', rules: 'Second' }] });
    render(<CodexPanel />);
    fireEvent.click(screen.getByTestId('codex-challenges'));
    const el = screen.getByTestId('challenge-packet');
    expect(el.textContent).toContain('Line one\n  [socket]\n<b>bold</b>');
    expect(el.querySelector('b')).toBeNull();
    const pre = screen.getByTestId('challenge-packet-rules');
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(screen.getByTestId('challenge-crypto')).toBeTruthy();
  });
});
