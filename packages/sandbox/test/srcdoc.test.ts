import { describe, expect, it } from 'vitest';
import { buildSandboxHtml, escapeForScript, validateSandboxMessage } from '../src/srcdoc.js';

const BS = String.fromCharCode(92);

describe('buildSandboxHtml', () => {
  it('embeds the SDK via an import map, the user script as a data: module, and a strict CSP', () => {
    const html = buildSandboxHtml({ sdkBundle: 'export const x = 1;', source: 'export default function main(game) { game.operator.stop(); }' });
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('"@daemonet/sdk":"data:text/javascript;base64,');
    expect(html).toContain(`Content-Security-Policy`);
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain(`connect-src 'none'`);
    expect(html).toContain('data:text/javascript;base64,' + btoa('export default function main(game) { game.operator.stop(); }'));
    expect(html).not.toContain('</script></script>');
  });

  it('cannot be broken out of with a closing script tag in the source', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: '</script><script>alert(1)</script>' });
    // the source only appears base64-encoded, so a literal closing tag never reaches the HTML
    expect(html.split('</script>')).toHaveLength(3);
  });

  it('creates the in-sandbox client with reconnect disabled and a placeholder credential', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: 'export default () => {}' });
    expect(html).toContain('reconnect: false');
    expect(html).toContain("staticToken('sandbox')");
  });
});

describe('escapeForScript', () => {
  it('turns < into a JSON unicode escape', () => {
    expect(escapeForScript('{"a":"<b></script>"}', 'json')).toBe('{"a":"' + BS + 'u003cb>' + BS + 'u003c/script>"}');
    expect(escapeForScript('{"a":"<b>"}', 'json')).not.toContain('<');
  });

  it('breaks </script in any case inside JavaScript source, leaving the rest alone', () => {
    const out = escapeForScript('a</script>b</ScRiPt >c<div>', 'js');
    expect(out).toBe('a<' + BS + '/script>b<' + BS + '/ScRiPt >c<div>');
    expect(out.toLowerCase()).not.toContain('</script');
  });
});

describe('buildSandboxHtml bootstrap', () => {
  it('removes the init listener only after a valid init, and shares one budget across logs and errors', () => {
    const html = buildSandboxHtml({ sdkBundle: '', source: 'export default () => {}' });
    expect(html).not.toContain('once: true');
    expect(html).toContain("removeEventListener('message', onInit)");
    expect(html).toContain('postBudgeted');
    expect(html).toContain("worker-src 'none'");
  });
});

describe('validateSandboxMessage', () => {
  it('accepts well-formed messages and clamps oversized fields', () => {
    expect(validateSandboxMessage({ type: 'started' })).toEqual({ type: 'started' });
    expect(validateSandboxMessage({ type: 'finished' })).toEqual({ type: 'finished' });
    const log = validateSandboxMessage({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    expect(log).toEqual({ type: 'log', level: 'info', args: ['hi', 1, { a: 1 }] });
    const err = validateSandboxMessage({ type: 'error', message: 'm'.repeat(10000), stack: 's'.repeat(100000) });
    expect(err?.type === 'error' && err.message.length).toBeLessThanOrEqual(2000);
    expect(err?.type === 'error' && (err.stack?.length ?? 0)).toBeLessThanOrEqual(8000);
    const many = validateSandboxMessage({ type: 'log', level: 'log', args: Array.from({ length: 50 }, (_, i) => i) });
    expect(many?.type === 'log' && many.args.length).toBe(10);
    const big = validateSandboxMessage({ type: 'log', level: 'log', args: ['x'.repeat(50000)] });
    expect(big?.type === 'log' && String(big.args[0]).length).toBeLessThanOrEqual(2100);
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [null, 'x', 1, [], {}, { type: 'init' }, { type: 'log', level: 'fatal', args: [] }, { type: 'log', level: 'log', args: 'x' }, { type: 'error', message: 5 }, { type: 'nope' }];
    for (const b of bad) expect(validateSandboxMessage(b)).toBeNull();
  });
});
