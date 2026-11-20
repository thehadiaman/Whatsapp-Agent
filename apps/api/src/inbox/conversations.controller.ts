import { detectLanguage } from '@app/assistant';
import { schema } from '@app/db';
import {
  enqueueOutbound,
  NotFoundError,
  OwnershipError,
  queueReply,
  transitionConversation,
  TransitionError,
  WindowClosedError,
  type EventPublisher,
  type ObjectStorage,
  type Queues,
  type ReplyContent,
} from '@app/pipeline';
import {
  assignBodySchema,
  noteBodySchema,
  replyBodySchema,
  type AssignBody,
  type ConversationDetail,
  type ConversationListItem,
  type NoteBody,
  type ReplyBody,
  type TurnExplanation,
} from '@app/shared';
import { spokenLanguageOf } from '@app/voice';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Response } from 'express';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { RateLimit } from '../common/rate-limit.js';
import { currentRequest } from '../common/request-context.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { EVENTS, QUEUES, STORAGE } from '../infra/tokens.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { conversationDetail, listConversations, reopenTemplateFor } from './inbox.queries.js';

function toHttp(error: unknown): never {
  if (error instanceof NotFoundError) throw new NotFoundException(error.message);
  if (error instanceof WindowClosedError) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'window_closed',
      message: error.message,
    });
  }
  if (error instanceof OwnershipError || error instanceof TransitionError) {
    throw new ConflictException(error.message);
  }
  throw error;
}

const requestId = () => currentRequest()?.requestId ?? null;

