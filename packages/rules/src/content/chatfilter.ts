import { deepFreeze } from '../freeze.js';

/**
 * Chat filter (SP4 spec §5.1). The default term list ships here; admins add terms at runtime. Matching
 * runs on a normalised form of the text (case-folded, confusables and leet folded, zero-width characters and
 * combining marks removed, repeated characters collapsed, separators removed inside words) so `S.p.a.m` and
 * `spaaam` match `spam`.
 *
 * The filter runs on untrusted player text and admin-supplied terms, so it is built to stay linear-ish:
 * input is length-bounded before any matching, WORD terms are escaped literals, and REGEX terms that could
 * backtrack catastrophically are refused at compile time (see `regexIsSafe`).
 */
export type FilterAction = 'BLOCK' | 'MASK';
export type FilterKind = 'WORD' | 'REGEX';

export interface FilterTerm {
  pattern: string;
  kind: FilterKind;
  action: FilterAction;
}

/** Deliberately short and generic: slurs and harassment terms are added by the admins, not shipped in the repo. */
export const DEFAULT_TERMS: readonly FilterTerm[] = deepFreeze([
  { pattern: 'kys', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'kill yourself', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'free bits', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'discord.gg', kind: 'WORD', action: 'BLOCK' },
  { pattern: 'https?://', kind: 'REGEX', action: 'BLOCK' },
  { pattern: 'fuck', kind: 'WORD', action: 'MASK' },
  { pattern: 'shit', kind: 'WORD', action: 'MASK' },
] as const satisfies readonly FilterTerm[]);

/** Text longer than this is refused outright by `applyFilter` (chat is capped at 512 characters well below it). */
export const FILTER_MAX_INPUT = 2048;
/** Longest admin pattern (WORD or REGEX) that is compiled. */
export const FILTER_MAX_PATTERN = 200;
/** At most this many terms are compiled (extra terms are ignored). */
export const FILTER_MAX_TERMS = 1000;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Cyrillic and Greek lookalikes (lower case; input is lower-cased first) folded to the Latin letter they imitate. */
const CONFUSABLE: Record<string, string> = deepFreeze({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k',
  'і': 'i', 'ѕ': 's', 'ј': 'j', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'н': 'h',
  'т': 't', 'м': 'm', 'в': 'b',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'β': 'b', 'η': 'n', 'ω': 'w',
});

