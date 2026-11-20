import {
  passageFromFaq,
  passagesFromCatalogue,
  passagesFromText,
  type Embedder,
  type PassageDraft,
  type RetrievedPassage,
} from '@app/assistant';
import { schema, withTenant, type Transaction } from '@app/db';
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { PipelineDeps } from './deps.js';

/** A file the owner must fix; the message says what to do. Never retried. */
export class UnreadableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableSourceError';
  }
}

export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;

export type KnowledgeFileKind = 'pdf' | 'docx' | 'text' | 'catalogue';

/** Decided by extension: browsers send unreliable types for .md and .csv. */
export function knowledgeFileKind(filename: string): KnowledgeFileKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  switch (extension) {
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'md':
    case 'markdown':
    case 'txt':
      return 'text';
    case 'csv':
      return 'catalogue';
    default:
      return null;
  }
}

export const KNOWLEDGE_CONTENT_TYPES: Record<KnowledgeFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain; charset=utf-8',
  catalogue: 'text/csv; charset=utf-8',
};

export interface ReadResult {
  passages: PassageDraft[];
  /** Pages for a PDF, products for a catalogue. */
  unitCount: number | null;
}

// The libraries are CommonJS or large ES modules; load them when a file needs them.
const require = createRequire(import.meta.url);

async function readPdf(bytes: Uint8Array): Promise<ReadResult> {
  // Imported on first use: pdfjs prints a one-off notice that page rendering
  // (which needs a canvas library we leave out) is unavailable. We only read text.
  const pdfjs = (await import(
    require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  )) as typeof import('pdfjs-dist');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new UnreadableSourceError(
        name === 'PasswordException'
          ? 'This PDF is password-protected. Remove the password and upload it again.'
          : 'This PDF could not be opened. Save it again as a PDF and upload it.',
      );
    }
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push(text.trim());
    }
    const all = pages.join('\n\n').trim();
    if (all.replace(/\s/g, '').length < 20) {
      throw new UnreadableSourceError(
        'No text found: this looks like a scanned PDF. Upload a text PDF or paste the content as an FAQ.',
      );
    }
    return { passages: passagesFromText(all), unitCount: document.numPages };
  } finally {
    await task.destroy();
  }
}

async function readDocx(bytes: Uint8Array): Promise<ReadResult> {
  const mammoth = require('mammoth') as typeof import('mammoth');
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { passages: passagesFromText(result.value), unitCount: null };
  } catch {
    throw new UnreadableSourceError(
      'This Word file could not be read. Open it, save it again as .docx and upload it.',
    );
  }
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UnreadableSourceError(
      'The file is not UTF-8 text. Save it as UTF-8 (in Excel: "CSV UTF-8") and upload it again.',
    );
  }
}

