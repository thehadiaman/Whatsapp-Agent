import { z } from 'zod';

/** Why a conversation went to a person (assistant_turns.handoff_reason, plus staff take-overs). */
export const HANDOFF_CODE_LABELS: Record<string, string> = {
  asked_for_person: 'Asked for a person',
  needs_person: 'Needs a person',
  complaint: 'Customer unhappy',
  not_in_knowledge: 'Not in the knowledge base',
  other: 'Assistant handed over',
  escalation_keyword: 'Escalation word',
  reply_limit: 'Reply limit reached',
  voice_untranscribed: 'Voice note not understood',
  guard_blocked: 'Reply held back by the figure check',
  budget_exhausted: 'Daily budget used up',
  rate_limited: 'Too many messages',
  failed: 'Assistant could not answer',
  taken_over: 'Staff took over',
};

export const analyticsPeriodSchema = z.coerce.number().pipe(z.union([z.literal(7), z.literal(30)]));

const ms = z.number().int().nullable();

export const analyticsDaySchema = z.object({
  /** The business's local date, YYYY-MM-DD. */
  date: z.string(),
  conversations: z.number().int(),
  /** Custody, as the chart draws it: never held by a person, a person took part, still waiting. */
  assistantOnly: z.number().int(),
  personTookPart: z.number().int(),
  waiting: z.number().int(),
  handoffs: z.number().int(),
  replyMedianMs: ms,
  replyP95Ms: ms,
  costPerConversationMicros: z.number().int().nullable(),
});
export type AnalyticsDay = z.infer<typeof analyticsDaySchema>;

const totals = z.object({
  conversations: z.number().int(),
  assistantOnly: z.number().int(),
  costPerConversationMicros: z.number().int().nullable(),
});

export const analyticsSchema = z.object({
  days: z.number().int(),
  timezone: z.string(),
  summary: totals.extend({
    replyMedianMs: ms,
    replyP95Ms: ms,
    /** The same numbers for the period before, for comparison. */
    previous: totals,
  }),
  byDay: z.array(analyticsDaySchema),
  reasons: z.array(z.object({ code: z.string(), count: z.number().int() })),
  /** From waiting for a person to the first reply by staff. */
  humanReply: z.object({
    count: z.number().int(),
    medianMs: ms,
    p95Ms: ms,
    /** Hand-overs that began while the business was closed. */
    outsideHours: z.object({ count: z.number().int(), medianMs: ms }).nullable(),
  }),
});
export type Analytics = z.infer<typeof analyticsSchema>;
