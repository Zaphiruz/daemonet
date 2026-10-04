import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { chatStore } from './game/chat.ts';
import { clusterStore } from './game/clusters.ts';
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
export type OrgRank = 'OWNER' | 'OFFICER' | 'MEMBER';
export interface OrgMemberRow {
  operatorId: string;
  name: string | null;
  rank: OrgRank;
  joinedAt: string;
}
export interface OrgView {
  id: string;
  name: string;
  tag: string;
  ownerId: string;
  members: OrgMemberRow[];
}
export interface OrgMine {
  org: OrgView | null;
  rank: OrgRank | null;
  invites: Array<{ orgId: string; name: string; tag: string; byId: string; at: string }>;
  prices: { create: number; tag: number; rename: number };
}
export interface OrgLeaderRow {
  operatorId: string;
  name: string | null;
  rank: OrgRank;
  captures: number;
  highestSignature: number;
  evolutions: number;
  ticketsDone: number;
}
export interface LedgerEntry {
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
}
export interface ChatHistoryLine {
  id: string;
  channel: string;
  from: string;
  name: string | null;
  tag: string | null;
  text: string;
  at: string;
}
export interface AdminReport {
  id: string;
  reporterId: string;
  targetId: string;
  messageId: string | null;
  reason: string;
  note: string;
  status: string;
  at: string;
  reporterName: string | null;
  targetName: string | null;
  message: { id: string; text: string; channel: string } | null;
  /** The reported operator's latest lines and filter hits, for context. */
  recent: Array<{ id: string; channel: string; text: string; at: string }>;
  hits: Array<{ id: string; channel: string; text: string; term: string; at: string }>;
}
export interface FilterTermRow {
  id: string;
  pattern: string;
  kind: 'WORD' | 'REGEX';
  action: 'BLOCK' | 'MASK';
}
export interface EconomyView {
  supply: number;
  operators: number;
  days: Array<{ day: string; created: number; destroyed: number; byReason: Record<string, number> }>;
}

/**
 * A readable message for a failed API call. The API's error bodies (`validation_error` / `bad_request` / `not_found`
 * carry its own short reason; `unauthorized`, `forbidden`, `payload_too_large`, `rate_limited`, `internal_error`) and
 * transport failures all map to something a person can act on; nothing else from a response is shown.
 */
export function describeApiError(err: unknown): string {
  const e = err as { status?: unknown; data?: { error?: unknown; message?: unknown } } | null | undefined;
  if (e === null || typeof e !== 'object') return 'request failed';
  const status = e.status;
  if (status === 'FETCH_ERROR' || status === 'TIMEOUT') return 'network error: check your connection and try again';
  if (status === 'PARSING_ERROR') return 'server error: try again later';
  const code = typeof e.data?.error === 'string' ? e.data.error : '';
  const message = typeof e.data?.message === 'string' ? e.data.message : '';
  if (status === 401 || code === 'unauthorized') return 'session expired: sign in again';
  if (status === 403 || code === 'forbidden') return 'admin rights required';
  if (status === 413 || code === 'payload_too_large') return 'request too large';
  if (status === 429 || code === 'rate_limited') return 'too many requests: slow down and try again';
  if (typeof status === 'number' && status >= 500) return 'server error: try again later';
  if ((code === 'validation_error' || code === 'bad_request' || code === 'not_found') && message) return message;
  return 'request failed';
}

/**
 * A readable message for a failed org / rename call. The API's own short reasons are shown (`costs 8192 bits`, `that name
 * is taken`, `that name or tag is not allowed` for a filter refusal, `requires owner`); a 402 says the balance is short.
 */
