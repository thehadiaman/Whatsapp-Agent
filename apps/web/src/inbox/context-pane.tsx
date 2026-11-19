'use client';

import type { ConversationDetail } from '@app/shared';
import { formatPhone, formatTime } from './custody';

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

/** Right pane: who the customer is, and why the assistant said what it said. */
export function ContextPane({
  detail,
  selectedMessageId,
  now,
}: {
  detail: ConversationDetail;
  selectedMessageId: string | null;
  now: Date;
}) {
  const selected = detail.timeline.find((e) => e.type === 'message' && e.id === selectedMessageId);
  return (
    <div className="h-full space-y-0 overflow-y-auto">
      <section aria-labelledby="customer-heading" className="border-b border-rule p-4">
        <h2 id="customer-heading" className="text-label font-semibold text-graphite">
          Customer
        </h2>
        <p className="mt-1 font-semibold" dir="auto">
          {detail.customer.name ?? 'No name shared'}
        </p>
        <p className="mono text-meta">
          {formatPhone(detail.customer.phone) ?? 'Username only: no phone number shared'}
        </p>
        <p className="mt-2 text-list text-graphite">
          First wrote {dateFormat.format(new Date(detail.customer.firstSeenAt))} to{' '}
          <span className="mono text-meta">{detail.channel.displayPhoneNumber}</span>
        </p>
      </section>

      <section aria-labelledby="explain-heading" className="p-4">
        <h2
          id="explain-heading"
          className="flex items-baseline justify-between text-label font-semibold text-graphite"
        >
          Explain this reply
          {selected ? <span className="mono text-meta">{formatTime(selected.at, now)}</span> : null}
        </h2>
        <p className="mt-1 text-list text-graphite">
          {selected
            ? 'No trace was recorded for this reply. Replies the assistant writes from now on show the passages it read, the tools it called, and their latency, tokens and cost here.'
            : 'Select a reply from the assistant to see the passages, tools and cost behind it.'}
        </p>
      </section>
    </div>
  );
}
