import { useSyncExternalStore } from 'react';

export interface IncidentInfo {
  id: string;
  species: string;
  endsAt: string;
  phase: 'open' | 'fighting' | 'shield' | 'unshield';
  bossId: string | null;
}
export interface Telegraph {
  x: number;
  y: number;
  radius: number;
  atTick: number;
}
export interface IncidentEvent {
  phase: 'open' | 'fighting' | 'shield' | 'unshield' | 'cleared' | 'expired';
  id: string;
  n?: number;
  species: string;
  endsAt: string;
  bossId: string | null;
  participants?: Array<{ operatorId: string; name: string | null; damage: number; share: number; reward: number }>;
}

export interface IncidentSnapshot {
  current: IncidentInfo | null;
  telegraphs: Telegraph[];
}

/**
 * Live Incident state for the banner, the gateway card and the map. Fed by the connection's events (they arrive before
 * any panel mounts, carry-forward #19) and seeded from /api/incidents when the page loads mid-Incident, when no event
 * will come until the phase changes. Ids of Incidents that ended are remembered so a cached API answer can never bring
 * a finished one back.
 */
export function createIncidentStore(now: () => number = () => Date.now()) {
  let current: IncidentInfo | null = null;
  let telegraphs: Telegraph[] = [];
  const ended = new Set<string>();
  let snapshot: IncidentSnapshot = { current, telegraphs };
  const listeners = new Set<() => void>();
  const notify = () => {
    snapshot = { current, telegraphs };
    listeners.forEach((l) => l());
  };
  return {
    onEvent(e: IncidentEvent) {
      if (e.phase === 'cleared' || e.phase === 'expired') {
        ended.add(e.id);
        current = null;
        telegraphs = [];
      } else current = { id: e.id, species: e.species, endsAt: e.endsAt, phase: e.phase, bossId: e.bossId };
      notify();
    },
    /** From the API: only when nothing newer is known, and never an Incident that ended or whose window is over. */
    seed(info: { id: string; species: string; endsAt: string } | null) {
      if (!info || current || ended.has(info.id) || Date.parse(info.endsAt) <= now()) return;
      current = { ...info, phase: 'open', bossId: null };
      notify();
    },
    onTelegraph(t: Telegraph) {
      telegraphs = [...telegraphs, t];
      notify();
    },
    /** Drops blasts that have landed. */
    prune(tick: number) {
      if (!telegraphs.some((t) => t.atTick < tick)) return;
      telegraphs = telegraphs.filter((t) => t.atTick >= tick);
      notify();
    },
    /** The blasts belong to the world that was just replaced (travel). */
    clearTelegraphs() {
      if (!telegraphs.length) return;
      telegraphs = [];
      notify();
    },
    /** The connection was lost or replaced: what is running now is unknown until the API says so. */
    resync() {
      if (!current && !telegraphs.length) return;
      current = null;
      telegraphs = [];
      notify();
    },
    /** A different operator signs in: forget everything. */
    reset() {
      current = null;
      telegraphs = [];
      ended.clear();
      notify();
    },
    get: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type IncidentStore = ReturnType<typeof createIncidentStore>;

export const incidentStore = createIncidentStore();
export function useIncident(): IncidentSnapshot {
  return useSyncExternalStore(incidentStore.subscribe, incidentStore.get, incidentStore.get);
}

/** Plain-words log line per phase. */
export function describeIncidentEvent(e: IncidentEvent): string {
  switch (e.phase) {
    case 'open':
      return `INCIDENT: a ${e.species} kernel daemon is loose in kernelspace (gateway in backbone)`;
    case 'fighting':
      return `the ${e.species} is under attack`;
    case 'shield':
      return `the ${e.species} raised its shield — clear the adds`;
    case 'unshield':
      return `the ${e.species} is exposed again`;
    case 'cleared':
      return `Incident cleared${e.participants?.length ? `: ${e.participants.map((p) => `${p.name ?? '?'} ${Math.round(p.share * 100)}% → ${p.reward} bits`).join(', ')}` : ''}`;
    case 'expired':
      return `the ${e.species} got away`;
  }
}
