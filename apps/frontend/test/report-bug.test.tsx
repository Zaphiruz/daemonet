// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.ts')>()),
  useLogoutMutation: () => [vi.fn()],
  useIncidentsQuery: () => ({ data: undefined }),
  useMeQuery: () => ({ data: undefined }),
}));

import { Login } from '../src/App.tsx';
import { ISSUES_URL, ReportBug } from '../src/components/ReportBug.tsx';
import { TopBar } from '../src/components/TopBar.tsx';

afterEach(cleanup);

function expectBugLink() {
  const link = screen.getByTestId('report-bug') as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe(ISSUES_URL);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(link.textContent).toBe('report a bug');
}

describe('report a bug link', () => {
  it('points at the public issue template and opens safely in a new tab', () => {
    render(<ReportBug />);
    expectBugLink();
    expect(ISSUES_URL).toMatch(/^https:\/\/github\.com\/Zaphiruz\/daemonet\/issues\/new\?template=bug_report\.yml$/);
  });

  it('is on the sign-in screen', () => {
    render(<Login />);
    expectBugLink();
  });

  it('is in the top bar next to logout', () => {
    render(<TopBar me={{ id: 'op', name: 'alice', bits: 0 } as never} />);
    expectBugLink();
    expect(screen.getByText('logout')).toBeTruthy();
  });
});
