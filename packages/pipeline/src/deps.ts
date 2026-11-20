import type { Database } from '@app/db';
import type { Logger } from '@app/shared';
import type { AssistantDeps, PipelineSettings, ProviderRegistry } from './config.js';
import type { EventPublisher } from './events.js';
import type { Queues } from './queues.js';
import type { ObjectStorage } from './storage.js';

/** Everything pipeline code needs, passed explicitly (no globals). */
export interface PipelineDeps {
  /** Connected as app_user: row-level security applies to every tenant query. */
  db: Database;
  queues: Queues;
  providers: ProviderRegistry;
  storage: ObjectStorage;
  logger: Logger;
  settings: PipelineSettings;
  /** Tells connected inboxes a conversation changed. */
  events: EventPublisher;
  assistant: AssistantDeps;
  now?: () => Date;
}

export function nowOf(deps: Pick<PipelineDeps, 'now'>): Date {
  return deps.now ? deps.now() : new Date();
}
