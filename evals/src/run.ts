import { execSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { seedBusinessKnowledge, demoTenants, upsertTenant } from '@app/api/seed';
import { MockChatModel, MockEmbedder, type ChatModel, type Embedder } from '@app/assistant';
import {
  bootstrapRoles,
  createDb,
  migrate,
  recreateDatabase,
  schema,
  withDatabase,
  type DbHandle,
} from '@app/db';
import { BedrockChatModel, BedrockEmbedder } from '@app/live';
import {
  createQueues,
  LocalDiskStorage,
  pipelineEnvSchema,
  pipelineSettings,
  ProviderRegistry,
  runAssistantTurn,
  type PipelineDeps,
} from '@app/pipeline';
import { createLogger, DEMO_CUSTOMERS } from '@app/shared';
import { MockSpeechToText, MockTextToSpeech } from '@app/voice';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { CASES, type EvalCase } from './cases.js';
import { score, type Scored, type TurnTrace, type Verdict } from './checks.js';
import { Judge } from './judge.js';
import { renderReport, type CaseResult, type ModelRun } from './report.js';

/**
 * `pnpm eval` (live Bedrock) and `pnpm eval:mock` (offline). Runs every case
 * through the production assistant code (`runAssistantTurn`: retrieval, the
 * model, tools, guards) in a separate database, `app_eval`, recreated each
 * run, and writes docs/EVALS.md from the stored turns.
 */
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // The environment may be set directly.
}

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    models: { type: 'string' },
    judge: { type: 'string' },
    only: { type: 'string' },
  },
});
const env = process.env;
const live = values.live;
const region = env['AWS_REGION'] ?? 'ap-south-1';
const modelIds = live
  ? (values.models ?? 'anthropic.claude-haiku-5-5,anthropic.claude-haiku-4-5').split(',')
  : ['mock'];
const judgeModel = values.judge ?? env['EVAL_JUDGE_MODEL'] ?? 'anthropic.claude-sonnet-5-5';
const cases = values.only ? CASES.filter((c) => c.id.startsWith(values.only ?? '')) : CASES;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

async function prepareDatabase(): Promise<{ migrator: DbHandle; app: DbHandle }> {
  const urls = {
    superuser: withDatabase(required('DATABASE_SUPERUSER_URL'), 'app_eval'),
    migrator: withDatabase(required('DATABASE_MIGRATOR_URL'), 'app_eval'),
    user: withDatabase(required('DATABASE_URL'), 'app_eval'),
    platform: withDatabase(required('DATABASE_PLATFORM_URL'), 'app_eval'),
  };
  await recreateDatabase(withDatabase(urls.superuser, 'postgres'), 'app_eval');
  await bootstrapRoles(urls);
  await migrate(urls.migrator);
  return { migrator: createDb(urls.migrator, { max: 2 }), app: createDb(urls.user, { max: 4 }) };
}

// Turn errors are recorded on the turn itself; the eval prints its own lines.
const silent = createLogger({
  service: 'eval',
  level: 'error',
  destination: new Writable({
    write: (_chunk, _encoding, done) => {
      done();
    },
  }),
});

/** One copy of each demo business for this model: same knowledge, orders and settings. */
async function businesses(
  migrator: DbHandle,
  storage: LocalDiskStorage,
  embedder: Embedder,
  label: string,
): Promise<Record<string, { tenantId: string; channelId: string }>> {
  const out: Record<string, { tenantId: string; channelId: string }> = {};
  for (const demo of demoTenants('unused-password')) {
    const tenantId = await upsertTenant(migrator.db, {
      ...demo,
      slug: `eval-${label}-${demo.slug}`,
      members: [],
      channel: {
        phoneNumberId: `9${String(randomInt(1e9, 1e10 - 1))}${String(randomInt(1e4, 1e5 - 1))}`,
        displayPhoneNumber: demo.channel?.displayPhoneNumber ?? '+0',
      },
    });
    // Budgets out of the way: the eval measures answers, not limits.
    await migrator.db
      .update(schema.tenants)
      .set({ assistantDailyTokenBudget: 10_000_000, assistantTurnsPerCustomerHour: 200 })
      .where(eq(schema.tenants.id, tenantId));
    const customers = DEMO_CUSTOMERS.filter((c) => c.business === demo.slug);
    if (customers.length) {
      await migrator.db
        .insert(schema.customers)
        .values(
          customers.map((c) => ({ tenantId, bsuid: c.bsuid, waId: c.waId, profileName: c.name })),
        );
    }
    await seedBusinessKnowledge(migrator.db, storage, {
      tenantId,
      slug: demo.slug,
      embedder,
      now: Date.now(),
    });
    const [channel] = await migrator.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.tenantId, tenantId));
    if (!channel) throw new Error('eval: business without a channel');
    out[demo.slug] = { tenantId, channelId: channel.id };
  }
  return out;
}

