import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { CodexBestiaryRow, ItemDef, MoveDef, NatureDef, SpeciesDef, TraitDef, TypeId } from './types.ts';

export interface Me {
  operatorId: string;
  name: string | null;
  starterClaimed: boolean;
  bits: number;
  isAdmin: boolean;
}
export interface ScriptDoc {
  source: string;
  version: number;
  updatedAt: string | null;
}
export interface ScriptVersion {
  version: number;
  createdAt: string;
  bytes: number;
}
export interface DiskDaemon {
  id: string;
  species: string;
  level: number;
  clean: boolean;
  signature: number;
  slot: number;
  hp: number;
  moves: string[];
  ivs: number[];
  heldItem: string | null;
  patched: boolean;
  moveTypeUses: number[];
  crashes: number;
  history: Array<{ at: string; kind: string; detail: string }>;
  log: { originalOperatorId: string; capturedAt: string; subnet: string; tool: string; spawnIndex: number | null };
}
export interface LedgerEntry {
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}
export interface Codex {
  types: TypeId[];
  chart: Record<TypeId, Record<TypeId, number>>;
  species: SpeciesDef[];
  moves: MoveDef[];
  items: ItemDef[];
  natures: NatureDef[];
  traits: TraitDef[];
  /** Bestiary rows with hidden, undiscovered requirements blanked (null). */
  bestiary: CodexBestiaryRow[];
  discovered: string[];
  discoveries: Array<{ formId: string; operatorName: string | null; discoveredAt: string }>;
  /** Each type's capture challenge rules: plain text with line breaks; render as text, never HTML. */
  challenges: Array<{ type: TypeId; rules: string }>;
  /** The caller's research points per bestiary line. */
  research: Record<string, number>;
  /** Requirement kinds of hidden, undiscovered branches in lines the caller researched to 256 (kind only). */
  hints: Array<{ formId: string; kind: string }>;
}

export interface BoardTicket {
  index: number;
  kind: 'clear' | 'capture' | 'deliver' | 'evolve';
  params: unknown;
  target: number;
  reward: number;
  title: string;
  status: 'OPEN' | 'DONE' | 'ABANDONED' | null;
}
export interface TicketHistory {
  id: string;
  day: string;
  subnet: string;
  index: number;
  kind: string;
  target: number;
  reward: number;
  progress: number;
  status: 'OPEN' | 'DONE' | 'ABANDONED';
  acceptedAt: string;
  completedAt: string | null;
}

/** All mutations carry the CSRF header the API requires. */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api',
    credentials: 'same-origin',
    prepareHeaders: (headers) => {
      headers.set('x-requested-with', 'daemonet');
      return headers;
    },
  }),
  tagTypes: ['Me', 'Script', 'Disk', 'Codex', 'Tickets'],
  endpoints: (b) => ({
    me: b.query<Me, void>({ query: () => '/me', providesTags: ['Me'] }),
    codex: b.query<Codex, void>({ query: () => '/codex', providesTags: ['Codex'] }),
    disk: b.query<DiskDaemon[], void>({ query: () => '/disk', providesTags: ['Disk'] }),
    ledger: b.query<LedgerEntry[], void>({ query: () => '/ledger' }),
    board: b.query<{ day: string; subnet: string; tickets: BoardTicket[]; acceptedToday: number }, string>({ query: (subnet) => `/tickets/board?subnet=${encodeURIComponent(subnet)}`, providesTags: ['Tickets'] }),
    ticketHistory: b.query<TicketHistory[], void>({ query: () => '/tickets', providesTags: ['Tickets'] }),
    script: b.query<ScriptDoc, void>({ query: () => '/scripts/main', providesTags: ['Script'] }),
    versions: b.query<ScriptVersion[], void>({ query: () => '/scripts/main/versions', providesTags: ['Script'] }),
    version: b.query<{ version: number; source: string }, number>({ query: (v) => `/scripts/main/versions/${v}` }),
    saveScript: b.mutation<{ version: number; updatedAt: string }, { source: string }>({
      query: (body) => ({ url: '/scripts/main', method: 'PUT', body }),
      invalidatesTags: ['Script'],
    }),
    logout: b.mutation<{ ok: boolean; endSessionUrl: string | null }, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      // the cached codex (research, hints), tickets and ledger belong to the operator who just left
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          dispatch(api.util.resetApiState());
        } catch {
          // a failed logout keeps the session and its caches
        }
      },
    }),
  }),
});

export const { useMeQuery, useCodexQuery, useDiskQuery, useLedgerQuery, useBoardQuery, useTicketHistoryQuery, useScriptQuery, useVersionsQuery, useLazyVersionQuery, useSaveScriptMutation, useLogoutMutation } = api;

/** A failed ticket request; `status` 401/403 means the web session is gone (sign in again). */
export class TicketError extends Error {
  constructor(readonly status: number) {
    super(`ticket request failed: ${status}`);
    this.name = 'TicketError';
  }

  /** The session is gone: retrying cannot help until the player signs in again. */
  get signedOut(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** A ticket request that takes longer than this fails (a timeout is retried like any other connect failure). */
export const TICKET_TIMEOUT_MS = 10_000;

/**
 * Mints a fresh single-use WebSocket ticket (`ticket:<value>`) outside React, for the connection
 * manager. Call it once per connection attempt: a ticket is consumed by the socket's `auth` and is
 * never reused, cached or sent in `reauth`.
 */
export async function fetchTicket(): Promise<string> {
  const res = await fetch('/api/ws/ticket', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'daemonet' }, signal: AbortSignal.timeout(TICKET_TIMEOUT_MS) });
  if (!res.ok) throw new TicketError(res.status);
  return ((await res.json()) as { ticket: string }).ticket;
}
