import type { Input } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

export const LEASH_TILES = 8;
export const HOST_RADIUS = 2;
export const OUT_OF_COMBAT_MS = 4096;
export const RESTORE_CHANNEL_MS = 2048;
export const STARTER_LEVEL = 5;

/** Stub until Task 4: rejects every command. */
export function handleCommands(_world: World, inputs: readonly Input[], out: Out): void {
  for (const input of inputs) out.fail(input, 'E_STATE', 'commands are not implemented yet');
}