/** Turns an uploaded file into passages. Throws UnreadableSourceError with advice. */
export async function readKnowledgeFile(bytes: Uint8Array, filename: string): Promise<ReadResult> {
  const kind = knowledgeFileKind(filename);
  let result: ReadResult;
  switch (kind) {
    case 'pdf':
      result = await readPdf(bytes);
      break;
    case 'docx':
      result = await readDocx(bytes);
      break;
    case 'text':
      result = { passages: passagesFromText(utf8(bytes)), unitCount: null };
      break;
    case 'catalogue': {
      try {
        const passages = passagesFromCatalogue(utf8(bytes));
        result = { passages, unitCount: passages.length };
      } catch (error) {
        if (error instanceof UnreadableSourceError) throw error;
        throw new UnreadableSourceError(error instanceof Error ? error.message : 'Unreadable CSV.');
      }
      break;
    }
    case null:
      throw new UnreadableSourceError('Upload a PDF, Word (.docx), Markdown, text or CSV file.');
  }
  if (result.passages.length === 0) {
    throw new UnreadableSourceError('The file has no text to read.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** Passages the model reads per turn. */
export const MAX_PASSAGES = 5;
const CANDIDATES = 20;
/** Reciprocal rank fusion constant, from the original RRF paper (Cormack et al., 2009). */
const RRF_K = 60;

// Words too common to mean anything as keywords. Two-letter words are already dropped.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'have', 'has', 'can', 'what', 'when', 'where', 'how',
  'does', 'did', 'will', 'with', 'this', 'that', 'from', 'there', 'please', 'want', 'need', 'any',
  'about', 'hai', 'kya', 'mera', 'meri', 'aap', 'kab', 'kaise', 'bhai', 'mein', 'nahi', 'hain',
]); // prettier-ignore

function keywordQuery(text: string): string | null {
  const words = (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  ).filter((w) => Array.from(w).length >= 3 && !STOP_WORDS.has(w));
  const unique = [...new Set(words)].slice(0, 24);
  // websearch_to_tsquery treats "or" as OR; the words contain only letters and digits.
  return unique.length > 0 ? unique.join(' or ') : null;
}

/**
 * Hybrid retrieval: nearest passages by embedding plus keyword matches
 * (product names, order numbers), merged by reciprocal rank fusion. Runs in
 * the tenant's transaction, so row-level security limits it to that business.
 */
export async function retrievePassages(
  tx: Transaction,
  embedder: Embedder,
  query: string,
  limit = MAX_PASSAGES,
): Promise<RetrievedPassage[]> {
  const [vector] = await embedder.embed([query], 'query');
  if (!vector) return [];
  const p = schema.knowledgePassages;
  const distance = sql<number>`${p.embedding} <=> ${JSON.stringify(vector)}::vector`;

  // Only vectors from the same model are comparable (D-093).
  const semantic = await tx
    .select({ id: p.id, similarity: sql<number>`1 - (${distance})` })
    .from(p)
    .where(eq(p.embeddingModel, embedder.model))
    .orderBy(distance)
    .limit(CANDIDATES);

  const terms = keywordQuery(query);
  const keyword = terms
    ? await tx
        .select({ id: p.id })
        .from(p)
        .where(sql`${p.search} @@ websearch_to_tsquery('simple', ${terms})`)
        .orderBy(sql`ts_rank_cd(${p.search}, websearch_to_tsquery('simple', ${terms})) desc`)
        .limit(CANDIDATES)
    : [];

  const fused = new Map<string, { rrf: number; similarity: number; keyword: boolean }>();
  semantic.forEach((row, i) => {
    fused.set(row.id, {
      rrf: 1 / (RRF_K + i + 1),
      // float8 arrives from pg as a number.
      similarity: row.similarity,
      keyword: false,
    });
  });
  keyword.forEach((row, i) => {
    const entry = fused.get(row.id) ?? { rrf: 0, similarity: 0, keyword: false };
    entry.rrf += 1 / (RRF_K + i + 1);
    entry.keyword = true;
    fused.set(row.id, entry);
  });

  // Fusion picks which passages; they are then read most similar first, so
  // the order and the scores shown with them agree.
  const chosen = [...fused.entries()]
    .filter(([, e]) => e.similarity >= embedder.relevanceFloor || e.keyword)
    .sort(([, a], [, b]) => b.rrf - a.rrf)
    .slice(0, limit)
    .sort(([, a], [, b]) => b.similarity - a.similarity);
  if (chosen.length === 0) return [];

  const rows = await tx
    .select({
      id: p.id,
      sourceId: p.sourceId,
      heading: p.heading,
      text: p.text,
      sourceTitle: schema.knowledgeSources.title,
    })
    .from(p)
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, p.sourceId))
    .where(
      inArray(
        p.id,
        chosen.map(([id]) => id),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return chosen.flatMap(([id, e]) => {
    const row = byId.get(id);
    if (!row) return [];
    // A keyword-only match has no meaningful similarity; show what the embedding says anyway.
    return [{ ...row, score: Math.round(e.similarity * 100) / 100 }];
  });
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export const knowledgeJobSchema = z.object({
  tenantId: z.uuid(),
  sourceId: z.uuid(),
  version: z.number().int().min(1),
});
export type KnowledgeJob = z.infer<typeof knowledgeJobSchema>;

const EMBED_BATCH = 32;

async function markFailed(deps: PipelineDeps, job: KnowledgeJob, message: string): Promise<void> {
  await withTenant(deps.db, job.tenantId, async (tx) => {
    const s = schema.knowledgeSources;
    const updated = await tx
      .update(s)
      .set({ status: 'failed', error: message, passageCount: 0, updatedAt: new Date() })
      .where(and(eq(s.id, job.sourceId), eq(s.version, job.version)))
      .returning({ id: s.id });
    // A failed source is not used: its old passages go too, so the page and
    // the assistant agree about what it knows.
    if (updated.length > 0) {
      await tx
        .delete(schema.knowledgePassages)
        .where(eq(schema.knowledgePassages.sourceId, job.sourceId));
    }
  });
}

/**
 * Reads one knowledge source into passages and embeddings. Superseded jobs
 * (the owner edited or re-uploaded since) do nothing. The old passages stay
 * live until the new ones replace them, in one transaction.
 */
export async function ingestKnowledgeSource(deps: PipelineDeps, job: Job): Promise<void> {
  const data = knowledgeJobSchema.parse(job.data);
  const s = schema.knowledgeSources;
  const source = await withTenant(deps.db, data.tenantId, async (tx) => {
    const [row] = await tx.select().from(s).where(eq(s.id, data.sourceId));
    if (!row || row.version !== data.version) return null;
    await tx
      .update(s)
      .set({ status: 'reading', error: null, updatedAt: new Date() })
      .where(eq(s.id, row.id));
    return row;
  });
  if (!source) return;

  let read: ReadResult;
  try {
    if (source.kind === 'faq') {
      read = { passages: [passageFromFaq(source.title, source.answer ?? '')], unitCount: null };
    } else {
      const file = source.storageKey ? await deps.storage.get(source.storageKey) : null;
      if (!file) throw new UnreadableSourceError('The uploaded file is missing. Upload it again.');
      read = await readKnowledgeFile(file.bytes, source.title);
    }
  } catch (error) {
    if (!(error instanceof UnreadableSourceError)) throw error;
    await markFailed(deps, data, error.message);
    deps.logger.info({ sourceId: source.id }, 'knowledge source unreadable');
    return;
  }

  const embedder = deps.assistant.embedder;
  const vectors: number[][] = [];
  for (let i = 0; i < read.passages.length; i += EMBED_BATCH) {
    const batch = read.passages.slice(i, i + EMBED_BATCH);
    vectors.push(
      ...(await embedder.embed(
        batch.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)),
        'document',
      )),
    );
  }

  const stored = await withTenant(deps.db, data.tenantId, async (tx) => {
    const [current] = await tx
      .select({ version: s.version })
      .from(s)
      .where(eq(s.id, source.id))
      .for('update');
    if (current?.version !== data.version) return false;
    await tx
      .delete(schema.knowledgePassages)
      .where(eq(schema.knowledgePassages.sourceId, source.id));
    await tx.insert(schema.knowledgePassages).values(
      read.passages.map((passage, ordinal) => ({
        tenantId: data.tenantId,
        sourceId: source.id,
        ordinal,
        heading: passage.heading,
        text: passage.text,
        embedding: vectors[ordinal] ?? [],
        embeddingModel: embedder.model,
      })),
    );
    await tx
      .update(s)
      .set({
        status: 'ready',
        error: null,
        passageCount: read.passages.length,
        unitCount: read.unitCount,
        updatedAt: new Date(),
      })
      .where(eq(s.id, source.id));
    return true;
  });
  deps.logger.info(
    { sourceId: source.id, passages: read.passages.length, stored },
    'knowledge source read',
  );
}

/** Marks a source failed once its job has run out of retries (the embedder kept failing). */
export async function failKnowledgeJob(deps: PipelineDeps, job: Job): Promise<void> {
  const parsed = knowledgeJobSchema.safeParse(job.data);
  if (!parsed.success) return;
  await markFailed(
    deps,
    parsed.data,
    "Couldn't index this source right now. Try uploading it again in a few minutes.",
  );
}
