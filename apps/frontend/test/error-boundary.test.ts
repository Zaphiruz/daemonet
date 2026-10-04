// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx';
import { log } from '../src/game/log.ts';

let mounts = 0;
let shouldThrow = true;
function Child() {
  if (shouldThrow) throw new Error('boom');
  mounts++;
  return createElement('p', { 'data-testid': 'child' }, 'fine');
}

beforeEach(() => {
  mounts = 0;
  shouldThrow = true;
  log.clear();
  // React reports the caught render error on the console
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a fallback, logs once, and the reset button re-mounts the child', () => {
    render(createElement(ErrorBoundary, { label: 'test panel', children: createElement(Child) }));
    expect(screen.getByRole('alert').textContent).toContain('This panel crashed');
    const errors = log.get().filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toContain('test panel crashed: boom');

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'reload panel' }));
    expect(screen.getByTestId('child').textContent).toBe('fine');
    expect(mounts).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(log.get().filter((e) => e.kind === 'error')).toHaveLength(1);
  });
});