export function describeOrgError(err: unknown): string {
  const e = err as { status?: unknown; data?: { error?: unknown; message?: unknown } } | null | undefined;
  if (e === null || typeof e !== 'object') return 'request failed';
  const code = typeof e.data?.error === 'string' ? e.data.error : '';
  const message = typeof e.data?.message === 'string' ? e.data.message : '';
  if (e.status === 402 || code === 'insufficient_bits') return `not enough bits${message ? `: ${message}` : ''}`;
  if (e.status === 403 || code === 'forbidden') return message ? `not allowed: ${message}` : 'not allowed: your rank cannot do that';
  if ((e.status === 400 || e.status === 404) && message) return message;
  return describeApiError(err);
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
/** A history page: the newest lines, or those before the `(at, id)` cursor of the oldest line held. */
export interface ChatHistoryArgs {
  channel: string;
  before?: string;
  beforeId?: string;
}

/** `before` and `beforeId` together form the API's composite cursor (lines of one millisecond are never skipped). */
export function chatHistoryUrl({ channel, before, beforeId }: ChatHistoryArgs): string {
  const q = new URLSearchParams();
  if (before) q.set('before', before);
  if (before && beforeId) q.set('beforeId', beforeId);
  const qs = q.toString();
  return `/chat/${encodeURIComponent(channel)}${qs ? `?${qs}` : ''}`;
}

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
  tagTypes: ['Me', 'Script', 'Disk', 'Codex', 'Tickets', 'Reports', 'Filter', 'Org'],
  endpoints: (b) => ({
    me: b.query<Me, void>({ query: () => '/me', providesTags: ['Me'] }),
    codex: b.query<Codex, void>({ query: () => '/codex', providesTags: ['Codex'] }),
    disk: b.query<DiskDaemon[], void>({ query: () => '/disk', providesTags: ['Disk'] }),
    ledger: b.query<LedgerEntry[], void>({ query: () => '/ledger' }),
    board: b.query<{ day: string; subnet: string; tickets: BoardTicket[]; acceptedToday: number }, string>({ query: (subnet) => `/tickets/board?subnet=${encodeURIComponent(subnet)}`, providesTags: ['Tickets'] }),
    ticketHistory: b.query<TicketHistory[], void>({ query: () => '/tickets', providesTags: ['Tickets'] }),
    chatHistory: b.query<ChatHistoryLine[], ChatHistoryArgs>({ query: chatHistoryUrl }),
    report: b.mutation<{ ok: boolean; id: string; duplicate?: boolean }, { targetId: string; messageId?: string; reason: string; note: string }>({
      query: (body) => ({ url: '/reports', method: 'POST', body }),
    }),
    adminReports: b.query<AdminReport[], string>({ query: (status) => `/admin/reports?status=${status}`, providesTags: ['Reports'] }),
    resolveReport: b.mutation<{ ok: boolean }, { id: string; action: 'DISMISS' | 'DELETE' | 'MUTE'; minutes?: number }>({
      query: ({ id, ...body }) => ({ url: `/admin/reports/${encodeURIComponent(id)}/resolve`, method: 'POST', body }),
      invalidatesTags: ['Reports'],
    }),
    filterTerms: b.query<FilterTermRow[], void>({ query: () => '/admin/chat/filter', providesTags: ['Filter'] }),
    addFilterTerm: b.mutation<FilterTermRow, { pattern: string; kind: 'WORD' | 'REGEX'; action: 'BLOCK' | 'MASK' }>({
      query: (body) => ({ url: '/admin/chat/filter', method: 'POST', body }),
      invalidatesTags: ['Filter'],
    }),
    deleteFilterTerm: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `/admin/chat/filter/${encodeURIComponent(id)}`, method: 'DELETE' }), invalidatesTags: ['Filter'] }),
    adminDeleteMessage: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `/admin/chat/${encodeURIComponent(id)}`, method: 'DELETE' }), invalidatesTags: ['Reports'] }),
    adminMute: b.mutation<{ ok: boolean; until: string | null }, { operatorId: string; minutes: number }>({
      query: (body) => ({ url: '/admin/chat/mute', method: 'POST', body }),
    }),
    adminEconomy: b.query<EconomyView, void>({ query: () => '/admin/economy' }),
    orgMine: b.query<OrgMine, void>({ query: () => '/orgs/mine', providesTags: ['Org'] }),
    orgLeaderboard: b.query<OrgLeaderRow[], string>({ query: (id) => `/orgs/${encodeURIComponent(id)}/leaderboard`, providesTags: ['Org'] }),
    /** POST /api/orgs<path> — create (''), /invite, /<id>/accept, /<id>/decline, /leave, /kick, /rank, /transfer, /tag. */
    orgAction: b.mutation<unknown, { path: string; body: object }>({ query: ({ path, body }) => ({ url: `/orgs${path}`, method: 'POST', body }), invalidatesTags: ['Org'] }),
    rename: b.mutation<{ ok: boolean; name: string; bits: number }, { name: string }>({ query: (body) => ({ url: '/me/rename', method: 'POST', body }), invalidatesTags: ['Me', 'Org'] }),
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
          // the chat lines and mute state belong to the operator who just left too
          chatStore.clear();
          clusterStore.clear();
        } catch {
          // a failed logout keeps the session and its caches
        }
      },
    }),
  }),
});

export const {
  useLazyChatHistoryQuery,
  useReportMutation,
  useAdminReportsQuery,
  useResolveReportMutation,
  useFilterTermsQuery,
  useAddFilterTermMutation,
  useDeleteFilterTermMutation,
  useAdminDeleteMessageMutation,
  useAdminMuteMutation,
  useAdminEconomyQuery,
  useOrgMineQuery,
  useOrgLeaderboardQuery,
  useOrgActionMutation,
  useRenameMutation,
  useMeQuery, useCodexQuery, useDiskQuery, useLedgerQuery, useBoardQuery, useTicketHistoryQuery, useScriptQuery, useVersionsQuery, useLazyVersionQuery, useSaveScriptMutation, useLogoutMutation } = api;

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
