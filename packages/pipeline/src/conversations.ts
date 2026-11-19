import { schema, type Transaction } from '@app/db';
import { eq } from 'drizzle-orm';
import { canTransition, type ConversationState } from './rules.js';

/** The conversation does not exist for this tenant (row-level security hides others). */
export class NotFoundError extends Error {
  constructor(message = 'Conversation not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export type Actor = { type: 'system' } | { type: 'assistant' } | { type: 'user'; userId: string };

export interface TransitionResult {
  conversationId: string;
  from: ConversationState;
  to: ConversationState;
}

/**
 * The only way a conversation changes holder. Locks the row, checks the move
 * is allowed, sets the holder, and logs who did it and why (brief §4).
 */
export async function transitionConversation(
  tx: Transaction,
  input: {
    conversationId: string;
    to: ConversationState;
    actor: Actor;
    reason: string;
    requestId?: string | null;
    /** Rejects the change unless the current state is one of these. */
    from?: readonly ConversationState[];
  },
): Promise<TransitionResult> {
  const [conversation] = await tx
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, input.conversationId))
    .for('update');
  if (!conversation) throw new NotFoundError();

  if (input.from && !input.from.includes(conversation.state)) {
    throw new TransitionError(describeConflict(conversation.state));
  }
  if (!canTransition(conversation.state, input.to)) {
    throw new TransitionError(describeConflict(conversation.state));
  }

  await tx
    .update(schema.conversations)
    .set({
      state: input.to,
      holderUserId: input.to === 'human' && input.actor.type === 'user' ? input.actor.userId : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, conversation.id));

  await tx.insert(schema.conversationTransitions).values({
    tenantId: conversation.tenantId,
    conversationId: conversation.id,
    fromState: conversation.state,
    toState: input.to,
    actorType: input.actor.type,
    actorUserId: input.actor.type === 'user' ? input.actor.userId : null,
    reason: input.reason,
    requestId: input.requestId ?? null,
  });

  return { conversationId: conversation.id, from: conversation.state, to: input.to };
}

function describeConflict(state: ConversationState): string {
  switch (state) {
    case 'human':
      return 'Someone else already holds this conversation.';
    case 'closed':
      return 'This conversation is closed.';
    case 'assistant':
      return 'The assistant holds this conversation.';
    case 'waiting_for_human':
      return 'This conversation is waiting for a person.';
  }
}