let conversationNumber = 1;

/** The row an insert returned; a missing one is a bug in the eval, not a result. */
function only<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`eval: the ${what} insert returned no row`);
  return row;
}

/** Stores the case as a customer conversation and runs one assistant turn on it. */
async function runCase(
  deps: PipelineDeps,
  migrator: DbHandle,
  business: { tenantId: string; channelId: string },
  testCase: EvalCase,
): Promise<TurnTrace> {
  const { tenantId, channelId } = business;
  const demo = testCase.customer
    ? DEMO_CUSTOMERS.find((c) => c.name === testCase.customer)
    : undefined;
  let customerId: string;
  if (demo) {
    const [row] = await migrator.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.bsuid, demo.bsuid));
    if (!row) throw new Error(`eval: no customer ${demo.name}`);
    customerId = row.id;
  } else {
    const [row] = await migrator.db
      .insert(schema.customers)
      .values({ tenantId, bsuid: `EVAL.${randomUUID()}`, profileName: 'Eval customer' })
      .returning({ id: schema.customers.id });
    customerId = only(row, 'customer').id;
  }
  const now = Date.now();
  const [conversation] = await migrator.db
    .insert(schema.conversations)
    .values({
      tenantId,
      channelId,
      customerId,
      number: conversationNumber++,
      lastInboundAt: new Date(now),
      lastMessageAt: new Date(now),
    })
    .returning({ id: schema.conversations.id });
  const conversationId = only(conversation, 'conversation').id;
  await migrator.db.insert(schema.conversationTransitions).values({
    tenantId,
    conversationId,
    fromState: null,
    toState: 'assistant',
    actorType: 'system',
    reason: 'Customer started a conversation',
    createdAt: new Date(now - 60_000),
  });
  let lastId = '';
  for (const [i, text] of testCase.messages.entries()) {
    const at = new Date(now - (testCase.messages.length - i) * 1_000);
    const [message] = await migrator.db
      .insert(schema.messages)
      .values({
        tenantId,
        channelId,
        conversationId,
        direction: 'inbound',
        kind: 'text',
        senderType: 'customer',
        waMessageId: `wamid.EVAL${randomUUID()}`,
        body: text,
        status: 'received',
        statusAt: at,
        waTimestamp: at,
        createdAt: at,
      })
      .returning({ id: schema.messages.id });
    lastId = only(message, 'message').id;
  }

  await runAssistantTurn(
    deps,
    { tenantId, conversationId, messageId: lastId },
    { lastAttempt: true },
  );

  const [turn] = await migrator.db
    .select()
    .from(schema.assistantTurns)
    .where(eq(schema.assistantTurns.triggerMessageId, lastId));
  if (!turn) throw new Error('eval: the turn was not recorded');
  const [reply] = turn.replyMessageId
    ? await migrator.db
        .select({ body: schema.messages.body })
        .from(schema.messages)
        .where(eq(schema.messages.id, turn.replyMessageId))
    : [];
  const passageIds = turn.passages.map((p) => p.passageId);
  const passages = passageIds.length
    ? await migrator.db
        .select({ heading: schema.knowledgePassages.heading, text: schema.knowledgePassages.text })
        .from(schema.knowledgePassages)
        .where(inArray(schema.knowledgePassages.id, passageIds))
    : [];
  // Closed, so the next case for the same customer opens a new conversation.
  await migrator.db
    .update(schema.conversations)
    .set({ state: 'closed' })
    .where(eq(schema.conversations.id, conversationId));

  return {
    outcome: turn.outcome,
    basis: turn.basis,
    handoffReason: turn.handoffReason,
    reply: reply?.body ?? null,
    latencyMs: turn.latencyMs,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    costMicros: turn.costMicros,
    evidence: [
      ...passages.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)),
      ...turn.toolCalls.map((c) => `${c.name} → ${JSON.stringify(c.result)}`),
    ],
  };
}

