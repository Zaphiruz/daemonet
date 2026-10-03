import type { Input } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export interface Aim {
  targetId?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
}

export interface QueuedUse {
  daemonId: string;
  move: string;
  aim: Aim;
  /** Player uses carry their input so the reply can be sent; wild uses have none. */
  input?: Input;
}

/** Stub until Task 5. */
export function executeQueuedUses(_world: World, _uses: readonly QueuedUse[], _out: Out): void {}
