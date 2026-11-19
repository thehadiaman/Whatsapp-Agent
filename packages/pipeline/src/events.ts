import type { Logger } from '@app/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * Change notifications from the worker and API to connected inboxes, over
 * Redis pub/sub. Events carry IDs only: the browser refetches through the
 * API, where row-level security applies, so a misrouted event cannot leak
 * message content.
 */
export const EVENTS_CHANNEL = 'desk:events';

export const tenantEventSchema = z.object({
  type: z.literal('conversation.changed'),
  tenantId: z.uuid(),
  conversationId: z.uuid(),
});
export type TenantEvent = z.infer<typeof tenantEventSchema>;

export interface EventPublisher {
  /** Never throws: a lost notification only delays an inbox refresh. */
  conversationChanged(tenantId: string, conversationId: string): Promise<void>;
}

export class RedisEventPublisher implements EventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async conversationChanged(tenantId: string, conversationId: string): Promise<void> {
    const event: TenantEvent = { type: 'conversation.changed', tenantId, conversationId };
    try {
      await this.redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
    } catch (error) {
      this.logger.warn({ err: error, conversationId }, 'could not publish change event');
    }
  }
}

export const noEvents: EventPublisher = {
  conversationChanged: () => Promise.resolve(),
};

/**
 * Subscribes a dedicated Redis connection (a subscribed connection can do
 * nothing else) and calls `onEvent` for every valid event. Invalid messages
 * are dropped: the channel is a boundary like any other.
 */
export async function subscribeToEvents(
  subscriber: Redis,
  onEvent: (event: TenantEvent) => void,
  logger: Logger,
): Promise<() => Promise<void>> {
  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== EVENTS_CHANNEL) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      logger.warn('dropped a malformed change event');
      return;
    }
    const result = tenantEventSchema.safeParse(parsed);
    if (result.success) onEvent(result.data);
    else logger.warn('dropped an invalid change event');
  });
  await subscriber.subscribe(EVENTS_CHANNEL);
  return async () => {
    await subscriber.unsubscribe(EVENTS_CHANNEL);
  };
}
