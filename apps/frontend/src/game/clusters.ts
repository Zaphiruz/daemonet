import { useSyncExternalStore } from 'react';

export interface ClusterInvite {
  clusterId: string;
  from: string;
  name: string | null;
  expiresAt: string;
}

/** Friendly cause per protocol error code; the server's own detail follows it. */
const CODE_TEXT: Record<string, string> = {
  E_RATE: 'too fast, slow down',
  E_STATE: 'not possible right now',
  E_RANGE: 'too far away',
  E_INVALID: 'not accepted',
  E_COOLDOWN: 'still cooling down',
  E_ENERGY: 'not enough energy',
  E_AUTH: 'not allowed for this session',
};

/** Readable text for a rejected cluster command. */
export function describeClusterError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  // the SDK's message is "<code>: <server text>"; players get the readable lead instead of the code
  const message = typeof code === 'string' && raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  const lead = typeof code === 'string' ? CODE_TEXT[code] : undefined;
  return lead ? `${lead}: ${message}` : message;
}

/**
 * Pending cluster invites, fed by the connection (they arrive before any panel mounts). An invite is dropped
 * client-side at its `expiresAt`; there is one per cluster (a newer invite replaces the older).
 */
export function createClusterStore(now: () => number = () => Date.now()) {
  let invites: ClusterInvite[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let snapshot = { invites };
  const notify = () => {
    snapshot = { invites };
    listeners.forEach((l) => l());
  };
  const drop = (clusterId: string) => {
    const t = timers.get(clusterId);
    if (t !== undefined) clearTimeout(t);
    timers.delete(clusterId);
    invites = invites.filter((i) => i.clusterId !== clusterId);
  };
  return {
    push(inv: ClusterInvite) {
      const left = Date.parse(inv.expiresAt) - now();
      drop(inv.clusterId);
      if (left > 0) {
        invites = [...invites, inv];
        timers.set(
          inv.clusterId,
          setTimeout(() => {
            drop(inv.clusterId);
            notify();
          }, left),
        );
      }
      notify();
    },
    remove(clusterId: string) {
      drop(clusterId);
      notify();
    },
    /** Forgets everything of the session (the connection ended or the operator logged out). */
    clear() {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      invites = [];
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type ClusterStore = ReturnType<typeof createClusterStore>;
export const clusterStore = createClusterStore();

export function useClusterInvites(): ClusterInvite[] {
  return useSyncExternalStore(clusterStore.subscribe, clusterStore.get, clusterStore.get).invites;
}
