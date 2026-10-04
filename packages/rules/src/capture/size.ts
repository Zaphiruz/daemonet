import type { ToolDef } from '../content/items.js';

export interface ChallengeTarget {
  /** 0 = base form. */
  stage: number;
  /** Current HP / max HP, clamped to [0, 1]. */
  hpFraction: number;
  clean: boolean;
  signature: number;
  hardened: boolean;
  statused: boolean;
}

/**
 * size = 16 * 2^stage * (1 + hpFraction), x2 clean, x2 signature >= 1, x2 hardened, x0.5 statused,
 * x tool.sizeMultiplier; rounded; minimum 8, maximum {@link MAX_CHALLENGE_SIZE}.
 */
/** Upper bound on a challenge's size parameter; keeps every public challenge (single or chain) under 64 KiB. */
export const MAX_CHALLENGE_SIZE = 1024;

export function challengeSize(target: ChallengeTarget, tool: ToolDef): number {
  const hp = Math.min(1, Math.max(0, target.hpFraction));
  let size = 16 * 2 ** target.stage * (1 + hp);
  if (target.clean) size *= 2;
  if (target.signature >= 1) size *= 2;
  if (target.hardened) size *= 2;
  if (target.statused) size *= 0.5;
  size *= tool.sizeMultiplier;
  return Math.min(MAX_CHALLENGE_SIZE, Math.max(8, Math.round(size)));
}
