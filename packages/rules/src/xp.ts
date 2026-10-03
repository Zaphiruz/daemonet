import { LEVEL_CAP } from './constants.js';

/** Total XP needed to be at `level`: 8 * level^3. */
export function xpForLevel(level: number): number {
  return 8 * level ** 3;
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < LEVEL_CAP && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** XP from defeating or capturing a daemon. */
export function xpYield(baseYield: number, level: number): number {
  return Math.floor((baseYield * level) / 8);
}

/** Split XP equally; the remainder goes to the first recipients. */
export function splitXp(total: number, recipients: number): number[] {
  if (recipients <= 0) return [];
  const share = Math.floor(total / recipients);
  const remainder = total - share * recipients;
  return Array.from({ length: recipients }, (_, i) => share + (i < remainder ? 1 : 0));
}
