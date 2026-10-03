import Editor, { loader } from '@monaco-editor/react';
import type { GameClient } from '@daemonet/sdk';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useEffect, useRef, useState } from 'react';
import { useLazyVersionQuery, useSaveScriptMutation, useScriptQuery, useVersionsQuery } from '../api.ts';
import { useConnection } from '../game/connection.ts';
import { start, stop, useSandboxStatus } from '../game/sandbox.ts';
import { SDK_TYPES, STARTER_TEMPLATE } from '../sdk-types.ts';

// Bundle Monaco locally (the CSP forbids the default CDN loader) and give it Vite-built workers:
// its own `new URL('…?esm', import.meta.url)` fallback ends up inlined as a blob whose relative imports break.
self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()) };
loader.config({ monaco });
monaco.typescript.javascriptDefaults.setCompilerOptions({ allowJs: true, checkJs: true, target: monaco.typescript.ScriptTarget.ES2020, module: monaco.typescript.ModuleKind.ESNext, moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs });
monaco.typescript.javascriptDefaults.addExtraLib(SDK_TYPES, 'file:///node_modules/@daemonet/sdk/index.d.ts');

export const AUTOSAVE_MS = 2000;

export function ScriptPanel({ client }: { client: GameClient | null }) {
  const script = useScriptQuery();
  const versions = useVersionsQuery();
  const [save, saveState] = useSaveScriptMutation();
  const [loadVersion] = useLazyVersionQuery();
  const status = useSandboxStatus();
  const conn = useConnection();
  const [source, setSource] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (source === null && script.data) setSource(script.data.source);
  }, [script.data, source]);

  const onChange = (value: string | undefined) => {
    setSource(value ?? '');
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      void save({ source: value ?? '' });
    }, AUTOSAVE_MS);
  };

  if (source === null) return <p className="p-3 text-sm text-neutral-500">loading script…</p>;
  const manual = client?.role === 'controller';
  // the runner refuses to start unless the host socket is up
  const online = conn.status === 'online';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 text-xs">
        <button
          className="rounded bg-emerald-700 px-2 py-0.5 hover:bg-emerald-600 disabled:opacity-40"
          disabled={!client || !manual || !online || status === 'starting' || status === 'running'}
          onClick={() => client && void start(client, source)}
          data-testid="run-script"
        >
          run
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={stop} data-testid="stop-script">
          stop
        </button>
        <span className="mono text-neutral-500" data-testid="script-status">
          {status} · v{script.data?.version ?? 0} {saveState.isLoading ? '· saving…' : dirty.current ? '· unsaved' : '· saved'}
        </span>
        <button className="ml-auto text-neutral-400 hover:text-neutral-200" onClick={() => onChange(STARTER_TEMPLATE)}>
          insert starter template
        </button>
        <select
          className="rounded bg-neutral-800 px-1"
          value=""
          onChange={async (e) => {
            const v = Number(e.target.value);
            if (!v) return;
            const r = await loadVersion(v).unwrap();
            onChange(r.source);
          }}
        >
          <option value="">restore version…</option>
          {(versions.data ?? []).map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {new Date(v.createdAt).toLocaleString()} · {v.bytes} B
            </option>
          ))}
        </select>
      </div>
      {pasteWarning && (
        <div className="bg-amber-900/40 px-2 py-1 text-xs text-amber-200">
          Pasted code runs with your operator's full permissions: it can send any game command as you. Only run code you understand.{' '}
          <button className="underline" onClick={() => setPasteWarning(false)}>
            got it
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1" onPaste={() => setPasteWarning(true)} data-testid="editor">
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme="vs-dark"
          value={source}
          onChange={onChange}
          options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, scrollBeyondLastLine: false }}
        />
      </div>
    </div>
  );
}
