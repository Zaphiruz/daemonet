import { deepFreeze } from '../freeze.js';
import { createRng, type Rng } from '../rng.js';
import type { TypeId } from '../types.js';
import { BESTIARY } from './bestiary.js';
import { getSpecies } from './species.js';
import { getSubnet } from './subnets.js';

/** Helpdesk tickets (SP3b spec 7): the only everyday faucet of bits. */
export const TICKETS_PER_DAY = 8;
export const OPEN_TICKETS_MAX = 2;
export const BOARD_SIZE = 8;

export type TicketKind = 'clear' | 'capture' | 'deliver' | 'evolve';

export type TicketParams =
  | { kind: 'clear'; type: TypeId; count: number }
  | { kind: 'capture'; line: number; minLevel: number }
  | { kind: 'deliver'; to: string }
  | { kind: 'evolve' };

export interface TicketDef {
  /** Position on the board (0-7); with the day and subnet it identifies the ticket. */
  index: number;
  kind: TicketKind;
  params: TicketParams;
  /** Progress needed to complete. */
  target: number;
  /** Bits paid on completion. */
  reward: number;
  title: string;
}

/** UTC calendar day (`YYYY-MM-DD`) a board belongs to. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Full `clear` counts by subnet tier (tiers above 3 use the last). */
const CLEAR_COUNTS = deepFreeze([4, 8, 16, 32] as const);
const cap512 = (n: number) => Math.min(512, n);
/** Spec 7: deliver pays 128-256. */
const DELIVER_MAX = 256;

function lineName(line: number): string {
  return BESTIARY.find((r) => r.line === line && r.stage === 0)?.name ?? `line ${line}`;
}

interface Pool {
  types: TypeId[];
  species: Array<{ id: string; minLevel: number }>;
}

/** Types that spawn in the subnet (primary types of its regions' species) and its spawnable species with region minimum levels. */
function subnetPool(subnetId: string): Pool {
  const s = getSubnet(subnetId);
  const types = new Set<TypeId>();
  const species: Pool['species'] = [];
  for (const r of s.regions) {
    for (const id of Object.keys(r.species)) {
      types.add(getSpecies(id).types[0]!);
      species.push({ id, minLevel: r.levels[0] });
    }
  }
  return { types: [...types], species };
}

function makeTicket(index: number, kind: TicketKind, subnetId: string, tier: number, rng: Rng, pool: Pool): TicketDef {
  switch (kind) {
    case 'clear': {
      const type = rng.pick(pool.types);
      const full = CLEAR_COUNTS[Math.min(3, tier)]!;
      const half = rng.chance(0.5);
      const count = half ? full / 2 : full;
      const reward = cap512(Math.max(64, 64 * (1 + tier) * (half ? 0.5 : 1)));
      return { index, kind, params: { kind, type, count }, target: count, reward, title: `Clear ${count} ${type} daemons in ${subnetId}` };
    }
    case 'capture': {
      const pick = rng.pick(pool.species);
      const sp = getSpecies(pick.id);
      const reward = cap512(128 * (1 + sp.stage) + 64 * tier);
      return {
        index,
        kind,
        params: { kind, line: sp.line, minLevel: pick.minLevel },
        target: 1,
        reward,
        title: `Capture a ${lineName(sp.line)}-line daemon of level ${pick.minLevel}+ in ${subnetId}`,
      };
    }
    case 'deliver': {
      // Incident gateways are not ordinary destinations: a ticket must always be completable.
      const to = rng.pick(getSubnet(subnetId).gateways.filter((g) => !g.incidentOnly).map((g) => g.to));
      const reward = Math.min(DELIVER_MAX, 128 + 64 * Math.max(tier, getSubnet(to).tier));
      return { index, kind, params: { kind, to }, target: 1, reward, title: `Deliver a token to the host of ${to}` };
    }
    case 'evolve':
      return { index, kind, params: { kind }, target: 1, reward: 256, title: 'Evolve any daemon' };
  }
}

/**
 * The 8 tickets a subnet's host posts on `day` (same for every operator; rotates daily). `lo` boards
 * always open with two tool-free `clear` tickets so a new operator can earn a first purchase.
 */
export function ticketBoard(subnetId: string, day: string): TicketDef[] {
  const subnet = getSubnet(subnetId);
  if (subnet.regions.length === 0) return []; // kernelspace: no spawns to clear or capture, no board
  const rng = createRng(`tickets:${subnetId}:${day}`);
  const pool = subnetPool(subnetId);
  const kinds: readonly TicketKind[] = subnet.tier === 0 ? ['clear', 'capture', 'deliver'] : ['clear', 'capture', 'deliver', 'evolve'];
  const board: TicketDef[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    const kind = subnetId === 'lo' && i < 2 ? 'clear' : rng.pick(kinds);
    board.push(makeTicket(i, kind, subnetId, subnet.tier, rng, pool));
  }
  return board;
}

export function ticketKey(day: string, subnet: string, index: number): string {
  return `${day}:${subnet}:${index}`;
}
