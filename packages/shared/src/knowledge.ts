import { z } from 'zod';

/** Shapes the knowledge-base and "Explain this reply" APIs return and the web app validates. */

const isoDate = z.iso.datetime({ offset: true });

export const knowledgeSourceKindSchema = z.enum(['faq', 'file', 'catalogue']);
export const knowledgeSourceStatusSchema = z.enum(['queued', 'reading', 'ready', 'failed']);

export const knowledgeSourceSchema = z.object({
  id: z.uuid(),
  kind: knowledgeSourceKindSchema,
  /** File name, or the FAQ question. */
  title: z.string(),
  /** FAQ only. */
  answer: z.string().nullable(),
  status: knowledgeSourceStatusSchema,
  /** Why reading failed and what to do. */
  error: z.string().nullable(),
  passageCount: z.number().int(),
  /** Pages of a PDF or products in a catalogue. */
  unitCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  version: z.number().int(),
  updatedAt: isoDate,
  updatedBy: z.string().nullable(),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const knowledgePassageSchema = z.object({
  ordinal: z.number().int(),
  heading: z.string().nullable(),
  text: z.string(),
});

export const knowledgeSourceDetailSchema = knowledgeSourceSchema.extend({
  passages: z.array(knowledgePassageSchema),
});
export type KnowledgeSourceDetail = z.infer<typeof knowledgeSourceDetailSchema>;

export const faqBodySchema = z.object({
  question: z.string().trim().min(1, 'Write the question.').max(300),
  answer: z.string().trim().min(1, 'Write the answer.').max(2_000),
});
export type FaqBody = z.infer<typeof faqBodySchema>;

export const tryQuestionBodySchema = z.object({
  question: z.string().trim().min(1, 'Write a question.').max(500),
});
export type TryQuestionBody = z.infer<typeof tryQuestionBodySchema>;

export const retrievedPassageSchema = z.object({
  passageId: z.uuid(),
  sourceId: z.uuid(),
  sourceTitle: z.string(),
  heading: z.string().nullable(),
  text: z.string(),
  score: z.number(),
});
export type RetrievedPassageView = z.infer<typeof retrievedPassageSchema>;

/** Upload limit, shown on the page and enforced by the API. */
export const MAX_KNOWLEDGE_UPLOAD_MB = 10;
export const KNOWLEDGE_FILE_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt', '.csv'] as const;

export const assistantOutcomeSchema = z.enum([
  'replied',
  'handed_off',
  'declined',
  'guard_blocked',
  'budget_exhausted',
  'rate_limited',
  'skipped',
  'failed',
]);

/** The itemised receipt behind one assistant reply (DESIGN.md §5). */
export const turnExplanationSchema = z.object({
  turnId: z.uuid(),
  model: z.string(),
  outcome: assistantOutcomeSchema,
  basis: z.string().nullable(),
  language: z.string().nullable(),
  passages: z.array(
    z.object({
      sourceId: z.uuid(),
      sourceTitle: z.string(),
      heading: z.string().nullable(),
      score: z.number(),
    }),
  ),
  toolCalls: z.array(z.object({ name: z.string(), input: z.unknown(), result: z.unknown() })),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  latencyMs: z.number().int(),
  modelCalls: z.number().int(),
  detail: z.string().nullable(),
  createdAt: isoDate,
});
export type TurnExplanation = z.infer<typeof turnExplanationSchema>;
