import { randomUUID } from 'node:crypto';
import { schema, type Transaction } from '@app/db';
import {
  enqueueKnowledge,
  KNOWLEDGE_CONTENT_TYPES,
  knowledgeFileKind,
  knowledgeObjectKey,
  MAX_KNOWLEDGE_FILE_BYTES,
  retrievePassages,
  type AssistantDeps,
  type ObjectStorage,
  type Queues,
} from '@app/pipeline';
import {
  faqBodySchema,
  tryQuestionBodySchema,
  type FaqBody,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type RetrievedPassageView,
  type TryQuestionBody,
} from '@app/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { asc, desc, eq } from 'drizzle-orm';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { ASSISTANT, QUEUES, STORAGE } from '../infra/tokens.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';

/** The part of Multer's file object this controller reads (memory storage). */
interface UploadedKnowledgeFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const s = schema.knowledgeSources;

/**
 * Multer decodes the multipart file name as Latin-1; browsers send UTF-8.
 * Re-decode, unless that produces replacement characters (a real Latin-1 name).
 */
function fileTitle(originalname: string): string {
  const utf8 = Buffer.from(originalname, 'latin1').toString('utf8');
  const name = utf8.includes('\uFFFD') ? originalname : utf8;
  return (name.split(/[\\/]/).pop() ?? 'file').trim().slice(0, 200) || 'file';
}

async function listSources(tx: Transaction, id?: string): Promise<KnowledgeSource[]> {
  const rows = await tx
    .select({ source: s, updatedBy: schema.users.name })
    .from(s)
    .leftJoin(schema.users, eq(schema.users.id, s.updatedByUserId))
    .where(id ? eq(s.id, id) : undefined)
    .orderBy(desc(s.updatedAt));
  return rows.map(({ source, updatedBy }) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    answer: source.answer,
    status: source.status,
    error: source.error,
    passageCount: source.passageCount,
    unitCount: source.unitCount,
    sizeBytes: source.sizeBytes,
    version: source.version,
    updatedAt: source.updatedAt.toISOString(),
    updatedBy,
  }));
}

