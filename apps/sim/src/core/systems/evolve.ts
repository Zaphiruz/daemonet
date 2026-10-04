import { applyEvolution, computeStats, evolutionOptions, getSpecies, movesAtLevel, statBlockFromArray, statBlockToArray, type EvolutionContext } from '@daemonet/rules';
import { distance } from '../grid.js';
import { Rejection, type Daemon, type HistoryEntry, type Input, type Intent, type IntentResult, type Operator } from '../model.js';
import type { Out } from '../out.js';
import { INTEREST_RADIUS } from '../view.js';
import type { World } from '../world.js';

/** What requirement checks see for `d` right now. */
export function evolutionContext(world: World, op: Operator, d: Daemon): EvolutionContext {
  let unobserved = true;
  for (const other of world.operators.values()) {
    if (other.id !== op.id && distance(other, op) <= INTEREST_RADIUS) {
      unobserved = false;
      break;
    }
  }
  return { subnet: world.subnet.id, unobserved, originalOperator: d.originalOperatorId === op.id, discovered: world.discovered };
}

/**
 * `evolve` command: the daemon must be in RAM and not running, the form must be one of its options with
 * the level reached and every requirement met. The outcome is rolled here and persisted as an intent;
 * the daemon changes only once the store confirms.
 */
export function evolve(world: World, op: Operator, d: Daemon, formId: string, input: Input, out: Out): void {
  if (d.active) throw new Rejection('E_STATE', 'recall the daemon first');
  if (d.pending) throw new Rejection('E_STATE', 'daemon is busy');
  const option = evolutionOptions(d, evolutionContext(world, op, d)).find((o) => o.form === formId);
  if (!option) throw new Rejection('E_INVALID', `${d.species} does not evolve into ${formId}`);
  if (d.level < option.level) throw new Rejection('E_STATE', `needs level ${option.level}`);
  if (!option.met) throw new Rejection('E_STATE', option.revealed ? 'requirement not met' : 'requirement unknown');

  const r = applyEvolution(d, formId, world.rng);
  const at = world.now();
  const history: HistoryEntry[] = [{ at, kind: 'evolved', detail: `${d.species} -> ${formId} at level ${d.level}` }];
  for (const c of r.changes) {
    if (c.kind === 'clean') history.push({ at, kind: 'clean', detail: 'all IVs reached 31 on evolution' });
    if (c.kind === 'signature') history.push({ at, kind: 'signature', detail: `T${c.from} -> T${c.to} (+1 ${c.bonusStat})` });
  }
  const hp = d.hp <= 0 ? 0 : Math.max(1, Math.round((r.maxHp * d.hp) / d.stats.hp));
  d.pending = true;
  world.trackIntent(
    {
      id: world.newId('i'),
      kind: 'evolve',
      operatorId: op.id,
      reqId: input.reqId,
      daemonId: d.id,
      level: d.level,
      from: d.species,
      to: r.species,
      ivs: statBlockToArray(r.ivs),
      bonus: statBlockToArray(r.bonus),
      clean: r.clean,
      signature: r.signature,
      heldItem: r.heldItem,
      moves: r.moves,
      hp,
      changes: r.changes,
      history,
    },
    out,
  );
}

/**
 * Applies a persisted evolution. Idempotent: when the operator left and was reloaded from the store after the
 * intent committed, the daemon is already `intent.to` and is left alone (no second history entry); the reply is
 * still ok. `op` is undefined when the operator has left: the discovery is still recorded and announced.
 */
export function completeEvolveIntent(world: World, op: Operator | undefined, intent: Extract<Intent, { kind: 'evolve' }>, result: IntentResult, out: Out): void {
  const found = world.daemons.get(intent.daemonId);
  const d = op && found?.ownerId === op.id ? found : undefined;
  if (d) d.pending = false;
  if (!result.ok) return op ? out.fail(intent, 'E_STATE', result.reason) : undefined;
  // Every committed evolution into a form leaves its Discovery row, replayed or not.
  world.discovered.add(intent.to);
  if (result.discovered) out.emit({ e: 'discovery', form: intent.to, operator: intent.operatorId, operatorName: op?.name ?? null }, { at: null });
  if (!op) return;
  if (!d || d.species !== intent.from) return out.ok(intent, { species: intent.to, changes: intent.changes });
  const sp = getSpecies(intent.to);
  const liveHp = d.hp;
  const liveMaxHp = d.stats.hp;
  d.species = sp.id;
  d.types = sp.types;
  d.ivs = statBlockFromArray(intent.ivs);
  d.bonus = statBlockFromArray(intent.bonus);
  d.clean = intent.clean;
  d.signature = intent.signature;
  d.heldItem = intent.heldItem;
  d.trait = sp.traits[d.traitSlot];
  d.stats = computeStats({ base: sp.base, ivs: d.ivs, bonus: d.bonus, level: d.level, nature: d.nature });
  if (d.level === intent.level) {
    d.moves = [...intent.moves];
    d.hp = Math.min(intent.hp, d.stats.hp);
  } else {
    // A level-up landed while the evolve was pending: the intent's moves and HP are for the old level, so
    // recompute moves for the new form and carry the live HP fraction (a crashed daemon stays at 0).
    d.moves = movesAtLevel(sp, d.level);
    d.hp = d.crashed || liveHp <= 0 ? 0 : Math.min(d.stats.hp, Math.max(1, Math.round((d.stats.hp * liveHp) / liveMaxHp)));
  }
  d.cooldowns = {};
  d.history.push(...intent.history);
  out.emit({ e: 'evolved', daemon: d.id, from: intent.from, to: intent.to, changes: intent.changes }, { to: op.id });
  return out.ok(intent, { species: d.species, changes: intent.changes });
}
