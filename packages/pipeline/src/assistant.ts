import {
  buildRequest,
  completeValidated,
  costMicros,
  detectLanguage,
  HANDOFF_REASON_TEXT,
  HANDOFF_REASONS,
  handoffNotice,
  NOTICE_LOCALES,
  outsideHoursLine,
  ModelUnavailableError,
  ungroundedFigures,
  type BusinessProfile,
  type FinalAnswer,
  type HandoffReason,
  type HistoryMessage,
  type ModelContent,
  type ModelRequest,
  type RetrievedPassage,
  type ToolCall,
} from '@app/assistant';
import { schema, withTenant, type Transaction } from '@app/db';
import { describeHours, nextOpening, type OpeningHours } from '@app/shared';
import { spokenLanguageOf } from '@app/voice';
import type { Job } from 'bullmq';
import { and, count, desc, eq, gt, inArray, lt, max, notInArray, sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import { transitionConversation } from './conversations.js';
import { nowOf, type PipelineDeps } from './deps.js';
import { retrievePassages } from './knowledge.js';
import { OwnershipError, queueReply } from './outbound.js';
import { assistantJobSchema, enqueueOutbound, type AssistantJob } from './queues.js';
import { assistantSpeaks, escalationKeywordIn } from './rules.js';

type Outcome = (typeof schema.assistantOutcome.enumValues)[number];

/** Model calls per turn: up to three rounds of tools, then the answer. */
export const MAX_MODEL_CALLS = 4;

/** A turn that cannot succeed by retrying: hand over now. */
class TurnFailure extends Error {}

interface Context {
  business: BusinessProfile;
  budget: number;
  turnsPerHour: number;
  customerId: string;
  /** Answer a voice note with a voice note (tenant setting). */
  voiceReplies: boolean;
  /** Escalation rules (tenant settings). */
  escalationKeywords: string[];
  maxAssistantReplies: number | null;
  openingHours: OpeningHours | null;
  outsideHoursNotice: boolean;
  /** Customer messages since the business last wrote, oldest first. */
  pending: PendingMessage[];
  history: HistoryMessage[];
}

interface PendingMessage {
  id: string;
  /** As the model sees it, e.g. "[Voice note] …". */
  text: string;
  /** The customer's own words, for language detection and retrieval. */
  words: string;
  voice: 'none' | 'transcribed' | 'untranscribed';
}

function describe(message: typeof schema.messages.$inferSelect): string {
  switch (message.kind) {
    case 'text':
      return message.body ?? '';
    case 'image':
      return `[Photo${message.media?.caption ? `: ${message.media.caption}` : ''}]`;
    case 'document':
      return `[Document${message.media?.filename ? ` ${message.media.filename}` : ''}${
        message.media?.caption ? `: ${message.media.caption}` : ''
      }]`;
    case 'audio': {
      const t = message.transcript;
      if (t?.status === 'done') return `[Voice note] ${t.text}`;
      return t?.status === 'failed'
        ? '[Voice note that could not be transcribed]'
        : '[Voice note, not transcribed yet]';
    }
    case 'template':
      return `[Template message: ${message.templateName ?? 'unnamed'}]`;
    default:
      return '[A message type the inbox cannot show]';
  }
}

/**
 * Loads what the turn needs, or null when there is nothing to do: a person
 * holds the conversation, this message was already answered, or a newer
 * customer message will be answered by its own job.
 */
async function loadContext(tx: Transaction, job: AssistantJob): Promise<Context | null> {
  const m = schema.messages;
  const [conversation] = await tx
    .select({ state: schema.conversations.state, customerId: schema.conversations.customerId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversationId));
  if (conversation?.state !== 'assistant') return null;

  const [answered] = await tx
    .select({ id: schema.assistantTurns.id })
    .from(schema.assistantTurns)
    .where(eq(schema.assistantTurns.triggerMessageId, job.messageId));
  if (answered) return null;

  const [lastOutbound] = await tx
    .select({ at: m.createdAt })
    .from(m)
    .where(
      and(
        eq(m.conversationId, job.conversationId),
        eq(m.direction, 'outbound'),
        notInArray(m.status, ['failed', 'cancelled']),
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(1);

  const pendingRows = await tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.conversationId, job.conversationId),
        eq(m.direction, 'inbound'),
        lastOutbound ? gt(m.createdAt, lastOutbound.at) : undefined,
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(20);
  pendingRows.reverse();
  if (pendingRows.at(-1)?.id !== job.messageId) return null;
  const first = pendingRows[0];
  if (!first) return null;
  // A voice note still being transcribed: its transcript queues this turn again.
  if (pendingRows.some((row) => row.transcript?.status === 'pending')) return null;

  const earlier = await tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.conversationId, job.conversationId),
        lt(m.createdAt, first.createdAt),
        notInArray(m.status, ['failed', 'cancelled']),
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(12);

  const [tenant] = await tx
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, job.tenantId));
  if (!tenant) return null;
  return {
    business: {
      name: tenant.name,
      summary: tenant.assistantSummary,
      timezone: tenant.timezone,
      tone: tenant.assistantTone,
      hours: tenant.openingHours ? describeHours(tenant.openingHours) : null,
    },
    budget: tenant.assistantDailyTokenBudget,
    turnsPerHour: tenant.assistantTurnsPerCustomerHour,
    customerId: conversation.customerId,
    voiceReplies: tenant.voiceReplies,
    escalationKeywords: tenant.escalationKeywords,
    maxAssistantReplies: tenant.maxAssistantReplies,
    openingHours: tenant.openingHours,
    outsideHoursNotice: tenant.outsideHoursNotice,
    pending: pendingRows.map((row): PendingMessage => {
      const transcript = row.kind === 'audio' ? row.transcript : null;
      return {
        id: row.id,
        text: describe(row),
        words:
          transcript?.status === 'done'
            ? transcript.text
            : row.kind === 'audio'
              ? ''
              : describe(row),
        voice:
          row.kind !== 'audio'
            ? 'none'
            : transcript?.status === 'done'
              ? 'transcribed'
              : 'untranscribed',
      };
    }),
    history: earlier.reverse().map((row) => ({
      from: row.direction === 'inbound' ? ('customer' as const) : ('business' as const),
      text: describe(row),
    })),
  };
}