/** The knowledge base: FAQs, files and catalogues the assistant answers from. */
@Controller('knowledge')
@Access('member')
export class KnowledgeController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(ASSISTANT) private readonly assistant: AssistantDeps,
  ) {}

  @Get('sources')
  list(@CurrentMember() member: MemberPrincipal): Promise<KnowledgeSource[]> {
    return this.tenantDb.run(member, (tx) => listSources(tx));
  }

  @Get('sources/:id')
  async detail(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<KnowledgeSourceDetail> {
    const detail = await this.tenantDb.run(member, async (tx) => {
      const [source] = await listSources(tx, id);
      if (!source) return null;
      const passages = await tx
        .select({
          ordinal: schema.knowledgePassages.ordinal,
          heading: schema.knowledgePassages.heading,
          text: schema.knowledgePassages.text,
        })
        .from(schema.knowledgePassages)
        .where(eq(schema.knowledgePassages.sourceId, id))
        .orderBy(asc(schema.knowledgePassages.ordinal));
      return { ...source, passages };
    });
    if (!detail) throw new NotFoundException('Knowledge source not found.');
    return detail;
  }

  @Post('faqs')
  @Access('owner')
  @RateLimit({ name: 'knowledge', limit: 60, windowSeconds: 60 })
  async addFaq(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(faqBodySchema)) body: FaqBody,
  ): Promise<{ id: string }> {
    const id = await this.tenantDb.run(member, async (tx) => {
      const [row] = await tx
        .insert(s)
        .values({
          tenantId: member.tenantId,
          kind: 'faq',
          title: body.question,
          answer: body.answer,
          createdByUserId: member.userId,
          updatedByUserId: member.userId,
        })
        .returning({ id: s.id });
      if (!row) throw new Error('faq insert returned no row');
      await this.tenantDb.audit(tx, member, {
        action: 'knowledge.faq_added',
        targetType: 'knowledge_source',
        targetId: row.id,
        after: { question: body.question },
      });
      return row.id;
    });
    await enqueueKnowledge(this.queues, { tenantId: member.tenantId, sourceId: id, version: 1 });
    return { id };
  }

  @Put('faqs/:id')
  @Access('owner')
  @RateLimit({ name: 'knowledge', limit: 60, windowSeconds: 60 })
  async editFaq(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(faqBodySchema)) body: FaqBody,
  ): Promise<{ id: string; version: number }> {
    const version = await this.tenantDb.run(member, async (tx) => {
      const [current] = await tx.select().from(s).where(eq(s.id, id)).for('update');
      if (current?.kind !== 'faq') return null;
      const next = current.version + 1;
      await tx
        .update(s)
        .set({
          title: body.question,
          answer: body.answer,
          version: next,
          status: 'queued',
          error: null,
          updatedByUserId: member.userId,
          updatedAt: new Date(),
        })
        .where(eq(s.id, id));
      await this.tenantDb.audit(tx, member, {
        action: 'knowledge.faq_edited',
        targetType: 'knowledge_source',
        targetId: id,
        before: { question: current.title },
        after: { question: body.question },
      });
      return next;
    });
    if (version === null) throw new NotFoundException('FAQ not found.');
    await enqueueKnowledge(this.queues, { tenantId: member.tenantId, sourceId: id, version });
    return { id, version };
  }

  @Post('files')
  @Access('owner')
  @RateLimit({ name: 'knowledge', limit: 60, windowSeconds: 60 })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_KNOWLEDGE_FILE_BYTES, files: 1 } }),
  )
  async upload(
    @CurrentMember() member: MemberPrincipal,
    @UploadedFile() file: UploadedKnowledgeFile | undefined,
  ): Promise<{ id: string }> {
    if (!file) throw new BadRequestException('Choose a file to upload.');
    const title = fileTitle(file.originalname);
    const kind = knowledgeFileKind(title);
    if (!kind) {
      throw new BadRequestException('Upload a PDF, Word (.docx), Markdown, text or CSV file.');
    }
    if (file.size === 0) throw new BadRequestException('The file is empty.');

    // The file is stored first: a source row never points at a missing file.
    const id = randomUUID();
    const key = knowledgeObjectKey(member.tenantId, id);
    await this.storage.put(key, file.buffer, KNOWLEDGE_CONTENT_TYPES[kind]);
    await this.tenantDb.run(member, async (tx) => {
      await tx.insert(s).values({
        id,
        tenantId: member.tenantId,
        kind: kind === 'catalogue' ? 'catalogue' : 'file',
        title,
        contentType: KNOWLEDGE_CONTENT_TYPES[kind],
        sizeBytes: file.size,
        storageKey: key,
        createdByUserId: member.userId,
        updatedByUserId: member.userId,
      });
      await this.tenantDb.audit(tx, member, {
        action: 'knowledge.file_uploaded',
        targetType: 'knowledge_source',
        targetId: id,
        after: { title, sizeBytes: file.size },
      });
    });
    await enqueueKnowledge(this.queues, { tenantId: member.tenantId, sourceId: id, version: 1 });
    return { id };
  }

  @Delete('sources/:id')
  @Access('owner')
  @HttpCode(204)
  @RateLimit({ name: 'knowledge', limit: 60, windowSeconds: 60 })
  async remove(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const removed = await this.tenantDb.run(member, async (tx) => {
      // Passages go with the source (foreign key cascade), so the assistant stops using it at once.
      const [row] = await tx
        .delete(s)
        .where(eq(s.id, id))
        .returning({ title: s.title, storageKey: s.storageKey });
      if (!row) return null;
      await this.tenantDb.audit(tx, member, {
        action: 'knowledge.source_removed',
        targetType: 'knowledge_source',
        targetId: id,
        before: { title: row.title },
      });
      return row;
    });
    if (!removed) throw new NotFoundException('Knowledge source not found.');
    if (removed.storageKey) await this.storage.delete(removed.storageKey);
  }

  /** "Try a question": the passages the assistant would read, with their scores. */
  @Post('try')
  @HttpCode(200)
  @RateLimit({ name: 'knowledge-try', limit: 30, windowSeconds: 60 })
  async tryQuestion(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(tryQuestionBodySchema)) body: TryQuestionBody,
  ): Promise<RetrievedPassageView[]> {
    const passages = await this.tenantDb.run(member, (tx) =>
      retrievePassages(tx, this.assistant.embedder, body.question),
    );
    return passages.map((p) => ({
      passageId: p.id,
      sourceId: p.sourceId,
      sourceTitle: p.sourceTitle,
      heading: p.heading,
      text: p.text,
      score: p.score,
    }));
  }
}
