import type { Game } from './game.js';
import type { RunningServer } from './server.js';
import type { Store } from './store.js';

export interface ShutdownParts {
  server: Pick<RunningServer, 'stopAccepting' | 'close'>;
  game: Pick<Game, 'shutdown'>;
  store: Pick<Store, 'close'>;
}

/**
 * The sim's graceful shutdown sequence (the tick loop must already be stopped): stop accepting connections, let the
 * game kick everyone with 'server shutting down' and persist, then end the stragglers and close the store.
 */
export async function gracefulShutdown({ server, game, store }: ShutdownParts): Promise<void> {
  try {
    server.stopAccepting();
    await game.shutdown();
  } finally {
    try {
      await server.close();
    } finally {
      await store.close();
    }
  }
}