/** The business's calendar day, so the budget resets at local midnight. */
export function localDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const lookupOrderInput = z.object({ order_number: z.string().trim().min(1).max(40) });
const handoffInput = z.object({
  reason: z.enum(HANDOFF_REASONS),
  summary: z.string().trim().max(200).default(''),
});

const normaliseOrderNumber = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface ToolOutcome {
  content: string;
  isError: boolean;
  recorded: unknown;
}

/**
 * Runs one tool call. Authorisation lives here, not in the prompt: an order
 * is returned only to the customer who placed it, so no wording in a message
 * or document can make the assistant read out someone else's order.
 */
async function runTool(
  deps: PipelineDeps,
  tenantId: string,
  context: Context,
  call: ToolCall,
  onHandoff: (reason: HandoffReason, summary: string) => void,
): Promise<ToolOutcome> {
  if (call.name === 'lookup_order') {
    const input = lookupOrderInput.safeParse(call.input);
    if (!input.success) {
      return { content: 'order_number must be a short string.', isError: true, recorded: null };
    }
    const wanted = normaliseOrderNumber(input.data.order_number);
    const o = schema.orders;
    const [order] = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select()
        .from(o)
        .where(sql`regexp_replace(upper(${o.orderNumber}), '[^A-Z0-9]', '', 'g') = ${wanted}`)
        .limit(1),
    );
    const result =
      order && order.customerId === context.customerId
        ? {
            found: true,
            order_number: order.orderNumber,
            status: order.status,
            items: order.items,
            total: order.total,
            currency: order.currency,
            courier: order.courier,
            tracking_number: order.trackingNumber,
            promised_date: order.promisedDate,
            placed_on: order.placedAt.toISOString().slice(0, 10),
          }
        : // Someone else's order looks exactly like no order.
          { found: false };
    return { content: JSON.stringify(result), isError: false, recorded: result };
  }
  if (call.name === 'handoff') {
    const input = handoffInput.safeParse(call.input);
    if (!input.success) {
      return {
        content: `reason must be one of: ${HANDOFF_REASONS.join(', ')}.`,
        isError: true,
        recorded: null,
      };
    }
    onHandoff(input.data.reason, input.data.summary);
    const result = { ok: true, note: 'A person will take over after your reply.' };
    return { content: JSON.stringify(result), isError: false, recorded: result };
  }
  return { content: `There is no tool called ${call.name}.`, isError: true, recorded: null };
}

