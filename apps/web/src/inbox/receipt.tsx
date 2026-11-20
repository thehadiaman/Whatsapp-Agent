'use client';

import type { TurnExplanation } from '@app/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { messageOf } from '../lib/client-api';
import { inboxApi } from './api';

/** What lookup_order returned, validated: tool results are stored as plain JSON. */
const orderResultSchema = z.object({
  found: z.literal(true),
  order_number: z.string(),
  status: z.string(),
  items: z.array(z.object({ name: z.string(), quantity: z.number() })),
  total: z.string().nullable(),
  currency: z.string().nullable(),
  courier: z.string().nullable(),
  promised_date: z.string().nullable(),
});
export type OrderResult = z.infer<typeof orderResultSchema>;

const STATUS_WORDS: Record<string, string> = {
  received: 'Received',
  preparing: 'Being prepared',
  ready: 'Ready for pickup',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export function orderStatusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}

export function promisedText(order: OrderResult): string {
  return order.promised_date
    ? `Due ${dayFormat.format(new Date(`${order.promised_date}T00:00:00`))}`
    : 'Delivery date: not given';
}

/** The last order the assistant found in this turn, if any. */
export function lastOrder(turn: TurnExplanation): OrderResult | null {
  for (const call of [...turn.toolCalls].reverse()) {
    if (call.name !== 'lookup_order') continue;
    const parsed = orderResultSchema.safeParse(call.result);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function outcomeText(turn: TurnExplanation): string {
  switch (turn.outcome) {
    case 'replied':
      return turn.basis === 'knowledge'
        ? 'Answered from the knowledge base.'
        : turn.basis === 'order'
          ? 'Answered from an order lookup.'
          : 'Said it did not have the answer and offered a person.';
    case 'declined':
      return 'Declined: the question was not about this business.';
    case 'handed_off':
      return 'Handed the conversation to a person.';
    case 'guard_blocked':
      return 'Held back by the figure check: the reply had a number not found in the knowledge base. A person was asked to answer.';
    case 'budget_exhausted':
      return "The business's daily assistant budget was used up. A person was asked to answer.";
    case 'rate_limited':
      return 'Too many messages in an hour: the assistant stopped replying.';
    case 'skipped':
      return 'Not sent: a person took over before the reply was ready.';
    case 'failed':
      return 'The assistant could not answer, so it asked a person to.';
  }
}

function toolSummary(call: TurnExplanation['toolCalls'][number]): string {
  if (call.name === 'lookup_order') {
    const order = orderResultSchema.safeParse(call.result);
    if (order.success) {
      return `${order.data.order_number}: ${orderStatusWord(order.data.status).toLowerCase()}${
        order.data.courier ? `, ${order.data.courier}` : ''
      }`;
    }
    const asked = z.object({ order_number: z.string() }).safeParse(call.input);
    return `${asked.success ? asked.data.order_number : 'order'}: not found for this customer`;
  }
  if (call.name === 'handoff') {
    const input = z.object({ reason: z.string() }).safeParse(call.input);
    return input.success ? input.data.reason.replaceAll('_', ' ') : 'to a person';
  }
  return call.name;
}

function cost(micros: number, model: string): string {
  if (micros === 0) return model === 'mock' ? '$0 · mock model' : '$0';
  const dollars = micros / 1_000_000;
  return dollars < 0.0001 ? '< $0.0001' : `$${dollars.toFixed(4)}`;
}

/** One line of the receipt: label, dotted leader, value. */
function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="shrink-0">{label}</dt>
      <span
        aria-hidden
        className="min-w-4 flex-1 -translate-y-1 border-b border-dotted border-rule-strong"
      />
      <dd className="shrink-0 text-right">{children}</dd>
    </div>
  );
}

const number = new Intl.NumberFormat('en-GB');

/** "Explain this reply": an itemised receipt (DESIGN.md §5), loaded for one turn. */
export function Receipt({ conversationId, turnId }: { conversationId: string; turnId: string }) {
  const [turn, setTurn] = useState<TurnExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    inboxApi.explanation(conversationId, turnId).then(
      (next) => {
        if (live) setTurn(next);
      },
      (failure: unknown) => {
        if (live) setError(`Couldn't load this receipt. ${messageOf(failure)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, turnId]);

  if (error) return <p className="mt-2 text-list text-stamp">{error}</p>;
  if (!turn) return <p className="mono mt-2 text-meta text-graphite">Loading receipt…</p>;

  return (
    <div className="mt-2 space-y-3">
      <p className="text-list">{outcomeText(turn)}</p>
      {turn.detail && turn.outcome !== 'replied' ? (
        <p className="mono text-meta text-graphite">{turn.detail}</p>
      ) : null}
      <dl className="mono space-y-1 text-meta">
        <Line label="Passages">{turn.passages.length}</Line>
        {turn.passages.map((p) => (
          <div key={`${p.sourceId}-${p.heading ?? ''}`} className="flex items-baseline gap-1 pl-3">
            <dt className="min-w-0 truncate">
              <a href={`/knowledge?s=${p.sourceId}`} className="underline" dir="auto">
                {p.heading && p.heading !== p.sourceTitle
                  ? `${p.sourceTitle} · ${p.heading}`
                  : p.sourceTitle}
              </a>
            </dt>
            <span
              aria-hidden
              className="min-w-4 flex-1 -translate-y-1 border-b border-dotted border-rule-strong"
            />
            <dd className="shrink-0">{p.score.toFixed(2)}</dd>
          </div>
        ))}
        {turn.toolCalls.map((call, i) => (
          <div key={`${call.name}-${String(i)}`} className="pl-0">
            <dt className="inline">Tool </dt>
            <dd className="inline">
              {call.name}
              <span className="block pl-3 text-graphite" dir="auto">
                → {toolSummary(call)}
              </span>
            </dd>
          </div>
        ))}
        <Line label="Model">{turn.model}</Line>
        <Line label="Latency">{(turn.latencyMs / 1000).toFixed(2)} s</Line>
        <Line label={turn.model === 'mock' ? 'Tokens, estimated' : 'Tokens in / out'}>
          {number.format(turn.inputTokens)} / {number.format(turn.outputTokens)}
        </Line>
        <Line label="Cost">{cost(turn.costMicros, turn.model)}</Line>
      </dl>
    </div>
  );
}

/** The order the assistant last looked up in this conversation's latest turn. */
export function LastOrder({ conversationId, turnId }: { conversationId: string; turnId: string }) {
  const [order, setOrder] = useState<OrderResult | null>(null);
  useEffect(() => {
    let live = true;
    inboxApi.explanation(conversationId, turnId).then(
      (turn) => {
        if (live) setOrder(lastOrder(turn));
      },
      () => {
        // The order panel is a convenience; the receipt shows any error.
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, turnId]);

  if (!order) return null;
  return (
    <section aria-labelledby="order-heading" className="border-b border-rule p-4">
      <h2 id="order-heading" className="text-label font-semibold text-graphite">
        Order {order.order_number}
      </h2>
      <p className="mt-1 text-list">
        {orderStatusWord(order.status)}
        {order.courier ? ` · ${order.courier}` : ''}
      </p>
      <p className="text-list">{promisedText(order)}</p>
      <ul className="mt-1 text-list text-graphite">
        {order.items.map((item) => (
          <li key={item.name} dir="auto">
            {item.quantity} × {item.name}
          </li>
        ))}
      </ul>
      {order.total ? (
        <p className="mono mt-1 text-meta">
          {order.currency} {order.total}
        </p>
      ) : null}
    </section>
  );
}
