import { schema, type Database } from '@app/db';
import type { Provider } from './config.js';
import { enqueueWebhookEvent, type Queues } from './queues.js';

/**
 * Called by the webhook endpoint after the signature check: store the raw
 * body, enqueue it, return. Everything else happens in the worker, so the
 * endpoint answers 200 in milliseconds and a processing bug loses nothing.
 */
export async function ingestWebhook(
  db: Database,
  queues: Queues,
  provider: Provider,
  rawBody: string,
): Promise<string> {
  const [event] = await db
    .insert(schema.webhookEvents)
    .values({ provider, body: rawBody })
    .returning({ id: schema.webhookEvents.id });
  if (!event) throw new Error('ingestWebhook: insert returned no row');
  // If this enqueue is lost, the sweeper finds the unprocessed row.
  await enqueueWebhookEvent(queues, event.id);
  return event.id;
}
