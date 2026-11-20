import { randomInt } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockEmbedder, passageFromFaq } from '@app/assistant';
import { schema, type DbHandle } from '@app/db';
import {
  conversationDetailSchema,
  knowledgeSourceDetailSchema,
  knowledgeSourceSchema,
  retrievedPassageSchema,
  turnExplanationSchema,
} from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  arrangeDb,
  call,
  clientIp,
  createTestTenant,
  ORIGIN,
  signIn,
  startApi,
  testConfig,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

let api: RunningApi;
let db: DbHandle;
let a: TestTenant;
let b: TestTenant;
const cookies: Record<string, string> = {};

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

beforeAll(async () => {
  db = arrangeDb();
  a = await createTestTenant(db, 'ka');
  b = await createTestTenant(db, 'kb');
  const storageDir = await mkdtemp(join(tmpdir(), 'knowledge-api-'));
  api = await startApi(testConfig({ MEDIA_STORAGE_DIR: storageDir }));
  cookies['ownerA'] = await signIn(api, a.ownerEmail);
  cookies['agentA'] = await signIn(api, a.agentEmail);
  cookies['ownerB'] = await signIn(api, b.ownerEmail);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

async function upload(cookie: string, name: string, bytes: Uint8Array, origin = ORIGIN) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const response = await fetch(`${api.url}/api/knowledge/files`, {
    method: 'POST',
    headers: { cookie, origin, 'x-real-ip': clientIp() },
    body: form,
  });
  const json: unknown = await response.json();
  return { status: response.status, json };
}

async function addFaq(cookie: string, question: string, answer: string) {
  return call(api, '/api/knowledge/faqs', {
    method: 'POST',
    cookie,
    body: { question, answer },
  });
}

/** Indexes an FAQ as the worker would, so retrieval has something to find. */
async function indexFaq(tenantId: string, sourceId: string, question: string, answer: string) {
  const draft = passageFromFaq(question, answer);
  const [vector] = await new MockEmbedder().embed([`${draft.heading ?? ''}\n${draft.text}`]);
  await db.db.insert(schema.knowledgePassages).values({
    tenantId,
    sourceId,
    ordinal: 0,
    heading: draft.heading,
    text: draft.text,
    embedding: vector!,
    embeddingModel: 'mock-hashed-ngrams-v1',
  });
  await db.db
    .update(schema.knowledgeSources)
    .set({ status: 'ready', passageCount: 1 })
    .where(eq(schema.knowledgeSources.id, sourceId));
}

describe('managing the knowledge base', () => {
  it('an owner adds an FAQ; it is queued for reading and audited', async () => {
    const added = await addFaq(
      cookies['ownerA']!,
      'Do you deliver on Fridays?',
      'Yes, after 2 pm.',
    );
    expect(added.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(added.json);

    const list = z
      .array(knowledgeSourceSchema)
      .parse((await call(api, '/api/knowledge/sources', { cookie: cookies['agentA']! })).json);
    expect(list.find((s) => s.id === id)).toMatchObject({
      kind: 'faq',
      title: 'Do you deliver on Fridays?',
      answer: 'Yes, after 2 pm.',
      status: 'queued',
      version: 1,
    });
    const [audit] = await db.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.action, 'knowledge.faq_added')),
      );
    expect(audit).toBeDefined();
  });

  it('an agent can read the knowledge base but not change it', async () => {
    const denied = await addFaq(cookies['agentA']!, 'Opening hours?', '10 to 10.');
    expect(denied.status).toBe(403);
    const upload403 = await upload(
      cookies['agentA']!,
      'notes.txt',
      new TextEncoder().encode('hello'),
    );
    expect(upload403.status).toBe(403);
  });

  it('editing an FAQ bumps its version and queues it again', async () => {
    const { id } = z
      .object({ id: z.uuid() })
      .parse((await addFaq(cookies['ownerA']!, 'Opening hours?', 'Open 10 am to 10 pm.')).json);
    const edited = await call(api, `/api/knowledge/faqs/${id}`, {
      method: 'PUT',
      cookie: cookies['ownerA']!,
      body: { question: 'Opening hours?', answer: 'Open 9 am to 11 pm.' },
    });
    expect(edited.json).toEqual({ id, version: 2 });
    const detail = knowledgeSourceDetailSchema.parse(
      (await call(api, `/api/knowledge/sources/${id}`, { cookie: cookies['ownerA']! })).json,
    );
    expect(detail).toMatchObject({ answer: 'Open 9 am to 11 pm.', status: 'queued', version: 2 });
  });

  it('accepts PDF, Word, text and CSV uploads and says what is wrong with anything else', async () => {
    const pdf = await readFile(
      new URL('../../../../packages/pipeline/test/fixtures/warranty.pdf', import.meta.url),
    );
    const ok = await upload(cookies['ownerA']!, 'Warranty policy.pdf', pdf);
    expect(ok.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(ok.json);
    const source = knowledgeSourceDetailSchema.parse(
      (await call(api, `/api/knowledge/sources/${id}`, { cookie: cookies['ownerA']! })).json,
    );
    expect(source).toMatchObject({
      kind: 'file',
      title: 'Warranty policy.pdf',
      sizeBytes: pdf.byteLength,
    });

    const csv = await upload(
      cookies['ownerA']!,
      'Price list.csv',
      new TextEncoder().encode('Product,Price\nPixel 9,3199\n'),
    );
    expect(
      knowledgeSourceSchema
        .pick({ kind: true })
        .safeParse(
          (
            await call(
              api,
              `/api/knowledge/sources/${z.object({ id: z.uuid() }).parse(csv.json).id}`,
              { cookie: cookies['ownerA']! },
            )
          ).json,
        ).data?.kind,
    ).toBe('catalogue');

    const xlsx = await upload(cookies['ownerA']!, 'prices.xlsx', new Uint8Array([1, 2, 3]));
    expect(xlsx).toMatchObject({
      status: 400,
      json: { message: 'Upload a PDF, Word (.docx), Markdown, text or CSV file.' },
    });
    const empty = await upload(cookies['ownerA']!, 'empty.txt', new Uint8Array());
    expect(empty).toMatchObject({ status: 400, json: { message: 'The file is empty.' } });
  });

  it('refuses a file over 10 MB', async () => {
    const big = await upload(cookies['ownerA']!, 'huge.txt', new Uint8Array(10 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
  });

  it('keeps a Malayalam or Arabic file name intact', async () => {
    const result = await upload(
      cookies['ownerA']!,
      'കേക്ക് വിലകൾ.txt',
      new TextEncoder().encode('Chocolate cake 850'),
    );
    const { id } = z.object({ id: z.uuid() }).parse(result.json);
    const source = knowledgeSourceDetailSchema.parse(
      (await call(api, `/api/knowledge/sources/${id}`, { cookie: cookies['ownerA']! })).json,
    );
    expect(source.title).toBe('കേക്ക് വിലകൾ.txt');
  });

  it('refuses an upload from another site (CSRF)', async () => {
    const result = await upload(
      cookies['ownerA']!,
      'notes.txt',
      new TextEncoder().encode('x'),
      'https://evil.example',
    );
    expect(result.status).toBe(403);
  });

  it('removing a source deletes its passages, so the assistant stops using it', async () => {
    const { id } = z
      .object({ id: z.uuid() })
      .parse(
        (await addFaq(cookies['ownerA']!, 'Gift wrapping?', 'Free for orders over AED 200.')).json,
      );
    await indexFaq(a.id, id, 'Gift wrapping?', 'Free for orders over AED 200.');
    const removed = await call(api, `/api/knowledge/sources/${id}`, {
      method: 'DELETE',
      cookie: cookies['ownerA']!,
    });
    expect(removed.status).toBe(204);
    const passages = await db.db
      .select()
      .from(schema.knowledgePassages)
      .where(eq(schema.knowledgePassages.sourceId, id));
    expect(passages).toEqual([]);
  });
});

describe('isolation between businesses', () => {
  it("another business cannot see, edit or remove this business's sources", async () => {
    const { id } = z
      .object({ id: z.uuid() })
      .parse(
        (await addFaq(cookies['ownerA']!, 'Staff discount?', 'The staff code is ZANZIBAR77.')).json,
      );
    await indexFaq(a.id, id, 'Staff discount?', 'The staff code is ZANZIBAR77.');

    const listB = z
      .array(knowledgeSourceSchema)
      .parse((await call(api, '/api/knowledge/sources', { cookie: cookies['ownerB']! })).json);
    expect(listB.map((s) => s.id)).not.toContain(id);
    expect(
      (await call(api, `/api/knowledge/sources/${id}`, { cookie: cookies['ownerB']! })).status,
    ).toBe(404);
    expect(
      (
        await call(api, `/api/knowledge/faqs/${id}`, {
          method: 'PUT',
          cookie: cookies['ownerB']!,
          body: { question: 'x', answer: 'y' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(api, `/api/knowledge/sources/${id}`, {
          method: 'DELETE',
          cookie: cookies['ownerB']!,
        })
      ).status,
    ).toBe(404);

    const tryB = z.array(retrievedPassageSchema).parse(
      (
        await call(api, '/api/knowledge/try', {
          method: 'POST',
          cookie: cookies['ownerB']!,
          body: { question: 'staff discount code ZANZIBAR77' },
        })
      ).json,
    );
    expect(tryB).toEqual([]);
  });
});

describe('try a question', () => {
  it('shows the passages the assistant would read, with scores', async () => {
    const { id } = z
      .object({ id: z.uuid() })
      .parse(
        (
          await addFaq(
            cookies['ownerA']!,
            'Is the screen guard covered?',
            'Screen guards are not covered by the warranty.',
          )
        ).json,
      );
    await indexFaq(
      a.id,
      id,
      'Is the screen guard covered?',
      'Screen guards are not covered by the warranty.',
    );
    const result = await call(api, '/api/knowledge/try', {
      method: 'POST',
      cookie: cookies['agentA']!,
      body: { question: 'bhai screen guard ka warranty kitna hai' },
    });
    expect(result.status).toBe(200);
    const passages = z.array(retrievedPassageSchema).parse(result.json);
    expect(passages[0]).toMatchObject({
      sourceId: id,
      sourceTitle: 'Is the screen guard covered?',
    });
    expect(passages[0]!.score).toBeGreaterThan(0);
  });
});

describe('explain this reply', () => {
  it("returns a reply's receipt to its business only, and marks the reply in the thread", async () => {
    const [channel] = await db.db
      .insert(schema.channels)
      .values({
        tenantId: a.id,
        provider: 'simulator',
        phoneNumberId: `1${digits(14)}`,
        displayPhoneNumber: '+971 4 0',
      })
      .returning();
    const [customer] = await db.db
      .insert(schema.customers)
      .values({ tenantId: a.id, bsuid: `AE.${digits(20)}`, profileName: 'Rahul' })
      .returning();
    const [conversation] = await db.db
      .insert(schema.conversations)
      .values({
        tenantId: a.id,
        channelId: channel!.id,
        customerId: customer!.id,
        number: 900 + randomInt(99),
      })
      .returning();
    const base = { tenantId: a.id, channelId: channel!.id, conversationId: conversation!.id };
    const [question] = await db.db
      .insert(schema.messages)
      .values({
        ...base,
        direction: 'inbound',
        kind: 'text',
        senderType: 'customer',
        body: 'Is the S24 in stock?',
        status: 'received',
      })
      .returning();
    const [reply] = await db.db
      .insert(schema.messages)
      .values({
        ...base,
        direction: 'outbound',
        kind: 'text',
        senderType: 'assistant',
        body: 'Yes.',
        status: 'sent',
        outboxSeq: 0,
      })
      .returning();
    const [turn] = await db.db
      .insert(schema.assistantTurns)
      .values({
        tenantId: a.id,
        conversationId: conversation!.id,
        customerId: customer!.id,
        triggerMessageId: question!.id,
        replyMessageId: reply!.id,
        model: 'mock',
        outcome: 'replied',
        basis: 'knowledge',
        language: 'en',
        inputTokens: 812,
        outputTokens: 40,
        latencyMs: 320,
        modelCalls: 1,
        passages: [
          {
            passageId: question!.id,
            sourceId: question!.id,
            sourceTitle: 'Price list.csv',
            heading: 'Galaxy S24',
            score: 0.71,
          },
        ],
      })
      .returning();

    const explained = await call(api, `/api/conversations/${conversation!.id}/turns/${turn!.id}`, {
      cookie: cookies['agentA']!,
    });
    expect(turnExplanationSchema.parse(explained.json)).toMatchObject({
      outcome: 'replied',
      inputTokens: 812,
      passages: [{ sourceTitle: 'Price list.csv', heading: 'Galaxy S24', score: 0.71 }],
    });
    const detail = conversationDetailSchema.parse(
      (await call(api, `/api/conversations/${conversation!.id}`, { cookie: cookies['agentA']! }))
        .json,
    );
    const replyEntry = detail.timeline.find((e) => e.type === 'message' && e.id === reply!.id);
    expect(replyEntry).toMatchObject({ turnId: turn!.id });

    const fromB = await call(api, `/api/conversations/${conversation!.id}/turns/${turn!.id}`, {
      cookie: cookies['ownerB']!,
    });
    expect(fromB.status).toBe(404);
  });
});
