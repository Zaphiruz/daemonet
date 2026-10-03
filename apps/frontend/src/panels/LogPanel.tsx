import { useState } from 'react';
import { log, useLog, type LogKind } from '../game/log.ts';

const COLORS: Record<LogKind, string> = { event: 'text-neutral-200', script: 'text-sky-300', error: 'text-red-400', reject: 'text-amber-400', system: 'text-neutral-500' };

export function LogPanel() {
  const entries = useLog();
  const [filter, setFilter] = useState<LogKind | 'all'>('all');
  const shown = entries.filter((e) => filter === 'all' || e.kind === filter).slice(-200);
  return (
    <div className="flex h-full flex-col p-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        {(['all', 'event', 'script', 'reject', 'error', 'system'] as const).map((k) => (
          <button key={k} className={`rounded px-1 ${filter === k ? 'bg-neutral-700' : 'bg-neutral-900'}`} onClick={() => setFilter(k)}>
            {k}
          </button>
        ))}
        <button className="ml-auto text-neutral-500" onClick={() => log.clear()}>
          clear
        </button>
      </div>
      <div className="mono flex-1 overflow-auto" data-testid="log">
        {shown.map((e) => (
          <div key={e.id} className={COLORS[e.kind]}>
            <span className="text-neutral-600">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
