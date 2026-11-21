import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { createDb, schema } from '@app/db';
import { eq, sql } from 'drizzle-orm';

/**
 * `pnpm load-test` (brief §8): pushes 1,000 customer messages through the
 * simulator with faults switched on, into a running stack (`make dev` or
 * `make up`, mock mode), and proves from both sides, our database and the
 * customers' phones, that none were lost or duplicated. Writes
 * docs/LOAD-TEST.md. Uses its own business, so the demo data is untouched.
 */
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // The environment may be set directly.
}

const { values } = parseArgs({
  options: {
    customers: { type: 'string', default: '200' },
    waves: { type: 'string', default: '5' },
    'wave-gap-ms': { type: 'string', default: '2500' },
    'timeout-s': { type: 'string', default: '300' },
  },
});
const CUSTOMERS = Number(values.customers);
const WAVES = Number(values.waves);
const WAVE_GAP_MS = Number(values['wave-gap-ms']);
const TIMEOUT_MS = Number(values['timeout-s']) * 1000;

const SIMULATOR = (process.env['SIMULATOR_PUBLIC_URL'] ?? 'http://localhost:4010').replace(
  /\/$/,
  '',
);
const API = `http://localhost:${process.env['API_PORT'] ?? '4000'}`;
const WORKER = `http://localhost:${process.env['WORKER_HEALTH_PORT'] ?? '4020'}`;
const PHONE_NUMBER_ID = '100000000000777';
const SLUG = 'load-test';

/** Faults on, as the brief asks; failed delivery statuses off (they are Meta's, not ours to retry). */
const FAULTS = {
  duplicateRate: 0.2,
  reorderWindowMs: 300,
  delayMs: 100,
  failSendRate: 0.05,
  rateLimitRate: 0.05,
  failedStatusRate: 0,
};

