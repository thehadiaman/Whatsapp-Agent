import { schema } from '@app/db';
import {
  enqueueOutbound,
  NotFoundError,
  OwnershipError,
  queueReply,
  transitionConversation,
  TransitionError,
  WindowClosedError,
  type Queues,
} from '@app/pipeline';
import {
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
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { currentRequest } from '../common/request-context.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { QUEUES } from '../infra/tokens.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';

const replyBodySchema = z.strictObject({ text: z.string().trim().min(1).max(4096) });
type ReplyBody = z.infer<typeof replyBodySchema>;

function conflict(error: unknown): never {
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

/**
 * Ownership changes and staff replies. The inbox UI arrives in phase 3; the
 * rules live here and in @app/pipeline so the pipeline can be tested now.
 */
@Controller('conversations')
@Access('member')
export class ConversationsController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(QUEUES) private readonly queues: Queues,
  ) {}

  @Get(':id/messages')
  messages(@CurrentMember() member: MemberPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tenantDb.run(member, async (tx) => {
      const [conversation] = await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id));
      if (!conversation) throw new NotFoundException('Conversation not found.');
      return tx
        .select({
          id: schema.messages.id,
          direction: schema.messages.direction,
          kind: schema.messages.kind,
          senderType: schema.messages.senderType,
          body: schema.messages.body,
          status: schema.messages.status,
          outboxSeq: schema.messages.outboxSeq,
          createdAt: schema.messages.createdAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, id))
        .orderBy(asc(schema.messages.createdAt));
    });
  }

  @Post(':id/take-over')
  @HttpCode(200)
  async takeOver(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tenantDb
      .run(member, async (tx) => {
        const result = await transitionConversation(tx, {
          conversationId: id,
          to: 'human',
          from: ['assistant', 'waiting_for_human'],
          actor: { type: 'user', userId: member.userId },
          reason: 'Taken over',
          requestId: currentRequest()?.requestId ?? null,
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.taken_over',
          targetType: 'conversation',
          targetId: id,
          before: { state: result.from },
          after: { state: result.to, holderUserId: member.userId },
        });
        return result;
      })
      .catch(conflict);
  }

  @Post(':id/hand-back')
  @HttpCode(200)
  async handBack(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tenantDb
      .run(member, async (tx) => {
        const [conversation] = await tx
          .select({ holderUserId: schema.conversations.holderUserId })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id));
        // The holder hands back; an owner may also release someone else's conversation.
        if (conversation?.holderUserId !== member.userId && member.role !== 'owner') {
          throw new OwnershipError('Only the person holding this conversation can hand it back.');
        }
        const result = await transitionConversation(tx, {
          conversationId: id,
          to: 'assistant',
          from: ['human'],
          actor: { type: 'user', userId: member.userId },
          reason: 'Handed back to the assistant',
          requestId: currentRequest()?.requestId ?? null,
        });
        await this.tenantDb.audit(tx, member, {
          action: 'conversation.handed_back',
          targetType: 'conversation',
          targetId: id,
          before: { state: result.from, holderUserId: conversation?.holderUserId ?? null },
          after: { state: result.to },
        });
        return result;
      })
      .catch(conflict);
  }

  /** Queues a reply; 202 because sending happens in the worker, in order. */
  @Post(':id/replies')
  @HttpCode(202)
  async reply(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(replyBodySchema)) body: ReplyBody,
  ): Promise<{ messageId: string }> {
    const messageId = await this.tenantDb
      .run(member, (tx) =>
        queueReply(tx, {
          conversationId: id,
          sender: { type: 'user', userId: member.userId },
          content: { kind: 'text', body: body.text },
          now: new Date(),
        }),
      )
      .catch(conflict);
    // After commit. If this is lost, the worker's sweeper finds the queued row.
    await enqueueOutbound(this.queues, { tenantId: member.tenantId, messageId });
    return { messageId };
  }
}
