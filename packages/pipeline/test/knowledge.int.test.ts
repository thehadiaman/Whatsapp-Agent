import { readFile } from 'node:fs/promises';
import { schema, withTenant } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readKnowledgeFile, retrievePassages, UnreadableSourceError } from '../src/knowledge.js';
import { enqueueKnowledge } from '../src/queues.js';
import { knowledgeObjectKey } from '../src/storage.js';
import { startHarness, waitFor, type Harness } from './harness.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

describe('readKnowledgeFile', () => {
  it('reads a text PDF page by page', async () => {
    const result = await readKnowledgeFile(await fixture('warranty.pdf'), 'Warranty policy.pdf');
    expect(result.unitCount).toBe(2);
    const text = result.passages.map((p) => p.text).join('\n');
    expect(text).toContain('All phones carry a 12-month manufacturer warranty');
    expect(text).toContain('Screen guards and cases are not covered');
  });

  it('refuses a scanned PDF with advice the owner can act on', async () => {
    await expect(
      readKnowledgeFile(await fixture('scanned.pdf'), 'Delivery areas.pdf'),
    ).rejects.toThrow(
      'No text found: this looks like a scanned PDF. Upload a text PDF or paste the content as an FAQ.',
    );
  });

  it('reads a Word file, Malayalam included', async () => {
    const result = await readKnowledgeFile(await fixture('returns.docx'), 'Returns.docx');
    expect(result.passages.map((p) => p.text).join('\n')).toContain(
      'ഓർഡർ ചെയ്ത കേക്ക് 24 മണിക്കൂർ മുമ്പ് വരെ റദ്ദാക്കാം.',
    );
  });

  it('turns a catalogue into one passage per product, and refuses other types', async () => {
    const csv = new TextEncoder().encode(
      'Product,Price (AED)\nGalaxy S24 128 GB,2899\nPixel 9,3199\n',
    );
    const result = await readKnowledgeFile(csv, 'Price list November.csv');
    expect(result.unitCount).toBe(2);
    expect(result.passages[1]).toEqual({
      heading: 'Pixel 9',
      text: 'Product: Pixel 9. Price (AED): 3199.',
    });
    await expect(readKnowledgeFile(csv, 'prices.xlsx')).rejects.toBeInstanceOf(
      UnreadableSourceError,
    );
    await expect(
      readKnowledgeFile(new Uint8Array([0xff, 0xfe, 0x00]), 'latin.csv'),
    ).rejects.toThrow(/not UTF-8/);
  });
});

