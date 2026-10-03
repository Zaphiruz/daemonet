import type { ToolId } from '@daemonet/rules';
import { Rejection, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import type { World } from '../world.js';

/** Stubs until Task 6. */
export function startCapture(_world: World, _op: Operator, _args: { targetId: string; tool: ToolId }, _out: Out): string {
  throw new Rejection('E_STATE', 'capture is not implemented yet');
}

export function submitCapture(_world: World, _op: Operator, _args: { captureId: string; answer?: unknown }, _out: Out): 'correct' | 'wrong' {
  throw new Rejection('E_STATE', 'capture is not implemented yet');
}

export function completeCaptureIntent(_world: World, _op: Operator, _intent: Extract<Intent, { kind: 'capture' }>, _result: IntentResult, _out: Out): void {}

export function progressCaptures(_world: World, _out: Out): void {}
