'use client';

import type { ConversationListItem } from '@app/shared';
import type { RefObject } from 'react';
import {
  displayName,
  formatDuration,
  formatPhone,
  formatTime,
  initials,
  tokenNumber,
  type QueueGroups,
} from './custody';

interface Props {
  groups: QueueGroups;
  meId: string;
  selectedId: string | null;
  now: Date;
  scope: 'open' | 'closed';
  closed: ConversationListItem[];
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
  error: string | null;
  onSearch: (value: string) => void;
  onScope: (scope: 'open' | 'closed') => void;
  onSelect: (id: string) => void;
  onRetry: () => void;
}

function Row({
  item,
  meId,
  selected,
  now,
  onSelect,
}: {
  item: ConversationListItem;
  meId: string;
  selected: boolean;
  now: Date;
  onSelect: (id: string) => void;
}) {
  const mine = item.state === 'human' && item.holder?.id === meId;
  const windowClosed =
    item.windowClosesAt !== null && new Date(item.windowClosesAt).getTime() <= now.getTime();
  const name = displayName(item.customer);
  let stamp: { text: string; className: string } | null = null;
  if (item.state === 'waiting_for_human') {
    stamp = {
      text: `Wait ${formatDuration(now.getTime() - new Date(item.waitingSince ?? now).getTime())}`,
      className: 'stamp-waiting_for_human',
    };
  } else if (item.state === 'human' && item.holder) {
    stamp = { text: initials(item.holder.name), className: mine ? 'stamp-mine' : 'stamp-human' };
  }

  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_56px]">
      <button
        type="button"
        data-conversation-id={item.id}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${tokenNumber(item.number)} ${name}, ${
          item.state === 'human' && item.holder
            ? `held by ${mine ? 'you' : item.holder.name}`
            : item.state === 'waiting_for_human'
              ? 'waiting for a person'
              : item.state === 'closed'
                ? 'closed'
                : 'held by the assistant'
        }`}
        onClick={() => {
          onSelect(item.id);
        }}
        className={`flex w-full gap-2 border-b border-rule pr-3 text-left ${
          selected ? 'bg-sheet shadow-[inset_0_0_0_1px_var(--color-ink)]' : 'hover:bg-sheet/60'
        }`}
      >
        <span aria-hidden className={`custody custody-${item.state}`} />
        <span className="min-w-0 flex-1 py-2">
          <span className="flex items-baseline gap-2">
            <span className="display text-list">{tokenNumber(item.number)}</span>
            <span className="truncate text-list font-semibold" dir="auto">
              {name}
            </span>
            <span className="ml-auto shrink-0">
              {stamp ? (
                <span className={`stamp text-meta ${stamp.className}`}>{stamp.text}</span>
              ) : item.lastMessage ? (
                <span className="mono text-meta text-graphite">
                  {formatTime(item.lastMessage.at, now)}
                </span>
              ) : null}
            </span>
          </span>
          <span className="mt-0.5 flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-list text-graphite" dir="auto">
              {item.lastMessage?.direction === 'outbound' ? '↳ ' : ''}
              {item.lastMessage?.preview ?? formatPhone(item.customer.phone) ?? ''}
            </span>
            {windowClosed && item.state !== 'closed' ? (
              <span className="mono shrink-0 text-meta text-stamp">window closed</span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function Group({
  title,
  items,
  ...rest
}: {
  title: string;
  items: ConversationListItem[];
  meId: string;
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className="sticky top-0 z-10 flex items-baseline justify-between border-b border-rule bg-thermal px-3 py-1 text-label font-semibold">
        {title}
        <span className="mono text-meta text-graphite">{items.length}</span>
      </h2>
      <ul>
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            meId={rest.meId}
            selected={item.id === rest.selectedId}
            now={rest.now}
            onSelect={rest.onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

export function Queue({
  groups,
  meId,
  selectedId,
  now,
  scope,
  closed,
  search,
  searchRef,
  loading,
  error,
  onSearch,
  onScope,
  onSelect,
  onRetry,
}: Props) {
  const open =
    groups.waiting.length + groups.mine.length + groups.others.length + groups.assistant.length;
  const shared = { meId, selectedId, now, onSelect };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-rule p-3">
        <label className="sr-only" htmlFor="queue-search">
          Search conversations
        </label>
        <div className="flex items-center gap-2">
          <input
            id="queue-search"
            ref={searchRef}
            type="search"
            className="field py-1.5"
            placeholder="Search name, number or message"
            value={search}
            onChange={(event) => {
              onSearch(event.target.value);
            }}
          />
          <span className="keycap" aria-hidden>
            /
          </span>
        </div>
        <div role="group" aria-label="Show" className="flex gap-3 text-label">
          {(['open', 'closed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => {
                onScope(value);
              }}
              className={`font-semibold ${scope === value ? 'underline decoration-2 underline-offset-4' : 'text-graphite'}`}
            >
              {value === 'open' ? `Open · ${String(open)}` : 'Closed'}
            </button>
          ))}
          <span className="ml-auto text-graphite">
            Waiting {groups.waiting.length} · Mine {groups.mine.length}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {error ? (
          <div role="alert" className="m-3 border-l-4 border-stamp pl-3 text-stamp">
            <p>{error}</p>
            <button type="button" className="button button-quiet mt-2 text-label" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <p className="mono p-3 text-meta text-graphite">Loading conversations…</p>
        ) : scope === 'closed' ? (
          closed.length === 0 ? (
            <p className="p-3 text-graphite">No closed conversations yet.</p>
          ) : (
            <Group title="Closed" items={closed} {...shared} />
          )
        ) : open === 0 ? (
          <div className="flex gap-3 p-4">
            <span aria-hidden className="custody custody-assistant" />
            <p className="text-graphite">
              {search
                ? 'Nothing matches that search.'
                : 'No conversations yet. Customer messages from WhatsApp appear here; the assistant answers first.'}
            </p>
          </div>
        ) : (
          <>
            <Group title="Waiting for a person" items={groups.waiting} {...shared} />
            <Group title="Mine" items={groups.mine} {...shared} />
            <Group title="Colleagues" items={groups.others} {...shared} />
            <Group title="Assistant" items={groups.assistant} {...shared} />
          </>
        )}
      </div>
    </div>
  );
}
