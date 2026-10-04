import { lazy, Suspense, useEffect, useState } from 'react';
import { useMeQuery } from './api.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { TopBar } from './components/TopBar.tsx';
import { WorldCanvas } from './components/WorldCanvas.tsx';
import { open, useConnection } from './game/connection.ts';
import { CodexPanel, ItemsPanel } from './panels/CodexPanel.tsx';
import { IncidentsPanel } from './panels/IncidentsPanel.tsx';
import { AdminPanel } from './panels/AdminPanel.tsx';
import { ChatPanel } from './panels/ChatPanel.tsx';
import { DiskPanel } from './panels/DiskPanel.tsx';
import { HostPanel } from './panels/HostPanel.tsx';
import { OrgPanel } from './panels/OrgPanel.tsx';
import { LogPanel } from './panels/LogPanel.tsx';
import { PlayPanel } from './panels/PlayPanel.tsx';
import { RamPanel } from './panels/RamPanel.tsx';

// Monaco is big: load it (and its workers) only when the Script tab is first opened, never on the login page.
const ScriptPanel = lazy(() => import('./panels/ScriptPanel.tsx'));

const TABS = ['play', 'ram', 'disk', 'host', 'items', 'codex', 'chat', 'org', 'incidents', 'script', 'log', 'admin'] as const;
type Tab = (typeof TABS)[number];

export function Login() {
  const dev = import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const [name, setName] = useState('alice');
  return (
    <main className="grid h-full place-items-center">
      <div className="w-80 space-y-3 rounded border border-neutral-800 p-6">
        <h1 className="text-xl font-semibold text-sky-300">daemonet</h1>
        <p className="text-sm text-neutral-400">Sign in to enter the network.</p>
        <a className="block rounded bg-sky-700 px-3 py-2 text-center hover:bg-sky-600" href="/api/auth/login">
          Sign in with Authentik
        </a>
        {dev && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              location.href = `/api/auth/dev?name=${encodeURIComponent(name)}`;
            }}
          >
            <input className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} data-testid="dev-name" />
            <button className="rounded bg-neutral-700 px-2 text-sm" data-testid="dev-login">
              dev login
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export function App() {
  const me = useMeQuery();
  const conn = useConnection();
  const [tab, setTab] = useState<Tab>('play');
  // auto-open only from `idle`: kicked / failed are terminal and must not loop
  useEffect(() => {
    if (me.data && conn.status === 'idle') void open('controller').catch(() => {});
  }, [me.data, conn.status]);

  if (me.isLoading) return <p className="p-4 text-neutral-500">loading…</p>;
  if (me.isError || !me.data) return <Login />;
  const client = conn.client;
  const isAdmin = me.data.isAdmin === true;
  const tabs = TABS.filter((t) => t !== 'admin' || isAdmin);
  const ended = conn.status === 'kicked' || conn.status === 'failed';
  return (
    <div className="flex h-full flex-col">
      <TopBar me={me.data} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {client ? (
            <ErrorBoundary label="world view">
              <WorldCanvas />
            </ErrorBoundary>
          ) : (
            <p className="p-4 text-neutral-500" data-testid="connection-note">
              {ended ? `${conn.status}${conn.kickReason ? `: ${conn.kickReason}` : ''}` : `${conn.status}…`}
              {ended && conn.status === 'failed' && (
                <>
                  {' '}
                  <a className="underline" href="/api/auth/login">
                    sign in again
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-neutral-800">
          <nav className="flex border-b border-neutral-800 text-xs">
            {tabs.map((t) => (
              <button key={t} className={`flex-1 py-1.5 uppercase tracking-wide ${tab === t ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
                {t}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto">
            <ErrorBoundary key={tab} label={`${tab} panel`}>
            {tab === 'play' && (client?.self ? <PlayPanel client={client} /> : <p className="p-3 text-sm text-neutral-500">connecting…</p>)}
            {tab === 'ram' && client?.self && <RamPanel client={client} />}
            {tab === 'disk' && client?.self && <DiskPanel client={client} />}
            {tab === 'host' && client?.self && <HostPanel client={client} />}
            {tab === 'items' && client?.self && <ItemsPanel inventory={client.self.inventory} />}
            {tab === 'codex' && <CodexPanel />}
            {tab === 'chat' && (client?.self ? <ChatPanel client={client} isAdmin={isAdmin} /> : <p className="p-3 text-sm text-neutral-500">connecting…</p>)}
            {tab === 'org' && (client?.self ? <OrgPanel client={client} /> : <p className="p-3 text-sm text-neutral-500">connecting…</p>)}
            {tab === 'incidents' && <IncidentsPanel />}
            {tab === 'admin' && isAdmin && <AdminPanel />}
            {tab === 'script' && (
                <Suspense fallback={<p className="p-3 text-sm text-neutral-500">loading editor…</p>}>
                  <ScriptPanel client={client} />
                </Suspense>
              )}
            {tab === 'log' && <LogPanel />}
            </ErrorBoundary>
          </div>
        </aside>
      </div>
    </div>
  );
}
