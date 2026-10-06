import { describe, expect, it } from 'vitest';
import { DAEMON_HISTORY_MAX, withTraded } from '../src/exchange/ledger.js';

describe('withTraded', () => {
  it('appends one traded entry', () => {
    const at = new Date('2026-10-05T00:00:00.000Z');
    expect(withTraded([{ at: 'x', kind: 'captured', detail: 'starter' }], at, 'traded directly')).toEqual([
      { at: 'x', kind: 'captured', detail: 'starter' },
      { at: at.toISOString(), kind: 'traded', detail: 'traded directly' },
    ]);
  });

  it('starts over on a non-array history', () => {
    const at = new Date(0);
    expect(withTraded(null, at, 'd')).toEqual([{ at: at.toISOString(), kind: 'traded', detail: 'd' }]);
  });

  it('keeps only the last DAEMON_HISTORY_MAX entries after N+1 passes', () => {
    let history: ReturnType<typeof withTraded> = [{ at: 'first', kind: 'captured', detail: 'starter' }];
    for (let i = 0; i < DAEMON_HISTORY_MAX + 1; i++) history = withTraded(history, new Date(i * 1000), `pass ${i}`);
    expect(history).toHaveLength(DAEMON_HISTORY_MAX);
    expect(history.at(-1)).toMatchObject({ kind: 'traded', detail: `pass ${DAEMON_HISTORY_MAX}` });
    expect(history[0]).toMatchObject({ detail: 'pass 1' });
  });
});
