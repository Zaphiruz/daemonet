import type { Bus } from '@daemonet/bus';
import type { Game } from './game.js';
import type { RunningServer } from './server.js';
import type { Store } from './store.js';

export interface ShutdownParts {
  server: Pick<RunningServer, 'stopAccepting' | 'close'>;
  game: Pick<Game, 'shutdown'>;
  store: Pick<Store, 'close'>;
  bus: Pick<Bus, 'close'>;
}

/**
 * The sim's graceful shutdown sequence (the tick loop must already be stopped): stop accepting connections, let the
 * game kick everyone with 'server shutting down' and persist, then end the stragglers, close the store and finally the
 * bus (in-flight chat lines publish after their store write).
 */
export async function gracefulShutdown({ server, game, store, bus }: ShutdownParts): Promise<void> {
  try {
    server.stopAccepting();
    await game.shutdown();
  } finally {
    try {
      await server.close();
    } finally {
      try {
        await store.close();
      } finally {
        await bus.close();
      }
    }
  }
}
