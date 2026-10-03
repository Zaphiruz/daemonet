import { challengeSize, getTool, type PublicChallenge } from '@daemonet/rules';
import type { GameEvent } from '@daemonet/shared';
import { describe, expect, it } from 'vitest';
import type { StepResult, World } from '../src/core/index.js';
import { solve } from '../../../packages/rules/test/solvers.js';
import { idle, input, makeWorld, operatorRecord, placeWild, self, step } from './helpers.js';

type CaptureStart = Extract<GameEvent, { e: 'captureStart' }>;
type CaptureResult = Extract<GameEvent, { e: 'captureResult' }>;

const find = <E extends GameEvent['e']>(results: StepResult[], e: E) =>
  results.flatMap((r) => r.events).map((x) => x.event).find((ev): ev is Extract<GameEvent, { e: E }> => ev.e === e);

function setup(): { world: World; wildId: string } {
  const world = makeWorld();
  world.addOperator(operatorRecord('alice'));
  const wild = placeWild(world, 'bitrot', 5, 7.5, 5.5);
  return { world, wildId: wild.id };
}

function start(world: World, wildId: string, tool: 'sniff' | 'mirror' | 'dump' = 'mirror'): CaptureStart {
  const r = step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool } }));
  expect(r.replies[0]).toMatchObject({ ok: true });
  return find([r], 'captureStart')!;
}

const submit = (world: World, captureId: string, answer: unknown) =>
  step(world, input('alice', { cmd: 'submitCapture', actor: self, args: { captureId, answer } }));

describe('capture', () => {
  it('a correct answer commits via an intent, then lands in RAM', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    expect(world.operators.get('alice')!.inventory.mirror).toBe(1);
    const r = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    expect(r.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(world.daemons.has(wildId)).toBe(false);
    const intent = r.intents.find((i) => i.kind === 'capture')!;
    expect(intent).toMatchObject({ kind: 'capture', location: 'RAM', tool: 'mirror', log: { originalOperatorId: 'alice', subnet: 'test' } });
    world.completeIntent(intent.id, { ok: true });
    const done = find([step(world)], 'captureResult')!;
    expect(done).toMatchObject({ ok: true, daemon: { species: 'bitrot', slot: 2 } });
    expect(world.operators.get('alice')!.ram).toHaveLength(3);
  });

  it('a wrong answer fails, hardens the target and doubles the next challenge size', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    // Bitrot is Glitch-type, so the answer shape is { hex }; this one is well-formed but wrong.
    const r = submit(world, ev.captureId, { hex: '00' });
    expect(r.replies[0]).toMatchObject({ ok: true, result: { status: 'wrong' } });
    expect(find([r], 'captureResult')).toMatchObject({ ok: false, reason: 'wrong_answer' });
    const wild = world.daemons.get(wildId)!;
    expect(wild.wild!.hardenedUntil).toBeGreaterThan(world.tick);
    const base = { stage: 0, hpFraction: 1, clean: false, signature: 0, statused: false };
    expect(challengeSize({ ...base, hardened: true }, getTool('mirror'))).toBe(2 * challengeSize({ ...base, hardened: false }, getTool('mirror')));
  });

  it('a malformed answer is E_INVALID and leaves the capture open', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    expect(submit(world, ev.captureId, { nope: 1 }).replies[0]).toMatchObject({ ok: false, code: 'E_INVALID' });
    expect(world.captures.get(ev.captureId)?.state).toBe('open');
    const second = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    expect(second.replies[0]).toMatchObject({ ok: true, result: { status: 'correct' } });
    expect(submit(world, ev.captureId, { checksum: '00000000' }).replies[0]).toMatchObject({ ok: false, code: 'E_STATE' });
  });

  it('times out after the tool deadline', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId, 'sniff');
    const results = idle(world, 40);
    expect(find(results, 'captureResult')).toMatchObject({ captureId: ev.captureId, ok: false, reason: 'timeout' });
  });

  it('fails with packet loss when the operator leaves tool range', () => {
    const { world, wildId } = setup();
    start(world, wildId, 'sniff');
    step(world, input('alice', { cmd: 'moveTo', actor: self, args: { x: 5.5, y: 12.5 } }));
    const results = idle(world, 16);
    expect(find(results, 'captureResult')).toMatchObject({ ok: false, reason: 'packet_loss' });
  });

  it('fails with packet loss when the operator is hit', () => {
    const { world, wildId } = setup();
    start(world, wildId);
    const wild = world.daemons.get(wildId)!;
    wild.wild!.aggro = 'alice';
    const results = idle(world, 32);
    const res = find(results, 'captureResult') as CaptureResult | undefined;
    expect(res).toMatchObject({ ok: false, reason: 'packet_loss' });
  });

  it('refuses targets tagged by another operator and out-of-range targets', () => {
    const { world, wildId } = setup();
    world.addOperator(operatorRecord('bob'));
    const wild = world.daemons.get(wildId)!;
    wild.wild!.tagOwner = 'bob';
    wild.wild!.tagUntil = 10_000;
    expect(step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool: 'mirror' } })).replies[0]).toMatchObject({ code: 'E_STATE' });
    wild.wild!.tagOwner = null;
    wild.x = 20.5;
    wild.y = 28.5;
    expect(step(world, input('alice', { cmd: 'capture', actor: self, args: { targetId: wildId, tool: 'mirror' } })).replies[0]).toMatchObject({ code: 'E_RANGE' });
  });

  it('goes to Disk when RAM is full, and a persist failure refunds the tool', () => {
    const { world, wildId } = setup();
    const op = world.operators.get('alice')!;
    for (let s = 2; s < 8; s++) op.reservedSlots.add(s);
    const ev = start(world, wildId);
    const r = submit(world, ev.captureId, solve(ev.challenge as PublicChallenge));
    const intent = r.intents.find((i) => i.kind === 'capture')!;
    expect(intent).toMatchObject({ location: 'DISK' });
    world.completeIntent(intent.id, { ok: false, reason: 'db down' });
    expect(find([step(world)], 'captureResult')).toMatchObject({ ok: false, reason: 'persist_failed' });
    expect(op.inventory.mirror).toBe(2);
    expect(op.diskSlots.size).toBe(0);
  });

  it('fails with packet loss when the target is defeated mid-capture, and clears the capture', () => {
    const { world, wildId } = setup();
    const ev = start(world, wildId);
    world.daemons.get(wildId)!.hp = 0;
    const results = idle(world, 2);
    expect(find(results, 'captureResult')).toMatchObject({ captureId: ev.captureId, ok: false, reason: 'packet_loss' });
    expect(world.captures.size).toBe(0);
    expect(world.operators.get('alice')!.captureId).toBeNull();
  });

  it('sending the operator home mid-capture drops the capture without error', () => {
    const { world, wildId } = setup();
    start(world, wildId);
    world.removeOperator('alice');
    expect(world.captures.size).toBe(0);
    expect(() => idle(world, 3)).not.toThrow();
    expect(world.daemons.get(wildId)).toBeDefined();
  });
});