describe('ingestion and retrieval', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function addSource(
    tenantId: string,
    source: { kind: 'faq' | 'file' | 'catalogue'; title: string; answer?: string; file?: Buffer },
  ) {
    const [row] = await h.migrator.db
      .insert(schema.knowledgeSources)
      .values({ tenantId, kind: source.kind, title: source.title, answer: source.answer ?? null })
      .returning();
    if (!row) throw new Error('no source');
    if (source.file) {
      const key = knowledgeObjectKey(tenantId, row.id);
      await h.deps.storage.put(key, source.file, 'application/octet-stream');
      await h.migrator.db
        .update(schema.knowledgeSources)
        .set({ storageKey: key })
        .where(eq(schema.knowledgeSources.id, row.id));
    }
    await enqueueKnowledge(h.deps.queues, { tenantId, sourceId: row.id, version: 1 });
    return row.id;
  }

  async function sourceRow(id: string) {
    const [row] = await h.migrator.db
      .select()
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, id));
    return row;
  }

  const settled = async (id: string) =>
    ['ready', 'failed'].includes((await sourceRow(id))?.status ?? '');

  it('reads a file into passages on the worker, then finds them by meaning and by keyword', async () => {
    const pdf = await addSource(h.tenant.id, {
      kind: 'file',
      title: 'Warranty policy.pdf',
      file: await fixture('warranty.pdf'),
    });
    const faq = await addSource(h.tenant.id, {
      kind: 'faq',
      title: 'Do you deliver on Fridays?',
      answer: 'Yes, after 2 pm, anywhere in Karama and Bur Dubai.',
    });
    await waitFor('sources read', async () => (await settled(pdf)) && (await settled(faq)));
    expect(await sourceRow(pdf)).toMatchObject({ status: 'ready', unitCount: 2, error: null });
    expect((await sourceRow(faq))?.passageCount).toBe(1);

    const found = await withTenant(h.deps.db, h.tenant.id, (tx) =>
      retrievePassages(tx, h.deps.assistant.embedder, 'are screen guards covered by warranty?'),
    );
    expect(found[0]?.sourceTitle).toBe('Warranty policy.pdf');
    expect(found[0]?.text).toContain('Screen guards and cases are not covered');
    expect(found[0]?.score).toBeGreaterThan(0);

    const friday = await withTenant(h.deps.db, h.tenant.id, (tx) =>
      retrievePassages(tx, h.deps.assistant.embedder, 'friday delivery?'),
    );
    expect(friday.map((p) => p.sourceTitle)).toContain('Do you deliver on Fridays?');

    const nothing = await withTenant(h.deps.db, h.tenant.id, (tx) =>
      retrievePassages(tx, h.deps.assistant.embedder, 'zebra xylophone quantum'),
    );
    expect(nothing).toEqual([]);
  });

  it('marks a scanned PDF failed with the reason, and keeps no passages for it', async () => {
    const id = await addSource(h.tenant.id, {
      kind: 'file',
      title: 'Delivery areas.pdf',
      file: await fixture('scanned.pdf'),
    });
    await waitFor('source settled', () => settled(id));
    expect(await sourceRow(id)).toMatchObject({
      status: 'failed',
      passageCount: 0,
      error: expect.stringContaining('scanned PDF') as unknown,
    });
  });

  it('a superseded version does nothing; the newest version replaces the passages', async () => {
    const id = await addSource(h.tenant.id, {
      kind: 'faq',
      title: 'Opening hours?',
      answer: 'Open 10 am to 10 pm every day.',
    });
    await waitFor('first version read', () => settled(id));
    // The owner edits the answer: version 2. A stale version-1 job must not undo it.
    await h.migrator.db
      .update(schema.knowledgeSources)
      .set({ answer: 'Open 9 am to 11 pm every day.', version: 2, status: 'queued' })
      .where(eq(schema.knowledgeSources.id, id));
    await enqueueKnowledge(h.deps.queues, { tenantId: h.tenant.id, sourceId: id, version: 2 });
    await waitFor('second version read', () => settled(id));
    const passages = await h.migrator.db
      .select({ text: schema.knowledgePassages.text })
      .from(schema.knowledgePassages)
      .where(eq(schema.knowledgePassages.sourceId, id));
    expect(passages).toEqual([{ text: 'Q: Opening hours?\nA: Open 9 am to 11 pm every day.' }]);
  });

  it("one business's retrieval never sees another business's passages", async () => {
    const other = await h.createTenant();
    const secret = await addSource(other.id, {
      kind: 'faq',
      title: 'Staff discount code?',
      answer: 'The staff discount code is ZANZIBAR77.',
    });
    await waitFor('other business source read', () => settled(secret));
    const fromA = await withTenant(h.deps.db, h.tenant.id, (tx) =>
      retrievePassages(tx, h.deps.assistant.embedder, 'staff discount code ZANZIBAR77'),
    );
    expect(fromA.map((p) => p.text).join(' ')).not.toContain('ZANZIBAR77');
    const fromB = await withTenant(h.deps.db, other.id, (tx) =>
      retrievePassages(tx, h.deps.assistant.embedder, 'staff discount code ZANZIBAR77'),
    );
    expect(fromB[0]?.text).toContain('ZANZIBAR77');
  });
});
