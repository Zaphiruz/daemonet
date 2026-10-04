import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromHex, fromUtf8, utf8 } from '../src/capture/common.js';
import { lruHits } from '../src/capture/cache.js';
import { hammingEncode } from '../src/capture/glitch.js';
import { ringContents } from '../src/capture/buffer.js';
import { roundRobin } from '../src/capture/kernel.js';
import { checkAccess, type RootParams, type RootRequest } from '../src/capture/root.js';
import { runPipeline } from '../src/capture/shell.js';
import { finalStates, type Segment } from '../src/capture/socket.js';
import { deliveryOrder, type SignalParams } from '../src/capture/signal.js';
import { firstRace, type ThreadEvent } from '../src/capture/thread.js';
import {
  checkAnswer,
  generateChallenge,
  getFamily,
  hasFamily,
  publicChallenge,
  type ChainPayload,
} from '../src/capture/index.js';
import { challengeSize, type ChallengeTarget } from '../src/capture/size.js';
import { getTool, type Noise } from '../src/content/items.js';
import { createRng } from '../src/rng.js';
import { TYPES, type TypeId } from '../src/types.js';
import { solve, solveBuffer, solveCache, solveKernel, solveRoot, solveShell, solveSignal, solveSocket, solveThread } from './solvers.js';

const FAMILIES: TypeId[] = ['packet', 'crypto', 'glitch', 'null', 'kernel', 'cache', 'thread', 'signal', 'socket', 'buffer', 'shell', 'root'];

/** Change the answer so it is still schema-valid but wrong (every family's answer shape is covered). */
function mutate(answer: Record<string, unknown>): Record<string, unknown> {
  const [key, value] = Object.entries(answer)[0]!;
  if (typeof value === 'number') return { [key]: value + 1 };
  if (typeof value === 'string') {
    if (key === 'checksum' || key === 'hex' || key === 'contents') return { [key]: value === '' ? '00' : (value[0] === '0' ? '1' : '0') + value.slice(1) };
    if (key === 'allowed') return { [key]: (value[0] === '1' ? '0' : '1') + value.slice(1) };
    return { [key]: value + 'x' };
  }
  if (Array.isArray(value)) {
    if (key === 'race') return { [key]: [value[0] === -1 ? 0 : -1, value[1]] };
    return { [key]: [...value, typeof value[0] === 'number' ? 1 : 'x'] };
  }
  const entries = Object.entries(value as Record<string, string>);
  if (entries.length === 0) return { [key]: { extra: 'CLOSED' } };
  const [k, v] = entries[0]!;
  return { [key]: { ...(value as Record<string, string>), [k]: v === 'CLOSED' ? 'ESTABLISHED' : 'CLOSED' } };
}

describe('challengeSize', () => {
  const base: ChallengeTarget = { stage: 0, hpFraction: 1, clean: false, signature: 0, hardened: false, statused: false };
  const sniff = getTool('sniff');

  it('follows 16 * 2^stage * (1 + hp) with multipliers', () => {
    expect(challengeSize(base, sniff)).toBe(32);
    expect(challengeSize({ ...base, hpFraction: 0 }, sniff)).toBe(16);
    expect(challengeSize({ ...base, stage: 2 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, clean: true, signature: 3 }, sniff)).toBe(128);
    expect(challengeSize({ ...base, hardened: true }, sniff)).toBe(64);
    expect(challengeSize({ ...base, statused: true }, sniff)).toBe(16);
    expect(challengeSize({ ...base, hpFraction: 0.25 }, getTool('dump'))).toBe(10);
  });

  it('never goes below 8 and clamps hp', () => {
    expect(challengeSize({ ...base, hpFraction: 0, statused: true }, getTool('dump'))).toBe(8);
    expect(challengeSize({ ...base, hpFraction: 5 }, sniff)).toBe(32);
  });
});

