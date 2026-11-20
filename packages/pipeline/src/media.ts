import { schema, withTenant } from '@app/db';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { PipelineDeps } from './deps.js';
import { readOggOpus } from '@app/voice';
import { enqueueTranscription, tenantMessageJobSchema } from './queues.js';
import { mediaKey } from './storage.js';

/** The inbox shows a voice note's length before it is played. Not Ogg Opus: unknown. */
function audioLength(bytes: Uint8Array): { durationMs?: number } {
  try {
    return { durationMs: readOggOpus(bytes).durationMs };
  } catch {
    return {};
  }
}

/**
 * Copies an inbound image, document or voice note into our own storage.
 * Meta's download URLs expire after 5 minutes, so this runs as soon as the
 * message is stored; the media ID is exchanged for a fresh URL on each try.
 */
export async function fetchInboundMedia(deps: PipelineDeps, job: Job): Promise<void> {
  const { tenantId, messageId } = tenantMessageJobSchema.parse(job.data);

  const target = await withTenant(deps.db, tenantId, async (tx) => {
    const [message] = await tx
      .select({
        kind: schema.messages.kind,
        media: schema.messages.media,
        channelId: schema.messages.channelId,
        conversationId: schema.messages.conversationId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    if (!message?.media || message.media.storageKey) return null;
    const [channel] = await tx
      .select({
        provider: schema.channels.provider,
        phoneNumberId: schema.channels.phoneNumberId,
        accessTokenSealed: schema.channels.accessTokenSealed,
      })
      .from(schema.channels)
      .where(eq(schema.channels.id, message.channelId));
    return channel
      ? {
          kind: message.kind,
          media: message.media,
          channel,
          conversationId: message.conversationId,
        }
      : null;
  });
  if (!target) return;

  const client = deps.providers.client(target.channel);
  const info = await client.getMedia(target.media.id);
  const file = await client.downloadMedia(info.url);
  const key = mediaKey(tenantId, messageId);
  await deps.storage.put(key, file.bytes, target.media.mimeType);

  await withTenant(deps.db, tenantId, (tx) =>
    tx
      .update(schema.messages)
      .set({
        media: {
          ...target.media,
          storageKey: key,
          sizeBytes: file.bytes.byteLength,
          ...(target.kind === 'audio' ? audioLength(file.bytes) : {}),
        },
      })
      .where(eq(schema.messages.id, messageId)),
  );
  deps.logger.info({ messageId, sizeBytes: file.bytes.byteLength }, 'inbound media stored');
  if (target.kind === 'audio') await enqueueTranscription(deps.queues, { tenantId, messageId });
  await deps.events.conversationChanged(tenantId, target.conversationId);
}
