'use client';

import { analyticsSchema, HANDOFF_CODE_LABELS, type Analytics as Data } from '@app/shared';
import { useEffect, useState } from 'react';
import { messageOf, request } from '../lib/client-api';

const dayLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const count = new Intl.NumberFormat('en-GB');

export function duration(ms: number | null): string {
  if (ms === null) return '–';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds && minutes < 10
      ? `${String(minutes)} m ${String(seconds)} s`
      : `${String(minutes)} m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} h ${String(minutes % 60)} m`;
}

export function dollars(micros: number | null): string {
  if (micros === null) return '–';
  if (micros === 0) return '$0';
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Who held conversations, by day: the custody marks, as in the inbox (DESIGN.md §3). */
function CustodyChart({ data }: { data: Data }) {
  const max = Math.max(1, ...data.byDay.map((d) => d.conversations));
  return (
    <section aria-labelledby="custody-heading" className="border-b border-rule py-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h2 id="custody-heading" className="text-label font-semibold">
          Who held conversations, by day
        </h2>
        <ul className="mono flex flex-wrap gap-x-4 text-meta text-graphite" aria-label="Key">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="chart-assistant inline-block h-3 w-4" /> assistant only
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="chart-person inline-block h-3 w-4" /> a person took part
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="chart-waiting inline-block h-3 w-4" /> waiting now
          </li>
        </ul>
      </div>
      <ol className="mt-3 space-y-1">
        {data.byDay.map((day) => (
          <li key={day.date} className="flex items-center gap-3">
            <span className="mono w-14 shrink-0 text-meta text-graphite">
              {dayLabel.format(new Date(`${day.date}T00:00:00Z`))}
            </span>
            <span className="sr-only">
              {`${String(day.conversations)} conversations: ${String(day.assistantOnly)} assistant only, ${String(day.personTookPart)} with a person, ${String(day.waiting)} waiting.`}
            </span>
            <span aria-hidden className="flex h-3 min-w-0 flex-1">
              <span
                className="chart-assistant"
                style={{ width: `${String((day.assistantOnly / max) * 100)}%` }}
              />
              <span
                className="chart-person"
                style={{ width: `${String((day.personTookPart / max) * 100)}%` }}
              />
              <span
                className="chart-waiting"
                style={{ width: `${String((day.waiting / max) * 100)}%` }}
              />
            </span>
            <span aria-hidden className="mono w-8 shrink-0 text-right text-meta">
              {day.conversations}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DayBook({ data }: { data: Data }) {
  return (
    <section aria-labelledby="daybook-heading" className="border-b border-rule py-4">
      <h2 id="daybook-heading" className="text-label font-semibold">
        Day book
      </h2>
      <div className="mt-2 overflow-x-auto">
        <table className="mono w-full min-w-[640px] text-meta">
          <thead className="text-graphite">
            <tr className="border-b border-rule text-left">
              <th scope="col" className="py-1 pr-3 font-normal">
                Date
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                Conversations
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                Resolved by assistant
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                Handoffs
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                Median reply
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                p95 reply
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Cost / conv
              </th>
            </tr>
          </thead>
          <tbody>
            {[...data.byDay].reverse().map((day) => (
              <tr key={day.date} className="border-b border-rule last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {dayLabel.format(new Date(`${day.date}T00:00:00Z`))}
                </th>
                <td className="py-1 pr-3 text-right">{count.format(day.conversations)}</td>
                <td className="py-1 pr-3 text-right">
                  {day.conversations > 0
                    ? `${count.format(day.assistantOnly)} (${String(share(day.assistantOnly, day.conversations))}%)`
                    : '–'}
                </td>
                <td className="py-1 pr-3 text-right">{count.format(day.handoffs)}</td>
                <td className="py-1 pr-3 text-right">{duration(day.replyMedianMs)}</td>
                <td className="py-1 pr-3 text-right">{duration(day.replyP95Ms)}</td>
                <td className="py-1 text-right">{dollars(day.costPerConversationMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Reasons({ data }: { data: Data }) {
  const top = Math.max(1, ...data.reasons.map((r) => r.count));
  return (
    <section aria-labelledby="reasons-heading" className="min-w-0">
      <h2 id="reasons-heading" className="text-label font-semibold">
        Why conversations went to a person
      </h2>
      {data.reasons.length === 0 ? (
        <p className="mt-2 text-graphite">None in this period: the assistant kept every one.</p>
      ) : (
        <ol className="mt-2 space-y-1">
          {data.reasons.map((r) => (
            <li
              key={r.code}
              className="grid grid-cols-[minmax(0,15rem)_2.5rem_1fr] items-center gap-2"
            >
              <span className="truncate">{HANDOFF_CODE_LABELS[r.code] ?? r.code}</span>
              <span className="mono text-right text-meta">{r.count}</span>
              <span
                aria-hidden
                className="h-2 bg-stamp"
                style={{ width: `${String((r.count / top) * 100)}%` }}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HumanReply({ data }: { data: Data }) {
  const h = data.humanReply;
  return (
    <section aria-labelledby="human-heading" className="min-w-0">
      <h2 id="human-heading" className="text-label font-semibold">
        Time to first human reply
      </h2>
      {h.count === 0 ? (
        <p className="mt-2 text-graphite">No one waited for a person in this period.</p>
      ) : (
        <dl className="mono mt-2 space-y-1 text-meta">
          <div className="flex gap-2">
            <dt className="text-graphite">median</dt>
            <dd>{duration(h.medianMs)}</dd>
            <dt className="ml-3 text-graphite">p95</dt>
            <dd>{duration(h.p95Ms)}</dd>
            <dd className="ml-3 text-graphite">{count.format(h.count)} replies</dd>
          </div>
          {h.outsideHours ? (
            <div className="flex gap-2">
              <dt className="text-graphite">handed over while closed</dt>
              <dd>
                {h.outsideHours.count > 0
                  ? `median ${duration(h.outsideHours.medianMs)} (${count.format(h.outsideHours.count)})`
                  : 'none'}
              </dd>
            </div>
          ) : (
            <p className="text-graphite">
              Set opening hours in settings to see after-hours waits apart.
            </p>
          )}
        </dl>
      )}
    </section>
  );
}

/** The analytics page (DESIGN.md "Analytics"): a sentence, a custody chart, a day book. */
export function Analytics() {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped by "Retry now" to fetch again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    request(`/analytics?days=${String(days)}`, {}, analyticsSchema).then(
      (next) => {
        if (!live) return;
        setData(next);
        setError(null);
      },
      (failure: unknown) => {
        if (live) setError(`Couldn't load analytics. ${messageOf(failure)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [days, attempt]);

  const s = data?.summary;
  const before = s?.previous;
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-rule pb-3">
        <h1 className="display text-pane">Analytics</h1>
        <label className="flex items-center gap-2">
          <span className="sr-only">Period</span>
          <select
            className="field w-auto py-1"
            value={days}
            onChange={(event) => {
              setDays(event.target.value === '30' ? 30 : 7);
            }}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <span className="text-graphite">Compared with the {days} days before</span>
        {data ? (
          <span className="mono ml-auto text-meta text-graphite">days in {data.timezone}</span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 border-l-4 border-stamp pl-3 text-stamp">
          {error}{' '}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              setAttempt(attempt + 1);
            }}
          >
            Retry now
          </button>
        </p>
      ) : !data || !s || !before ? (
        <p className="mono mt-4 text-meta text-graphite">Loading analytics…</p>
      ) : s.conversations === 0 ? (
        <p className="mt-4 text-graphite">
          No conversations in the last {days} days yet. Numbers appear here as customers write in.
        </p>
      ) : (
        <>
          <section aria-label="Summary" className="border-b border-rule py-4">
            <p className="text-headline">
              The assistant resolved{' '}
              <span className="display">{count.format(s.assistantOnly)}</span> of{' '}
              <span className="display">{count.format(s.conversations)}</span> conversations (
              {share(s.assistantOnly, s.conversations)}%) without a person.
            </p>
            <p className="mt-2">
              First replies: median {duration(s.replyMedianMs)}, p95 {duration(s.replyP95Ms)}. Cost
              per conversation: {dollars(s.costPerConversationMicros)}.
            </p>
            <p className="mono mt-1 text-meta text-graphite">
              {before.conversations > 0
                ? `Before: ${String(share(before.assistantOnly, before.conversations))}% of ${count.format(before.conversations)}, ${dollars(before.costPerConversationMicros)} per conversation.`
                : 'No conversations in the period before.'}
              {s.costPerConversationMicros === 0 ? ' Cost is $0: the mock model answered.' : ''}
            </p>
          </section>
          <CustodyChart data={data} />
          <DayBook data={data} />
          <div className="grid gap-6 py-4 md:grid-cols-2">
            <Reasons data={data} />
            <HumanReply data={data} />
          </div>
        </>
      )}
    </main>
  );
}
