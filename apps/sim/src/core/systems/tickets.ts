import { OPEN_TICKETS_MAX, TICKETS_PER_DAY, dayKey, ticketBoard, ticketKey, type TicketDef, type TypeId } from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, type Input, type IntentResult, type OpenTicket, type Operator, type TicketIntent } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';
import { HOST_RADIUS } from './commands.js';

/**
 * Helpdesk tickets (SP3b spec §7). The board is rules content; an accepted ticket is a store row. Accept and abandon
 * are store intents (the world tracks them as `pending`); progress is counted here and checkpointed; the payout is a
 * `completeTicket` intent that the store applies once (row OPEN -> DONE with one ledger row) and the world credits on
 * commit. A definitive refusal of a completion means the row is no longer open (paid or closed elsewhere): the ticket
 * leaves the world unpaid and is never raised again.
 */

/** Something a ticket can count: a wild daemon cleared here, a capture here, an evolution anywhere. */
export type TicketEvent = { kind: 'clear'; type: TypeId } | { kind: 'capture'; line: number; level: number } | { kind: 'evolve' };

/** Rolls the per-day counter (and the day's accepted keys) over at UTC midnight. */
function today(world: World, op: Operator, day = dayKey(world.now())): string {
  if (op.ticketsDay !== day) {
    op.ticketsDay = day;
    op.ticketsToday = 0;
    for (const key of op.acceptedKeys) if (!key.startsWith(`${day}:`)) op.acceptedKeys.delete(key);
  }
  return day;
}

/** Recently generated boards (every `self` projection looks up its tickets' titles each tick). */
const boards = new Map<string, readonly TicketDef[] | null>();
const BOARD_CACHE_MAX = 64;

/** The board a ticket came from, or undefined for a subnet without one. */
export function boardTicket(subnet: string, day: string, index: number): TicketDef | undefined {
  const key = `${day}:${subnet}`;
  let board = boards.get(key);
  if (board === undefined) {
    try {
      board = ticketBoard(subnet, day);
    } catch {
      board = null;
    }
    if (boards.size >= BOARD_CACHE_MAX) boards.clear();
    boards.set(key, board);
  }
  return board?.[index];
}

export function acceptTicket(world: World, op: Operator, args: { day: string; subnet: string; index: number }, input: Input, out: Out): void {
  if (distance(op, world.subnet.host) > HOST_RADIUS) throw new Rejection('E_RANGE', 'must be at the host node');
  if (args.subnet !== world.subnet.id) throw new Rejection('E_INVALID', `this host only posts ${world.subnet.id} tickets`);
  const day = today(world, op);
  if (args.day !== day) throw new Rejection('E_STATE', `the board for ${args.day} is gone; today is ${day}`);
  const def = Number.isSafeInteger(args.index) && args.index >= 0 ? boardTicket(world.subnet.id, day, args.index) : undefined;
  if (!def) throw new Rejection('E_INVALID', 'no such ticket on the board');
  const key = ticketKey(day, args.subnet, args.index);
  if (op.acceptedKeys.has(key)) throw new Rejection('E_STATE', 'already accepted');
  if (op.ticketsToday >= TICKETS_PER_DAY) throw new Rejection('E_STATE', `at most ${TICKETS_PER_DAY} tickets per day`);
  if (op.tickets.length >= OPEN_TICKETS_MAX) throw new Rejection('E_STATE', `at most ${OPEN_TICKETS_MAX} open tickets`);
  const ticket: OpenTicket = {
    id: world.newId('t'),
    day,
    subnet: args.subnet,
    index: args.index,
    kind: def.kind,
    // A copy: the board is cached and shared.
    params: structuredClone(def.params),
    target: def.target,
    reward: def.reward,
    progress: 0,
    pending: true,
    completing: false,
  };
  op.tickets.push(ticket);
  op.acceptedKeys.add(key);
  op.ticketsToday++;
  world.trackIntent(
    {
      id: world.newId('i'), kind: 'acceptTicket', operatorId: op.id, reqId: input.reqId, ticketId: ticket.id, day, subnet: args.subnet, index: args.index,
      ticketKind: def.kind, params: structuredClone(def.params), target: def.target, reward: def.reward,
    },
    out,
  );
}

