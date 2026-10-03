import { readFileSync } from 'node:fs';
import { SANDBOX_CSP } from '@daemonet/sandbox';
import { describe, expect, it } from 'vitest';

const caddyfile = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');

/** The body of the `handle <matcher> { ... }` block (no nested braces except `header { }`). */
function handleBlock(matcher: string): string {
  const start = caddyfile.indexOf(`handle ${matcher} {`);
  expect(start, `handle ${matcher} exists`).toBeGreaterThan(-1);
  const end = caddyfile.indexOf('\n  }\n', start);
  return caddyfile.slice(start, end);
}

describe('Caddyfile sandbox contract', () => {
  it('serves /sandbox.html with the exact SANDBOX_CSP header, framable only by this origin', () => {
    const block = handleBlock('/sandbox.html');
    expect(block).toContain(`Content-Security-Policy "${SANDBOX_CSP}"`);
    expect(block).toContain('X-Frame-Options "SAMEORIGIN"');
    expect(block).toContain('file_server');
    expect(block).not.toContain('try_files');
  });

  it('serves /sandbox/* statically without the SPA fallback or any proxy/auth', () => {
    const block = handleBlock('/sandbox/*');
    expect(block).toContain('file_server');
    expect(block).not.toContain('try_files');
    expect(block).not.toContain('reverse_proxy');
  });

  it('declares sandbox handles before the catch-all so they win', () => {
    const catchAll = caddyfile.indexOf('\n  handle {\n');
    expect(caddyfile.indexOf('handle /sandbox.html')).toBeLessThan(catchAll);
    expect(caddyfile.indexOf('handle /sandbox/*')).toBeLessThan(catchAll);
  });

  it('keeps the host page CSP strict', () => {
    const csp = /\(host_csp\) \{\s*Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1] ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-src 'self'");
    const scriptSrc = /script-src ([^;]+);/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('data:');
    expect(csp).toContain("worker-src 'self' blob:");
  });
});
