import { schema, type Transaction } from '@app/db';
import { and, eq } from 'drizzle-orm';
import { nextStatus, type MessageStatus } from './rules.js';

/**
 * Folds every stored status event for a WhatsApp message into the message.
 * Safe to call any number of times, in any order: the result depends only on
 * the set of events (see `nextStatus`). Called when an event arrives and
 * again when a send returns, because Meta may report `sent` before our send
 * call has returned the message ID.
 */
export async function applyStatusEvents(
  tx: Transaction,
  channelId: string,
  waMessageId: string,
): Promise<void> {
  const [message] = await tx
    .select({
      id: schema.messages.id,
      status: schema.messages.status,
    })
    .from(schema.messages)
    .where(
      and(eq(schema.messages.channelId, channelId), eq(schema.messages.waMessageId, waMessageId)),
    )
    .for('update');
  if (!message) return;

  const events = await tx
    .select()
    .from(schema.messageStatusEvents)
    .where(
      and(
        eq(schema.messageStatusEvents.channelId, channelId),
        eq(schema.messageStatusEvents.waMessageId, waMessageId),
      ),
    );

  let status: MessageStatus = message.status;
  let at: Date | null = null;
  let errors: unknown = null;
  for (const event of events) {
    const next = nextStatus(status, event.status as MessageStatus);
    if (next !== status) {
      status = next;
      at = event.occurredAt;
      errors = event.errors;
    }
  }
  if (status === message.status || !at) return;

  const firstError = Array.isArray(errors)
    ? (errors[0] as { code?: number; title?: string })
    : null;
  await tx
    .update(schema.messages)
    .set({
      status,
      statusAt: at,
      ...(status === 'failed'
        ? {
            error: {
              code: typeof firstError?.code === 'number' ? firstError.code : null,
              message: firstError?.title ?? 'WhatsApp reported the message as failed.',
            },
          }
        : {}),
    })
    .where(eq(schema.messages.id, message.id));
}
