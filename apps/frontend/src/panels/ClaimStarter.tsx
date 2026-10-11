import { getSpecies } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useState } from 'react';
import { log } from '../game/log.ts';

export const STARTERS = ['pingling', 'hashling', 'glitchmite', 'nullpup'] as const;

const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A name the sim's filter accepts (a-z 0-9 _ -): the starter plus four random characters. */
export function defaultOperatorName(species: string, rand: () => number = Math.random): string {
  let tail = '';
  for (let i = 0; i < 4; i++) tail += NAME_ALPHABET[Math.floor(rand() * NAME_ALPHABET.length)];
  return `${species}-${tail}`;
}

/**
 * The only thing an unclaimed operator can do. The name is prefilled with a suggestion that follows the starter
 * pick until the player types their own; an emptied field falls back to it, so a claim is never sent nameless.
 * A refusal is shown under the button as well as in the Log.
 */
export function ClaimStarter({ client }: { client: GameClient }) {
  const manual = client.role === 'controller';
  const [starter, setStarter] = useState<string>(STARTERS[0]);
  const [suggested, setSuggested] = useState(() => defaultOperatorName(STARTERS[0]));
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const name = (typed ?? suggested).trim() || suggested;

  const pick = (species: string) => {
    setStarter(species);
    if (typed === null || typed.trim() === '') setSuggested(defaultOperatorName(species));
  };
  const claim = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await client.operator.claimStarter(starter, name);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'refused';
      setRefusal(reason);
      log.push('reject', `claimStarter: ${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 p-3 text-sm" data-testid="claim-starter">
      <p className="text-neutral-300">Claim a starter to enter the network.</p>
      <input className="w-full rounded bg-neutral-800 px-2 py-1" placeholder="operator name (a-z 0-9 _ -)" value={typed ?? suggested} onChange={(e) => setTyped(e.target.value)} data-testid="name-input" />
      <select className="w-full rounded bg-neutral-800 px-2 py-1" value={starter} onChange={(e) => pick(e.target.value)} data-testid="starter-select">
        {STARTERS.map((s) => (
          <option key={s} value={s}>
            {getSpecies(s).name}
          </option>
        ))}
      </select>
      <button className="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600 disabled:opacity-50" disabled={!manual || busy} onClick={() => void claim()} data-testid="claim">
        {busy ? 'claiming…' : 'claim'}
      </button>
      {!manual && <p className="text-neutral-500">only the controlling session can claim</p>}
      {refusal && (
        <p className="text-red-400" role="alert" data-testid="claim-refusal">
          {refusal}
        </p>
      )}
    </div>
  );
}
