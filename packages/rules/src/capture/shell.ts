import { z } from 'zod';
import type { ChallengeFamily } from './common.js';
import { WORDS } from './crypto.js';

/**
 * Shell: evaluate a small pipeline over `lines`.
 * Stages (separated by " | "): `grep <word>` keeps lines containing the word as a plain, case-sensitive
 * substring (no patterns); `sort` sorts lines (code-point order); `uniq` drops consecutive duplicates;
 * `cut -d<c> -f<n>` keeps the n-th (1-based) field split by the single character c (lines with fewer fields
 * become ""); `wc -l` replaces the output with one line holding the count. Blank lines in the INPUT are
 * ignored (noise); an empty string produced by a stage (e.g. `cut`) is a line like any other and is kept.
 * A generated pipeline with no `grep`, `cut` or `wc` stage gets at most {@link SHELL_UNREDUCED_MAX_LINES} input lines
 * (blank lines not counted), so the answer stays small enough to submit.
 * Answer: the output lines.
 */
export interface ShellParams {
  pipeline: string;
}
export interface ShellPayload {
  lines: string[];
}
export interface ShellAnswer {
  output: string[];
}

/** Compare strings by Unicode code point (not by UTF-16 code unit, which misorders astral characters). */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Input-line cap for a generated pipeline that keeps every line (no `grep`, `cut` or `wc` stage). */
export const SHELL_UNREDUCED_MAX_LINES = 512;

export function runPipeline(pipeline: string, lines: readonly string[]): string[] {
  let out = lines.filter((l) => l !== '');
  for (const stage of pipeline.split(' | ')) {
    const [cmd, ...args] = stage.split(' ');
    switch (cmd) {
      case 'grep':
        out = out.filter((l) => l.includes(args[0]!));
        break;
      case 'sort':
        out = [...out].sort(compareCodePoints);
        break;
      case 'uniq':
        out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
        break;
      case 'cut': {
        const delim = args[0]!.slice(2);
        const field = Number(args[1]!.slice(2)) - 1;
        out = out.map((l) => l.split(delim)[field] ?? '');
        break;
      }
      case 'wc':
        out = [String(out.length)];
        break;
    }
  }
  return out;
}

export const shellFamily: ChallengeFamily<ShellParams, ShellPayload, ShellAnswer> = {
  type: 'shell',
  answerSchema: z.object({ output: z.array(z.string()).max(16384) }),
  generate(size, noise, rng) {
    const stages: string[] = [];
    if (rng.chance(0.7)) stages.push(`grep ${rng.pick(WORDS)}`);
    if (rng.chance(0.5)) stages.push(`cut -d, -f${rng.int(1, 3)}`);
    if (rng.chance(0.7)) stages.push('sort');
    if (rng.chance(0.5)) stages.push('uniq');
    if (rng.chance(0.3)) stages.push('wc -l');
    if (stages.length === 0) stages.push('sort');
    const pipeline = stages.join(' | ');
    // sort/uniq alone keep every (up to 16-character) line; cap the input so the output stays under MAX_ANSWER_BYTES
    const reduces = stages.some((s) => s.startsWith('grep') || s.startsWith('cut') || s.startsWith('wc'));
    const count = reduces ? size : Math.min(size, SHELL_UNREDUCED_MAX_LINES);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(`${rng.pick(WORDS)},${rng.int(0, 99)},${rng.pick(WORDS)}`);
    const blanks = [0, Math.floor(count / 8), Math.floor(count / 4)][noise]!;
    for (let i = 0; i < blanks; i++) lines.splice(rng.int(0, lines.length), 0, '');
    return { params: { pipeline }, payload: { lines }, answer: { output: runPipeline(pipeline, lines) } };
  },
  check: (e, s) => e.output.length === s.output.length && e.output.every((v, i) => v === s.output[i]),
};