/** The inbox: read models, ownership changes, replies and notes. */
@Controller('conversations')
@Access('member')
export class ConversationsController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(EVENTS) private readonly events: EventPublisher,
  ) {}

  @Get()
  list(
    @CurrentMember() member: MemberPrincipal,
    @Query('scope') scope?: string,
  ): Promise<ConversationListItem[]> {
    return this.tenantDb.run(member, (tx) =>
      listConversations(tx, scope === 'closed' ? 'closed' : 'open'),
    );
  }

  @Get(':id')
  async detail(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationDetail> {
    const detail = await this.tenantDb.run(member, (tx) => conversationDetail(tx, id));
    if (!detail) throw new NotFoundException('Conversation not found.');
    return detail;
  }

  /** "Explain this reply": what the assistant read, called and spent for one reply. */
  @Get(':id/turns/:turnId')
  async explanation(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('turnId', new ParseUUIDPipe()) turnId: string,
  ): Promise<TurnExplanation> {
    const t = schema.assistantTurns;
    const [turn] = await this.tenantDb.run(member, (tx) =>
      tx
        .select()
        .from(t)
        .where(and(eq(t.id, turnId), eq(t.conversationId, id))),
    );
    if (!turn) throw new NotFoundException('There is no record for this reply.');
    return {
      turnId: turn.id,
      model: turn.model,
      outcome: turn.outcome,
      basis: turn.basis,
      language: turn.language,
      passages: turn.passages.map((p) => ({
        sourceId: p.sourceId,
        sourceTitle: p.sourceTitle,
        heading: p.heading,
        score: p.score,
      })),
      toolCalls: turn.toolCalls,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costMicros: turn.costMicros,
      latencyMs: turn.latencyMs,
      modelCalls: turn.modelCalls,
      detail: turn.detail,
      createdAt: turn.createdAt.toISOString(),
    };
  }

  @Post(':id/take-over')
  @HttpCode(200)
  async takeOver(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.tenantDb
      .run(member, async (tx) => {
        const r = await transitionConversation(tx, {
          conversationId: id,
          to: 'human',
          from: ['assistant', 'waiting_for_human'],
          actor: { type: 'user', userId: member.userId },
          reason: 'Taken over',
          requestId: requestId(),
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.taken_over',
          targetType: 'conversation',
          targetId: id,
          before: { state: r.from },
          after: { state: r.to, holderUserId: member.userId },
        });
        return r;
      })
      .catch(toHttp);
    await this.events.conversationChanged(member.tenantId, id);
    return result;
  }

  @Post(':id/hand-back')
  @HttpCode(200)
  async handBack(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.tenantDb
      .run(member, async (tx) => {
        const [conversation] = await tx
          .select({ holderUserId: schema.conversations.holderUserId })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id));
        if (!conversation) throw new NotFoundError();
        // The holder hands back; an owner may also release someone else's conversation.
        if (conversation.holderUserId !== member.userId && member.role !== 'owner') {
          throw new OwnershipError('Only the person holding this conversation can hand it back.');
        }
        const r = await transitionConversation(tx, {
          conversationId: id,
          to: 'assistant',
          from: ['human', 'waiting_for_human'],
          actor: { type: 'user', userId: member.userId },
          reason: 'Handed back to the assistant',
          requestId: requestId(),
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.handed_back',
          targetType: 'conversation',
          targetId: id,
          before: { state: r.from, holderUserId: r.previousHolderUserId },
          after: { state: r.to },
        });
        return r;
      })
      .catch(toHttp);
    await this.events.conversationChanged(member.tenantId, id);
    return result;
  }

  /**
   * Gives the conversation to a teammate. An owner may reassign anything; an
   * agent may assign a conversation only if no one else holds it.
   */
  @Post(':id/assign')
  @HttpCode(200)
  async assign(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(assignBodySchema)) body: AssignBody,
  ) {
    const result = await this.tenantDb
      .run(member, async (tx) => {
        const [conversation] = await tx
          .select({ holderUserId: schema.conversations.holderUserId })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id));
        if (!conversation) throw new NotFoundError();
        const heldByOther =
          conversation.holderUserId !== null && conversation.holderUserId !== member.userId;
        if (heldByOther && member.role !== 'owner') {
          throw new OwnershipError('Someone else holds this conversation; ask them or an owner.');
        }
        // Memberships are tenant-scoped: an ID from another business is simply not found.
        const [assignee] = await tx
          .select({ name: schema.users.name })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.userId, body.userId));
        if (!assignee) throw new NotFoundError('That person is not on this team.');
        const r = await transitionConversation(tx, {
          conversationId: id,
          to: 'human',
          from: ['assistant', 'waiting_for_human', 'human'],
          actor: { type: 'user', userId: member.userId },
          holderUserId: body.userId,
          reason: `Assigned to ${assignee.name} by ${member.name}`,
          requestId: requestId(),
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.assigned',
          targetType: 'conversation',
          targetId: id,
          before: { state: r.from, holderUserId: r.previousHolderUserId },
          after: { state: r.to, holderUserId: body.userId },
        });
        return r;
      })
      .catch(toHttp);
    await this.events.conversationChanged(member.tenantId, id);
    return result;
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.tenantDb
      .run(member, async (tx) => {
        const [conversation] = await tx
          .select({ holderUserId: schema.conversations.holderUserId })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id));
        if (!conversation) throw new NotFoundError();
        if (
          conversation.holderUserId !== null &&
          conversation.holderUserId !== member.userId &&
          member.role !== 'owner'
        ) {
          throw new OwnershipError('Someone else holds this conversation; they can close it.');
        }
        const r = await transitionConversation(tx, {
          conversationId: id,
          to: 'closed',
          actor: { type: 'user', userId: member.userId },
          reason: `Closed by ${member.name}`,
          requestId: requestId(),
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.closed',
          targetType: 'conversation',
          targetId: id,
          before: { state: r.from, holderUserId: r.previousHolderUserId },
          after: { state: r.to },
        });
        return r;
      })
      .catch(toHttp);
    await this.events.conversationChanged(member.tenantId, id);
    return result;
  }

  /** Queues a reply; 202 because the worker sends it, in order. */
  @Post(':id/replies')
  @HttpCode(202)
  @RateLimit({ name: 'replies', limit: 60, windowSeconds: 60 })
  async reply(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(replyBodySchema)) body: ReplyBody,
  ): Promise<{ messageId: string }> {
    const messageId = await this.tenantDb
      .run(member, async (tx) => {
        let content: ReplyContent;
        if ('text' in body && body.voice) {
          const [tenant] = await tx
            .select({ voiceReplies: schema.tenants.voiceReplies })
            .from(schema.tenants)
            .where(eq(schema.tenants.id, member.tenantId));
          if (!tenant?.voiceReplies) {
            throw new BadRequestException(
              'Voice replies are off for this business. An owner can turn them on in settings.',
            );
          }
          // Spoken in the language it is written in; no voice for it means text.
          const language = spokenLanguageOf(detectLanguage(body.text)) ?? 'en';
          content = { kind: 'voice', body: body.text, language };
        } else if ('text' in body) {
          content = { kind: 'text', body: body.text };
        } else {
          const template = await reopenTemplateFor(tx, id);
          if (!template) {
            throw new OwnershipError(
              'This business has no approved reopen template. An owner can add one in settings.',
            );
          }
          content = { kind: 'template', name: template.name, languageCode: template.language };
        }
        return queueReply(tx, {
          conversationId: id,
          sender: { type: 'user', userId: member.userId },
          content,
          now: new Date(),
        });
      })
      .catch(toHttp);
    // After commit. If this is lost, the worker's sweeper finds the queued row.
    await enqueueOutbound(this.queues, { tenantId: member.tenantId, messageId });
    await this.events.conversationChanged(member.tenantId, id);
    return { messageId };
  }

  /** Staff-only note. Never sent to the customer. */
  @Post(':id/notes')
  @HttpCode(201)
  @RateLimit({ name: 'notes', limit: 30, windowSeconds: 60 })
  async addNote(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(noteBodySchema)) body: NoteBody,
  ): Promise<{ id: string }> {
    const note = await this.tenantDb.run(member, async (tx) => {
      const [conversation] = await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id));
      if (!conversation) throw new NotFoundException('Conversation not found.');
      const [row] = await tx
        .insert(schema.conversationNotes)
        .values({
          tenantId: member.tenantId,
          conversationId: id,
          authorUserId: member.userId,
          body: body.text,
        })
        .returning({ id: schema.conversationNotes.id });
      return row;
    });
    if (!note) throw new Error('note insert returned no row');
    await this.events.conversationChanged(member.tenantId, id);
    return note;
  }
}