const QUESTIONS = [
  'Is the Galaxy S24 in stock?',
  'do you deliver to Deira today?',
  'क्या आपके पास iPhone 15 का कवर है?',
  'هل وصل طلبي؟',
  'screen guard ka warranty kitna hai?',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = sorted[Math.floor(rank)] ?? 0;
  const high = sorted[Math.ceil(rank)] ?? low;
  return Math.round(low + (high - low) * (rank - Math.floor(rank)));
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${url}: HTTP ${String(response.status)}`);
  return (await response.json()) as T;
}

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

interface PhoneMessage {
  wamid: string;
  direction: 'in' | 'out';
  at: number;
}

async function main(): Promise<number> {
  for (const [name, url] of [
    ['simulator', `${SIMULATOR}/health`],
    ['API', `${API}/ready`],
    ['worker', `${WORKER}/health`],
  ] as const) {
    if (!(await up(url)))
      throw new Error(
        `The ${name} is not answering at ${url}. Start the stack first: make dev (or make up).`,
      );
  }
  const migratorUrl = process.env['DATABASE_MIGRATOR_URL'];
  if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL is not set (see .env.example)');
  const { db, close } = createDb(migratorUrl, { max: 2 });
  const state = await json<{ faults: Record<string, number>; delivered: number }>(
    `${SIMULATOR}/control/state`,
  );
  const runId = randomBytes(3).toString('hex');

  try {
    // A fresh load-test business each run; the previous one goes, with its data.
    await db.delete(schema.tenants).where(eq(schema.tenants.slug, SLUG));
    const [tenant] = await db
      .insert(schema.tenants)
      .values({
        slug: SLUG,
        name: 'Load test',
        timezone: 'Asia/Dubai',
        assistantSummary: 'A phone shop used for load testing.',
        assistantDailyTokenBudget: 10_000_000,
        assistantTurnsPerCustomerHour: 100,
      })
      .returning({ id: schema.tenants.id });
    if (!tenant) throw new Error('could not create the load-test business');
    const tenantId = tenant.id;
    await db.insert(schema.channels).values({
      tenantId,
      provider: 'simulator',
      phoneNumberId: PHONE_NUMBER_ID,
      displayPhoneNumber: '+971 4 000 0777',
    });
    await json(`${SIMULATOR}/control/businesses`, {
      method: 'POST',
      body: JSON.stringify({
        phoneNumberId: PHONE_NUMBER_ID,
        displayPhoneNumber: '+971 4 000 0777',
        name: 'Load test',
      }),
    });
    const customers = Array.from({ length: CUSTOMERS }, (_, i) => ({
      name: `Load ${String(i + 1)}`,
      bsuid: `LT.${runId}.${String(i).padStart(4, '0')}`,
      // Half have a phone number, half a username only, as on WhatsApp now.
      waId: i % 2 === 0 ? `9715${String(10_000_000 + i)}` : null,
      businessPhoneNumberId: PHONE_NUMBER_ID,
    }));
    await json(`${SIMULATOR}/control/customers`, {
      method: 'POST',
      body: JSON.stringify(customers),
    });
    await json(`${SIMULATOR}/control/faults`, { method: 'POST', body: JSON.stringify(FAULTS) });

    // --- send ------------------------------------------------------------------
    const sent: string[] = [];
    const startedAt = Date.now();
    for (let wave = 0; wave < WAVES; wave += 1) {
      for (let i = 0; i < customers.length; i += 100) {
        const batch = customers.slice(i, i + 100).map((c, j) => ({
          customerId: c.bsuid,
          text: `${QUESTIONS[(i + j + wave) % QUESTIONS.length] ?? ''} (${String(wave + 1)})`,
        }));
        const { wamids } = await json<{ wamids: string[] }>(`${SIMULATOR}/control/messages`, {
          method: 'POST',
          body: JSON.stringify(batch),
        });
        sent.push(...wamids);
      }
      if (wave < WAVES - 1) await sleep(WAVE_GAP_MS);
    }
    const sentAt = Date.now();
    process.stdout.write(
      `sent ${String(sent.length)} messages in ${String(sentAt - startedAt)} ms; waiting for the pipeline…\n`,
    );

    // --- wait until everything settles ----------------------------------------
    const pending = async () => {
      const result = await db.execute<{ stored: number; unsent: number; unanswered: number }>(sql`
        select
          (select count(*)::int from messages where tenant_id = ${tenantId} and direction = 'inbound') as stored,
          (select count(*)::int from messages where tenant_id = ${tenantId} and direction = 'outbound'
             and status in ('queued', 'sending')) as unsent,
          (select count(*)::int from conversations c
             cross join lateral (select m.id from messages m where m.conversation_id = c.id and m.direction = 'inbound'
                                 order by m.created_at desc limit 1) last_in
            where c.tenant_id = ${tenantId} and c.state = 'assistant'
              and not exists (select 1 from assistant_turns t where t.trigger_message_id = last_in.id)) as unanswered`);
      return result.rows[0] ?? { stored: 0, unsent: 0, unanswered: 0 };
    };
    let settledAt = 0;
    let stable = 0;
    let last = await pending();
    while (Date.now() - sentAt < TIMEOUT_MS) {
      last = await pending();
      if (last.stored >= sent.length && last.unsent === 0 && last.unanswered === 0) {
        stable += 1;
        if (stable === 3) {
          settledAt = Date.now() - 2_000;
          break;
        }
      } else {
        stable = 0;
      }
      await sleep(1_000);
    }
    // Statuses (delivered) trail the sends by a few hundred milliseconds.
    await sleep(1_000);

    // --- our side ---------------------------------------------------------------
    const inbound = await db
      .select({ wamid: schema.messages.waMessageId, createdAt: schema.messages.createdAt })
      .from(schema.messages)
      .where(
        sql`${schema.messages.tenantId} = ${tenantId} and ${schema.messages.direction} = 'inbound'`,
      );
    const storedIds = inbound.map((m) => m.wamid ?? '');
    const sentSet = new Set(sent);
    const lost = sent.filter((id) => !storedIds.includes(id));
    const duplicatedRows = storedIds.length - new Set(storedIds).size;
    const unexpectedRows = storedIds.filter((id) => !sentSet.has(id)).length;

    const outbound = await db.execute<{
      wamid: string | null;
      status: string;
      attempts: number;
      seq: number;
      bsuid: string;
    }>(sql`
      select m.wa_message_id as wamid, m.status, m.attempts, m.outbox_seq as seq, cu.bsuid
      from messages m
      join conversations c on c.id = m.conversation_id
      join customers cu on cu.id = c.customer_id
      where m.tenant_id = ${tenantId} and m.direction = 'outbound'`);
    const ours = outbound.rows;
    const statusCounts = ours.reduce<Record<string, number>>((acc, m) => {
      acc[m.status] = (acc[m.status] ?? 0) + 1;
      return acc;
    }, {});
    const retried = ours.filter((m) => m.attempts > 1).length;
    const deadLetters = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.deadLetters)
      .where(eq(schema.deadLetters.tenantId, tenantId));

    // --- the phones' side ---------------------------------------------------------
    let onPhones = 0;
    let unknownOnPhones = 0;
    let duplicatesOnPhones = 0;
    let outOfOrder = 0;
    const ourByWamid = new Map(ours.filter((m) => m.wamid).map((m) => [m.wamid, m]));
    for (const customer of customers) {
      const thread = await json<PhoneMessage[]>(
        `${SIMULATOR}/control/threads/${encodeURIComponent(customer.bsuid)}`,
      );
      const out = thread.filter((m) => m.direction === 'out').sort((a, b) => a.at - b.at);
      onPhones += out.length;
      unknownOnPhones += out.filter((m) => !ourByWamid.has(m.wamid)).length;
      duplicatesOnPhones += out.length - new Set(out.map((m) => m.wamid)).size;
      const seqs = out.map((m) => ourByWamid.get(m.wamid)?.seq ?? -1);
      for (let i = 1; i < seqs.length; i += 1)
        if ((seqs[i] ?? 0) < (seqs[i - 1] ?? 0)) outOfOrder += 1;
    }
    const sentByUs = ours.filter((m) => m.wamid).length;

    // --- timings, from the stored traces ------------------------------------------
    const traces = await db.execute<{
      reply_ms: number | null;
      latency_ms: number;
      // bigint: node-postgres returns it as a string.
      cost: string;
    }>(sql`
      select (extract(epoch from (r.sent_at - coalesce(m.wa_timestamp, m.created_at))) * 1000)::int as reply_ms,
             t.latency_ms, t.cost_micros as cost
      from assistant_turns t
      join messages m on m.id = t.trigger_message_id
      left join messages r on r.id = t.reply_message_id
      where t.tenant_id = ${tenantId}`);
    const replyMs = traces.rows.flatMap((t) =>
      t.reply_ms !== null && t.reply_ms >= 0 ? [t.reply_ms] : [],
    );
    const turnMs = traces.rows.map((t) => t.latency_ms);
    const conversations = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.conversations)
      .where(eq(schema.conversations.tenantId, tenantId));
    const cost = traces.rows.reduce((sum, t) => sum + Number(t.cost), 0);
    const lastStored = Math.max(...inbound.map((m) => m.createdAt.getTime()));
    const delivered =
      (await json<{ delivered: number }>(`${SIMULATOR}/control/state`)).delivered - state.delivered;

    const checks: [string, boolean, string][] = [
      [
        'Every message stored',
        lost.length === 0,
        `${String(sent.length - lost.length)} of ${String(sent.length)}`,
      ],
      [
        'No message stored twice',
        duplicatedRows === 0 && unexpectedRows === 0,
        `${String(duplicatedRows)} duplicate rows`,
      ],
      [
        'Every reply sent',
        (statusCounts['queued'] ?? 0) +
          (statusCounts['sending'] ?? 0) +
          (statusCounts['failed'] ?? 0) ===
          0,
        `${String(sentByUs)} sent, ${String(statusCounts['failed'] ?? 0)} failed`,
      ],
      [
        'Each reply on the phone once',
        onPhones === sentByUs && unknownOnPhones === 0 && duplicatesOnPhones === 0,
        `${String(onPhones)} on phones, ${String(unknownOnPhones)} unknown, ${String(duplicatesOnPhones)} twice`,
      ],
      ['Replies in order per conversation', outOfOrder === 0, `${String(outOfOrder)} out of order`],
      [
        'Every customer answered',
        last.unanswered === 0,
        `${String(last.unanswered)} waiting for a turn`,
      ],
      [
        'Settled in time',
        settledAt > 0,
        settledAt > 0
          ? `${String(Math.round((settledAt - sentAt) / 1000))} s after the last send`
          : `not within ${String(TIMEOUT_MS / 1000)} s`,
      ],
    ];
    const passed = checks.every(([, ok]) => ok);
    const s = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(2)} s`);

    const report = [
      '# Load test',
      '',
      `Generated by \`pnpm load-test\` on ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Do not edit by hand: run it again.`,
      '',
      `**Result: ${passed ? 'passed' : 'FAILED'}.** ${String(sent.length)} customer messages from ${String(CUSTOMERS)} customers, in ${String(WAVES)} waves ${String(WAVE_GAP_MS / 1000)} s apart, through the simulator with faults on, into the stack running in mock mode on one machine.`,
      '',
      '| Check | Passed | Detail |',
      '| --- | --- | --- |',
      ...checks.map(([name, ok, detail]) => `| ${name} | ${ok ? 'yes' : '**no**'} | ${detail} |`),
      '',
      '## Faults switched on',
      '',
      `Duplicate webhook deliveries ${String(FAULTS.duplicateRate * 100)}%, reordering within ${String(FAULTS.reorderWindowMs)} ms, ${String(FAULTS.delayMs)} ms delay, failed sends ${String(FAULTS.failSendRate * 100)}%, rate-limit errors ${String(FAULTS.rateLimitRate * 100)}%. The simulator made ${String(delivered)} webhook deliveries for ${String(sent.length)} messages and their statuses; ${String(retried)} replies needed more than one send attempt; ${String(deadLetters[0]?.n ?? 0)} went to the dead-letter queue.`,
      '',
      '## Measured, from the stored traces',
      '',
      '| Measure | Value |',
      '| --- | --- |',
      `| Messages stored | ${String(storedIds.length)} in ${s(lastStored - startedAt)} from the first send |`,
      `| Replies sent | ${String(sentByUs)} (${Object.entries(statusCounts)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(', ')}) |`,
      `| Reply time, customer message to reply sent: median | ${s(percentile(replyMs, 0.5))} |`,
      `| Reply time: p95 | ${s(percentile(replyMs, 0.95))} |`,
      `| Assistant's own work per turn: median / p95 | ${s(percentile(turnMs, 0.5))} / ${s(percentile(turnMs, 0.95))} |`,
      `| Cost per conversation | $${(cost / Math.max(1, conversations[0]?.n ?? 1) / 1_000_000).toFixed(5)} (mock model: no charge) |`,
      '',
      '## How to read this',
      '',
      `- Reply time includes the assistant's 1.5 s wait for more messages, the order hold behind the previous reply's delivery, and send retries after the injected failures. The model here is the mock, so a live model adds its own time: see docs/EVALS.md.`,
      `- Machine: ${String(cpus().length)} × ${cpus()[0]?.model ?? 'unknown CPU'}, ${String(Math.round(totalmem() / 2 ** 30))} GB RAM, Node ${process.version}. These are laptop numbers, not the EC2 instance's.`,
      '- "On the phone" is the simulator\'s record of what each customer received, compared with what our database says was sent.',
      '- Fewer replies than messages is expected: messages that arrive while a reply is being prepared are answered together, in one reply.',
      '- The time to settle is set by the slowest replies: after an injected send failure they wait out the retry backoff (1, 2, 4 s…), and later replies in the same conversation wait behind them to keep the order.',
      '',
    ].join('\n');
    writeFileSync(new URL('../../docs/LOAD-TEST.md', import.meta.url), report);
    process.stdout.write(`${report}\n`);
    return passed ? 0 : 1;
  } finally {
    await fetch(`${SIMULATOR}/control/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.faults),
    }).catch(() => undefined);
    await close();
  }
}

process.exitCode = await main();