export function abandonTicket(world: World, op: Operator, ticketId: string, input: Input, out: Out): void {
  const t = op.tickets.find((x) => x.id === ticketId);
  if (!t) throw new Rejection('E_INVALID', 'no such open ticket');
  if (t.pending || t.completing) throw new Rejection('E_STATE', 'ticket is busy');
  t.pending = true;
  world.trackIntent({ id: world.newId('i'), kind: 'abandonTicket', operatorId: op.id, reqId: input.reqId, ticketId }, out);
}

function matches(world: World, t: OpenTicket, ev: TicketEvent): boolean {
  const p = t.params;
  switch (ev.kind) {
    case 'clear':
      return p.kind === 'clear' && p.type === ev.type && t.subnet === world.subnet.id;
    case 'capture':
      return p.kind === 'capture' && p.line === ev.line && ev.level >= p.minLevel && t.subnet === world.subnet.id;
    case 'evolve':
      return p.kind === 'evolve';
  }
}

function bump(world: World, op: Operator, t: OpenTicket, out: Out): void {
  t.progress = Math.min(t.target, t.progress + 1);
  out.emit({ e: 'ticketProgress', ticketId: t.id, progress: t.progress, target: t.target }, { to: op.id });
  settle(world, op, t, out);
}

/**
 * Raises the completion intent once. Not while travelling: the hand-off rebuilds the operator in the destination
 * world from a checkpoint, which raises it there instead (a completion pending in the source world would be lost).
 */
function settle(world: World, op: Operator, t: OpenTicket, out: Out): void {
  if (t.progress < t.target || t.completing || t.pending || op.travelling) return;
  t.completing = true;
  world.trackIntent({ id: world.newId('i'), kind: 'completeTicket', operatorId: op.id, ticketId: t.id, reward: t.reward }, out);
}

/** Count `ev` against every matching open ticket of `op` (only ever the operator who earned it). */
export function advanceTickets(world: World, op: Operator, ev: TicketEvent, out: Out): void {
  for (const t of op.tickets) if (!t.pending && t.progress < t.target && matches(world, t, ev)) bump(world, op, t, out);
}

/** Per tick: deliveries complete at the destination host (checked in the destination world); complete tickets settle. */
export function checkTickets(world: World, out: Out): void {
  const day = dayKey(world.now());
  for (const op of world.operators.values()) {
    today(world, op, day);
    for (const t of [...op.tickets]) {
      if (t.pending) continue;
      const arrived = t.params.kind === 'deliver' && t.params.to === world.subnet.id && distance(op, world.subnet.host) <= HOST_RADIUS;
      if (arrived && t.progress < t.target && !op.travelling) bump(world, op, t, out);
      else settle(world, op, t, out);
    }
  }
}

export function completeTicketIntent(world: World, op: Operator, intent: TicketIntent, result: IntentResult, out: Out): void {
  const t = op.tickets.find((x) => x.id === intent.ticketId);
  switch (intent.kind) {
    case 'acceptTicket': {
      if (!result.ok) {
        op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
        op.acceptedKeys.delete(ticketKey(intent.day, intent.subnet, intent.index));
        // Only the day it was counted on (a refusal can arrive after midnight).
        if (op.ticketsDay === intent.day) op.ticketsToday = Math.max(0, op.ticketsToday - 1);
        return out.fail(intent, 'E_STATE', result.reason);
      }
      if (t) t.pending = false;
      return out.ok(intent, { ticketId: intent.ticketId });
    }
    case 'abandonTicket': {
      if (!result.ok) {
        if (t) t.pending = false;
        return out.fail(intent, 'E_STATE', result.reason);
      }
      op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
      return out.ok(intent);
    }
    case 'completeTicket': {
      // Either way the row is closed in the store: paid now, or (refused) no longer open, so never paid again here.
      op.tickets = op.tickets.filter((x) => x.id !== intent.ticketId);
      // No ticket on the operator: it was rebuilt from a store record taken after the commit, whose balance already
      // holds the reward (the analogue of `ownsDaemon`), so it is not credited a second time.
      if (!t) return;
      if (!result.ok) {
        // Closed without a payout: tell the operator rather than letting the ticket silently vanish.
        out.emit({ e: 'ticketDone', ticketId: intent.ticketId, reward: 0, unpaid: true }, { to: op.id });
        return;
      }
      op.bits += intent.reward;
      out.emit({ e: 'ticketDone', ticketId: intent.ticketId, reward: intent.reward }, { to: op.id });
      out.emit({ e: 'bits', delta: intent.reward, reason: 'ticket', balance: op.bits }, { to: op.id });
      return;
    }
  }
}
