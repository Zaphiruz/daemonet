import { CHAT_INTERVAL_MS, CHAT_MAX_CHARS } from '@daemonet/rules';
import type { GameClient } from '@daemonet/sdk';
import { useEffect, useRef, useState } from 'react';
import { describeApiError, useAdminDeleteMessageMutation, useAdminMuteMutation, useLazyChatHistoryQuery, useReportMutation } from '../api.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { run } from '../components/WorldCanvas.tsx';
import { chatStore, useChat, type ChatLine } from '../game/chat.ts';
import { log } from '../game/log.ts';
import { ClusterPanel } from './ClusterPanel.tsx';

const REASONS = ['SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER'] as const;
/** What the API accepts as the id part of a DM channel. */
const OPERATOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Report dialog for a chat line or an operator (SP4 spec §5.2): the reporter only ever sees "report received". */
export function ReportButton({ targetId, messageId, label = 'report' }: { targetId: string; messageId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('SPAM');
  const [note, setNote] = useState('');
  const [report, state] = useReportMutation();
  if (!open) {
    return (
      <button className="ml-1 text-[10px] text-neutral-600 hover:text-red-300" onClick={() => setOpen(true)} data-testid={`report-${messageId ?? targetId}`}>
        {label}
      </button>
    );
  }
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-[10px]">
      <select className="rounded bg-neutral-800 px-1" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])} aria-label="report reason">
        {REASONS.map((r) => (
          <option key={r} value={r}>
            {r.toLowerCase()}
          </option>
        ))}
      </select>
      <input className="w-24 rounded bg-neutral-800 px-1" placeholder="note" maxLength={256} value={note} onChange={(e) => setNote(e.target.value)} aria-label="report note" />
      <button
        className="rounded bg-red-900 px-1 hover:bg-red-800"
        disabled={state.isLoading}
        onClick={async () => {
          try {
            // a duplicate report is acknowledged the same way; the reporter never learns what became of it
            await report({ targetId, ...(messageId ? { messageId } : {}), reason, note }).unwrap();
            log.push('system', 'report received');
          } catch (err) {
            log.push('error', `report not sent: ${describeApiError(err)}`);
          }
          setOpen(false);
        }}
        data-testid="report-send"
      >
        send
      </button>
      <button className="text-neutral-500" onClick={() => setOpen(false)}>
        cancel
      </button>
    </span>
  );
}

