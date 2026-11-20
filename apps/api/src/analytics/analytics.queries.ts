import { schema, type Transaction } from '@app/db';
import { isOpen, type Analytics, type AnalyticsDay } from '@app/shared';
import { sql } from 'drizzle-orm';

/**
 * The analytics page's numbers, computed on read inside the tenant's
 * transaction. Days are the business's local days. Definitions (D-084):
 * - a conversation counts on the day it started;
 * - "assistant only": it never went to a person; "waiting": waiting for one
 *   now; "a person took part": everything else (the three add up);
 * - reply time: customer message → assistant reply sent;
 * - cost per conversation: model cost of its turns ÷ conversations;
 * - human reply time: waiting for a person → first staff message.
 */

/** Linear interpolation between ranks, like Postgres percentile_cont. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return Math.round(a + (b - a) * (rank - low));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The N local dates ending today, oldest first, as YYYY-MM-DD. */
function daysEnding(today: string, n: number, offset = 0): string[] {
  const end = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - offset - (n - 1 - i));
    return isoDay(d);
  });
}

interface DayRow extends Record<string, unknown> {
  day: string;
  conversations: number;
  assistant_only: number;
  waiting: number;
  cost: string;
}

export async function analytics(tx: Transaction, days: 7 | 30): Promise<Analytics> {
  const [tenant] = await tx
    .select({
      timezone: schema.tenants.timezone,
      openingHours: schema.tenants.openingHours,
    })
    .from(schema.tenants);
  if (!tenant) throw new Error('analytics: tenant not visible');
  const tz = tenant.timezone;
  const local = (column: unknown) => sql`(${column} at time zone ${tz})::date`;
  const since = sql`(now() at time zone ${tz})::date - ${2 * days - 1}::int`;

  const todayRow = await tx.execute<{ today: string }>(
    sql`select to_char((now() at time zone ${tz})::date, 'YYYY-MM-DD') as today`,
  );
  const today = todayRow.rows[0]?.today ?? isoDay(new Date());
  const current = daysEnding(today, days);
  const previous = daysEnding(today, days, days);

  const dayRows = await tx.execute<DayRow>(sql`
    select to_char(${local(sql`c.created_at`)}, 'YYYY-MM-DD') as day,
           count(*)::int as conversations,
           count(*) filter (where not exists (
             select 1 from conversation_transitions t
             where t.conversation_id = c.id and t.to_state in ('waiting_for_human', 'human')
           ))::int as assistant_only,
           count(*) filter (where c.state = 'waiting_for_human')::int as waiting,
           coalesce(sum(tc.cost), 0)::text as cost
    from conversations c
    left join lateral (
      select coalesce(sum(t.cost_micros), 0) as cost from assistant_turns t
      where t.conversation_id = c.id
    ) tc on true
    where ${local(sql`c.created_at`)} >= ${since}
    group by 1`);

  const handoffRows = await tx.execute<{ day: string; n: number }>(sql`
    select to_char(${local(sql`t.created_at`)}, 'YYYY-MM-DD') as day, count(*)::int as n
    from conversation_transitions t
    where t.to_state = 'waiting_for_human' and ${local(sql`t.created_at`)} >= ${since}
    group by 1`);

  const replyRows = await tx.execute<{ day: string; ms: number }>(sql`
    select to_char(${local(sql`t.created_at`)}, 'YYYY-MM-DD') as day,
           (extract(epoch from (r.sent_at - coalesce(m.wa_timestamp, m.created_at))) * 1000)::int as ms
    from assistant_turns t
    join messages r on r.id = t.reply_message_id
    join messages m on m.id = t.trigger_message_id
    where r.sent_at is not null and ${local(sql`t.created_at`)} >= ${since}`);

  const periodStart = sql`(now() at time zone ${tz})::date - ${days - 1}::int`;
  const reasonRows = await tx.execute<{ code: string; n: number }>(sql`
    select code, count(*)::int as n from (
      select t.handoff_reason as code from assistant_turns t
      where t.handoff_reason is not null and ${local(sql`t.created_at`)} >= ${periodStart}
      union all
      select 'taken_over' from conversation_transitions t
      where t.from_state = 'assistant' and t.to_state = 'human' and t.actor_type = 'user'
        and ${local(sql`t.created_at`)} >= ${periodStart}
    ) reasons
    group by code order by n desc, code`);

  const waitRows = await tx.execute<{ waited_at: Date; replied_at: Date | null }>(sql`
    select w.created_at as waited_at,
           (select min(m.created_at) from messages m
            where m.conversation_id = w.conversation_id and m.direction = 'outbound'
              and m.sender_type = 'user' and m.created_at > w.created_at) as replied_at
    from conversation_transitions w
    where w.to_state = 'waiting_for_human' and ${local(sql`w.created_at`)} >= ${periodStart}`);

  const byDate = new Map(dayRows.rows.map((r) => [r.day, r]));
  const handoffs = new Map(handoffRows.rows.map((r) => [r.day, r.n]));
  const replies = new Map<string, number[]>();
  for (const r of replyRows.rows) {
    if (r.ms < 0) continue; // clock skew between WhatsApp's timestamp and ours
    replies.set(r.day, [...(replies.get(r.day) ?? []), r.ms]);
  }

  const perConversation = (cost: number, n: number) => (n > 0 ? Math.round(cost / n) : null);
  const totalsOf = (dates: string[]) => {
    let conversations = 0;
    let assistantOnly = 0;
    let cost = 0;
    for (const d of dates) {
      const row = byDate.get(d);
      conversations += row?.conversations ?? 0;
      assistantOnly += row?.assistant_only ?? 0;
      cost += Number(row?.cost ?? 0);
    }
    return {
      conversations,
      assistantOnly,
      costPerConversationMicros: perConversation(cost, conversations),
    };
  };

  const byDay: AnalyticsDay[] = current.map((date) => {
    const row = byDate.get(date);
    const conversations = row?.conversations ?? 0;
    const assistantOnly = row?.assistant_only ?? 0;
    const waiting = row?.waiting ?? 0;
    const ms = replies.get(date) ?? [];
    return {
      date,
      conversations,
      assistantOnly,
      waiting,
      personTookPart: conversations - assistantOnly - waiting,
      handoffs: handoffs.get(date) ?? 0,
      replyMedianMs: percentile(ms, 0.5),
      replyP95Ms: percentile(ms, 0.95),
      costPerConversationMicros: perConversation(Number(row?.cost ?? 0), conversations),
    };
  });

  const periodReplies = current.flatMap((d) => replies.get(d) ?? []);
  const answered = waitRows.rows
    .filter((w) => w.replied_at)
    .map((w) => ({
      ms: new Date(w.replied_at as Date).getTime() - new Date(w.waited_at).getTime(),
      closed: !isOpen(tenant.openingHours, tz, new Date(w.waited_at)),
    }));
  const afterHours = answered.filter((a) => a.closed).map((a) => a.ms);

  return {
    days,
    timezone: tz,
    summary: {
      ...totalsOf(current),
      replyMedianMs: percentile(periodReplies, 0.5),
      replyP95Ms: percentile(periodReplies, 0.95),
      previous: totalsOf(previous),
    },
    byDay,
    reasons: reasonRows.rows.map((r) => ({ code: r.code, count: r.n })),
    humanReply: {
      count: answered.length,
      medianMs: percentile(
        answered.map((a) => a.ms),
        0.5,
      ),
      p95Ms: percentile(
        answered.map((a) => a.ms),
        0.95,
      ),
      outsideHours: tenant.openingHours
        ? { count: afterHours.length, medianMs: percentile(afterHours, 0.5) }
        : null,
    },
  };
}
