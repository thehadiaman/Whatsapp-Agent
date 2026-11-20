'use client';

import type {
  ConversationDetail,
  ConversationState,
  TeamMember,
  TimelineEntry,
  TimelineMessage,
} from '@app/shared';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  custodyAlongTimeline,
  displayName,
  formatPhone,
  formatTime,
  holderLabel,
  tokenNumber,
  windowText,
} from './custody';
import { VoicePlayer } from './voice-player';

export interface ThreadActions {
  takeOver: () => void;
  handBack: () => void;
  assign: (userId: string) => void;
  close: () => void;
  reply: (text: string, voice: boolean) => Promise<boolean>;
  sendTemplate: () => void;
  note: (text: string) => Promise<boolean>;
  retry: (messageId: string) => void;
  explain: (messageId: string) => void;
}

interface Props {
  detail: ConversationDetail;
  meId: string;
  meIsOwner: boolean;
  team: TeamMember[];
  now: Date;
  busy: boolean;
  error: string | null;
  confirmingClose: boolean;
  setConfirmingClose: (value: boolean) => void;
  assignOpen: boolean;
  setAssignOpen: (value: boolean) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  noteMode: boolean;
  setNoteMode: (value: boolean) => void;
  actions: ThreadActions;
  selectedMessageId: string | null;
}

const LEDGER_TEXT: Record<ConversationState, string> = {
  assistant: 'text-graphite',
  waiting_for_human: 'text-stamp',
  human: 'text-ballpoint',
  closed: 'text-graphite',
};

const STATUS_WORDS: Record<string, string> = {
  queued: 'queued',
  sending: 'sending…',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'played',
  cancelled: 'not sent: a person took over',
};

