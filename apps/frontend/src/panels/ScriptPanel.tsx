import Editor, { loader } from '@monaco-editor/react';
import type { GameClient } from '@daemonet/sdk';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import { useLazyVersionQuery, useSaveScriptMutation, useScriptQuery, useVersionsQuery } from '../api.ts';
import { log } from '../game/log.ts';
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

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = { minimap: { enabled: false }, fontSize: 13, tabSize: 2, scrollBeyondLastLine: false };

/** A readable reason for a failed save (an RTK Query error is `{ status, data }`, `{ status: 'FETCH_ERROR', error }` or an Error). */
export function saveFailureReason(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 413) return 'script too large (max 256 KiB)';
  if (status === 401) return 'signed out';
  if (typeof status === 'number') return `HTTP ${status}`;
  const detail = (err as { error?: unknown; message?: unknown } | null)?.error ?? (err as { message?: unknown } | null)?.message;
  if (typeof status === 'string') return typeof detail === 'string' ? `${status}: ${detail}` : status;
  return typeof detail === 'string' ? detail : 'request failed';
}

export function ScriptPanel({ client }: { client: GameClient | null }) {
  const script = useScriptQuery();
  const versions = useVersionsQuery();
  const [save, saveState] = useSaveScriptMutation();
  const [loadVersion] = useLazyVersionQuery();
  const status = useSandboxStatus();
  const conn = useConnection();
  const [source, setSource] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState(false);
  // `dirty` is true from the first edit until a save that covers it resolves (state for the status line, ref for the effect)
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  };
  /** Bumped by every edit: a save only clears `dirty` if nothing was typed since it was sent. */
  const editSeq = useRef(0);
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seenVersion = useRef<number | null>(null);
  // adopt fresh server data (first load, or a newer version) unless the editor holds unsaved edits or a save is in flight
  useEffect(() => {
    const d = script.data;
    if (!d || d.version === seenVersion.current) return;
    if (source === null || (!dirtyRef.current && inFlight.current === 0)) {
      seenVersion.current = d.version;
      setSource(d.source);
    }
  }, [script.data, source, dirty, saveState.isLoading]);

  const send = (value: string, seq: number) => {
    inFlight.current++;
    save({ source: value })
      .unwrap()
      .then((r) => {
        seenVersion.current = Math.max(seenVersion.current ?? 0, r.version);
        if (editSeq.current === seq) setDirty(false);
      })
      .catch((err: unknown) => {
        setDirty(true);
        log.push('error', `autosave failed: ${saveFailureReason(err)}`);
      })
      .finally(() => {
        inFlight.current--;
      });
  };

  const onChange = (value: string | undefined) => {
    setSource(value ?? '');
    setDirty(true);
    const seq = ++editSeq.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => send(value ?? '', seq), AUTOSAVE_MS);
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
          onClick={() => client && start(client, source).catch((err: Error) => log.push('error', `script not started: ${err.message}`))}
          data-testid="run-script"
        >
          run
        </button>
        <button className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700" onClick={stop} data-testid="stop-script">
          stop
        </button>
        <span className="mono text-neutral-500" data-testid="script-status">
          {status} · v{script.data?.version ?? 0} {saveState.isLoading ? '· saving…' : saveState.isError ? '· save failed' : dirty ? '· unsaved' : '· saved'}
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
            try {
              const r = await loadVersion(v).unwrap();
              onChange(r.source);
            } catch (err) {
              log.push('error', `could not load version ${v}: ${err instanceof Error ? err.message : 'request failed'}`);
            }
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
          options={EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
}

export default ScriptPanel;