describe('hammingEncode', () => {
  it('encodes known nibbles', () => {
    expect(hammingEncode(0b0000)).toBe(0);
    // d1..d4 = 1011 -> p1=0, p2=1, p3=0 -> bits p1 p2 d1 p3 d2 d3 d4 = 0 1 1 0 0 1 1
    expect(hammingEncode(0b1011)).toBe(0b1100110);
  });
});

describe.each(FAMILIES)('%s family', (type) => {
  it('is registered', () => {
    expect(TYPES).toContain(type);
    expect(hasFamily(type)).toBe(true);
  });

  it('the reference solver passes and a mutated answer fails', () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 300 }), fc.constantFrom<Noise>(0, 1, 2), fc.integer(), (size, noise, seed) => {
        const challenge = generateChallenge([type], size, noise, createRng(seed));
        const answer = solve(publicChallenge(challenge)) as Record<string, unknown>;
        expect(checkAnswer(challenge, answer)).toBe('correct');
        expect(checkAnswer(challenge, mutate(answer))).toBe('wrong');
      }),
      { numRuns: 64 },
    );
  });

  it('is deterministic per seed', () => {
    const a = generateChallenge([type], 64, 2, createRng('same'));
    const b = generateChallenge([type], 64, 2, createRng('same'));
    expect(a).toEqual(b);
  });

  it('stays under 64 KiB at the largest SP1 size', () => {
    // stage 0, full HP, clean, signature, hardened: 16 * 2 * 2 * 2 * 2 = 256; allow 4x headroom.
    const challenge = generateChallenge([type], 1024, 2, createRng('big'));
    expect(JSON.stringify(publicChallenge(challenge)).length).toBeLessThan(65536);
  });

  it('rejects malformed answers as invalid', () => {
    const challenge = generateChallenge([type], 16, 0, createRng(1));
    expect(checkAnswer(challenge, { nope: true })).toBe('invalid');
    expect(checkAnswer(challenge, null)).toBe('invalid');
  });
});

describe('chained challenges', () => {
  it('solving stage one unseals stage two', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FAMILIES), fc.constantFrom(...FAMILIES), fc.integer(), (a, b, seed) => {
        const challenge = generateChallenge([a, b], 24, 1, createRng(seed));
        expect(challenge.kind).toBe('chain');
        expect(challenge.families).toEqual([a, b]);
        const answer = solve(publicChallenge(challenge));
        expect(checkAnswer(challenge, answer)).toBe('correct');
      }),
      { numRuns: 48 },
    );
  });

  it('resists a known-prefix repeating-XOR attack on packet -> glitch chains', () => {
    for (let seed = 0; seed < 32; seed++) {
      const challenge = generateChallenge(['packet', 'glitch'], 24, 1, createRng(seed));
      const chain = challenge.payload as ChainPayload;
      const cipher = fromHex(chain.sealed);

      // Rebuild the real stage two from the same seed to know the plaintext and first answer.
      const rng = createRng(seed);
      const first = getFamily('packet').generate(24, 1, rng);
      const second = getFamily('glitch').generate(24, 1, rng);
      expect(second.answer).toEqual(challenge.answer);
      const plaintext = JSON.stringify({ params: second.params, payload: second.payload });
      const prefix = '{"params":{"encoding":"hamming74","bytes":24},"payload":{"blocks":[';
      expect(plaintext.startsWith(prefix)).toBe(true);

      // A repeating-XOR attacker assumes the key period is the length of the canonical first answer.
      const period = JSON.stringify(first.answer).length;
      expect(period).toBe(23);
      const known = utf8(prefix);
      const key = Array.from({ length: period }, (_, i) => cipher[i]! ^ known[i]!);
      const guess = fromUtf8(cipher.map((b, i) => b ^ key[i % period]!));
      expect(guess).not.toBe(plaintext);
      expect(guess.slice(prefix.length)).not.toBe(plaintext.slice(prefix.length));
    }
  });

  it('never exposes the answer publicly', () => {
    const challenge = generateChallenge(['packet', 'glitch'], 16, 0, createRng(2));
    expect(publicChallenge(challenge)).not.toHaveProperty('answer');
  });

  it('rejects bad type counts', () => {
    expect(() => generateChallenge([], 16, 0, createRng(3))).toThrow(RangeError);
    expect(() => generateChallenge(['kernel', 'heap', 'null'], 16, 0, createRng(3))).toThrow(RangeError);
  });
});