function transitionText(entry: Extract<TimelineEntry, { type: 'transition' }>): string {
  switch (entry.to) {
    case 'waiting_for_human':
      return `Waiting for a person · ${entry.reason}`;
    case 'human':
      return entry.reason.startsWith('Assigned')
        ? entry.reason
        : `${entry.actorName ?? 'Someone'} took over`;
    case 'assistant':
      return entry.from === null
        ? entry.reason
        : `Handed back to the assistant by ${entry.actorName ?? 'someone'}`;
    case 'closed':
      return entry.reason;
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ml: 'Malayalam',
  ar: 'Arabic',
};

const FALLBACK_TEXT: Record<string, (language: string) => string> = {
  no_voice: (language) => `no voice for ${LANGUAGE_NAMES[language] ?? language}`,
  too_long: () => 'too long for a voice note',
  too_large: () => 'the voice note would be too large to play',
  synthesis_failed: () => 'the voice could not be made',
};

/** A voice note: the player, with what was said beside it (DESIGN.md, "Voice notes"). */
function VoiceNote({ message }: { message: TimelineMessage }) {
  const src = `/api/media/${message.id}`;
  const available = message.media?.available ?? false;
  const t = message.transcript;
  const outbound = message.direction === 'outbound';
  return (
    <div className="grid gap-x-3 gap-y-1 md:grid-cols-[minmax(0,15rem)_1fr]">
      {available ? (
        <VoicePlayer
          src={src}
          durationMs={message.media?.durationMs ?? null}
          label={outbound ? 'voice reply' : 'voice note from the customer'}
        />
      ) : (
        <p className="mono text-meta text-graphite">
          {outbound ? 'Voice note is being made…' : 'Voice note is being copied…'}
        </p>
      )}
      <div className="min-w-0">
        {outbound ? (
          <>
            <p dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {message.body}
            </p>
            <p className="mono text-meta text-graphite">
              {message.speech?.language ?? ''} · Sent as voice
              {message.speech?.engine === 'polly'
                ? ` · Amazon Polly, ${message.speech.voiceId ?? ''}`
                : message.speech?.engine === 'mock'
                  ? ' · mock voice'
                  : ''}
            </p>
          </>
        ) : t?.status === 'done' ? (
          <>
            <p dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {t.text}
            </p>
            <p className="mono text-meta text-graphite">
              {t.language} ·{' '}
              {t.engine === 'transcribe'
                ? 'Transcribed by Amazon Transcribe'
                : 'Transcript from simulator'}
            </p>
          </>
        ) : t?.status === 'failed' ? (
          <p className="text-list text-stamp">
            Couldn&apos;t transcribe this voice note ({t.reason}). Listen to it before replying.
          </p>
        ) : (
          <p className="mono text-meta text-graphite">Transcribing…</p>
        )}
      </div>
    </div>
  );
}

function MessageBody({ message }: { message: TimelineMessage }) {
  const [expanded, setExpanded] = useState(false);
  const long = (message.body?.length ?? 0) > 700;
  if (message.kind === 'audio' && (message.direction === 'inbound' || message.speech)) {
    return <VoiceNote message={message} />;
  }
  if (message.media) {
    const src = `/api/media/${message.id}`;
    return (
      <div className="space-y-1">
        {!message.media.available ? (
          <p className="mono text-meta text-graphite">Attachment is being copied…</p>
        ) : message.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated customer media from /api/media; the image optimiser cannot fetch with the user's session and should not cache it
          <img
            src={src}
            alt={message.media.caption ?? 'Photo from the customer'}
            className="max-h-60 max-w-full rounded-control border border-rule"
            loading="lazy"
          />
        ) : message.kind === 'audio' ? (
          <audio controls src={src} className="max-w-full" />
        ) : (
          <a href={src} download>
            Download {message.media.filename ?? 'document'}
          </a>
        )}
        {message.media.caption ? <p dir="auto">{message.media.caption}</p> : null}
      </div>
    );
  }
  if (message.kind === 'template') {
    return <p className="text-graphite">Sent the approved template “{message.templateName}”.</p>;
  }
  if (message.kind === 'unsupported') {
    return (
      <p className="text-graphite">The customer sent a message type the inbox cannot show yet.</p>
    );
  }
  return (
    <div>
      <p
        dir="auto"
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${long && !expanded ? 'clamp-12' : ''}`}
      >
        {message.body}
      </p>
      {message.speech?.fallback ? (
        <p className="mono text-meta text-graphite">
          Sent as text: {FALLBACK_TEXT[message.speech.fallback]?.(message.speech.language)}
        </p>
      ) : null}
      {long ? (
        <button
          type="button"
          className="mt-1 text-label font-semibold underline underline-offset-2"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded
            ? 'Show less'
            : `Show full message (${(message.body?.length ?? 0).toLocaleString('en')} characters)`}
        </button>
      ) : null}
    </div>
  );
}

export function Thread({
  detail,
  meId,
  meIsOwner,
  team,
  now,
  busy,
  error,
  confirmingClose,
  setConfirmingClose,
  assignOpen,
  setAssignOpen,
  composerRef,
  noteMode,
  setNoteMode,
  actions,
  selectedMessageId,
}: Props) {
  const [draft, setDraft] = useState('');
  const [voiceReply, setVoiceReply] = useState(false);
  const speaking = voiceReply && detail.voiceReplies && !noteMode;
  const mine = detail.state === 'human' && detail.holder?.id === meId;
  const window = windowText(detail.windowClosesAt, now);
  const custody = custodyAlongTimeline(detail.timeline);
  const name = displayName(detail.customer);
  const canAssign = detail.state !== 'closed' && (meIsOwner || !detail.holder || mine);
  const canClose = detail.state !== 'closed' && (meIsOwner || !detail.holder || mine);
  const stampClass =
    detail.state === 'human' ? (mine ? 'stamp-mine' : 'stamp-human') : `stamp-${detail.state}`;
  const lastTransition = [...detail.timeline].reverse().find((e) => e.type === 'transition');

  // Open at the latest message, and follow new ones unless the reader scrolled up.
  const timelineRef = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    following.current = true;
  }, [detail.id]);
  useLayoutEffect(() => {
    const list = timelineRef.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [detail.id, detail.timeline.length]);

  // After taking over, the reply box appears: put the cursor in it.
  useEffect(() => {
    if (mine) composerRef.current?.focus();
  }, [mine, composerRef]);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    const sent = noteMode ? await actions.note(text) : await actions.reply(text, speaking);
    if (sent) setDraft('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sheet">
      <header className="border-b border-rule px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="display text-pane">{tokenNumber(detail.number)}</span>
          <h1 className="text-title font-semibold" dir="auto">
            {name}
          </h1>
          <span className="mono text-meta text-graphite">
            {formatPhone(detail.customer.phone) ?? 'username only'}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`stamp text-pane ${stampClass}`} data-testid="held-by">
            <span className="mr-2 text-label">Held by</span>
            {mine ? 'You' : holderLabel(detail.state, detail.holder?.name ?? null)}
            {lastTransition ? (
              <span className="mono ml-2 text-meta normal-case tracking-normal">
                since {formatTime(lastTransition.at, now)}
              </span>
            ) : null}
          </span>

          <div className="ml-auto flex flex-wrap gap-2">
            {(detail.state === 'assistant' || detail.state === 'waiting_for_human') && (
              <button
                type="button"
                className="button button-person"
                disabled={busy}
                onClick={actions.takeOver}
              >
                Take over <span className="keycap">T</span>
              </button>
            )}
            {(mine || (meIsOwner && detail.state === 'human')) && (
              <button
                type="button"
                className="button button-assistant"
                disabled={busy}
                onClick={actions.handBack}
              >
                Hand back to assistant <span className="keycap">H</span>
              </button>
            )}
            {canAssign ? (
              <DropdownMenu.Root open={assignOpen} onOpenChange={setAssignOpen}>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="button button-quiet" disabled={busy}>
                    Assign… <span className="keycap">A</span>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-50 min-w-56 rounded-control border border-rule-strong bg-sheet p-1 shadow-[0_6px_20px_rgb(24_32_46_/_0.15)]"
                  >
                    <DropdownMenu.Label className="px-2 py-1 text-label text-graphite">
                      Give this conversation to
                    </DropdownMenu.Label>
                    {team
                      .filter((member) => member.userId !== detail.holder?.id)
                      .map((member) => (
                        <DropdownMenu.Item
                          key={member.userId}
                          onSelect={() => {
                            actions.assign(member.userId);
                          }}
                          className="cursor-pointer rounded-stamp px-2 py-1.5 outline-none data-[highlighted]:bg-thermal"
                        >
                          {member.userId === meId ? 'Me' : member.name}
                          <span className="mono ml-2 text-meta text-graphite">{member.role}</span>
                        </DropdownMenu.Item>
                      ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
            {canClose ? (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  setConfirmingClose(true);
                }}
              >
                Close <span className="keycap">C</span>
              </button>
            ) : null}
          </div>
        </div>

        {confirmingClose ? (
          <div
            role="alertdialog"
            aria-label="Close conversation"
            className="mt-2 flex flex-wrap items-center gap-2 border-l-4 border-ink pl-3"
          >
            <p>
              Close conversation {tokenNumber(detail.number)}? A new message from the customer will
              open a new one.
            </p>
            <button type="button" className="button button-quiet" onClick={actions.close} autoFocus>
              Close conversation
            </button>
            <button
              type="button"
              className="text-label font-semibold underline"
              onClick={() => {
                setConfirmingClose(false);
              }}
            >
              Keep it open
            </button>
          </div>
        ) : null}

        <p
          className={`mono mt-2 text-meta ${window.open ? 'text-graphite' : 'text-stamp'}`}
          data-testid="window"
        >
          {window.text}
        </p>
        {error ? (
          <p role="alert" className="mt-2 border-l-4 border-stamp pl-3 text-stamp">
            {error}
          </p>
        ) : null}
      </header>

      <ol
        ref={timelineRef}
        className="min-h-0 flex-1 overflow-y-auto py-2"
        aria-label={`Conversation with ${name}`}
        onScroll={(event) => {
          const list = event.currentTarget;
          following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        }}
      >
        {detail.timeline.map((entry, index) => {
          const state = custody[index] ?? 'assistant';
          if (entry.type === 'transition') {
            return (
              <li key={entry.id} className={`mx-4 my-2 ${LEDGER_TEXT[entry.to]}`}>
                <p className="ledger-entry mono text-meta">
                  {formatTime(entry.at, now)} · {transitionText(entry)}
                </p>
              </li>
            );
          }
          if (entry.type === 'note') {
            return (
              <li key={entry.id} className="flex gap-3 pr-4">
                <span aria-hidden className={`custody custody-${state}`} />
                <div className="slip my-1 flex-1 px-3 py-2">
                  <p className="mono text-meta">
                    Internal note · not sent to the customer · {entry.authorName ?? 'Someone'} ·{' '}
                    {formatTime(entry.at, now)}
                  </p>
                  <p dir="auto" className="mt-1 whitespace-pre-wrap">
                    {entry.body}
                  </p>
                </div>
              </li>
            );
          }
          const sender =
            entry.senderType === 'customer'
              ? 'Customer'
              : entry.senderType === 'assistant'
                ? 'Assistant'
                : (entry.senderName ?? 'Staff');
          const senderColour =
            entry.senderType === 'assistant'
              ? 'text-graphite'
              : entry.senderType === 'user'
                ? 'text-ballpoint'
                : 'text-ink';
          const selected = selectedMessageId === entry.id;
          return (
            <li key={entry.id} className={`flex gap-3 pr-4 ${selected ? 'bg-thermal' : ''}`}>
              <span aria-hidden className={`custody custody-${state}`} />
              <div className="grid flex-1 grid-cols-[3.25rem_1fr] gap-x-2 py-1.5 sm:grid-cols-[3.25rem_7rem_1fr]">
                <span className="mono pt-0.5 text-meta text-graphite">
                  {formatTime(entry.at, now)}
                </span>
                <span className={`text-label font-semibold ${senderColour} sm:pt-0.5`}>
                  {entry.senderType === 'assistant' ? (
                    <button
                      type="button"
                      className="underline decoration-dotted underline-offset-2"
                      onClick={() => {
                        actions.explain(entry.id);
                      }}
                      aria-label="Explain this reply"
                    >
                      {sender}
                    </button>
                  ) : (
                    sender
                  )}
                </span>
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <MessageBody message={entry} />
                  {entry.direction === 'outbound' ? (
                    entry.status === 'failed' ? (
                      <p className="mono mt-0.5 text-meta text-stamp">
                        Not sent: {entry.error?.message ?? 'WhatsApp refused it'}.{' '}
                        {mine ? (
                          <button
                            type="button"
                            className="font-semibold underline"
                            onClick={() => {
                              actions.retry(entry.id);
                            }}
                          >
                            Send again
                          </button>
                        ) : null}
                      </p>
                    ) : (
                      <p className="mono mt-0.5 text-meta text-graphite">
                        {STATUS_WORDS[entry.status] ?? entry.status}
                        {entry.error && entry.status === 'queued'
                          ? ` · retrying: ${entry.error.message}`
                          : ''}
                      </p>
                    )
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-rule p-3">
        {detail.state === 'closed' ? (
          <p className="text-graphite">
            This conversation is closed. A new message from the customer opens a new one.
          </p>
        ) : mine && !window.open && !noteMode ? (
          <div className="space-y-2">
            <p className="text-stamp">
              Free text can&apos;t be sent: WhatsApp closed the 24-hour window. Send the approved
              template to reopen it.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="button button-person"
                disabled={busy || !detail.channel.reopenTemplateName}
                onClick={actions.sendTemplate}
              >
                Send template “{detail.channel.reopenTemplateName ?? 'none set'}”
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setNoteMode(true);
                }}
              >
                Add internal note <span className="keycap">N</span>
              </button>
            </div>
          </div>
        ) : mine || noteMode ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-2"
          >
            <label htmlFor="composer" className="sr-only">
              {noteMode ? 'Internal note' : `Reply to ${name}`}
            </label>
            <textarea
              id="composer"
              ref={composerRef}
              dir="auto"
              rows={3}
              maxLength={noteMode ? 2000 : 4096}
              value={draft}
              placeholder={
                noteMode ? 'Internal note: only your team sees this' : `Reply to ${name}…`
              }
              className={`field resize-y ${noteMode ? 'bg-carbon' : ''}`}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === 'Escape' && noteMode) setNoteMode(false);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className={`button ${noteMode ? 'button-quiet bg-carbon' : 'button-person'}`}
                disabled={busy || !draft.trim()}
              >
                {noteMode ? 'Add note' : speaking ? 'Send as voice' : 'Send'}
              </button>
              {detail.voiceReplies && !noteMode ? (
                <button
                  type="button"
                  className="mono text-meta font-semibold underline underline-offset-2"
                  aria-pressed={voiceReply}
                  title="Speak the reply as a voice note. Languages without a voice go as text."
                  onClick={() => {
                    setVoiceReply(!voiceReply);
                  }}
                >
                  Voice reply: {voiceReply ? 'on' : 'off'}
                </button>
              ) : null}
              {mine ? (
                <button
                  type="button"
                  className="text-label font-semibold underline underline-offset-2"
                  onClick={() => {
                    setNoteMode(!noteMode);
                  }}
                >
                  {noteMode ? 'Write a reply instead' : 'Add internal note'}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-label font-semibold underline underline-offset-2"
                  onClick={() => {
                    setNoteMode(false);
                  }}
                >
                  Cancel
                </button>
              )}
              <span className="mono ml-auto text-meta text-graphite">
                Enter sends · Shift+Enter new line
              </span>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-graphite">
              {detail.state === 'human' && detail.holder
                ? `${detail.holder.name} holds this conversation.`
                : `The assistant is replying to ${name}. Take over to write yourself.`}
            </p>
            {detail.state !== 'human' ? (
              <button
                type="button"
                className="button button-person"
                disabled={busy}
                onClick={actions.takeOver}
              >
                Take over <span className="keycap">T</span>
              </button>
            ) : null}
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setNoteMode(true);
              }}
            >
              Add internal note <span className="keycap">N</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