@Controller('messages')
@Access('member')
export class MessagesController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(EVENTS) private readonly events: EventPublisher,
  ) {}

  /** Puts a failed reply back in the queue. Only whoever may reply now may retry. */
  @Post(':id/retry')
  @HttpCode(202)
  @RateLimit({ name: 'replies', limit: 60, windowSeconds: 60 })
  async retry(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ messageId: string }> {
    const conversationId = await this.tenantDb
      .run(member, async (tx) => {
        const [row] = await tx
          .select({ message: schema.messages, conversation: schema.conversations })
          .from(schema.messages)
          .innerJoin(
            schema.conversations,
            eq(schema.conversations.id, schema.messages.conversationId),
          )
          .where(and(eq(schema.messages.id, id), eq(schema.messages.direction, 'outbound')));
        if (!row) throw new NotFoundError('Message not found.');
        if (row.message.status !== 'failed') {
          throw new OwnershipError('Only a failed message can be sent again.');
        }
        if (row.conversation.state !== 'human' || row.conversation.holderUserId !== member.userId) {
          throw new OwnershipError('Take over the conversation before sending again.');
        }
        await tx
          .update(schema.messages)
          .set({ status: 'queued', statusAt: new Date(), attempts: 0, error: null })
          .where(eq(schema.messages.id, id));
        return row.conversation.id;
      })
      .catch(toHttp);
    await enqueueOutbound(this.queues, { tenantId: member.tenantId, messageId: id });
    await this.events.conversationChanged(member.tenantId, conversationId);
    return { messageId: id };
  }
}

const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
]);

@Controller('media')
@Access('member')
export class MediaController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Streams a stored attachment, or redirects to a short-lived S3 link. Only images and audio render inline; anything
   * else (PDF, HTML, SVG sent by a customer) downloads, so it cannot run in
   * the inbox's origin.
   */
  @Get(':messageId')
  async get(
    @CurrentMember() member: MemberPrincipal,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const media = await this.tenantDb.run(member, async (tx) => {
      const [row] = await tx
        .select({ media: schema.messages.media })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      return row?.media ?? null;
    });
    if (!media?.storageKey) throw new NotFoundException('This attachment is not available yet.');
    const baseMime = media.mimeType.split(';')[0]?.trim() ?? '';
    if (this.storage.signedUrl) {
      // S3: a short-lived link fetched by the browser, with the type and
      // disposition fixed in its signature (D-092). Never cached longer than it lives.
      const url = await this.storage.signedUrl(media.storageKey, {
        contentType: media.mimeType,
        inline: INLINE_TYPES.has(baseMime),
        expiresIn: this.config.MEDIA_URL_TTL_SECONDS,
      });
      res.setHeader('cache-control', 'private, no-store');
      res.redirect(302, url);
      return;
    }
    const file = await this.storage.get(media.storageKey);
    if (!file) throw new NotFoundException('This attachment is not available.');
    const baseType = file.contentType.split(';')[0]?.trim() ?? '';
    const inline = INLINE_TYPES.has(baseType);
    res.setHeader('content-type', inline ? file.contentType : 'application/octet-stream');
    res.setHeader('content-disposition', inline ? 'inline' : 'attachment');
    res.setHeader('cache-control', 'private, max-age=300');
    res.send(Buffer.from(file.bytes));
  }
}