/** Case-fold, strip marks / format characters, fold confusables, undo leet, collapse repeats, drop separators inside words. Pure. */
export function normalizeForFilter(text: string): string {
  const folded = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[Ͱ-ϿЀ-ԯ]/g, (c) => CONFUSABLE[c] ?? c)
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c);
  return folded
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[.\-_*~^`'"]+(?=\S)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CompiledFilter {
  terms: Array<FilterTerm & { re: RegExp }>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Conservative ReDoS guard for admin REGEX terms. Refuses: over-long patterns, backreferences, a quantified group
 * (`+ * {`) that contains a quantifier or an alternation (`(a+)+`, `(a|aa)*`), more than one unbounded quantifier
 * (polynomial blow-up), more than two quantifiers in all, bounded repeats above 100, and more than eight `?`.
 * Safe patterns therefore cost at most O(n^2) on input bounded by `FILTER_MAX_INPUT`.
 */
function regexIsSafe(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > FILTER_MAX_PATTERN) return false;
  if (/\\[1-9k]/.test(pattern)) return false;
  const s = pattern.replace(/\\[\s\S]/g, 'x').replace(/\[[^\]]*\]/g, 'x');
  const stack: Array<{ quant: boolean; alt: boolean }> = [];
  let unbounded = 0;
  let counted = 0;
  let optional = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '(') {
      stack.push({ quant: false, alt: false });
      if (s[i + 1] === '?') i++; // (?: (?= (?! (?<
    } else if (c === '|') {
      const top = stack[stack.length - 1];
      if (top) top.alt = true;
    } else if (c === '?') {
      if (++optional > 8) return false;
      for (const f of stack) f.quant = true;
    } else if (c === '+' || c === '*' || c === '{') {
      if (c === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(s.slice(i));
        if (!m) continue; // a literal brace
        if (Number(m[1]) > 100 || (m[2] !== undefined && m[2] !== '' && Number(m[2]) > 100)) return false;
        if (m[2] === '') unbounded++;
        counted++;
        i += m[0].length - 1;
      } else {
        unbounded++;
        counted++;
      }
      for (const f of stack) f.quant = true;
    } else if (c === ')') {
      const f = stack.pop();
      if (!f) return false; // unbalanced; RegExp would reject too
      const next = s[i + 1];
      if ((next === '+' || next === '*' || next === '{') && (f.quant || f.alt)) return false;
    }
  }
  return unbounded <= 1 && counted <= 2;
}

export function compileFilter(terms: readonly FilterTerm[]): CompiledFilter {
  return {
    terms: terms.slice(0, FILTER_MAX_TERMS).flatMap((t) => {
      try {
        if (t.pattern.length > FILTER_MAX_PATTERN) return [];
        let source: string;
        if (t.kind === 'REGEX') {
          if (!regexIsSafe(t.pattern)) return [];
          source = t.pattern;
        } else {
          const norm = normalizeForFilter(t.pattern);
          if (norm === '') return []; // would match everywhere
          source = `(?<![a-z])${escape(norm)}(?![a-z])`;
        }
        return [{ ...t, re: new RegExp(source, 'i') }];
      } catch {
        return [];
      }
    }),
  };
}

export type FilterResult = { ok: true; text: string; masked: string[] } | { ok: false; term: string };

/**
 * BLOCK wins over MASK; masking replaces the offending words in the *original* text with `***`.
 * Text longer than `FILTER_MAX_INPUT` is refused (fail closed) without being scanned.
 */
export function applyFilter(filter: CompiledFilter, text: string): FilterResult {
  if (text.length > FILTER_MAX_INPUT) return { ok: false, term: 'length' };
  const norm = normalizeForFilter(text);
  const masked: string[] = [];
  let words: string[] | undefined;
  let normWords: string[] = [];
  for (const t of filter.terms) {
    if (!t.re.test(norm)) continue;
    if (t.action === 'BLOCK') return { ok: false, term: t.pattern };
    masked.push(t.pattern);
    if (!words) {
      words = text.split(/(\s+)/);
      normWords = words.map((w) => (/\s/.test(w) ? '' : normalizeForFilter(w)));
    }
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== '***' && normWords[i] !== '' && t.re.test(normWords[i]!)) words[i] = '***';
    }
  }
  return { ok: true, text: words ? words.join('') : text, masked };
}

export const DEFAULT_FILTER: CompiledFilter = deepFreeze(compileFilter(DEFAULT_TERMS));

/** Names (operators, orgs, tags) join words with - _ . so each part is checked on its own as well as the whole; masked terms are refused too. */
export function nameAllowedBy(filter: CompiledFilter, name: string): boolean {
  return [name, ...name.split(/[-_.\s]+/)].every((part) => {
    const r = applyFilter(filter, part);
    return r.ok && r.masked.length === 0;
  });
}

export const CHAT_MAX_CHARS = 512;
export const CHAT_INTERVAL_MS = 2000;
export const CHAT_HISTORY_DAYS = 7;
/** BLOCK hits within this window that trigger an automatic mute of AUTO_MUTE_MINUTES. */
export const AUTO_MUTE_HITS = 3;
export const AUTO_MUTE_WINDOW_MS = 10 * 60_000;
export const AUTO_MUTE_MINUTES = 10;
export const REPORTS_PER_DAY = 8;

/** Trim, strip control characters, cap the length. Empty result = nothing to send. */
export function cleanChatText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_CHARS);
}