async function main(): Promise<void> {
  const started = new Date();
  const { migrator, app } = await prepareDatabase();
  const redis = new Redis(required('REDIS_URL'), { maxRetriesPerRequest: null });
  const prefix = `eval-${String(started.getTime())}`;
  const settings = pipelineSettings(pipelineEnvSchema.parse({}));
  const queues = createQueues(redis, settings, prefix);
  const storage = new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'eval-')));
  const embedder: Embedder = live
    ? new BedrockEmbedder({
        model: env['BEDROCK_EMBED_MODEL'] ?? 'cohere.embed-multilingual-v3',
        region,
      })
    : new MockEmbedder();
  const judge = live ? new Judge(judgeModel, region) : null;
  const runs: ModelRun[] = [];

  try {
    for (const [index, modelId] of modelIds.entries()) {
      const model: ChatModel = live
        ? new BedrockChatModel({ model: modelId, region })
        : new MockChatModel();
      const tenants = await businesses(migrator, storage, embedder, String(index));
      const deps: PipelineDeps = {
        db: app.db,
        queues,
        providers: new ProviderRegistry({}),
        storage,
        logger: silent,
        settings,
        events: { conversationChanged: () => Promise.resolve() },
        assistant: {
          model,
          embedder,
          settings: { enabled: true, debounceMs: 0, maxOutputTokens: 1_024 },
        },
        voice: { stt: new MockSpeechToText(), tts: new MockTextToSpeech() },
      };
      const results: CaseResult[] = [];
      for (const testCase of cases) {
        const business = tenants[testCase.business];
        if (!business) throw new Error(`eval: no business ${testCase.business}`);
        let trace: TurnTrace;
        let verdict: Verdict | null = null;
        let scored: Scored;
        try {
          trace = await runCase(deps, migrator, business, testCase);
          if (judge && trace.reply) {
            verdict = await judge.grade({
              messages: testCase.messages,
              evidence: trace.evidence,
              reply: trace.reply,
              language: testCase.language,
            });
          }
          scored = score(testCase, trace, verdict);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          trace = {
            outcome: 'error',
            basis: null,
            handoffReason: null,
            reply: null,
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costMicros: 0,
            evidence: [],
          };
          scored = {
            grounded: 'fail',
            handoff: 'fail',
            declined: 'fail',
            language: 'fail',
            notes: [`error: ${message.slice(0, 200)}`],
          };
        }
        results.push({ testCase, trace, verdict, scored });
        process.stdout.write(
          `${modelId} ${testCase.id}: ${scored.notes.length ? scored.notes.join('; ') : 'ok'}\n`,
        );
      }
      runs.push({ model: modelId, results });
    }
  } finally {
    await Promise.allSettled([
      queues.webhooks.obliterate({ force: true }),
      queues.outbound.obliterate({ force: true }),
    ]);
    await queues.close();
    redis.disconnect();
    await Promise.all([migrator.close(), app.close()]);
  }

  const sha = (() => {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const markdown = renderReport({
    live,
    startedAt: started.toISOString(),
    commit: sha,
    embedder: embedder.model,
    judge: judge ? judgeModel : null,
    runs,
  });
  writeFileSync(new URL('../../docs/EVALS.md', import.meta.url), markdown);
  const resultsDir = new URL('../results/', import.meta.url);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(new URL(`${prefix}.json`, resultsDir), JSON.stringify(runs, null, 2));
  process.stdout.write(`\nWrote docs/EVALS.md and evals/results/${prefix}.json\n`);
}

await main();
