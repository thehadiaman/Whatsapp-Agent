'use client';

import {
  KNOWLEDGE_FILE_EXTENSIONS,
  MAX_KNOWLEDGE_UPLOAD_MB,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type RetrievedPassageView,
} from '@app/shared';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useRef, useState } from 'react';
import { messageOf } from '../lib/client-api';
import { knowledgeApi } from './api';

type Filter = 'all' | 'faq' | 'file' | 'catalogue';
type Pane =
  { kind: 'try' } | { kind: 'source'; id: string } | { kind: 'faq-form'; editing: string | null };

interface Props {
  isOwner: boolean;
  initialSourceId: string | null;
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const day = (iso: string) => dayFormat.format(new Date(iso));

const STATUS: Record<KnowledgeSource['status'], { word: string; className: string }> = {
  queued: { word: 'Queued', className: 'text-ink' },
  reading: { word: 'Reading…', className: 'text-ink' },
  ready: { word: 'Ready', className: 'text-graphite' },
  failed: { word: 'Failed', className: 'text-stamp' },
};

function sizeText(bytes: number | null): string | null {
  if (bytes === null) return null;
  return bytes < 1024 * 1024
    ? `${String(Math.ceil(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function summary(source: KnowledgeSource): string {
  if (source.status === 'failed') return source.error ?? 'Could not be read.';
  if (source.status !== 'ready')
    return `${source.kind === 'faq' ? 'FAQ' : 'File'} · ${day(source.updatedAt)}`;
  if (source.kind === 'catalogue') {
    return `${String(source.unitCount ?? source.passageCount)} products · ${day(source.updatedAt)}`;
  }
  if (source.kind === 'faq') return source.answer ?? '';
  const pages = source.unitCount ? ` · ${plural(source.unitCount, 'page')}` : '';
  return `${plural(source.passageCount, 'passage')}${pages} · ${day(source.updatedAt)}`;
}

/** The knowledge base: what the assistant may answer from (DESIGN.md §4, "Knowledge base"). */
export function Knowledge({ isOwner, initialSourceId }: Props) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [listState, setListState] = useState<{ loading: boolean; error: string | null }>({
    loading: true,
    error: null,
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [pane, setPane] = useState<Pane>(
    initialSourceId ? { kind: 'source', id: initialSourceId } : { kind: 'try' },
  );
  const [detail, setDetail] = useState<KnowledgeSourceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Read by async callbacks to drop answers for a source no longer open.
  const openId = useRef<string | null>(initialSourceId);

  const loadList = useCallback(
    () =>
      knowledgeApi.list().then(
        (next) => {
          setSources(next);
          setListState({ loading: false, error: null });
        },
        (error: unknown) => {
          setListState({
            loading: false,
            error: `Couldn't load the knowledge base. ${messageOf(error)}`,
          });
        },
      ),
    [],
  );

  const loadDetail = useCallback(
    (id: string) =>
      knowledgeApi.detail(id).then(
        (next) => {
          if (openId.current !== id) return;
          setDetail(next);
          setDetailError(null);
        },
        (error: unknown) => {
          if (openId.current === id) setDetailError(messageOf(error));
        },
      ),
    [],
  );

  useEffect(() => {
    void loadList();
    if (initialSourceId) void loadDetail(initialSourceId);
  }, [loadList, loadDetail, initialSourceId]);

  // While anything is being read, refresh until it settles.
  const pending = sources.some((s) => s.status === 'queued' || s.status === 'reading');
  const openPending =
    pane.kind === 'source' && sources.some((s) => s.id === pane.id && s.status !== detail?.status);
  useEffect(() => {
    if (!pending && !openPending) return;
    const timer = setTimeout(() => {
      void loadList();
      if (openId.current) void loadDetail(openId.current);
    }, 1_500);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, openPending, sources, loadList, loadDetail]);

  const open = (next: Pane) => {
    openId.current = next.kind === 'source' ? next.id : null;
    setPane(next);
    setConfirmRemove(false);
    setActionError(null);
    if (next.kind === 'source') {
      setDetail(null);
      setDetailError(null);
      void loadDetail(next.id);
    }
  };

  const act = async (work: () => Promise<{ id: string } | null>) => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await work();
      await loadList();
      if (result) open({ kind: 'source', id: result.id });
      else open({ kind: 'try' });
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const faqs = sources.filter((s) => s.kind === 'faq');
  const files = sources.filter((s) => s.kind === 'file');
  const catalogues = sources.filter((s) => s.kind === 'catalogue');
  const shown =
    filter === 'all' ? [...files, ...catalogues] : sources.filter((s) => s.kind === filter);
  const selectedId = pane.kind === 'source' ? pane.id : null;
  const detailOpen = pane.kind !== 'try';

  return (
    <div className="grid h-[calc(100dvh-3rem)] min-h-0 grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]">
      <aside
        aria-label="Knowledge sources"
        className={`min-h-0 flex-col border-r border-rule ${detailOpen ? 'hidden lg:flex' : 'flex'}`}
      >
        <div className="space-y-2 border-b border-rule p-3">
          <div className="flex items-center gap-2">
            <h1 className="display text-pane">Knowledge</h1>
            {isOwner ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="button button-quiet ml-auto" disabled={busy}>
                    Add source ▾
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-50 min-w-64 rounded-control border border-rule-strong bg-sheet p-1 shadow-[0_6px_20px_rgb(24_32_46_/_0.15)]"
                  >
                    <DropdownMenu.Item
                      onSelect={() => {
                        open({ kind: 'faq-form', editing: null });
                      }}
                      className="cursor-pointer rounded-stamp px-2 py-1.5 outline-none data-[highlighted]:bg-thermal"
                    >
                      Add an FAQ
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => fileInput.current?.click()}
                      className="cursor-pointer rounded-stamp px-2 py-1.5 outline-none data-[highlighted]:bg-thermal"
                    >
                      Upload a file
                      <span className="mono ml-2 text-meta text-graphite">
                        PDF, Word, text, CSV · {MAX_KNOWLEDGE_UPLOAD_MB} MB
                      </span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Upload a file"
              accept={KNOWLEDGE_FILE_EXTENSIONS.join(',')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void act(() => knowledgeApi.upload(file));
              }}
            />
          </div>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-x-3 gap-y-1 text-label">
            {(
              [
                ['all', 'All', sources.length],
                ['faq', 'FAQs', faqs.length],
                ['file', 'Files', files.length],
                ['catalogue', 'Catalogue', catalogues.length],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                }}
                className={`font-semibold ${filter === value ? 'underline decoration-2 underline-offset-4' : 'text-graphite'}`}
              >
                {label} {count}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto font-semibold underline lg:hidden"
              onClick={() => {
                open({ kind: 'try' });
              }}
            >
              Try a question
            </button>
          </div>
          {actionError ? (
            <p role="alert" className="border-l-4 border-stamp pl-3 text-stamp">
              {actionError}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={listState.loading}>
          {listState.error ? (
            <div role="alert" className="m-3 border-l-4 border-stamp pl-3 text-stamp">
              <p>{listState.error}</p>
              <button
                type="button"
                className="button button-quiet mt-2"
                onClick={() => void loadList()}
              >
                Try again
              </button>
            </div>
          ) : listState.loading ? (
            <p className="mono p-3 text-meta text-graphite">Loading the knowledge base…</p>
          ) : sources.length === 0 ? (
            <p className="p-4 text-graphite">
              The assistant can only answer from what you add here.{' '}
              {isOwner
                ? 'Add your first FAQ or upload a price list.'
                : 'Ask an owner to add FAQs or files.'}
            </p>
          ) : (
            <ul>
              {shown.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  selected={source.id === selectedId}
                  onSelect={() => {
                    open({ kind: 'source', id: source.id });
                  }}
                />
              ))}
              {filter === 'all' && faqs.length > 0 ? (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setFilter('faq');
                    }}
                    className="flex w-full flex-col border-b border-rule px-3 py-2 text-left hover:bg-sheet/60"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold">FAQ</span>
                      <span className="mono text-meta text-graphite">{faqs.length} entries</span>
                      <span className="mono ml-auto text-meta text-graphite">
                        {faqs.some((f) => f.status !== 'ready') ? 'Reading…' : 'Ready'}
                      </span>
                    </span>
                    <span className="text-list text-graphite">
                      Edited {day(faqs[0]?.updatedAt ?? new Date().toISOString())}
                      {faqs[0]?.updatedBy ? ` by ${faqs[0].updatedBy}` : ''}
                    </span>
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </aside>

      <main className={`min-h-0 overflow-y-auto ${detailOpen ? 'block' : 'hidden lg:block'}`}>
        {detailOpen ? (
          <div className="border-b border-rule bg-sheet px-4 py-2 lg:hidden">
            <button
              type="button"
              className="text-label font-semibold underline"
              onClick={() => {
                open({ kind: 'try' });
                openId.current = null;
              }}
            >
              ‹ Knowledge
            </button>
          </div>
        ) : null}

        {pane.kind === 'faq-form' ? (
          <FaqForm
            initial={pane.editing ? (detail ?? null) : null}
            busy={busy}
            onCancel={() => {
              open(pane.editing ? { kind: 'source', id: pane.editing } : { kind: 'try' });
            }}
            onSave={(body) => {
              const editing = pane.editing;
              void act(() =>
                editing ? knowledgeApi.editFaq(editing, body) : knowledgeApi.addFaq(body),
              );
            }}
          />
        ) : pane.kind === 'source' ? (
          detailError ? (
            <p role="alert" className="m-4 border-l-4 border-stamp pl-3 text-stamp">
              {detailError}
            </p>
          ) : detail ? (
            <SourceDetail
              detail={detail}
              isOwner={isOwner}
              busy={busy}
              confirmRemove={confirmRemove}
              onEdit={() => {
                setPane({ kind: 'faq-form', editing: detail.id });
              }}
              onAskRemove={setConfirmRemove}
              onRemove={() => void act(() => knowledgeApi.remove(detail.id).then(() => null))}
              onOpen={(id) => {
                open({ kind: 'source', id });
              }}
            />
          ) : (
            <p className="mono p-4 text-meta text-graphite">Loading source…</p>
          )
        ) : (
          <div className="p-4">
            <TryQuestion
              onOpen={(id) => {
                open({ kind: 'source', id });
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function SourceRow({
  source,
  selected,
  onSelect,
}: {
  source: KnowledgeSource;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = STATUS[source.status];
  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_56px]">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        data-source-id={source.id}
        onClick={onSelect}
        className={`flex w-full flex-col border-b border-rule px-3 py-2 text-left ${
          selected ? 'bg-sheet shadow-[inset_0_0_0_1px_var(--color-ink)]' : 'hover:bg-sheet/60'
        }`}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold" dir="auto">
            {source.title}
          </span>
          <span className={`mono shrink-0 text-meta ${status.className}`}>{status.word}</span>
        </span>
        <span
          className={`line-clamp-2 text-list ${source.status === 'failed' ? 'text-stamp' : 'text-graphite'}`}
          dir="auto"
        >
          {summary(source)}
        </span>
      </button>
    </li>
  );
}

function SourceDetail({
  detail,
  isOwner,
  busy,
  confirmRemove,
  onEdit,
  onAskRemove,
  onRemove,
  onOpen,
}: {
  detail: KnowledgeSourceDetail;
  isOwner: boolean;
  busy: boolean;
  confirmRemove: boolean;
  onEdit: () => void;
  onAskRemove: (ask: boolean) => void;
  onRemove: () => void;
  onOpen: (id: string) => void;
}) {
  const verb = detail.kind === 'faq' ? (detail.version > 1 ? 'Edited' : 'Added') : 'Uploaded';
  const units =
    detail.kind === 'catalogue' && detail.unitCount !== null
      ? `${String(detail.unitCount)} products`
      : detail.unitCount !== null
        ? `${String(detail.unitCount)} pages`
        : null;
  const meta = [
    `${verb} ${day(detail.updatedAt)}${detail.updatedBy ? ` by ${detail.updatedBy}` : ''}`,
    units,
    sizeText(detail.sizeBytes),
    `version ${String(detail.version)}`,
  ].filter(Boolean);

  return (
    <article aria-labelledby="source-title">
      <header className="border-b border-rule p-4">
        <p className="mono text-meta text-graphite">
          {detail.kind === 'faq' ? 'FAQ' : detail.kind === 'catalogue' ? 'Catalogue' : 'File'}
        </p>
        <h2 id="source-title" className="text-title font-semibold" dir="auto">
          {detail.title}
        </h2>
        <p className="mono mt-1 text-meta text-graphite">{meta.join(' · ')}</p>
        <p className={`mt-2 ${detail.status === 'failed' ? 'text-stamp' : ''}`} role="status">
          {detail.status === 'ready'
            ? `Ready · ${String(detail.passageCount)} ${detail.passageCount === 1 ? 'passage' : 'passages'}`
            : detail.status === 'failed'
              ? (detail.error ?? 'This source could not be read.')
              : detail.status === 'reading'
                ? 'Reading… the assistant uses it once it is ready.'
                : 'Queued for reading.'}
        </p>
        {isOwner ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {detail.kind === 'faq' ? (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={onEdit}
              >
                Edit FAQ
              </button>
            ) : null}
            {confirmRemove ? (
              <div
                role="alertdialog"
                aria-label="Remove source"
                className="flex flex-wrap items-center gap-2 border-l-4 border-ink pl-3"
              >
                <p>The assistant stops using it at once.</p>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={onRemove}
                  autoFocus
                >
                  Remove {detail.kind === 'faq' ? 'FAQ' : 'file'}
                </button>
                <button
                  type="button"
                  className="text-label font-semibold underline"
                  onClick={() => {
                    onAskRemove(false);
                  }}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  onAskRemove(true);
                }}
              >
                Remove…
              </button>
            )}
          </div>
        ) : null}
      </header>

      <div className="border-b border-rule p-4">
        <TryQuestion onOpen={onOpen} />
      </div>

      <section aria-labelledby="passages-heading" className="p-4">
        <h3 id="passages-heading" className="text-label font-semibold text-graphite">
          Passages
        </h3>
        {detail.passages.length === 0 ? (
          <p className="mt-1 text-graphite">No passages yet.</p>
        ) : (
          <ol className="mt-2 space-y-3">
            {detail.passages.map((p) => (
              <li key={p.ordinal} className="grid grid-cols-[2.5rem_1fr] gap-x-2">
                <span className="mono text-meta text-graphite">§{p.ordinal + 1}</span>
                <div className="min-w-0">
                  {p.heading && detail.kind !== 'faq' ? (
                    <p className="text-label font-semibold" dir="auto">
                      {p.heading}
                    </p>
                  ) : null}
                  <p className="whitespace-pre-wrap" dir="auto">
                    {p.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

function TryQuestion({ onOpen }: { onOpen: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<{ asked: string; passages: RetrievedPassageView[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const asked = question.trim();
    if (!asked) return;
    setBusy(true);
    setError(null);
    knowledgeApi.tryQuestion(asked).then(
      (passages) => {
        setResult({ asked, passages });
        setBusy(false);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setBusy(false);
      },
    );
  };

  return (
    <section aria-labelledby="try-heading">
      <h3 id="try-heading" className="text-label font-semibold">
        Try a question as a customer would ask it
      </h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="mt-2 flex gap-2"
      >
        <label htmlFor="try-question" className="sr-only">
          Question
        </label>
        <input
          id="try-question"
          className="field"
          dir="auto"
          maxLength={500}
          placeholder="bhai screen guard ka warranty kitna hai"
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button button-quiet shrink-0"
          disabled={busy || !question.trim()}
        >
          Try it
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-stamp">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-3" aria-live="polite">
          {result.passages.length === 0 ? (
            <p className="text-graphite">
              Nothing in the knowledge base matches. The assistant would say it doesn&apos;t know
              and offer a person.
            </p>
          ) : (
            <>
              <p className="text-list text-graphite">The assistant would read:</p>
              <ol className="mt-1 space-y-2">
                {result.passages.map((p) => (
                  <li key={p.passageId} className="grid grid-cols-[3rem_1fr] gap-x-2">
                    <span className="mono text-meta">{p.score.toFixed(2)}</span>
                    <div className="min-w-0">
                      <button
                        type="button"
                        className="text-label font-semibold underline"
                        dir="auto"
                        onClick={() => {
                          onOpen(p.sourceId);
                        }}
                      >
                        {p.heading && p.heading !== p.sourceTitle
                          ? `${p.sourceTitle} · ${p.heading}`
                          : p.sourceTitle}
                      </button>
                      <p className="line-clamp-2 text-list" dir="auto">
                        {p.text}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function FaqForm({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: KnowledgeSourceDetail | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { question: string; answer: string }) => void;
}) {
  const [question, setQuestion] = useState(initial?.title ?? '');
  const [answer, setAnswer] = useState(initial?.answer ?? '');
  return (
    <form
      className="max-w-2xl space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ question: question.trim(), answer: answer.trim() });
      }}
    >
      <h2 className="text-title font-semibold">{initial ? 'Edit FAQ' : 'Add an FAQ'}</h2>
      <p className="text-list text-graphite">
        Write the answer exactly as the shop would give it: prices, hours and policies are repeated
        word for word, and the assistant never adds to them.
      </p>
      <div>
        <label htmlFor="faq-question" className="text-label font-semibold">
          Question
        </label>
        <input
          id="faq-question"
          className="field mt-1"
          dir="auto"
          maxLength={300}
          autoFocus
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="faq-answer" className="text-label font-semibold">
          Answer
        </label>
        <textarea
          id="faq-answer"
          className="field mt-1 resize-y"
          dir="auto"
          rows={5}
          maxLength={2000}
          value={answer}
          onChange={(event) => {
            setAnswer(event.target.value);
          }}
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          className="button button-person"
          disabled={busy || !question.trim() || !answer.trim()}
        >
          {initial ? 'Save changes' : 'Save FAQ'}
        </button>
        <button type="button" className="button button-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
