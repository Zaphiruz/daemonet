import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_CHARS,
  DEFAULT_FILTER,
  DEFAULT_TERMS,
  FILTER_MAX_INPUT,
  applyFilter,
  cleanChatText,
  compileFilter,
  nameAllowedBy,
  normalizeForFilter,
} from '../src/content/chatfilter.js';

describe('normalizeForFilter', () => {
  it('folds case, leet and repeats, and removes separators inside words', () => {
    expect(normalizeForFilter('SpAm')).toBe('spam');
    expect(normalizeForFilter('sp4m')).toBe('spam');
    expect(normalizeForFilter('spaaaam')).toBe('spaam');
    expect(normalizeForFilter('s.p.a.m')).toBe('spam');
    expect(normalizeForFilter('hello   world ')).toBe('hello world');
    expect(normalizeForFilter('Épée')).toBe('epee');
  });

  it('strips zero-width and format characters, combining marks, and folds confusables', () => {
    expect(normalizeForFilter('sp​am')).toBe('spam');
    expect(normalizeForFilter('sp­am')).toBe('spam');
    expect(normalizeForFilter('sp⁠a﻿m')).toBe('spam');
    expect(normalizeForFilter('s̶p̶a̶m̶')).toBe('spam');
    expect(normalizeForFilter('ｓｐａｍ')).toBe('spam'); // fullwidth
    expect(normalizeForFilter('spаm')).toBe('spam'); // Cyrillic a
    expect(normalizeForFilter('ѕpаm')).toBe('spam'); // Cyrillic s, a
    expect(normalizeForFilter('SPΑM')).toBe('spam'); // Greek capital alpha
  });
});

describe('applyFilter', () => {
  it('blocks, masks, and leaves clean text alone', () => {
    expect(applyFilter(DEFAULT_FILTER, 'trade anyone? tap for 2 packet frags')).toEqual({ ok: true, text: 'trade anyone? tap for 2 packet frags', masked: [] });
    expect(applyFilter(DEFAULT_FILTER, 'just KYS lol')).toEqual({ ok: false, term: 'kys' });
    expect(applyFilter(DEFAULT_FILTER, 'join https://example.test now')).toEqual({ ok: false, term: 'https?://' });
    expect(applyFilter(DEFAULT_FILTER, 'what the FUCK was that')).toEqual({ ok: true, text: 'what the *** was that', masked: ['fuck'] });
    expect(applyFilter(DEFAULT_FILTER, 'f.u.c.k this')).toMatchObject({ ok: true, text: '*** this' });
  });

  it('matches whole words only and ignores bad regexes', () => {
    const f = compileFilter([
      { pattern: 'ass', kind: 'WORD', action: 'MASK' },
      { pattern: '(', kind: 'REGEX', action: 'BLOCK' },
    ]);
    expect(f.terms).toHaveLength(1);
    expect(applyFilter(f, 'class assignment')).toMatchObject({ ok: true, text: 'class assignment' });
    expect(applyFilter(f, 'you ass')).toMatchObject({ text: 'you ***' });
  });

  it('catches obfuscated terms (zero-width, confusables, combining marks)', () => {
    const f = compileFilter([{ pattern: 'zork', kind: 'WORD', action: 'BLOCK' }]);
    expect(applyFilter(f, 'you z​ork')).toEqual({ ok: false, term: 'zork' });
    expect(applyFilter(f, 'you zоrk')).toEqual({ ok: false, term: 'zork' });
    expect(applyFilter(f, 'you źórk')).toEqual({ ok: false, term: 'zork' });
  });
});

