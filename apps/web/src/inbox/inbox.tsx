'use client';

import type { ConversationDetail, ConversationListItem, TeamMember } from '@app/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, inboxApi } from './api';
import { ContextPane } from './context-pane';
import { displayName, formatPhone, formatTime, groupQueue, queueOrder } from './custody';
import { Queue } from './queue';
import { Thread } from './thread';
import { useInboxSocket } from './use-inbox-socket';

interface Props {
  me: { id: string; name: string; role: 'owner' | 'agent' };
  /** From ?c= on the server, so the first render already shows it (no hydration mismatch). */
  initialSelectedId: string | null;
}

const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous conversation'],
  ['/', 'Search'],
  ['T', 'Take over'],
  ['H', 'Hand back to assistant'],
  ['A', 'Assign to someone'],
  ['C', 'Close'],
  ['N', 'Add internal note'],
  ['E', "Explain the assistant's latest reply"],
  ['Esc', 'Back to the list (narrow screens)'],
  ['?', 'Show these shortcuts'],
];

function message(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function Inbox({ me, initialSelectedId }: Props) {
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [closed, setClosed] = useState<ConversationListItem[]>([]);
  const [listState, setListState] = useState<{ loading: boolean; error: string | null }>({
    loading: true,
    error: null,
  });
  const [scope, setScope] = useState<'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailError, setDetailError] = useState<{ text: string; retry: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Read by async callbacks to drop responses for a conversation no longer open.
  const selectedRef = useRef<string | null>(initialSelectedId);

  // --- data -----------------------------------------------------------------------
  // State is only ever set in the promise callbacks, after the network answers.
  const loadList = useCallback(
    (): Promise<void> =>
      Promise.all([inboxApi.list('open'), inboxApi.list('closed')]).then(
        ([open, done]) => {
          setItems(open);
          setClosed(done);
          setListState({ loading: false, error: null });
        },
        (error: unknown) => {
          setListState({ loading: false, error: `Couldn't load conversations. ${message(error)}` });
        },
      ),
    [],
  );

  const loadDetail = useCallback(
    (id: string): Promise<void> =>
      inboxApi.detail(id).then(
        (next) => {
          if (selectedRef.current !== id) return;
          setDetail(next);
          setDetailError(null);
        },
        (error: unknown) => {
          if (selectedRef.current !== id) return;
          // 404 also covers another business's conversation (row-level security
          // hides it), so retrying cannot help.
          setDetailError(
            error instanceof ApiRequestError && error.status === 404
              ? {
                  text: "This conversation isn't in your inbox. The link may be wrong or for another business. Pick one from the list.",
                  retry: false,
                }
              : { text: message(error), retry: true },
          );
        },
      ),
    [],
  );

  useEffect(() => {
    void loadList();
    void inboxApi.team().then(setTeam, () => {
      setTeam([]);
    });
  }, [loadList]);

  /** Opens a conversation (or none) and resets everything about the previous one. */
  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setActionError(null);
    setConfirmingClose(false);
    setNoteMode(false);
    setSelectedMessageId(null);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set('c', selectedId);
    else url.searchParams.delete('c');
    window.history.replaceState(null, '', url);
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Live updates: refetch what changed, coalescing bursts.
  const pending = useRef<{
    list: boolean;
    detail: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    list: false,
    detail: false,
    timer: null,
  });
  const flush = useCallback(() => {
    const p = pending.current;
    p.timer = null;
    if (p.list) void loadList();
    if (p.detail && selectedRef.current) void loadDetail(selectedRef.current);
    p.list = false;
    p.detail = false;
  }, [loadList, loadDetail]);
  const connection = useInboxSocket({
    onChange: (conversationId) => {
      const p = pending.current;
      p.list = true;
      if (conversationId === selectedRef.current) p.detail = true;
      p.timer ??= setTimeout(flush, 150);
    },
    onReconnect: () => {
      pending.current.list = true;
      pending.current.detail = true;
      flush();
    },
  });

  // --- derived --------------------------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const source = scope === 'open' ? items : closed;
    if (!q) return source;
    return source.filter(
      (i) =>
        displayName(i.customer).toLowerCase().includes(q) ||
        (formatPhone(i.customer.phone) ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        (i.lastMessage?.preview ?? '').toLowerCase().includes(q) ||
        String(i.number).padStart(3, '0').includes(q),
    );
  }, [items, closed, scope, search]);
  const groups = useMemo(
    () => groupQueue(scope === 'open' ? filtered : [], me.id),
    [filtered, scope, me.id],
  );
  const order = useMemo(
    () => (scope === 'open' ? queueOrder(groups) : filtered),
    [groups, filtered, scope],
  );

  // --- actions --------------------------------------------------------------------
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      if (!selectedRef.current) return false;
      setBusy(true);
      setActionError(null);
      try {
        await action();
        const id = selectedRef.current;
        await Promise.all([loadList(), loadDetail(id)]);
        return true;
      } catch (error) {
        setActionError(message(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadList, loadDetail],
  );

  const actions = useMemo(() => {
    const id = () => selectedId ?? '';
    return {
      takeOver: () => void run(() => inboxApi.takeOver(id())),
      handBack: () => void run(() => inboxApi.handBack(id())),
      assign: (userId: string) => void run(() => inboxApi.assign(id(), userId)),
      close: () =>
        void run(() => inboxApi.close(id())).then(() => {
          setConfirmingClose(false);
        }),
      reply: (text: string, voice: boolean) =>
        run(() => inboxApi.reply(id(), voice ? { text, voice: true } : { text })),
      sendTemplate: () => void run(() => inboxApi.reply(id(), { template: 'reopen' })),
      note: (text: string) =>
        run(() => inboxApi.note(id(), text)).then((ok) => {
          if (ok) setNoteMode(false);
          return ok;
        }),
      retry: (messageId: string) => void run(() => inboxApi.retry(messageId)),
      explain: (messageId: string) => {
        setSelectedMessageId(messageId);
        setShowDetails(true);
      },
    };
  }, [run, selectedId]);

  // --- keyboard -------------------------------------------------------------------
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key;
      const move = (delta: number) => {
        if (order.length === 0) return;
        const index = order.findIndex((i) => i.id === selectedRef.current);
        const next = order[Math.min(order.length - 1, Math.max(0, index + delta))] ?? order[0];
        if (!next) return;
        select(next.id);
        document.querySelector<HTMLButtonElement>(`[data-conversation-id="${next.id}"]`)?.focus();
      };
      const state = detail?.state;
      const mine = state === 'human' && detail?.holder?.id === me.id;
      switch (key) {
        case 'j':
          move(1);
          break;
        case 'k':
          move(-1);
          break;
        case '/':
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case '?':
          setShowHelp((v) => !v);
          break;
        case 'Escape':
          setShowHelp(false);
          setShowDetails(false);
          if (!confirmingClose && window.matchMedia('(max-width: 1023px)').matches) select(null);
          setConfirmingClose(false);
          break;
        case 't':
        case 'T':
          if (state === 'assistant' || state === 'waiting_for_human') actions.takeOver();
          break;
        case 'h':
        case 'H':
          if (mine || (me.role === 'owner' && state === 'human')) actions.handBack();
          break;
        case 'a':
        case 'A':
          if (detail && state !== 'closed') {
            event.preventDefault();
            setAssignOpen(true);
          }
          break;
        case 'c':
        case 'C':
          if (detail && state !== 'closed') setConfirmingClose(true);
          break;
        case 'e':
        case 'E': {
          // The latest assistant reply; its receipt opens in the context pane.
          const latest = [...(detail?.timeline ?? [])]
            .reverse()
            .find((e) => e.type === 'message' && e.senderType === 'assistant');
          if (latest) actions.explain(latest.id);
          break;
        }
        case 'n':
        case 'N':
          if (detail && state !== 'closed') {
            event.preventDefault();
            setNoteMode(true);
            setTimeout(() => composerRef.current?.focus(), 0);
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [order, detail, me.id, me.role, actions, confirmingClose, select]);

  // --- layout ---------------------------------------------------------------------
  const paused = connection.status === 'reconnecting';
  return (
    <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col">
      {paused ? (
        <p
          role="status"
          className="mono border-b border-stamp bg-sheet px-4 py-1 text-meta text-stamp"
        >
          Reconnecting… updates paused at {formatTime(connection.since.toISOString(), now)}. The
          list refreshes when the connection is back.
        </p>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_300px]">
        <aside
          aria-label="Conversations"
          className={`min-h-0 border-r border-rule ${selectedId ? 'hidden lg:block' : 'block'}`}
        >
          <Queue
            groups={groups}
            closed={scope === 'closed' ? filtered : []}
            meId={me.id}
            selectedId={selectedId}
            now={now}
            scope={scope}
            search={search}
            searchRef={searchRef}
            loading={listState.loading}
            error={listState.error}
            onSearch={setSearch}
            onScope={setScope}
            onSelect={select}
            onRetry={() => void loadList()}
          />
        </aside>

        <main className={`min-h-0 ${selectedId ? 'block' : 'hidden lg:block'}`}>
          {selectedId ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center gap-3 border-b border-rule bg-sheet px-4 py-2 lg:hidden">
                <button
                  type="button"
                  className="text-label font-semibold underline"
                  onClick={() => {
                    select(null);
                  }}
                >
                  ‹ Inbox
                </button>
                <button
                  type="button"
                  className="ml-auto text-label font-semibold underline"
                  onClick={() => {
                    setShowDetails(true);
                  }}
                >
                  Details
                </button>
              </div>
              {detail ? (
                <div className="min-h-0 flex-1">
                  <Thread
                    detail={detail}
                    meId={me.id}
                    meIsOwner={me.role === 'owner'}
                    team={team}
                    now={now}
                    busy={busy}
                    error={actionError}
                    confirmingClose={confirmingClose}
                    setConfirmingClose={setConfirmingClose}
                    assignOpen={assignOpen}
                    setAssignOpen={setAssignOpen}
                    composerRef={composerRef}
                    noteMode={noteMode}
                    setNoteMode={setNoteMode}
                    actions={actions}
                    selectedMessageId={selectedMessageId}
                  />
                </div>
              ) : detailError ? (
                <div role="alert" className="m-4 border-l-4 border-stamp pl-3 text-stamp">
                  <p>{detailError.text}</p>
                  {detailError.retry ? (
                    <button
                      type="button"
                      className="button button-quiet mt-2"
                      onClick={() => void loadDetail(selectedId)}
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="mono p-4 text-meta text-graphite">Loading conversation…</p>
              )}
            </div>
          ) : (
            <div className="flex h-full items-start gap-3 p-8">
              <span aria-hidden className="custody custody-assistant h-10" />
              <p className="max-w-md text-graphite">
                Pick a conversation from the list, or press <span className="keycap">j</span> to
                start at the top. Whoever has waited longest is first. Press{' '}
                <span className="keycap">?</span> for all shortcuts.
              </p>
            </div>
          )}
        </main>

        <aside
          aria-label="Details"
          className={`min-h-0 border-l border-rule bg-thermal ${
            showDetails
              ? 'fixed inset-0 z-40 block bg-thermal lg:static lg:z-auto'
              : 'hidden lg:block'
          }`}
        >
          {showDetails ? (
            <div className="flex justify-end border-b border-rule px-4 py-2 lg:hidden">
              <button
                type="button"
                className="text-label font-semibold underline"
                onClick={() => {
                  setShowDetails(false);
                }}
              >
                Close details
              </button>
            </div>
          ) : null}
          {detail ? (
            <ContextPane detail={detail} selectedMessageId={selectedMessageId} now={now} />
          ) : (
            <p className="p-4 text-list text-graphite">Customer details appear here.</p>
          )}
        </aside>
      </div>

      {showHelp ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
          className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4 pt-24"
          onClick={() => {
            setShowHelp(false);
          }}
        >
          <div
            className="w-full max-w-sm rounded-control border border-rule-strong bg-sheet p-4"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <h2 id="shortcuts-title" className="text-title font-semibold">
              Keyboard shortcuts
            </h2>
            <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-y-1.5">
              {SHORTCUTS.map(([keys, label]) => (
                <div key={keys} className="contents">
                  <dt className="mono text-meta">{keys}</dt>
                  <dd className="text-list">{label}</dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              autoFocus
              className="button button-quiet mt-4"
              onClick={() => {
                setShowHelp(false);
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
