import type { ErrorCode, GameEvent } from '@daemonet/shared';
import type { Point } from './grid.js';
import type { Intent, Reply, ScopedEvent } from './model.js';

/** Collects everything a step (or an intent completion) produces. */
export class Out {
  readonly events: ScopedEvent[] = [];
  readonly replies: Reply[] = [];
  readonly intents: Intent[] = [];

  /** Private to `to`, or public near `at` (null = everyone). */
  emit(event: GameEvent, scope: { to: string } | { at: Point | null }): void {
    this.events.push('to' in scope ? { event, to: scope.to, at: null } : { event, to: null, at: scope.at ? { x: scope.at.x, y: scope.at.y } : null });
  }

  ok(req: { operatorId: string; reqId: string }, result?: unknown): void {
    this.replies.push(result === undefined ? { operatorId: req.operatorId, reqId: req.reqId, ok: true } : { operatorId: req.operatorId, reqId: req.reqId, ok: true, result });
  }

  fail(req: { operatorId: string; reqId: string }, code: ErrorCode, message: string): void {
    this.replies.push({ operatorId: req.operatorId, reqId: req.reqId, ok: false, code, message });
  }

  intent(intent: Intent): void {
    this.intents.push(intent);
  }
}