describe('compileFilter robustness', () => {
  it('treats admin WORD patterns literally (regex metacharacters are escaped)', () => {
    const f = compileFilter([{ pattern: '(a+)+$', kind: 'WORD', action: 'BLOCK' }]);
    expect(f.terms).toHaveLength(1);
    expect(applyFilter(f, 'aaaa')).toMatchObject({ ok: true });
  });

  it('drops WORD terms that normalise to nothing instead of matching everything', () => {
    const f = compileFilter([
      { pattern: '', kind: 'WORD', action: 'BLOCK' },
      { pattern: '​', kind: 'WORD', action: 'BLOCK' },
      { pattern: '   ', kind: 'WORD', action: 'BLOCK' },
    ]);
    expect(f.terms).toHaveLength(0);
    expect(applyFilter(f, 'anything')).toMatchObject({ ok: true });
  });

  it('rejects REGEX terms with nested quantifiers, quantified alternation, backreferences, or excess length', () => {
    const bad = ['(a+)+$', '(a*)*b', '(a|aa)+$', '(\\w+\\s?)*$', '(a{1,9}){1,9}', '(.*a){5,}', '(a)\\1', 'a.*b.*c', 'a'.repeat(300)];
    const f = compileFilter(bad.map((pattern) => ({ pattern, kind: 'REGEX' as const, action: 'BLOCK' as const })));
    expect(f.terms).toHaveLength(0);
  });

  it('keeps simple REGEX terms working', () => {
    const f = compileFilter([
      { pattern: 'https?://', kind: 'REGEX', action: 'BLOCK' },
      { pattern: '(foo|bar)baz', kind: 'REGEX', action: 'BLOCK' },
      { pattern: '(ab)?cd', kind: 'REGEX', action: 'BLOCK' },
    ]);
    expect(f.terms).toHaveLength(3);
    expect(applyFilter(f, 'xx barbaz')).toEqual({ ok: false, term: '(foo|bar)baz' });
  });

  it('caps the number of compiled terms', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ pattern: `w${String.fromCharCode(97 + (i % 26))}${i}x`, kind: 'WORD' as const, action: 'MASK' as const }));
    expect(compileFilter(many).terms.length).toBeLessThanOrEqual(1000);
  });

  it('freezes the default terms', () => {
    expect(Object.isFrozen(DEFAULT_TERMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TERMS[0])).toBe(true);
  });
});

describe('applyFilter pathological input', () => {
  const timed = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it('refuses over-long text without scanning it', () => {
    const r = applyFilter(DEFAULT_FILTER, 'a'.repeat(FILTER_MAX_INPUT + 1));
    expect(r.ok).toBe(false);
  });

  it('is fast on long runs of repeated characters, separators and whitespace at the limit', () => {
    const f = compileFilter([
      ...DEFAULT_TERMS,
      { pattern: '(a+)+$', kind: 'REGEX', action: 'BLOCK' }, // rejected at compile
      { pattern: 'a.*b', kind: 'REGEX', action: 'BLOCK' },
    ]);
    const inputs = [
      'a'.repeat(FILTER_MAX_INPUT - 1) + '!',
      '.'.repeat(FILTER_MAX_INPUT - 1) + ' x',
      ' '.repeat(FILTER_MAX_INPUT),
      'a '.repeat(FILTER_MAX_INPUT / 2),
      'a.'.repeat(FILTER_MAX_INPUT / 2),
      '́'.repeat(FILTER_MAX_INPUT),
      '​'.repeat(FILTER_MAX_INPUT),
      'ﷺ'.repeat(FILTER_MAX_INPUT), // expands ~18x under NFKD
      'f'.repeat(FILTER_MAX_INPUT),
    ];
    for (const input of inputs) {
      expect(timed(() => applyFilter(f, input))).toBeLessThan(500);
    }
  });

  it('is fast with many terms against many words', () => {
    const terms = Array.from({ length: 1000 }, (_, i) => ({ pattern: `qq${i}zz`, kind: 'WORD' as const, action: 'MASK' as const }));
    const f = compileFilter([...terms, { pattern: 'fuck', kind: 'WORD', action: 'MASK' }]);
    const text = 'fuck '.repeat(FILTER_MAX_INPUT / 5);
    expect(timed(() => applyFilter(f, text))).toBeLessThan(1500);
  });
});

describe('nameAllowedBy', () => {
  it('checks the whole name and each part, refusing blocked and masked terms', () => {
    expect(nameAllowedBy(DEFAULT_FILTER, 'alice')).toBe(true);
    expect(nameAllowedBy(DEFAULT_FILTER, 'kys')).toBe(false);
    expect(nameAllowedBy(DEFAULT_FILTER, 'shit-lord')).toBe(false);
    expect(nameAllowedBy(DEFAULT_FILTER, 'root_user-7')).toBe(true);
  });
});

describe('cleanChatText', () => {
  it('strips control characters, collapses whitespace and caps at 512', () => {
    expect(cleanChatText('  hi\u0000 there\n\n you ')).toBe('hi there you');
    expect(cleanChatText('x'.repeat(600))).toHaveLength(CHAT_MAX_CHARS);
    expect(cleanChatText('\u0007')).toBe('');
  });
});