interface TurnRecord {
  outcome: Outcome;
  reply: string | null;
  /** Moves the conversation to waiting_for_human with this reason. */
  handoff: string | null;
  basis: string | null;
  language: string | null;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  passages: RetrievedPassage[];
  toolCalls: { name: string; input: unknown; result: unknown }[];
  detail: string | null;
  /** Code for analytics when the conversation goes to a person (see HANDOFF_CODES). */
  handoffReason: string | null;
}

/**
 * One assistant turn for the newest unanswered customer message.
 * `lastAttempt` is true on the job's final try: a transient error then hands
 * the conversation to a person instead of leaving the customer unanswered.
 */
export async function runAssistantTurn(
  deps: PipelineDeps,
  job: AssistantJob,
  options: { lastAttempt: boolean },
): Promise<Outcome | null> {
  const started = performance.now();
  const now = nowOf(deps);
  const context = await withTenant(deps.db, job.tenantId, (tx) => loadContext(tx, job));
  if (!context) return null;

  const customerText = context.pending
    .map((p) => p.words)
    .filter(Boolean)
    .join('\n');
  const notice = handoffNotice(customerText);
  const record: TurnRecord = {
    outcome: 'replied',
    reply: null,
    handoff: null,
    basis: null,
    language: detectLanguage(customerText),
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    passages: [],
    toolCalls: [],
    detail: null,
    handoffReason: null,
  };

  const limits = await withTenant(deps.db, job.tenantId, async (tx) => {
    const [recent] = await tx
      .select({ n: count() })
      .from(schema.assistantTurns)
      .where(
        and(
          eq(schema.assistantTurns.customerId, context.customerId),
          gt(schema.assistantTurns.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      );
    const [usage] = await tx
      .select()
      .from(schema.assistantUsageDaily)
      .where(eq(schema.assistantUsageDaily.day, localDay(now, context.business.timezone)));
    // Replies since the assistant last took the conversation (it started, or was handed back).
    const [since] = await tx
      .select({ at: max(schema.conversationTransitions.createdAt) })
      .from(schema.conversationTransitions)
      .where(
        and(
          eq(schema.conversationTransitions.conversationId, job.conversationId),
          eq(schema.conversationTransitions.toState, 'assistant'),
        ),
      );
    const [replies] = await tx
      .select({ n: count() })
      .from(schema.assistantTurns)
      .where(
        and(
          eq(schema.assistantTurns.conversationId, job.conversationId),
          inArray(schema.assistantTurns.outcome, ['replied', 'declined']),
          since?.at ? gt(schema.assistantTurns.createdAt, since.at) : undefined,
        ),
      );
    return {
      turnsThisHour: recent?.n ?? 0,
      tokensToday: usage ? usage.inputTokens + usage.outputTokens : 0,
      repliesSoFar: replies?.n ?? 0,
    };
  });
  const keyword = escalationKeywordIn(customerText, context.escalationKeywords);

  if (limits.turnsThisHour >= context.turnsPerHour) {
    // Likely spam or a loop: stop answering, no message back, and let a person look.
    Object.assign(record, {
      outcome: 'rate_limited',
      handoffReason: 'rate_limited',
      handoff: 'Many messages in an hour; the assistant stopped replying',
      detail: `${String(limits.turnsThisHour)} turns in the last hour`,
    });
  } else if (context.pending.some((p) => p.voice === 'untranscribed')) {
    // Never guess what someone said: a person listens to it.
    Object.assign(record, {
      outcome: 'handed_off',
      reply: notice.text,
      handoffReason: 'voice_untranscribed',
      handoff: 'Voice note could not be transcribed',
      detail: 'a voice note in this turn has no transcript',
    });
  } else if (keyword) {
    // The owner's rule: these topics always go to a person, before any model call.
    Object.assign(record, {
      outcome: 'handed_off',
      reply: notice.text,
      handoffReason: 'escalation_keyword',
      handoff: `Mentioned "${keyword}" (escalation rule)`,
      detail: `escalation keyword: ${keyword}`,
    });
  } else if (
    context.maxAssistantReplies !== null &&
    limits.repliesSoFar >= context.maxAssistantReplies
  ) {
    Object.assign(record, {
      outcome: 'handed_off',
      reply: notice.text,
      handoffReason: 'reply_limit',
      handoff: `Assistant reached ${String(context.maxAssistantReplies)} replies (escalation rule)`,
      detail: `${String(limits.repliesSoFar)} replies in this conversation`,
    });
  } else if (limits.tokensToday >= context.budget) {
    Object.assign(record, {
      outcome: 'budget_exhausted',
      handoffReason: 'budget_exhausted',
      reply: notice.text,
      handoff: "Assistant's daily budget is used up",
      detail: `${String(limits.tokensToday)} of ${String(context.budget)} tokens used today`,
    });
  } else {
    await answer(deps, job, context, record, now, notice.text, options.lastAttempt);
  }

  // Handing over after hours: say when a person will actually read it.
  const opens =
    record.handoff && record.reply && context.outsideHoursNotice
      ? nextOpening(context.openingHours, context.business.timezone, now)
      : null;
  if (opens && record.reply) {
    const when = new Intl.DateTimeFormat(NOTICE_LOCALES[notice.language], {
      timeZone: context.business.timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(opens);
    record.reply = `${record.reply}\n${outsideHoursLine(notice.language, when)}`;
  }

  return commit(deps, job, context, record, now, Math.round(performance.now() - started));
}

async function answer(
  deps: PipelineDeps,
  job: AssistantJob,
  context: Context,
  record: TurnRecord,
  now: Date,
  noticeText: string,
  lastAttempt: boolean,
): Promise<void> {
  const model = deps.assistant.model;
  const fail = (outcome: Outcome, handoff: string, detail: string) => {
    Object.assign(record, {
      outcome,
      reply: noticeText,
      handoff,
      detail,
      basis: null,
      handoffReason: outcome,
    });
  };
  try {
    const query = context.pending.map((p) => p.words).join('\n');
    record.passages = await withTenant(deps.db, job.tenantId, (tx) =>
      retrievePassages(tx, deps.assistant.embedder, query),
    );

    let request: ModelRequest = buildRequest({
      business: context.business,
      history: context.history,
      pending: context.pending.map((p) => p.text),
      passages: record.passages,
      today: localDay(now, context.business.timezone),
      maxTokens: deps.assistant.settings.maxOutputTokens,
    });
    const handoff: { chosen: { reason: HandoffReason; summary: string } | null } = {
      chosen: null,
    };
    let final: FinalAnswer | null = null;

    for (;;) {
      if (record.modelCalls >= MAX_MODEL_CALLS) {
        throw new TurnFailure(`no answer after ${String(MAX_MODEL_CALLS)} model calls`);
      }
      const response = await completeValidated(model, request);
      record.modelCalls += 1;
      record.inputTokens += response.usage.inputTokens;
      record.outputTokens += response.usage.outputTokens;
      if (response.result.type === 'answer') {
        final = response.result.answer;
        break;
      }
      const uses: ModelContent[] = [];
      const results: ModelContent[] = [];
      for (const call of response.result.calls) {
        const outcome = await runTool(deps, job.tenantId, context, call, (reason, summary) => {
          handoff.chosen = { reason, summary };
        });
        record.toolCalls.push({ name: call.name, input: call.input, result: outcome.recorded });
        uses.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: outcome.content,
          isError: outcome.isError,
        });
      }
      request = {
        ...request,
        messages: [
          ...request.messages,
          { role: 'assistant', content: uses },
          { role: 'user', content: results },
        ],
      };
    }

    // Grounding guard: every figure must come from what the model was shown.
    const evidence = [
      ...record.passages.map((p) => `${p.heading ?? ''} ${p.text}`),
      ...record.toolCalls.map((c) => JSON.stringify(c.result)),
      ...context.pending.map((p) => p.text),
      ...context.history.map((h) => h.text),
      context.business.hours ?? '',
    ];
    const invented = ungroundedFigures(final.reply, evidence);
    record.basis = final.basis;
    if (invented.length > 0) {
      fail(
        'guard_blocked',
        'Assistant reply held back: it had a figure not found in the knowledge base',
        `figures not in evidence: ${invented.join(', ')}`,
      );
      return;
    }
    const chosen = handoff.chosen;
    Object.assign(record, {
      outcome: chosen ? 'handed_off' : final.basis === 'declined' ? 'declined' : 'replied',
      reply: final.reply,
      handoff: chosen
        ? `${HANDOFF_REASON_TEXT[chosen.reason]}${chosen.summary ? `: ${chosen.summary}` : ''}`
        : null,
      handoffReason: chosen ? chosen.reason : null,
    });
  } catch (error) {
    const permanent =
      error instanceof TurnFailure ||
      error instanceof ModelUnavailableError ||
      error instanceof ZodError;
    if (!permanent && !lastAttempt) throw error;
    const reason =
      error instanceof ZodError
        ? 'model response did not match the expected shape'
        : error instanceof Error
          ? error.message.slice(0, 200)
          : 'unknown error';
    fail('failed', 'The assistant could not answer', reason);
  }
}

async function commit(
  deps: PipelineDeps,
  job: AssistantJob,
  context: Context,
  record: TurnRecord,
  now: Date,
  latencyMs: number,
): Promise<Outcome> {
  const cost = costMicros(deps.assistant.model.name, record);
  const result = await withTenant(deps.db, job.tenantId, async (tx) => {
    let replyId: string | null = null;
    if (record.reply) {
      // Spoken back when the customer spoke, if the business allows it.
      const language = spokenLanguageOf(record.language ?? '');
      const speak =
        language !== null &&
        assistantSpeaks(context.voiceReplies, context.pending.at(-1)?.voice === 'transcribed');
      try {
        replyId = await queueReply(tx, {
          conversationId: job.conversationId,
          sender: { type: 'assistant' },
          content: speak
            ? { kind: 'voice', body: record.reply, language }
            : { kind: 'text', body: record.reply },
          now,
        });
      } catch (error) {
        if (!(error instanceof OwnershipError)) throw error;
        // A person took over while the model was thinking: their word wins.
        record.outcome = 'skipped';
        record.handoff = null;
        record.detail = 'A person took over before the reply was ready';
      }
    }
    if (record.handoff) {
      await transitionConversation(tx, {
        conversationId: job.conversationId,
        to: 'waiting_for_human',
        actor: { type: 'assistant' },
        reason: record.handoff,
        from: ['assistant'],
      });
    }
    const [turn] = await tx
      .insert(schema.assistantTurns)
      .values({
        tenantId: job.tenantId,
        conversationId: job.conversationId,
        customerId: context.customerId,
        triggerMessageId: job.messageId,
        replyMessageId: replyId,
        model: deps.assistant.model.name,
        outcome: record.outcome,
        basis: record.basis,
        language: record.language,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costMicros: cost,
        latencyMs,
        modelCalls: record.modelCalls,
        passages: record.passages.map((p) => ({
          passageId: p.id,
          sourceId: p.sourceId,
          sourceTitle: p.sourceTitle,
          heading: p.heading,
          score: p.score,
        })),
        toolCalls: record.toolCalls,
        detail: record.detail,
        // A person took over first (skipped): nothing was handed over.
        handoffReason: record.handoff ? record.handoffReason : null,
      })
      .returning({ id: schema.assistantTurns.id });

    const u = schema.assistantUsageDaily;
    await tx
      .insert(u)
      .values({
        tenantId: job.tenantId,
        day: localDay(now, context.business.timezone),
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costMicros: cost,
        turns: 1,
      })
      .onConflictDoUpdate({
        target: [u.tenantId, u.day],
        set: {
          inputTokens: sql`${u.inputTokens} + excluded.input_tokens`,
          outputTokens: sql`${u.outputTokens} + excluded.output_tokens`,
          costMicros: sql`${u.costMicros} + excluded.cost_micros`,
          turns: sql`${u.turns} + 1`,
        },
      });
    return { replyId, turnId: turn?.id ?? null };
  });

  if (result.replyId) {
    await enqueueOutbound(deps.queues, { tenantId: job.tenantId, messageId: result.replyId });
  }
  await deps.events.conversationChanged(job.tenantId, job.conversationId);
  // No message text in logs (brief §4): IDs, outcome and measurements only.
  deps.logger.info(
    {
      conversationId: job.conversationId,
      turnId: result.turnId,
      outcome: record.outcome,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costMicros: cost,
      latencyMs,
    },
    'assistant turn',
  );
  return record.outcome;
}

/** BullMQ processor for the assistant queue. */
export async function processAssistantJob(deps: PipelineDeps, job: Job): Promise<void> {
  const data = assistantJobSchema.parse(job.data);
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  await runAssistantTurn(deps, data, { lastAttempt });
}
