ALTER TABLE "messages" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "speech" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "languages" text[] DEFAULT '{en}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "voice_replies" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_languages_known" CHECK (cardinality("tenants"."languages") between 1 and 4 and "tenants"."languages" <@ array['en', 'hi', 'ml', 'ar']::text[]);--> statement-breakpoint
-- Hand-written: voice notes whose transcript is still pending because a job
-- was lost (the media copy or the transcription). Like the other sweeps it
-- runs as app_user with no tenant set, so it returns IDs only and runs as owner.
-- `stored` says which step to redo: copy the file, or transcribe it.
CREATE FUNCTION pending_transcripts(p_older_than interval, p_newer_than interval, p_limit integer)
  RETURNS TABLE (tenant_id uuid, message_id uuid, stored boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.tenant_id, m.id, (m.media ? 'storageKey') FROM messages m
    WHERE m.direction = 'inbound' AND m.kind = 'audio'
      AND m.transcript ->> 'status' = 'pending'
      AND m.created_at < now() - p_older_than
      AND m.created_at > now() - p_newer_than
    ORDER BY m.created_at
    LIMIT p_limit
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pending_transcripts(interval, interval, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pending_transcripts(interval, interval, integer) TO app_user;