export function ChatPanel({ client, isAdmin }: { client: GameClient; isAdmin: boolean }) {
  const chat = useChat();
  const subnetChannel = `subnet:${client.subnet}`;
  const [picked, setPicked] = useState<string | null>(null);
  // the subnet channel follows the current world (travel); other subnets' lines stay in the store but are not shown
  // a cluster channel exists only while you are a member (lines of a cluster you left stay in the store, hidden)
  const channels = [...new Set([...client.chat.channels, ...[...chat.lines.keys()].filter((c) => !c.startsWith('subnet:') && !c.startsWith('cluster:')), ...(picked?.startsWith('dm:') ? [picked] : [])])];
  const active = picked !== null && channels.includes(picked) ? picked : subnetChannel;
  const [text, setText] = useState('');
  const [dm, setDm] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [loadHistory] = useLazyChatHistoryQuery();
  const listRef = useRef<HTMLDivElement>(null);
  const manual = client.role === 'controller';
  const lines = chat.lines.get(active) ?? [];
  /** Channels whose history has been paged back to the start (an older page came back empty). */
  const [exhausted, setExhausted] = useState<ReadonlySet<string>>(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pagesHistory = active.startsWith('subnet:') || active.startsWith('dm:');

  useEffect(() => {
    chatStore.setActive(active);
    // cluster history is live-only and org history is not served yet
    if (!active.startsWith('subnet:') && !active.startsWith('dm:')) return;
    let stale = false;
    loadHistory({ channel: active })
      .unwrap()
      .then((rows) => {
        if (!stale) chatStore.history(active, rows as ChatLine[]);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // a transparent reconnect refetches too: lines sent while the socket was down only exist in the history
  }, [active, loadHistory, chat.reconnects]);
  // lines only count as unread while the panel is closed or on another channel
  useEffect(() => () => chatStore.setActive(''), []);
  // follow the newest line (loading older lines must not jump to the bottom)
  const newest = lines.at(-1)?.id;
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [newest, active]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 250)), 250);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** Fetches the page before the oldest line held, by the API's (at, id) cursor. */
  const loadOlder = () => {
    const oldest = lines[0];
    if (!oldest || loadingOlder) return;
    const channel = active;
    setLoadingOlder(true);
    loadHistory({ channel, before: oldest.at, beforeId: oldest.id })
      .unwrap()
      .then((rows) => {
        if (rows.length === 0) setExhausted((s) => new Set(s).add(channel));
        else chatStore.history(channel, rows as ChatLine[]);
      })
      .catch((err: unknown) => log.push('error', `older chat not loaded: ${describeApiError(err)}`))
      .finally(() => setLoadingOlder(false));
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    run(client.chat.send(active, t), 'chat');
    setText('');
    setCooldown(CHAT_INTERVAL_MS);
  };
  const muted = chat.mutedUntil !== null && Date.parse(chat.mutedUntil) > Date.now();

  return (
    <div className="flex h-full flex-col text-xs">
      <ErrorBoundary label="cluster panel">
        <ClusterPanel client={client} />
      </ErrorBoundary>
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-1">
        {channels.map((c) => (
          <button key={c} className={`rounded px-1.5 py-0.5 ${active === c ? 'bg-neutral-800 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`} onClick={() => setPicked(c)} data-testid={`channel-${c}`}>
            {c}
            {chat.unread.get(c) ? <span className="ml-1 rounded bg-sky-800 px-1 text-[10px]">{chat.unread.get(c)}</span> : null}
          </button>
        ))}
        <form
          className="ml-auto flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const id = dm.trim();
            if (id && id !== client.operatorId && OPERATOR_ID.test(id)) setPicked(`dm:${id}`);
            else if (id) log.push('error', 'not a valid operator id for a direct message');
            setDm('');
          }}
        >
          <input className="w-28 rounded bg-neutral-900 px-1" placeholder="dm operator id" value={dm} onChange={(e) => setDm(e.target.value)} data-testid="chat-dm" />
        </form>
      </div>
      <div ref={listRef} className="mono min-h-0 flex-1 overflow-auto p-2" data-testid="chat-lines">
        {lines.length === 0 && <p className="text-neutral-600">nothing yet</p>}
        {pagesHistory && lines.length > 0 && !exhausted.has(active) && (
          <button className="mb-1 text-[10px] text-neutral-500 hover:text-neutral-300 disabled:opacity-40" disabled={loadingOlder} onClick={loadOlder} data-testid="chat-older">
            older lines
          </button>
        )}
        {lines.map((l) => (
          <div key={l.id} className="group break-words">
            <span className="text-neutral-600">{new Date(l.at).toLocaleTimeString()}</span>{' '}
            <span className={l.from === client.operatorId ? 'text-sky-300' : 'text-neutral-300'}>
              {l.tag ? `[${l.tag}] ` : ''}
              {l.name ?? l.from.slice(0, 8)}
            </span>
            : <span className="text-neutral-100">{l.text}</span>
            {l.from !== client.operatorId && <ReportButton targetId={l.from} messageId={l.id} />}
            {isAdmin && <AdminLineActions line={l} />}
          </div>
        ))}
      </div>
      <form
        className="flex gap-1 border-t border-neutral-800 p-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!manual || muted || cooldown > 0) return;
          send();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1"
          placeholder={muted ? `muted until ${new Date(chat.mutedUntil!).toLocaleTimeString()}` : `message ${active}`}
          maxLength={CHAT_MAX_CHARS}
          value={text}
          disabled={!manual || muted}
          onChange={(e) => setText(e.target.value)}
          data-testid="chat-input"
        />
        <button className="rounded bg-sky-800 px-2 hover:bg-sky-700 disabled:opacity-40" disabled={!manual || muted || cooldown > 0 || !text.trim()} data-testid="chat-send">
          {cooldown > 0 ? `${(cooldown / 1000).toFixed(1)}s` : 'send'}
        </button>
      </form>
    </div>
  );
}

/** Moderation on a line (admins only): delete it for everyone, or mute its author for 30 minutes. Failures go to the Log. */
function AdminLineActions({ line }: { line: ChatLine }) {
  const [del] = useAdminDeleteMessageMutation();
  const [mute] = useAdminMuteMutation();
  return (
    <span className="ml-1 hidden gap-1 text-[10px] group-hover:inline-flex">
      <button
        className="text-amber-400"
        onClick={() =>
          void del(line.id)
            .unwrap()
            .catch((err: unknown) => log.push('error', `delete failed: ${describeApiError(err)}`))
        }
        data-testid={`admin-delete-${line.id}`}
      >
        delete
      </button>
      <button
        className="text-amber-400"
        onClick={() =>
          void mute({ operatorId: line.from, minutes: 30 })
            .unwrap()
            .catch((err: unknown) => log.push('error', `mute failed: ${describeApiError(err)}`))
        }
        data-testid={`admin-mute-${line.id}`}
      >
        mute 30m
      </button>
    </span>
  );
}