/**
 * Hand-computed fixtures: expected answers were worked out by hand from the families' doc-comment rules,
 * not by running the code, so a misread tie-break cannot hide behind a solver that copies the rule.
 */
describe('hand-computed family fixtures', () => {
  const ev = (thread: number, op: ThreadEvent['op'], obj: string): ThreadEvent => ({ thread, op, obj });

  it('kernel', () => {
    // quantum 2. pid1 runs 0-2 (1 left); pid2 arrives at 2 exactly, so it queues AHEAD of pid1.
    // pid2 runs 2-3 and finishes; pid1 runs 3-4 and finishes; queue empty, idle until pid3 arrives at 10,
    // runs 10-12. pid4 has burst 0 and never runs.
    const processes = [
      { pid: 3, arrival: 10, burst: 2 },
      { pid: 4, arrival: 1, burst: 0 },
      { pid: 1, arrival: 0, burst: 3 },
      { pid: 2, arrival: 2, burst: 1 },
    ];
    expect(roundRobin(processes, 2)).toEqual([2, 1, 3]);
    expect(solveKernel({ quantum: 2 }, { processes })).toEqual({ order: [2, 1, 3] });
  });

  it('cache', () => {
    // capacity 2: a miss [a]; b miss [a,b]; '#c' ignored; a HIT (1) -> [b,a]; c miss evicts b -> [a,c];
    // b miss evicts a -> [c,b]; a miss evicts c -> [b,a]. Total 1 hit.
    const trace = ['a', 'b', '#c', 'a', 'c', 'b', 'a'];
    expect(lruHits(2, trace)).toBe(1);
    expect(solveCache({ capacity: 2 }, { trace })).toEqual({ hits: 1 });
  });

  it('thread', () => {
    const run = (events: ThreadEvent[]) => {
      expect(solveThread({ threads: 2 }, { events })).toEqual({ race: firstRace(events) });
      return firstRace(events);
    };
    // shared lock m held at both writes -> no race
    expect(run([ev(0, 'lock', 'm'), ev(0, 'write', 'x'), ev(0, 'unlock', 'm'), ev(1, 'lock', 'm'), ev(1, 'write', 'x'), ev(1, 'unlock', 'm')])).toEqual([-1, -1]);
    // t1's stray unlock is a no-op; t0 locks m twice but one unlock releases it, so at event 4 t0 holds
    // nothing while t1 (event 6) holds m: no common lock -> race [4,6]
    expect(run([ev(1, 'unlock', 'm'), ev(0, 'lock', 'm'), ev(0, 'lock', 'm'), ev(0, 'unlock', 'm'), ev(0, 'write', 'x'), ev(1, 'lock', 'm'), ev(1, 'read', 'x')])).toEqual([4, 6]);
    // smallest i first: (0,2) on x beats (1,3) on y
    expect(run([ev(0, 'write', 'x'), ev(1, 'write', 'y'), ev(1, 'write', 'x'), ev(0, 'write', 'y')])).toEqual([0, 2]);
    // two reads never race
    expect(run([ev(0, 'read', 'x'), ev(1, 'read', 'x')])).toEqual([-1, -1]);
  });

  it('signal', () => {
    // masked {5,3}, unmaskAt 4. t0:5 pending{5}; t1:3 pending{3,5}; t1:5 coalesces; t2:7 delivered [7];
    // t4:3 -> unmask first: pending flushed ascending [3,5] -> [7,3,5], then 3 delivered, 9 delivered;
    // t6:5 delivered (mask gone).
    const a: SignalParams = { masked: [5, 3], unmaskAt: 4 };
    const signalsA = [
      { t: 0, sig: 5 },
      { t: 1, sig: 3 },
      { t: 1, sig: 5 },
      { t: 2, sig: 7 },
      { t: 4, sig: 3 },
      { t: 4, sig: 9 },
      { t: 6, sig: 5 },
    ];
    expect(deliveryOrder(a, signalsA)).toEqual([7, 3, 5, 3, 9, 5]);
    expect(solveSignal(a, { signals: signalsA })).toEqual({ order: [7, 3, 5, 3, 9, 5] });
    // unmaskAt beyond every signal (and signals out of array order): 1 pending, 2 delivered, 1 coalesces,
    // 4 delivered, flush at the end -> [2,4,1]
    const b: SignalParams = { masked: [1], unmaskAt: 100 };
    const signalsB = [
      { t: 3, sig: 4 },
      { t: 0, sig: 1 },
      { t: 1, sig: 2 },
      { t: 2, sig: 1 },
    ];
    expect(deliveryOrder(b, signalsB)).toEqual([2, 4, 1]);
    expect(solveSignal(b, { signals: signalsB })).toEqual({ order: [2, 4, 1] });
  });

  it('socket', () => {
    const seg = (conn: string, flag: Segment['flag']): Segment => ({ conn, flag });
    const connections = ['a', 'b', 'c', 'd', 'e'];
    const segments = [
      seg('a', 'ACK'), // ignored in CLOSED
      seg('a', 'SYN'), // SYN_RCVD
      seg('a', 'SYN'), // duplicate SYN ignored in SYN_RCVD
      seg('a', 'SYNACK'), // ESTABLISHED
      seg('a', 'ACK'), // ignored in ESTABLISHED
      seg('a', 'FIN'), // CLOSE_WAIT
      seg('b', 'SYN'),
      seg('b', 'ACK'), // ESTABLISHED
      seg('b', 'FIN'),
      seg('b', 'FIN'), // LAST_ACK
      seg('b', 'ACK'), // CLOSED
      seg('c', 'SYN'),
      seg('c', 'RST'), // CLOSED
      seg('d', 'SYN'), // SYN_RCVD
      seg('z', 'SYN'), // not in params: still reported
      seg('z', 'FIN'), // ignored in SYN_RCVD
    ];
    const expected = { a: 'CLOSE_WAIT', b: 'CLOSED', c: 'CLOSED', d: 'SYN_RCVD', e: 'CLOSED', z: 'SYN_RCVD' };
    expect(finalStates(connections, segments)).toEqual(expected);
    expect(solveSocket({ connections }, { segments })).toEqual({ states: expected });
    // SYNACK and FIN in CLOSED do nothing; ACK in CLOSE_WAIT does nothing; RST in LAST_ACK closes
    const more = [
      seg('a', 'SYNACK'),
      seg('a', 'FIN'),
      seg('b', 'SYN'),
      seg('b', 'ACK'),
      seg('b', 'FIN'),
      seg('b', 'ACK'),
      seg('c', 'SYN'),
      seg('c', 'ACK'),
      seg('c', 'FIN'),
      seg('c', 'FIN'),
      seg('c', 'RST'),
    ];
    const expected2 = { a: 'CLOSED', b: 'CLOSE_WAIT', c: 'CLOSED' };
    expect(finalStates(['a', 'b', 'c'], more)).toEqual(expected2);
    expect(solveSocket({ connections: ['a', 'b', 'c'] }, { segments: more })).toEqual({ states: expected2 });
  });

  it('buffer', () => {
    // capacity 3: r no-op on empty; 01 02 03 -> [01 02 03]; 04 drops 01 -> [02 03 04]; r -> [03 04];
    // 05 -> [03 04 05]; 0a drops 03 -> [04 05 0a]; 06 drops 04 -> [05 0a 06].
    const ops = ['r', 'w:01', 'w:02', 'w:03', 'w:04', 'r', 'w:05', 'w:0a', 'w:06'];
    expect(ringContents(3, ops)).toBe('050a06');
    expect(solveBuffer({ capacity: 3 }, { ops })).toEqual({ contents: '050a06' });
    // drained to empty -> ''
    expect(ringContents(2, ['w:ff', 'r', 'r', 'r'])).toBe('');
    expect(solveBuffer({ capacity: 2 }, { ops: ['w:ff', 'r', 'r', 'r'] })).toEqual({ contents: '' });
    // capacity 1 keeps only the latest write
    expect(ringContents(1, ['w:aa', 'w:bb', 'w:cc'])).toBe('cc');
    expect(solveBuffer({ capacity: 1 }, { ops: ['w:aa', 'w:bb', 'w:cc'] })).toEqual({ contents: 'cc' });
  });

  it('shell', () => {
    const lines = ['b,2,x', '', 'a,1,x', 'b,2,x', 'c,3,y', '', 'b,2,x'];
    const run = (pipeline: string, input: string[] = lines) => {
      expect(solveShell({ pipeline }, { lines: input })).toEqual({ output: runPipeline(pipeline, input) });
      return runPipeline(pipeline, input);
    };
    // blank lines ignored; uniq only drops CONSECUTIVE duplicates (b,2,x repeats non-adjacently)
    expect(run('uniq')).toEqual(['b,2,x', 'a,1,x', 'b,2,x', 'c,3,y', 'b,2,x']);
    expect(run('sort | uniq')).toEqual(['a,1,x', 'b,2,x', 'c,3,y']);
    expect(run('grep x | wc -l')).toEqual(['4']);
    expect(run('grep nomatch | wc -l')).toEqual(['0']);
    expect(run('cut -d, -f2 | sort')).toEqual(['1', '2', '2', '2', '3']);
    // fewer fields than requested -> ""
    expect(run('cut -d, -f3', ['a,b', 'a,b,c'])).toEqual(['', 'c']);
    // grep is a substring match; stages apply left to right
    expect(run('grep b | cut -d, -f1', ['abc', 'xyz', 'b'])).toEqual(['abc', 'b']);
    // sort is by code point, not UTF-16 unit: U+FFFF < U+1F600 although surrogate D83D < FFFF; uppercase before lowercase
    expect(run('sort', ['\u{1F600}', '￿', 'b', 'B', 'a'])).toEqual(['B', 'a', 'b', '￿', '\u{1F600}']);
  });

  it('root', () => {
    // mode: owner rwx, group r-x, other --x
    const params: RootParams = {
      mode: 'rwxr-x--x',
      owner: 'alice',
      group: 'staff',
      acl: [
        { who: 'user:bob', perms: '---' },
        { who: 'group:ops', perms: 'r--' },
        { who: 'group:wheel', perms: '-w-' },
      ],
    };
    const req = (user: string, groups: string[], op: RootRequest['op']): RootRequest => ({ user, groups, op });
    const cases: Array<[RootRequest, boolean]> = [
      [req('alice', [], 'w'), true], // owner triple rwx
      [req('alice', ['ops'], 'x'), true], // owner beats the group ACL
      [req('bob', ['staff'], 'r'), false], // user ACL --- beats the group triple r-x
      [req('carol', ['ops'], 'r'), true], // group ACL ops grants r
      [req('carol', ['ops'], 'x'), false], // group ACL ops denies x
      [req('carol', ['staff', 'ops'], 'x'), false], // an ACL group matched: the file-group triple (r-x) is NOT consulted
      [req('carol', ['ops', 'wheel'], 'w'), true], // ANY matching group entry grants: wheel grants w
      [req('carol', ['ops', 'wheel'], 'r'), true], // ops grants r
      [req('carol', ['staff'], 'x'), true], // no ACL match; file group triple r-x
      [req('carol', ['staff'], 'w'), false],
      [req('carol', ['guest'], 'x'), true], // other triple --x
      [req('carol', ['guest'], 'r'), false],
      [req('carol', [], 'x'), true], // no groups -> other triple
    ];
    for (const [r, want] of cases) expect(checkAccess(params, r), JSON.stringify(r)).toBe(want);
    const requests = cases.map(([r]) => r);
    expect(solveRoot(params, { requests })).toEqual({ allowed: '1101001110101' });
  });
});
