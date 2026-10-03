import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, ServerMessage, parseClientMessage } from '../src/protocol.js';

const cmd = (d: Record<string, unknown>) => JSON.stringify({ t: 'cmd', seq: 1, d: { reqId: 'r1', ...d } });

describe('parseClientMessage', () => {
  it('accepts auth and defaults the role to controller', () => {
    const r = parseClientMessage(JSON.stringify({ t: 'auth', seq: 0, d: { token: 'dev:alice' } }));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.t === 'auth') expect(r.message.d.role).toBe('controller');
  });

  it('accepts every SP1 command shape', () => {
    const good = [
      { cmd: 'moveTo', actor: 'self', args: { x: 1, y: 2 } },
      { cmd: 'moveTo', actor: 'dmn_1', args: { x: 1, y: 2 } },
      { cmd: 'stop', actor: 'self', args: {} },
      { cmd: 'run', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'recall', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'swap', actor: 'self', args: { outId: 'a', inId: 'b' } },
      { cmd: 'capture', actor: 'self', args: { targetId: 'w1', tool: 'sniff' } },
      { cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { checksum: '00000000' } } },
      { cmd: 'useItem', actor: 'self', args: { item: 'restore', daemonId: 'dmn_1' } },
      { cmd: 'restoreAll', actor: 'self', args: {} },
      { cmd: 'claimStarter', actor: 'self', args: { species: 'pingling', operatorName: 'alice_01' } },
      { cmd: 'store', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'load', actor: 'self', args: { daemonId: 'dmn_1' } },
      { cmd: 'use', actor: 'dmn_1', args: { move: 'ping', targetId: 'w1' } },
    ];
    for (const g of good) expect(parseClientMessage(cmd(g)).ok, g.cmd).toBe(true);
  });

  it('rejects operator-only commands sent by a daemon actor', () => {
    expect(parseClientMessage(cmd({ cmd: 'capture', actor: 'dmn_1', args: { targetId: 'w1', tool: 'sniff' } })).ok).toBe(false);
  });

  it('rejects bad names, unknown tools and malformed JSON', () => {
    expect(parseClientMessage(cmd({ cmd: 'claimStarter', actor: 'self', args: { species: 'x', operatorName: 'Bad Name!' } })).ok).toBe(false);
    expect(parseClientMessage(cmd({ cmd: 'capture', actor: 'self', args: { targetId: 'w1', tool: 'net' } })).ok).toBe(false);
    expect(parseClientMessage('{not json').ok).toBe(false);
  });

  it('enforces 4 KiB for normal messages and 16 KiB for submitCapture', () => {
    const big = 'a'.repeat(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(cmd({ cmd: 'moveTo', actor: big.slice(0, 64), args: { x: 0, y: 0 }, pad: big })).ok).toBe(false);
    const submit = cmd({ cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { plaintext: 'b'.repeat(8000) } } });
    expect(parseClientMessage(submit).ok).toBe(true);
    const tooBig = cmd({ cmd: 'submitCapture', actor: 'self', args: { captureId: 'c1', answer: { plaintext: 'b'.repeat(17000) } } });
    expect(parseClientMessage(tooBig).ok).toBe(false);
  });
});

describe('ServerMessage', () => {
  it('parses a delta with patches and events', () => {
    const msg = {
      t: 'delta',
      seq: 5,
      d: {
        tick: 100,
        upserts: [{ kind: 'daemon', id: 'w1', hp: 10 }],
        removes: ['w2'],
        events: [
          { e: 'hit', source: 'dmn_1', target: 'w1', move: 'ping', amount: 7, multiplier: 1 },
          { e: 'captureResult', captureId: 'c1', ok: false, reason: 'timeout' },
        ],
      },
    };
    expect(ServerMessage.safeParse(msg).success).toBe(true);
  });

  it('rejects a patch without an id', () => {
    const msg = { t: 'delta', seq: 5, d: { tick: 1, upserts: [{ kind: 'daemon', hp: 1 }], removes: [], events: [] } };
    expect(ServerMessage.safeParse(msg).success).toBe(false);
  });
});
